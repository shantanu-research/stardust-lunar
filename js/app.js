/* STARDUST — shell, router and the non-workspace screens (Home, Choose mode, Projects, Data, Settings). */
import { $, $$, esc, icon, ago, toast, clamp, fmtInt } from './lib.js';
import { Store, Prefs } from './store.js';
import { MODES, SENSORS, modeById } from './modes.js';
import { startWave } from './wave.js';
import { paintMoons } from './moons.js';
import { newProject, makeSample } from './runner.js';
import { renderWorkspace } from './workspace.js';
import { startAura } from './aura.js';
import { startFlow } from './flow.js';
import { startStars } from './stars.js';

startStars();

// Lenis: inertial scrolling, driven by the GSAP ticker; paused while the aurora owns the screen.
(() => {
  const L = window.Lenis, g = window.gsap;
  if (!L || !g || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const lenis = new L({ lerp: .085, wheelMultiplier: .9, smoothWheel: true });
  g.ticker.add((t) => lenis.raf(t * 1000)); g.ticker.lagSmoothing(0);
  new MutationObserver(() => document.body.classList.contains('analysing') ? lenis.stop() : lenis.start()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  addEventListener('hashchange', () => lenis.scrollTo(0, { immediate: true }));
})();

const view = $('#view'), rail = $('#rail'), modalRoot = $('#modalRoot');
let cleanup = null, token = 0;

// ───────── theme ─────────
function applyTheme(t) { document.documentElement.dataset.theme = t; Prefs.set('theme', t); $('#themeBtn').innerHTML = icon(t === 'dark' ? 'sun' : 'moon'); $('#themeBtn').title = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'; document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#000000' : '#f3f3f1'; }
applyTheme(document.documentElement.dataset.theme || 'dark');
$('#themeBtn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));

// ───────── rail ─────────
const RAIL = [['home', 'Home', 'home'], ['projects', 'Projects', 'folder'], ['data', 'Data', 'data'], ['settings', 'Settings', 'settings']];
rail.innerHTML = '<i class="rail-bar"></i>' + RAIL.map(([id, label, ic]) => `<a href="#/${id}" data-r="${id}">${icon(ic)}${label}</a>`).join('');
function updateRail(page) {
  const on = page === 'modes' ? 'home' : page;
  $$('a', rail).forEach(a => { const active = a.dataset.r === on; a.classList.toggle('active', active); active ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  const a = $('a.active', rail), bar = $('.rail-bar', rail);
  if (a && getComputedStyle(bar).display !== 'none') { bar.style.transform = `translateY(${a.offsetTop}px)`; bar.classList.add('on'); } else bar.classList.remove('on');
}

// ───────── pointer spotlight on cards ─────────
let spotEl = null;
document.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const el = e.target.closest?.('.card,.proj');
  if (el !== spotEl) { spotEl?.removeAttribute('data-spot'); spotEl = el; spotEl?.setAttribute('data-spot', ''); }
  if (spotEl) { const r = spotEl.getBoundingClientRect(); spotEl.style.setProperty('--mx', (e.clientX - r.left) + 'px'); spotEl.style.setProperty('--my', (e.clientY - r.top) + 'px'); }
}, { passive: true });

// ───────── helpers ─────────
const STATUS = { draft: ['In progress', ''], processing: ['Processing', 'on'], completed: ['Completed', 'ok'], failed: ['Needs attention', 'bad'] };
function projectCard(p) {
  const m = modeById(p.mode), [label, cls] = STATUS[p.status] || STATUS.draft;
  return `<div class="proj" role="link" tabindex="0" data-open="${p.id}" aria-label="Open project ${esc(p.name)}">
    <div class="proj-thumb">${p.thumb ? `<img src="${p.thumb}" alt="">` : `<span class="moon md" data-moon="${m.id}"></span>`}<button class="proj-menu" data-menu="${p.id}" aria-label="Project options">${icon('dots')}</button></div>
    <h3>${esc(p.name)}</h3>
    <p>Chandrayaan-2 · ${esc((p.sensors || []).join(' + ') || 'Imagery')} · ${esc(m.name)}</p>
    <div class="proj-meta"><span><i class="dot ${cls}"></i>${label}</span><span>${ago(p.updated)}</span></div>
  </div>`;
}
function wireCards(root, reload) {
  $$('.proj[data-open]', root).forEach(c => {
    const open = () => { location.hash = `#/p/${c.dataset.open}/${c.dataset.openView || 'overview'}`; };
    c.addEventListener('click', (e) => { if (e.target.closest('[data-menu]')) return; open(); });
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  });
  $$('[data-menu]', root).forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); projectMenu(b, b.dataset.menu, reload); }));
}
function projectMenu(anchor, id, reload) {
  $('.pop-menu')?.remove();
  const m = document.createElement('div'); m.className = 'mode-menu pop-menu'; m.style.cssText = 'position:fixed;width:180px;z-index:120';
  const r = anchor.getBoundingClientRect(); m.style.left = Math.min(innerWidth - 196, r.right - 170) + 'px'; m.style.top = r.bottom + 6 + 'px';
  m.innerHTML = `<button data-a="open">${icon('arrow')}Open</button><button data-a="rename">${icon('file')}Rename</button><button data-a="delete">${icon('trash')}Delete</button>`;
  document.body.append(m);
  const close = () => { m.remove(); document.removeEventListener('pointerdown', away, true); };
  const away = (e) => { if (!m.contains(e.target)) close(); };
  setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
  m.addEventListener('click', async (e) => {
    const a = e.target.closest('button')?.dataset.a; if (!a) return; close();
    const p = await Store.get(id); if (!p) return;
    if (a === 'open') location.hash = `#/p/${id}/overview`;
    if (a === 'rename') { const n = prompt('Rename project', p.name); if (n && n.trim()) { p.name = n.trim().slice(0, 60); await Store.put(p); reload?.(); } }
    if (a === 'delete') { if (confirm(`Delete “${p.name}” and its images and results from this device?`)) { await Store.del(id); toast('Project deleted'); reload?.(); } }
  });
}

