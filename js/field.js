/* Lunar-dust field behind the mode selector — GPU version.
   Particle state (position, age, seed) lives in float textures and is advanced entirely on the GPU each frame
   (ping-pong). Motion comes from a divergence-free curl-noise field built from three noise scales: broad sweeping
   currents, mid curls and fine turbulence. Every frame each particle is drawn as a segment from its previous to its
   current position into a half-float trail buffer that fades with time, so paths accumulate into fine filaments.
   Two depth layers (sharp foreground, faint slower background), a lagging cursor with a wake, a hovered card the
   flow bends around and brightens near, and a gather/sweep on selection. The canvas persists across visits.
   Falls back to the CPU version (flow.js) when WebGL2 float render targets are unavailable. */
import { governor } from './gl.js';
import { startCpuFlow } from './flow.js';

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const WAKE = 8;

const NOISE = `
float h13(vec3 p){ p = fract(p * .1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float n3(vec3 x){ vec3 i = floor(x), f = fract(x); f = f * f * f * (f * (f * 6. - 15.) + 10.);
  return mix(mix(mix(h13(i), h13(i + vec3(1,0,0)), f.x), mix(h13(i + vec3(0,1,0)), h13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h13(i + vec3(0,0,1)), h13(i + vec3(1,0,1)), f.x), mix(h13(i + vec3(0,1,1)), h13(i + vec3(1,1,1)), f.x), f.y), f.z); }`;

// ── simulation: one fragment per particle ──
const SIM = `#version 300 es
precision highp float;
uniform sampler2D uState; uniform vec2 uRes; uniform float uTime, uDt;
uniform vec4 uMouse; uniform vec2 uWake[${WAKE}]; uniform float uWakeAmt;
uniform vec4 uHover; uniform float uHoverAmt; uniform vec3 uGather;
out vec4 o;
${NOISE}
float psi(vec2 p, float t){ return n3(vec3(p * .0019, t * .035)) + .26 * n3(vec3(p * .0066 + 40., t * .085)) + .07 * n3(vec3(p * .019 + 90., t * .16)); }
vec2 curl(vec2 p, float t){ float e = 4.; return vec2(psi(p + vec2(0, e), t) - psi(p - vec2(0, e), t), -(psi(p + vec2(e, 0), t) - psi(p - vec2(e, 0), t))) / (2. * e); }
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec4 s = texelFetch(uState, ivec2(gl_FragCoord.xy), 0);
  vec2 p = s.xy; float age = s.z, seed = s.w;
  float bg = step(.32, fract(seed * 7.131));                 // 0 = foreground, 1 = background layer
  vec2 v = curl(p, uTime) * mix(100000., 64000., bg) + vec2(9., -3.5);
  // hovered card: streams bend around it (normal + tangential), fading with distance
  if (uHoverAmt > .01) {
    vec2 d = p - uHover.xy, q = abs(d) - uHover.zw;
    float sd = length(max(q, 0.)) + min(max(q.x, q.y), 0.);
    if (sd < 180.) { vec2 n = normalize(d + 1e-4); float f = exp(-max(sd, 0.) / 60.) * uHoverAmt; v += (n * 55. + vec2(-n.y, n.x) * 85.) * f; }
  }
  // cursor: Gaussian-falloff swirl plus a share of its velocity
  if (uMouse.x > -1000.) {
    vec2 d = p - uMouse.xy; float f = exp(-dot(d, d) / (2. * 115. * 115.));
    v += (vec2(-d.y, d.x) * .35 + uMouse.zw * .32) * f;
  }
  // wake: small vortices along the cursor's recent path, weaker the older they are
  for (int k = 0; k < ${WAKE}; k++) {
    vec2 d = p - uWake[k]; float f = exp(-dot(d, d) / (2. * 70. * 70.)) * (1. - float(k) / ${WAKE}.) * uWakeAmt;
    v += vec2(-d.y, d.x) * .45 * f;
  }
  // selection: converge (g < 0) then sweep outward (g > 0)
  if (uGather.z != 0.) { vec2 d = p - uGather.xy; float l = max(length(d), 1.); v += d / l * uGather.z * 240. * min(1., 420. / l); }
  p += v * uDt; age += uDt;
  float span = 7. + fract(seed * 13.7) * 11.;
  if (age > span || p.x < -30. || p.y < -30. || p.x > uRes.x + 30. || p.y > uRes.y + 30.) {
    seed = fract(seed + .6180339);
    p = vec2(hash(vec2(seed, uTime)), hash(vec2(uTime, seed * 3.7))) * uRes; age = 0.;
  }
  o = vec4(p, age, seed);
}`;

