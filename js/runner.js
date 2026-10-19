/* Worker management, sample generation and the project analysis pipeline. */
import { grayToCanvas, canvasToBlob, makeThumb, decodeImage, uid } from './lib.js';
import { Store } from './store.js';
import { modeById, sensorById } from './modes.js';

const Engine = () => window.StardustEngine;

// ───────── worker ─────────
let worker = null, jobId = 0, pending = new Map();
function ensure() {
  if (worker) return worker;
  worker = new Worker('js/engine.js');
  worker.onmessage = (e) => {
    const { id, type } = e.data, job = pending.get(id); if (!job) return;
    if (type === 'progress') job.onProgress?.(e.data);
    else { pending.delete(id); type === 'error' ? job.reject(new Error(e.data.message)) : job.resolve(e.data.result); }
  };
  worker.onerror = (err) => { for (const j of pending.values()) j.reject(new Error(err.message || 'Worker error')); pending.clear(); worker = null; };
  return worker;
}
export const Runner = {
  run(type, payload, onProgress) {
    const id = ++jobId, w = ensure();
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, onProgress }); w.postMessage({ id, type, payload }); });
  },
  cancel() { if (worker) { worker.terminate(); worker = null; } for (const j of pending.values()) j.reject(new Error('Cancelled')); pending.clear(); }
};

// ───────── pixel cache (decoded luma for each project image) ─────────
const pixelCache = new Map();
export async function pixels(project, role) {
  const key = project.id + role + (project[role].version || 0);
  if (!pixelCache.has(key)) pixelCache.set(key, decodeImage(project[role].blob));
  return pixelCache.get(key);
}
export function dropPixels(project) { for (const k of [...pixelCache.keys()]) if (k.startsWith(project.id)) pixelCache.delete(k); }

// ───────── sample imagery (real LRO WAC terrain, synthetic *view* with a known transform) ─────────
const sampleCache = new Map();
async function wacSample() {
  if (!sampleCache.has('wac')) sampleCache.set('wac', (async () => {
    const blob = await (await fetch('assets/lro-wac-sample.jpg')).blob(), d = await decodeImage(blob);
    return { w: d.w, h: d.h, data: d.gray };
  })());
  return sampleCache.get('wac');
}
function down(img, f) {
  const w = Math.floor(img.w / f), h = Math.floor(img.h / f), o = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let a = 0; a < f; a++) for (let b = 0; b < f; b++) s += img.data[(y * f + a) * img.w + x * f + b]; o[y * w + x] = s / (f * f); }
  return { w, h, data: o };
}
function soften(img) {
  const { w, h, data } = img, o = new Uint8ClampedArray(data.length);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += data[(y + dy) * w + x + dx]; o[y * w + x] = s / 9; }
  return { w, h, data: o };
}
async function toRecord(img, name, sensor, gsd, note) {
  const blob = await canvasToBlob(grayToCanvas(img.data, img.w, img.h));
  return { name, blob, w: img.w, h: img.h, sensor, gsd, note, sample: true, version: 0 };
}
/** kind: basic | sun | inverted | scale. Returns {src, ref, truth}. */
export async function makeSample(kind) {
  const full = await wacSample(), E = Engine();
  const base = { basic: { seed: 11, scale: 0.85, rotation: -22, ramp: 0.3, gamma: 1.2, noise: 4 }, sun: { seed: 23, scale: 0.95, rotation: 14, ramp: 0.85, gamma: 1.9, noise: 6 }, inverted: { seed: 9, scale: 0.9, rotation: -30, ramp: 0.2, gamma: 1.1, noise: 4 }, scale: { seed: 5, scale: 1, rotation: 18, ramp: 0.3, gamma: 1.2, noise: 3, sizeScale: 1 } }[kind] || {};
  const syn = E.synthesize(full, base);
  let moving = syn.img, ref = full, H = syn.H, srcGsd = 1, refGsd = 1, srcS = 'Other', refS = 'Other', note = 'Real LRO WAC terrain; the moving view is synthesised with a known transform and illumination change.';
  if (kind === 'inverted') { moving = soften({ w: moving.w, h: moving.h, data: moving.data.map(v => 255 - v) }); note = 'Contrast-reversed and softened moving view of real LRO WAC terrain (cross-modal stand-in).'; }
  if (kind === 'scale') { ref = down(full, 4); H = H.map(v => v / 4); srcGsd = 1; refGsd = 4; note = 'Fine moving view against a 4× coarser reference — the OHRC-vs-TMC-2 situation in miniature.'; }
  const src = await toRecord(moving, `sample-${kind}-moving.png`, srcS, srcGsd, note), rr = await toRecord(ref, `sample-${kind}-reference.png`, refS, refGsd, note);
  return { src, ref: rr, truth: { H, note: 'Known synthetic transform (moving → reference)', params: syn.params } };
}