// ───────── modal: new project ─────────
export function openNewProject(preMode) {
  const prefs = Prefs.get('defaults', {});
  let mode = preMode || 'deimos', sensors = new Set(['OHRC']);
  modalRoot.innerHTML = `<div class="overlay" role="dialog" aria-modal="true" aria-labelledby="npT">
    <form class="modal" autocomplete="off">
      <div class="modal-head"><h2 id="npT">New Project</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon('close')}</button></div>
      <div class="modal-body">
        <div class="field"><label for="npName">Project name</label><input class="input" id="npName" maxlength="60" placeholder="Enter project name…" required></div>
        <div class="field"><label>Select mode</label><div class="mode-pick"><button type="button" class="input" id="npMode" aria-haspopup="listbox" aria-expanded="false"></button><div class="mode-menu" id="npMenu" role="listbox" hidden></div></div></div>
        <div class="field"><label>Data source</label><div class="chips" id="npChips"><button type="button" class="chip" aria-pressed="true" disabled>Chandrayaan-2</button>${SENSORS.filter(s => s.id !== 'Other').map(s => `<button type="button" class="chip" data-s="${s.id}" aria-pressed="${s.id === 'OHRC'}">${s.label}</button>`).join('')}</div><p class="note" id="npNote"></p></div>
        <div class="modal-foot"><button type="button" class="btn" data-close>Cancel</button><button class="btn solid" type="submit">Create Project ${icon('arrow')}</button></div>
      </div></form></div>`;
  const root = $('.overlay', modalRoot), name = $('#npName'), btn = $('#npMode'), menu = $('#npMenu'), note = $('#npNote');
  const close = () => { document.removeEventListener('keydown', esc_); root.classList.add('closing'); setTimeout(() => { if (modalRoot.contains(root)) modalRoot.innerHTML = ''; }, 380); };
  const esc_ = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', esc_);
  $$('[data-close]', root).forEach(b => b.addEventListener('click', close));
  root.addEventListener('pointerdown', (e) => { if (e.target === root) close(); });
  const paintMode = () => { const m = modeById(mode); btn.innerHTML = `<span class="moon sm" data-moon="${m.id}"></span><span>${m.name} <small style="color:var(--muted)">— ${m.title}</small></span>`; paintMoons(btn); };
  const paintNote = () => { const m = modeById(mode); note.textContent = m.id === 'phobos' ? 'Pick the instrument for each image on the next screen — their resolutions set the scale prior.' : m.id === 'enceladus' ? 'For IIRS, export one band as an image; the matcher uses structure, not absolute radiance.' : 'You can change instruments per image on the next screen.'; };
  btn.addEventListener('click', () => { const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); });
  menu.innerHTML = MODES.map(m => `<button type="button" role="option" data-m="${m.id}" aria-selected="${m.id === mode}"><span class="moon sm" data-moon="${m.id}"></span><span>${m.name}<small>${m.title}</small></span></button>`).join(''); paintMoons(menu);
  menu.addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (!b) return; mode = b.dataset.m; $$('[data-m]', menu).forEach(x => x.setAttribute('aria-selected', String(x === b))); menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); paintMode(); paintNote(); });
  $('#npChips', root).addEventListener('click', (e) => { const c = e.target.closest('[data-s]'); if (!c) return; const on = c.getAttribute('aria-pressed') !== 'true'; if (!on && sensors.size === 1) return; c.setAttribute('aria-pressed', String(on)); on ? sensors.add(c.dataset.s) : sensors.delete(c.dataset.s); });
  paintMode(); paintNote(); name.value = ''; setTimeout(() => name.focus(), 60);
  $('form', root).addEventListener('submit', async (e) => {
    e.preventDefault();
    const p = newProject({ name: name.value.trim() || 'Untitled project', mode, sensors: [...sensors] });
    p.params = Object.assign({}, prefs.ratio != null ? { ratio: prefs.ratio } : {}, prefs.thr != null ? { thr: prefs.thr } : {}, prefs.maxKp != null ? { maxKp: prefs.maxKp } : {}, prefs.workRes != null ? { workRes: prefs.workRes } : {});
    await Store.put(p); close(); location.hash = `#/p/${p.id}/start`;
  });
}
window.addEventListener('stardust:new-project', (e) => openNewProject(e.detail));

