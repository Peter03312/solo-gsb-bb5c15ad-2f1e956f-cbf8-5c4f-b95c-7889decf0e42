'use strict';

// 跨报告同视野覆盖变化核对页：
// 选择同一切片的两份不同已发布报告 + 基线视野，在【基线图片快照】上叠加
// 可切换的四类实际区域（填充 + 边界），显示各类像素面积、占视野净面积比例与
// 按基线标尺换算的物理面积（mm²）。只读，取两份报告发布时冻结数据。

const COVERAGE_DIFF_COLORS = {
  both: '#4fd1c5',         // 共同覆盖：青绿
  retestOnly: '#7ed321',   // 仅复测：绿
  baselineOnly: '#f5a623', // 仅基线：橙
  none: '#9aa7b1'          // 始终未覆盖：灰
};

const CoverageDiffView = {
  reports: [],
  baselineReport: null,
  retestReport: null,
  result: null,         // 最近一次核对结果
  view: null,           // CanvasView
  fills: new Set(['both', 'retestOnly', 'baselineOnly', 'none']),
  borders: new Set(['both', 'retestOnly', 'baselineOnly', 'none']),
  _inited: false,

  esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  async open() {
    if (!this._inited) {
      this._inited = true;
      document.getElementById('cd-run').onclick = () => this.run();
      document.getElementById('cd-baseline').onchange = () => this.onBaselineChange();
      document.getElementById('cd-retest').onchange = () => { this.retestReport = this.picked('cd-retest'); };
    }
    await this.loadReports();
  },

  picked(selectId) {
    const id = document.getElementById(selectId).value;
    return this.reports.find((r) => r.id === id) || null;
  },

  async loadReports() {
    let reports;
    try {
      reports = await API.listReports();
    } catch (e) {
      this.showError(`报告列表加载失败：${e.message}`);
      return;
    }
    this.reports = reports;
    // 同一切片分组提示：下拉展示标题 + 切片/细胞数，便于选择同一切片的两份报告
    const option = (r) => {
      const chain = r.isChainTip ? '' : '（历史）';
      return `<option value="${this.esc(r.id)}">${this.esc(r.title)}${chain} · ` +
             `细胞 ${r.cells.length} · ${this.sliceTag(r)}</option>`;
    };
    const baseSel = document.getElementById('cd-baseline');
    const retestSel = document.getElementById('cd-retest');
    baseSel.innerHTML = reports.map(option).join('');
    retestSel.innerHTML = reports.map(option).join('');
    this.baselineReport = reports[0] || null;
    this.retestReport = reports[1] || reports[0] || null;
    if (this.baselineReport) baseSel.value = this.baselineReport.id;
    if (this.retestReport) retestSel.value = this.retestReport.id;
    this.fillFields();
    if (reports.length < 2) {
      this.showError('至少需要两份已发布报告（含同一切片的更正版本）才能核对覆盖变化。');
    } else {
      this.clearError();
    }
  },

  // 同一 image_id 的短标签（下拉里帮助辨认同一切片）
  sliceTag(r) {
    return `切片 ${String(r.imageId).slice(0, 8)}`;
  },

  onBaselineChange() {
    this.baselineReport = this.picked('cd-baseline');
    this.fillFields();
  },

  // 视野下拉来自【基线报告】冻结 fields
  fillFields() {
    const sel = document.getElementById('cd-field');
    const fields = (this.baselineReport && this.baselineReport.fields) || [];
    sel.innerHTML = fields.map((f, i) => {
      const name = (f.name && f.name.trim()) || `视野 ${i + 1}`;
      return `<option value="${this.esc(f.id)}">${this.esc(name)}</option>`;
    }).join('');
    if (!fields.length) {
      sel.innerHTML = '<option value="">（基线报告无取样视野）</option>';
    }
  },

  showError(msg) {
    const el = document.getElementById('cd-error');
    if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
    el.classList.remove('hidden');
    el.textContent = msg;
  },
  clearError() { this.showError(''); },

  async run() {
    this.baselineReport = this.picked('cd-baseline');
    this.retestReport = this.picked('cd-retest');
    const fieldSel = document.getElementById('cd-field');
    const fieldId = fieldSel.value;
    if (!this.baselineReport || !this.retestReport) return this.showError('请选择基线与复测两份报告。');
    if (!fieldId) return this.showError('基线报告中没有取样视野，无法核对（请先在该切片发布含视野的报告）。');

    this.clearError();
    let body;
    try {
      body = await API.reportCoverageDiff(this.baselineReport.id, this.retestReport.id, fieldId);
    } catch (e) {
      // 400：相同报告/不同切片/视野不存在/名称歧义；404：报告不存在。不写回任何数据
      this.showError(e.message);
      return;
    }
    this.result = body;
    this.fills = new Set(['both', 'retestOnly', 'baselineOnly', 'none']);
    this.borders = new Set(['both', 'retestOnly', 'baselineOnly', 'none']);
    this.renderResult();
  },

  fmtPx(v) {
    if (!Number.isFinite(v)) return '—';
    return (Math.round(v * 1000) / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  },
  fmtMm(v) {
    if (v === null || v === undefined) return '待定标';
    return String(v);
  },

  renderResult() {
    const body = this.result;
    const d = body.diff;
    document.getElementById('cd-result-panel').classList.remove('hidden');

    // 标尺换算依据（两份不同时显著提示）
    const scaleEl = document.getElementById('cd-scale-note');
    scaleEl.innerHTML = (d.scalesDiffer
      ? '<span class="cd-scale-warn">⚠ 两份报告标尺不同：</span>'
      : '标尺：') + this.esc(d.scaleBasis) +
      `<br>基线《${this.esc(body.baselineTitle)}》（草稿 v${body.baselineDraftVersion}）` +
      ` ↔ 复测《${this.esc(body.retestTitle)}》（草稿 v${body.retestDraftVersion}）` +
      ` · 视野 <b>${this.esc(d.fieldName || '(未命名)')}</b>${body.matchedBy === 'name' ? '（按名称匹配）' : ''}`;

    // 四类开关 + 数值表
    const toggles = document.getElementById('cd-toggles');
    toggles.innerHTML = '';
    const catMap = Object.fromEntries(d.categories.map((c) => [c.id, c]));
    d.categories.forEach((c) => {
      const color = COVERAGE_DIFF_COLORS[c.id];
      const wrap = document.createElement('label');
      wrap.className = 'cd-toggle';
      wrap.innerHTML =
        `<input type="checkbox" data-kind="fill" data-cat="${c.id}" ${this.fills.has(c.id) ? 'checked' : ''}/>` +
        `<input type="checkbox" data-kind="border" data-cat="${c.id}" ${this.borders.has(c.id) ? 'checked' : ''}/>` +
        `<span class="cd-swatch" style="background:${color}"></span>` +
        `<span>${this.esc(c.label)}</span>`;
      wrap.querySelectorAll('input').forEach((cb) => {
        cb.onchange = () => {
          const set = cb.dataset.kind === 'fill' ? this.fills : this.borders;
          if (cb.checked) set.add(cb.dataset.cat); else set.delete(cb.dataset.cat);
          this.renderOverlay();
        };
      });
      toggles.appendChild(wrap);
    });

    // 数值表：像素面积 / 占视野净面积比例 / mm²
    const rows = d.categories.map((c) => {
      const color = COVERAGE_DIFF_COLORS[c.id];
      return `<tr>
        <td><span class="cd-swatch" style="background:${color}"></span> ${this.esc(c.label)}</td>
        <td>${this.fmtPx(c.areaPx)}</td>
        <td>${this.esc(c.percentText)}</td>
        <td>${this.esc(this.fmtMm(c.areaMm2))}</td>
      </tr>`;
    }).join('');
    document.getElementById('cd-table').innerHTML = `
      <thead><tr><th>类别</th><th>像素面积 px²</th><th>占视野净面积</th><th>物理面积 mm²</th></tr></thead>
      <tbody>${rows}
        <tr class="cd-sum">
          <th>合计（= 视野净面积）</th>
          <td>${this.fmtPx(d.sumAreaPx)}</td>
          <td>100%</td>
          <td>${this.esc(d.sumAreaMm2 === null ? '待定标' : String(d.sumAreaMm2))}</td>
        </tr>
      </tbody>`;

    document.getElementById('cd-identity').innerHTML =
      `视野净面积：<b>${this.fmtPx(d.fieldAreaPx)} px²</b>` +
      (d.fieldAreaMm2 !== null ? ` · <b>${this.esc(String(d.fieldAreaMm2))} mm²</b>` : '') +
      `；四类像素面积之和 <b>${this.fmtPx(d.sumAreaPx)} px²</b>` +
      (d.sumAreaMm2 !== null ? `、mm² 之和 <b>${this.esc(String(d.sumAreaMm2))} mm²</b>` : '') +
      '，与视野净面积一致。<br>' +
      `基线覆盖率 ${(d.baselineCoveredRatio * 100).toFixed(2)}%` +
      ` → 复测覆盖率 ${(d.retestCoveredRatio * 100).toFixed(2)}%。`;

    const names = (arr) => arr.map((x) => this.esc(x.name || x.key)).join('、') || '（无）';
    document.getElementById('cd-cells').innerHTML =
      `<p class="hint">基线侧有正面积交集细胞 ${d.contributingBaselineCells.length} 个：${names(d.contributingBaselineCells)}<br>` +
      `复测侧有正面积交集细胞 ${d.contributingRetestCells.length} 个：${names(d.contributingRetestCells)}</p>`;

    this.loadCanvas(body);
  },

  async loadCanvas(body) {
    const d = body.diff;
    if (!this.view) {
      this.view = new CanvasView(document.getElementById('coverage-diff-canvas'), {
        onZoom: (k) => { document.getElementById('cd-zoom').textContent = `${Math.round(k * 100)}%`; }
      });
      this.view.readOnly = true;
    }
    // 画布数据：不画两侧原始细胞/视野，只画四类叠加层（底图为基线快照）
    this.view.bindState(() => ({
      cells: [], fields: [], calib: null,
      coverageOverlay: {
        categories: d.categories.map((c) => ({
          id: c.id,
          color: COVERAGE_DIFF_COLORS[c.id],
          fill: COVERAGE_DIFF_COLORS[c.id] + '59',
          loops: c.loops,
          boundaries: c.boundaries
        })),
        fills: this.fills,
        borders: this.borders
      }
    }));
    await this.view.loadImage(`/api/reports/${body.baselineReportId}/file`, d.width, d.height);
    this.view.readOnly = true;
    this.view.setTool('pan');
  },

  // 仅切换叠加层显示（不重新拉取/加载图片）
  renderOverlay() {
    if (this.view) this.view.render();
  }
};

window.CoverageDiffView = CoverageDiffView;
