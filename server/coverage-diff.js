'use strict';

// 跨报告同视野覆盖变化核对（只读）：
//
// 选定同一切片的两份【不同】已发布报告（含更正链上的历史报告），并指定【基线报告】中的
// 一个取样视野。两次标注都在同一张切片图片的同一像素坐标系内（报告共享 image_id、
// 冻结的宽高一致），因此可直接在基线视野净区域上做逐点的覆盖分类：
//
//   共同覆盖 both       ：基线净区域内、同时被某基线细胞与某复测细胞净区域覆盖；
//   仅复测 retestOnly   ：基线净区域内、被复测覆盖但基线未覆盖；
//   仅基线 baselineOnly ：基线净区域内、被基线覆盖但复测未覆盖；
//   始终未覆盖 none     ：基线净区域内、两次都未覆盖。
//
// 四类把【基线视野净区域】（外环扣除孔洞）精确、无重叠地划满：四类像素面积（px²）之和
// 恰为视野净面积；物理面积（mm²）一律按【基线标尺】换算（复测细胞先与基线视野做几何交集，
// 与复测自身标尺无关；两份标尺不同时由调用方明确提示换算依据）。
//
// 与单视野覆盖核对一致：
//   - 细胞先相互取【并集】，重叠细胞不重复计面积；
//   - 跨越视野边界的细胞只计落在视野内部的部分；
//   - 细胞孔洞、视野孔洞、仅边界接触（零面积）一律不贡献面积。
//
// 本文件同时以 CommonJS（服务端/自测）与浏览器全局 CoverageDiff 两种方式可用，
// 服务端与页端使用完全相同的几何实现（MergeStats 平面排列）。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./geometry'), require('./merge-stats'));
  } else {
    // 浏览器：几何原语由 ClientGeom 提供，平面排列由 MergeStats 提供
    root.CoverageDiff = factory({
      pointStrictlyInside: root.ClientGeom.gPointStrictlyInside,
      pointInsideOrOn: root.ClientGeom.gPointInsideOrOn,
      signedArea: root.ClientGeom.gSignedArea
    }, root.MergeStats);
  }
})(typeof self !== 'undefined' ? self : this, function (geo, MergeStats) {

  const EPS = 1e-9;
  const ROUND_N = 6; // 面积展示与“四类之和=视野净面积”对齐的小数位

  // 四类的稳定标识与中文名（页面/JSON 共用）
  const CATEGORIES = [
    { id: 'both', label: '共同覆盖' },
    { id: 'retestOnly', label: '仅复测覆盖' },
    { id: 'baselineOnly', label: '仅基线覆盖' },
    { id: 'none', label: '始终未覆盖' }
  ];
  const CATEGORY_IDS = CATEGORIES.map((c) => c.id);

  function round(v, n = ROUND_N) {
    const f = 10 ** n;
    return Math.round(v * f) / f;
  }

  // μm/px → mm²/px²（与 fields.js / merge-stats.js 相同换算）
  function px2ToMm2(areaPx, scale) {
    return areaPx * scale * scale / 1e6;
  }

  function cellKey(cell, index) {
    return (cell && typeof cell.id === 'string' && cell.id) ? cell.id : `#${index}`;
  }

  function ringBBox(ring) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of ring) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, minY, maxX, maxY };
  }

  function bboxOfNet(shape) {
    const b = ringBBox(shape.outer);
    for (const h of shape.holes || []) {
      const hb = ringBBox(h);
      if (hb.minX < b.minX) b.minX = hb.minX;
      if (hb.minY < b.minY) b.minY = hb.minY;
      if (hb.maxX > b.maxX) b.maxX = hb.maxX;
      if (hb.maxY > b.maxY) b.maxY = hb.maxY;
    }
    return b;
  }

  function bboxOverlap(a, b) {
    return !(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY);
  }

  // 点 p 是否严格落在净区域：严格在外环内，且不在任何孔洞内/边界上。
  function pointInNet(p, shape) {
    if (!geo.pointStrictlyInside(p, shape.outer)) return false;
    for (const h of shape.holes || []) {
      if (geo.pointInsideOrOn(p, h)) return false;
    }
    return true;
  }

  // ---------- 请求校验 ----------
  //
  // baseline / retest：水合后的报告对象（含 id、imageId、width、height、fields、cells、calib）。
  // 严格按需求报错：相同报告、不同切片、报告/视野不存在、视野名称歧义。
  function validateReports(baseline, retest, baselineId, retestId) {
    if (typeof baselineId !== 'string' || !baselineId ||
        typeof retestId !== 'string' || !retestId) {
      throw { status: 400, message: '请分别选择基线报告 baselineReportId 与复测报告 retestReportId' };
    }
    if (!baseline) throw { status: 404, message: `基线报告 ${baselineId} 不存在` };
    if (!retest) throw { status: 404, message: `复测报告 ${retestId} 不存在` };
    if (baseline.id === retest.id || baselineId === retestId) {
      throw { status: 400, message: '基线与复测必须是两份不同的报告（不能选择同一份报告），请求被拒绝' };
    }
    if (baseline.imageId !== retest.imageId) {
      throw {
        status: 400,
        message: `两份报告不属于同一切片：基线报告《${baseline.title}》属于切片 ${baseline.imageId}，` +
          `复测报告《${retest.title}》属于切片 ${retest.imageId}；覆盖变化核对只支持同一切片的两份报告，请求被拒绝`
      };
    }
    // 防御：同一 image_id 下冻结宽高理应一致；不一致则像素坐标系不可对齐
    if (baseline.width !== retest.width || baseline.height !== retest.height) {
      throw {
        status: 400,
        message: `两份报告冻结的图片尺寸不一致（基线 ${baseline.width}×${baseline.height}，` +
          `复测 ${retest.width}×${retest.height}），像素坐标系无法对齐，无法核对同一视野，请求被拒绝`
      };
    }
  }

  // 解析基线视野标识：先按 id 精确匹配，再按名称（trim 后）精确匹配。
  // 空标识 → 400；不存在 → 400；同名歧义 → 400（提示改用 id）。
  function resolveBaselineField(fields, identifier) {
    const all = Array.isArray(fields) ? fields : [];
    if (typeof identifier !== 'string' || !identifier.trim()) {
      throw { status: 400, message: '请提供基线报告中的视野标识 fieldId（视野 id 或视野名称）' };
    }
    const idIndex = all.findIndex((f) => f && typeof f.id === 'string' && f.id === identifier);
    if (idIndex >= 0) return { field: all[idIndex], matchBy: 'id' };
    const name = identifier.trim();
    const nameMatches = [];
    all.forEach((f, i) => {
      if (f && typeof f.name === 'string' && f.name.trim() === name) nameMatches.push(i);
    });
    if (nameMatches.length === 1) return { field: all[nameMatches[0]], matchBy: 'name' };
    if (nameMatches.length > 1) {
      throw {
        status: 400,
        message: `视野名称「${name}」在基线报告中存在 ${nameMatches.length} 个同名视野，无法唯一确定，` +
          '请改用视野 id 查询（可在基线报告详情的 fields 中获取）'
      };
    }
    throw {
      status: 400,
      message: `基线视野不存在：${identifier}（不属于基线报告；请使用该报告冻结 fields 中的视野 id 或名称，` +
        '可先在报告详情获取视野列表），请求被拒绝'
    };
  }

  // 在既有排列上下文上做有向面积求和（复用 merge-stats 的符号求和约定）。
  // 仅用于“某细胞与视野是否存在正面积交集”的判定；近零残差归零。
  function signedAreaIn(ctx, predicate) {
    let sum = 0;
    for (const loop of ctx.loops) {
      if (predicate(loop.q)) sum += loop.area;
    }
    return Math.abs(sum) < 1e-7 ? 0 : sum;
  }

  // ---------- 核心：四类覆盖分区 ----------
  //
  // baseline / retest：报告对象；field：基线报告中的目标视野。
  // 返回各类像素/mm²面积、占比、可渲染的有向环与边界、以及有正面积贡献的两侧细胞名单。
  function buildCoverageDiff(baseline, retest, field) {
    const bCells = Array.isArray(baseline.cells) ? baseline.cells : [];
    const rCells = Array.isArray(retest.cells) ? retest.cells : [];
    const bScale = baseline.calib ? baseline.calib.scale : null;
    const rScale = retest.calib ? retest.calib.scale : null;

    // 基线视野净面积（外环扣除孔洞）——与逐视野统计/单视野覆盖核对同公式
    const fieldAreaPx = Math.abs(geo.signedArea(field.outer)) -
      (field.holes || []).reduce((s, h) => s + Math.abs(geo.signedArea(h)), 0);

    // 仅保留外环包围盒与视野相交的细胞（孔洞在各自外环内部），控制排列规模
    const fieldBox = bboxOfNet(field);
    const baseCand = [];
    bCells.forEach((cell, index) => {
      if (cell && Array.isArray(cell.outer) && bboxOverlap(fieldBox, bboxOfNet(cell))) {
        baseCand.push({ cell, index });
      }
    });
    const retestCand = [];
    rCells.forEach((cell, index) => {
      if (cell && Array.isArray(cell.outer) && bboxOverlap(fieldBox, bboxOfNet(cell))) {
        retestCand.push({ cell, index });
      }
    });

    // 一个排列容纳：基线视野（shapes[0]）+ 基线候选细胞 + 复测候选细胞。
    // 面积归属都由“排列面采样点在不在对应净区域内”的谓词决定，
    // 因此跨边界细胞只计内部、多细胞重叠只计一次、孔洞/仅边界接触不贡献。
    const shapes = [field]
      .concat(baseCand.map((x) => x.cell))
      .concat(retestCand.map((x) => x.cell));
    const baseStart = 1;
    const retestStart = 1 + baseCand.length;
    const ctx = MergeStats.buildArrangement(shapes);

    const inField = (q) => pointInNet(q, field);
    const coveredBy = (q, start, cand) => {
      for (let i = 0; i < cand.length; i++) {
        if (pointInNet(q, ctx.shapes[start + i])) return true;
      }
      return false;
    };
    const inBaselineCells = (q) => coveredBy(q, baseStart, baseCand);
    const inRetestCells = (q) => coveredBy(q, retestStart, retestCand);

    // 排列圈 → 四类（视野净区域之外记 'outside'，不参与面积划分）
    function faceCategory(loop) {
      const q = loop.q;
      if (!inField(q)) return 'outside';
      const b = inBaselineCells(q);
      const r = inRetestCells(q);
      if (b && r) return 'both';
      if (r && !b) return 'retestOnly';
      if (b && !r) return 'baselineOnly';
      return 'none';
    }
    const faceCat = ctx.loops.map(faceCategory);

    // 各类有向面积求和：圈方向自带符号（CCW 外 +、CW 孔 −），孔洞/嵌套自动正确。
    const rawPx = { both: 0, retestOnly: 0, baselineOnly: 0, none: 0 };
    ctx.loops.forEach((loop, fi) => {
      const cat = faceCat[fi];
      if (cat !== 'outside') rawPx[cat] += loop.area;
    });

    // 数值噪声夹取到 [0, 视野净面积]
    const clamp = (v) => Math.max(0, Math.min(v, Math.max(0, fieldAreaPx)));
    const areasPx = {
      both: clamp(rawPx.both),
      retestOnly: clamp(rawPx.retestOnly),
      baselineOnly: clamp(rawPx.baselineOnly),
      none: clamp(rawPx.none)
    };

    // 让四类（6 位小数取整后）之和精确等于视野净面积：把取整残差补给面积最大的一类。
    // 浮点误差远小于取整精度，该调整只影响第 6 位小数；图形按真实几何渲染，与数值一致。
    const roundedTotal = round(fieldAreaPx);
    let biggest = 'none';
    for (const id of CATEGORY_IDS) if (areasPx[id] > areasPx[biggest]) biggest = id;
    const sumRounded0 = CATEGORY_IDS.reduce((s, id) => s + round(areasPx[id]), 0);
    areasPx[biggest] = Math.max(0, areasPx[biggest] + round(roundedTotal - sumRounded0));
    // 理论上残差已清；再兜一次，保证恒等
    const sumRounded1 = CATEGORY_IDS.reduce((s, id) => s + round(areasPx[id]), 0);
    const rest = round(roundedTotal - sumRounded1);
    if (rest !== 0) areasPx[biggest] = Math.max(0, areasPx[biggest] + rest);

    // ---------- 可渲染几何：有向环（填充）+ 跨类边界（描边） ----------
    //
    // buildArrangement 的每个遍历圈是一条有向边界圈（CCW 外圈 / CW 孔洞内圈），
    // 与 ctx.loops 一一对应。前端对每一类把其全部有向环放进同一 PATH，按非零缠绕规则
    // 一次性填充：外边界与孔洞环自动合成挖空区域。坐标取 3 位小数（输入精度 1e-3）。
    const r3 = (v) => Math.round(v * 1000) / 1000;
    const regionLoops = { both: [], retestOnly: [], baselineOnly: [], none: [] };
    const seenCycle = new Set();
    for (const he0 of ctx.halfEdges) {
      if (seenCycle.has(he0)) continue;
      const cat = he0.face !== undefined ? faceCat[he0.face] : 'outside';
      const pts = [];
      let he = he0;
      do {
        seenCycle.add(he);
        pts.push({ x: r3(he.from.x), y: r3(he.from.y) });
        he = he.next;
      } while (he && he !== he0);
      if (cat !== 'outside' && pts.length >= 3) regionLoops[cat].push(pts);
    }

    // 跨类边界：无向边两侧圈类别不同则属于该边界（视野净区域外侧记 'outside'）。
    // 一条边最多关联两类，各自“实际区域边界”都含它——因此视野外环、视野孔洞环、
    // 细胞覆盖分界线都会被画出；仅边界接触（零面积接缝）两侧同类，不会产生边界。
    const boundaries = { both: [], retestOnly: [], baselineOnly: [], none: [] };
    const edgeSeen = new Set();
    for (const he of ctx.halfEdges) {
      const a = he.from, b = he.to;
      const key = a.idx < b.idx ? `${a.idx}|${b.idx}` : `${b.idx}|${a.idx}`;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      const catA = he.face !== undefined ? faceCat[he.face] : 'outside';
      const catB = he.twin && he.twin.face !== undefined ? faceCat[he.twin.face] : 'outside';
      if (catA === catB) continue; // 同类内部接缝（含仅边界接触）不画
      const seg = [{ x: r3(a.x), y: r3(a.y) }, { x: r3(b.x), y: r3(b.y) }];
      if (catA !== 'outside') boundaries[catA].push(seg);
      if (catB !== 'outside') boundaries[catB].push(seg);
    }

    // ---------- 有正面积贡献的细胞名单（各自与视野净交集 > EPS） ----------
    // shapes[0] 为视野；基线细胞从 1 开始，复测细胞从 1 + baseCand.length 开始。
    const hitCells = (start, cand) => {
      const out = [];
      cand.forEach((entry, ci) => {
        const shapeIdx = start + ci;
        const a = signedAreaIn(ctx, (q) =>
          inField(q) && pointInNet(q, ctx.shapes[shapeIdx]));
        if (a > EPS) out.push({ key: cellKey(entry.cell, entry.index), name: entry.cell.name || '' });
      });
      return out;
    };
    const hitBase = hitCells(baseStart, baseCand)
      .sort((a, c) => (a.key < c.key ? -1 : a.key > c.key ? 1 : 0));
    const hitRetest = hitCells(retestStart, retestCand)
      .sort((a, c) => (a.key < c.key ? -1 : a.key > c.key ? 1 : 0));

    // ---------- 物理面积：一律按基线标尺换算 ----------
    const calibrated = typeof bScale === 'number' && Number.isFinite(bScale) && bScale > 0;
    const retestCalibrated = typeof rScale === 'number' && Number.isFinite(rScale) && rScale > 0;
    const toMm2 = (px) => px2ToMm2(px, bScale);
    const fieldAreaMm2 = calibrated ? toMm2(fieldAreaPx) : null;
    const scaleSame = retestCalibrated && calibrated && Math.abs(rScale - bScale) <= 1e-12;

    const buildCategory = (id, label) => {
      const px = areasPx[id];
      const ratio = fieldAreaPx > 0 ? px / fieldAreaPx : 0;
      const mm2 = calibrated ? toMm2(px) : null;
      return {
        id,
        label,
        areaPx: round(px),
        areaMm2: calibrated ? round(mm2) : null,
        ratio: round(ratio),
        percent: round(ratio * 100, 2),
        percentText: `${round(ratio * 100, 2)}%`,
        areaText: calibrated ? String(round(mm2)) : '待定标',
        loops: regionLoops[id],
        boundaries: boundaries[id]
      };
    };
    const categories = CATEGORIES.map((c) => buildCategory(c.id, c.label));

    return {
      kind: 'coverage-diff',
      fieldName: (field && field.name && String(field.name).trim()) || '',
      fieldHoles: Array.isArray(field.holes) ? field.holes.length : 0,
      width: baseline.width,
      height: baseline.height,
      // 基线视野净面积（划分母区域）
      fieldAreaPx: roundedTotal,
      fieldAreaMm2: calibrated ? round(fieldAreaMm2) : null,
      fieldAreaText: calibrated ? String(round(fieldAreaMm2)) : '待定标',
      // 四类（顺序固定：共同 / 仅复测 / 仅基线 / 始终未覆盖）
      categories,
      // 恒等校验：四类 px² 与 mm² 之和等于视野净面积
      sumAreaPx: round(CATEGORY_IDS.reduce((s, id) => s + areasPx[id], 0)),
      sumAreaMm2: calibrated
        ? round(CATEGORY_IDS.reduce((s, id) => s + toMm2(areasPx[id]), 0))
        : null,
      // 两侧覆盖率（便于快速判断变化）
      baselineCoveredPx: round(areasPx.both + areasPx.baselineOnly),
      retestCoveredPx: round(areasPx.both + areasPx.retestOnly),
      baselineCoveredRatio: round(fieldAreaPx > 0
        ? (areasPx.both + areasPx.baselineOnly) / fieldAreaPx : 0),
      retestCoveredRatio: round(fieldAreaPx > 0
        ? (areasPx.both + areasPx.retestOnly) / fieldAreaPx : 0),
      // 标尺换算依据
      calibrated,
      baselineScaleUmPerPx: calibrated ? bScale : null,
      retestScaleUmPerPx: retestCalibrated ? rScale : null,
      scalesDiffer: calibrated && retestCalibrated && !scaleSame,
      scaleBasis: calibrated
        ? ('本视野全部物理面积（mm²）均按【基线标尺】1 px = ' +
           `${round(bScale, 6)} μm 换算（面积 × (μm/px)² ÷ 1e6）；` +
           (retestCalibrated && !scaleSame
             ? `复测报告标尺为 1 px = ${round(rScale, 6)} μm，与基线不同，复测标尺不参与本视野面积换算。`
             : '两份报告标尺一致。'))
        : '基线报告未定标，物理面积（mm²）无法换算（待定标）；像素面积与占比照常给出。',
      contributingBaselineCells: hitBase,
      contributingRetestCells: hitRetest
    };
  }

  return {
    CATEGORIES,
    CATEGORY_IDS,
    validateReports,
    resolveBaselineField,
    buildCoverageDiff
  };
});