// ───────── Home ─────────
async function renderHome(tk) {
  view.innerHTML = `
    <section class="hero" aria-label="Stardust"><canvas id="wave" aria-hidden="true"></canvas>
      <div class="hero-copy">
        <p class="hero-eyebrow">Lunar imaging system</p>
        <h1 class="hero-title">Stardust</h1>
        <p class="hero-tag">Match. Register. Verify.</p>
        <p class="hero-sub">Turning Chandrayaan-2 observations into pixel-accurate correspondences — across scale, Sun angle and sensor.</p>
        <div class="hero-actions"><a class="btn solid lg" href="#/modes">${icon('plus')}New Project</a><a class="btn lg" href="#/projects">${icon('folder')}Open Project</a></div>
      </div></section>
    <section class="section" aria-labelledby="rp"><div class="section-head"><h2 id="rp">Recent projects</h2><a class="link-arrow" href="#/projects">View all ${icon('arrow')}</a></div><div class="proj-grid" id="recent"></div></section>
    <div class="foot"><span>Indian Space Research Organisation</span><span>Moon<b>/</b>Data<b>/</b>Discovery</span></div>`;
  const stop = startWave($('.hero'), $('#wave')), stopAura = startAura($('#recent'), '.proj');
  const load = async () => {
    const list = (await Store.all()).slice(0, 4); if (tk !== token) return;
    const grid = $('#recent'); if (!grid) return;
    grid.innerHTML = list.map(projectCard).join('') + (list.length < 4 ? `<a class="proj ghost" href="#/modes" style="animation-delay:${.55 + list.length * .12}s"><span class="plus">${icon('plus')}</span><b style="font-weight:500;letter-spacing:.14em;font-size:11px;text-transform:uppercase;color:var(--ink-2)">${list.length ? 'New project' : 'Start your first project'}</b><span style="font-size:11px;max-width:180px">${list.length ? 'Pick a mode and load two observations.' : 'Choose a mode, then load two images — or try a real LRO sample.'}</span></a>` : '');
    paintMoons(grid); wireCards(grid, load);
  };
  await load(); return () => { stop(); stopAura(); };
}

