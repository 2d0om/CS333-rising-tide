// src/seashader.js — a calm moving light over the water communities (Member 2)
//
// The colour of every community is drawn by the map itself, exactly from the data. This layer
// only adds light: long slow swells and fine ripples, rendered as a faint highlight/shadow
// (at most ~10% opacity) and clipped to the water communities by the map. It never changes
// which colour a community has, so the depth encoding reads the same with or without it.
// Returns null without WebGL; the map then simply has still water.

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform vec2 uSize;     // CSS px
uniform float uTime;    // seconds

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
vec2 wave(vec2 p, vec2 dir, float len, float amp, float speed, float t, float warp) {
  float k = 6.2832 / len;
  return dir * (k * amp * cos(dot(dir, p) * k - t * speed + warp));
}

void main() {
  vec2 p = vec2(vUv.x, 1.0 - vUv.y) * uSize;
  float t = uTime;
  float warp = noise(p / 140.0 + vec2(t * 0.015, -t * 0.01)) * 6.2832;
  // swell rolling in from the Gulf (north-west), with a cross-swell and fine ripples
  vec2 g = wave(p, normalize(vec2(0.80, 0.60)), 90.0, 2.4, 0.55, t, warp)
         + wave(p, normalize(vec2(0.55, 0.85)), 52.0, 1.2, 0.75, t, warp * 0.6)
         + wave(p, normalize(vec2(0.95, 0.30)), 26.0, 0.45, 1.05, t, 1.3);
  vec2 q = p / 12.0 + vec2(t * 0.12, t * 0.08);
  float n0 = noise(q);
  g += vec2(noise(q + vec2(0.2, 0.0)) - n0, noise(q + vec2(0.0, 0.2)) - n0) * 0.35;
  vec3 n = normalize(vec3(-g * 0.6, 1.0));
  vec3 L = normalize(vec3(-0.45, -0.55, 0.70));
  float l = dot(n, L) - L.z;                       // > 0 faces the sun, < 0 faces away
  float a = l > 0.0 ? min(l * 0.55, 0.10) : min(-l * 0.45, 0.08);
  vec3 c = l > 0.0 ? vec3(1.0) : vec3(0.04, 0.12, 0.22);
  gl_FragColor = vec4(c * a, a);                   // premultiplied alpha
}`;

export function createSeaLight(width, height) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
  const shader = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch (e) { console.warn('View B: water light unavailable.', e); return null; }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.uniform2f(gl.getUniformLocation(prog, 'uSize'), width, height);
  const uTime = gl.getUniformLocation(prog, 'uTime');
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  let lost = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });
  return {
    canvas,
    draw(seconds) {
      if (lost) return;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(uTime, seconds);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
}
