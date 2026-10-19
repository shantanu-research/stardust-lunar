/* Flare: a WebGL corona behind the hovered card. Domain-warped smoke, noise-modulated rays and a warm core
   fading to cool tips. It glides between cards (GSAP + damping) and never clips. Decorative only. */
import { createShader, NOISE_GLSL, governor } from './gl.js';

const FRAG = `precision highp float;
uniform vec2 uRes; uniform float uTime, uGlow, uBloom, uLight, uDpr; uniform vec4 uCard; uniform vec3 uTint; uniform vec2 uMouse;
${NOISE_GLSL}
float sdBox(vec2 p, vec2 b, float r){ vec2 q = abs(p) - b + r; return length(max(q, 0.)) + min(max(q.x, q.y), 0.) - r; }
void main(){
  vec2 frag = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec2 rel = frag - uCard.xy;
  float R = length(uCard.zw);
  float d = sdBox(rel, uCard.zw, 20.);
  vec2 p = rel / R;
  float t = uTime;
  vec2 hw = uCard.zw / R;
  // plasma wisps rise from the upper-right corner and curl up-left; a lesser plume trails from the lower-left
  float dc = min(length(p - vec2(hw.x * .85, -hw.y)), length(p - vec2(-hw.x, hw.y * .7)) * 1.5);
  float reach = exp(-dc * 2.7) * smoothstep(-.02, .06, d / R);
  vec2 q = p + .55 * vec2(fbm(p * 1.6 + vec2(0., t * .03)), fbm(p * 1.6 + vec2(5.2, 1.3) - t * .025));
  q += .35 * vec2(fbm(q * 2.6 + t * .02), fbm(q * 2.6 + 3.7 - t * .018));
  q += vec2(-.18, .35) * dc;
  q += (uMouse - p) * .22 * exp(-dc * 1.2);
  float r1 = pow(clamp(1. - abs(2. * fbm(q * 2.4 + vec2(0., -t * .045)) - 1.), 0., 1.), 9.);
  float r2 = pow(clamp(1. - abs(2. * fbm(q * 6.2 + vec2(t * .03, 2.1)) - 1.), 0., 1.), 8.);
  float body = smoothstep(.35, .85, fbm(q * 1.5 + vec2(0., -t * .02)));
  float edge = exp(-max(d, 0.) / 16.) * .22 + exp(-max(d, 0.) / 70.) * .12;
  float I = (r1 * 1.25 + r2 * .5 + body * .12) * reach + edge * (.5 + .5 * reach);
  I *= uGlow * mix(.12, 1., smoothstep(-26., 3., d)) * (.55 + .45 * uBloom);
  vec3 col = mix(vec3(.93, .94, 1.), uTint, .14);
  if (uLight > .5) { float a = clamp(I * .5, 0., 1.); gl_FragColor = vec4(vec3(.1, .12, .26) * a, a); return; }
  vec3 c = 1. - exp(-col * I * 1.9);
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
    if (st.glow < .004 && !target) { sh.gl.clear(sh.gl.COLOR_BUFFER_BIT); seen = false; return; }
    sh.set('uRes', canvas.width, canvas.height); sh.set('uDpr', dpr); sh.set('uTime', (now - t0) / 1000); sh.set('uCard', st.x, st.y, st.hw, st.hh);
    m.x += (m.tx - m.x) * .06; m.ty += 0; m.y += (m.ty - m.y) * .06; sh.set('uMouse', m.x, m.y); sh.set('uGlow', st.glow); sh.set('uBloom', st.bloom); sh.set('uLight', light() ? 1 : 0);
    const c = getComputedStyle(document.documentElement).getPropertyValue('--flare-rgb').trim().split(',').map(Number); sh.set('uTint', ...(c.length === 3 ? c.map(v => v / 255) : [.54, .63, 1]));
    sh.draw(); raf = requestAnimationFrame(frame);
  }
  const kick = () => { if (!raf && alive && !reduce.matches) raf = requestAnimationFrame(frame); };
  const enter = (c) => { if (target === c) return; if (st.glow < .02) seen = false; target = c; tween('glow', 1, 1.5, 'power2.out'); tween('bloom', 1, 2.4, 'power3.out'); kick(); };
  const leave = () => { target = null; tween('glow', 0, 1.1, 'power2.inOut'); tween('bloom', .4, 1.4, 'power2.out'); kick(); };
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