// ───────── Choose mode ─────────
function renderModes() {
  view.innerHTML = `<div class="modes-head"><a class="back-link" href="#/home">${icon('back')} Back</a><p class="eyebrow">New workspace</p><h1>Choose your mode</h1><p>Different celestial bodies. Different perspectives.<br>Same goal — deeper insights.</p></div>
    <div class="mode-grid" id="modeGrid">${MODES.map(m => `<button class="mode" data-mode="${m.id}" aria-label="${m.name}: ${esc(m.title)}"><span class="no">${m.no}</span><span class="moon" data-moon="${m.id}" aria-hidden="true"></span><h3>${m.name}</h3><p>${esc(m.blurb)}</p><span class="go" aria-hidden="true">${icon('arrow')}</span></button>`).join('')}</div>
    <p class="modes-note">The moons guide your analysis</p>`;
  paintMoons(view);
  $('#modeGrid').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) openNewProject(b.dataset.mode); });
  return startFlow($('#modeGrid'), '.mode');
}

// ───────── Projects ─────────
async function renderProjects(tk) {
  view.innerHTML = `<div class="page-head"><div><p class="eyebrow">Library</p><h1>Projects</h1><p>Everything you have registered, stored on this device.</p></div><a class="btn solid" href="#/modes">${icon('plus')}New Project</a></div>
    <div class="toolbar"><input class="input" id="q" type="search" placeholder="Search projects…" aria-label="Search projects"><select class="input" id="fm" style="max-width:240px" aria-label="Filter by mode"><option value="">All modes</option>${MODES.map(m => `<option value="${m.id}">${m.name} — ${m.title}</option>`).join('')}</select><span class="note" id="count"></span></div><div class="proj-grid" id="grid"></div>`;
  let all = [];
  const draw = () => {
    const q = $('#q').value.trim().toLowerCase(), fm = $('#fm').value, list = all.filter(p => (!fm || p.mode === fm) && (!q || p.name.toLowerCase().includes(q)));
    $('#count').textContent = `${list.length} of ${all.length}`;
    $('#grid').innerHTML = list.length ? list.map(projectCard).join('') : `<div class="empty" style="grid-column:1/-1"><span class="moon lg" data-moon="deimos"></span><b style="color:var(--ink)">${all.length ? 'No matching projects' : 'No projects yet'}</b><span>${all.length ? 'Try a different search.' : 'Create one to see it here.'}</span><a class="btn solid" href="#/modes">${icon('plus')}New Project</a></div>`;
    paintMoons($('#grid')); wireCards($('#grid'), load);
  };
  const load = async () => { all = await Store.all(); if (tk === token) draw(); };
  $('#q').addEventListener('input', draw); $('#fm').addEventListener('change', draw);
  const stopAura = startAura($('#grid'), '.proj');
  await load(); return stopAura;
}

