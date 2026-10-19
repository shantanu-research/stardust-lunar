/* Ambient sky: a sparse starfield that breathes slowly and shifts a few pixels with the pointer.
   Low contrast by design — it should be felt, not noticed. Hidden in the light theme. */
export function startStars() {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const c = document.createElement('canvas'); c.id = 'sky'; c.setAttribute('aria-hidden', 'true'); document.body.prepend(c);
  const g = c.getContext('2d'); let w, h, dpr, stars = [], raf = 0, px = 0, py = 0, tx = 0, ty = 0;
  const seed = (n) => { let s = n; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
  function build() {
    dpr = Math.min(devicePixelRatio || 1, 2); w = innerWidth; h = innerHeight; c.width = w * dpr; c.height = h * dpr;
    const r = seed(42), n = Math.round(w * h / 9000); stars = [];
    for (let i = 0; i < n; i++) { const z = r(); stars.push({ x: r() * w, y: r() * h, z, s: .35 + z * z * 1.2, a: .12 + z * .5, ph: r() * 6.28, sp: .2 + r() * .9, hue: r() < .12 ? (r() < .6 ? 220 : 35) : 0 }); }
    if (reduce.matches) draw(0);
  }
  function draw(t) {
    tx += (px - tx) * .04; ty += (py - ty) * .04;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    for (const s of stars) {
      const tw = reduce.matches ? 1 : .55 + .45 * Math.sin(t * .0006 * s.sp + s.ph);
      const x = (s.x + tx * s.z * 14 + w) % w, y = (s.y + ty * s.z * 10 + h) % h;
      g.globalAlpha = s.a * tw; g.fillStyle = s.hue ? `hsl(${s.hue},70%,86%)` : '#fff';
      g.beginPath(); g.arc(x, y, s.s, 0, 6.283); g.fill();
    }
    g.globalAlpha = 1;
  }
  const loop = (t) => { raf = 0; if (document.hidden || reduce.matches) return; draw(t); raf = requestAnimationFrame(loop); };
  addEventListener('resize', build); addEventListener('pointermove', (e) => { px = e.clientX / innerWidth - .5; py = e.clientY / innerHeight - .5; }, { passive: true });
  document.addEventListener('visibilitychange', () => { if (!raf && !reduce.matches) raf = requestAnimationFrame(loop); });
  build(); raf = requestAnimationFrame(loop);
}
