// src/waterfield.js — one number per community in, a smooth water surface out (Member 2)
//
// The map used to paint each community as a flat polygon, so the sea moved in tiles.
// Here every community writes its value into a grid; a short blur softens the steps
// only where two communities meet (interiors keep their own value). The surface is painted as a
// continuous gradient on a canvas, and d3.contours draws its isolines: the coastline at 50% and depth lines.
// The surface is clipped to the charted communities, so nothing is drawn where there is no data.

// Box blur along rows then columns (sums, not averages: callers divide value by weight)
function blur(src, tmp, gw, gh, r) {
  for (let y = 0; y < gh; y++) {
    const o = y * gw;
    let s = 0;
    for (let x = 0; x <= r && x < gw; x++) s += src[o + x];
    for (let x = 0; x < gw; x++) {
      tmp[o + x] = s;
      if (x + r + 1 < gw) s += src[o + x + r + 1];
      if (x - r >= 0) s -= src[o + x - r];
    }
  }
  for (let x = 0; x < gw; x++) {
    let s = 0;
    for (let y = 0; y <= r && y < gh; y++) s += tmp[y * gw + x];
    for (let y = 0; y < gh; y++) {
      src[y * gw + x] = s;
      if (y + r + 1 < gh) s += tmp[(y + r + 1) * gw + x];
      if (y - r >= 0) s -= tmp[(y - r) * gw + x];
    }
  }
}

