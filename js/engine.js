/* STARDUST registration engine.
   Pure JavaScript (no dependencies); runs inside a Web Worker or under Node for tests.

   Pipeline (SIH26166): normalise → scale-space keypoints → rotation/scale-invariant descriptors →
   ratio-tested matching → robust geometric verification (RANSAC + least squares) → registered image,
   match points and evaluation statistics (RMSE, inlier count, inlier ratio, distribution).

   Modes of preprocessing:
     raw     contrast-stretched intensity
     illum   log + local mean/variance normalisation: suppresses Sun-angle shading
     struct  illum + polarity-folded orientation descriptors: tolerant of contrast reversal (cross-modal)
*/
(function (root) {
  'use strict';

  const VERSION = '1.0.0';
  const DEFAULTS = {
    pre: 'raw', model: 'similarity', workRes: 1000, maxKp: 2500, ratio: 0.8, mutual: true,
    thr: 3, iter: 4000, sweep: false, scalePrior: 1, sens: 0.03, grid: 6, cap: 3, seed: 7
  };

  // ───────────────────────── small utilities ─────────────────────────
  function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  function toFloat(u8) { const f = new Float32Array(u8.length); for (let i = 0; i < f.length; i++) f[i] = u8[i] / 255; return f; }

  function stats(f) {
    let s = 0, s2 = 0; const n = f.length;
    for (let i = 0; i < n; i++) { const v = f[i]; s += v; s2 += v * v; }
    const m = s / n; return { mean: m, std: Math.sqrt(Math.max(1e-12, s2 / n - m * m)) };
  }

  function percentileStretch(f, lo = 0.01, hi = 0.99) {
    const step = Math.max(1, (f.length / 40000) | 0), sample = [];
    for (let i = 0; i < f.length; i += step) sample.push(f[i]);
    sample.sort((a, b) => a - b);
    const a = sample[Math.floor(sample.length * lo)], b = sample[Math.min(sample.length - 1, Math.floor(sample.length * hi))];
    const out = new Float32Array(f.length), d = Math.max(1e-6, b - a);
    for (let i = 0; i < f.length; i++) out[i] = clamp((f[i] - a) / d, 0, 1);
    return out;
  }

  function kernel(sigma) {
    const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1); let s = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + r] = v; s += v; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  }

  function blur(src, w, h, sigma) {
    if (sigma < 0.05) return src.slice();
    const k = kernel(sigma), r = (k.length - 1) >> 1, tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let s = 0;
        if (x >= r && x < w - r) { for (let j = -r; j <= r; j++) s += k[j + r] * src[row + x + j]; }
        else { for (let j = -r; j <= r; j++) { const xx = x + j < 0 ? 0 : x + j >= w ? w - 1 : x + j; s += k[j + r] * src[row + xx]; } }
        tmp[row + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        if (y >= r && y < h - r) { for (let j = -r; j <= r; j++) s += k[j + r] * tmp[(y + j) * w + x]; }
        else { for (let j = -r; j <= r; j++) { const yy = y + j < 0 ? 0 : y + j >= h ? h - 1 : y + j; s += k[j + r] * tmp[yy * w + x]; } }
        out[y * w + x] = s;
      }
    }
    return out;
  }

  function resize(src, w, h, nw, nh) {
    nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
    const fx = w / nw, fy = h / nh, f = Math.max(fx, fy);
    const base = f > 1.5 ? blur(src, w, h, 0.45 * f) : src, out = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) {
      const sy = clamp((y + 0.5) * fy - 0.5, 0, h - 1), y0 = sy | 0, y1 = Math.min(h - 1, y0 + 1), wy = sy - y0;
      for (let x = 0; x < nw; x++) {
        const sx = clamp((x + 0.5) * fx - 0.5, 0, w - 1), x0 = sx | 0, x1 = Math.min(w - 1, x0 + 1), wx = sx - x0;
        const a = base[y0 * w + x0], b = base[y0 * w + x1], c = base[y1 * w + x0], d = base[y1 * w + x1];
        out[y * nw + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
      }
    }
    return { data: out, w: nw, h: nh };
  }

  function half(src, w, h) {
    const nw = w >> 1, nh = h >> 1, out = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) out[y * nw + x] = src[2 * y * w + 2 * x];
    return { data: out, w: nw, h: nh };
  }

  // ───────────────────────── preprocessing ─────────────────────────
  /** Returns a standardised float image (mean≈0, std≈1) ready for scale-space analysis. */
  function preprocess(f, w, h, mode) {
    let g = percentileStretch(f);
    if (mode === 'illum' || mode === 'struct') {
      // log compression keeps shadowed relief visible; local normalisation removes slowly varying illumination.
      for (let i = 0; i < g.length; i++) g[i] = Math.log(1 + 8 * g[i]);
      const sg = Math.max(6, Math.min(w, h) / 40);
      const m = blur(g, w, h, sg), d = new Float32Array(g.length);
      for (let i = 0; i < g.length; i++) { const v = g[i] - m[i]; d[i] = v * v; }
      const v = blur(d, w, h, sg);
      for (let i = 0; i < g.length; i++) g[i] = (g[i] - m[i]) / Math.sqrt(v[i] + 1e-4);
      const mean = stats(g).mean;
      for (let i = 0; i < g.length; i++) g[i] = Math.tanh((g[i] - mean) * 0.8);
    }
    const s = stats(g); const out = new Float32Array(g.length);
    for (let i = 0; i < g.length; i++) out[i] = (g[i] - s.mean) / s.std;
    return out;
  }

  // ───────────────────────── keypoints ─────────────────────────
  const S = 3, SIGMA0 = 1.6, KSTEP = Math.pow(2, 1 / S);

  function detect(img, w, h, opt) {
    const octs = [], cands = [];
    let cur = blur(img, w, h, Math.sqrt(SIGMA0 * SIGMA0 - 0.25)), cw = w, ch = h;
    const nOct = Math.max(1, Math.min(opt.octaves || 8, Math.floor(Math.log2(Math.min(w, h) / 24))));
    const edgeR = 10, edge = (edgeR + 1) * (edgeR + 1) / edgeR, thr = opt.sens;
    for (let o = 0; o < nOct; o++) {
      const G = [cur];
      for (let i = 1; i < S + 3; i++) {
        const sp = SIGMA0 * Math.pow(KSTEP, i - 1), st = sp * KSTEP;
        G.push(blur(G[i - 1], cw, ch, Math.sqrt(st * st - sp * sp)));
      }
      const D = [];
      for (let i = 0; i < S + 2; i++) { const d = new Float32Array(cw * ch), a = G[i + 1], b = G[i]; for (let p = 0; p < d.length; p++) d[p] = a[p] - b[p]; D.push(d); }
      const offs = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) offs.push(dy * cw + dx);
      const scale = 1 << o;
      for (let i = 1; i <= S; i++) {
        const d = D[i], dp = D[i - 1], dn = D[i + 1];
        for (let y = 5; y < ch - 5; y++) {
          for (let x = 5; x < cw - 5; x++) {
            const idx = y * cw + x, v = d[idx];
            if (v < thr && v > -thr) continue;
            let ok = true;
            if (v > 0) {
              for (let n = 0; n < 9 && ok; n++) { const q = idx + offs[n]; if (dp[q] >= v || dn[q] >= v || (n !== 4 && d[q] >= v)) ok = false; }
            } else {
              for (let n = 0; n < 9 && ok; n++) { const q = idx + offs[n]; if (dp[q] <= v || dn[q] <= v || (n !== 4 && d[q] <= v)) ok = false; }
            }
            if (!ok) continue;
            const dxx = d[idx + 1] + d[idx - 1] - 2 * v, dyy = d[idx + cw] + d[idx - cw] - 2 * v;
            const dxy = (d[idx + cw + 1] - d[idx + cw - 1] - d[idx - cw + 1] + d[idx - cw - 1]) / 4;
            const det = dxx * dyy - dxy * dxy, tr = dxx + dyy;
            if (det <= 0 || tr * tr / det >= edge) continue;
            const gx = (d[idx + 1] - d[idx - 1]) / 2, gy = (d[idx + cw] - d[idx - cw]) / 2;
            const ox = -(dyy * gx - dxy * gy) / det, oy = -(dxx * gy - dxy * gx) / det;
            if (Math.abs(ox) > 1 || Math.abs(oy) > 1) continue;
            const resp = Math.abs(v + 0.5 * (gx * ox + gy * oy));
            if (resp < thr) continue;
            cands.push({ o, i, ox: x + ox, oy: y + oy, x: (x + ox) * scale, y: (y + oy) * scale, resp, sigma: SIGMA0 * Math.pow(KSTEP, i) });
          }
        }
      }
      octs.push({ G, cw, ch });
      if (o < nOct - 1) { const hlf = half(G[S], cw, ch); cur = hlf.data; cw = hlf.w; ch = hlf.h; }
    }
    return { octs, cands };
  }

  /** Keep a budget of keypoints: half by strength, half round-robin across a grid so coverage stays even. */
  function select(cands, w, h, maxKp, grid = 8) {
    if (cands.length <= maxKp) return cands;
    cands.sort((a, b) => b.resp - a.resp);
    const chosen = new Set(), half = Math.floor(maxKp / 2);
    for (let i = 0; i < half; i++) chosen.add(cands[i]);
    const cells = Array.from({ length: grid * grid }, () => []);
    for (const c of cands) if (!chosen.has(c)) cells[clamp((c.y / h * grid) | 0, 0, grid - 1) * grid + clamp((c.x / w * grid) | 0, 0, grid - 1)].push(c);
    let n = 0, round = 0;
    while (n < maxKp - half) {
      let any = false;
      for (const cell of cells) if (round < cell.length && n < maxKp - half) { chosen.add(cell[round]); n++; any = true; }
      if (!any) break; round++;
    }
    return [...chosen];
  }

  // ───────────────────────── orientation + descriptor ─────────────────────────
  function orientations(kp, oct, fold) {
    const L = oct.G[kp.i], w = oct.cw, h = oct.ch, sig = kp.sigma, rad = Math.round(4.5 * sig), ws = 1.5 * sig;
    const ix = Math.round(kp.ox), iy = Math.round(kp.oy), N = 36, hist = new Float32Array(N), twoPi = Math.PI * 2;
    for (let dy = -rad; dy <= rad; dy++) {
      const y = iy + dy; if (y <= 0 || y >= h - 1) continue;
      for (let dx = -rad; dx <= rad; dx++) {
        const x = ix + dx; if (x <= 0 || x >= w - 1) continue;
        const gx = L[y * w + x + 1] - L[y * w + x - 1], gy = L[(y + 1) * w + x] - L[(y - 1) * w + x];
        const mag = Math.sqrt(gx * gx + gy * gy), ang = Math.atan2(gy, gx);
        const a = fold ? ((2 * ang) % twoPi + twoPi) % twoPi : (ang + twoPi) % twoPi;
        hist[Math.min(N - 1, (a / twoPi * N) | 0)] += mag * Math.exp(-(dx * dx + dy * dy) / (2 * ws * ws));
      }
    }
    const sm = new Float32Array(N);
    for (let pass = 0; pass < 2; pass++) { for (let i = 0; i < N; i++) sm[i] = 0.25 * hist[(i + N - 1) % N] + 0.5 * hist[i] + 0.25 * hist[(i + 1) % N]; hist.set(sm); }
    let max = 0; for (let i = 0; i < N; i++) if (hist[i] > max) max = hist[i];
    const out = [];
    if (max <= 0) return out;
    for (let i = 0; i < N; i++) {
      const l = hist[(i + N - 1) % N], c = hist[i], r = hist[(i + 1) % N];
      if (c > l && c > r && c >= 0.8 * max) {
        const bin = i + 0.5 * (l - r) / (l - 2 * c + r), phi = ((bin + 0.5) / N) * twoPi;
        if (fold) { const t = phi / 2; out.push(t, t + Math.PI); } else out.push(phi > Math.PI ? phi - twoPi : phi);
        if (out.length >= (fold ? 4 : 2)) break;
      }
    }
    return out;
  }

  function descriptor(kp, oct, theta, fold, out, off) {
    const L = oct.G[kp.i], w = oct.cw, h = oct.ch, d = 4, n = 8, sig = kp.sigma;
    const ix = Math.round(kp.ox), iy = Math.round(kp.oy), fx = kp.ox - ix, fy = kp.oy - iy;
    const hw = 3 * sig, rad = Math.round(hw * Math.SQRT2 * (d + 1) * 0.5), ct = Math.cos(theta) / hw, st = Math.sin(theta) / hw;
    const hist = new Float32Array((d + 2) * (d + 2) * n), twoPi = Math.PI * 2, period = fold ? Math.PI : twoPi, wexp = -1 / (0.5 * d * d);
    for (let i = -rad; i <= rad; i++) {
      const y = iy + i; if (y <= 0 || y >= h - 1) continue;
      for (let j = -rad; j <= rad; j++) {
        const x = ix + j; if (x <= 0 || x >= w - 1) continue;
        const jj = j - fx, ii = i - fy;
        const cr = jj * ct + ii * st, rr = -jj * st + ii * ct, rb = rr + d / 2 - 0.5, cb = cr + d / 2 - 0.5;
        if (rb <= -1 || rb >= d || cb <= -1 || cb >= d) continue;
        const gx = L[y * w + x + 1] - L[y * w + x - 1], gy = L[(y + 1) * w + x] - L[(y - 1) * w + x];
        const mag = Math.sqrt(gx * gx + gy * gy); if (mag === 0) continue;
        let ori = Math.atan2(gy, gx) - theta; ori = ((ori % period) + period) % period;
        const ob = ori / period * n, wgt = Math.exp((cr * cr + rr * rr) * wexp) * mag;
        const r0 = Math.floor(rb), c0 = Math.floor(cb), o0 = Math.floor(ob), dr = rb - r0, dc = cb - c0, dO = ob - o0;
        for (let a = 0; a < 2; a++) {
          const rv = r0 + a + 1, wr = wgt * (a ? dr : 1 - dr);
          for (let b = 0; b < 2; b++) {
            const cv = c0 + b + 1, wc = wr * (b ? dc : 1 - dc), base = (rv * (d + 2) + cv) * n;
            hist[base + (o0 % n)] += wc * (1 - dO); hist[base + ((o0 + 1) % n)] += wc * dO;
          }
        }
      }
    }
    let k = 0, norm = 0; const v = new Float32Array(128);
    for (let r = 0; r < d; r++) for (let c = 0; c < d; c++) for (let o = 0; o < n; o++) { const val = hist[((r + 1) * (d + 2) + c + 1) * n + o]; v[k++] = val; norm += val * val; }
    norm = Math.sqrt(norm) || 1; let n2 = 0;
    for (let i = 0; i < 128; i++) { v[i] = Math.min(0.2, v[i] / norm); n2 += v[i]; }
    // RootSIFT: L1-normalise then square-root (Hellinger kernel) — markedly better for repetitive terrain.
    n2 = n2 || 1; for (let i = 0; i < 128; i++) out[off + i] = Math.sqrt(v[i] / n2);
  }

  function features(img, w, h, opt, forMoving) {
    const fold = opt.pre === 'struct';
    const { octs, cands } = detect(img, w, h, opt);
    const kps = select(cands, w, h, opt.maxKp);
    const pts = [], list = [];
    for (const kp of kps) {
      const oct = octs[kp.o];
      let angles = orientations(kp, oct, fold);
      if (fold && !forMoving) angles = angles.slice(0, 1);   // reference: one copy; moving: both 180° hypotheses
      for (const th of angles) { list.push([kp, th]); }
    }
    const desc = new Float32Array(list.length * 128);
    list.forEach(([kp, th], idx) => { descriptor(kp, octs[kp.o], th, fold, desc, idx * 128); pts.push({ x: kp.x, y: kp.y, s: kp.sigma * (1 << kp.o), resp: kp.resp }); });
    return { pts, desc, n: pts.length, candidates: cands.length };
  }

  // ───────────────────────── matching ─────────────────────────
  function match(A, B, ratio, mutual) {
    const nA = A.n, nB = B.n, da = A.desc, db = B.desc;
    const bestRefDot = new Float32Array(nB).fill(-1), bestRefIdx = new Int32Array(nB).fill(-1);
    const res = new Array(nA);
    const colocal = (j, k) => k >= 0 && Math.abs(B.pts[j].x - B.pts[k].x) < 2 && Math.abs(B.pts[j].y - B.pts[k].y) < 2;
    for (let i = 0; i < nA; i++) {
      const ao = i * 128; let best = -2, second = -2, bj = -1;
      for (let j = 0; j < nB; j++) {
        const bo = j * 128; let dot = 0;
        for (let k = 0; k < 128; k += 4) dot += da[ao + k] * db[bo + k] + da[ao + k + 1] * db[bo + k + 1] + da[ao + k + 2] * db[bo + k + 2] + da[ao + k + 3] * db[bo + k + 3];
        if (dot > best) { if (!colocal(j, bj)) second = best; best = dot; bj = j; }
        else if (dot > second && !colocal(j, bj)) second = dot;
        if (dot > bestRefDot[j]) { bestRefDot[j] = dot; bestRefIdx[j] = i; }
      }
      res[i] = [bj, best, second];
    }
    const out = [];
    for (let i = 0; i < nA; i++) {
      const [bj, best, second] = res[i]; if (bj < 0) continue;
      const d1 = Math.sqrt(Math.max(0, 2 - 2 * best)), d2 = Math.sqrt(Math.max(0, 2 - 2 * second));
      if (d2 <= 0 || d1 / d2 >= ratio) continue;
      if (mutual && bestRefIdx[bj] !== i) continue;
      out.push({ a: i, b: bj, ratio: d1 / d2, dist: d1 });
    }
    out.sort((p, q) => p.ratio - q.ratio);
    // one correspondence per physical location pair (descriptors at several orientations collapse to one)
    const seen = new Set(), uniq = [];
    for (const m of out) { const key = Math.round(A.pts[m.a].x / 1.5) + ',' + Math.round(A.pts[m.a].y / 1.5) + '|' + Math.round(B.pts[m.b].x / 1.5) + ',' + Math.round(B.pts[m.b].y / 1.5); if (!seen.has(key)) { seen.add(key); uniq.push(m); } }
    return uniq;
  }

  // ───────────────────────── geometry ─────────────────────────
  // Model vector: [m00, m01, tx, m10, m11, ty]  (x' = m00 x + m01 y + tx)
  function fitSimilarity(P, Q, idx) {
    let mpx = 0, mpy = 0, mqx = 0, mqy = 0; const n = idx.length;
    for (const i of idx) { mpx += P[2 * i]; mpy += P[2 * i + 1]; mqx += Q[2 * i]; mqy += Q[2 * i + 1]; }
    mpx /= n; mpy /= n; mqx /= n; mqy /= n;
    let sd = 0, sdot = 0, scross = 0;
    for (const i of idx) { const px = P[2 * i] - mpx, py = P[2 * i + 1] - mpy, qx = Q[2 * i] - mqx, qy = Q[2 * i + 1] - mqy; sd += px * px + py * py; sdot += px * qx + py * qy; scross += px * qy - py * qx; }
    if (sd < 1e-9) return null;
    const a = sdot / sd, b = scross / sd;
    return [a, -b, mqx - (a * mpx - b * mpy), b, a, mqy - (b * mpx + a * mpy)];
  }
  function fitAffine(P, Q, idx) {
    let mpx = 0, mpy = 0, mqx = 0, mqy = 0; const n = idx.length;
    for (const i of idx) { mpx += P[2 * i]; mpy += P[2 * i + 1]; mqx += Q[2 * i]; mqy += Q[2 * i + 1]; }
    mpx /= n; mpy /= n; mqx /= n; mqy /= n;
    let a00 = 0, a01 = 0, a11 = 0, b00 = 0, b01 = 0, b10 = 0, b11 = 0;
    for (const i of idx) {
      const px = P[2 * i] - mpx, py = P[2 * i + 1] - mpy, qx = Q[2 * i] - mqx, qy = Q[2 * i + 1] - mqy;
      a00 += px * px; a01 += px * py; a11 += py * py; b00 += qx * px; b01 += qx * py; b10 += qy * px; b11 += qy * py;
    }
    const det = a00 * a11 - a01 * a01; if (Math.abs(det) < 1e-9 * (a00 + a11 + 1e-9) * (a00 + a11 + 1e-9)) return null;
    const i00 = a11 / det, i01 = -a01 / det, i11 = a00 / det;
    const m00 = b00 * i00 + b01 * i01, m01 = b00 * i01 + b01 * i11, m10 = b10 * i00 + b11 * i01, m11 = b10 * i01 + b11 * i11;
    return [m00, m01, mqx - (m00 * mpx + m01 * mpy), m10, m11, mqy - (m10 * mpx + m11 * mpy)];
  }
  const fit = (model, P, Q, idx) => (idx.length < (model === 'affine' ? 3 : 2) ? null : model === 'affine' ? fitAffine(P, Q, idx) : fitSimilarity(P, Q, idx));
  const apply = (H, x, y) => [H[0] * x + H[1] * y + H[2], H[3] * x + H[4] * y + H[5]];
  function invert(H) {
    const det = H[0] * H[4] - H[1] * H[3]; if (Math.abs(det) < 1e-14) return null;
    const a = H[4] / det, b = -H[1] / det, c = -H[3] / det, d = H[0] / det;
    return [a, b, -(a * H[2] + b * H[5]), c, d, -(c * H[2] + d * H[5])];
  }
  function compose(A, B) { // A∘B
    return [A[0] * B[0] + A[1] * B[3], A[0] * B[1] + A[1] * B[4], A[0] * B[2] + A[1] * B[5] + A[2], A[3] * B[0] + A[4] * B[3], A[3] * B[1] + A[4] * B[4], A[3] * B[2] + A[4] * B[5] + A[5]];
  }
  function decompose(H) {
    const sx = Math.hypot(H[0], H[3]), rot = Math.atan2(H[3], H[0]);
    const det = H[0] * H[4] - H[1] * H[3], sy = det / (sx || 1), shear = (H[0] * H[1] + H[3] * H[4]) / (sx * sx || 1);
    return { scaleX: sx, scaleY: sy, scale: Math.sqrt(Math.abs(det)), rotationDeg: rot * 180 / Math.PI, shear, tx: H[2], ty: H[5] };
  }
  function plausible(H, model) {
    if (!H) return false; const d = decompose(H);
    if (!(d.scaleX > 1 / 80 && d.scaleX < 80)) return false;
    if (model === 'affine') { if (d.scaleY <= 0) return false; const r = d.scaleY / d.scaleX; if (r < 0.35 || r > 2.9 || Math.abs(d.shear) > 0.6) return false; }
    return true;
  }

  function ransac(P, Q, nM, cfg, ref) {
    const rand = rng(cfg.seed), k = cfg.model === 'affine' ? 3 : 2, thr2 = cfg.thr * cfg.thr;
    let best = null, bestN = 0, bestSum = Infinity, iter = cfg.iter;
    const minSep = 0.04 * Math.max(ref.w, ref.h), pool = Math.min(nM, 1500);
    const score = (H) => { let n = 0, s = 0; for (let i = 0; i < nM; i++) { const x = H[0] * P[2 * i] + H[1] * P[2 * i + 1] + H[2] - Q[2 * i], y = H[3] * P[2 * i] + H[4] * P[2 * i + 1] + H[5] - Q[2 * i + 1], e = x * x + y * y; if (e < thr2) { n++; s += e; } } return [n, s]; };
    for (let it = 0; it < iter; it++) {
      const sample = []; let guard = 0;
      while (sample.length < k && guard++ < 50) {
        // bias toward confident matches (list is ratio-sorted) but never exclusively
        const i = rand() < 0.7 ? Math.floor(Math.pow(rand(), 1.6) * pool) : Math.floor(rand() * nM);
        if (sample.includes(i)) continue;
        if (sample.some(j => Math.hypot(P[2 * i] - P[2 * j], P[2 * i + 1] - P[2 * j + 1]) < minSep || Math.hypot(Q[2 * i] - Q[2 * j], Q[2 * i + 1] - Q[2 * j + 1]) < minSep * 0.2)) continue;
        sample.push(i);
      }
      if (sample.length < k) continue;
      const H = fit(cfg.model, P, Q, sample); if (!plausible(H, cfg.model)) continue;
      const [n, s] = score(H);
      if (n > bestN || (n === bestN && s < bestSum)) {
        best = H; bestN = n; bestSum = s;
        const w = n / nM; if (w > 0.02) iter = Math.min(iter, Math.ceil(Math.log(1 - 0.9995) / Math.log(1 - Math.pow(w, k) + 1e-12)) + 200);
      }
    }
    if (!best || bestN < k + 1) return null;
    // local optimisation: refit on all inliers, re-select, repeat until stable
    let H = best, inl = [];
    for (let r = 0; r < 8; r++) {
      inl = []; for (let i = 0; i < nM; i++) { const x = H[0] * P[2 * i] + H[1] * P[2 * i + 1] + H[2] - Q[2 * i], y = H[3] * P[2 * i] + H[4] * P[2 * i + 1] + H[5] - Q[2 * i + 1]; if (x * x + y * y < thr2) inl.push(i); }
      const H2 = fit(cfg.model, P, Q, inl); if (!plausible(H2, cfg.model)) break;
      const moved = Math.abs(H2[2] - H[2]) + Math.abs(H2[5] - H[5]); H = H2; if (moved < 1e-4) break;
    }
    inl = []; for (let i = 0; i < nM; i++) { const x = H[0] * P[2 * i] + H[1] * P[2 * i + 1] + H[2] - Q[2 * i], y = H[3] * P[2 * i] + H[4] * P[2 * i + 1] + H[5] - Q[2 * i + 1]; if (x * x + y * y < thr2) inl.push(i); }
    return { H, inliers: inl };
  }

  function residuals(H, P, Q, idx) {
    return idx.map(i => { const x = H[0] * P[2 * i] + H[1] * P[2 * i + 1] + H[2] - Q[2 * i], y = H[3] * P[2 * i] + H[4] * P[2 * i + 1] + H[5] - Q[2 * i + 1]; return Math.hypot(x, y); });
  }
  const rms = (a) => (a.length ? Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length) : NaN);
  function quantile(a, q) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

  // ───────────────────────── distribution ─────────────────────────
  function distribution(Hn, srcN, refN, refPts, G, cap, resid) {
    // eligible cells: centre lies in the reference frame AND maps back into the source frame
    const inv = invert(Hn), counts = new Array(G * G).fill(0), eligible = new Array(G * G).fill(false), cellOf = new Array(refPts.length);
    for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
      const cx = (gx + 0.5) / G * refN.w, cy = (gy + 0.5) / G * refN.h, s = inv ? apply(inv, cx, cy) : [-1, -1];
      eligible[gy * G + gx] = s[0] >= 0 && s[0] < srcN.w && s[1] >= 0 && s[1] < srcN.h;
    }
    const perCell = Array.from({ length: G * G }, () => []);
    refPts.forEach((p, i) => { const c = clamp((p[1] / refN.h * G) | 0, 0, G - 1) * G + clamp((p[0] / refN.w * G) | 0, 0, G - 1); cellOf[i] = c; counts[c]++; perCell[c].push(i); });
    const selected = new Array(refPts.length).fill(false);
    for (const list of perCell) { list.sort((a, b) => resid[a] - resid[b]); for (let k = 0; k < Math.min(cap, list.length); k++) selected[list[k]] = true; }
    const elig = eligible.filter(Boolean).length, occupied = counts.filter((c, i) => c > 0 && eligible[i]).length;
    let ent = 0, tot = 0; counts.forEach((c, i) => { if (eligible[i]) tot += c; });
    counts.forEach((c, i) => { if (eligible[i] && c > 0) { const p = c / tot; ent -= p * Math.log(p); } });
    return { grid: G, counts, eligible, coverage: elig ? occupied / elig : 0, uniformity: elig > 1 ? ent / Math.log(elig) : 0, selected, selectedCount: selected.filter(Boolean).length, eligibleCells: elig, occupiedCells: occupied };
  }

  function holdout(P, Q, inl, Hn_unused, model, G, ref) {
    // spatial holdout: fit on checkerboard half A, test on half B (and vice-versa).
    const cell = i => (clamp((Q[2 * i + 1] / ref.h * G) | 0, 0, G - 1) + clamp((Q[2 * i] / ref.w * G) | 0, 0, G - 1)) & 1;
    const A = inl.filter(i => cell(i) === 0), B = inl.filter(i => cell(i) === 1), need = model === 'affine' ? 8 : 6;
    if (A.length < need || B.length < need) return null;
    const errs = [];
    for (const [fitSet, testSet] of [[A, B], [B, A]]) { const H = fit(model, P, Q, fitSet); if (!H) return null; errs.push(...residuals(H, P, Q, testSet)); }
    return rms(errs);
  }

  // ───────────────────────── registration driver ─────────────────────────
  function prepImage(img, cfg) {
    const f = toFloat(img.data), longest = Math.max(img.w, img.h), k = Math.min(1, cfg.workRes / longest);
    const r = k < 1 ? resize(f, img.w, img.h, img.w * k, img.h * k) : { data: f, w: img.w, h: img.h };
    return { data: r.data, w: r.w, h: r.h, k: r.w / img.w, ky: r.h / img.h };
  }

  function sensorPrior(srcGsd, refGsd) { return srcGsd && refGsd ? srcGsd / refGsd : 1; }

  /** Register `src` (moving) onto `ref` (fixed). Returns the full result object. */
  function register(src, ref, userCfg, progress = () => {}) {
    const cfg = Object.assign({}, DEFAULTS, userCfg || {}), t0 = Date.now(), warnings = [];
    progress('normalize', 0.03, 'Normalising observations');
    const S0 = prepImage(src, cfg), R0 = prepImage(ref, cfg);
    const refImg = preprocess(R0.data, R0.w, R0.h, cfg.pre);
    progress('detect', 0.12, 'Detecting reference features');
    const refF = features(refImg, R0.w, R0.h, { sens: cfg.sens, maxKp: cfg.maxKp, pre: cfg.pre }, false);

    const prior = clamp(cfg.scalePrior * R0.k / S0.k, 1 / 16, 16);   // source-work px → reference-work px
    const candidates = cfg.sweep ? [prior / 2, prior / 1.41, prior, prior * 1.41, prior * 2] : [prior];
    let best = null, tried = [];
    candidates.forEach((sc, ci) => {
      const base = 0.2 + 0.6 * ci / candidates.length, span = 0.6 / candidates.length;
      progress('detect', base, cfg.sweep ? `Scale hypothesis ${ci + 1}/${candidates.length} · ×${sc.toFixed(3)}` : 'Detecting source features');
      const sw = Math.round(S0.w * sc), sh = Math.round(S0.h * sc);
      if (sw < 64 || sh < 64) { tried.push({ scale: sc, inliers: 0, skipped: true }); return; }
      if (sw > 3000 || sh > 3000) { tried.push({ scale: sc, inliers: 0, skipped: true }); return; }
      const rs = Math.abs(sc - 1) > 1e-3 ? resize(S0.data, S0.w, S0.h, sw, sh) : { data: S0.data, w: S0.w, h: S0.h };
      const srcImg = preprocess(rs.data, rs.w, rs.h, cfg.pre);
      const srcF = features(srcImg, rs.w, rs.h, { sens: cfg.sens, maxKp: cfg.maxKp, pre: cfg.pre }, true);
      progress('match', base + span * 0.5, 'Matching descriptors');
      const ms = match(srcF, refF, cfg.ratio, cfg.mutual);
      const nM = ms.length, P = new Float64Array(nM * 2), Q = new Float64Array(nM * 2);
      ms.forEach((m, i) => { const a = srcF.pts[m.a], b = refF.pts[m.b]; P[2 * i] = a.x; P[2 * i + 1] = a.y; Q[2 * i] = b.x; Q[2 * i + 1] = b.y; });
      progress('verify', base + span * 0.8, 'Verifying geometry');
      const r = nM >= 4 ? ransac(P, Q, nM, cfg, R0) : null;
      tried.push({ scale: sc, candidates: nM, inliers: r ? r.inliers.length : 0, srcKeypoints: srcF.n });
      if (r && (!best || r.inliers.length > best.r.inliers.length)) best = { r, ms, P, Q, srcF, sc, rs: { w: rs.w, h: rs.h } };
    });
    if (!best) return { ok: false, reason: 'No geometrically consistent correspondences were found. Try another mode (Sun-angle or cross-modal), a looser ratio, or confirm the two images overlap.', tried, timings: { total: Date.now() - t0 }, refKeypoints: refF.n };

    progress('verify', 0.9, 'Refining transform');
    const { r, ms, P, Q, srcF, sc } = best;
    // Hsc: source-work → pre-scaled source; Hwork maps pre-scaled source → reference work coordinates
    let H = r.H, inl = r.inliers;
    // final refinement: tighten threshold once the model is good, to expose sub-pixel behaviour
    const tight = Math.max(0.75, Math.min(cfg.thr, 1.5));
    if (inl.length > 12) {
      for (let k = 0; k < 4; k++) {
        const res = residuals(H, P, Q, inl), cut = Math.max(tight, Math.min(cfg.thr, quantile(res, 0.9) * 1.5));
        const keep = inl.filter((i, j) => res[j] <= cut), H2 = fit(cfg.model, P, Q, keep.length >= 6 ? keep : inl); if (H2 && plausible(H2, cfg.model)) H = H2;
        const all = []; for (let i = 0; i < ms.length; i++) { const x = H[0] * P[2 * i] + H[1] * P[2 * i + 1] + H[2] - Q[2 * i], y = H[3] * P[2 * i] + H[4] * P[2 * i + 1] + H[5] - Q[2 * i + 1]; if (x * x + y * y < cfg.thr * cfg.thr) all.push(i); } inl = all;
      }
    }
    const inSet = new Set(inl);
    // native-coordinate transform: source native → source work → pre-scale → reference work → reference native
    const Ssrc = [S0.k, 0, 0, 0, S0.ky, 0], Spre = [sc, 0, 0, 0, sc, 0], Rinv = [1 / R0.k, 0, 0, 0, 1 / R0.ky, 0];
    const Hn = compose(Rinv, compose(H, compose(Spre, Ssrc)));
    const dec = decompose(Hn);
    // per-match native coordinates and residuals (in reference native px and source native px)
    const matches = new Float32Array(ms.length * 7), nativeRef = [], resRef = [];
    ms.forEach((m, i) => {
      const a = srcF.pts[m.a], b = refF.pts[m.b];
      const sx = a.x / sc / S0.k, sy = a.y / sc / S0.ky, rx = b.x / R0.k, ry = b.y / R0.ky;
      const p = apply(Hn, sx, sy), e = Math.hypot(p[0] - rx, p[1] - ry);
      matches.set([sx, sy, rx, ry, e, inSet.has(i) ? 1 : 0, m.ratio], i * 7);
      if (inSet.has(i)) { nativeRef.push([rx, ry]); resRef.push(e); }
    });
    const rmseRef = rms(resRef), srcScale = dec.scale || 1;
    const inlIdxNative = [...inSet];
    const dist = distribution(Hn, { w: src.w, h: src.h }, { w: ref.w, h: ref.h }, nativeRef, cfg.grid, cfg.cap, resRef);
    // holdout in work space, reported in reference native px
    const hoWork = holdout(P, Q, inl, null, cfg.model, 4, R0);
    const hoRef = hoWork == null ? null : hoWork / R0.k;
    const out = {
      ok: true, version: VERSION, cfg,
      H: Hn, decomposed: dec,
      metrics: {
        candidates: ms.length, inliers: inl.length, inlierRatio: inl.length / Math.max(1, ms.length),
        rmseRefPx: rmseRef, rmseSrcPx: rmseRef / srcScale, medianRefPx: quantile(resRef, 0.5), p95RefPx: quantile(resRef, 0.95), maxRefPx: Math.max(...resRef),
        holdoutRefPx: hoRef, holdoutSrcPx: hoRef == null ? null : hoRef / srcScale,
        refKeypoints: refF.n, srcKeypoints: srcF.n, coverage: dist.coverage, uniformity: dist.uniformity, selected: dist.selectedCount,
        subpixel: rmseRef / srcScale < 1
      },
      dist, matches, tried, warnings,
      sizes: { src: [src.w, src.h], ref: [ref.w, ref.h], work: { src: [S0.w, S0.h], ref: [R0.w, R0.h] } },
      timings: { total: Date.now() - t0 }
    };
    // selected flags aligned to inlier order
    const selFlags = new Uint8Array(ms.length); let q = 0; ms.forEach((m, i) => { if (inSet.has(i)) { if (dist.selected[q]) selFlags[i] = 1; q++; } });
    out.selectedFlags = selFlags; delete out.dist.selected;
    if (cfg.pre !== 'raw') out.preview = { src: previewOf(S0, cfg.pre), ref: previewOf(R0, cfg.pre) };
    progress('done', 1, 'Registered');
    return out;
  }

  function previewOf(img, pre) {
    const maxSide = 420, k = Math.min(1, maxSide / Math.max(img.w, img.h)), r = k < 1 ? resize(img.data, img.w, img.h, img.w * k, img.h * k) : img;
    const norm = preprocess(r.data, r.w, r.h, pre), u8 = new Uint8ClampedArray(norm.length);
    let lo = Infinity, hi = -Infinity; for (const v of norm) { if (v < lo) lo = v; if (v > hi) hi = v; }
    for (let i = 0; i < norm.length; i++) u8[i] = ((norm[i] - lo) / (hi - lo || 1)) * 255;
    return { w: r.w, h: r.h, data: u8 };
  }

  // ───────────────────────── warp ─────────────────────────
  /** Resample `src` (Uint8 gray) into the reference frame. Output pixel (u,v) ↔ reference native (u/scale, v/scale). */
  function warp(src, Hn, refW, refH, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(refW, refH)), ow = Math.round(refW * scale), oh = Math.round(refH * scale), inv = invert(Hn);
    const out = new Uint8ClampedArray(ow * oh), mask = new Uint8Array(ow * oh);
    if (!inv) return { w: ow, h: oh, scale, data: out, mask };
    for (let v = 0; v < oh; v++) for (let u = 0; u < ow; u++) {
      const x = (u + 0.5) / scale - 0.5, y = (v + 0.5) / scale - 0.5, sx = inv[0] * x + inv[1] * y + inv[2], sy = inv[3] * x + inv[4] * y + inv[5];
      if (sx < 0 || sy < 0 || sx > src.w - 1 || sy > src.h - 1) continue;
      const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(src.w - 1, x0 + 1), y1 = Math.min(src.h - 1, y0 + 1), wx = sx - x0, wy = sy - y0;
      const a = src.data[y0 * src.w + x0], b = src.data[y0 * src.w + x1], c = src.data[y1 * src.w + x0], d = src.data[y1 * src.w + x1];
      out[v * ow + u] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy; mask[v * ow + u] = 1;
    }
    return { w: ow, h: oh, scale, data: out, mask };
  }

  // ───────────────────────── synthetic ground truth ─────────────────────────
  /** Build a moving image from `ref` with a known similarity transform, illumination change and sensor noise. */
  function synthesize(ref, opt = {}) {
    const rand = rng(opt.seed || 11), rot = ((opt.rotation != null ? opt.rotation : (rand() * 50 - 25))) * Math.PI / 180, s = opt.scale != null ? opt.scale : 0.7 + rand() * 0.7;
    const ow = Math.round(ref.w * 0.62 * (opt.sizeScale || 1) / s * Math.min(1, s * 1.6)), oh = Math.round(ref.h * 0.62 * (opt.sizeScale || 1) / s * Math.min(1, s * 1.6));
    // H_true: moving(x',y') → reference. x = s·R·(x'−cx) + c_ref + jitter  (moving shows a window of ref)
    const cx = ow / 2, cy = oh / 2, jx = (rand() - 0.5) * ref.w * 0.2, jy = (rand() - 0.5) * ref.h * 0.2;
    const ca = Math.cos(rot), sa = Math.sin(rot), a = s * ca, b = s * sa;
    const tx = ref.w / 2 + jx - (a * cx - b * cy), ty = ref.h / 2 + jy - (b * cx + a * cy);
    const H = [a, -b, tx, b, a, ty], data = new Uint8ClampedArray(ow * oh), gamma = opt.gamma || 1.35, ramp = opt.ramp != null ? opt.ramp : 0.45, noise = opt.noise != null ? opt.noise : 5, ang = rand() * Math.PI * 2;
    for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
      const sx = H[0] * x + H[1] * y + H[2], sy = H[3] * x + H[4] * y + H[5];
      let v = 0;
      if (sx >= 0 && sy >= 0 && sx <= ref.w - 1 && sy <= ref.h - 1) {
        const x0 = sx | 0, y0 = sy | 0, x1 = Math.min(ref.w - 1, x0 + 1), y1 = Math.min(ref.h - 1, y0 + 1), wx = sx - x0, wy = sy - y0;
        v = (ref.data[y0 * ref.w + x0] * (1 - wx) + ref.data[y0 * ref.w + x1] * wx) * (1 - wy) + (ref.data[y1 * ref.w + x0] * (1 - wx) + ref.data[y1 * ref.w + x1] * wx) * wy;
      }
      const t = ((x / ow - 0.5) * Math.cos(ang) + (y / oh - 0.5) * Math.sin(ang)) + 0.5, shade = 1 - ramp + 2 * ramp * t;
      v = 255 * Math.pow(v / 255, gamma) * shade + (rand() + rand() + rand() - 1.5) * noise * 1.6;
      data[y * ow + x] = clamp(v, 0, 255);
    }
    return { img: { w: ow, h: oh, data }, H, params: { rotationDeg: rot * 180 / Math.PI, scale: s, gamma, ramp, noise } };
  }

  /** Compare an estimated transform with a known one over a grid inside the moving image. Returns px RMSE in reference and moving pixels. */
  function transformError(Hest, Htrue, w, h) {
    const e = []; for (let gy = 1; gy < 10; gy++) for (let gx = 1; gx < 10; gx++) { const x = gx / 10 * w, y = gy / 10 * h, p = apply(Hest, x, y), q = apply(Htrue, x, y); e.push(Math.hypot(p[0] - q[0], p[1] - q[1])); }
    const sc = decompose(Htrue).scale || 1;
    return { rmseRef: rms(e), rmseSrc: rms(e) / sc, max: Math.max(...e) };
  }

  function selfTest(ref, userCfg, progress = () => {}) {
    const syn = synthesize(ref, { seed: (userCfg && userCfg.seed) || 11 });
    const res = register(syn.img, ref, Object.assign({}, userCfg, { scalePrior: 1 }), progress);
    const out = { ok: res.ok, synthetic: syn.params, size: [syn.img.w, syn.img.h], moving: syn.img, Htrue: syn.H };
    if (res.ok) { out.error = transformError(res.H, syn.H, syn.img.w, syn.img.h); out.metrics = res.metrics; out.H = res.H; out.timings = res.timings; } else out.reason = res.reason;
    return out;
  }

  // ───────────────────────── benchmark ─────────────────────────
  function benchmark(src, ref, userCfg, progress = () => {}) {
    const combos = [['raw', 'similarity'], ['raw', 'affine'], ['illum', 'similarity'], ['illum', 'affine'], ['struct', 'similarity'], ['struct', 'affine']], rows = [];
    combos.forEach(([pre, model], i) => {
      const t = Date.now(), cfg = Object.assign({}, userCfg, { pre, model });
      const r = register(src, ref, cfg, (s, p, m) => progress('benchmark', (i + p) / combos.length, `${pre} · ${model} — ${m}`));
      rows.push({ pre, model, ok: r.ok, metrics: r.ok ? r.metrics : null, seconds: (Date.now() - t) / 1000, result: r });
    });
    const passing = rows.filter(r => r.ok && r.metrics.rmseSrcPx < 1), pool = passing.length ? passing : rows.filter(r => r.ok);
    const best = pool.sort((a, b) => b.metrics.inliers - a.metrics.inliers)[0] || null;
    return { rows, best: best ? best.result : null, bestKey: best ? best.pre + '/' + best.model : null };
  }

  /** Recompute distribution + grid-balanced selection from stored matches (used by the live Titan controls). */
  function redistribute(matches, Hn, srcSize, refSize, G, cap) {
    const pts = [], res = [], idx = [];
    for (let i = 0; i < matches.length / 7; i++) if (matches[i * 7 + 5]) { pts.push([matches[i * 7 + 2], matches[i * 7 + 3]]); res.push(matches[i * 7 + 4]); idx.push(i); }
    const d = distribution(Hn, { w: srcSize[0], h: srcSize[1] }, { w: refSize[0], h: refSize[1] }, pts, G, cap, res);
    const flags = new Uint8Array(matches.length / 7); idx.forEach((m, q) => { if (d.selected[q]) flags[m] = 1; });
    delete d.selected; return { dist: d, selectedFlags: flags };
  }

  const Engine = { VERSION, redistribute, DEFAULTS, register, warp, synthesize, transformError, selfTest, benchmark, sensorPrior, apply, invert, decompose };
  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  root.StardustEngine = Engine;

  // ───────────────────────── worker protocol ─────────────────────────
  if (typeof importScripts === 'function' && typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
    self.onmessage = (e) => {
      const { id, type, payload } = e.data, prog = (stage, pct, msg) => self.postMessage({ id, type: 'progress', stage, pct, msg });
      try {
        if (type === 'register') {
          const r = register(payload.src, payload.ref, payload.cfg, prog);
          if (r.ok && payload.warp !== false) { const w = warp(payload.src, r.H, payload.ref.w, payload.ref.h, payload.warpMax || 2400); r.warp = w; self.postMessage({ id, type: 'result', result: r }, [r.matches.buffer, w.data.buffer, w.mask.buffer, r.selectedFlags.buffer]); }
          else self.postMessage({ id, type: 'result', result: r });
        } else if (type === 'selftest') {
          const r = selfTest(payload.ref, payload.cfg, prog); self.postMessage({ id, type: 'result', result: r });
        } else if (type === 'benchmark') {
          const b = benchmark(payload.src, payload.ref, payload.cfg, prog);
          const rows = b.rows.map(({ result, ...rest }) => rest);
          let best = b.best; if (best && best.ok) { best.warp = warp(payload.src, best.H, payload.ref.w, payload.ref.h, payload.warpMax || 2400); }
          self.postMessage({ id, type: 'result', result: { rows, bestKey: b.bestKey, best } });
        }
      } catch (err) { self.postMessage({ id, type: 'error', message: String(err && err.stack || err) }); }
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
