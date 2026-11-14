// SG-REPORT v3: SepsisGuard report in a Power BI style
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const has = v => v !== null && v !== undefined && !Number.isNaN(v);
const num = (v, d = 0) => has(v) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '--';
const pct = (v, d = 1) => has(v) ? `${num(v, d)}%` : '--';
const REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
const FONT = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif';
const RESULTS = ['Caught early', 'Missed', 'False alarm', 'Quiet (no sepsis)'];
const charts = {};
const S = { report: null, summary: null, patients: [], details: {}, hosp: 'A', dim: 'Age group', page: 'overview',
            budget: 15, current: null, idx: 0, timer: null };

async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* ---------- chart engine: Power BI look, animated updates ---------- */
const barLabels = { id: 'barLabels', afterDatasetsDraw(c, args, o) {
  if (!o || !o.display) return;
  const ctx = c.ctx; ctx.save(); ctx.font = `600 11px ${FONT}`; ctx.fillStyle = '#252423';
  c.data.datasets.forEach((ds, i) => {
    const meta = c.getDatasetMeta(i);
    if (meta.hidden || meta.type !== 'bar') return;
    meta.data.forEach((el, j) => {
      const v = ds.data[j]; if (!has(v)) return;
      const t = num(v, o.decimals || 0) + (o.suffix || '');
      if (c.options.indexAxis === 'y') { ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(t, el.x + 4, el.y); }
      else { ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(t, el.x, el.y - 3); }
    });
  });
  ctx.restore();
} };
const center = { id: 'center', afterDraw(c, args, o) {
  if (!o || !o.text) return;
  const arc = c.getDatasetMeta(0).data[0]; if (!arc) return;
  const ctx = c.ctx, x = arc.x, y = arc.y, r = arc.outerRadius, ir = arc.innerRadius;
  ctx.save(); ctx.textAlign = 'center';
  if (o.max) {
    const a = Math.PI + Math.PI * Math.min(1, o.target / o.max);
    ctx.strokeStyle = '#252423'; ctx.lineWidth = 3; ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * (ir - 5), y + Math.sin(a) * (ir - 5)); ctx.lineTo(x + Math.cos(a) * (r + 5), y + Math.sin(a) * (r + 5)); ctx.stroke();
    ctx.fillStyle = o.color || '#252423'; ctx.font = `600 32px ${FONT}`; ctx.textBaseline = 'bottom'; ctx.fillText(o.text, x, y - 12);
    ctx.font = `12px ${FONT}`; ctx.fillStyle = '#605E5C'; ctx.textBaseline = 'top'; ctx.fillText(o.sub || '', x, y - 8);
    ctx.fillText('0%', x - (r + ir) / 2, y + 6); ctx.fillText(o.maxLabel || '', x + (r + ir) / 2, y + 6);
  } else {
    ctx.textBaseline = 'middle'; ctx.fillStyle = '#252423'; ctx.font = `600 26px ${FONT}`; ctx.fillText(o.text, x, y - 8);
    ctx.font = `12px ${FONT}`; ctx.fillStyle = '#605E5C'; ctx.fillText(o.sub || '', x, y + 15);
  }
  ctx.restore();
} };
function chartSetup() {
  if (!window.Chart) return;
  Chart.register(barLabels, center);
  Chart.defaults.font.family = FONT;
  Chart.defaults.color = '#605E5C';
  Chart.defaults.borderColor = '#EDEBE9';
  Chart.defaults.maintainAspectRatio = false;
  Object.assign(Chart.defaults.plugins.tooltip, { backgroundColor: '#FFFFFF', titleColor: '#252423', bodyColor: '#252423',
    borderColor: '#C8C6C4', borderWidth: 1, padding: 10, cornerRadius: 2, boxPadding: 4 });
  Object.assign(Chart.defaults.plugins.legend.labels, { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8 });
  if (REDUCED) Chart.defaults.animation = false;
  else Object.assign(Chart.defaults.animation, { duration: 900, easing: 'easeOutQuart' });
}
function upsert(id, config) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (!window.Chart) { el.replaceWith(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'The chart library could not load. Refresh the page.' })); return null; }
  const c = charts[id];
  if (c && c.config.type === config.type) {
    c.data.labels = config.data.labels;
    config.data.datasets.forEach((ds, i) => { if (c.data.datasets[i]) Object.assign(c.data.datasets[i], ds); else c.data.datasets.push(ds); });
    c.data.datasets.length = config.data.datasets.length;
    c.options = config.options;
    c.update();
    return c;
  }
  if (c) c.destroy();
  charts[id] = new Chart(el, config);
  return charts[id];
}
function freshCharts(page) {
  $$('canvas', page).forEach(cv => { if (charts[cv.id]) { charts[cv.id].destroy(); delete charts[cv.id]; } });
  $$('.kpi .v', page).forEach(v => { v.dataset.cur = '0'; });
}
const axis = (title, extra = {}) => ({ grid: { color: '#EDEBE9' }, border: { display: false }, title: { display: !!title, text: title }, ...extra });

