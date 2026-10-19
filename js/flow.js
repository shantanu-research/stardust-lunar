/* Lunar-dust flow field for the mode screen.
   Thousands of particles ride a slowly evolving curl-noise current (divergence-free, so it swirls rather than
   pools). Each frame they are drawn as short line segments into a feedback buffer that fades a little, so their
   paths accumulate into silk-like filaments. The field bends around the hovered card, is stirred by a lagging
   cursor, and gathers toward a selected card before sweeping outward. Monochrome, rendered behind the UI. */
import { governor } from './gl.js';

const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ── tiny 3D value noise (x, y, time) used to build a stream function ──
const P = new Uint8Array(512); { const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) P[i] = p[i & 255]; }
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;
const h = (x, y, z) => P[P[P[x & 255] + (y & 255)] + (z & 255)] / 255;
function noise3(x, y, z) {
  const X = Math.floor(x), Y = Math.floor(y), Z = Math.floor(z), u = fade(x - X), v = fade(y - Y), w = fade(z - Z);
  return lerp(lerp(lerp(h(X, Y, Z), h(X + 1, Y, Z), u), lerp(h(X, Y + 1, Z), h(X + 1, Y + 1, Z), u), v),
              lerp(lerp(h(X, Y, Z + 1), h(X + 1, Y, Z + 1), u), lerp(h(X, Y + 1, Z + 1), h(X + 1, Y + 1, Z + 1), u), v), w);
}

const VS_LINE = 'attribute vec2 p;attribute float a;uniform vec2 res;varying float va;void main(){va=a;vec2 c=p/res*2.-1.;gl_Position=vec4(c.x,-c.y,0.,1.);}';
const FS_LINE = 'precision mediump float;varying float va;void main(){gl_FragColor=vec4(va,va,va,va);}';
const VS_QUAD = 'attribute vec2 q;varying vec2 uv;void main(){uv=q*.5+.5;gl_Position=vec4(q,0.,1.);}';
const FS_FADE = 'precision mediump float;uniform sampler2D t;uniform float k;varying vec2 uv;void main(){gl_FragColor=max(texture2D(t,uv)*k-vec4(.7/255.),0.);}';
const FS_SHOW = 'precision mediump float;uniform sampler2D t;uniform float gain;varying vec2 uv;void main(){vec3 c=texture2D(t,uv).rgb;c=1.-exp(-c*gain);float l=max(c.r,max(c.g,c.b));gl_FragColor=vec4(c*vec3(.94,.95,1.),l);}';

function program(gl, vs, fs) {
  const mk = (t, s) => { const o = gl.createShader(t); gl.shaderSource(o, s); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(o)); return o; };
  const pr = gl.createProgram(); gl.attachShader(pr, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(pr);
  if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error('link'); return pr;
}

