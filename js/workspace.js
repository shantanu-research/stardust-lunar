/* Workspace: per-project screens — Start (mode detail), Overview (Registration · Comparison · Distribution · Validation),
   Data, Processing, Results and Export. */
import { $, $$, esc, icon, ago, toast, fmt, fmtInt, pct, clamp, decodeImage, grayToCanvas, canvasToBlob, download, loadImageEl, makeThumb, reducedMotion, countUp } from './lib.js';
import { Store } from './store.js';
import { modeById, SENSORS, sensorById } from './modes.js';
import { paintMoons } from './moons.js';
import { Runner, Jobs, analyse, buildCfg, pixels, dropPixels, makeSample, groundTruthTest } from './runner.js';
import { runWithAurora } from './aurora.js';

const E = () => window.StardustEngine;
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const TABS = [['registration', 'Image Registration'], ['comparison', 'Comparison'], ['distribution', 'Distribution'], ['validation', 'Validation']];
const STATUS = { draft: ['Draft', 'warn'], processing: ['Processing', 'on'], completed: ['Completed', 'ok'], failed: ['Needs attention', 'bad'] };
const MODEL_NAME = { similarity: 'Similarity', affine: 'Affine' };

// Every run plays under the aurora: the interface recedes, the engine works, then the result opens.
const running = new Map();
export function kickoff(project, opts = {}) {
  if (running.has(project.id)) return running.get(project.id);
  const mode = modeById(project.mode), bench = opts.benchmark ?? mode.benchmark;
  const p = runWithAurora(async () => { await analyse(project, { benchmark: bench }); return project.status === 'completed'; }, {
    eyebrow: `${mode.name} · ${bench ? 'Method benchmark' : mode.title}`,
    onSettled: (ok, { cancelled }) => { if (cancelled) return; location.hash = `#/p/${project.id}/${bench && opts.stay ? 'processing' : 'overview/' + (ok ? (opts.tab || mode.tab) : 'registration')}`; }
  }).catch((e) => toast('Analysis failed: ' + e.message.split('\n')[0], 'error')).finally(() => running.delete(project.id));
  running.set(project.id, p); return p;
}

