'use strict';
// Small charts drawn as SVG (no library): bars and lines, with a tooltip on hover.
// Usage: put chart({...}) in the page's HTML, then call drawCharts(root) once it is on the page.
// Colours follow the series (sales is always the first colour), never the rank.

const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
const CH = { specs: new Map(), n: 0 };

function niceStep(range, ticks = 4) {
  const raw = range / ticks;
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}
function niceDomain(values) {
  let lo = Math.min(0, ...values), hi = Math.max(0, ...values);
  if (lo === hi) hi = lo + 1;
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return { lo, hi, ticks };
}
// 1250 → 1.3k, 2400000 → 2.4M (axis labels only; tooltips show the full amount)
function shortNum(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n * 100) / 100);
}

// spec: { type: 'bars' | 'lines', labels: [...], series: [{ name, values: [...], color? }], fmt?: (v) => text,
//         height?, area?: true (lines: shade under the first line), tip?: (i) => extra text lines }
function chart(spec) {
  const id = 'ch' + (++CH.n);
  CH.specs.set(id, spec);
  const many = spec.series.length > 1;
  const legend = many ? `<div class="legend">${spec.series.map((s, i) => `<span><i style="background:${s.color || SERIES[i]}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `${legend}<div class="chart" data-chart="${id}" style="height:${spec.height || 220}px"></div>`;
}

function drawCharts(root = document) {
  for (const el of root.querySelectorAll('[data-chart]')) {
    const spec = CH.specs.get(el.dataset.chart);
    if (spec) el.innerHTML = renderChart(spec, Math.max(240, el.clientWidth || 600), spec.height || 220);
  }
}