export function createWaterField(features, projection, width, height, { cell = 4, soft = 1, fill = 8 } = {}) {
  // The grid overhangs the frame by a few cells, so isolines that close along the grid's edge do so off-screen
  const m = 3, gw = Math.ceil(width / cell) + 2 * m, gh = Math.ceil(height / cell) + 2 * m, N = gw * gh;
  const toGrid = v => v / cell + m;
  const ids = new Int32Array(N).fill(-1);

  // Which community owns each grid cell (tested at the cell centre, once)
  features.forEach((f, k) => {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const poly of polys) {
      const rings = poly.map(ring => ring.map(projection));
      const outer = rings[0];
      if (!outer || outer.some(p => !p)) continue;
      const [x0, x1] = d3.extent(outer, p => p[0]), [y0, y1] = d3.extent(outer, p => p[1]);
      const i0 = Math.max(0, Math.floor(toGrid(x0))), i1 = Math.min(gw - 1, Math.ceil(toGrid(x1)));
      const j0 = Math.max(0, Math.floor(toGrid(y0))), j1 = Math.min(gh - 1, Math.ceil(toGrid(y1)));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const pt = [(i - m + 0.5) * cell, (j - m + 0.5) * cell];
        if (d3.polygonContains(outer, pt) && !rings.slice(1).some(h => d3.polygonContains(h, pt))) ids[j * gw + i] = k;
      }
    }
  });

  const vs = new Float32Array(N), ws = new Float32Array(N), vb = new Float32Array(N), wb = new Float32Array(N);
  const tmp = new Float32Array(N), out = new Float32Array(N);
  const contourGen = d3.contours().size([gw, gh]);
  const gridPath = d3.geoPath(d3.geoIdentity().scale(cell).translate([-m * cell, -m * cell]));

  // vals[k] = value of feature k, or NaN where there is no surface (fog, no sales)
  function field(vals) {
    for (let i = 0; i < N; i++) {
      const id = ids[i], x = id >= 0 ? vals[id] : NaN;
      if (x === x) { vs[i] = vb[i] = x; ws[i] = wb[i] = 1; } else { vs[i] = vb[i] = ws[i] = wb[i] = 0; }
    }
    blur(vs, tmp, gw, gh, soft); blur(vs, tmp, gw, gh, soft);
    blur(ws, tmp, gw, gh, soft); blur(ws, tmp, gw, gh, soft);
    blur(vb, tmp, gw, gh, fill); blur(wb, tmp, gw, gh, fill);
    // Outside the data the surface just continues its neighbours' level, so an isoline never
    // appears along the edge of the data; the clip path hides everything out there anyway.
    for (let i = 0; i < N; i++) out[i] = ws[i] > 1e-4 ? vs[i] / ws[i] : wb[i] > 1e-4 ? vb[i] / wb[i] : 0.5;
    return out;
  }

  // For the water shader: one RGBA texel per grid cell, from the field() just computed.
  // R = value (0..1), G = signed distance to the coastline in px (water positive; -32..96 px),
  // B = 255 inside the data, 0 outside. The distance lets waves and foam run toward the shore.
  const dist = new Float32Array(N), packedTex = new Uint8Array(N * 4);
  const D0 = 32, DSPAN = 128;
  function pack(grid) {
    const wet = i => grid[i] >= 0.5;
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x, w = wet(i);
      const edge = (x > 0 && wet(i - 1) !== w) || (x < gw - 1 && wet(i + 1) !== w) ||
                   (y > 0 && wet(i - gw) !== w) || (y < gh - 1 && wet(i + gw) !== w);
      dist[i] = edge ? 0.5 : 1e6;
    }
    const D = 1.4142;   // two-pass chamfer distance, in cells
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
      const i = y * gw + x; let d = dist[i];
      if (x > 0) d = Math.min(d, dist[i - 1] + 1);
      if (y > 0) { d = Math.min(d, dist[i - gw] + 1);
        if (x > 0) d = Math.min(d, dist[i - gw - 1] + D);
        if (x < gw - 1) d = Math.min(d, dist[i - gw + 1] + D); }
      dist[i] = d;
    }
    for (let y = gh - 1; y >= 0; y--) for (let x = gw - 1; x >= 0; x--) {
      const i = y * gw + x; let d = dist[i];
      if (x < gw - 1) d = Math.min(d, dist[i + 1] + 1);
      if (y < gh - 1) { d = Math.min(d, dist[i + gw] + 1);
        if (x < gw - 1) d = Math.min(d, dist[i + gw + 1] + D);
        if (x > 0) d = Math.min(d, dist[i + gw - 1] + D); }
      dist[i] = d;
    }
    for (let i = 0, o = 0; i < N; i++, o += 4) {
      const v = grid[i], sd = (wet(i) ? 1 : -1) * dist[i] * cell;
      packedTex[o] = (v <= 0 ? 0 : v >= 1 ? 1 : v) * 255 + 0.5;
      packedTex[o + 1] = Math.max(0, Math.min(1, (sd + D0) / DSPAN)) * 255 + 0.5;
      packedTex[o + 2] = ws[i] > 1e-3 ? 255 : 0;
      packedTex[o + 3] = 255;
    }
    return packedTex;
  }

  // A canvas holding the surface at grid resolution; the browser's smooth upscaling turns it
  // into a continuous gradient. lut = Uint8ClampedArray of 256 rgb triples (value 0..1 -> colour).
  function makeCanvas() {
    const canvas = document.createElement('canvas');
    canvas.width = gw; canvas.height = gh;
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block' });
    const ctx = canvas.getContext('2d'), img = ctx.createImageData(gw, gh), px = img.data;
    return {
      canvas,
      draw(grid, lut) {
        for (let i = 0, o = 0; i < N; i++, o += 4) {
          const v = grid[i], j = (v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0) * 3;
          px[o] = lut[j]; px[o + 1] = lut[j + 1]; px[o + 2] = lut[j + 2]; px[o + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
      }
    };
  }

  return {
    field,
    pack,
    gw, gh, distRange: [D0, DSPAN],
    makeCanvas,
    box: { x: -m * cell, y: -m * cell, width: gw * cell, height: gh * cell },   // where the canvas sits
    // nested regions value >= t, as SVG path strings in screen coordinates
    contours: (grid, thresholds) => contourGen.thresholds(thresholds)(grid).map(c => ({ t: c.value, d: gridPath(c) || '' })),
    line: (grid, t) => gridPath(contourGen.thresholds([t])(grid)[0]) || ''
  };
}
