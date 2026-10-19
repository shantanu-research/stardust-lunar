/* Tiny WebGL helper: one full-screen triangle, one fragment shader, uniforms by name. */
export function createShader(canvas, fragSrc, { premultiplied = true } = {}) {
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: premultiplied, antialias: false, powerPreference: 'low-power' });
  if (!gl) return null;
  const vs = 'attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}';
  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { console.warn(gl.getShaderInfoLog(s)); return null; } return s; };
  const v = compile(gl.VERTEX_SHADER, vs), f = compile(gl.FRAGMENT_SHADER, fragSrc); if (!v || !f) return null;
  const prog = gl.createProgram(); gl.attachShader(prog, v); gl.attachShader(prog, f); gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'a'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const cache = {}, U = (n) => cache[n] ??= gl.getUniformLocation(prog, n);
  return {
    gl, size(w, h) { canvas.width = w; canvas.height = h; gl.viewport(0, 0, w, h); },
    set(n, ...v) { const l = U(n); if (l == null) return; ({ 1: () => gl.uniform1f(l, v[0]), 2: () => gl.uniform2f(l, v[0], v[1]), 3: () => gl.uniform3f(l, v[0], v[1], v[2]), 4: () => gl.uniform4f(l, v[0], v[1], v[2], v[3]) })[v.length](); },
    draw(r) { gl.disable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); if (r) { gl.enable(gl.SCISSOR_TEST); gl.scissor(r[0], r[1], r[2], r[3]); } gl.drawArrays(gl.TRIANGLES, 0, 3); },
    dispose() { const e = gl.getExtension('WEBGL_lose_context'); e && e.loseContext(); }
  };
}

/** Frame-time governor: call tick(now) once per frame; onScale(q) receives a render-resolution factor in [min,1]. */
export function governor(onScale, { min = .4, target = 20 } = {}) {
  let last = 0, ema = 16, q = 1, slow = 0, fast = 0;
  return { get q() { return q; }, tick(now) {
    if (last) { const dt = Math.min(now - last, 100); ema += (dt - ema) * .1; if (ema > target) { slow++; fast = 0; } else if (ema < target * .6) { fast++; slow = 0; } else { slow = fast = 0; } }
    last = now;
    if (slow > 24 && q > min) { q = Math.max(min, q * .82); slow = 0; ema = 16; onScale(q); document.body.classList.add('perf-low'); }
    else if (fast > 240 && q < 1) { q = Math.min(1, q * 1.1); fast = 0; onScale(q); }
  }, reset() { last = 0; } };
}

export const NOISE_GLSL = `
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*noise(p);p=p*2.02+vec2(17.3,9.1);a*=.5;}return v;}
`;
