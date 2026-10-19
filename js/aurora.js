/* Analysis aurora. While the engine works the interface recedes and an aurora takes the screen: layered
   curtains over a lunar horizon, rendered in a fragment shader and choreographed with GSAP.
   Rotating words and space facts surface letter by letter; when the task settles everything parts and the UI returns. */
import { Jobs, Runner } from './runner.js';
import { createShader, NOISE_GLSL, governor } from './gl.js';

const WORDS = ['Calibrating', 'Reading shadows', 'Triangulating', 'Deliberating', 'Chasing the terminator', 'Counting craters', 'Untangling sunlight', 'Cross-referencing', 'Measuring regolith', 'Consulting the ephemeris', 'Converging', 'Resolving', 'Stargazing', 'Aligning orbits', 'Contemplating'];
const FACTS = [
  ['The Moon drifts about 3.8 cm farther from Earth every year.', 'Lunar laser ranging'],
  ['A full lunar day — sunrise to sunrise — lasts about 29.5 Earth days.', 'Lunar fact'],
  ['From 100 km up, Chandrayaan-2’s OHRC resolves details about 25 cm across.', 'ISRO'],
  ['Some craters near the lunar poles have not seen sunlight for billions of years.', 'Lunar fact'],
  ['Chandrayaan-3 touched down near the lunar south pole on 23 August 2023.', 'ISRO'],
  ['We always see the same face of the Moon — it is tidally locked to Earth.', 'Lunar fact'],
  ['Moon dust reflects about as much light as worn asphalt.', 'Lunar fact'],
  ['When the Sun sits a few degrees above the horizon, polar shadows stretch for kilometres.', 'Why Sun angle matters'],
  ['Imagination will often carry us to worlds that never were. But without it we go nowhere.', 'Carl Sagan'],
  ['Equipped with his five senses, man explores the universe around him and calls the adventure Science.', 'Edwin Hubble'],
  ['The Earth is the cradle of humanity, but one cannot live in the cradle forever.', 'Konstantin Tsiolkovsky'],
  ['That’s one small step for man, one giant leap for mankind.', 'Neil Armstrong']
];
const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const G = () => window.gsap;

const FRAG = `precision highp float;
uniform vec2 uRes, uMouse; uniform float uTime, uReveal;
${NOISE_GLSL}
vec3 curtains(vec2 uv, float t){
  vec3 col = vec3(0.);
  for (int i = 0; i < 4; i++) {
    float fi = float(i);
    float x = uv.x * (1.15 + .22 * fi) + fi * 3.1 + uMouse.x * .08 * (fi + 1.);
    float path = .46 + .05 * fi + .24 * fbm(vec2(x * .9 + t * (.035 + .012 * fi), fi * 7. + t * .02)) + .05 * sin(x * 2.2 + t * .12 + fi * 1.7);
    path -= (1. - uReveal) * .35;
    float d = uv.y - path;
    float body = smoothstep(-.004, .012, d) * (exp(-max(d, 0.) * (7.5 - fi * .6)) + .9 * exp(-max(d, 0.) * 36.));
    float warp = fbm(vec2(x * 2.6, t * .08 + fi)) * 5.;
    float s = pow(clamp(fbm(vec2(x * 70. + warp, t * .1 + fi * 2.)) * 1.35 - .08, 0., 1.), 1.8);
    float streak = mix(.22, 1.25, s);
    float pulse = .5 + .5 * sin(x * 1.5 - t * .3 + fi * 2.1) * (.6 + .4 * sin(t * .21 + fi));
    float h = clamp(d * 2.0, 0., 1.);
    vec3 c = mix(mix(vec3(.12, 1., .62), vec3(.22, .86, 1.), smoothstep(0., .5, h)), vec3(.68, .42, 1.), smoothstep(.4, 1., h));
    c = mix(c, vec3(1., .45, .75), .12 * smoothstep(.0, .06, d) * (1. - smoothstep(.06, .2, d)) * fbm(vec2(x * 3., t * .05)));
    col += c * body * streak * pulse * (.55 - .07 * fi) * uReveal;
  }
  return col;
}
void main(){
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 q = uv; q.x *= uRes.x / uRes.y;
  float t = uTime;
  vec3 sky = mix(vec3(.004, .008, .02), vec3(.012, .02, .055), pow(uv.y, .8));
  vec2 gp = gl_FragCoord.xy / 2.; vec2 g = floor(gp); float h = hash(g);
  float star = step(.9975, h) * smoothstep(.55, .0, length(fract(gp) - .5)) * (.5 + .5 * sin(t * (1. + h * 3.) + h * 40.));
  vec3 stars = star * mix(vec3(.8, .88, 1.), vec3(1., .85, .7), step(.6, hash(g + 7.))) * (.35 + .65 * smoothstep(.25, .9, uv.y));
  vec3 a = curtains(vec2(q.x * .62, uv.y), t);
  vec3 glow = curtains(vec2(q.x * .62, uv.y * .9 + .02), t * .8) * .35;
  vec3 col = sky + stars * (1. - clamp(dot(a, vec3(1.)) * 1.4, 0., .8)) + a + glow * .35;
  float ridge = .075 + .045 * fbm(vec2(q.x * 3.2, 1.7)) + .02 * fbm(vec2(q.x * 11., 4.2));
  float land = smoothstep(ridge + .003, ridge - .003, uv.y);
  vec3 lit = a * .5 + vec3(.015, .02, .04);
  col = mix(col, lit * .6, land);
  float vig = smoothstep(1.25, .35, length((uv - .5) * vec2(1.1, 1.)));
  col *= vig;
  col = 1. - exp(-col * 1.55);
  gl_FragColor = vec4(col, 1.);
}`;