/* ---------- animated KPI cards ---------- */
function countTo(el, to, d, suf, animate) {
  const from = parseFloat(el.dataset.cur || '0') || 0;
  el.dataset.cur = has(to) ? to : 0;
  if (!has(to)) { el.textContent = '--'; return; }
  if (REDUCED || !animate) { el.textContent = num(to, d) + suf; return; }
  const tok = {}; el._tok = tok;
  const t0 = performance.now();
  const step = now => {
    if (el._tok !== tok) return;
    const k = Math.min(1, (now - t0) / 800), e = 1 - Math.pow(1 - k, 3);
    el.textContent = num(from + (to - from) * e, d) + suf;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function kpis(sel, items, animate = true) {
  const box = $(sel);
  if (box.children.length !== items.length)
    box.innerHTML = items.map(() => '<div class="kpi"><div class="v" data-cur="0">0</div><div class="l"></div><div class="c"></div></div>').join('');
  items.forEach(([label, value, d, suf, cap, cls], i) => {
    const k = box.children[i];
    k.className = 'kpi' + (cls ? ' ' + cls : '');
    $('.l', k).textContent = label;
    $('.c', k).textContent = cap || '';
    countTo($('.v', k), value, d, suf, animate);
  });
}

/* ---------- pages, slicers, focus mode ---------- */
const RENDER = {};
function show(name) {
  if (!RENDER[name]) name = 'overview';
  S.page = name;
  if (name !== 'replay') stopPlay();
  $$('.page').forEach(p => p.classList.toggle('on', p.id === 'page-' + name));
  $$('#pages button').forEach(b => b.classList.toggle('on', b.dataset.page === name));
  if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
  const page = $('#page-' + name);
  freshCharts(page);
  if (S.report) RENDER[name]();
}
$('#pages').addEventListener('click', e => { const b = e.target.closest('button[data-page]'); if (b) show(b.dataset.page); });
document.addEventListener('click', e => {
  const b = e.target.closest('.tiles[data-slicer] button');
  if (!b) return;
  const key = b.parentElement.dataset.slicer;
  S[key] = b.dataset.v;
  $$(`.tiles[data-slicer="${key}"] button`).forEach(x => x.classList.toggle('on', x.dataset.v === S[key]));
  RENDER[S.page]();
});
const FOCUS_ICON = '<svg viewBox="0 0 16 16"><polyline points="10,2 14,2 14,6"/><polyline points="6,14 2,14 2,10"/><line x1="14" y1="2" x2="9" y2="7"/><line x1="2" y1="14" x2="7" y2="9"/></svg>';
$$('.tile-head').forEach(h => h.insertAdjacentHTML('beforeend', `<button class="focus" title="Focus mode" aria-label="Focus mode">${FOCUS_ICON}</button>`));
function setFocus(tile) {
  $$('.tile.focused').forEach(t => t.classList.remove('focused'));
  if (tile) tile.classList.add('focused');
  $('#backdrop').classList.toggle('on', !!tile);
  Object.values(charts).forEach(c => c.resize());
}
document.addEventListener('click', e => {
  const f = e.target.closest('.focus');
  if (f) { const t = f.closest('.tile'); setFocus(t.classList.contains('focused') ? null : t); }
});
$('#backdrop').addEventListener('click', () => setFocus(null));
document.addEventListener('keydown', e => { if (e.key === 'Escape') setFocus(null); });

/* ---------- page 1: overview ---------- */
function groupPhrase(dim, g) {
  return { 'Age group': `patients aged ${g}`, 'Sex': `${g.toLowerCase()} patients`, 'ICU type': `${g.toLowerCase()} ICU patients`,
           'Stay length': `stays of ${g.toLowerCase()}` }[dim] || g;
}
RENDER.overview = () => {
  const H = S.report.hospitals[S.hosp], k = H.kpi;
  const me = H.models.find(m => m.model === 'SepsisGuard') || {}, sirs = H.models.find(m => m.model === 'SIRS rule') || {};
  kpis('#ovKpis', [
    ['Test patients', k.patients, 0, '', `${num(k.sepsis)} developed sepsis in the ICU`],
    ['Sepsis caught', k.caught, 1, '%', `SIRS rule: ${pct(sirs.caught)}`, 'okay'],
    ['False alarms', k.false_alarms, 1, '%', `SIRS rule: ${pct(sirs.false_alarms)}`],
    ['Caught 6 h or more early', k.early6, 1, '%', 'of all sepsis patients'],
    ['Median warning', k.median_warning, 0, ' h', 'before sepsis began'],
    ['AUROC', k.auroc, 3, '', S.hosp === 'A' ? 'new patients, same hospital' : 'a hospital it never saw']]);
  const counts = RESULTS.map(r => H.outcomes[r] || 0), total = counts.reduce((a, b) => a + b, 0);
  upsert('ovDonut', { type: 'doughnut', data: { labels: RESULTS, datasets: [{ data: counts, borderColor: '#fff', borderWidth: 2,
      backgroundColor: [css('--caught'), css('--missed'), css('--falsealarm'), css('--quiet')] }] },
    options: { cutout: '62%', plugins: { legend: { position: 'bottom' }, center: { text: num(total), sub: 'patients' },
      tooltip: { callbacks: { label: c => `${c.label}: ${num(c.parsed)} (${pct(100 * c.parsed / total)})` } } } } });
  const wrap = t => t.length > 14 ? t.split(' ').reduce((L, w) => { const l = L[L.length - 1]; if (l && (l + ' ' + w).length <= 14) L[L.length - 1] = l + ' ' + w; else L.push(w); return L; }, []) : t;
  upsert('ovModels', { type: 'bar', data: { labels: H.models.map(m => wrap(m.model)), datasets: [
      { label: 'Sepsis caught', data: H.models.map(m => m.caught), backgroundColor: css('--caught'), borderRadius: 2 },
      { label: 'False alarms', data: H.models.map(m => m.false_alarms), backgroundColor: css('--falsealarm'), borderRadius: 2 }] },
    options: { layout: { padding: { top: 16 } }, plugins: { legend: { position: 'bottom' }, barLabels: { display: true, decimals: 1, suffix: '%' },
      tooltip: { callbacks: { label: c => `${c.dataset.label}: ${pct(c.parsed.y)}` } } },
      scales: { x: axis('', { grid: { display: false } }), y: axis('% of patients', { min: 0, max: 100 }) } } });
  const G = H.groups[S.dim] || [];
  upsert('ovGroups', { type: 'bar', data: { labels: G.map(g => g.group), datasets: [
      { label: 'Sepsis caught', data: G.map(g => g.caught), backgroundColor: css('--caught'), borderRadius: 2 },
      { label: 'False alarms', data: G.map(g => g.false_alarms), backgroundColor: css('--falsealarm'), borderRadius: 2 }] },
    options: { layout: { padding: { top: 16 } }, plugins: { legend: { position: 'bottom' }, barLabels: { display: true, decimals: 0, suffix: '%' },
      tooltip: { callbacks: { label: c => { const g = G[c.dataIndex]; return c.datasetIndex === 0
        ? `Caught ${pct(c.parsed.y)} of ${num(g.sepsis)} sepsis patients` : `False alarm for ${pct(c.parsed.y)} of ${num(g.others)} other patients`; } } } },
      scales: { x: axis('', { grid: { display: false } }), y: axis('% of patients', { min: 0, max: 100 }) } } });
  const W = ['12 h or more', '6 to 12 h', 'Under 6 h', 'Missed'];
  upsert('ovWarn', { type: 'bar', data: { labels: W, datasets: [{ label: 'Sepsis patients', data: W.map(w => H.warning[w] || 0),
      backgroundColor: ['#0B5CAD', '#118DFF', '#8CC4FF', css('--missed')], borderRadius: 2 }] },
    options: { indexAxis: 'y', layout: { padding: { right: 36 } }, plugins: { legend: { display: false }, barLabels: { display: true } },
      scales: { x: axis('Sepsis patients', { beginAtZero: true }), y: axis('', { grid: { display: false } }) } } });
  let worst = null;
  Object.entries(H.groups).forEach(([dim, rows]) => rows.forEach(g => {
    if (g.sepsis >= 10 && has(g.caught) && (!worst || g.caught < worst.caught)) worst = { ...g, dim };
  }));
  const ratio = has(sirs.false_alarms) && k.false_alarms > 0 ? sirs.false_alarms / k.false_alarms : null;
  $('#ovStory').innerHTML = `<span class="tag">Hospital ${S.hosp}${S.hosp === 'B' ? ', never seen in training' : ''}</span>
    <p>SepsisGuard caught <b>${pct(k.caught)}</b> of sepsis patients. The SIRS rule caught <b>${pct(sirs.caught)}</b>.</p>
    <p>False alarms went to <b>${pct(k.false_alarms)}</b> of other patients, against <b>${pct(sirs.false_alarms)}</b> with SIRS${ratio && ratio > 1.2 ? `, about <b>${num(ratio, 1)}× fewer</b>` : ''}.</p>
    <p>When it caught sepsis, the median warning came <b>${num(k.median_warning)} hours</b> before onset.</p>
    ${worst ? `<p>Lowest catch rate: <b>${esc(groupPhrase(worst.dim, worst.group))}</b> at <b>${pct(worst.caught)}</b>.</p>` : ''}`;
};

/* ---------- page 2: countdown to sepsis ---------- */
function heatColor(v, max) {
  if (!has(v)) return 'transparent';
  const stops = [[251, 237, 238], [214, 69, 84], [122, 21, 32]];
  const t = Math.max(0, Math.min(1, v / max)) * 2, i = Math.min(1, Math.floor(t)), f = t - i;
  const c = stops[i].map((a, j) => Math.round(a + (stops[i + 1][j] - a) * f));
  return `rgb(${c.join(',')})`;
}
RENDER.countdown = () => {
  const H = S.report.hospitals[S.hosp], C = H.countdown, line = S.report.alert_line;
  const pts = arr => C.hours.map((x, i) => ({ x, y: arr[i] }));
  upsert('cdLine', { type: 'line', data: { datasets: [
      { label: 'Patients the model caught', data: pts(C.caught), borderColor: css('--caught'), backgroundColor: css('--caught'), borderWidth: 2.5, pointRadius: 0, spanGaps: true, tension: .25 },
      { label: 'Patients the model missed', data: pts(C.missed), borderColor: css('--missed'), backgroundColor: css('--missed'), borderWidth: 2.5, pointRadius: 0, spanGaps: true, tension: .25 },
      { label: 'Average for patients without sepsis', data: [{ x: -48, y: C.baseline }, { x: 0, y: C.baseline }], borderColor: '#A19F9D', backgroundColor: '#A19F9D', borderDash: [2, 3], borderWidth: 2, pointRadius: 0 },
      { label: 'Alert line', data: [{ x: -48, y: line }, { x: 0, y: line }], borderColor: '#252423', backgroundColor: '#252423', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 }] },
    options: { interaction: { mode: 'nearest', axis: 'x', intersect: false }, plugins: { legend: { position: 'bottom' },
      tooltip: { callbacks: { title: it => it[0].parsed.x === 0 ? 'Sepsis onset' : `${-it[0].parsed.x} h before sepsis`,
                              label: c => `${c.dataset.label}: ${pct(c.parsed.y, 2)}` } } },
      scales: { x: axis('Hours before sepsis', { type: 'linear', min: -48, max: 0, ticks: { stepSize: 6, callback: v => v === 0 ? 'Onset' : `${-v} h` } }),
                y: axis('Average risk (%)', { beginAtZero: true }) } } });
  const last = arr => [...arr].reverse().find(has);
  const cross = C.hours.find((x, i) => has(C.caught[i]) && C.caught[i] >= line);
  $('#cdStory').innerHTML = `<span class="tag">Hospital ${S.hosp}</span>
    <p>For patients the model caught, average risk climbs to <b>${pct(last(C.caught), 1)}</b> at onset${has(cross) ? ` and stays above the ${pct(line, 1)} alert line from about <b>${-cross} hours</b> before sepsis` : ''}.</p>
    <p>For missed patients it only reaches <b>${pct(last(C.missed), 1)}</b>, close to the <b>${pct(C.baseline, 1)}</b> average of patients who never got sepsis. Their measurements looked close to normal.</p>
    <p>The squares below show the same pattern one patient at a time.</p>`;
  const max = 2 * line, R = H.heat.rows;
  $('#heatN').textContent = R.length;
  $('#heatMax').textContent = `${pct(max, 1)} or more`;
  const head = '<div></div>' + H.heat.hours.map(h => `<div class="hd">${h % 6 === 0 ? (h === 0 ? 'Onset' : `${-h} h`) : ''}</div>`).join('');
  $('#cdHeat').innerHTML = `<div class="heat">${head}${R.map((r, ri) => `<div class="rl" title="${esc(r.id)}"><i style="background:${r.result === 'Missed' ? css('--missed') : css('--caught')}"></i>${esc(r.id)}</div>`
    + r.values.map((v, ci) => `<div class="cell" style="background:${heatColor(v, max)};animation-delay:${ci * 22 + ri * 6}ms"
      title="${esc(r.id)}, ${H.heat.hours[ci] === 0 ? 'onset' : `${-H.heat.hours[ci]} h before sepsis`}: ${has(v) ? pct(v, 2) : 'no data'}"></div>`).join('')).join('')}</div>`;
};
// ===== END OF PART 1 =====
// ===== START OF PART 2 =====
/* ---------- page 3: alert simulator ---------- */
function simRow(b) { return S.report.simulator.find(r => r.budget === b) || S.report.simulator[0]; }
function renderSimulator(animateChart = true) {
  const b = S.budget, row = simRow(b), m = row[S.hosp], base = simRow(15)[S.hosp];
  $('#simOut').textContent = `${b}%`;
  $('#simLine').textContent = `At this budget an alert fires when risk reaches ${pct(row.line, 2)}.`;
  kpis('#simKpis', [
    ['Sepsis caught', m.caught, 1, '%', 'of sepsis patients', 'okay'],
    ['Caught 6 h or more early', m.early6, 1, '%', 'of sepsis patients'],
    ['False alarms', m.false_alarms, 1, '%', 'of patients without sepsis'],
    ['New alerts', m.alerts100, 1, '', 'per 100 patient-days'],
    ['Alert line', row.line, 2, '%', 'risk needed for an alert']]);
  const xs = S.report.simulator.map(r => r.budget);
  const top = 100;
  const cfg = { type: 'line', data: { datasets: [
      { label: 'Sepsis caught', data: S.report.simulator.map(r => ({ x: r.budget, y: r[S.hosp].caught })), borderColor: css('--caught'), backgroundColor: css('--caught'), borderWidth: 2.5, pointRadius: 0, tension: .2 },
      { label: 'False alarms', data: S.report.simulator.map(r => ({ x: r.budget, y: r[S.hosp].false_alarms })), borderColor: css('--falsealarm'), backgroundColor: css('--falsealarm'), borderWidth: 2.5, pointRadius: 0, tension: .2 },
      { label: 'Your budget', data: [{ x: b, y: 0 }, { x: b, y: top }], borderColor: '#252423', backgroundColor: '#252423', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 },
      { label: 'Selected', data: [{ x: b, y: m.caught }, { x: b, y: m.false_alarms }], showLine: false, pointRadius: 6, pointHoverRadius: 7,
        backgroundColor: [css('--caught'), css('--falsealarm')], borderColor: '#fff', borderWidth: 2 }] },
    options: { interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: { legend: { position: 'bottom', labels: { filter: it => it.text !== 'Selected' } },
        tooltip: { filter: it => it.dataset.label !== 'Your budget' && it.dataset.label !== 'Selected',
          callbacks: { title: it => `Budget ${it[0].parsed.x}%`, label: c => `${c.dataset.label}: ${pct(c.parsed.y)}` } } },
      scales: { x: axis('False-alarm budget (%)', { type: 'linear', min: xs[0], max: xs[xs.length - 1] }), y: axis('% of patients', { min: 0, max: top }) } } };
  if (!animateChart && charts.simChart) cfg.options.animation = { duration: 250 };
  upsert('simChart', cfg);
  const dc = m.caught - base.caught, da = m.alerts100 - base.alerts100;
  const sign = v => (v > 0 ? '+' : '') + num(v, 1);
  $('#simStory').innerHTML = `<span class="tag">Hospital ${S.hosp}, ${b}% budget</span>
    <p>The model would catch <b>${pct(m.caught)}</b> of sepsis patients, <b>${pct(m.early6)}</b> of them at least 6 hours early.</p>
    <p>The cost: <b>${pct(m.false_alarms)}</b> of other patients get a false alarm, about <b>${num(m.alerts100, 1)} new alerts</b> per 100 patient-days.</p>
    ${b === 15 ? '<p>15% is the setting used everywhere else in this report.</p>'
               : `<p>Against the 15% setting: <b>${sign(dc)} points</b> caught and <b>${sign(da)}</b> alerts per 100 patient-days.</p>`}`;
}
RENDER.simulator = () => {
  renderSimulator();
  const rc = S.summary.recalibration || [], ops = S.summary.operating_points || [];
  $('#recalTable').innerHTML = rc.map(r => `<tr><td>${esc(r['alert line'])}</td><td>${pct(r['sepsis_caught_%'])}</td>
    <td>${pct(r['false_alarm_patients_%'])}</td><td>${num(r['new_alerts_per_100_patient_days'], 1)}</td></tr>`).join('');
  $('#opsTable').innerHTML = ops.map(r => `<tr${r.false_alarm_budget === '15%' ? ' class="me"' : ''}><td>${esc(r.false_alarm_budget)}</td>
    <td>${esc(r.hospital)}</td><td>${pct(r['sepsis_caught_%'])}</td><td>${pct(r['false_alarm_patients_%'])}</td><td>${num(r['new_alerts_per_100_patient_days'], 1)}</td></tr>`).join('');
};
$('#simBudget').addEventListener('input', e => { S.budget = +e.target.value; renderSimulator(false); });

/* ---------- page 4: patient replay ---------- */
const VITALS = [['HR', 'Heart rate', ' bpm', 0], ['O2Sat', 'Oxygen saturation', '%', 0], ['MAP', 'Mean blood pressure', ' mmHg', 0],
                ['Resp', 'Breathing rate', ' /min', 0], ['Temp', 'Temperature', ' °C', 1]];
const bedNo = id => 'Patient ' + String(id).replace('demo-', '');
const who = p => `${has(p.age) ? Math.round(p.age) : '?'}, ${String(p.sex).toLowerCase()}, ${String(p.icu_type).replace(' ICU', '').toLowerCase()} ICU`;
function reasonsHtml(list) {
  const isMissing = r => /: (n\/a|not measured)$/.test(r);
  const measured = (list || []).filter(r => !isMissing(r));
  const missing = (list || []).filter(isMissing).map(r => r.replace(/: (n\/a|not measured)$/, '').replace(/, latest$/, ''));
  return (measured.length ? `<ol class="reasons">${measured.map(r => `<li>${esc(r)}</li>`).join('')}</ol>` : '<p class="muted">No single measured value stands out.</p>')
    + (missing.length ? `<p class="muted">Tests not done yet also nudged the score: ${esc(missing.join(', '))}</p>` : '');
}
function openPatient(id) {
  stopPlay();
  const d = S.details[id]; if (!d) return;
  S.current = d; S.idx = d.timeline.length - 1;
  $('#rpPick').value = id;
  const tl = d.timeline, x0 = tl[0].hour, x1 = Math.max(tl[tl.length - 1].hour, d.sepsis_onset_hour || 0);
  const top = Math.max(d.threshold * 100 * 1.8, ...tl.map(h => h.risk * 100)) * 1.12;
  $('#rpNote').textContent = `Hospital ${d.hospital}, ${who(d)}, ${d.hours} hours in ICU`;
  const sets = [
    { label: 'Sepsis risk', data: tl.map(h => ({ x: h.hour, y: h.risk * 100 })), borderColor: css('--caught'), backgroundColor: 'rgba(17,141,255,.10)', fill: true, borderWidth: 2.5, pointRadius: 0, tension: .2 },
    { label: 'Alert line', data: [{ x: x0, y: d.threshold * 100 }, { x: x1, y: d.threshold * 100 }], borderColor: '#252423', backgroundColor: '#252423', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 }];
  if (d.sepsis_onset_hour) sets.push({ label: 'Sepsis began', data: [{ x: d.sepsis_onset_hour, y: 0 }, { x: d.sepsis_onset_hour, y: top }],
    borderColor: css('--onset'), backgroundColor: css('--onset'), borderWidth: 2, pointRadius: 0 });
  upsert('riskChart', { type: 'line', data: { datasets: sets }, options: { interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: { legend: { position: 'bottom' }, tooltip: { filter: it => it.datasetIndex === 0, callbacks: { title: it => `Hour ${it[0].parsed.x}`, label: c => `Risk ${pct(c.parsed.y, 2)}` } } },
    scales: { x: axis('Hours in ICU', { type: 'linear', min: x0, max: x1 }), y: axis('Risk (%)', { min: 0, max: top }) } } });
  $('#rpVitals').innerHTML = VITALS.map(([k, label]) => `<div class="tile"><div class="tile-head"><h3>${label}</h3></div><div class="chart mini"><canvas id="v-${k}"></canvas></div></div>`).join('');
  VITALS.forEach(([k, label, unit]) => upsert('v-' + k, { type: 'line', data: { datasets: [{ label, data: tl.map(h => ({ x: h.hour, y: h[k] })),
      borderColor: css('--caught'), borderWidth: 1.8, pointRadius: 0, spanGaps: true, tension: .2 }] },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { title: it => `Hour ${it[0].parsed.x}`, label: c => `${num(c.parsed.y, 1)}${unit}` } } },
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      scales: { x: axis('', { type: 'linear', min: x0, max: x1, ticks: { maxTicksLimit: 5 } }), y: axis('', { ticks: { maxTicksLimit: 4 } }) } } }));
  const lead = d.sepsis_onset_hour && d.first_alert_hour ? d.sepsis_onset_hour - d.first_alert_hour : null;
  $('#rpStory').innerHTML = `<span class="tag">${esc(d.kind)}</span><p>${d.sepsis_onset_hour
    ? (d.first_alert_hour ? `Sepsis began at ICU hour <b>${d.sepsis_onset_hour}</b>. The first alert came at hour <b>${d.first_alert_hour}</b>, <b>${lead} hours</b> earlier.`
                          : `Sepsis began at ICU hour <b>${d.sepsis_onset_hour}</b>, but the risk never crossed the alert line. A missed case.`)
    : (d.first_alert_hour ? `This patient never developed sepsis, but the risk crossed the alert line at hour <b>${d.first_alert_hour}</b>. A false alarm.`
                          : 'This patient never developed sepsis and never triggered an alert.')}</p>`;
  $('#scrub').max = tl.length - 1;
  drawHour(true);
}
function drawHour(animate = false) {
  const d = S.current; if (!d) return;
  const tl = d.timeline, upto = tl.slice(0, S.idx + 1), h = upto[upto.length - 1];
  const mode = animate ? undefined : 'none';
  if (charts.riskChart) { charts.riskChart.data.datasets[0].data = upto.map(t => ({ x: t.hour, y: t.risk * 100 })); charts.riskChart.update(mode); }
  VITALS.forEach(([k]) => { const c = charts['v-' + k]; if (c) { c.data.datasets[0].data = upto.map(t => ({ x: t.hour, y: t[k] })); c.update(mode); } });
  const latest = k => { const t = [...upto].reverse().find(x => has(x[k])); return t ? t[k] : null; };
  const alert = h.risk >= d.threshold;
  kpis('#rpKpis', [['Sepsis risk now', h.risk * 100, 2, '%', alert ? 'Sepsis alert' : `Alert at ${pct(d.threshold * 100, 2)}`, alert ? 'alert' : 'okay'],
    ...VITALS.map(([k, label, unit, dec]) => [label, latest(k), dec, unit, 'latest value'])], animate);
  $('#hourLabel').textContent = `Hour ${h.hour} of ${tl[tl.length - 1].hour}`;
  $('#scrub').value = S.idx;
  $('#why').innerHTML = reasonsHtml(h.reasons);
}
function startPlay() {
  const d = S.current; if (!d) return;
  if (S.idx >= d.timeline.length - 1) S.idx = 0;
  $('#play').textContent = 'Pause';
  S.timer = setInterval(() => { if (S.idx >= d.timeline.length - 1) return stopPlay(); S.idx++; drawHour(); }, 300);
}
function stopPlay() { if (S.timer) { clearInterval(S.timer); S.timer = null; } const b = $('#play'); if (b) b.textContent = 'Play'; }
$('#play').addEventListener('click', () => S.timer ? stopPlay() : startPlay());
$('#scrub').addEventListener('input', e => { stopPlay(); S.idx = +e.target.value; drawHour(); });
$('#rpPick').addEventListener('change', e => openPatient(e.target.value));
RENDER.replay = () => {
  const first = S.current ? S.current.id : (S.patients.find(p => p.kind === 'Caught early') || S.patients[0] || {}).id;
  if (first) openPatient(first);
};

