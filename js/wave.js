/* Dot-wave hero: a field of dots folded along a diagonal ridge, with a cursor ring that parts the dots. Purely decorative. */
export function startWave(host, canvas) {
  const ctx = canvas.getContext('2d'), reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let w = 0, h = 0, dpr = 1, sp = 13, cols = 0, rows = 0, raf = 0, t0 = performance.now(), born = t0, visible = true, alive = true, color = '255,255,255';
  const mouse = { x: -999, y: -999, rx: -999, ry: -999, down: 0, on: 0 };
  const smooth = (a, b, x) => { x = Math.min(1, Math.max(0, (x - a) / (b - a))); return x * x * (3 - 2 * x); };
  const readColor = () => { const c = getComputedStyle(document.documentElement).getPropertyValue('--wave-rgb').trim(); color = c || '255,255,255'; };
  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2); w = host.clientWidth; h = host.clientHeight; if (!w || !h) return;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    sp = w < 700 ? 15 : w > 1700 ? 15 : 13; cols = Math.ceil(w / sp) + 2; rows = Math.ceil(h / sp) + 2; readColor();
    if (reduce.matches) frame(performance.now(), true);
  }
  const B = 7, buckets = Array.from({ length: B }, () => []);
  function frame(now, still) {
    const k = still ? 1 : Math.min(1, (now - born) / 2600), t = still ? 4 : (now - t0) / 1000;
    mouse.rx += (mouse.x - mouse.rx) * .16; mouse.ry += (mouse.y - mouse.ry) * .16; mouse.on += ((mouse.x > -900 ? 1 : 0) - mouse.on) * .08;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    const th = .5, ca = Math.cos(th), sa = Math.sin(th), cx = w * .64, cy = h * .5, sigma = Math.max(60, h * .17), len = w * .32;
    for (const b of buckets) b.length = 0;
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      let x = i * sp, y = j * sp;
      const dx = x - cx, dy = y - cy, s = dx * ca + dy * sa, d = -dx * sa + dy * ca;
      const env = Math.exp(-(s * s) / (len * len)), g = Math.exp(-(d * d) / (sigma * sigma)), ridge = g * env;
      const swell = 5 * Math.sin(x * .011 + y * .014 + t * .55) + 3 * Math.cos(x * .02 - t * .4);
      const pinch = -d * (.78 * ridge) * (1 + .12 * Math.sin(t * .7 + s * .01));
      const ripple = 14 * Math.sin(s * .028 - t * 1.05 + d * .012) * Math.exp(-(d * d) / (sigma * sigma * 3.2)) * env;
      x += -sa * (pinch + ripple) + ca * 5 * Math.sin(t * .6 + y * .02) * g; y += ca * (pinch + ripple) + swell;
      const mx = x - mouse.rx, my = y - mouse.ry, md = Math.hypot(mx, my), R = 120 + mouse.down * 60;
      if (mouse.on > .01 && md < R && md > .01) { const f = Math.pow(1 - md / R, 2) * (26 + mouse.down * 22) * mouse.on; x += mx / md * f; y += my / md * f; }
      if (x < -4 || y < -4 || x > w + 4 || y > h + 4) continue;
      const u = x / w, fade = smooth(.2, .5, u) * (1 - .25 * (1 - smooth(0, .12, y / h)));
      const grow = smooth(0, 1, k * 1.7 - Math.hypot(x - cx, y - cy) / (w * .9));
      const a = Math.min(1, (.16 + .95 * Math.pow(ridge, .75) + .08 * Math.sin(i * .5 + t)) * fade * grow);
      if (a < .04) continue;
      const r = .5 + 1.7 * Math.pow(ridge, .75) + .35 * smooth(.55, 1, u) * (1 - ridge) * (j / rows);
      buckets[Math.min(B - 1, (a * B) | 0)].push(x, y, r);
    }
    if (color.startsWith('255')) { // a whisper of colour along the fold: ice-blue, white, lavender
      const gr = ctx.createLinearGradient(w * .35, h * .15, w, h * .9); gr.addColorStop(0, 'rgb(205,218,255)'); gr.addColorStop(.5, 'rgb(255,255,255)'); gr.addColorStop(1, 'rgb(226,212,255)'); ctx.fillStyle = gr;
    } else ctx.fillStyle = `rgb(${color})`;
    for (let b = 0; b < B; b++) {
      const arr = buckets[b]; if (!arr.length) continue; ctx.globalAlpha = (b + .6) / B; ctx.beginPath();
      for (let n = 0; n < arr.length; n += 3) { ctx.moveTo(arr[n] + arr[n + 2], arr[n + 1]); ctx.arc(arr[n], arr[n + 1], arr[n + 2], 0, 6.2832); }
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (mouse.on > .02) {
      const rr = 15 + mouse.down * 5 + 1.5 * Math.sin(t * 3);
      ctx.strokeStyle = `rgba(${color},${.7 * mouse.on})`; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(mouse.rx, mouse.ry, rr, 0, 6.2832); ctx.stroke();
      ctx.strokeStyle = `rgba(${color},${.18 * mouse.on})`; ctx.beginPath(); ctx.arc(mouse.rx, mouse.ry, rr + 9 + 4 * Math.sin(t * 2), 0, 6.2832); ctx.stroke();
    }
  }
  function loop(now) { raf = 0; if (!alive || document.hidden || !visible || reduce.matches) return; frame(now); raf = requestAnimationFrame(loop); }
  const kick = () => { if (!raf && alive && !reduce.matches) raf = requestAnimationFrame(loop); };
  const move = e => { const r = host.getBoundingClientRect(); mouse.x = e.clientX - r.left; mouse.y = e.clientY - r.top; if (mouse.rx < -900) { mouse.rx = mouse.x; mouse.ry = mouse.y; } };
  const leave = () => { mouse.x = mouse.y = -999; };
  const down = () => { mouse.down = 1; const up = () => { mouse.down = 0; removeEventListener('pointerup', up); }; addEventListener('pointerup', up); };
  host.addEventListener('pointermove', move); host.addEventListener('pointerleave', leave); host.addEventListener('pointerdown', down);
  const ro = new ResizeObserver(resize); ro.observe(host);
  const io = new IntersectionObserver(e => { visible = e[0].isIntersecting; kick(); }); io.observe(host);
  const vis = () => kick(); document.addEventListener('visibilitychange', vis);
  const theme = new MutationObserver(readColor); theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  resize(); kick();
  return () => { alive = false; cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); theme.disconnect(); document.removeEventListener('visibilitychange', vis); };
}