let el = null;
function build() {
  el = document.createElement('div'); el.id = 'aurora'; el.className = 'aurora'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.innerHTML = `<canvas aria-hidden="true"></canvas><div class="aurora-veil"></div>
    <div class="aurora-copy"><p class="aurora-eyebrow"></p><h2 class="aurora-word" aria-live="off"></h2><figure class="aurora-fact"><blockquote></blockquote><figcaption></figcaption></figure></div>
    <div class="aurora-foot"><div class="aurora-bar"><i></i></div><div class="aurora-meta"><span class="aurora-stage">Starting</span><span class="aurora-pct">0%</span></div><button type="button" class="aurora-cancel">Cancel</button></div>`;
  document.body.append(el);
}

function sky(canvas) {
  const sh = createShader(canvas, FRAG, { premultiplied: false });
  if (!sh) { canvas.style.background = 'radial-gradient(80% 60% at 50% 70%,#0c2a3a,#02030a)'; return { reveal() {}, stop() {} }; }
  const st = { reveal: 0, mx: 0, my: 0 }; let raf = 0, alive = true; const t0 = performance.now(); let scale = .8;
  const gov = governor((q) => { scale = .8 * q; size(); });
  const size = () => sh.size(Math.max(320, Math.round(innerWidth * scale)), Math.max(200, Math.round(innerHeight * scale)));
  const mv = (e) => { st.mx += ((e.clientX / innerWidth - .5) * 2 - st.mx) * .08; st.my += ((e.clientY / innerHeight - .5) * 2 - st.my) * .08; };
  const loop = (now) => { raf = 0; if (!alive || document.hidden) return; gov.tick(now); sh.set('uRes', canvas.width, canvas.height); sh.set('uTime', (now - t0) / 1000 + 20); sh.set('uReveal', st.reveal); sh.set('uMouse', st.mx, st.my); sh.draw(); if (!reduce() || st.reveal > 0.01) raf = requestAnimationFrame(loop); };
  const vis = () => { gov.reset(); if (!document.hidden && alive && !raf) raf = requestAnimationFrame(loop); }; document.addEventListener('visibilitychange', vis);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); cancelAnimationFrame(raf); raf = 0; canvas.style.background = 'radial-gradient(80% 60% at 50% 70%,#0c2a3a,#02030a)'; });
  size(); addEventListener('resize', size); addEventListener('pointermove', mv, { passive: true }); raf = requestAnimationFrame(loop);
  return {
    reveal(v, dur) { const g = G(); if (g && !reduce()) g.to(st, { reveal: v, duration: dur, ease: v ? 'power2.inOut' : 'power2.in', overwrite: true }); else st.reveal = v; if (!raf && alive) raf = requestAnimationFrame(loop); },
    stop() { alive = false; cancelAnimationFrame(raf); removeEventListener('resize', size); document.removeEventListener('visibilitychange', vis); removeEventListener('pointermove', mv); sh.dispose(); }
  };
}

const chars = (node, text) => { node.textContent = ''; for (const c of text) { const s = document.createElement('span'); s.className = 'ch'; s.textContent = c === ' ' ? ' ' : c; node.append(s); } return [...node.children]; };