// ───────── Data ─────────
const SAMPLES = [
  { kind: 'basic', mode: 'deimos', title: 'Rotated window', text: 'Two windows of the same real LRO WAC terrain, rotated and rescaled with a known transform.' },
  { kind: 'sun', mode: 'europa', title: 'Sun-angle change', text: 'Same terrain under a strong illumination ramp and gamma shift — shading moves, craters stay.' },
  { kind: 'inverted', mode: 'enceladus', title: 'Cross-modal stand-in', text: 'Contrast-reversed and softened view, imitating two sensors that disagree on brightness.' },
  { kind: 'scale', mode: 'phobos', title: 'Resolution gap', text: 'A fine view against a reference that is 4× coarser — a small OHRC-vs-TMC-2 situation.' }
];
async function renderData(tk) {
  view.innerHTML = `<div class="page-head"><div><p class="eyebrow">Observations</p><h1>Data</h1><p>Real LRO WAC terrain with known-transform views, so every mode can be tried and checked against ground truth. Your own images are added inside a project.</p></div></div>
    <div class="section-head"><h2 class="label">Sample pairs</h2></div><div class="sample-grid" id="samples">${SAMPLES.map(s => `<div class="card sample"><div class="proj-thumb"><img src="assets/lro-wac-sample.jpg" alt="" style="${s.kind === 'inverted' ? 'filter:grayscale(1) invert(1)' : ''}"></div><h3>${s.title}</h3><p>${s.text}</p><button class="btn sm solid" data-sample="${s.kind}" data-mode="${s.mode}">Open in ${modeById(s.mode).name}</button></div>`).join('')}</div>
    <div class="section-head" style="margin-top:44px"><h2 class="label">Your images</h2></div><div id="mine" class="card"><div class="empty">Loading…</div></div>
    <p class="note" style="margin-top:22px;max-width:760px"><b>Formats.</b> PNG, JPEG, WebP, BMP and GIF decode in the browser. PDS4 / GeoTIFF / 16-bit products should be exported to an 8-bit PNG first (for IIRS, a single band). Images stay on this device — nothing is uploaded.</p>`;
  $('#samples').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-sample]'); if (!b) return; b.disabled = true; b.innerHTML = '<span class="spinner"></span> Preparing';
    try { const p = await projectFromSample(b.dataset.sample, b.dataset.mode); location.hash = `#/p/${p.id}/start`; } catch (err) { toast('Could not build the sample: ' + err.message, 'error'); b.disabled = false; b.textContent = 'Try again'; }
  });
  const all = await Store.all(); if (tk !== token) return;
  const rows = all.flatMap(p => ['src', 'ref'].filter(r => p[r]).map(r => ({ p, r, i: p[r] })));
  $('#mine').innerHTML = rows.length ? `<div class="scroll"><table class="tbl"><thead><tr><th>Image</th><th>Role</th><th>Instrument</th><th>Size</th><th>Project</th></tr></thead><tbody>${rows.map(x => `<tr><td>${esc(x.i.name)}${x.i.sample ? ' <span class="pill" style="height:18px;margin-left:6px">sample</span>' : ''}</td><td>${x.r === 'src' ? 'Moving' : 'Reference'}</td><td>${esc(x.i.sensor || '—')}</td><td>${x.i.w}×${x.i.h}</td><td><a href="#/p/${x.p.id}/data" style="text-decoration:underline">${esc(x.p.name)}</a></td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">No images yet. Load a pair inside a project, or open a sample above.</div>';
}
export async function projectFromSample(kind, mode) {
  const s = await makeSample(kind), p = newProject({ name: 'Sample · ' + SAMPLES.find(x => x.kind === kind).title, mode, sensors: kind === 'scale' ? ['OHRC', 'TMC-2'] : ['OHRC'] });
  p.src = s.src; p.ref = s.ref; p.truth = s.truth; await Store.put(p); return p;
}

// ───────── Settings ─────────
async function renderSettings() {
  const d = Object.assign({ ratio: 0.8, thr: 3, maxKp: 2500, workRes: 1000 }, Prefs.get('defaults', {}));
  const theme = document.documentElement.dataset.theme, usage = await Store.usage();
  view.innerHTML = `<div class="page-head"><div><p class="eyebrow">Preferences</p><h1>Settings</h1><p>Defaults applied to new projects. Per-project parameters live in the Processing view.</p></div></div>
    <div class="set-grid">
      <div class="card"><div class="card-head"><h3>Appearance</h3></div><div class="card-body"><div class="field"><label>Theme</label><div class="chips"><button class="chip" data-theme="dark" aria-pressed="${theme === 'dark'}">Dark</button><button class="chip" data-theme="light" aria-pressed="${theme === 'light'}">Light</button></div></div><p class="note">Animations follow your system’s “reduce motion” setting.</p></div></div>
      <div class="card"><div class="card-head"><h3>Engine defaults</h3></div><div class="card-body">
        <div class="field"><label for="dWr">Working resolution <span class="val" id="vWr">${d.workRes}px</span></label><input type="range" id="dWr" min="500" max="1800" step="100" value="${d.workRes}"><p class="note">Longest side used for matching. Higher is slower; reported errors are always in native pixels.</p></div>
        <div class="field"><label for="dKp">Keypoints per image <span class="val" id="vKp">${d.maxKp}</span></label><input type="range" id="dKp" min="800" max="5000" step="100" value="${d.maxKp}"></div>
        <div class="field"><label for="dRa">Match ratio <span class="val" id="vRa">${d.ratio.toFixed(2)}</span></label><input type="range" id="dRa" min="0.6" max="0.95" step="0.01" value="${d.ratio}"></div>
        <div class="field"><label for="dTh">Inlier threshold <span class="val" id="vTh">${d.thr.toFixed(1)}px</span></label><input type="range" id="dTh" min="1" max="8" step="0.5" value="${d.thr}"></div>
      </div></div>
      <div class="card"><div class="card-head"><h3>Storage</h3></div><div class="card-body"><p class="note" id="usage">${usage ? `Using ${(usage.used / 1048576).toFixed(1)} MB of local storage on this device.` : 'Projects are stored in this browser.'}</p><button class="btn danger" id="wipe">${icon('trash')}Delete all projects</button></div></div>
      <div class="card"><div class="card-head"><h3>About</h3></div><div class="card-body"><div class="kv"><span>Engine</span><b>v${window.StardustEngine.VERSION}</b></div><div class="kv"><span>Problem</span><b>SIH26166</b></div><div class="kv"><span>Sponsor</span><b>ISRO</b></div><p class="note" style="margin-top:14px">Sun-angle, scale and modality invariant image correspondence for Chandrayaan-2 OHRC, TMC-2 and IIRS imagery. Fit residuals describe agreement with the fitted model; independent accuracy needs surveyed control points.</p></div></div>
    </div>`;
  const save = () => Prefs.set('defaults', d);
  const bind = (id, vid, key, f) => $('#' + id).addEventListener('input', (e) => { d[key] = +e.target.value; $('#' + vid).textContent = f(d[key]); save(); });
  bind('dWr', 'vWr', 'workRes', v => v + 'px'); bind('dKp', 'vKp', 'maxKp', v => v); bind('dRa', 'vRa', 'ratio', v => v.toFixed(2)); bind('dTh', 'vTh', 'thr', v => v.toFixed(1) + 'px');
  $$('[data-theme]', view).forEach(b => b.addEventListener('click', () => { applyTheme(b.dataset.theme); $$('[data-theme]', view).forEach(x => x.setAttribute('aria-pressed', String(x === b))); }));
  $('#wipe').addEventListener('click', async () => { if (confirm('Delete every project, image and result stored on this device?')) { await Store.clear(); toast('All projects deleted', 'ok'); } });
}