/* ---------- page 5: try a new patient ---------- */
const LIVE = [['icu', 'Hours in ICU so far', 6, 72, 1, 24, ' h'], ['worse', 'Getting worse for the last', 1, 12, 1, 6, ' h'],
  ['HR', 'Heart rate now', 50, 170, 1, 118, ' bpm'], ['O2Sat', 'Oxygen saturation now', 80, 100, 1, 92, '%'],
  ['MAP', 'Mean blood pressure now', 40, 110, 1, 63, ' mmHg'], ['SBP', 'Systolic blood pressure now', 60, 180, 1, 96, ' mmHg'],
  ['Resp', 'Breathing rate now', 8, 45, 1, 27, ' /min'], ['Temp', 'Temperature now', 35, 41, 0.1, 38.6, ' °C']];
const BASELINE = { HR: 80, Resp: 16, Temp: 37.0, MAP: 85, SBP: 125, O2Sat: 97 };
$('#liveSliders').innerHTML = LIVE.map(([k, label, min, max, step, val, unit]) => `<div class="slider"><div class="row">
  <label for="s-${k}">${label}</label><output id="o-${k}" for="s-${k}">${val}${unit}</output></div>
  <input type="range" id="s-${k}" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val}"></div>`).join('');
function livePayload() {
  const v = k => parseFloat($('#s-' + k).value);
  const icu = v('icu'), worse = Math.min(v('worse'), icu - 1), start = icu - worse, hours = [];
  for (let h = 1; h <= icu; h++) {
    const t = h <= start ? 0 : (h - start) / worse, values = {};
    Object.keys(BASELINE).forEach(k => { values[k] = Math.round((BASELINE[k] + t * (v(k) - BASELINE[k])) * 10) / 10; });
    if (h === icu && $('#l-labs').checked) Object.assign(values, { WBC: 14.5, Lactate: 2.6, Creatinine: 1.6, Platelets: 140 });
    hours.push({ hour: h, values });
  }
  return { age: Math.min(100, Math.max(18, +$('#l-age').value || 67)), sex: $('#l-sex').value, icu_type: $('#l-icu').value,
           hospital: $('#l-hosp').value, hours_in_hospital_before_icu: 12, hours };
}
function liveQuery() {
  const v = k => $('#s-' + k).value;
  return new URLSearchParams({ age: Math.min(100, Math.max(18, +$('#l-age').value || 67)), sex: $('#l-sex').value,
    icu_type: $('#l-icu').value, hospital: $('#l-hosp').value, hours_in_hospital_before_icu: 12,
    icu_hours: v('icu'), worse_hours: v('worse'), HR: v('HR'), O2Sat: v('O2Sat'), MAP: v('MAP'), SBP: v('SBP'),
    Resp: v('Resp'), Temp: v('Temp'), labs: $('#l-labs').checked }).toString();
}
const rescoreLive = debounce(async () => {
  try {
    const r = await api('/api/score/quick?' + liveQuery());
    const last = r.latest, risk = last.risk * 100, thr = r.threshold * 100, max = Math.max(thr * 3, risk * 1.15);
    const col = last.alert ? css('--missed') : css('--caught');
    upsert('gauge', { type: 'doughnut', data: { labels: ['Risk', ''], datasets: [{ data: [risk, Math.max(0, max - risk)],
        backgroundColor: [col, '#EDEBE9'], borderWidth: 0 }] },
      options: { rotation: -90, circumference: 180, cutout: '72%', events: [], layout: { padding: { bottom: 22, left: 8, right: 8 } },
        plugins: { legend: { display: false }, tooltip: { enabled: false },
          center: { text: pct(risk, 2), sub: last.alert ? 'Sepsis alert' : `Alert at ${pct(thr, 2)}`, color: col, target: thr, max, maxLabel: pct(max, 1) } } } });
    $('#l-first').textContent = r.first_alert_hour ? `First alert at hour ${r.first_alert_hour} of ${last.hour}` : 'No hour of this stay crossed the alert line';
    $('#l-reasons').innerHTML = reasonsHtml(last.reasons);
    const xs = r.timeline.map(t => t.hour);
    upsert('liveChart', { type: 'bar', data: { labels: xs, datasets: [{ label: 'Risk', data: r.timeline.map(t => t.risk * 100),
        backgroundColor: r.timeline.map(t => t.alert ? css('--missed') : css('--caught')), borderRadius: 2 },
        { type: 'line', label: 'Alert line', data: xs.map(() => thr), borderColor: '#252423', borderDash: [6, 4], borderWidth: 1.5, pointRadius: 0 }] },
      options: { plugins: { legend: { display: false }, tooltip: { callbacks: { title: it => `Hour ${it[0].label}`, label: c => `${c.dataset.label}: ${pct(c.parsed.y, 2)}` } } },
        scales: { x: axis('Hours in ICU', { grid: { display: false } }), y: axis('Risk (%)', { beginAtZero: true }) } } });
  } catch (err) {
    $('#l-reasons').innerHTML = `<p class="muted">The model could not score this patient: ${esc(err.message)}</p>`;
  }
}, 350);
document.addEventListener('input', e => {
  if (!e.target.closest('#page-live')) return;
  const def = LIVE.find(x => x[0] === e.target.dataset.k);
  if (def) $('#o-' + def[0]).textContent = `${e.target.value}${def[6]}`;
  rescoreLive();
});
document.addEventListener('change', e => { if (e.target.closest('#page-live')) rescoreLive(); });
RENDER.live = () => rescoreLive();

