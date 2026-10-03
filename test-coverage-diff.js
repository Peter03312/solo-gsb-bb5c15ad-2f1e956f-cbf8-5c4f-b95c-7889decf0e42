'use strict';

// 跨报告同视野覆盖变化核对（四类分区）的纯几何自测（npm test）。
// 校验：四类像素面积之和恒等于基线视野净面积、跨边界/重叠/孔洞/仅边界接触语义、
// 物理面积按基线标尺换算、两份标尺不同的依据，以及全部报错语义。

const D = require('./server/coverage-diff');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('ok -', name); }
  else { failures += 1; console.error('FAIL -', name, extra != null ? JSON.stringify(extra) : ''); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

const rect = (x, y, w, h) => [
  { x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }
];
const cell = (id, outer, holes = []) => ({ id, name: id, outer, holes });
const report = (id, imageId, scale, cells, wh = [300, 300]) => ({
  id, title: id, imageId, width: wh[0], height: wh[1], calib: { scale }, cells
});

function diffOf(baseline, retest, field, fieldId = 'f1') {
  D.validateReports(baseline, retest, baseline.id, retest.id);
  const res = D.resolveBaselineField([field], fieldId);
  return D.buildCoverageDiff(baseline, retest, res.field);
}
const byId = (d, id) => d.categories.find((c) => c.id === id);

// ---------- 1) 经典四分区：左半基线、下半复测，视野带一个 10×10 孔洞 ----------
{
  const field = { id: 'f1', name: 'F', outer: rect(0, 0, 100, 100), holes: [rect(70, 70, 10, 10)] };
  const b = report('b', 'img1', 1, [cell('A', rect(0, 0, 50, 100))]);
  const r = report('r', 'img1', 1, [cell('C', rect(0, 50, 100, 50))]);
  const d = diffOf(b, r, field);
  check('共同覆盖 = 2500', approx(byId(d, 'both').areaPx, 2500), byId(d, 'both'));
  check('仅复测 = 2400（右下 2500 扣除孔洞 100）', approx(byId(d, 'retestOnly').areaPx, 2400), byId(d, 'retestOnly'));
  check('仅基线 = 2500', approx(byId(d, 'baselineOnly').areaPx, 2500), byId(d, 'baselineOnly'));
  check('始终未覆盖 = 2500', approx(byId(d, 'none').areaPx, 2500), byId(d, 'none'));
  check('视野净面积 = 9900', approx(d.fieldAreaPx, 9900), d);
  check('四类 px² 之和 = 视野净面积 9900', approx(d.sumAreaPx, 9900), d.sumAreaPx);
  check('四类 mm² 之和 = 0.0099', approx(d.sumAreaMm2, 0.0099), d.sumAreaMm2);
  const pctSum = d.categories.reduce((s, c) => s + c.percent, 0);
  check('占比百分比之和 = 100（2 位小数）', approx(pctSum, 100, 0.02), pctSum);
  check('比例占比之和 = 1（各占比按 6 位小数给出，末位取整有 ±2e-6 容差）',
    approx(d.categories.reduce((s, c) => s + c.ratio, 0), 1, 2e-6));
  check('每类都带可渲染环与边界', d.categories.every((c) => c.loops.length >= 1 && c.boundaries.length >= 1),
    d.categories.map((c) => [c.id, c.loops.length, c.boundaries.length]));
  check('基线覆盖 5000、复测覆盖 4900',
    approx(d.baselineCoveredPx, 5000) && approx(d.retestCoveredPx, 4900), d);
  check('贡献名单：基线 A、复测 C',
    d.contributingBaselineCells.some((x) => x.key === 'A') &&
    d.contributingRetestCells.some((x) => x.key === 'C'), d);
}

// ---------- 2) 完全共同覆盖 ----------
{
  const field = { id: 'f1', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const d = diffOf(
    report('b', 'img1', 1, [cell('A', rect(0, 0, 100, 100))]),
    report('r', 'img1', 1, [cell('C', rect(0, 0, 100, 100))]), field);
  check('全覆盖：both=10000', approx(byId(d, 'both').areaPx, 10000), d);
  check('全覆盖：其余三类 = 0',
    ['retestOnly', 'baselineOnly', 'none'].every((id) => approx(byId(d, id).areaPx, 0)), d);
  check('全覆盖恒等：sum=10000', approx(d.sumAreaPx, 10000), d);
}

// ---------- 3) 重叠细胞先取并集，不重复计 ----------
{
  const field = { id: 'f1', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const b = report('b', 'img1', 1, [
    cell('A', rect(0, 0, 60, 100)),   // 6000
    cell('B', rect(40, 0, 60, 100))   // 与 A 重叠 20×100=2000；并集铺满 10000
  ]);
  const r = report('r', 'img1', 1, []);
  const d = diffOf(b, r, field);
  check('重叠基线细胞并集 = 10000（仅基线）', approx(byId(d, 'baselineOnly').areaPx, 10000), d);
  check('并集后无始终未覆盖', approx(byId(d, 'none').areaPx, 0), d);
}

// ---------- 4) 细胞孔洞挖空：孔洞落入“始终未覆盖” ----------
{
  const field = { id: 'f1', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const b = report('b', 'img1', 1, [cell('A', rect(0, 0, 100, 100), [rect(10, 10, 20, 20)])]);
  const r = report('r', 'img1', 1, []);
  const d = diffOf(b, r, field);
  check('带孔细胞覆盖 9600', approx(byId(d, 'baselineOnly').areaPx, 9600), d);
  check('孔洞 400 归始终未覆盖', approx(byId(d, 'none').areaPx, 400), d);
}

// ---------- 5) 复测细胞填进基线细胞的孔洞：该处基线净区域未覆盖、复测覆盖 → 仅复测 ----------
{
  const field = { id: 'f1', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const b = report('b', 'img1', 1, [cell('A', rect(0, 0, 100, 100), [rect(10, 10, 20, 20)])]);
  const r = report('r', 'img1', 1, [cell('C', rect(0, 0, 100, 100))]); // 复测实体覆盖整视野（含基线孔洞）
  const d = diffOf(b, r, field);
  check('细胞实体 9600 两次都覆盖 → 共同 9600', approx(byId(d, 'both').areaPx, 9600), d);
  check('基线孔洞被复测实体填上（基线净区域未覆盖）→ 仅复测 400', approx(byId(d, 'retestOnly').areaPx, 400), d);
  check('始终未覆盖 0、仅基线 0',
    approx(byId(d, 'none').areaPx, 0) && approx(byId(d, 'baselineOnly').areaPx, 0), d);
}

// ---------- 6) 跨视野边界的细胞只计内部；仅边界接触不贡献 ----------
{
  const field = { id: 'f1', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const b = report('b', 'img1', 1, [
    cell('A', rect(50, 0, 100, 50)),   // 跨右边界：内部 50×50=2500
    cell('T', rect(0, 100, 100, 20))   // 仅共享底边 y=100：0
  ]);
  const r = report('r', 'img1', 1, []);
  const d = diffOf(b, r, field);
  check('跨边界细胞只计内部 2500', approx(byId(d, 'baselineOnly').areaPx, 2500), d);
  check('仅边界接触细胞不贡献，名单只有 A',
    d.contributingBaselineCells.length === 1 && d.contributingBaselineCells[0].key === 'A', d);
}

// ---------- 7) 视野孔洞永不归属任何一类（即便有细胞落入） ----------
{
  const field = { id: 'f1', name: 'F', outer: rect(0, 0, 100, 100), holes: [rect(0, 0, 30, 30)] };
  const b = report('b', 'img1', 1, [cell('A', rect(0, 0, 100, 100))]);
  const r = report('r', 'img1', 1, [cell('C', rect(0, 0, 100, 100))]);
  const d = diffOf(b, r, field);
  check('视野孔洞即便两侧都覆盖：共同 = 净面积 9100', approx(byId(d, 'both').areaPx, 9100), d);
  check('四类之和仍为净面积 9100（孔洞 900 永不计入）', approx(d.sumAreaPx, 9100), d);
}

// ---------- 8) 物理面积按基线标尺；两份标尺不同给出依据 ----------
{
  const field = { id: 'f1', name: 'F', outer: rect(0, 0, 100, 100), holes: [] };
  const b = report('b', 'img1', 2, [cell('A', rect(0, 0, 100, 100))]); // 2 μm/px
  const r = report('r', 'img1', 1, [cell('C', rect(0, 0, 100, 100))]); // 1 μm/px
  const d = diffOf(b, r, field);
  check('不同标尺：mm² 按基线 2μm/px → 0.04', approx(byId(d, 'both').areaMm2, 0.04), d);
  check('scalesDiffer=true 且保留两侧标尺',
    d.scalesDiffer === true && d.baselineScaleUmPerPx === 2 && d.retestScaleUmPerPx === 1, d);
  check('换算依据文本提示基线标尺', /基线标尺/.test(d.scaleBasis) && /复测报告标尺/.test(d.scaleBasis), d.scaleBasis);

  // 相同标尺：scalesDiffer=false
  const d2 = diffOf(
    report('b2', 'img1', 1, [cell('A', rect(0, 0, 100, 100))]),
    report('r2', 'img1', 1, [cell('C', rect(0, 0, 100, 100))]), field);
  check('相同标尺：scalesDiffer=false', d2.scalesDiffer === false, d2);
}

// ---------- 9) 报错语义 ----------
function errCheck(name, fn, status, re) {
  try { fn(); check(name, false, '未抛错'); }
  catch (e) {
    check(name, e.status === status && (re ? re.test(e.message) : true), { status: e.status, msg: e.message });
  }
}
{
  const f = { id: 'f1', name: 'F', outer: rect(0, 0, 10, 10), holes: [] };
  const b = report('b', 'img1', 1, []);
  const r = report('r', 'img1', 1, []);
  errCheck('相同报告 → 400', () => D.validateReports(b, b, 'b', 'b'), 400, /两份不同/);
  errCheck('不同切片 → 400', () => D.validateReports(b, report('r2', 'imgX', 1, []), 'b', 'r2'), 400, /同一切片/);
  errCheck('基线报告不存在 → 404', () => D.validateReports(null, r, 'x', 'r'), 404, /基线报告/);
  errCheck('复测报告不存在 → 404', () => D.validateReports(b, null, 'b', 'x'), 404, /复测报告/);
  errCheck('缺少复测标识 → 400', () => D.validateReports(b, null, 'b', ''), 400);
  errCheck('尺寸不一致 → 400', () => D.validateReports(b, report('r3', 'img1', 1, [], [400, 400]), 'b', 'r3'), 400, /尺寸不一致/);
  errCheck('视野标识为空 → 400', () => D.resolveBaselineField([f], '  '), 400);
  errCheck('视野不存在 → 400', () => D.resolveBaselineField([f], 'nope'), 400, /基线视野不存在/);
  errCheck('视野名称歧义 → 400',
    () => D.resolveBaselineField([
      { id: '1', name: '同名', outer: rect(0, 0, 5, 5), holes: [] },
      { id: '2', name: '同名', outer: rect(0, 0, 5, 5), holes: [] }
    ], '同名'), 400, /无法唯一确定/);

  // 名称唯一时可按名称匹配
  const got = D.resolveBaselineField([{ id: '1', name: '唯一', outer: rect(0, 0, 5, 5), holes: [] }], ' 唯一 ');
  check('按名称（trim）匹配成功 matchBy=name', got.matchBy === 'name' && got.field.id === '1', got);
}

if (failures) { console.error(`\n${failures} 项失败`); process.exit(1); }
console.log('\n全部跨报告覆盖变化核对纯几何自测通过 ✔');
