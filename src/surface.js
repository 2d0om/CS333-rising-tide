// src/surface.js — the moving water and the fog, drawn on the GPU over the map (Member 2)
//
// The map's colours are drawn by the SVG underneath, exactly from the data. This one transparent
// layer only adds movement on top, inside masks rasterised from the same community shapes:
//   water — long smooth swells lit by a low sun, a soft sheen, and foam that laps along the coast;
//   fog   — drifting 3D clouds over communities with too few sales (lit from one side so they
//           have volume), soft at the edges, never fully opaque.
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
vec2 wave(vec2 p, vec2 dir, float len, float amp, float speed, float t, float warp) {
  float k = 6.2832 / len;
  return dir * (k * amp * cos(dot(dir, p) * k - t * speed + warp));
}
float cloud(vec2 p, float t) {
  float a = fbm(p / 95.0 + vec2(t * 0.022, t * 0.009));
  float b = fbm(p / 48.0 - vec2(t * 0.035, -t * 0.015) + 5.2);
  return clamp(a * 0.7 + b * 0.5 - 0.18, 0.0, 1.0);
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
    // swell from the Gulf (north-west), a cross-swell, and slow fine ripples
    float warp = noise(p / 150.0 + vec2(t * 0.012, -t * 0.008)) * 6.2832;
    vec2 g = wave(p, normalize(vec2(0.80, 0.60)), 110.0, 3.0, 0.42, t, warp)
           + wave(p, normalize(vec2(0.55, 0.85)), 64.0, 1.5, 0.58, t, warp * 0.6)
           + wave(p, normalize(vec2(0.95, 0.30)), 33.0, 0.55, 0.80, t, 1.3);
    vec2 q = p / 14.0 + vec2(t * 0.09, t * 0.06);
    float n0 = noise(q);
    g += vec2(noise(q + vec2(0.2, 0.0)) - n0, noise(q + vec2(0.0, 0.2)) - n0) * 0.3;
    vec3 n = normalize(vec3(-g * 0.55, 1.0));
    vec3 L = normalize(vec3(-0.45, -0.55, 0.70));
    vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
    float l = dot(n, L) - L.z;
    float aLight = l > 0.0 ? min(l * 0.7, 0.14) : min(-l * 0.55, 0.11);
    vec3 cLight = l > 0.0 ? vec3(1.0) : vec3(0.03, 0.10, 0.20);
    col = vec4(cLight * aLight, aLight);
    float sheen = pow(max(dot(n, H), 0.0), 26.0) * 0.12;
    col = col * (1.0 - sheen) + vec4(vec3(sheen), sheen);
    // foam: a soft line along the shore and gentle laps rolling toward it
    float breakup = 0.55 + 0.45 * smoothstep(0.3, 0.7, noise(p / 7.0 + vec2(t * 0.12, -t * 0.05)));
    float edge = smoothstep(0.42, 0.72, land);
    float lap = smoothstep(0.82, 1.0, sin(land * 24.0 - t * 1.25 + noise(p / 36.0) * 3.0)) * smoothstep(0.06, 0.32, land);
    float foam = clamp(edge * 0.7 + lap * 0.4, 0.0, 0.8) * breakup;
    col = col * (1.0 - foam) + vec4(vec3(foam), foam);
    col *= water;
  }

  if (fog > 0.01) {
    // two cloud layers drifting at different speeds give depth; light from the north-west gives volume
    float d = cloud(p, t);
    float dl = cloud(p + vec2(-7.0, -7.0), t);
    float shade = clamp(0.78 + (d - dl) * 3.2, 0.42, 1.1);
    vec3 fc = mix(vec3(0.58, 0.64, 0.72), vec3(1.0), shade);
    float a = fog * (0.55 + 0.4 * smoothstep(0.1, 0.75, d));
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