// ── segments: vertex 2i reads the previous state, 2i+1 the current one ──
const SEG_VS = `#version 300 es
uniform sampler2D uPrev, uCur; uniform int uSide; uniform vec2 uRes;
out float vA;
void main(){
  int id = gl_VertexID >> 1, end = gl_VertexID & 1;
  ivec2 ij = ivec2(id % uSide, id / uSide);
  vec4 a = texelFetch(uPrev, ij, 0), b = texelFetch(uCur, ij, 0);
  vec4 s = end == 0 ? a : b;
  float span = 7. + fract(b.w * 13.7) * 11., lf = b.z / span;
  float env = clamp(lf * 6., 0., 1.) * clamp((1. - lf) * 4., 0., 1.);
  float bg = step(.32, fract(b.w * 7.131));
  float lum = .35 + pow(fract(b.w * 91.7), 3.) * .65;
  float jump = step(60., distance(a.xy, b.xy)) + step(.5, a.z - b.z);  // respawned this frame: draw nothing
  vA = lum * env * mix(.085, .026, bg) * (1. - clamp(jump, 0., 1.));
  vec2 c = s.xy / uRes * 2. - 1.; gl_Position = vec4(c.x, -c.y, 0., 1.);
}`;
const SEG_FS = `#version 300 es
precision mediump float; in float vA; out vec4 o; void main(){ o = vec4(vA); }`;

const QUAD_VS = `#version 300 es
layout(location = 0) in vec2 q; out vec2 uv; void main(){ uv = q * .5 + .5; gl_Position = vec4(q, 0., 1.); }`;
const FADE_FS = `#version 300 es
precision mediump float; uniform sampler2D uT; uniform float uK; in vec2 uv; out vec4 o; void main(){ o = texture(uT, uv) * uK; }`;
// present: tone-map to neutral white over pure black; quieter behind every card, a little brighter round the hovered one
const SHOW_FS = `#version 300 es
precision highp float; uniform sampler2D uT; uniform vec2 uRes; uniform float uGain;
uniform vec4 uCards[8]; uniform int uNCards; uniform vec4 uHover; uniform float uHoverAmt;
in vec2 uv; out vec4 o;
float sdb(vec2 p, vec4 r){ vec2 q = abs(p - r.xy) - r.zw; return length(max(q, 0.)) + min(max(q.x, q.y), 0.); }
void main(){
  vec2 p = vec2(uv.x, 1. - uv.y) * uRes;
  float c = texture(uT, uv).r, m = 1.;
  for (int i = 0; i < 8; i++) { if (i >= uNCards) break; m = min(m, mix(.32, 1., smoothstep(-6., 26., sdb(p, uCards[i])))); }
  if (uHoverAmt > .01) { float d = sdb(p, uHover); m += uHoverAmt * .45 * exp(-max(d, 0.) / 70.) * step(0., d); }
  float l = 1. - exp(-c * uGain * m);
  o = vec4(vec3(l), l);
}`;

let inst = null;