/* ---------- page 6: model insights ---------- */
RENDER.insights = () => {
  const sig = (S.summary.top_signals || []).slice(0, 12);
  const col = s => s.direction.startsWith('higher') ? css('--higher') : s.direction.startsWith('lower') ? css('--lower') : '#A19F9D';
  upsert('sigChart', { type: 'bar', data: { labels: sig.map(s => s.signal), datasets: [{ label: 'Share of influence', data: sig.map(s => s['importance_%']),
      backgroundColor: sig.map(col), borderRadius: 2 }] },
    options: { indexAxis: 'y', layout: { padding: { right: 40 } }, plugins: { legend: { display: false }, barLabels: { display: true, decimals: 1, suffix: '%' },
      tooltip: { callbacks: { label: c => `${pct(c.parsed.x)} of influence, ${sig[c.dataIndex].direction}` } } },
      scales: { x: axis('Share of influence (%)', { beginAtZero: true }), y: axis('', { grid: { display: false } }) } } });
  const NAMES = { 'Clinical score: SIRS (no ML)': 'SIRS rule (no ML)' };
  $('#resTable').innerHTML = (S.summary.test_results || []).map(r => `<tr${r.model === S.summary.model.name ? ' class="me"' : ''}>
    <td>${esc(NAMES[r.model] || r.model)}</td><td style="white-space:nowrap">${esc(r.test_set.split(' (')[0])}</td><td>${num(r.hour_auroc, 3)}</td>
    <td>${pct(r['sepsis_caught_%'])}</td><td>${pct(r['false_alarm_patients_%'])}</td><td>${pct(r['caught_6h+_early_%'])}</td></tr>`).join('');
};