function renderChart(spec, W, H) {
  const fmt = spec.fmt || ((v) => num(v));
  const series = spec.series.map((s, i) => ({ ...s, color: s.color || SERIES[i] }));
  const labels = spec.labels;
  const n = labels.length;
  const all = series.flatMap((s) => s.values);
  const { lo, hi, ticks } = niceDomain(all.length ? all : [0]);
  const endLabels = spec.type === 'lines' && series.length > 1 && series.length <= 4;
  const L = 48, R = endLabels ? 74 : 10, T = 10, B = 26;
  const pw = W - L - R, ph = H - T - B;
  const y = (v) => T + ph - ((v - lo) / (hi - lo)) * ph;
  const band = pw / Math.max(n, 1);
  const cx = (i) => L + band * i + band / 2;
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / 54))));
  const tips = [];
  const tipFor = (i) => {
    const lines = series.map((s) => `<span class="tip-row"><i style="background:${s.color}"></i>${esc(s.name)}: <b>${esc(fmt(s.values[i] ?? 0))}</b></span>`);
    const extra = spec.tip ? spec.tip(i) : [];
    return `<b class="tip-head">${esc(labels[i])}</b>${lines.join('')}${extra.map((x) => `<span class="tip-row muted">${esc(x)}</span>`).join('')}`;
  };

  let g = '<g class="ch-grid">';
  for (const t of ticks) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"${t === 0 ? ' class="zero"' : ''}/><text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${esc(shortNum(t))}</text>`;
  g += '</g><g class="ch-x">';
  for (let i = 0; i < n; i += every) g += `<text x="${cx(i)}" y="${H - 8}" text-anchor="middle">${esc(labels[i])}</text>`;
  g += '</g>';

  let marks = '';
  if (spec.type === 'bars') {
    const k = series.length;
    const groupW = Math.min(band - 4, k * 38);
    const bw = Math.max(2, (groupW - (k - 1) * 2) / k);
    for (let i = 0; i < n; i++) {
      let bars = '';
      series.forEach((s, j) => {
        const v = s.values[i] || 0;
        if (!v) return;
        const x = cx(i) - groupW / 2 + j * (bw + 2);
        const y0 = y(0), y1 = y(v);
        const top = Math.min(y0, y1), h = Math.max(1, Math.abs(y1 - y0));
        const r = Math.min(4, bw / 2, h);
        // rounded at the data end, square on the baseline
        const d = v >= 0
          ? `M${x},${y0}V${top + r}Q${x},${top} ${x + r},${top}H${x + bw - r}Q${x + bw},${top} ${x + bw},${top + r}V${y0}Z`
          : `M${x},${y0}V${top + h - r}Q${x},${top + h} ${x + r},${top + h}H${x + bw - r}Q${x + bw},${top + h} ${x + bw},${top + h - r}V${y0}Z`;
        bars += `<path class="ch-bar" d="${d}" fill="${s.color}"/>`;
      });
      tips.push(tipFor(i));
      marks += `<g class="ch-band" data-ti="${i}">${bars}<rect x="${L + band * i}" y="${T}" width="${band}" height="${ph}" fill="transparent"/></g>`;
    }
  } else {
    if (spec.area && series[0]) {
      const s = series[0];
      const pts = s.values.map((v, i) => `${cx(i)},${y(v || 0)}`).join(' L');
      marks += `<path d="M${cx(0)},${y(0)} L${pts} L${cx(n - 1)},${y(0)}Z" fill="${s.color}" opacity=".10"/>`;
    }
    for (const s of series) {
      const pts = s.values.map((v, i) => `${i ? 'L' : 'M'}${cx(i)},${y(v || 0)}`).join('');
      marks += `<path d="${pts}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
      if (n === 1) marks += `<circle cx="${cx(0)}" cy="${y(s.values[0] || 0)}" r="4" fill="${s.color}"/>`;
    }
    if (endLabels) {
      // names at the end of each line, pushed apart so they never sit on top of each other
      const ends = series.map((s) => ({ s, yy: y(s.values[n - 1] || 0) })).sort((a, b) => a.yy - b.yy);
      for (let i = 1; i < ends.length; i++) if (ends[i].yy - ends[i - 1].yy < 14) ends[i].yy = ends[i - 1].yy + 14;
      for (const e of ends) marks += `<text class="ch-end" x="${W - R + 8}" y="${e.yy + 4}">${esc(e.s.name.length > 10 ? e.s.name.slice(0, 9) + '…' : e.s.name)}</text>`;
    }
    for (let i = 0; i < n; i++) {
      tips.push(tipFor(i));
      const dots = series.map((s) => `<circle class="ch-on" cx="${cx(i)}" cy="${y(s.values[i] || 0)}" r="5" fill="${s.color}" stroke="#fff" stroke-width="2"/>`).join('');
      marks += `<g class="ch-col" data-ti="${i}"><line class="ch-on ch-xhair" x1="${cx(i)}" x2="${cx(i)}" y1="${T}" y2="${T + ph}"/>${dots}<rect x="${L + band * i}" y="${T}" width="${band}" height="${ph}" fill="transparent"/></g>`;
    }
  }
  spec.tips = tips;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(series.map((s) => s.name).join(', '))}">${g}${marks}</svg>`;
}

// One tooltip for every chart on the page.
(function chartTips() {
  let tip = null;
  const show = (html, e) => {
    if (!tip) { tip = document.createElement('div'); tip.id = 'chartTip'; document.body.appendChild(tip); }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    let x = e.clientX + 14, yy = e.clientY + 14;
    if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 14;
    if (yy + r.height > innerHeight - 8) yy = e.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + 'px'; tip.style.top = Math.max(8, yy) + 'px';
  };
  document.addEventListener('mousemove', (e) => {
    const g = e.target.closest && e.target.closest('[data-ti]');
    const host = g && g.closest('[data-chart]');
    const spec = host && CH.specs.get(host.dataset.chart);
    if (spec && spec.tips) show(spec.tips[+g.dataset.ti], e);
    else if (tip) tip.style.display = 'none';
  });
  let t = null;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => drawCharts(), 150); });
})();

// A row of horizontal bars made of plain HTML (good for long names): [{ name, value, sub? }]
function hbars(rows, { fmt = (v) => num(v), color = SERIES[0] } = {}) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return `<div class="hbars">${rows.map((r) => `<div class="hb-row"><div class="hb-name">${esc(r.name)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</div>
    <div class="hb-track"><div class="hb-fill" style="width:${Math.max(0.5, (Math.abs(r.value) / max) * 100)}%;background:${r.color || color}"></div></div><div class="hb-val">${esc(fmt(r.value))}</div></div>`).join('')}</div>`;
}