/** Run `task` under the aurora. `onSettled(ok)` is called while the UI is still hidden (navigate there). */
export async function runWithAurora(task, { eyebrow = '', minMs = 7500, onSettled } = {}) {
  if (!el) build();
  const g = G(), calm = reduce();
  const words = shuffle(WORDS), facts = shuffle(FACTS), word = el.querySelector('.aurora-word'), quote = el.querySelector('blockquote'), cite = el.querySelector('figcaption'), fact = el.querySelector('.aurora-fact');
  const stage = el.querySelector('.aurora-stage'), pctEl = el.querySelector('.aurora-pct'), bar = el.querySelector('.aurora-bar i'), cancel = el.querySelector('.aurora-cancel'), copy = el.querySelector('.aurora-copy'), foot = el.querySelector('.aurora-foot'), eb = el.querySelector('.aurora-eyebrow');
  eb.textContent = eyebrow; bar.style.width = '0%'; pctEl.textContent = '0%'; stage.textContent = 'Starting'; word.textContent = '';
  const field = sky(el.querySelector('canvas'));

  // word choreography: letters rise in blurred, previous line leaves upward
  let current = null;
  const wordIn = (text, final) => {
    const old = current;
    if (old) { if (g && !calm) g.to(old.children, { y: -26, opacity: 0, filter: 'blur(12px)', duration: .7, stagger: .018, ease: 'power2.in', onComplete: () => old.remove() }); else old.remove(); }
    const line = document.createElement('span'); line.className = 'wordline'; word.append(line); current = line;
    const cs = chars(line, text + (final ? '' : '…'));
    if (g && !calm) {
      g.fromTo(cs, { y: 34, opacity: 0, filter: 'blur(14px)' }, { y: 0, opacity: 1, filter: 'blur(0px)', duration: 1.3, stagger: .04, ease: 'expo.out', delay: old ? .35 : 0 });
      if (final) g.fromTo(line, { scale: .96 }, { scale: 1, duration: 1.6, ease: 'expo.out', delay: .3 });
    }
  };
  const factIn = (i) => {
    const f = facts[i % facts.length], set = () => { quote.textContent = f[0]; cite.textContent = f[1]; };
    if (g && !calm) g.timeline().to(fact, { opacity: 0, y: -8, filter: 'blur(6px)', duration: .6, ease: 'power2.in' }).add(set).fromTo(fact, { opacity: 0, y: 10, filter: 'blur(6px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 1.1, ease: 'power3.out' });
    else set();
  };
  let wi = 0, fi = 0; wordIn(words[0]); quote.textContent = facts[0][0]; cite.textContent = facts[0][1];
  const wTimer = setInterval(() => wordIn(words[++wi % words.length]), 3200), fTimer = setInterval(() => factIn(++fi), 8200);
  const off = Jobs.on((s) => { const p = Math.round(s.pct * 100); if (g) g.to(bar, { width: p + '%', duration: .8, ease: 'power2.out', overwrite: true }); else bar.style.width = p + '%'; pctEl.textContent = p + '%'; if (s.msg) stage.textContent = s.msg; });
  let cancelled = false; cancel.onclick = () => { cancelled = true; cancel.disabled = true; Runner.cancel(); Jobs.finish(); }; cancel.disabled = false;

  // enter: the interface recedes (CSS), the aurora rises, copy settles
  document.body.classList.add('analysing'); el.classList.add('on');
  if (g && !calm) {
    g.fromTo(el, { opacity: 0 }, { opacity: 1, duration: 1.8, ease: 'power2.out', delay: .2, overwrite: true });
    g.fromTo(eb, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 1.2, delay: .8, ease: 'power3.out' });
    g.fromTo(fact, { opacity: 0 }, { opacity: 1, duration: 1.6, delay: 1.6, ease: 'power2.out' });
    g.fromTo(foot, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 1.4, delay: 1.2, ease: 'power3.out' });
  } else el.style.opacity = 1;
  field.reveal(1, 3.2);

  const t0 = Date.now(); let ok = false, error = null;
  try { const r = await task(); ok = r !== false; } catch (e) { error = e; }
  if (!cancelled && !error) await sleep(Math.max(0, minMs - (Date.now() - t0)));
  clearInterval(wTimer); clearInterval(fTimer); off();
  wordIn(cancelled ? 'Cancelled' : error ? 'Something went wrong' : ok ? 'Aligned' : 'No verified match', true);
  if (g) g.to(bar, { width: '100%', duration: .8, overwrite: true }); else bar.style.width = '100%';
  pctEl.textContent = cancelled ? '' : '100%'; stage.textContent = cancelled ? 'Stopped by you' : ok ? 'Opening the result' : 'Returning to the workspace';
  await sleep(2100);
  try { onSettled?.(ok && !cancelled && !error, { cancelled, error }); } catch { /* navigation errors are non-fatal */ }

  // exit: copy lifts away, the aurora fades down, the interface returns
  field.reveal(0, 1.8);
  if (g && !calm) {
    g.to([copy, foot], { opacity: 0, y: -18, filter: 'blur(10px)', duration: .9, ease: 'power2.in' });
    g.to(el, { opacity: 0, duration: 1.6, delay: .5, ease: 'power2.inOut' });
  } else el.style.opacity = 0;
  document.body.classList.remove('analysing');
  await sleep(2200);
  el.classList.remove('on'); field.stop(); word.textContent = ''; current = null;
  if (g) g.set([copy, foot, eb, fact, el], { clearProps: 'all' });
  if (error && error.message !== 'Cancelled') throw error;
  return ok;
}
