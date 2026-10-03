'use strict';

// 跨报告同视野覆盖变化核对的端到端 HTTP 自测（npm test）：在临时 DATA_DIR 启动真实服务，
// 走 上传 → 定标 → 圈视野/细胞 → 发布基线 → 改草稿 → 更正发布复测 →
// 覆盖变化核对（四类面积恒等 / 按名称 / 不同标尺提示 / 冻结不改 / 只读）→ 错误语义 全流程。

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const PORT = 8239;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'pm-covdiff-'));
const base = `http://localhost:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

async function jsend(method, p, body) {
  const res = await fetch(base + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
function upload(buffer) {
  return new Promise((resolve, reject) => {
    const boundary = '----b' + Math.random().toString(16).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n` +
      'Content-Type: image/png\r\n\r\n');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const req = require('http').request(base + '/api/images', {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + buffer.length + tail.length }
    }, (res) => {
      let d = ''; res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(d || '{}') }));
    });
    req.on('error', reject);
    req.write(head); req.write(buffer); req.write(tail); req.end();
  });
}
const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
];

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let started = false;
  srv.stdout.on('data', (d) => { if (String(d).includes('已启动')) started = true; });
  srv.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50 && !started; i++) await new Promise((r) => setTimeout(r, 100));
  if (!started) throw new Error('server did not start');

  try {
    const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#fff' } })
      .png().toBuffer();
    const up = await upload(png);
    const imgId = up.body.id;

    // 视野 100×100 净面积 10000；标尺 1px=1μm
    let r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    check('定标成功', r.status === 200, r.body);
    r = await jsend('PUT', `/api/images/${imgId}/fields`, {
      version: r.body.version,
      fields: [{ id: 'f1', name: '中心视野', outer: rect(0, 0, 100, 100), holes: [] }]
    });
    check('保存视野成功', r.status === 200, r.body);

    // 基线细胞：左半（0,0,50,100）→ 覆盖 5000
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: r.body.version,
      cells: [{ id: 'A', name: '甲', outer: rect(0, 0, 50, 100), holes: [] }]
    });
    check('保存基线轮廓成功', r.status === 200, r.body);

    const pub = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: r.body.version, title: '切片A 基线报告'
    });
    check('基线报告发布成功', pub.status === 201, pub.body);
    const baseId = pub.body.report.id;

    // ---------- 错误：不能选同一份报告 ----------
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, {
      retestReportId: baseId, fieldId: 'f1'
    });
    check('相同报告 → 400', r.status === 400 && /两份不同/.test(r.body.error), r.body);

    // ---------- 另一切片：用于“不同切片”报错 ----------
    const up2 = await upload(png);
    const img2 = up2.body.id;
    r = await jsend('PUT', `/api/images/${img2}/calibration`, {
      version: 1, p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 100
    });
    r = await jsend('PUT', `/api/images/${img2}/contours`, {
      version: r.body.version, cells: [{ id: 'X', name: 'X', outer: rect(0, 0, 10, 10), holes: [] }]
    });
    const pub2 = await jsend('POST', `/api/images/${img2}/publish`, {
      version: r.body.version, title: '另一切片报告'
    });
    const otherId = pub2.body.report.id;
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, {
      retestReportId: otherId, fieldId: 'f1'
    });
    check('不同切片 → 400', r.status === 400 && /同一切片/.test(r.body.error), r.body);

    // ---------- 改为复测：下半（0,50,100,50）→ 覆盖 5000，再发布“另一份”同切片报告 ----------
    let cur = await jsend('GET', `/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: cur.body.version,
      cells: [{ id: 'C', name: '丙', outer: rect(0, 50, 100, 50), holes: [] }]
    });
    check('保存复测轮廓成功', r.status === 200, r.body);
    // 普通发布（同一切片第二份独立报告，非更正链）
    const pubR = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: r.body.version, title: '切片A 复测报告'
    });
    check('复测报告发布成功', pubR.status === 201, pubR.body);
    const retestId = pubR.body.report.id;

    // ---------- 正常核对（按 id） ----------
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, {
      retestReportId: retestId, fieldId: 'f1'
    });
    check('覆盖变化核对成功', r.status === 200, r.body);
    const d = r.body.diff;
    const cat = Object.fromEntries(d.categories.map((c) => [c.id, c]));
    check('共同覆盖 2500', approx(cat.both.areaPx, 2500), cat.both);
    check('仅复测 2500', approx(cat.retestOnly.areaPx, 2500), cat.retestOnly);
    check('仅基线 2500', approx(cat.baselineOnly.areaPx, 2500), cat.baselineOnly);
    check('始终未覆盖 2500', approx(cat.none.areaPx, 2500), cat.none);
    check('四类之和 = 视野净面积 10000（px 与 mm²）',
      approx(d.sumAreaPx, 10000) && approx(d.sumAreaMm2, 0.01) &&
      approx(d.fieldAreaPx, 10000) && approx(d.fieldAreaMm2, 0.01), d);
    check('scope / 同切片 / matchedBy',
      r.body.scope === 'coverage-diff' && r.body.imageId === imgId && r.body.matchedBy === 'id', r.body);
    check('每类带回填环与边界',
      d.categories.every((c) => Array.isArray(c.loops) && Array.isArray(c.boundaries) &&
        c.loops.length >= 1 && c.boundaries.length >= 1),
      d.categories.map((c) => [c.id, c.loops.length, c.boundaries.length]));
    check('两侧贡献细胞：基线甲、复测丙',
      d.contributingBaselineCells.some((x) => x.key === 'A') &&
      d.contributingRetestCells.some((x) => x.key === 'C'), d);
    check('相同标尺 scalesDiffer=false', d.scalesDiffer === false, d);

    // 按名称核对
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, {
      retestReportId: retestId, fieldId: ' 中心视野 '
    });
    check('按名称核对成功 matchedBy=name 且数值一致',
      r.status === 200 && r.body.matchedBy === 'name' &&
      approx(r.body.diff.categories[0].areaPx, 2500), r.body);

    // 视野不存在 / 缺字段
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, { retestReportId: retestId, fieldId: 'ghost' });
    check('基线视野不存在 → 400', r.status === 400 && /基线视野不存在/.test(r.body.error), r.body);
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, { retestReportId: retestId });
    check('缺 fieldId → 400', r.status === 400, r.body);
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, { fieldId: 'f1' });
    check('缺 retestReportId → 400', r.status === 400, r.body);

    // 基线报告不存在 → 404；复测不存在 → 404
    r = await jsend('POST', '/api/reports/no-such-base/coverage-diff', { retestReportId: retestId, fieldId: 'f1' });
    check('基线报告不存在 → 404', r.status === 404, r.body);
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, { retestReportId: 'no-such-r', fieldId: 'f1' });
    check('复测报告不存在 → 404', r.status === 404, r.body);

    // ---------- 草稿后续修改不改变旧报告核对结果（只读冻结） ----------
    cur = await jsend('GET', `/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/contours`, {
      version: cur.body.version,
      cells: [{ id: 'Z', name: '丁', outer: rect(0, 0, 100, 100), holes: [] }]
    });
    const r2 = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, {
      retestReportId: retestId, fieldId: 'f1'
    });
    check('草稿再改后旧两报告核对结果不变（仍 2500/2500/2500/2500）',
      r2.body.diff.categories.map((c) => c.areaPx).join(',') === '2500,2500,2500,2500',
      r2.body.diff.categories.map((c) => c.areaPx));

    // 幂等、不写回：连续两次结果一致
    const a1 = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, { retestReportId: retestId, fieldId: 'f1' });
    const a2 = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, { retestReportId: retestId, fieldId: 'f1' });
    check('核对查询幂等、不写回', JSON.stringify(a1.body.diff) === JSON.stringify(a2.body.diff));

    // ---------- 两份标尺不同：重新定标后发布第三份报告，mm² 仍按基线标尺 ----------
    cur = await jsend('GET', `/api/images/${imgId}`);
    r = await jsend('PUT', `/api/images/${imgId}/calibration`, {
      version: cur.body.version,
      p1: { x: 0, y: 0 }, p2: { x: 100, y: 0 }, distanceUm: 200 // 1px = 2μm
    });
    check('重定标成功', r.status === 200, r.body);
    const pubS = await jsend('POST', `/api/images/${imgId}/publish`, {
      version: r.body.version, title: '切片A 复测报告（重定标 2μm/px）'
    });
    const scaleRetestId = pubS.body.report.id;
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, {
      retestReportId: scaleRetestId, fieldId: 'f1'
    });
    const ds = r.body.diff;
    check('不同标尺：scalesDiffer=true、两侧标尺返回',
      ds.scalesDiffer === true &&
      approx(ds.baselineScaleUmPerPx, 1) && approx(ds.retestScaleUmPerPx, 2), ds);
    check('不同标尺：物理面积按【基线标尺 1μm/px】（每类 5000px → 0.005 mm²，非 0.02）',
      approx(ds.categories[0].areaMm2, 0.005) && approx(ds.categories[1].areaMm2, 0.005) &&
      approx(ds.fieldAreaMm2, 0.01),
      ds.categories.map((c) => [c.id, c.areaPx, c.areaMm2]));
    check('不同标尺：换算依据文本明确提示复测标尺不参与',
      /复测报告标尺/.test(ds.scaleBasis) && /不参与/.test(ds.scaleBasis), ds.scaleBasis);

    // ---------- 更正链：历史报告也可作为核对一方 ----------
    cur = await jsend('GET', `/api/images/${imgId}`);
    const trace = await jsend('GET', `/api/reports/${retestId}/trace`);
    const cor = await jsend('POST', `/api/reports/${retestId}/correct`, {
      reason: '再次补全', draftVersion: cur.body.version, expectedTipId: trace.body.tipId
    });
    check('更正发布成功', cor.status === 201, cor.body);
    const v3 = cor.body.report.id;
    // 历史基线报告 baseId ↔ 最新更正报告 v3：现在复测铺满 10000
    r = await jsend('POST', `/api/reports/${baseId}/coverage-diff`, { retestReportId: v3, fieldId: 'f1' });
    check('基线（历史）↔ 更正链末端：共同 5000、仅复测 5000',
      approx(r.body.diff.categories[0].areaPx, 5000) &&
      approx(r.body.diff.categories[1].areaPx, 5000), r.body.diff.categories.map((c) => c.areaPx));

  } finally {
    srv.kill();
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
  console.log('\n全部跨报告覆盖变化核对 HTTP 自测通过 ✔');
}

main().catch((e) => { console.error(e); process.exit(1); });