function create() {
  const canvas = document.createElement('canvas'); canvas.className = 'flow'; canvas.setAttribute('aria-hidden', 'true');
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, powerPreference: 'high-performance' });
  if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
  const prog = (vs, fs) => {
    const mk = (t, src) => { const o = gl.createShader(t); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; return { p, u: (n) => (n in u ? u[n] : (u[n] = gl.getUniformLocation(p, n))) };
  };
  let sim, seg, fade, show;
  try { sim = prog(QUAD_VS, SIM); seg = prog(SEG_VS, SEG_FS); fade = prog(QUAD_VS, FADE_FS); show = prog(QUAD_VS, SHOW_FS); } catch (e) { console.warn('[field]', e); return null; }

  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const qb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, qb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const emptyVao = gl.createVertexArray();

  const tex = (w, h, ifmt, fmt, type, filter, data = null) => {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  };
  const free = (x) => { if (x) { gl.deleteTexture(x.t); gl.deleteFramebuffer(x.f); } };

  // particle state: SIDE×SIDE particles (≈37k, or ≈50k on large high-DPR screens)
  const SIDE = (screen.width * (devicePixelRatio || 1) > 2400) ? 224 : 192;
  let W = 0, H = 0, state = [], trail = [], sp = 0, tp = 0, q = 1, drawFrac = 1;
  function seedState() {
    const n = SIDE * SIDE, d = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { const s = Math.random(); d[i * 4] = Math.random() * W; d[i * 4 + 1] = Math.random() * H; d[i * 4 + 2] = Math.random() * 12; d[i * 4 + 3] = s; }
    state.forEach(free); state = [0, 1].map(() => tex(SIDE, SIDE, gl.RGBA32F, gl.RGBA, gl.FLOAT, gl.NEAREST, d));
  }
  function sizeTrail() {
    const wasEmpty = W < 2 || H < 2;
    W = Math.max(1, innerWidth); H = Math.max(1, innerHeight);
    const dpr = Math.min(devicePixelRatio || 1, 1.5), s = Math.max(.5, .8 * q) * dpr;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    trail.forEach(free); trail = [0, 1].map(() => { const t = tex(Math.max(1, Math.round(W * s)), Math.max(1, Math.round(H * s)), gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); return t; });
    if (wasEmpty && W > 1 && state.length) seedState();
  }
  sizeTrail(); seedState();

  // interaction state (CSS px)
  const mouse = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, vx: 0, vy: 0 }, wake = new Float32Array(WAKE * 2).fill(-1e4);
  let wakeAmt = 0, wakeClock = 0, host = null, sel = '', hover = null, hoverAmt = 0, gather = null, cards = new Float32Array(32), nCards = 0;
  const hoverRect = [0, 0, 0, 0];

  const onMove = (e) => { mouse.tx = e.clientX; mouse.ty = e.clientY; };
  const onOut = (e) => { if (!e.relatedTarget) mouse.tx = mouse.ty = -1e4; };
  const over = (e) => { const c = e.target.closest?.(sel); if (c && host?.contains(c)) hover = c; };
  const out = (e) => { const c = e.target.closest?.(sel); if (c && c === hover && !c.contains(e.relatedTarget)) hover = null; };
  const click = (e) => { const c = e.target.closest?.(sel); if (!c || !host?.contains(c)) return; const r = c.getBoundingClientRect(); gather = { x: r.left + r.width / 2, y: r.top + r.height / 2, t0: performance.now() }; };

  const t0 = performance.now(); let raf = 0, last = 0, running = false, dead = false;
  const gov = governor((nq) => { q = nq; drawFrac = Math.max(.45, nq); sizeTrail(); }, { min: .5, target: 22 });

  function readCards() {
    nCards = 0; if (!host) return;
    const head = document.querySelector('.modes-head h1'); if (head) { const r = head.getBoundingClientRect(); cards.set([r.left + r.width / 2, r.top + r.height / 2 + 30, r.width / 2 + 10, r.height / 2 + 40], 0); nCards = 1; }
    host.querySelectorAll(sel).forEach((c) => { if (nCards >= 8) return; const r = c.getBoundingClientRect(); cards.set([r.left + r.width / 2, r.top + r.height / 2, r.width / 2, r.height / 2], nCards * 4); nCards++; });
  }

  function simulate(dt, now) {
    const t = (now - t0) / 1000;
    // damped cursor with inertia; its velocity (px/s) also feeds the flow
    const lx = mouse.x, ly = mouse.y, k = 1 - Math.pow(1 - .06, dt * 60);
    if (mouse.tx > -1e3 && mouse.x < -1e3) { mouse.x = mouse.tx; mouse.y = mouse.ty; }
    mouse.x += (mouse.tx - mouse.x) * k; mouse.y += (mouse.ty - mouse.y) * k;
    mouse.vx = (mouse.x - lx) / Math.max(dt, 1e-3); mouse.vy = (mouse.y - ly) / Math.max(dt, 1e-3);
    if (mouse.tx < -1e3) { mouse.x = mouse.y = -1e4; mouse.vx = mouse.vy = 0; }
    const speed = Math.hypot(mouse.vx, mouse.vy);
    wakeAmt += ((mouse.x > -1e3 ? Math.min(1, speed / 600) : 0) - wakeAmt) * Math.min(1, dt * 3);
    wakeClock += dt; if (wakeClock > .06) { wakeClock = 0; wake.copyWithin(2, 0, WAKE * 2 - 2); wake[0] = mouse.x; wake[1] = mouse.y; }
    hoverAmt += ((hover && hover.isConnected ? 1 : 0) - hoverAmt) * Math.min(1, dt * 3.2);
    if (hover && hover.isConnected) { const r = hover.getBoundingClientRect(); hoverRect[0] = r.left + r.width / 2; hoverRect[1] = r.top + r.height / 2; hoverRect[2] = r.width / 2 + 8; hoverRect[3] = r.height / 2 + 8; }
    let g = 0;
    if (gather) { const e = (now - gather.t0) / 1000; if (e > 1.7) gather = null; else g = e < .6 ? -Math.sin(e / .6 * Math.PI) : Math.sin(Math.min(1, (e - .6) / 1.1) * Math.PI) * .9; }

    gl.bindVertexArray(vao); gl.disable(gl.BLEND);
    const src = state[sp], dst = state[1 - sp];
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.f); gl.viewport(0, 0, SIDE, SIDE);
    gl.useProgram(sim.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.t); gl.uniform1i(sim.u('uState'), 0);
    gl.uniform2f(sim.u('uRes'), W, H); gl.uniform1f(sim.u('uTime'), t); gl.uniform1f(sim.u('uDt'), dt);
    gl.uniform4f(sim.u('uMouse'), mouse.x, mouse.y, mouse.vx, mouse.vy);
    gl.uniform2fv(sim.u('uWake'), wake); gl.uniform1f(sim.u('uWakeAmt'), wakeAmt);
    gl.uniform4f(sim.u('uHover'), hoverRect[0], hoverRect[1], hoverRect[2], hoverRect[3]); gl.uniform1f(sim.u('uHoverAmt'), hoverAmt);
    gl.uniform3f(sim.u('uGather'), gather ? gather.x : 0, gather ? gather.y : 0, g);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    sp = 1 - sp;
  }

  function drawTrails(dt) {
    const a = trail[tp], b = trail[1 - tp];
    // fade the accumulated trails (frame-rate independent)
    gl.bindVertexArray(vao); gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.f); gl.viewport(0, 0, b.w, b.h);
    gl.useProgram(fade.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, a.t); gl.uniform1i(fade.u('uT'), 0);
    gl.uniform1f(fade.u('uK'), Math.pow(.9915, dt * 60));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // add this frame's segments (previous → current position)
    gl.bindVertexArray(emptyVao); gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(seg.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, state[1 - sp].t); gl.uniform1i(seg.u('uPrev'), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, state[sp].t); gl.uniform1i(seg.u('uCur'), 1);
    gl.uniform1i(seg.u('uSide'), SIDE); gl.uniform2f(seg.u('uRes'), W, H);
    gl.drawArrays(gl.LINES, 0, Math.floor(SIDE * SIDE * drawFrac) * 2);
    gl.activeTexture(gl.TEXTURE0);
    tp = 1 - tp;
  }

  function present() {
    gl.bindVertexArray(vao); gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(show.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, trail[tp].t); gl.uniform1i(show.u('uT'), 0);
    gl.uniform2f(show.u('uRes'), W, H); gl.uniform1f(show.u("uGain"), 1.35);
    gl.uniform4fv(show.u('uCards'), cards); gl.uniform1i(show.u('uNCards'), nCards);
    gl.uniform4f(show.u('uHover'), hoverRect[0], hoverRect[1], hoverRect[2] - 8, hoverRect[3] - 8); gl.uniform1f(show.u('uHoverAmt'), hoverAmt);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  function frame(now) {
    raf = 0; if (!running || dead || document.hidden) return;
    const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60; last = now;
    if (innerWidth !== W || innerHeight !== H) sizeTrail();
    gov.tick(now); readCards(); simulate(dt, now); drawTrails(dt); present();
    raf = requestAnimationFrame(frame);
  }
  function still() { readCards(); for (let i = 0; i < 150; i++) { simulate(1 / 60, t0 + i * 16.7); drawTrails(1 / 60); } present(); }

  const onResize = () => { sizeTrail(); if (reduce()) still(); };
  const onVis = () => { last = 0; gov.reset(); if (!document.hidden && running && !raf && !reduce()) raf = requestAnimationFrame(frame); };
  addEventListener('resize', onResize); document.addEventListener('visibilitychange', onVis);
  addEventListener('pointermove', onMove, { passive: true }); document.addEventListener('pointerout', onOut);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); dead = true; cancelAnimationFrame(raf); canvas.remove(); inst = null; });

  return {
    canvas,
    attach(h, s) {
      if (host) this.detachHost();
      host = h; sel = s; hover = null;
      h.addEventListener('pointerover', over); h.addEventListener('pointerout', out); h.addEventListener('focusin', over); h.addEventListener('click', click, true);
      if (!canvas.isConnected) document.body.append(canvas);
      running = true; last = 0;
      if (reduce()) still(); else if (!raf) raf = requestAnimationFrame(frame);
      requestAnimationFrame(() => canvas.classList.add('on'));
    },
    detachHost() {
      if (!host) return;
      host.removeEventListener('pointerover', over); host.removeEventListener('pointerout', out); host.removeEventListener('focusin', over); host.removeEventListener('click', click, true);
      host = null; hover = null; nCards = 0;
    },
    // Fade out but keep the simulation state, so returning to the selector continues the same field.
    pause() { this.detachHost(); canvas.classList.remove('on'); setTimeout(() => { if (!host) { running = false; cancelAnimationFrame(raf); raf = 0; } }, 900); }
  };
}

export function startFlow(host, selector) {
  if (!inst) inst = create();
  if (!inst) return startCpuFlow(host, selector);
  inst.attach(host, selector);
  const me = inst;
  return () => { if (inst === me) me.pause(); };
}