// ───────── router ─────────
async function route() {
  const tk = ++token;
  if (view.childElementCount && !matchMedia('(prefers-reduced-motion: reduce)').matches && !document.body.classList.contains('analysing')) { view.classList.add('view-out'); await new Promise(r => setTimeout(r, 260)); if (tk !== token) return; }
  view.classList.remove('view-out'); cleanup?.(); cleanup = null; $('.pop-menu')?.remove(); modalRoot.innerHTML = '';
  const parts = (location.hash.replace(/^#\/?/, '') || 'home').split('/'), page = parts[0];
  document.body.dataset.page = page === 'p' ? 'workspace' : page; updateRail(page);
  view.classList.remove('view-in'); void view.offsetWidth; view.classList.add('view-in'); scrollTo(0, 0);
  document.title = 'STARDUST' + ({ home: '', modes: ' · Choose mode', projects: ' · Projects', data: ' · Data', settings: ' · Settings', p: ' · Workspace' }[page] || '');
  try {
    if (page === 'modes') cleanup = renderModes();
    else if (page === 'projects') cleanup = await renderProjects(tk);
    else if (page === 'data') await renderData(tk);
    else if (page === 'settings') await renderSettings();
    else if (page === 'p') { const p = await Store.get(parts[1]); if (!p) { view.innerHTML = '<div class="empty" style="padding-top:140px"><b style="color:var(--ink)">Project not found</b><a class="btn" href="#/projects">Back to projects</a></div>'; return; } if (tk !== token) return; cleanup = await renderWorkspace(view, p, parts[2] || 'overview', parts[3]); }
    else cleanup = await renderHome(tk);
  } catch (e) { console.error(e); view.innerHTML = `<div class="empty" style="padding-top:140px"><b style="color:var(--bad)">Something went wrong</b><span>${esc(e.message)}</span><a class="btn" href="#/home">Home</a></div>`; }
  if (tk !== token) { cleanup?.(); cleanup = null; }
  updateRail(page);
}
addEventListener('hashchange', route);
addEventListener('resize', () => updateRail((location.hash.replace(/^#\/?/, '') || 'home').split('/')[0]));
document.fonts?.ready.then(() => updateRail((location.hash.replace(/^#\/?/, '') || 'home').split('/')[0]));
route();
