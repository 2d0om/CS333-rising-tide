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
    makeCanvas,
    box: { x: -m * cell, y: -m * cell, width: gw * cell, height: gh * cell },   // where the canvas sits
    // nested regions value >= t, as SVG path strings in screen coordinates
    contours: (grid, thresholds) => contourGen.thresholds(thresholds)(grid).map(c => ({ t: c.value, d: gridPath(c) || '' })),
    line: (grid, t) => gridPath(contourGen.thresholds([t])(grid)[0]) || ''
  };
}
