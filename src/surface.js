// src/surface.js — the moving water and the fog, drawn on the GPU over the map (Member 2)
//
// The map's colours are drawn by the SVG underneath, exactly from the data. This one transparent
// layer only adds movement on top, inside masks rasterised from the same community shapes:
//   water — a warped wave surface lit by a low sun: darker troughs, lighter faces, the sky mirrored
//           in the slopes, a soft highlight on the crests, and foam that laps along the coast;
//   fog   — 3D clouds over communities with too few sales that churn in place (time is the third
//           axis of the noise), lit from one side so they have volume, never fully opaque.
// Names, borders, the coastline and selections are drawn in an SVG above this layer, so they
// stay sharp through the fog. When the sea moves, the old and new masks cross-fade, so water,
// foam and fog glide to their new places instead of jumping.
// Returns null without WebGL: the map then shows still water and hatched fog.

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uA;      // masks before the change: r = water, g = fog, b = land (blurred)
uniform sampler2D uB;      // masks after the change
uniform float uMix;        // 0 -> 1 while the change plays
uniform vec2 uSize;        // CSS px
uniform float uTime;       // seconds

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise(p); p = p * 2.03 + vec2(17.1, 9.2); a *= 0.5; }
  return v;
}
// 3D value noise: the third axis is time, so the fog churns where it is instead of sliding away
float hash3(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.x + p.y) * p.z); }
float noise3(vec3 p) {
  vec3 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), u.x), mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), u.x), u.y);
  float b = mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), u.x), mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z);
}
float fbm3(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += a * noise3(p); p = p * 2.02 + vec3(11.3, 7.1, 3.7); a *= 0.5; }
  return v;
}

// Water surface height: three swells from the Gulf, bent by a slow warp so crests are never straight,
// plus fine wind ripples. Everything moves slowly and continuously.
float sea(vec2 p, float t) {
  vec2 w = vec2(fbm(p / 210.0 + vec2(t * 0.010, 0.0)), fbm(p / 210.0 + vec2(5.2, t * 0.008))) - 0.5;
  vec2 q = p + w * 90.0;
  float h = 0.0;
  h += sin(dot(q, vec2(0.80, 0.60)) / 15.0 - t * 0.75) * 0.50;
  h += sin(dot(q, vec2(0.45, 0.89)) / 9.5 - t * 1.00) * 0.28;
  h += sin(dot(q, vec2(0.97, 0.24)) / 6.0 - t * 1.35) * 0.14;
  h += (fbm(q / 11.0 + vec2(t * 0.16, t * 0.10)) - 0.5) * 0.26;
  return h;
}