// ───────── projects ─────────
export function newProject({ name, mode, sensors }) {
  return { id: uid(), name: name || 'Untitled project', mode, sensors, created: Date.now(), updated: Date.now(), status: 'draft', src: null, ref: null, params: {}, result: null, regBlob: null, thumb: null, truth: null };
}

export function buildCfg(project) {
  const mode = modeById(project.mode), p = project.params || {}, E = Engine();
  const cfg = Object.assign({}, E.DEFAULTS, mode.cfg);
  for (const k of ['model', 'pre', 'ratio', 'thr', 'maxKp', 'workRes', 'grid', 'cap', 'sweep', 'mutual', 'sens']) if (p[k] != null) cfg[k] = p[k];
  const sg = project.src?.gsd || 0, rg = project.ref?.gsd || 0;
  cfg.scalePrior = p.scalePrior != null ? p.scalePrior : E.sensorPrior(sg, rg);
  return cfg;
}

export const Jobs = {
  state: { projectId: null, running: false, stage: '', pct: 0, msg: '', log: [], started: 0 },
  listeners: new Set(),
  emit() { for (const l of this.listeners) l(this.state); },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  reset(projectId) { Object.assign(this.state, { projectId, running: true, stage: 'normalize', pct: 0, msg: 'Starting', log: [], started: Date.now() }); this.emit(); },
  progress(p) { const s = this.state; s.stage = p.stage; s.pct = p.pct; s.msg = p.msg; const last = s.log[s.log.length - 1]; if (!last || last.msg !== p.msg) s.log.push({ t: (Date.now() - s.started) / 1000, msg: p.msg }); this.emit(); },
  finish() { this.state.running = false; this.state.pct = 1; this.emit(); }
};

function pack(res) {
  return {
    metrics: res.metrics, H: res.H, decomposed: res.decomposed, cfg: res.cfg, tried: res.tried, sizes: res.sizes, timings: res.timings,
    matches: res.matches, selectedFlags: res.selectedFlags, dist: res.dist, preview: res.preview || null, ranAt: Date.now()
  };
}
async function adopt(project, res) {
  project.result = pack(res); project.error = null;
  if (res.warp) {
    const c = grayToCanvas(res.warp.data, res.warp.w, res.warp.h, res.warp.mask);
    project.regBlob = await canvasToBlob(c); project.regInfo = { w: res.warp.w, h: res.warp.h, scale: res.warp.scale };
    const ref = await pixels(project, 'ref'); // thumbnail = the registered view over the reference
    const base = grayToCanvas(ref.gray, ref.w, ref.h), g = base.getContext('2d'); g.globalAlpha = 0.85; g.drawImage(c, 0, 0, ref.w, ref.h);
    project.thumb = await makeThumb(base);
  }
  project.status = 'completed';
}

/** Run the registration for a project. Mutates + saves it. Throws on cancel. */
export async function analyse(project, { benchmark = false } = {}) {
  const [s, r] = await Promise.all([pixels(project, 'src'), pixels(project, 'ref')]);
  const cfg = buildCfg(project);
  project.status = 'processing'; await Store.put(project); Jobs.reset(project.id);
  try {
    const payload = { src: { w: s.w, h: s.h, data: s.gray }, ref: { w: r.w, h: r.h, data: r.gray }, cfg, warpMax: 2400 };
    if (benchmark) {
      const res = await Runner.run('benchmark', payload, (p) => Jobs.progress(p));
      project.benchmark = { rows: res.rows.map(x => ({ pre: x.pre, model: x.model, ok: x.ok, metrics: x.metrics, seconds: x.seconds })), bestKey: res.bestKey, ranAt: Date.now() };
      if (res.best?.ok) { await adopt(project, res.best); project.params = Object.assign({}, project.params, { pre: res.best.cfg.pre, model: res.best.cfg.model }); }
      else { project.status = 'failed'; project.error = 'No configuration produced a verified registration.'; }
    } else {
      const res = await Runner.run('register', payload, (p) => Jobs.progress(p));
      if (res.ok) await adopt(project, res); else { project.status = 'failed'; project.error = res.reason; project.result = null; }
    }
  } catch (e) {
    project.status = project.result ? 'completed' : 'draft'; await Store.put(project); Jobs.finish(); throw e;
  }
  await Store.put(project); Jobs.finish(); return project;
}

export async function groundTruthTest(project, onProgress) {
  const ref = await pixels(project, 'ref'), cfg = buildCfg(project);
  return Runner.run('selftest', { ref: { w: ref.w, h: ref.h, data: ref.gray }, cfg }, onProgress);
}