/* ---------- start ---------- */
function showError(msg) {
  $('#loading').style.display = 'flex';
  $('#loadingText').textContent = msg;
  $$('#loading i').forEach(i => { i.style.display = 'none'; });
}
async function init() {
  const slow = setTimeout(() => { $('#loadingText').textContent = 'Loading the report. The free server may be waking up, which can take up to a minute.'; }, 3000);
  try {
    chartSetup();
    const [sm, pl, rep] = await Promise.all([api('/api/summary'), api('/api/patients'), api('report.json')]);
    S.summary = sm; S.patients = pl.items; S.report = rep;
    const det = await Promise.all(S.patients.map(p => api('/api/patients/' + encodeURIComponent(p.id))));
    det.forEach(d => { S.details[d.id] = d; });
    if (sm.disclaimer) $('#disclaimer').textContent = sm.disclaimer;
    $('#onlineDot').classList.add('ok');
    $('#onlineText').textContent = `Model online, ${sm.model.n_features} signals per hour`;
    $('#gen').textContent = `Report data from ${rep.generated}.`;
    $('#rpPick').innerHTML = S.patients.map(p => `<option value="${esc(p.id)}">${bedNo(p.id)}: ${esc(p.kind)}</option>`).join('');
    $('#loading').style.display = 'none';
    show(location.hash.slice(1) || 'overview');
  } catch (err) {
    console.error(err);
    showError(String(err.message).includes('report.json')
      ? 'The report data file is missing. Run Cell 2 in the notebook, then refresh this page.'
      : 'The page could not reach the model server. Refresh in a minute. Details: ' + err.message);
  } finally { clearTimeout(slow); }
}
window.addEventListener('hashchange', () => { const n = location.hash.slice(1); if (n && n !== S.page) show(n); });
init();