export async function renderWorkspace(root, project, viewName, tab) {
  const disposers = [], on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); disposers.push(() => t.removeEventListener(ev, fn, o)); };
  const mode = modeById(project.mode);
  const save = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => Store.put(project), 400); }; })();
  const hasImgs = () => project.src && project.ref;
  const res = () => project.result;
  if (viewName === 'overview' && !tab) tab = mode.tab;
  if (viewName === 'start' && false) return;

  // ─────────── shared UI ───────────
  const sidebar = (active) => {
    const [stLabel, stCls] = STATUS[project.status] || STATUS.draft;
    const item = (id, label, ic, badge) => `<a href="#/p/${project.id}/${id}" class="${active === id ? 'active' : ''}" ${active === id ? 'aria-current="page"' : ''}>${icon(ic)}${label}${badge ? `<span class="badge">${badge}</span>` : ''}</a>`;
    return `<aside class="ws-side"><div class="ws-proj"><span class="moon md" data-moon="${mode.id}"></span><div><h2 title="${esc(project.name)}">${esc(project.name)}</h2><small>${mode.name} Mode</small><small>Last saved ${ago(project.updated)}</small></div></div>
      <nav class="ws-nav" aria-label="Project">${item('overview', 'Overview', 'grid')}${item('data', 'Data', 'image', hasImgs() ? '2' : '')}${item('processing', 'Processing', 'cpu', running.has(project.id) ? '●' : '')}${item('results', 'Results', 'chart')}${item('export', 'Export', 'download')}<div class="sep"></div><a href="#/p/${project.id}/start">${icon('target')}Mode brief</a></nav>
      <div class="ws-bottom"><a class="rail-like" href="#/projects" style="display:flex;gap:12px;align-items:center;height:38px;padding:0 14px;color:var(--muted);font-size:12.5px;border-radius:11px">${icon('back')}All projects</a><a href="#/settings" style="display:flex;gap:12px;align-items:center;height:38px;padding:0 14px;color:var(--muted);font-size:12.5px;border-radius:11px">${icon('settings')}Settings</a></div></aside>`;
  };
  const shell = (active, body) => { root.innerHTML = `<div class="ws">${sidebar(active)}<div class="ws-main">${body}</div></div>`; paintMoons(root); };
  const titleRow = (eyebrow, title, actions = '') => `<div class="ws-title"><div><p class="eyebrow">${eyebrow}</p><h1>${esc(title)}</h1></div><div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">${actions}</div></div>`;
  const statusPill = () => { const [l, c] = STATUS[project.status] || STATUS.draft; return `<span class="pill ${c === 'on' ? '' : c}"><i class="dot ${c === 'on' ? 'on' : c}"></i>${l}</span>`; };
  const needImages = () => `<div class="card"><div class="empty"><span class="moon lg" data-moon="${mode.id}"></span><b style="color:var(--ink)">Load two observations to begin</b><span>A moving source and a fixed reference.</span><a class="btn solid" href="#/p/${project.id}/start">${icon('image')}Load images</a></div></div>`;
  const runBtn = (label = 'Run Registration', cls = 'solid') => `<button class="btn ${cls}" data-run>${icon('play')}${label}</button>`;
  const wireRun = () => $$('[data-run]', root).forEach(b => { if (b.dataset.w) return; b.dataset.w = '1'; on(b, 'click', () => { if (!hasImgs()) { location.hash = `#/p/${project.id}/start`; return; } kickoff(project); }); });

  // image loading helpers
  const urlOf = (role) => { project[role]._url ||= URL.createObjectURL(project[role].blob); return project[role]._url; };
  disposers.push(() => { for (const r of ['src', 'ref']) if (project[r]?._url) { URL.revokeObjectURL(project[r]._url); project[r]._url = null; } });
  const imgEl = (role) => loadImageEl(urlOf(role));
  async function setImage(role, file) {
    try {
      const d = await decodeImage(file);
      if (d.w < 64 || d.h < 64) throw new Error('Image is too small (min 64×64).');
      const idx = role === 'src' ? 0 : 1, sensor = project.sensors?.[Math.min(idx, project.sensors.length - 1)] || 'Other';
      project[role] = { name: file.name || role, blob: file, w: d.w, h: d.h, sensor, gsd: sensorById(sensor).gsd, version: (project[role]?.version || 0) + 1 };
      project.truth = null; project.result = null; project.regBlob = null; project.thumb = null; project.status = 'draft'; project.benchmark = null; dropPixels(project);
      await Store.put(project);
      if (d.scaledFrom) toast(`Large image (${d.scaledFrom.join('×')}) downscaled to ${d.w}×${d.h} for in-browser work.`);
      return true;
    } catch (e) { toast('Could not read that image: ' + e.message, 'error'); return false; }
  }
  async function useSample(kind) {
    const s = await makeSample(kind);
    for (const r of ['src', 'ref']) { if (project[r]?._url) URL.revokeObjectURL(project[r]._url); project[r] = Object.assign({}, s[r], { version: (project[r]?.version || 0) + 1 }); }
    project.truth = s.truth; project.result = null; project.regBlob = null; project.thumb = null; project.status = 'draft'; dropPixels(project); await Store.put(project);
  }
  const priorText = () => { const s = project.src?.gsd, r = project.ref?.gsd; if (!(s > 0 && r > 0)) return 'Set both resolutions to give the matcher a scale prior.'; const k = s / r; return `One source pixel ≈ ${k.toFixed(k < 0.1 ? 3 : 2)} reference pixels (${s} m/px vs ${r} m/px).`; };

  // ═════════════════════ START (mode detail) ═════════════════════
  async function viewStart() {
    let sel = 'src';
    root.innerHTML = `<div class="start" id="start">
      <div><div class="stage-img" id="stagePane"></div></div>
      <div>
        <div class="start-head"><span class="moon md" data-moon="${mode.id}"></span><div><h2>${mode.name}</h2><small>${esc(mode.title)}</small></div></div>
        <h1>${esc(mode.headline)}</h1><p class="lede">${esc(mode.text)}</p>
        <div id="ioRows"></div>
        <div class="start-actions"><button class="btn solid lg" id="go">Start Analysis ${icon('arrow')}</button><button class="btn lg" id="sampleBtn">${icon('image')}Use sample pair</button></div>
        <p class="note" style="margin-top:14px"><b>Sample:</b> ${esc(mode.sample.label)} — real LRO WAC terrain with a known transform, so the result can be checked.</p>
        <p class="note"><a href="#/p/${project.id}/overview" style="text-decoration:underline">${project.result ? 'Go to the existing result' : 'Skip to workspace'}</a> · <a href="#/projects" style="text-decoration:underline">All projects</a></p>
        <input type="file" id="file" accept="image/*" hidden>
      </div></div>`;
    paintMoons(root);
    const fileIn = $('#file', root), pane = $('#stagePane', root), rows = $('#ioRows', root), go = $('#go', root);
    const paint = async () => {
      const it = project[sel];
      pane.innerHTML = it ? `<img src="${urlOf(sel)}" alt="${sel === 'src' ? 'Source' : 'Reference'} preview"><div class="cross"></div><span class="ring"></span><span class="tag" style="position:absolute;left:16px;bottom:14px;font-size:10px;letter-spacing:.24em;text-transform:uppercase;color:#fff">${sel === 'src' ? 'Source' : 'Reference'} · ${it.w}×${it.h}</span>` : `<div class="drop" id="drop">${icon('upload', '')}<b style="color:var(--ink-2);font-weight:500">Drop the ${sel === 'src' ? 'source' : 'reference'} image</b><span style="font-size:12px">PNG, JPEG, WebP or BMP · stays on this device</span><button class="btn sm" data-pick>Choose file</button></div>`;
      $$('[data-pick]', pane).forEach(b => on(b, 'click', () => fileIn.click()));
      const d = $('#drop', pane);
      if (d) { ['dragenter', 'dragover'].forEach(ev => on(d, ev, e => { e.preventDefault(); d.classList.add('over'); })); on(d, 'dragleave', () => d.classList.remove('over')); on(d, 'drop', async e => { e.preventDefault(); d.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f && await setImage(sel, f)) rebuild(); }); }
    };
    const row = (role, label, ic) => { const it = project[role]; return `<div class="io ${sel === role ? 'sel' : ''}" data-role="${role}" role="button" tabindex="0" aria-expanded="${sel === role}"><span class="ic">${icon(ic)}</span><div><b>${label}</b><small>${it ? `${esc(it.name)} · ${it.w}×${it.h}${it.sensor ? ' · ' + esc(it.sensor) : ''}` : 'Not loaded — click to add'}</small></div><span class="ok-ic">${it ? icon('check') : ''}</span>
      <div class="io-edit"><div class="field"><label>File</label><button class="btn sm" data-pick="${role}">${it ? 'Replace' : 'Choose file'}</button></div><div class="field"><label for="s-${role}">Instrument</label><select class="input" id="s-${role}" data-sensor="${role}" ${it ? '' : 'disabled'}>${SENSORS.map(s => `<option value="${s.id}" ${it?.sensor === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div><div class="field"><label for="g-${role}">m / px</label><input class="input mono" id="g-${role}" data-gsd="${role}" type="number" min="0" step="any" value="${it?.gsd ?? ''}" ${it ? '' : 'disabled'}></div></div></div>`; };
    const rebuild = async () => {
      rows.innerHTML = row('src', 'Source Image', 'image') + row('ref', 'Reference Image', 'layers') + `<div class="io" style="cursor:default"><span class="ic">${icon('file')}</span><div><b>Output</b><small>Registered image + match points + statistics</small></div><span></span></div>`;
      go.disabled = !hasImgs(); go.innerHTML = `${project.result ? 'Re-run Analysis' : 'Start Analysis'} ${icon('arrow')}`;
      $$('.io[data-role]', rows).forEach(r => { on(r, 'click', (e) => { if (e.target.closest('select,input,button')) return; sel = r.dataset.role; rebuild(); }); on(r, 'keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.target.closest('select,input,button')) { e.preventDefault(); sel = r.dataset.role; rebuild(); } }); });
      $$('[data-pick]', rows).forEach(b => on(b, 'click', () => { sel = b.dataset.pick; fileIn.click(); }));
      $$('[data-sensor]', rows).forEach(s => on(s, 'change', () => { const it = project[s.dataset.sensor]; it.sensor = s.value; const g = sensorById(s.value).gsd; if (g) it.gsd = g; save(); rebuild(); }));
      $$('[data-gsd]', rows).forEach(g => on(g, 'input', () => { project[g.dataset.gsd].gsd = parseFloat(g.value) || 0; save(); }));
      await paint();
    };
    on(fileIn, 'change', async () => { const f = fileIn.files[0]; fileIn.value = ''; if (f && await setImage(sel, f)) { if (sel === 'src' && !project.ref) sel = 'ref'; rebuild(); } });
    on($('#sampleBtn', root), 'click', async (e) => { const b = e.currentTarget; b.disabled = true; b.innerHTML = '<span class="spinner"></span> Preparing'; await useSample(mode.sample.kind); b.disabled = false; b.innerHTML = `${icon('image')}Use sample pair`; sel = 'src'; toast('Sample pair loaded', 'ok'); rebuild(); });
    on(go, 'click', () => kickoff(project));
    await rebuild();
  }

  // ═════════════════════ OVERVIEW ═════════════════════
  async function viewOverview() {
    const tabsHtml = `<div class="tabs" role="tablist">${TABS.map(([id, l]) => `<button role="tab" aria-selected="${tab === id}" data-tab="${id}">${l}</button>`).join('')}</div>`;
    const head = titleRow(`${mode.name} · ${esc(mode.title)}`, project.name, `${statusPill()}${hasImgs() ? runBtn(project.result ? 'Run again' : 'Run Registration', project.result ? '' : 'solid') : ''}`);
    shell('overview', head + tabsHtml + '<div id="tabBody"></div>');
    $$('[data-tab]', root).forEach(b => on(b, 'click', () => { location.hash = `#/p/${project.id}/overview/${b.dataset.tab}`; }));
    wireRun();
    const body = $('#tabBody', root);
    if (!hasImgs()) { body.innerHTML = needImages(); paintMoons(body); return; }
    if (!res()) {
      body.innerHTML = `<div class="card"><div class="empty"><span class="moon lg" data-moon="${mode.id}"></span><b style="color:var(--ink)">${project.status === 'failed' ? 'No verified registration' : 'Ready to register'}</b><span style="max-width:520px">${esc(project.status === 'failed' ? project.error : 'Both images are loaded. Run the analysis to compute correspondences, the registered image and statistics.')}</span><div style="display:flex;gap:12px;flex-wrap:wrap;justify-content:center">${runBtn()}<a class="btn" href="#/p/${project.id}/processing">${icon('sliders')}Change parameters</a></div></div></div>`;
      paintMoons(body); wireRun(); return;
    }
    if (tab === 'comparison') await tabComparison(body);
    else if (tab === 'distribution') tabDistribution(body);
    else if (tab === 'validation') tabValidation(body);
    else await tabRegistration(body);
  }

  const modelName = () => MODEL_NAME[res().cfg?.model] || 'Similarity';
  const accuracySrc = () => res().metrics.rmseSrcPx;
  const resultsCard = () => { const m = res().metrics; return `<div class="card"><div class="card-head"><h3>Registration Results</h3>${m.subpixel ? '<span class="pill ok">sub-pixel</span>' : '<span class="pill warn">&gt; 1 px</span>'}</div><div class="card-body" style="padding-top:8px">
    <div class="metric"><span>Matched points</span><b>${fmtInt(m.inliers)}</b></div>
    <div class="metric"><span>Accuracy (RMSE)</span><b>${fmt(accuracySrc(), 2)}<small>src px</small></b></div>
    <div class="metric"><span>Inlier ratio</span><b>${pct(m.inlierRatio)}</b></div>
    <div class="metric"><span>Transformation</span><b style="font-size:16px">${modelName()}</b></div>
    <button class="btn" style="width:100%;margin-top:14px" data-goto="comparison">View Overlay</button></div></div>
    <div class="card"><div class="card-head"><h3>Quick Actions</h3></div><div class="card-body" style="padding:6px 22px">
    <button class="action" data-run>${icon('play')}Run Registration</button><a class="action" href="#/p/${project.id}/processing">${icon('sliders')}Change Parameters</a><a class="action" href="#/p/${project.id}/export">${icon('download')}Export Results</a></div></div>`; };
  const wireGoto = () => { $$('[data-goto]', root).forEach(b => on(b, 'click', () => { location.hash = `#/p/${project.id}/overview/${b.dataset.goto}`; })); wireRun(); };

  // ───────── tab: registration ─────────
  async function tabRegistration(body) {
    body.innerHTML = `<div class="reg-grid">
      <div><div class="pane" id="pSrc"><canvas class="img"></canvas><canvas class="ov"></canvas><span class="tag">Source</span><span class="size">${project.src.w}×${project.src.h}</span><div class="inset"><canvas></canvas></div></div></div>
      <div><div class="pane" id="pRef"><canvas class="img"></canvas><canvas class="ov"></canvas><span class="tag r">Reference</span><span class="size">${project.ref.w}×${project.ref.h}</span><div class="inset"><canvas></canvas></div></div></div>
      <div class="side-stack">${resultsCard()}</div></div>
      <div class="toggle-row"><label class="switch"><input type="checkbox" id="tIn" checked>Inlier matches</label><label class="switch"><input type="checkbox" id="tSel" checked>Grid-balanced only</label><label class="switch"><input type="checkbox" id="tOut">Rejected candidates</label></div>
      <div class="legend"><span><i style="background:var(--ink)"></i>Residual under 0.5 px</span><span><i style="background:var(--warn)"></i>Residual over 1 px</span><span><i style="background:var(--faint)"></i>Rejected</span><span>Hover either image — the crosshair follows the transform into the other.</span></div>
      ${mode.id === 'europa' && res().preview ? illumination() : ''}`;
    wireGoto(); paintIllum();
    const [imS, imR] = await Promise.all([imgEl('src'), imgEl('ref')]);
    const H = res().H, inv = E().invert(H), M = res().matches, n = M.length / 7;
    const panes = { src: { el: $('#pSrc', root), im: imS, w: project.src.w, h: project.src.h }, ref: { el: $('#pRef', root), im: imR, w: project.ref.w, h: project.ref.h } };
    for (const k in panes) { const p = panes[k]; p.img = $('canvas.img', p.el); p.ov = $('canvas.ov', p.el); p.inset = $('.inset canvas', p.el); }
    let cursor = null, hover = null;
    const layout = (p) => { const r = p.el.getBoundingClientRect(), s = Math.min(r.width / p.w, r.height / p.h); p.view = { s, ox: (r.width - p.w * s) / 2, oy: (r.height - p.h * s) / 2, W: r.width, H: r.height }; };
    const sizeCanvas = (c, W, Hh) => { const d = Math.min(devicePixelRatio || 1, 2); if (c.width !== Math.round(W * d)) { c.width = Math.round(W * d); c.height = Math.round(Hh * d); } return d; };
    const drawImgs = () => { for (const k in panes) { const p = panes[k]; layout(p); const d = sizeCanvas(p.img, p.view.W, p.view.H); sizeCanvas(p.ov, p.view.W, p.view.H); const g = p.img.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, p.view.W, p.view.H); g.imageSmoothingQuality = 'high'; g.drawImage(p.im, p.view.ox, p.view.oy, p.w * p.view.s, p.h * p.view.s); } };
    const toView = (p, x, y) => [p.view.ox + x * p.view.s, p.view.oy + y * p.view.s];
    const drawOverlay = () => {
      const showIn = $('#tIn', root).checked, selOnly = $('#tSel', root).checked, showOut = $('#tOut', root).checked, ink = cssVar('--ink') || '#fff', warn = cssVar('--warn') || '#da9', faint = '#777';
      for (const k of ['src', 'ref']) {
        const p = panes[k], d = sizeCanvas(p.ov, p.view.W, p.view.H), g = p.ov.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); g.clearRect(0, 0, p.view.W, p.view.H);
        const flags = res().selectedFlags;
        for (let i = 0; i < n; i++) {
          const isIn = M[i * 7 + 5] === 1; if (isIn ? !showIn : !showOut) continue; if (isIn && selOnly && !flags[i]) continue;
          const x = M[i * 7 + (k === 'src' ? 0 : 2)], y = M[i * 7 + (k === 'src' ? 1 : 3)], e = M[i * 7 + 4], [vx, vy] = toView(p, x, y);
          g.globalAlpha = isIn ? 0.85 : 0.35; g.fillStyle = g.strokeStyle = !isIn ? faint : e > 1 ? warn : ink;
          g.beginPath(); g.arc(vx, vy, 1.1, 0, 6.283); g.fill(); if (isIn) { g.lineWidth = .6; g.globalAlpha = .35; g.beginPath(); g.arc(vx, vy, 4, 0, 6.283); g.stroke(); }
        }
        g.globalAlpha = 1;
      }
      const cur = cursor || idle;
      if (cur) for (const k of ['src', 'ref']) {
        const p = panes[k], g = p.ov.getContext('2d'), pt = k === 'src' ? cur.s : cur.r; if (!pt) continue; const [vx, vy] = toView(p, pt[0], pt[1]);
        g.strokeStyle = cursor ? 'rgba(255,255,255,.75)' : 'rgba(255,255,255,.4)'; g.lineWidth = 1; g.beginPath(); g.moveTo(vx, 0); g.lineTo(vx, p.view.H); g.moveTo(0, vy); g.lineTo(p.view.W, vy); g.stroke();
        g.beginPath(); g.arc(vx, vy, 13, 0, 6.283); g.stroke();
      }
    };
    const drawInset = () => {
      for (const k of ['src', 'ref']) {
        const p = panes[k], c = p.inset, cur = cursor || idle, pt = cur && (k === 'src' ? cur.s : cur.r); if (!pt) continue;
        const sz = 120, win = Math.min(p.w, p.h) * 0.07 * (k === 'ref' && res().decomposed.scale < 1 ? 1 : 1); c.width = sz; c.height = sz; const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
        g.drawImage(p.im, pt[0] - win / 2, pt[1] - win / 2, win, win, 0, 0, sz, sz); g.strokeStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.moveTo(sz / 2, 0); g.lineTo(sz / 2, sz); g.moveTo(0, sz / 2); g.lineTo(sz, sz / 2); g.stroke();
      }
    };
    const idle = { s: [project.src.w / 2, project.src.h / 2], r: E().apply(H, project.src.w / 2, project.src.h / 2) };
    panes.src.el.classList.add('hot'); panes.ref.el.classList.add('hot');
    const frame = () => { drawOverlay(); drawInset(); };
    const toImg = (p, e) => { const r = p.el.getBoundingClientRect(); return [(e.clientX - r.left - p.view.ox) / p.view.s, (e.clientY - r.top - p.view.oy) / p.view.s]; };
    for (const k of ['src', 'ref']) {
      const p = panes[k];
      on(p.el, 'pointermove', (e) => { const pt = toImg(p, e); if (pt[0] < 0 || pt[1] < 0 || pt[0] > p.w || pt[1] > p.h) return; cursor = k === 'src' ? { s: pt, r: E().apply(H, pt[0], pt[1]) } : { r: pt, s: inv ? E().apply(inv, pt[0], pt[1]) : null }; panes.src.el.classList.add('hot'); panes.ref.el.classList.add('hot'); cancelAnimationFrame(hover); hover = requestAnimationFrame(frame); });
      on(p.el, 'pointerleave', () => { cursor = null; frame(); });
    }
    ['tIn', 'tSel', 'tOut'].forEach(id => on($('#' + id, root), 'change', frame));
    const redraw = () => { drawImgs(); frame(); };
    const ro = new ResizeObserver(redraw); ro.observe(panes.src.el); disposers.push(() => ro.disconnect());
    redraw();
  }
  function illumination() {
    return `<div class="card" style="margin-top:22px"><div class="card-head"><h3>Illumination normalisation</h3><span class="pill">Europa</span></div><div class="card-body"><p class="note" style="margin-bottom:12px">Log compression and local mean/variance normalisation remove shading that depends on Sun elevation and azimuth. Features are computed on the normalised images (right), not on raw brightness (left).</p><div class="illum" id="illum"></div></div></div>`;
  }
  async function paintIllum() {
    const box = $('#illum', root); if (!box || !res().preview) return;
    for (const role of ['src', 'ref']) {
      const pv = res().preview[role], fig = document.createElement('figure'), after = grayToCanvas(pv.data, pv.w, pv.h);
      const im = await imgEl(role), before = document.createElement('canvas'); before.width = pv.w; before.height = pv.h; before.getContext('2d').drawImage(im, 0, 0, pv.w, pv.h);
      const pair = document.createElement('div'); pair.style.cssText = 'display:grid;grid-template-columns:1fr 1fr'; pair.append(before, after);
      fig.append(pair); const cap = document.createElement('figcaption'); cap.textContent = (role === 'src' ? 'Source' : 'Reference') + ' · raw → normalised'; fig.append(cap); box.append(fig);
    }
  }

  // ───────── tab: comparison ─────────
  async function tabComparison(body) {
    if (!project.regBlob) { body.innerHTML = '<div class="card"><div class="empty">No registered image yet.</div></div>'; return; }
    body.innerHTML = `<div class="cmp"><div class="cmp-view" id="cv"><canvas></canvas><div class="divider" id="dv"></div></div>
      <div class="side-stack"><div class="card"><div class="card-head"><h3>Overlay</h3></div><div class="card-body"><div class="seg" id="seg">${[['swipe', 'Swipe'], ['blend', 'Blend'], ['checker', 'Checker'], ['flicker', 'Flicker'], ['diff', 'Difference']].map(([id, l]) => `<button class="chip" data-m="${id}" aria-pressed="${id === 'swipe'}">${l}</button>`).join('')}</div>
      <div class="field" style="margin-top:20px" id="posField"><label for="pos">Position <span class="val" id="posV">50%</span></label><input id="pos" type="range" min="0" max="100" value="50"></div><p class="note" id="cmpNote"></p></div></div>${resultsCard()}</div></div>${mode.id === 'europa' && res().preview ? illumination() : ''}`;
    wireGoto(); paintIllum();
    const ref = await pixels(project, 'ref'), bmp = await createImageBitmap(project.regBlob);
    const wrap = $('#cv', root), cv = $('canvas', wrap), dv = $('#dv', root), pos = $('#pos', root);
    const W = Math.min(1100, ref.w), k = W / ref.w, Hh = Math.round(ref.h * k); cv.width = W; cv.height = Hh;
    const refC = grayToCanvas(ref.gray, ref.w, ref.h), mk = document.createElement('canvas'); mk.width = W; mk.height = Hh;
    const rg = mk.getContext('2d'); rg.drawImage(refC, 0, 0, W, Hh); const refD = rg.getImageData(0, 0, W, Hh);
    const rc = document.createElement('canvas'); rc.width = W; rc.height = Hh; const rcg = rc.getContext('2d'); rcg.drawImage(bmp, 0, 0, W, Hh); const regD = rcg.getImageData(0, 0, W, Hh);
    const g = cv.getContext('2d'); let m = 'swipe', t = 0.5, flick = null, flag = false;
    const NOTES = { swipe: 'Drag across the image. Left of the divider is the registered source; right is the reference. Edges should continue across the line.', blend: 'Cross-fade the registered source over the reference. Misregistration shows as doubled edges.', checker: 'Alternating tiles of source and reference. Craters and ridges should line up across tile borders.', flicker: 'Alternates the two images. Aligned terrain stays still; misregistered terrain jumps.', diff: 'Absolute difference where the images overlap. Residual structure highlights misregistration or illumination change.' };
    const draw = () => {
      g.clearRect(0, 0, W, Hh); dv.style.display = m === 'swipe' ? '' : 'none';
      if (m === 'swipe') { g.drawImage(mk, 0, 0); g.save(); g.beginPath(); g.rect(0, 0, W * t, Hh); g.clip(); g.drawImage(rc, 0, 0); g.restore(); dv.style.left = (t * 100) + '%'; }
      else if (m === 'blend') { g.drawImage(mk, 0, 0); g.globalAlpha = t; g.drawImage(rc, 0, 0); g.globalAlpha = 1; }
      else if (m === 'checker') { g.drawImage(mk, 0, 0); const ts = Math.max(24, Math.round(W / 14)); g.save(); g.beginPath(); for (let y = 0; y * ts < Hh; y++) for (let x = 0; x * ts < W; x++) if ((x + y) & 1) g.rect(x * ts, y * ts, ts, ts); g.clip(); g.drawImage(rc, 0, 0); g.restore(); }
      else if (m === 'flicker') { g.drawImage(mk, 0, 0); if (flag) g.drawImage(rc, 0, 0); }
      else { const out = g.createImageData(W, Hh), o = out.data, a = refD.data, b = regD.data; for (let i = 0; i < o.length; i += 4) { const v = b[i + 3] ? Math.min(255, Math.abs(a[i] - b[i]) * 2.2) : 0; o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255; } g.putImageData(out, 0, 0); }
    };
    const setMode = (id) => { m = id; clearInterval(flick); if (id === 'flicker' && !reducedMotion()) flick = setInterval(() => { flag = !flag; draw(); }, 520); $$('[data-m]', root).forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === id))); $('#posField', root).style.display = id === 'swipe' || id === 'blend' ? '' : 'none'; $('#cmpNote', root).textContent = NOTES[id]; draw(); };
    disposers.push(() => clearInterval(flick));
    $$('[data-m]', root).forEach(b => on(b, 'click', () => setMode(b.dataset.m)));
    on(pos, 'input', () => { t = pos.value / 100; $('#posV', root).textContent = pos.value + '%'; draw(); });
    let drag = false; const setPos = (e) => { const r = wrap.getBoundingClientRect(); t = clamp((e.clientX - r.left) / r.width, 0, 1); pos.value = Math.round(t * 100); $('#posV', root).textContent = pos.value + '%'; draw(); };
    on(wrap, 'pointerdown', (e) => { if (m !== 'swipe' && m !== 'blend') return; drag = true; wrap.setPointerCapture(e.pointerId); setPos(e); }); on(wrap, 'pointermove', (e) => { if (drag) setPos(e); }); on(wrap, 'pointerup', () => { drag = false; });
    setMode('swipe');
  }

  // ───────── tab: distribution ─────────
  function tabDistribution(body) {
    const r = res(), cfg = r.cfg, d0 = r.dist;
    body.innerHTML = `<div class="metric-grid" id="mg"></div><div class="two"><div class="card"><div class="card-head"><h3>Coverage of the overlap</h3><span class="note" id="gl"></span></div><div class="card-body"><div class="heat" id="heat"></div><div class="legend"><span><i style="background:var(--ink)"></i>Dense</span><span><i style="background:var(--surface-3);border:1px solid var(--line-2)"></i>Empty (eligible)</span><span>Dashed cells lie outside the overlap.</span></div></div></div>
      <div class="side-stack"><div class="card"><div class="card-head"><h3>Grid-balanced selection</h3></div><div class="card-body"><div class="field"><label for="gG">Grid <span class="val" id="gGv"></span></label><input type="range" id="gG" min="3" max="12" value="${d0.grid}"></div><div class="field"><label for="gC">Max points per cell <span class="val" id="gCv"></span></label><input type="range" id="gC" min="1" max="8" value="${cfg.cap || 3}"></div><p class="note">The selection keeps the lowest-residual points in every cell so the control-point set is spread across the overlap instead of clustered. Recomputed instantly from the stored matches.</p></div></div>
      <div class="card"><div class="card-head"><h3>Residual histogram</h3><span class="note">reference px</span></div><div class="card-body"><canvas class="chart" id="hist"></canvas></div></div></div></div>
      <div class="card" style="margin-top:18px"><div class="card-head"><h3>Where the matches are</h3><span class="note">reference frame</span></div><div class="card-body"><canvas class="chart" id="scatter" style="height:auto;aspect-ratio:${project.ref.w}/${project.ref.h};max-height:560px;border-radius:12px;background:#000;border:1px solid var(--line)"></canvas></div></div>`;
    const G = $('#gG', root), C = $('#gC', root); let cap = +C.value;
    const draw = () => {
      const d = res().dist, m = res().metrics;
      $('#mg', root).innerHTML = [['Coverage', pct(d.coverage), `${d.occupiedCells} of ${d.eligibleCells} eligible cells`], ['Uniformity', fmt(d.uniformity, 2), 'Normalised entropy (1 = even)'], ['Inliers', fmtInt(m.inliers), `of ${fmtInt(m.candidates)} candidates`], ['Grid-balanced', fmtInt(d.selectedCount), `≤ ${cap} per cell`]].map(([l, v, s]) => `<div class="card big"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('');
      const max = Math.max(1, ...d.counts); $('#gl', root).textContent = `${d.grid}×${d.grid}`;
      const heat = $('#heat', root); heat.style.gridTemplateColumns = `repeat(${d.grid},1fr)`; heat.innerHTML = d.counts.map((c, i) => `<i class="${d.eligible[i] ? '' : 'off'}" style="background:${c ? `color-mix(in srgb,var(--ink) ${Math.round(12 + 78 * c / max)}%,var(--surface-3))` : 'var(--surface-3)'};color:${c / max > .55 ? 'var(--bg)' : 'var(--muted)'}">${c || ''}</i>`).join('');
      $('#gGv', root).textContent = `${d.grid}×${d.grid}`; $('#gCv', root).textContent = cap;
      drawScatter();
    };
    const drawScatter = () => {
      const cv = $('#scatter', root), r = res(), M = r.matches, n = M.length / 7, W = cv.clientWidth || 600, Hh = W * project.ref.h / project.ref.w, dpr = Math.min(devicePixelRatio || 1, 2);
      cv.width = W * dpr; cv.height = Hh * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.fillStyle = '#000'; g.fillRect(0, 0, W, Hh);
      const k = W / project.ref.w, d = r.dist; g.strokeStyle = 'rgba(255,255,255,.1)'; for (let i = 0; i <= d.grid; i++) { g.beginPath(); g.moveTo(i / d.grid * W, 0); g.lineTo(i / d.grid * W, Hh); g.moveTo(0, i / d.grid * Hh); g.lineTo(W, i / d.grid * Hh); g.stroke(); }
      for (let i = 0; i < n; i++) { if (!M[i * 7 + 5]) continue; const sel = r.selectedFlags[i]; g.fillStyle = sel ? '#fff' : 'rgba(255,255,255,.28)'; g.beginPath(); g.arc(M[i * 7 + 2] * k, M[i * 7 + 3] * k, sel ? 3 : 1.6, 0, 6.283); g.fill(); }
    };
    const recompute = () => { const rr = E().redistribute(res().matches, res().H, res().sizes.src, res().sizes.ref, +G.value, cap); res().dist = rr.dist; res().selectedFlags = rr.selectedFlags; res().metrics.coverage = rr.dist.coverage; res().metrics.uniformity = rr.dist.uniformity; res().metrics.selected = rr.dist.selectedCount; res().cfg.grid = +G.value; res().cfg.cap = cap; draw(); save(); };
    on(G, 'input', recompute); on(C, 'input', () => { cap = +C.value; recompute(); });
    drawHist($('#hist', root), residualsRef(), 'px'); draw();
  }
  function residualsRef() { const M = res().matches, out = []; for (let i = 0; i < M.length / 7; i++) if (M[i * 7 + 5]) out.push(M[i * 7 + 4]); return out; }
  function drawHist(cv, vals, unit) {
    const dpr = Math.min(devicePixelRatio || 1, 2), W = cv.clientWidth || 400, Hh = 170; cv.width = W * dpr; cv.height = Hh * dpr; const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!vals.length) return; const sorted = [...vals].sort((a, b) => a - b), top = Math.max(1, sorted[Math.floor(sorted.length * 0.99)] * 1.05), B = 24, bins = new Array(B).fill(0);
    vals.forEach(v => { bins[Math.min(B - 1, Math.floor(v / top * B))]++; }); const max = Math.max(...bins), ink = cssVar('--ink'), line = cssVar('--line-2'), muted = cssVar('--muted'), bw = (W - 20) / B;
    g.strokeStyle = line; g.beginPath(); g.moveTo(10, Hh - 24.5); g.lineTo(W - 10, Hh - 24.5); g.stroke();
    bins.forEach((c, i) => { const h = c / max * (Hh - 50); g.fillStyle = ink; g.globalAlpha = 0.25 + 0.7 * c / max; g.fillRect(10 + i * bw + 1.5, Hh - 24 - h, bw - 3, h); }); g.globalAlpha = 1;
    g.fillStyle = muted; g.font = '10px Manrope, sans-serif'; g.textAlign = 'left'; g.fillText('0', 10, Hh - 8); g.textAlign = 'right'; g.fillText(top.toFixed(2) + ' ' + unit, W - 10, Hh - 8);
    g.textAlign = 'center'; const med = sorted[Math.floor(sorted.length / 2)]; g.fillText(`median ${med.toFixed(2)}`, 10 + Math.min(med / top, 0.95) * (W - 20), 12);
  }

  // ───────── tab: validation ─────────
  function tabValidation(body) {
    const r = res(), m = r.metrics, tr = project.truth;
    const sub = m.holdoutSrcPx != null ? m.holdoutSrcPx < 1 : m.subpixel;
    const truthErr = tr ? E().transformError(r.H, tr.H, project.src.w, project.src.h) : null;
    const kv = (l, v, c = '') => `<div class="kv"><span>${l}</span><b class="${c}">${v}</b></div>`;
    body.innerHTML = `<div class="two"><div class="side-stack">
      <div class="card"><div class="card-head"><h3>Evidence</h3><span class="pill ${sub ? 'ok' : 'warn'}">${sub ? 'Sub-pixel' : 'Over 1 source px'}</span></div><div class="card-body" style="padding-top:8px">
        ${kv('Fit RMSE · source px', fmt(m.rmseSrcPx, 3), m.rmseSrcPx < 1 ? 'ok' : 'warn')}${kv('Fit RMSE · reference px', fmt(m.rmseRefPx, 3))}
        ${kv('Spatial holdout · source px', m.holdoutSrcPx == null ? 'not enough points' : fmt(m.holdoutSrcPx, 3), m.holdoutSrcPx != null && m.holdoutSrcPx < 1 ? 'ok' : '')}
        ${kv('Median / 95th pct · ref px', `${fmt(m.medianRefPx, 2)} / ${fmt(m.p95RefPx, 2)}`)}${kv('Max residual · ref px', fmt(m.maxRefPx, 2))}
        ${kv('Inliers / candidates', `${fmtInt(m.inliers)} / ${fmtInt(m.candidates)}`)}${kv('Inlier ratio', pct(m.inlierRatio, 1))}${kv('Coverage · uniformity', `${pct(m.coverage)} · ${fmt(m.uniformity, 2)}`)}
        ${truthErr ? kv('Error vs known transform · source px', fmt(truthErr.rmseSrc, 3), truthErr.rmseSrc < 1 ? 'ok' : 'warn') : ''}
      </div></div>
      <div class="card"><div class="card-head"><h3>What this does and doesn’t show</h3></div><div class="card-body"><p class="note"><b>Fit RMSE</b> is how well matches agree with the fitted transform. <b>Spatial holdout</b> fits on half the checkerboard cells and tests on the other half, so it is not flattered by the points it was fitted to. Neither is surveyed ground truth.${tr ? ' This is a <b>sample</b> pair, so a known transform exists and its error is shown above.' : ' To measure true accuracy on your own data you need independent control points — or run the synthetic test on the right.'}</p></div></div></div>
      <div class="side-stack"><div class="card"><div class="card-head"><h3>Synthetic ground-truth test</h3></div><div class="card-body"><p class="note" style="margin-bottom:14px">Generates a moving view of <b>your reference image</b> with a random rotation, scale, illumination change and noise — so the true transform is known — then registers it with the current settings.</p><button class="btn solid" id="st">${icon('shield')}Run test</button><div id="stOut" style="margin-top:18px"></div></div></div>
      <div class="card"><div class="card-head"><h3>Residual histogram</h3><span class="note">reference px</span></div><div class="card-body"><canvas class="chart" id="hist"></canvas></div></div></div></div>`;
    drawHist($('#hist', root), residualsRef(), 'px');
    const showST = (t) => {
      const out = $('#stOut', root); if (!t) return;
      if (!t.ok) { out.innerHTML = `<p class="note" style="color:var(--bad)">${esc(t.reason || 'No registration')}</p>`; return; }
      out.innerHTML = `<div class="kv"><span>True error · moving px</span><b class="${t.error.rmseSrc < 1 ? 'ok' : 'warn'}">${fmt(t.error.rmseSrc, 3)}</b></div><div class="kv"><span>True error · reference px</span><b>${fmt(t.error.rmseRef, 3)}</b></div><div class="kv"><span>Fit RMSE · moving px</span><b>${fmt(t.metrics.rmseSrcPx, 3)}</b></div><div class="kv"><span>Inliers</span><b>${fmtInt(t.metrics.inliers)} / ${fmtInt(t.metrics.candidates)}</b></div><div class="kv"><span>Synthetic rotation · scale</span><b>${fmt(t.synthetic.rotationDeg, 1)}° · ×${fmt(t.synthetic.scale, 2)}</b></div><div class="kv"><span>Time</span><b>${fmt(t.timings.total / 1000, 1)} s</b></div>`;
    };
    showST(project.selftest);
    on($('#st', root), 'click', async (e) => {
      const b = e.currentTarget; b.disabled = true; b.innerHTML = '<span class="spinner"></span> <span id="stP">Running…</span>';
      try { const t = await groundTruthTest(project, (p) => { const el = $('#stP', root); if (el) el.textContent = Math.round(p.pct * 100) + '% · ' + p.msg; }); const slim = { ok: t.ok, reason: t.reason, synthetic: t.synthetic, error: t.error, metrics: t.metrics, timings: t.timings }; project.selftest = slim; save(); showST(slim); }
      catch (err) { toast('Test failed: ' + err.message.split('\n')[0], 'error'); }
      b.disabled = false; b.innerHTML = `${icon('shield')}Run test`;
    });
  }

  // ═════════════════════ DATA ═════════════════════════
  async function viewData() {
    shell('data', titleRow('Observations', 'Data', `<button class="btn" id="swap">${icon('swap')}Swap roles</button><button class="btn" id="sampleBtn">${icon('image')}Use sample pair</button>`) + `<div class="two" id="dd"></div><p class="note" style="margin-top:22px" id="prior"></p><input type="file" id="file" accept="image/*" hidden>`);
    const fileIn = $('#file', root); let role = 'src';
    const paint = () => {
      $('#dd', root).innerHTML = ['src', 'ref'].map(r => { const it = project[r], label = r === 'src' ? 'Moving source' : 'Fixed reference'; return `<div class="card"><div class="card-head"><h3>${label}</h3><button class="btn sm" data-pick="${r}">${it ? 'Replace' : 'Choose file'}</button></div><div class="card-body">${it ? `<div class="pane" style="aspect-ratio:4/3;cursor:default"><img src="${urlOf(r)}" alt="${label}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;filter:grayscale(1)"><span class="tag">${esc(it.name)}</span></div><div style="margin-top:16px"><div class="kv"><span>Dimensions</span><b>${it.w} × ${it.h}</b></div><div class="kv"><span>Instrument</span><b><select class="input" style="height:34px;width:150px" data-sensor="${r}">${SENSORS.map(s => `<option ${it.sensor === s.id ? 'selected' : ''} value="${s.id}">${s.label}</option>`).join('')}</select></b></div><div class="kv"><span>Resolution (m/px)</span><b><input class="input mono" style="height:34px;width:150px" type="number" min="0" step="any" value="${it.gsd ?? ''}" data-gsd="${r}"></b></div>${it.sample ? `<p class="note" style="margin-top:10px">${esc(it.note || 'Sample image')}</p>` : ''}</div>` : `<div class="empty">No image yet<button class="btn solid" data-pick="${r}">${icon('upload')}Choose file</button></div>`}</div></div>`; }).join('');
      $('#prior', root).innerHTML = `<b>Scale prior.</b> ${priorText()}`;
      $$('[data-pick]', root).forEach(b => on(b, 'click', () => { role = b.dataset.pick; fileIn.click(); }));
      $$('[data-sensor]', root).forEach(s => on(s, 'change', () => { const it = project[s.dataset.sensor]; it.sensor = s.value; const g = sensorById(s.value).gsd; if (g) it.gsd = g; save(); paint(); }));
      $$('[data-gsd]', root).forEach(g => on(g, 'input', () => { project[g.dataset.gsd].gsd = parseFloat(g.value) || 0; save(); $('#prior', root).innerHTML = `<b>Scale prior.</b> ${priorText()}`; }));
    };
    paint();
    on(fileIn, 'change', async () => { const f = fileIn.files[0]; fileIn.value = ''; if (!f) return; if (res() && !confirm('Replacing an image clears the current result. Continue?')) return; if (await setImage(role, f)) { toast('Image loaded', 'ok'); viewData(); } });
    on($('#swap', root), 'click', async () => { if (!hasImgs()) return; [project.src, project.ref] = [project.ref, project.src]; project.src.version++; project.ref.version++; project.truth = null; project.result = null; project.regBlob = null; project.thumb = null; project.status = 'draft'; dropPixels(project); await Store.put(project); toast('Roles swapped — result cleared'); viewData(); });
    on($('#sampleBtn', root), 'click', async () => { if (res() && !confirm('Loading a sample replaces both images and clears the result. Continue?')) return; await useSample(mode.sample.kind); toast('Sample pair loaded', 'ok'); viewData(); });
  }

  // ═════════════════════ PROCESSING ═════════════════════
  const STAGES = [['normalize', 'Normalise', 'Contrast / illumination'], ['detect', 'Detect & describe', 'Scale-space keypoints, RootSIFT'], ['match', 'Match', 'Ratio-tested nearest neighbours'], ['verify', 'Verify geometry', 'RANSAC + least squares'], ['done', 'Register image', 'Warp, statistics']];
  async function viewProcessing() {
    const cfg = buildCfg(project), p = project.params || (project.params = {});
    const val = (k) => p[k] != null ? p[k] : cfg[k];
    shell('processing', titleRow('Pipeline', 'Processing', `${runBtn('Run Registration')}<button class="btn" id="bench">${icon('chart')}Benchmark all methods</button><button class="btn danger" id="cancel" hidden>Cancel</button>`) + `<div class="proc"><div class="card"><div class="card-head"><h3>Sequence</h3><span class="note" id="elapsed"></span></div><div class="card-body"><div id="stages"></div><div class="bar"><i id="bar"></i></div><p class="note" id="msg">Idle.</p><div class="log" id="log"></div></div></div>
      <div class="card"><div class="card-head"><h3>Parameters</h3><button class="btn sm" id="reset">Reset to ${mode.name} defaults</button></div><div class="card-body"><div class="params">
        <div class="field"><label for="pm">Geometric model</label><select class="input" id="pm"><option value="similarity">Similarity — scale · rotation · shift</option><option value="affine">Affine — adds shear / anisotropy</option></select></div>
        <div class="field"><label for="pp">Preprocessing</label><select class="input" id="pp"><option value="raw">Intensity (stretch)</option><option value="illum">Sun-angle normalised</option><option value="struct">Cross-modal structure</option></select></div>
        <div class="field"><label for="pr">Match ratio <span class="val" id="prv"></span></label><input type="range" id="pr" min="0.6" max="0.95" step="0.01"></div>
        <div class="field"><label for="pt">Inlier threshold <span class="val" id="ptv"></span></label><input type="range" id="pt" min="1" max="8" step="0.5"></div>
        <div class="field"><label for="pk">Keypoints / image <span class="val" id="pkv"></span></label><input type="range" id="pk" min="800" max="5000" step="100"></div>
        <div class="field"><label for="pw">Working resolution <span class="val" id="pwv"></span></label><input type="range" id="pw" min="500" max="1800" step="100"></div>
        <div class="field"><label>Scale search</label><label class="switch"><input type="checkbox" id="ps">Sweep ±2× around the prior</label></div>
        <div class="field"><label for="psp">Scale prior (source → reference)</label><input class="input mono" id="psp" type="number" min="0.01" step="any" placeholder="auto"></div>
        <div class="field"><label for="pg">Distribution grid <span class="val" id="pgv"></span></label><input type="range" id="pg" min="3" max="12"></div>
        <div class="field"><label for="pc">Max points / cell <span class="val" id="pcv"></span></label><input type="range" id="pc" min="1" max="8"></div>
        <p class="note full" style="grid-column:1/-1" id="priorN"></p></div></div></div></div><div id="benchOut" style="margin-top:18px"></div>`);
    wireRun();
    const set = (id, v) => { const el = $('#' + id, root); if (el) { if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; } };
    const fill = () => { const c = buildCfg(project); set('pm', c.model); set('pp', c.pre); set('pr', c.ratio); set('pt', c.thr); set('pk', c.maxKp); set('pw', c.workRes); set('ps', c.sweep); set('psp', project.params.scalePrior ?? ''); set('pg', c.grid); set('pc', c.cap); lab(); $('#psp', root).placeholder = 'auto · ' + c.scalePrior.toFixed(3); $('#priorN', root).textContent = priorText(); };
    const lab = () => { const g = (id) => +$('#' + id, root).value; $('#prv', root).textContent = g('pr').toFixed(2); $('#ptv', root).textContent = g('pt').toFixed(1) + ' px'; $('#pkv', root).textContent = g('pk'); $('#pwv', root).textContent = g('pw') + ' px'; $('#pgv', root).textContent = g('pg') + '×' + g('pg'); $('#pcv', root).textContent = g('pc'); };
    const bind = (id, key, conv = (x) => x) => on($('#' + id, root), 'input', (e) => { const t = e.target; p[key] = conv(t.type === 'checkbox' ? t.checked : t.value); project.params = p; lab(); save(); });
    bind('pm', 'model'); bind('pp', 'pre'); bind('pr', 'ratio', Number); bind('pt', 'thr', Number); bind('pk', 'maxKp', Number); bind('pw', 'workRes', Number); bind('ps', 'sweep'); bind('pg', 'grid', Number); bind('pc', 'cap', Number);
    on($('#psp', root), 'input', (e) => { const v = parseFloat(e.target.value); if (v > 0) p.scalePrior = v; else delete p.scalePrior; project.params = p; save(); });
    on($('#reset', root), 'click', () => { project.params = {}; Object.keys(p).forEach(k => delete p[k]); save(); fill(); toast('Parameters reset'); });
    fill();
    // live job view
    const stagesEl = $('#stages', root), bar = $('#bar', root), msg = $('#msg', root), log = $('#log', root), runB = $('[data-run]', root), benchB = $('#bench', root), cancelB = $('#cancel', root), elapsed = $('#elapsed', root);
    const paintJob = (s) => {
      const mine = s.projectId === project.id, active = mine && s.running, idx = STAGES.findIndex(x => x[0] === s.stage);
      stagesEl.innerHTML = STAGES.map(([id, t, sub], i) => { const st = !mine ? '' : (!active && s.pct >= 1) ? 'done' : i < idx ? 'done' : i === idx && active ? 'active' : ''; return `<div class="stage ${st}"><span class="n">${st === 'done' ? icon('check') : i + 1}</span><div><b>${t}</b><small>${sub}</small></div></div>`; }).join('');
      bar.style.width = (mine ? s.pct * 100 : 0) + '%'; msg.textContent = mine ? (active ? s.msg : s.pct >= 1 ? 'Finished.' : 'Idle.') : 'Idle.';
      log.innerHTML = mine ? s.log.map(l => `<div><span>${l.t.toFixed(1)}s</span>${esc(l.msg)}</div>`).join('') : ''; log.scrollTop = log.scrollHeight;
      runB.disabled = benchB.disabled = active; cancelB.hidden = !active; elapsed.textContent = active ? ((Date.now() - s.started) / 1000).toFixed(0) + ' s' : '';
    };
    paintJob(Jobs.state); disposers.push(Jobs.on(paintJob));
    const tick = setInterval(() => { if (Jobs.state.running && Jobs.state.projectId === project.id) elapsed.textContent = ((Date.now() - Jobs.state.started) / 1000).toFixed(0) + ' s'; }, 1000); disposers.push(() => clearInterval(tick));
    on(cancelB, 'click', () => { Runner.cancel(); Jobs.finish(); });
    on(benchB, 'click', () => { if (!hasImgs()) { location.hash = `#/p/${project.id}/start`; return; } kickoff(project, { benchmark: true, stay: true }); });
    if (project.benchmark) { $('#benchOut', root).innerHTML = benchTable(); }
  }
  function benchTable() {
    const b = project.benchmark, name = { raw: 'Intensity', illum: 'Sun-angle normalised', struct: 'Cross-modal structure' };
    return `<div class="card"><div class="card-head"><h3>Method benchmark</h3><span class="note">${ago(b.ranAt)} · best adopted for this project</span></div><div class="scroll"><table class="tbl"><thead><tr><th>Preprocessing</th><th>Model</th><th>Inliers</th><th>Inlier ratio</th><th>RMSE · src px</th><th>Holdout · src px</th><th>Seconds</th></tr></thead><tbody>${b.rows.map(r => `<tr class="${b.bestKey === r.pre + '/' + r.model ? 'best' : ''}"><td>${name[r.pre]}${b.bestKey === r.pre + '/' + r.model ? ' ★' : ''}</td><td>${MODEL_NAME[r.model]}</td>${r.ok ? `<td>${fmtInt(r.metrics.inliers)}</td><td>${pct(r.metrics.inlierRatio, 1)}</td><td>${fmt(r.metrics.rmseSrcPx, 3)}</td><td>${r.metrics.holdoutSrcPx == null ? '—' : fmt(r.metrics.holdoutSrcPx, 3)}</td>` : '<td colspan="4" style="color:var(--bad)">no verified match</td>'}<td>${fmt(r.seconds, 1)}</td></tr>`).join('')}</tbody></table></div></div>`;
  }

  // ═════════════════════ RESULTS ═════════════════════
  function viewResults() {
    if (!res()) { shell('results', titleRow('Evidence', 'Results') + (hasImgs() ? `<div class="card"><div class="empty"><b style="color:var(--ink)">No result yet</b>${runBtn()}</div></div>` : needImages())); wireRun(); paintMoons(root); return; }
    const r = res(), m = r.metrics, d = r.decomposed, M = r.matches, n = M.length / 7;
    const rows = []; for (let i = 0; i < n; i++) if (M[i * 7 + 5]) rows.push(i); rows.sort((a, b) => M[a * 7 + 4] - M[b * 7 + 4]);
    shell('results', titleRow('Evidence', 'Results', statusPill()) + `<div class="metric-grid">${[['Verified matches', fmtInt(m.inliers), `of ${fmtInt(m.candidates)} candidates`], ['Inlier ratio', pct(m.inlierRatio, 1), 'inliers / candidates'], ['RMSE', fmt(m.rmseSrcPx, 3) + '<small>src px</small>', `${fmt(m.rmseRefPx, 3)} reference px`], ['Processing', fmt(r.timings.total / 1000, 1) + '<small>s</small>', 'measured in this browser']].map(([l, v, s]) => `<div class="card big"><div class="l">${l}</div><div class="v">${v}</div><div class="s">${s}</div></div>`).join('')}</div>
      <div class="two"><div class="card"><div class="card-head"><h3>Transformation</h3><span class="pill">${modelName()}</span></div><div class="card-body" style="padding-top:8px">
        <div class="kv"><span>Scale (source → reference)</span><b>${fmt(d.scale, 4)}</b></div><div class="kv"><span>Rotation</span><b>${fmt(d.rotationDeg, 3)}°</b></div><div class="kv"><span>Translation</span><b>${fmt(d.tx, 2)}, ${fmt(d.ty, 2)} px</b></div>${r.cfg.model === 'affine' ? `<div class="kv"><span>Anisotropy · shear</span><b>${fmt(d.scaleY / d.scaleX, 4)} · ${fmt(d.shear, 4)}</b></div>` : ''}
        <div class="kv"><span>Matrix (native px)</span><b style="font-size:11px;line-height:1.7">[${r.H.slice(0, 3).map(v => fmt(v, 5)).join(', ')}]<br>[${r.H.slice(3).map(v => fmt(v, 5)).join(', ')}]</b></div><div class="kv"><span>Preprocessing</span><b>${esc(r.cfg.pre)}</b></div>${r.tried?.length > 1 ? `<div class="kv"><span>Scale hypotheses (inliers)</span><b>${r.tried.map(t => fmtInt(t.inliers)).join(' · ')}</b></div>` : ''}</div></div>
      <div class="card"><div class="card-head"><h3>Residuals</h3><span class="note">reference px</span></div><div class="card-body"><canvas class="chart" id="hist"></canvas></div></div></div>
      <div class="card" style="margin-top:18px"><div class="card-head"><h3>Control points</h3><span class="note">lowest residual first · showing ${Math.min(300, rows.length)} of ${fmtInt(rows.length)}</span></div><div class="scroll"><table class="tbl"><thead><tr><th>#</th><th>Source x, y</th><th>Reference x, y</th><th>Residual · ref px</th><th>Ratio</th><th>Grid-balanced</th></tr></thead><tbody>${rows.slice(0, 300).map((i, k) => `<tr><td>${k + 1}</td><td>${fmt(M[i * 7], 2)}, ${fmt(M[i * 7 + 1], 2)}</td><td>${fmt(M[i * 7 + 2], 2)}, ${fmt(M[i * 7 + 3], 2)}</td><td>${fmt(M[i * 7 + 4], 3)}</td><td>${fmt(M[i * 7 + 6], 2)}</td><td>${r.selectedFlags[i] ? '●' : ''}</td></tr>`).join('')}</tbody></table></div></div>`);
    drawHist($('#hist', root), residualsRef(), 'px');
  }

  // ═════════════════════ EXPORT ═════════════════════
  function csv(onlySel) {
    const r = res(), M = r.matches, n = M.length / 7, s = r.decomposed.scale || 1, out = ['id,source_x,source_y,reference_x,reference_y,residual_reference_px,residual_source_px,match_ratio,inlier,grid_balanced'];
    let id = 0; for (let i = 0; i < n; i++) { const inl = M[i * 7 + 5] === 1; if (!inl) continue; if (onlySel && !r.selectedFlags[i]) continue; out.push([++id, ...[0, 1, 2, 3].map(k => M[i * 7 + k].toFixed(3)), M[i * 7 + 4].toFixed(4), (M[i * 7 + 4] / s).toFixed(4), M[i * 7 + 6].toFixed(4), 1, r.selectedFlags[i] ? 1 : 0].join(',')); }
    return out.join('\n');
  }
  function jsonDoc() {
    const r = res(), m = r.metrics, tr = project.truth ? E().transformError(r.H, project.truth.H, project.src.w, project.src.h) : null;
    return JSON.stringify({ software: 'STARDUST', engineVersion: E().VERSION, problem: 'SIH26166', project: project.name, mode: mode.id, generated: new Date().toISOString(),
      coordinateConvention: 'Pixel units, origin at the centre of the top-left pixel (x right, y down); native resolution of each supplied image.',
      images: { source: { name: project.src.name, width: project.src.w, height: project.src.h, instrument: project.src.sensor, metersPerPixel: project.src.gsd }, reference: { name: project.ref.name, width: project.ref.w, height: project.ref.h, instrument: project.ref.sensor, metersPerPixel: project.ref.gsd } },
      transform: { model: r.cfg.model, description: 'Maps source pixel coordinates to reference pixel coordinates: x\' = m00·x + m01·y + tx ; y\' = m10·x + m11·y + ty', matrix: [[r.H[0], r.H[1], r.H[2]], [r.H[3], r.H[4], r.H[5]]], decomposition: r.decomposed },
      metrics: Object.assign({}, m, { knownTransformErrorSourcePx: tr ? tr.rmseSrc : null }), distribution: { grid: r.dist.grid, counts: r.dist.counts, eligible: r.dist.eligible, coverage: r.dist.coverage, uniformity: r.dist.uniformity },
      parameters: r.cfg, scaleHypotheses: r.tried, timingsMs: r.timings,
      scope: 'Fit and holdout residuals describe agreement with the fitted model. They are not independent ground-truth accuracy unless an independent check (known transform / surveyed control points) is reported.' }, null, 2);
  }
  async function reportHtml() {
    const r = res(), m = r.metrics, ref = await pixels(project, 'ref'); let img = '';
    if (project.regBlob) { const c = document.createElement('canvas'), k = Math.min(1, 900 / ref.w); c.width = ref.w * k; c.height = ref.h * k; const g = c.getContext('2d'); g.drawImage(grayToCanvas(ref.gray, ref.w, ref.h), 0, 0, c.width, c.height); g.globalAlpha = .55; g.drawImage(await createImageBitmap(project.regBlob), 0, 0, c.width, c.height); img = c.toDataURL('image/jpeg', 0.85); }
    const row = (a, b) => `<tr><th>${a}</th><td>${b}</td></tr>`;
    return `<!doctype html><meta charset="utf-8"><title>STARDUST report — ${esc(project.name)}</title><style>body{font:14px/1.6 system-ui,sans-serif;max-width:820px;margin:40px auto;padding:0 20px;color:#111}h1{font-weight:300;letter-spacing:.14em;text-transform:uppercase}table{border-collapse:collapse;width:100%;margin:12px 0 24px}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #ddd}th{color:#555;font-weight:500;width:50%}img{max-width:100%;border-radius:8px}small{color:#666}</style>
      <h1>${esc(project.name)}</h1><p>${mode.name} · ${esc(mode.title)} — SIH26166 registration report<br><small>Generated ${new Date().toLocaleString()} · engine v${E().VERSION}</small></p>${img ? `<img src="${img}" alt="Registered source blended over reference">` : ''}
      <h2>Evaluation statistics</h2><table>${row('Inliers / candidates', `${fmtInt(m.inliers)} / ${fmtInt(m.candidates)}`)}${row('Inlier ratio', pct(m.inlierRatio, 1))}${row('RMSE (source px)', fmt(m.rmseSrcPx, 3))}${row('RMSE (reference px)', fmt(m.rmseRefPx, 3))}${row('Spatial holdout (source px)', m.holdoutSrcPx == null ? 'n/a' : fmt(m.holdoutSrcPx, 3))}${row('Median / 95th pct residual (ref px)', `${fmt(m.medianRefPx, 2)} / ${fmt(m.p95RefPx, 2)}`)}${row('Coverage of overlap / uniformity', `${pct(m.coverage)} / ${fmt(m.uniformity, 2)}`)}${row('Grid-balanced control points', fmtInt(m.selected))}</table>
      <h2>Transform (${r.cfg.model})</h2><table>${row('Scale', fmt(r.decomposed.scale, 5))}${row('Rotation', fmt(r.decomposed.rotationDeg, 3) + '°')}${row('Translation', `${fmt(r.decomposed.tx, 2)}, ${fmt(r.decomposed.ty, 2)} px`)}</table>
      <h2>Inputs</h2><table>${row('Source', `${esc(project.src.name)} · ${project.src.w}×${project.src.h} · ${esc(project.src.sensor || '')}`)}${row('Reference', `${esc(project.ref.name)} · ${project.ref.w}×${project.ref.h} · ${esc(project.ref.sensor || '')}`)}${row('Preprocessing', r.cfg.pre)}</table>
      <p><small>Fit and holdout residuals describe agreement with the fitted transform, not independent ground-truth accuracy.</small></p>`;
  }
  function viewExport() {
    if (!res()) { shell('export', titleRow('Deliverables', 'Export') + (hasImgs() ? `<div class="card"><div class="empty"><b style="color:var(--ink)">Nothing to export yet</b>${runBtn()}</div></div>` : needImages())); wireRun(); paintMoons(root); return; }
    const slug = project.name.replace(/[^\w]+/g, '-').toLowerCase() || 'project', m = res().metrics;
    const card = (id, ic, title, text, btn) => `<div class="card"><div class="card-head"><h3>${title}</h3>${icon(ic)}</div><div class="card-body"><p class="note" style="min-height:66px">${text}</p>${btn}</div></div>`;
    shell('export', titleRow('Deliverables', 'Export', statusPill()) + `<div class="set-grid" style="max-width:1100px;grid-template-columns:repeat(2,minmax(0,1fr))">
      ${card('png', 'image', 'Registered image', 'The source image resampled into the reference frame (PNG, transparent outside the overlap). Registered product.', `<button class="btn solid" data-x="png" ${project.regBlob ? '' : 'disabled'}>${icon('download')}Download PNG</button>`)}
      ${card('csv', 'file', 'Match points', `${fmtInt(m.inliers)} verified correspondences with native source/reference coordinates and residuals.`, `<div style="display:flex;gap:12px;flex-wrap:wrap"><button class="btn solid" data-x="csv">${icon('download')}All inliers</button><button class="btn" data-x="csvsel">${icon('download')}Grid-balanced (${fmtInt(m.selected)})</button></div>`)}
      ${card('json', 'layers', 'Transform & statistics', 'Matrix, decomposition, RMSE, inlier count and ratio, distribution, parameters and scope statement (JSON).', `<button class="btn solid" data-x="json">${icon('download')}Download JSON</button>`)}
      ${card('rep', 'chart', 'Report', 'A self-contained HTML report with the overlay and evaluation statistics — print it to PDF.', `<button class="btn solid" data-x="rep">${icon('download')}Download report</button>`)}</div>
      <p class="note" style="margin-top:22px;max-width:760px">Coordinates use the native resolution of each supplied image, origin at the centre of the top-left pixel. RMSE is reported in both reference and source pixels; the source-pixel figure is the one to compare with the “below one source pixel” goal.</p>`);
    $$('[data-x]', root).forEach(b => on(b, 'click', async () => {
      const x = b.dataset.x;
      if (x === 'png') download(project.regBlob, `${slug}-registered.png`);
      if (x === 'csv') download(csv(false), `${slug}-match-points.csv`, 'text/csv');
      if (x === 'csvsel') download(csv(true), `${slug}-match-points-grid-balanced.csv`, 'text/csv');
      if (x === 'json') download(jsonDoc(), `${slug}-transform.json`, 'application/json');
      if (x === 'rep') download(await reportHtml(), `${slug}-report.html`, 'text/html');
      toast('Download started', 'ok');
    }));
  }

  // ─────────── dispatch ───────────
  if (viewName === 'start') await viewStart();
  else if (viewName === 'data') await viewData();
  else if (viewName === 'processing') await viewProcessing();
  else if (viewName === 'results') viewResults();
  else if (viewName === 'export') viewExport();
  else await viewOverview();
  root.querySelectorAll('.ws-main,.start').forEach(el => el.classList.add('view-in'));
  countUp($$('.metric b, .big .v', root));
  const tb = $('#tabBody', root); if (tb) tb.classList.add('tab-in');
  if (viewName === 'processing') paintMoons(root);
  return () => { disposers.forEach(f => f()); };
}
