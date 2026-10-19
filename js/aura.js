/* Flare: a WebGL corona behind the hovered card. Domain-warped smoke, noise-modulated rays and a warm core
   fading to cool tips. It glides between cards (GSAP + damping) and never clips. Decorative only. */
import { createShader, NOISE_GLSL, governor } from './gl.js';

const FRAG = `precision highp float;
uniform vec2 uRes; uniform float uTime, uGlow, uBloom, uLight, uDpr; uniform vec4 uCard; uniform vec3 uTint; uniform vec2 uMouse;
${NOISE_GLSL}
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
// A family of silky strands fanning from a point on the card edge and bending as they travel.
float strands(vec2 p, vec2 src, vec2 dir, float t, float seed, float N, float spread, float reach){
  vec2 q = p - src; float r = length(q);
  float da = atan(q.y, q.x) - atan(dir.y, dir.x); da = mod(da + 3.14159, 6.28318) - 3.14159;
  float bend = (.5 * sin(r * 1.8 - t * .1 + seed) + .16 * sin(r * 3.4 + t * .07 + seed * 2.3)) * r + .5 * r * r * sin(seed * 3. + t * .04) + uMouse.x * .25 * r;
  float x = (da + bend) * N, id = floor(x), fr = fract(x) - .5;
  float h = hash(vec2(id, seed));
  float w = mix(.07, .2, h) * (1. + r * .5);
  float line = exp(-fr * fr / (w * w)) * smoothstep(.42, .8, h);
  float cone = smoothstep(spread, 0., abs(da));
  return line * cone * exp(-r * reach) * smoothstep(.02, .22, r);
}
void main(){
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec2 rel = frag - uCard.xy;
  float R = length(uCard.zw);
  float d = sdBox(rel, uCard.zw, 20.);
  vec2 p = rel / R, hw = uCard.zw / R;
  float t = uTime;
  float k = 0.;
  k += 1.00 * strands(p, vec2(hw.x * .85, -hw.y), vec2(.1, -1.), t, 1.3, 11., .95, 1.7);
  k += .80 * strands(p, vec2(hw.x * .6, -hw.y), vec2(-.5, -1.), t, 4.7, 9., .9, 1.9);
  k += .45 * strands(p, vec2(-hw.x * .3, -hw.y), vec2(-.8, -.8), t, 7.9, 9., .8, 2.3);
  k += .55 * strands(p, vec2(-hw.x, hw.y * .7), vec2(-1., .5), t, 2.2, 9., .8, 2.2);
  k += .35 * strands(p, vec2(hw.x * .4, hw.y), vec2(.5, 1.), t, 5.5, 9., .8, 2.4);
  k *= smoothstep(-.02, .03, d / R);
  float rim = exp(-max(d, 0.) / 4.) * .42 + exp(-max(d, 0.) / 20.) * .16 + exp(-max(d, 0.) / 80.) * .08;
  float haze = smoothstep(.2, .9, fbm(p * 1.3 + vec2(0., -t * .02))) * exp(-max(d, 0.) / (R * .5)) * .12;
  float I = (k * 1.35 + rim * (.7 + .3 * uBloom) + haze) * uGlow;
  I *= mix(.08, 1., smoothstep(-24., 2., d));
  vec3 col = mix(vec3(.95, .96, 1.), uTint, .1);
  if (uLight > .5) { float a = clamp(I * .5, 0., 1.); gl_FragColor = vec4(vec3(.1, .12, .26) * a, a); return; }
  vec3 c = 1. - exp(-col * I * 1.6);
  gl_FragColor = vec4(c, clamp(max(c.r, max(c.g, c.b)), 0., 1.));
}`;