export function startFlow(host, selector) {
  const canvas = document.createElement('canvas'); canvas.className = 'flow'; canvas.setAttribute('aria-hidden', 'true'); document.body.append(canvas);
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'high-performance' });
  if (!gl) { canvas.remove(); return () => {}; }
  let pLine, pFade, pShow;
  try { pLine = program(gl, VS_LINE, FS_LINE); pFade = program(gl, VS_QUAD, FS_FADE); pShow = program(gl, VS_QUAD, FS_SHOW); } catch (e) { console.warn(e); canvas.remove(); return () => {}; }

  const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const lineBuf = gl.createBuffer();
  const U = (pr, n) => gl.getUniformLocation(pr, n);

  // ── sizing, feedback targets ──
  let W = 0, H = 0, scale = Math.min(devicePixelRatio || 1, 1.5), q = 1, fbo = [], tex = [], ping = 0;
  function target(w, h) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); return [f, t];
  }
  function resize() {
    W = innerWidth; H = innerHeight;
    const s = scale * q; canvas.width = Math.round(W * s); canvas.height = Math.round(H * s);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    fbo.forEach(f => gl.deleteFramebuffer(f)); tex.forEach(t => gl.deleteTexture(t));
    const a = target(canvas.width, canvas.height), b = target(canvas.width, canvas.height); fbo = [a[0], b[0]]; tex = [a[1], b[1]];
    seed();
  }

  // ── particles ──
  const MAX = 16000;
  const px = new Float32Array(MAX), py = new Float32Array(MAX), ox = new Float32Array(MAX), oy = new Float32Array(MAX), life = new Float32Array(MAX), span = new Float32Array(MAX), lum = new Float32Array(MAX), lay = new Float32Array(MAX);
  const verts = new Float32Array(MAX * 6);
  let N = 0;
  const spawn = (i) => { px[i] = ox[i] = Math.random() * W; py[i] = oy[i] = Math.random() * H; span[i] = 5 + Math.random() * 9; life[i] = Math.random() * span[i]; lum[i] = .35 + Math.pow(Math.random(), 3) * .65; lay[i] = Math.random() < .7 ? 1 : .55; };
  function seed() { N = Math.min(MAX, Math.round(W * H / 95 * q)); for (let i = 0; i < N; i++) spawn(i); }

  // ── flow grid: stream function ψ(x, y, t) sampled on a coarse grid, curl taken by finite differences ──
  const CELL = 24; let gw = 0, gh = 0, psi = new Float32Array(0), vx = new Float32Array(0), vy = new Float32Array(0);
  function field(t) {
    gw = Math.ceil(W / CELL) + 2; gh = Math.ceil(H / CELL) + 2;
    if (psi.length !== gw * gh) { psi = new Float32Array(gw * gh); vx = new Float32Array(gw * gh); vy = new Float32Array(gw * gh); }
    const s1 = CELL / 520, s2 = CELL / 150, z1 = t * .035, z2 = t * .08;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) psi[j * gw + i] = noise3(i * s1, j * s1, z1) + .16 * noise3(i * s2 + 40, j * s2, z2);
    for (let j = 1; j < gh - 1; j++) for (let i = 1; i < gw - 1; i++) {
      const k = j * gw + i;
      vx[k] = (psi[k + gw] - psi[k - gw]) * 1.0;   //  ∂ψ/∂y
      vy[k] = -(psi[k + 1] - psi[k - 1]) * 1.0;    // -∂ψ/∂x
    }
  }
  const sample = (x, y, out) => {
    const fx = Math.min(gw - 2.001, Math.max(1, x / CELL + 1)), fy = Math.min(gh - 2.001, Math.max(1, y / CELL + 1));
    const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, k = j * gw + i;
    out[0] = lerp(lerp(vx[k], vx[k + 1], u), lerp(vx[k + gw], vx[k + gw + 1], u), v);
    out[1] = lerp(lerp(vy[k], vy[k + 1], u), lerp(vy[k + gw], vy[k + gw + 1], u), v);
  };

  // ── interaction state ──
  const mouse = { x: -1e4, y: -1e4, tx: -1e4, ty: -1e4, vx: 0, vy: 0 };
  let hover = null, hoverAmt = 0, gather = null; // gather: { x, y, t0 }
  const onMove = (e) => { mouse.tx = e.clientX; mouse.ty = e.clientY; };
  const onLeaveWin = () => { mouse.tx = mouse.ty = -1e4; };
  const over = (e) => { const c = e.target.closest?.(selector); if (c && host.contains(c)) hover = c; };
  const out = (e) => { const c = e.target.closest?.(selector); if (c && c === hover && !c.contains(e.relatedTarget)) hover = null; };
  const click = (e) => { const c = e.target.closest?.(selector); if (!c || !host.contains(c)) return; const r = c.getBoundingClientRect(); gather = { x: r.left + r.width / 2, y: r.top + r.height / 2, t0: performance.now() }; };
  addEventListener('pointermove', onMove, { passive: true }); document.addEventListener('pointerleave', onLeaveWin);
  host.addEventListener('pointerover', over); host.addEventListener('pointerout', out); host.addEventListener('focusin', over); host.addEventListener('click', click, true);

  // ── frame ──
  const v = [0, 0]; let raf = 0, alive = true, last = 0;
  const t0 = performance.now();
  const gov = governor((nq) => { q = Math.max(.5, nq); resize(); }, { min: .5, target: 22 });

  function step(dt, now) {
    const t = (now - t0) / 1000;
    field(t);
    // lagging cursor: a soft vortex that trails the pointer
    const lx = mouse.x, ly = mouse.y;
    mouse.x += (mouse.tx - mouse.x) * .055; mouse.y += (mouse.ty - mouse.y) * .055;
    mouse.vx = mouse.x - lx; mouse.vy = mouse.y - ly;
    const mSpeed = Math.min(1, Math.hypot(mouse.vx, mouse.vy) / 18);
    // hovered card as a rounded rectangle the flow bends around
    hoverAmt += ((hover ? 1 : 0) - hoverAmt) * .05;
    let hr = null; if (hover && hover.isConnected) { const r = hover.getBoundingClientRect(); hr = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, hw: r.width / 2 + 10, hh: r.height / 2 + 10 }; }
    let g = 0, gx = 0, gy = 0; if (gather) { const e = (now - gather.t0) / 1000; if (e > 1.6) gather = null; else { g = e < .55 ? -1 : 1; gx = gather.x; gy = gather.y; g *= Math.sin(Math.min(1, e < .55 ? e / .55 : (e - .55) / 1.05) * Math.PI); } }
    const base = 62 * dt, n = N;
    for (let i = 0; i < n; i++) {
      let x = px[i], y = py[i];
      ox[i] = x; oy[i] = y;
      sample(x, y, v);
      let ux = v[0] * base * 52 * lay[i], uy = v[1] * base * 52 * lay[i];
      // gentle global drift so the field never stalls
      ux += .18 * base; uy -= .06 * base;
      if (hr && hoverAmt > .01) {
        const dx = x - hr.cx, dy = y - hr.cy, qx = Math.abs(dx) - hr.hw, qy = Math.abs(dy) - hr.hh;
        const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
        if (d < 150) {
          const len = Math.hypot(dx, dy) || 1, nx = dx / len, ny = dy / len, f = Math.exp(-Math.max(d, 0) / 55) * hoverAmt;
          ux += (nx * 1.6 - ny * 2.2) * f * base; uy += (ny * 1.6 + nx * 2.2) * f * base;
        }
      }
      if (mouse.x > -1e3) {
        const dx = x - mouse.x, dy = y - mouse.y, d2 = dx * dx + dy * dy;
        if (d2 < 48000) { const f = Math.exp(-d2 / 14000) * (.6 + 2.4 * mSpeed); ux += (-dy * .012 + mouse.vx * .25) * f * base; uy += (dx * .012 + mouse.vy * .25) * f * base; }
      }
      if (g) { const dx = gx - x, dy = gy - y, d = Math.hypot(dx, dy) || 1, f = Math.min(1, 380 / d) * g * 3.2 * base; ux -= dx / d * f; uy -= dy / d * f; }
      x += ux; y += uy;
      life[i] += dt;
      if (life[i] > span[i] || x < -20 || x > W + 20 || y < -20 || y > H + 20) { spawn(i); life[i] = 0; continue; }
      px[i] = x; py[i] = y;
    }
  }

  function render(dt = 1 / 60) {
    const cw = canvas.width, ch = canvas.height, sx = cw / W, sy = ch / H;
    // 1. fade the previous trails into the other buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[1 - ping]); gl.viewport(0, 0, cw, ch);
    gl.disable(gl.BLEND); gl.useProgram(pFade);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[ping]); gl.uniform1i(U(pFade, 't'), 0); gl.uniform1f(U(pFade, 'k'), Math.pow(.991, dt * 60));
    gl.bindBuffer(gl.ARRAY_BUFFER, quad); let a = gl.getAttribLocation(pFade, 'q'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.disableVertexAttribArray(a);
    // 2. add this frame's segments
    let k = 0;
    for (let i = 0; i < N; i++) {
      const lf = life[i] / span[i], env = Math.min(1, lf * 6) * Math.min(1, (1 - lf) * 4), al = lum[i] * env * .12 * lay[i];
      if (al < .004) continue;
      verts[k++] = ox[i] * sx; verts[k++] = oy[i] * sy; verts[k++] = al; verts[k++] = px[i] * sx; verts[k++] = py[i] * sy; verts[k++] = al;
    }
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE); gl.useProgram(pLine);
    gl.uniform2f(U(pLine, 'res'), cw, ch);
    gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf); gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, k), gl.DYNAMIC_DRAW);
    const ap = gl.getAttribLocation(pLine, 'p'), aa = gl.getAttribLocation(pLine, 'a');
    gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(aa); gl.vertexAttribPointer(aa, 1, gl.FLOAT, false, 12, 8);
    gl.drawArrays(gl.LINES, 0, k / 3); gl.disableVertexAttribArray(ap); gl.disableVertexAttribArray(aa);
    ping = 1 - ping;
    // 3. present
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);
    gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(pShow); gl.bindTexture(gl.TEXTURE_2D, tex[ping]); gl.uniform1i(U(pShow, 't'), 0); gl.uniform1f(U(pShow, 'gain'), 1.8);
    gl.bindBuffer(gl.ARRAY_BUFFER, quad); a = gl.getAttribLocation(pShow, 'q'); gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.disableVertexAttribArray(a);
  }

  function frame(now) {
    raf = 0; if (!alive) return;
    if (document.hidden) return;
    const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60; last = now;
    gov.tick(now); step(dt, now); render(dt);
    raf = requestAnimationFrame(frame);
  }

  resize();
  if (reduce()) {
    // Reduced motion: let the field settle off-screen, then show one still frame of filaments.
    for (let s = 0; s < 90; s++) { step(1 / 60, t0 + s * 16); render(); }
  } else raf = requestAnimationFrame(frame);
  canvas.classList.add('on');

  const onResize = () => { resize(); if (reduce()) { for (let s = 0; s < 90; s++) { step(1 / 60, performance.now() + s * 16); render(); } } };
  const onVis = () => { last = 0; gov.reset(); if (!document.hidden && !raf && alive && !reduce()) raf = requestAnimationFrame(frame); };
  addEventListener('resize', onResize); document.addEventListener('visibilitychange', onVis);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); alive = false; cancelAnimationFrame(raf); canvas.remove(); });

  return () => {
    alive = false; cancelAnimationFrame(raf);
    removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVis);
    removeEventListener('pointermove', onMove); document.removeEventListener('pointerleave', onLeaveWin);
    host.removeEventListener('pointerover', over); host.removeEventListener('pointerout', out); host.removeEventListener('focusin', over); host.removeEventListener('click', click, true);
    canvas.classList.remove('on'); setTimeout(() => { const ext = gl.getExtension('WEBGL_lose_context'); ext && ext.loseContext(); canvas.remove(); }, 700);
  };
}
