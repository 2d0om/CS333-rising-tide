// src/seashader.js — the water itself, drawn on the GPU (Member 2)
//
// Input: one texel per grid cell from waterfield.pack(): R = share of homes out of reach,
// G = signed distance to the coastline, B = inside the data. Output, per screen pixel:
//   colour  — exactly the depth colour of the encoding (the ramp), only lit, never re-coloured;
//   waves   — four travelling wave trains plus fine ripples tilt a surface normal, lit by a
//             low sun from the north-west: soft shading and sharp sun glints;
//   shallows— moving caustic light near the shore;
//   shore   — foam lines that roll in toward the coast and break, swash running up the sand,
//             darker wet sand just above the waterline;
//   sand    — fine grain and faint wind ripples.
// Lighting changes brightness by a few percent at most, so the depth colours still read.
// Returns null when WebGL is not available (View B then falls back to a plain gradient).

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uField;
uniform sampler2D uRamp;
uniform vec2 uSize;      // canvas size in CSS px
uniform float uTime;     // seconds
uniform vec2 uDist;      // distance encoding: (offset, span) in px
uniform float uPx;       // device pixels per CSS px

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// slope of one travelling wave (direction, wavelength px, amplitude, speed, phase warp)
vec2 wave(vec2 p, vec2 dir, float len, float amp, float speed, float t, float warp) {
  float k = 6.2832 / len;
  return dir * (k * amp * cos(dot(dir, p) * k - t * speed + warp));
}
vec2 slope(vec2 p, float t) {
  float warp = noise(p / 110.0 + vec2(t * 0.02, t * 0.013)) * 6.2832;   // breaks up the regular crests
  vec2 g = wave(p, normalize(vec2(0.80, 0.60)), 64.0, 1.60, 0.80, t, warp)
         + wave(p, normalize(vec2(0.55, 0.85)), 39.0, 0.95, 1.10, t, warp * 0.7)
         + wave(p, normalize(vec2(0.97, 0.25)), 23.0, 0.50, 1.50, t, warp * 0.4)
         + wave(p, normalize(vec2(0.30, 0.95)), 13.0, 0.22, 2.10, t, 1.7);
  vec2 q = p / 10.0 + vec2(t * 0.22, t * 0.14);
  float n0 = noise(q);
  g += vec2(noise(q + vec2(0.17, 0.0)) - n0, noise(q + vec2(0.0, 0.17)) - n0) * 0.55;  // fine ripples
  return g;
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec2 p = uv * uSize;                  // CSS px, y down
  vec4 F = texture2D(uField, uv);
  vec3 base = texture2D(uRamp, vec2(F.r, 0.5)).rgb;
  if (F.b < 0.5) { gl_FragColor = vec4(base, 1.0); return; }   // outside the data: clipped anyway
  float t = uTime;
  float sd = F.g * uDist.y - uDist.x;   // px to the coastline, positive in the water
  float water = smoothstep(0.494, 0.506, F.r);

  // ---- sand ----
  float grain = hash(floor(gl_FragCoord.xy)) - 0.5;
  float dunes = sin(dot(p, vec2(0.55, 0.83)) * 0.42 + noise(p / 26.0) * 8.0);
  vec3 sand = base * (1.0 + grain * 0.045 + dunes * 0.007);
  float wet = smoothstep(-16.0, -1.0, sd);
  sand *= 1.0 - 0.13 * wet;              // darker wet sand above the waterline
  float swashReach = 3.0 + 2.6 * sin(t * 0.85 + noise(p / 46.0) * 6.2832);
  float film = smoothstep(-swashReach - 0.8, -swashReach + 0.8, sd) * (1.0 - water);
  sand = mix(sand, mix(sand, vec3(0.42, 0.62, 0.78), 0.35), film);          // thin sheet of water
  sand = mix(sand, vec3(1.0), exp(-abs(sd + swashReach) / 1.1) * 0.55 * (1.0 - water));   // its foamy edge

  // ---- water ----
  vec3 n = normalize(vec3(-slope(p, t) * 0.6, 1.0));
  vec3 L = normalize(vec3(-0.45, -0.55, 0.70));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float depth = clamp((F.r - 0.5) / 0.5, 0.0, 1.0);
  float shade = 1.0 + (dot(n, L) - L.z) * 0.5;
  vec3 col = base * shade;
  float fres = pow(1.0 - n.z, 3.0);
  col += vec3(0.80, 0.90, 1.0) * fres * 0.22;                     // sky in the wave faces
  // sun glints: sharp, and only in drifting patches, the way light catches a real sea
  float patches = smoothstep(0.52, 0.85, noise(p / 70.0 + vec2(t * 0.04, -t * 0.03)));
  float nh = max(dot(n, H), 0.0);
  col += vec3(1.0, 0.98, 0.92) * (pow(nh, 420.0) * 0.95 * patches + pow(nh, 18.0) * 0.05);
  // caustics: bright moving net in the shallows near the shore
  float c1 = 1.0 - abs(2.0 * noise(p / 17.0 + vec2(t * 0.11, t * 0.07)) - 1.0);
  float c2 = 1.0 - abs(2.0 * noise(p / 12.0 - vec2(t * 0.08, -t * 0.05) + 7.3) - 1.0);
  float shallow = (1.0 - smoothstep(0.0, 0.45, depth)) * smoothstep(70.0, 6.0, sd);
  col += vec3(0.85, 0.95, 1.0) * pow(c1 * c2, 6.0) * 0.30 * shallow;
  // foam: lines that roll toward the coast and break on it
  float breakup = smoothstep(0.25, 0.72, noise(p / 4.5 + vec2(t * 0.25, -t * 0.1)));
  float roll = smoothstep(0.78, 1.0, sin(sd * 0.24 + t * 1.5 + noise(p / 28.0) * 2.4));
  float foam = exp(-max(sd, 0.0) / 3.0) * (0.6 + 0.4 * breakup)
             + roll * smoothstep(48.0, 6.0, sd) * breakup * 0.8;
  col = mix(col, vec3(0.97, 0.99, 1.0), clamp(foam, 0.0, 1.0) * 0.85);

  gl_FragColor = vec4(mix(sand, col, water), 1.0);
}`;

export function createSeaRenderer({ box, gw, gh, distRange, lut }) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false });
  if (!gl) return null;
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  canvas.width = Math.round(box.width * dpr); canvas.height = Math.round(box.height * dpr);
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
  } catch (e) { console.warn('View B: water shader unavailable, using flat gradient.', e); return null; }
  gl.useProgram(prog);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  const texture = (unit, w, h, data) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    return t;
  };
  const ramp = new Uint8Array(256 * 4);
  for (let j = 0; j < 256; j++) { ramp.set([lut[j * 3], lut[j * 3 + 1], lut[j * 3 + 2], 255], j * 4); }
  const fieldTex = texture(0, gw, gh, new Uint8Array(gw * gh * 4));
  texture(1, 256, 1, ramp);

  const U = name => gl.getUniformLocation(prog, name);
  gl.uniform1i(U('uField'), 0);
  gl.uniform1i(U('uRamp'), 1);
  gl.uniform2f(U('uSize'), box.width, box.height);
  gl.uniform2f(U('uDist'), distRange[0], distRange[1]);
  gl.uniform1f(U('uPx'), dpr);
  const uTime = U('uTime');
  gl.viewport(0, 0, canvas.width, canvas.height);

  let lost = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });

  return {
    canvas,
    get ok() { return !lost; },
    setField(packed) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fieldTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gw, gh, gl.RGBA, gl.UNSIGNED_BYTE, packed);
    },
    draw(seconds) {
      if (lost) return;
      gl.uniform1f(uTime, seconds);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  };
}