void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 m = mix(texture2D(uA, uv).rgb, texture2D(uB, uv).rgb, uMix);
  float water = m.r, fog = m.g, land = m.b;
  if (water < 0.01 && fog < 0.01) { gl_FragColor = vec4(0.0); return; }
  vec2 p = uv * uSize;
  float t = uTime;
  vec4 col = vec4(0.0);

  if (water > 0.01) {
    float e = 1.2;
    float h = sea(p, t);
    vec2 g = vec2(sea(p + vec2(e, 0.0), t) - h, sea(p + vec2(0.0, e), t) - h) / e;
    vec3 n = normalize(vec3(-g * 4.6, 1.0));
    vec3 L = normalize(vec3(-0.45, -0.55, 0.70));
    vec3 V = vec3(0.0, 0.0, 1.0);
    // troughs a little darker, faces toward the sun a little lighter
    float l = dot(n, L) - L.z;
    float aLight = l > 0.0 ? min(l * 0.55, 0.16) : min(-l * 0.5, 0.15);
    vec3 cLight = l > 0.0 ? vec3(0.92, 0.97, 1.0) : vec3(0.02, 0.08, 0.17);
    col = vec4(cLight * aLight, aLight);
    // the sky mirrored in the wave faces (fresnel), and a soft sun highlight on the crests
    float fres = pow(1.0 - max(n.z, 0.0), 2.2) * 0.9;
    vec3 sky = vec3(0.86, 0.93, 1.0);
    float aSky = clamp(fres, 0.0, 0.22);
    col = col * (1.0 - aSky) + vec4(sky * aSky, aSky);
    vec3 Hh = normalize(L + V);
    float spec = pow(max(dot(n, Hh), 0.0), 70.0) * 0.32 + pow(max(dot(n, Hh), 0.0), 12.0) * 0.05;
    col = col * (1.0 - spec) + vec4(vec3(1.0, 0.99, 0.95) * spec, spec);
    // foam: a soft line along the shore and gentle laps rolling toward it
    float breakup = 0.55 + 0.45 * smoothstep(0.3, 0.7, noise(p / 6.0 + vec2(t * 0.12, -t * 0.05)));
    float edge = smoothstep(0.42, 0.72, land);
    float lap = smoothstep(0.82, 1.0, sin(land * 24.0 - t * 1.25 + noise(p / 36.0) * 3.0)) * smoothstep(0.06, 0.32, land);
    float foam = clamp(edge * 0.7 + lap * 0.4, 0.0, 0.8) * breakup;
    col = col * (1.0 - foam) + vec4(vec3(foam), foam);
    col *= water;
  }

  if (fog > 0.01) {
    // volumetric-looking fog: density from 3D noise evolving in time (it churns in place), lit from the
    // north-west by sampling the density a step toward the light (thicker toward the light = shadowed)
    vec3 q = vec3(p / 64.0, t * 0.07);
    float d = clamp(fbm3(q) * 1.25 - 0.18, 0.0, 1.0);
    float dl = clamp(fbm3(q + vec3(-0.09, -0.09, 0.0)) * 1.25 - 0.18, 0.0, 1.0);
    float shade = clamp(0.82 + (d - dl) * 3.4, 0.38, 1.12);
    vec3 fc = mix(vec3(0.55, 0.61, 0.70), vec3(1.0), shade);
    float a = fog * (0.5 + 0.42 * smoothstep(0.12, 0.78, d));
    col = col * (1.0 - a) + vec4(fc * a, a);
  }
  gl_FragColor = col;
}`;

// drawShapes(ctx, which) must draw (fill) the requested shapes into a 2D context in CSS px:
// which = 'water' | 'fog' | 'land'
export function createSurface(width, height) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  Object.assign(canvas.style, { position: 'absolute', left: '0', top: '0', width: `${width}px`, height: `${height}px`,
    pointerEvents: 'none' });

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
  } catch (e) { console.warn('View B: water and fog layer unavailable.', e); return null; }
  gl.useProgram(prog);
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const U = n => gl.getUniformLocation(prog, n);
  gl.uniform2f(U('uSize'), width, height);
  gl.uniform1i(U('uA'), 0); gl.uniform1i(U('uB'), 1);
  const uMix = U('uMix'), uTime = U('uTime');
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);

  const makeTex = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
      [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    return t;
  };
  let texA = makeTex(), texB = makeTex();

  // Masks: water in red, fog in green (soft edge), land in blue, blurred so the foam knows the shore is near
  const mask = document.createElement('canvas');
  mask.width = canvas.width; mask.height = canvas.height;
  const mctx = mask.getContext('2d');
  const hasFilter = 'filter' in mctx;
  function paint(drawShapes, which, color, blurPx) {
    mctx.save();
    mctx.scale(dpr, dpr);
    mctx.fillStyle = color;
    if (blurPx && hasFilter) mctx.filter = `blur(${blurPx}px)`;
    else if (blurPx) {                     // older browsers: blur through a shadow cast from off-canvas
      mctx.shadowColor = color; mctx.shadowBlur = blurPx * 2; mctx.shadowOffsetX = 10000;
      mctx.translate(-10000, 0);
    }
    mctx.beginPath();
    drawShapes(mctx, which);
    mctx.fill();
    mctx.restore();
  }

  let mixFrom = 0, mixDur = 1, lost = false;
  canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); lost = true; });
  const ease = x => x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

  return {
    canvas,
    // Rasterise new masks and cross-fade to them over `ms`
    setMasks(drawShapes, ms, nowMs) {
      if (lost) return;
      mctx.setTransform(1, 0, 0, 1, 0, 0);
      mctx.clearRect(0, 0, mask.width, mask.height);
      mctx.globalCompositeOperation = 'lighter';
      paint(drawShapes, 'water', 'rgb(255,0,0)', 0);
      paint(drawShapes, 'fog', 'rgb(0,255,0)', 2.5);
      paint(drawShapes, 'land', 'rgb(0,0,255)', 9);
      mctx.globalCompositeOperation = 'source-over';
      [texA, texB] = [texB, texA];          // what was "after" becomes "before"
      gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, mask);
      mixFrom = nowMs; mixDur = Math.max(1, ms);
    },
    // true while a cross-fade is still playing
    draw(seconds, nowMs) {
      if (lost) return false;
      const k = Math.min(1, (nowMs - mixFrom) / mixDur);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, texB);
      gl.uniform1f(uMix, ease(k));
      gl.uniform1f(uTime, seconds);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return k < 1;
    }
  };
}