export function startAura(host, selector) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const canvas = document.createElement('canvas'); canvas.className = 'flare'; canvas.setAttribute('aria-hidden', 'true'); document.body.append(canvas);
  const sh = createShader(canvas, FRAG);
  if (!sh) { canvas.remove(); return () => {}; }
  const G = window.gsap, st = { x: 0, y: 0, hw: 100, hh: 100, glow: 0, bloom: 0 };
  const m = { x: 0, y: 0, tx: 0, ty: 0 };
  let dpr = 1, raf = 0, alive = true, target = null, t0 = performance.now(), seen = false;
  const light = () => document.documentElement.dataset.theme === 'light';
  let Q = 1;
  const gov = governor((q) => { Q = q; resize(); });
  function resize() { dpr = Math.min(devicePixelRatio || 1, 1.5) * .7 * Q; sh.size(Math.round(innerWidth * dpr), Math.round(innerHeight * dpr)); canvas.style.width = innerWidth + 'px'; canvas.style.height = innerHeight + 'px'; }
  const tween = (prop, to, dur, ease) => G ? G.to(st, { [prop]: to, duration: dur, ease, overwrite: 'auto' }) : (st[prop] = to);

  function frame(now) {
    raf = 0; if (!alive || document.hidden) return;
    gov.tick(now);
    if (target && target.isConnected) {
      const r = target.getBoundingClientRect(), tx = r.left + r.width / 2, ty = r.top + r.height / 2;
      if (!seen) { st.x = tx; st.y = ty; st.hw = r.width / 2; st.hh = r.height / 2; seen = true; }
      st.x += (tx - st.x) * .1; st.y += (ty - st.y) * .1; st.hw += (r.width / 2 - st.hw) * .15; st.hh += (r.height / 2 - st.hh) * .15;
    }
    if (st.glow < .004 && !target) { sh.gl.disable(sh.gl.SCISSOR_TEST); sh.gl.clear(sh.gl.COLOR_BUFFER_BIT); seen = false; return; }
    sh.set('uRes', canvas.width, canvas.height); sh.set('uDpr', dpr); sh.set('uTime', (now - t0) / 1000); sh.set('uCard', st.x, st.y, st.hw, st.hh);
    m.x += (m.tx - m.x) * .06; m.ty += 0; m.y += (m.ty - m.y) * .06; sh.set('uMouse', m.x, m.y); sh.set('uGlow', st.glow); sh.set('uBloom', st.bloom); sh.set('uLight', light() ? 1 : 0);
    const c = getComputedStyle(document.documentElement).getPropertyValue('--flare-rgb').trim().split(',').map(Number); sh.set('uTint', ...(c.length === 3 ? c.map(v => v / 255) : [.54, .63, 1]));
    const reach = Math.hypot(st.hw, st.hh) * 1.9, cw = canvas.width, ch = canvas.height;
    const x0 = Math.max(0, Math.floor((st.x - reach) * dpr)), x1 = Math.min(cw, Math.ceil((st.x + reach) * dpr)), y0 = Math.max(0, Math.floor((st.y - reach) * dpr)), y1 = Math.min(ch, Math.ceil((st.y + reach) * dpr));
    sh.draw([x0, ch - y1, Math.max(1, x1 - x0), Math.max(1, y1 - y0)]);
    if (!reduce.matches) raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf && alive) raf = requestAnimationFrame(frame); };
  const enter = (c) => { if (target === c) return; if (st.glow < .02) seen = false; target = c; tween('glow', 1, reduce.matches ? .01 : .9, 'expo.out'); tween('bloom', 1, reduce.matches ? .01 : 1.4, 'expo.out'); kick(); if (reduce.matches) setTimeout(kick, 60); };
  const leave = () => { target = null; tween('glow', 0, reduce.matches ? .01 : .65, 'power3.in'); tween('bloom', .4, reduce.matches ? .01 : .9, 'power2.in'); kick(); if (reduce.matches) setTimeout(kick, 60); };
  const over = (e) => { const c = e.target.closest?.(selector); if (c && host.contains(c)) enter(c); };
  const out = (e) => { const c = e.target.closest?.(selector); if (c && !c.contains(e.relatedTarget) && target === c) leave(); };
  host.addEventListener('pointermove', (e) => { if (!target) return; const r = target.getBoundingClientRect(), R = Math.hypot(r.width, r.height) / 2; m.tx = (e.clientX - (r.left + r.width / 2)) / R; m.ty = (e.clientY - (r.top + r.height / 2)) / R; }, { passive: true });
  host.addEventListener('pointerover', over); host.addEventListener('pointerout', out);
  host.addEventListener('focusin', over); host.addEventListener('focusout', (e) => { if (!host.contains(e.relatedTarget)) leave(); });
  addEventListener('resize', resize); resize();
  const vis = () => { gov.reset(); if (!document.hidden && target) kick(); }; document.addEventListener('visibilitychange', vis);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; });
  canvas.addEventListener('webglcontextrestored', () => kick());
  return () => { alive = false; cancelAnimationFrame(raf); removeEventListener('resize', resize); document.removeEventListener('visibilitychange', vis); G && G.killTweensOf(st); sh.dispose(); canvas.remove(); };
}
