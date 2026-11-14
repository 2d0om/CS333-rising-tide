// src/viewB.js — View B, "The Sea" (Member 2)
// Sand is where your budget buys a typical home; water is where it does not, deeper where fewer
// homes are within reach.
// Contract: createViewB(container, data, theme, { width, height }) -> { update(state), on(event, handler) }
// Emits: select, pin, hover, mode, thenPeriod, period, budget.
//
// Design rules for this view:
//   * Plain words and counts, not percentages of abstractions: "AED 1.2M buys a typical 80 m²
//     apartment in 26 of 35 neighbourhoods in 2015–17, but only 11 in 2024–26."
//   * What matters is on screen without hovering: the headline, the tide chart (how many of the
//     neighbourhoods your budget reaches in each period), orange outlines on the neighbourhoods that
//     went under, and names where they fit. Hover and click add detail (overview first).
//   * Every colour is exact: one fill per community from its own sales. The coastline runs along
//     real community borders, never interpolated. Moving water and fog (surface.js) only add light
//     and texture; names, borders, the coastline and selections stay above them.
//   * Everything fits one screen: the map on the left, the story and the controls on the right.
//   * Only things that respond look like they respond. Areas with no sales do nothing.
import { emitter } from './emitter.js';
import * as R from './rules.js';
import { createSurface } from './surface.js';

export const BUILD = 'View B · tide chart, fair names, budget bar · 2026-11-14';

const PERIOD_KEYS = Object.keys(R.PERIODS);
const periodLabel = p => p.replace('-', '–');
const fmt = d3.format(',.0f');
const pctFmt = d3.format('.0%');
const aed = v => v >= 1e6 ? `AED ${d3.format('.2~f')(v / 1e6)}M` : `AED ${d3.format(',.0f')(v / 1e3)}k`;
const short$ = v => v >= 1e6 ? `${d3.format('.2~f')(v / 1e6)}M` : `${d3.format(',.0f')(v / 1e3)}k`;
const MODE_LABEL = { all: 'All homes', ready: 'Ready', offplan: 'Off-plan' };
const BUDGET_MIN = 400000, BUDGET_MAX = 4000000;   // typical 80 m² prices run 0.4M–2.8M (off-plan up to 4M)
const roundBudget = b => b < 1e6 ? Math.round(b / 1e4) * 1e4 : Math.round(b / 5e4) * 5e4;
const ceilBudget = b => Math.ceil(b / 1e4) * 1e4;

// Names. Official community names are all capitals in the data: title-case them. Project names keep
// real acronyms (DMCC, JLT) but not words that only happen to be short (AL, THE, BAY).
const titleCase = s => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const NOT_ACRONYM = /^(AL|EL|THE|AND|OF|BAY|CITY|PARK|BIN|BU|UMM|ABU|RAS|NAD|NADD|HILL|HILLS|ONE|TWO|NEW|OLD|WEST|EAST)$/;
const nice = s => s.split(/\s+/).map(w => /^[A-Z]{2,4}$/.test(w) && !NOT_ACRONYM.test(w) ? w
  : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
// Shorter forms for tight spaces (map labels and the price strip); the full name is in the tooltip
const SHORT = { 'Jumeirah Village Circle': 'JVC', 'Jumeirah Village Triangle': 'JVT', 'Dubai World Central': 'Dubai South',
  'Jumeirah Lake Towers': 'JLT', 'Dubai Investment Park Second': 'DIP 2', 'Dubai Investment Park First': 'DIP 1',
  'DMCC Master Community': 'DMCC' };
const shortName = n => SHORT[n] || n.replace(' Second', ' 2').replace(' First', ' 1')
  .replace(' Third', ' 3').replace(' Fourth', ' 4').replace(' Fifth', ' 5');

// GeoJSON from the course may wind rings the "wrong" way for d3 (which then fills the whole globe).
function rewound(f) {
  const g = { type: 'Feature', properties: f.properties,
    geometry: { type: f.geometry.type, coordinates: f.geometry.coordinates.map(ring => ring.slice()) } };
  if (d3.geoArea(g) > 2 * Math.PI) g.geometry.coordinates = g.geometry.coordinates.map(ring => ring.reverse());
  return g;
}

export function createViewB(container, data, theme, { width, height }) {
  const ev = emitter();
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = d3.select(container).style('position', 'relative').style('font-family', theme.font)
    .style('color', theme.ink);
  root.selectAll('*').remove();

  // ---------- data preparation (once) ----------
  const features = data.geo.features.map(rewound);
  const commOfF = f => String(f.properties.COMM_NUM);
  const byComm = new Map(features.map(f => [commOfF(f), f]));
  const official = c => titleCase(byComm.get(c)?.properties.CNAME_E || `Community ${c}`);

  const homeSales = data.rows
    .filter(r => r.trans_group_en === 'Sales' && (r.property_type_en === 'Unit' || r.property_type_en === 'Villa'))
    .map(r => ({ r, comm: r.comm_num, period: R.periodOf(r) }));

  // The name people use: the master project behind most of a community's sales (from the data),
  // when one project clearly dominates; otherwise the official community name.
  const known = new Map();
  d3.rollups(homeSales.filter(d => d.r.master_project_en), v => {
    const top = d3.greatest(d3.rollups(v, w => w.length, d => d.r.master_project_en), d => d[1]);
    return top[1] / v.length >= 0.5 ? nice(top[0]) : null;
  }, d => d.comm).forEach(([c, name]) => { if (name) known.set(c, name); });
  const nameOf = c => known.get(c) || official(c);
  const alsoKnownAs = c => known.has(c) && known.get(c).toLowerCase() !== official(c).toLowerCase() ? official(c) : null;

  const priceCache = new Map();
  function pricesBy(period, s) {           // Map comm -> sorted prices (AED per m²)
    const key = [period, s.mode, s.homeType, s.money, s.dropExtremes].join('|');
    if (priceCache.has(key)) return priceCache.get(key);
    const m = new Map();
    for (const { r, comm, period: p } of homeSales) {
      if (p !== period || !R.isHomeSale(r, s.homeType) || !R.inMode(r, s.mode)) continue;
      if (s.dropExtremes && R.isExtreme(r)) continue;
      if (!Number.isFinite(r.price)) continue;
      let a = m.get(comm);
      if (!a) m.set(comm, (a = []));
      a.push(R.priceIn(r, s.money));
    }
    for (const a of m.values()) a.sort(d3.ascending);
    priceCache.set(key, m);
    return m;
  }
  const statsCache = new Map();
  function statsFor(period, s) {           // Map comm -> { n, shareWithin, edge }
    const key = [period, s.mode, s.homeType, s.money, s.dropExtremes, s.budget, s.size].join('|');
    if (statsCache.has(key)) return statsCache.get(key);
    if (statsCache.size > 400) statsCache.clear();
    const thr = s.budget / s.size;
    const out = new Map();
    for (const [comm, a] of pricesBy(period, s)) {
      out.set(comm, {
        n: a.length,
        shareWithin: d3.bisectRight(a, thr) / a.length,
        // the price of a typical home of your size: the smallest budget that reaches half the homes
        // sold here. At this budget the community turns from water to sand.
        edge: a[Math.ceil(a.length * 0.5) - 1] * s.size
      });
    }
    statsCache.set(key, out);
    return out;
  }
  const charted = st => !!st && st.n >= R.MIN_SALES;
  const isLand = st => charted(st) && st.shareWithin >= 0.5;
  const isWater = st => charted(st) && st.shareWithin < 0.5;

  function comparable(S1, S2) {            // like-for-like: 20+ sales in both periods
    const both = [...S2.keys()].filter(c => charted(S2.get(c)) && charted(S1.get(c)));
    const land = S => both.filter(c => isLand(S.get(c)));
    return { set: both, n: both.length, k1: land(S1).length, k2: land(S2).length,
      land1: both.length ? land(S1).length / both.length : NaN, land2: both.length ? land(S2).length / both.length : NaN };
  }

  // Frame the map on the communities that can be compared over time (charted in the first and last period).
  const base = { mode: 'all', homeType: 'apartment', money: 'nominal', dropExtremes: false };
  const chartedIn = p => new Set([...pricesBy(p, base)].filter(([, a]) => a.length >= R.MIN_SALES).map(([c]) => c));
  const first = chartedIn(PERIOD_KEYS[0]), last = chartedIn(PERIOD_KEYS[PERIOD_KEYS.length - 1]);
  const frameFeatures = features.filter(f => first.has(commOfF(f)) && last.has(commOfF(f)));

  const topo = topojson.topology({ c: { type: 'FeatureCollection', features } });
  const commOfG = g => String(g.properties.COMM_NUM);
  // Coastline: only between a land community and a water community (both with enough sales)
  const coastFor = S => topojson.mesh(topo, topo.objects.c, (a, b) => {
    if (a === b) return false;
    const A = S.get(commOfG(a)), B = S.get(commOfG(b));
    return (isLand(A) && isWater(B)) || (isWater(A) && isLand(B));
  });
  const stations = data.metro.features.map(f => ({ coords: f.geometry.coordinates }));

  // ---------- encoding ----------
  // Depth = share of homes OUT of reach. Sand darkens from 0% to 50%; at 50% the coastline is
  // crossed and water deepens to 100%. Lightness carries the order; hue only says sand or sea.
  const noSales = '#f4f5f7';
  const sandRamp = d3.interpolateLab(theme.depth.dry, theme.depth.wet);
  const waterRamp = d3.interpolateLab(theme.depth.shallow, theme.depth.deep);
  const outOf = st => 1 - st.shareWithin;
  const depthColor = out => out < 0.5 ? sandRamp(out / 0.5) : waterRamp((out - 0.5) / 0.5);
  const thenColor = '#8a95a3';
  const homeWord = () => (cur && cur.homeType === 'villa') ? 'villa' : 'apartment';

  // ---------- layout ----------
  // Wide: map on the left at full height; a panel on the right (headline, which homes, your budget,
  // the tide chart and the selected neighbourhood's prices). Narrow: the panel goes under the map.
  const wide = width >= 900;
  const colGap = 22;
  const panelW = wide ? Math.round(Math.max(360, Math.min(440, width * 0.33))) : width;
  const mapW = wide ? width - panelW - colGap : width;
  const mapH = wide ? height : Math.max(360, height - 640 - colGap);

  root.style('display', 'flex').style('flex-direction', wide ? 'row' : 'column').style('gap', `${colGap}px`)
    .style('width', `${width}px`).style('height', `${height}px`);
  const mapBox = root.append('div').style('position', 'relative').style('width', `${mapW}px`).style('height', `${mapH}px`)
    .style('flex', 'none').style('border-radius', '12px').style('overflow', 'hidden');
  const panel = root.append('div').style('width', `${panelW}px`).style('flex', 'none').style('display', 'flex')
    .style('flex-direction', 'column').style('gap', '12px').style('min-width', '0');

  // 1. The finding, in one or two plain sentences
  const headline = panel.append('div').style('font-size', `${theme.size.label + 2}px`).style('line-height', '1.45')
    .style('min-height', '62px');

  // 2. Which homes; each option shows its own then → now count
  const modeGroup = panel.append('div').attr('role', 'group').attr('aria-label', 'Which homes')
    .style('display', 'grid').style('grid-template-columns', '1fr 1fr 1fr').style('padding', '3px').style('gap', '2px')
    .style('background', '#eef1f5').style('border-radius', '10px');
  const modeButtons = modeGroup.selectAll('button').data(['all', 'ready', 'offplan']).join('button')
    .attr('type', 'button').style('font', `600 ${theme.size.small}px ${theme.font}`).style('padding', '6px 4px')
    .style('border', '0').style('border-radius', '8px').style('cursor', 'pointer').style('line-height', '1.3')
    .style('transition', 'background-color .2s, color .2s, box-shadow .2s');
  modeButtons.append('div').text(d => MODE_LABEL[d]);
  const modeNums = modeButtons.append('div').style('font-weight', 400).style('font-size', '11px')
    .style('font-variant-numeric', 'tabular-nums');

  // 3. Your budget: the number, and the bar that sets it
  const budgetBlock = panel.append('div');
  const budgetRow = budgetBlock.append('div').style('display', 'flex').style('align-items', 'baseline')
    .style('gap', '10px').style('flex-wrap', 'wrap');
  budgetRow.append('span').style('font-size', '11px').style('letter-spacing', '0.06em').style('text-transform', 'uppercase')
    .style('color', theme.quiet).text('Your budget');
  const budgetBig = budgetRow.append('span').style('font-size', '24px').style('font-weight', 700)
    .style('font-variant-numeric', 'tabular-nums').style('line-height', '1.2');
  const budgetSub = budgetRow.append('span').style('font-size', `${theme.size.small}px`).style('color', theme.quiet);
  const barBox = budgetBlock.append('div').style('margin-top', '2px');

  // 4. The tide chart: in each period, how many of the neighbourhoods your budget reaches
  const tideHead = panel.append('div').style('min-height', '32px');
  const tideTitle = tideHead.append('div').style('font', `600 ${theme.size.small}px ${theme.font}`);
  const tideSub = tideHead.append('div').style('font-size', '11px').style('color', theme.quiet).style('margin-top', '3px')
    .style('display', 'flex').style('flex-wrap', 'wrap').style('gap', '2px 12px');
  const tideBox = panel.append('div');

  // ---------- map: data underneath, moving water and fog in the middle, names and lines on top ----------
  const legendH = 50;
  const svg = mapBox.append('svg').attr('width', mapW).attr('height', mapH)
    .attr('viewBox', `0 0 ${mapW} ${mapH}`).attr('role', 'img')
    .attr('aria-label', 'Map of Dubai neighbourhoods: sand where your budget buys a typical home, water where it does not')
    .style('display', 'block').style('position', 'absolute').style('left', 0).style('top', 0);
  const projection = d3.geoMercator().fitExtent([[18, 18], [mapW - 18, mapH - legendH - 14]],
    { type: 'FeatureCollection', features: frameFeatures });
  const path = d3.geoPath(projection);

  const defs = svg.append('defs');
  const hatch = defs.append('pattern').attr('id', 'vb-fog').attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 6).attr('height', 6).attr('patternTransform', 'rotate(45)');
  hatch.append('rect').attr('width', 6).attr('height', 6).attr('fill', '#ffffff');
  hatch.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6)
    .attr('stroke', theme.fog).attr('stroke-width', 2.2);

  const seaRect = svg.append('rect').attr('width', mapW).attr('height', mapH).attr('fill', theme.realSea);
  svg.append('text').attr('x', 18).attr('y', 26).attr('fill', theme.quiet)
    .style('font-size', `${theme.size.small}px`).style('font-style', 'italic').attr('pointer-events', 'none')
    .text('Arabian Gulf (the real sea)');
  const commPaths = svg.append('g').selectAll('path').data(features, commOfF).join('path')
    .attr('d', path).attr('fill', noSales).attr('stroke', '#ffffff').attr('stroke-width', 0.6);

  const surface = createSurface(mapW, mapH);
  if (surface) mapBox.node().appendChild(surface.canvas);

  const top = mapBox.append('svg').attr('width', mapW).attr('height', mapH).attr('aria-hidden', true)
    .style('position', 'absolute').style('left', 0).style('top', 0).style('pointer-events', 'none');
  top.append('path').attr('d', path(topojson.mesh(topo, topo.objects.c, (a, b) => a !== b))).attr('fill', 'none')
    .attr('stroke', '#ffffff').attr('stroke-opacity', 0.5).attr('stroke-width', 0.6);   // borders stay crisp above fog
  const gTide = top.append('g');
  const ghostCoast = top.append('path').attr('fill', 'none').attr('stroke', theme.coastline).attr('stroke-width', 2)
    .attr('opacity', 0);
  const coastPath = top.append('path').attr('fill', 'none').attr('stroke', theme.coastline)
    .attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round');
  const previewPath = top.append('path').attr('fill', 'none').attr('stroke', theme.coastline)
    .attr('stroke-width', 2.2).attr('stroke-dasharray', '6 4').attr('opacity', 0);
  const gFlip = top.append('g');
  const gStations = top.append('g');
  const gMarks = top.append('g');
  const gLabels = top.append('g');
  const gForced = top.append('g');

  gStations.selectAll('circle').data(stations.filter(s => {
    const [x, y] = projection(s.coords); return x >= 0 && x <= mapW && y >= 0 && y <= mapH - legendH;
  })).join('circle')
    .attr('cx', d => projection(d.coords)[0]).attr('cy', d => projection(d.coords)[1])
    .attr('r', 1.5).attr('fill', theme.ink).attr('fill-opacity', 0.3);

  // Legend band along the bottom of the map: what sand, water, orange and fog mean
  const legend = mapBox.append('div').style('position', 'absolute').style('left', 0).style('right', 0).style('bottom', 0)
    .style('height', `${legendH}px`).style('background', 'rgba(255,255,255,0.93)').style('border-top', `1px solid ${theme.grid}`)
    .style('display', 'flex').style('align-items', 'center').style('gap', '18px').style('padding', '0 14px')
    .style('font-size', '11.5px').style('line-height', '1.35').style('pointer-events', 'none');
  const kw = 118;
  const legScale = legend.append('div').style('display', 'flex').style('align-items', 'center').style('gap', '8px');
  const legSvg = legScale.append('svg').attr('width', kw).attr('height', 30).attr('aria-hidden', true);
  const kg = legSvg.append('defs').append('linearGradient').attr('id', 'vb-key');
  [...d3.range(0, 0.5, 0.05), 0.4999, 0.5, ...d3.range(0.55, 1.001, 0.05)]
    .forEach(t => kg.append('stop').attr('offset', t).attr('stop-color', depthColor(t)));
  legSvg.append('rect').attr('y', 4).attr('width', kw).attr('height', 10).attr('rx', 2).attr('fill', 'url(#vb-key)');
  legSvg.append('line').attr('x1', kw / 2).attr('x2', kw / 2).attr('y1', 1).attr('y2', 17).attr('stroke', theme.coastline).attr('stroke-width', 2);
  [[0, 'all', 'start'], [kw / 2, 'half', 'middle'], [kw, 'none', 'end']].forEach(([x, t, a]) =>
    legSvg.append('text').attr('x', x).attr('y', 28).attr('text-anchor', a).attr('fill', theme.quiet).style('font-size', '10px').text(t));
  const legText = legScale.append('div');
  const legOther = legend.append('div').style('display', 'flex').style('flex-direction', 'column').style('gap', '2px');
  const legNames = legend.append('div').style('color', theme.quiet).style('margin-left', 'auto').style('text-align', 'right');

  // How far inland each community lies, to order the tide: a rising sea reaches coastal communities
  // first; a falling one drains inland first. The Gulf is north-west, so inland runs south-east.
  const inlandRaw = new Map(features.map(f => { const [x, y] = path.centroid(f); return [commOfF(f), (x + 0.6 * y)]; }));
  const inlandScale = d3.scaleLinear().domain(d3.extent([...inlandRaw.values()].filter(Number.isFinite))).clamp(true);
  const inland = c => inlandScale(inlandRaw.get(c) ?? 0);

  // ---------- names on the map ----------
  // A fair, stated rule: the neighbourhoods counted in the headline and the tide chart (20+ sales then
  // and now) are named, busiest first, as long as names do not overlap; any other neighbourhood with
  // 20+ sales is named only if its name fits inside its own shape. Names sit at the point furthest
  // from the shape's edges. Selected, hovered and pinned ones are always named.
  const measureCtx = document.createElement('canvas').getContext('2d');
  const textW = (t, px, wt = 600) => { measureCtx.font = `${wt} ${px}px ${theme.font}`; return measureCtx.measureText(t).width; };
  const splitName = t => {
    if (t.length <= 13 || !t.includes(' ')) return [t];
    const w = t.split(' ');
    let best = [t], score = Infinity;
    for (let i = 1; i < w.length; i++) {
      const a = w.slice(0, i).join(' '), b = w.slice(i).join(' ');
      const sc = Math.max(a.length, b.length);
      if (sc < score) { score = sc; best = [a, b]; }
    }
    return best;
  };
  const anchorCache = new Map();
  function anchorOf(f) {                   // pole of inaccessibility of the largest part, by grid search
    const c = commOfF(f);
    if (anchorCache.has(c)) return anchorCache.get(c);
    const g = f.geometry;
    const polys = (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).map(poly => poly.map(r => r.map(projection)));
    const outer = d3.greatest(polys.map(p => p[0]), r => Math.abs(d3.polygonArea(r)));
    let res = null;
    if (outer) {
      const [x0, x1] = d3.extent(outer, p => p[0]), [y0, y1] = d3.extent(outer, p => p[1]);
      const step = Math.max(2, Math.min(x1 - x0, y1 - y0) / 14);
      const segDist = (px, py) => {
        let m = Infinity;
        for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
          const [ax, ay] = outer[j], [bx, by] = outer[i];
          const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
          const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
          m = Math.min(m, Math.hypot(px - ax - t * dx, py - ay - t * dy));
        }
        return m;
      };
      let best = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, d: -1 };
      for (let y = y0 + step / 2; y < y1; y += step) for (let x = x0 + step / 2; x < x1; x += step) {
        if (!d3.polygonContains(outer, [x, y])) continue;
        const d = segDist(x, y);
        if (d > best.d) best = { x, y, d };
      }
      res = { x: best.x, y: best.y, ring: outer, area: Math.abs(d3.polygonArea(outer)) };
    }
    anchorCache.set(c, res);
    return res;
  }
  let labelKey = null;
  function placeLabels(s) {
    const key = [s.period, s.thenPeriod, s.mode, s.homeType, s.dropExtremes].join('|');
    if (key === labelKey) return;
    labelKey = key;
    const placed = [], out = [];
    const overlaps = b => placed.some(p => b.x0 < p.x1 + 3 && b.x1 > p.x0 - 3 && b.y0 < p.y1 + 2 && b.y1 > p.y0 - 2);
    const box = (cx, cy, lines, px) => {
      const w = d3.max(lines, l => textW(l, px)), h = lines.length * px * 1.1;
      return { x0: cx - w / 2, x1: cx + w / 2, y0: cy - h / 2, y1: cy + h / 2 };
    };
    // fits: the label's centre and at least 9 of 10 points around its box lie inside the shape
    const fits = (b, ring) => {
      const mx = (b.x0 + b.x1) / 2, my = (b.y0 + b.y1) / 2;
      if (!d3.polygonContains(ring, [mx, my])) return false;
      const pts = [[b.x0, b.y0], [mx, b.y0], [b.x1, b.y0], [b.x1, my], [b.x1, b.y1], [mx, b.y1], [b.x0, b.y1], [b.x0, my],
        [(b.x0 + mx) / 2, my], [(b.x1 + mx) / 2, my]];
      return pts.filter(p => d3.polygonContains(ring, p)).length >= 9;
    };
    features.filter(f => charted(S.get(commOfF(f)))).map(f => ({ c: commOfF(f), a: anchorOf(f), n: S.get(commOfF(f)).n }))
      .filter(it => it.a && it.a.x > 0 && it.a.x < mapW && it.a.y > 0 && it.a.y < mapH - legendH)
      .sort((p, q) => (C.set.includes(q.c) - C.set.includes(p.c)) || q.n - p.n)
      .forEach(it => {
        const lines = splitName(shortName(nameOf(it.c)));
        for (const px of [11, 10, 9.5]) {
          const b = box(it.a.x, it.a.y, lines, px);
          if (fits(b, it.a.ring) && !overlaps(b)) { placed.push(b); out.push({ ...it, lines, px }); return; }
        }
        if (!C.set.includes(it.c)) return;          // counted neighbourhoods: a smaller name, even if it overhangs
        const b = box(it.a.x, it.a.y, lines, 9);
        if (!overlaps(b) && b.x0 > 2 && b.x1 < mapW - 2 && b.y1 < mapH - legendH - 2) { placed.push(b); out.push({ ...it, lines, px: 9 }); }
      });
    const g = gLabels.selectAll('text.lab').data(out, d => d.c).join(enter => enter.append('text').attr('class', 'lab')
      .attr('text-anchor', 'middle').attr('fill', theme.ink).attr('paint-order', 'stroke')
      .attr('stroke', '#ffffff').attr('stroke-opacity', 0.9).attr('stroke-linejoin', 'round').attr('stroke-width', 3));
    g.attr('x', d => d.a.x).attr('y', d => d.a.y - (d.lines.length - 1) * d.px * 0.55).style('font', d => `600 ${d.px}px ${theme.font}`)
      .selectAll('tspan').data(d => d.lines.map((l, i) => ({ l, i, d }))).join('tspan')
      .attr('x', t => t.d.a.x).attr('dy', t => t.i === 0 ? '0.35em' : `${t.d.px * 1.1}px`).text(t => t.l);
  }
  // Names that the rule left out, shown while a neighbourhood is selected, hovered or pinned
  function forcedLabels(s) {
    const named = new Set(gLabels.selectAll('text.lab').data().map(d => d.c));
    const force = [s.selected, s.hovered, ...(s.pinned || [])]
      .filter((c, i, a) => c && a.indexOf(c) === i && byComm.has(c) && !named.has(c) && anchorOf(byComm.get(c)));
    gForced.selectAll('text').data(force, c => c).join('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
      .attr('x', c => anchorOf(byComm.get(c)).x).attr('y', c => anchorOf(byComm.get(c)).y)
      .attr('fill', theme.ink).attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.2)
      .attr('stroke-linejoin', 'round').style('font', `700 11px ${theme.font}`).text(c => shortName(nameOf(c)));
    gLabels.selectAll('text.lab').style('font-weight', d => d.c === s.selected ? 800 : 600);
  }

  // ---------- budget bar ----------
  // A thin track, the part your budget covers filled, a round handle with a soft shadow. The number
  // above it is the budget; a small mark shows the budget that reaches as many neighbourhoods now as
  // yours did then.
  const CW = panelW, BH = 58, barY = 24;
  const barSvg = barBox.append('svg').attr('width', CW).attr('height', BH).style('display', 'block').style('overflow', 'visible');
  const bm = { l: 10, r: 14 };
  const bx = d3.scaleLog().domain([BUDGET_MIN, BUDGET_MAX]).range([bm.l, CW - bm.r]).clamp(true);
  barSvg.append('defs').append('filter').attr('id', 'vb-knob-shadow').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%')
    .append('feDropShadow').attr('dx', 0).attr('dy', 1.5).attr('stdDeviation', 2).attr('flood-color', '#0b2540').attr('flood-opacity', 0.28);
  const barHit = barSvg.append('rect').attr('x', 0).attr('y', barY - 16).attr('width', CW).attr('height', 32)
    .attr('fill', 'transparent').style('cursor', 'pointer');
  barSvg.append('rect').attr('x', bm.l).attr('y', barY - 4).attr('width', CW - bm.l - bm.r).attr('height', 8).attr('rx', 4)
    .attr('fill', '#e3e8ee').attr('pointer-events', 'none');
  const barFill = barSvg.append('rect').attr('x', bm.l).attr('y', barY - 4).attr('height', 8).attr('rx', 4)
    .attr('fill', theme.depth.deep).attr('pointer-events', 'none');
  barSvg.append('g').attr('pointer-events', 'none').selectAll('text').data([400e3, 600e3, 800e3, 1e6, 1.5e6, 2e6, 3e6, 4e6]).join('text')
    .attr('x', v => bx(v)).attr('y', barY + 26).attr('text-anchor', 'middle').attr('fill', theme.quiet)
    .style('font-size', '10.5px').text(v => short$(v));
  const eqMark = barSvg.append('g').style('cursor', 'pointer');
  const knob = barSvg.append('g').attr('tabindex', 0).attr('role', 'slider')
    .attr('aria-label', 'Your budget. Arrow keys change it.')
    .attr('aria-valuemin', BUDGET_MIN).attr('aria-valuemax', BUDGET_MAX).style('cursor', 'grab').style('outline', 'none');
  const knobHalo = knob.append('circle').attr('r', 17).attr('fill', theme.depth.deep).attr('fill-opacity', 0);
  knob.append('circle').attr('r', 10).attr('fill', '#ffffff').attr('stroke', theme.depth.deep)
    .attr('stroke-width', 2.5).attr('filter', 'url(#vb-knob-shadow)');
  knob.on('mouseenter', () => knobHalo.transition().duration(150).attr('fill-opacity', 0.12))
    .on('mouseleave', () => { if (!dragging) knobHalo.transition().duration(200).attr('fill-opacity', 0); })
    .on('focus', () => knobHalo.attr('fill-opacity', 0.18)).on('blur', () => knobHalo.attr('fill-opacity', 0));

  // ---------- tide chart ----------
  // A stacked area over the four periods: of the neighbourhoods with 20+ sales in both "then" and
  // "now", how many your budget reaches (sand), how many it doesn't (water), and how many had too few
  // sales that period (fog). The line between sand and water is your budget's tide line. It is the
  // map seen side-on through time: the same counts, every period at once.
  const stripH = 62;
  const usedH = [headline, modeGroup, budgetBlock, tideHead].reduce((t, d) => t + d.node().getBoundingClientRect().height, 0);
  const TH = Math.max(190, Math.min(360, (wide ? height : 640) - usedH - 12 * 4 - stripH - 8));
  const tideSvg = tideBox.append('svg').attr('width', CW).attr('height', TH + stripH).style('display', 'block').style('overflow', 'visible');
  const tm = { l: 30, r: 104, t: 18, b: 40 };
  const tx = d3.scalePoint().domain(PERIOD_KEYS).range([tm.l + 16, CW - tm.r]);
  const ty = d3.scaleLinear().range([TH - tm.b, tm.t]);
  const tdefs = tideSvg.append('defs');
  const tfog = tdefs.append('pattern').attr('id', 'vb-tide-fog').attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 6).attr('height', 6).attr('patternTransform', 'rotate(45)');
  tfog.append('rect').attr('width', 6).attr('height', 6).attr('fill', '#f1f3f6');
  tfog.append('line').attr('y2', 6).attr('stroke', '#c9d0d8').attr('stroke-width', 2);
  const sandFill = sandRamp(0.45), waterFill = waterRamp(0.35);
  const colBand = tideSvg.append('rect').attr('y', tm.t - 12).attr('height', TH - tm.t - tm.b + 12 + 30).attr('rx', 6)
    .attr('fill', '#eef2f6');
  const gTideGrid = tideSvg.append('g').attr('pointer-events', 'none');
  const areaSand = tideSvg.append('path').attr('fill', sandFill).attr('pointer-events', 'none');
  const areaWater = tideSvg.append('path').attr('fill', waterFill).attr('pointer-events', 'none');
  const areaFog = tideSvg.append('path').attr('fill', 'url(#vb-tide-fog)').attr('pointer-events', 'none');
  const eqLine = tideSvg.append('path').attr('fill', 'none').attr('stroke', theme.ink).attr('stroke-opacity', 0.7)
    .attr('stroke-width', 1.4).attr('stroke-dasharray', '5 4').attr('pointer-events', 'none');
  const tideLine = tideSvg.append('path').attr('fill', 'none').attr('stroke', theme.coastline).attr('stroke-width', 2.6)
    .attr('stroke-linejoin', 'round').attr('pointer-events', 'none');
  const gTidePts = tideSvg.append('g').attr('pointer-events', 'none');
  const gAreaLabels = tideSvg.append('g').attr('pointer-events', 'none');
  const gAxis = tideSvg.append('g').attr('pointer-events', 'none');
  const hoverGuide = tideSvg.append('line').attr('y1', tm.t - 6).attr('y2', TH - tm.b).attr('stroke', theme.ink)
    .attr('stroke-opacity', 0).attr('stroke-dasharray', '2 3').attr('pointer-events', 'none');
  const gCols = tideSvg.append('g');
  const eqHit = tideSvg.append('g').style('cursor', 'pointer');
  const gStrip = tideSvg.append('g').attr('transform', `translate(0,${TH})`);

  // ---------- tooltip ----------
  const tip = root.append('div').style('position', 'absolute').style('pointer-events', 'none')
    .style('background', '#ffffff').style('border', `1px solid ${theme.grid}`).style('border-radius', '8px')
    .style('padding', '7px 10px').style('font-size', `${theme.size.small}px`).style('line-height', '1.45')
    .style('box-shadow', '0 2px 8px rgba(0,0,0,0.08)').style('max-width', '280px').style('opacity', 0).style('z-index', 3);
  function showTip(event, html) {
    const [x, y] = d3.pointer(event, container);
    const left = x + 300 > width ? x - 294 : x + 14;
    tip.html(html).style('opacity', 1).style('left', `${left}px`).style('top', `${Math.min(y + 14, height - 120)}px`);
  }
  const hideTip = () => tip.style('opacity', 0);

  // ---------- state ----------
  let prev = null, cur = null, S = new Map(), Sthen = new Map(), C = null, dragging = false;
  let flipped = [];
  const lastOut = new Map();

  // ---------- interactions ----------
  function statusOf(c, s) {
    const seq = PERIOD_KEYS.map(p => { const x = statsFor(p, s).get(c); return { p, k: !charted(x) ? 'none' : isLand(x) ? 'land' : 'water' }; })
      .filter(d => d.k !== 'none');
    if (!seq.length) return '';
    if (seq.every(d => d.k === 'water')) return 'Out of reach in every period';
    if (seq.every(d => d.k === 'land')) return 'Within reach in every period';
    const i = seq.findIndex((d, j) => d.k === 'water' && seq.slice(0, j).some(e => e.k === 'land'));
    return i >= 0 ? `Went under in ${periodLabel(seq[i].p)}` : `Came back within reach in ${periodLabel(seq.find(d => d.k === 'land').p)}`;
  }
  function tipForCommunity(c) {
    const st = S.get(c), stThen = Sthen.get(c);
    const aka = alsoKnownAs(c) ? ` <span style="color:${theme.quiet}">· ${alsoKnownAs(c)}</span>` : '';
    const head = `<strong>${nameOf(c)}</strong>${aka}<br>`;
    if (!charted(st)) return `${head}Only ${st ? st.n : 0} sale${st && st.n === 1 ? '' : 's'} in ${periodLabel(cur.period)}: too few to trust (20 needed).`;
    const same = cur.thenPeriod === cur.period;
    return `${head}Typical ${cur.size} m² ${homeWord()}: <strong>${aed(st.edge)}</strong>` +
      (!same && charted(stThen) ? ` <span style="color:${theme.quiet}">(${aed(stThen.edge)} in ${periodLabel(cur.thenPeriod)})</span>` : '') +
      `<br>${pctFmt(st.shareWithin)} of the ${fmt(st.n)} homes sold here are within your budget<br>` +
      `<span style="color:${theme.quiet}">${statusOf(c, cur)}</span>`;
  }
  const kindOf = c => { const st = S.get(c); return charted(st) ? 'data' : st ? 'fog' : 'none'; };

  commPaths
    .on('mousemove', (event, f) => {
      const c = commOfF(f);
      if (kindOf(c) === 'data' && cur.hovered !== c) ev.emit('hover', c);
      showTip(event, tipForCommunity(c));
    })
    .on('mouseleave', () => { if (cur && cur.hovered) ev.emit('hover', null); hideTip(); })
    .on('click', (event, f) => {
      const c = commOfF(f);
      if (kindOf(c) !== 'data') return;
      if (event.shiftKey) ev.emit('pin', c);
      else ev.emit('select', cur.selected === c ? null : c);
    });
  seaRect.on('click', () => { if (cur && cur.selected) ev.emit('select', null); });
  d3.select(window).on(`keydown.vb${Math.random().toString(36).slice(2, 7)}`, event => {
    if (event.key === 'Escape' && cur && cur.selected) ev.emit('select', null);
  });

  modeButtons
    .on('click', (event, m) => { endPreview(); ev.emit('mode', m); })
    .on('mouseenter', (event, m) => { if (cur && m !== cur.mode) preview(statsFor(cur.period, { ...cur, mode: m })); })
    .on('mouseleave', endPreview);
  function preview(Sp) { previewPath.attr('d', path(coastFor(Sp))).attr('opacity', 1); coastPath.attr('opacity', 0.25); }
  function endPreview() { previewPath.attr('opacity', 0); coastPath.attr('opacity', 1); }

  // Budget: drag the handle (or anywhere on the bar); click to jump; arrow keys on the handle.
  // While dragging, the handle and the line follow the pointer exactly; the budget sent is rounded.
  let pending = null;
  function sendBudget(b, x) {
    placeBudget(b, false, x);
    if (pending == null) requestAnimationFrame(() => { const v = pending; pending = null; if (v != null) ev.emit('budget', v); });
    pending = b;
  }
  const clampX = x => Math.max(bm.l, Math.min(CW - bm.r, x));
  const atX = x => roundBudget(bx.invert(clampX(x)));
  const drag = d3.drag().container(barSvg.node()).clickDistance(3)
    .on('start', () => { knobHalo.interrupt().attr('fill-opacity', 0.16); knob.style('cursor', 'grabbing'); })
    .on('drag', e => { if (cur) { dragging = true; sendBudget(atX(e.x), clampX(e.x)); } })
    .on('end', () => {
      knob.style('cursor', 'grab'); knobHalo.transition().duration(250).attr('fill-opacity', 0);
      requestAnimationFrame(() => requestAnimationFrame(() => { dragging = false; if (cur) placeBudget(cur.budget, true); }));
    });
  barHit.call(drag).on('click', event => { if (cur) ev.emit('budget', atX(d3.pointer(event, barSvg.node())[0])); });
  knob.call(drag).on('keydown', event => {
    const f = { ArrowLeft: 1 / 1.1, ArrowDown: 1 / 1.1, ArrowRight: 1.1, ArrowUp: 1.1, PageDown: 1 / 1.5, PageUp: 1.5 }[event.key];
    if (!f || !cur) return;
    event.preventDefault();
    ev.emit('budget', roundBudget(Math.max(BUDGET_MIN, Math.min(BUDGET_MAX, cur.budget * f))));
  });

  // ---------- drawing ----------
  function drawData(s, animate) {
    S = statsFor(s.period, s);
    Sthen = statsFor(s.thenPeriod, s);
    const same = s.thenPeriod === s.period;
    C = same ? (() => { const set = [...S.keys()].filter(c => charted(S.get(c))); const k = set.filter(c => isLand(S.get(c))).length;
      return { set, n: set.length, k1: k, k2: k, land1: k / set.length, land2: k / set.length }; })() : comparable(Sthen, S);
    flipped = same ? [] : C.set.filter(c => isLand(Sthen.get(c)) && isWater(S.get(c)));

    // Fills: exact colours. A deliberate change arrives as a tide; a drag follows the hand.
    const instant = !animate || reduceMotion;
    const dataF = [], otherF = [];
    commPaths.each(function (f) { (charted(S.get(commOfF(f))) ? dataF : otherF).push(this); });
    d3.selectAll(otherF).interrupt()
      .attr('fill', f => S.get(commOfF(f)) ? (surface ? '#e6eaef' : 'url(#vb-fog)') : noSales)
      .attr('pointer-events', f => S.get(commOfF(f)) ? 'all' : 'none')
      .style('cursor', f => S.get(commOfF(f)) ? 'help' : null)
      .each(function () { this.__out = null; });
    const dataSel = d3.selectAll(dataF).interrupt().attr('pointer-events', 'all').style('cursor', 'pointer');
    const delayOf = f => {
      const c = commOfF(f), now = outOf(S.get(c)), before = lastOut.get(c);
      if (before == null) return 0;
      return (now >= before ? inland(c) : 1 - inland(c)) * 450;
    };
    const fillOf = f => depthColor(outOf(S.get(commOfF(f))));
    if (instant) dataSel.attr('fill', fillOf).each(function (f) { this.__out = outOf(S.get(commOfF(f))); });
    // The colour travels along the depth scale itself (deep → shallow → wet sand → dry), never through grey
    else dataSel.transition().delay(delayOf).duration(700).ease(d3.easeSinInOut).attrTween('fill', function (f) {
      const el = this, to = outOf(S.get(commOfF(f))), from = el.__out;
      if (from == null) return () => depthColor((el.__out = to));
      const i = d3.interpolateNumber(from, to);
      return t => depthColor((el.__out = i(t)));
    });
    features.forEach(f => { const st = S.get(commOfF(f)); if (charted(st)) lastOut.set(commOfF(f), outOf(st)); });
    updateSurface(instant ? (dragging ? 140 : 0) : 1100);

    // Coastline: the old one fades while the new one comes in behind the tide
    const newCoast = path(coastFor(S)) || '';
    const oldCoast = coastPath.attr('d');
    coastPath.interrupt();
    if (instant || !oldCoast || oldCoast === newCoast) coastPath.attr('d', newCoast).attr('stroke-opacity', 1);
    else {
      ghostCoast.interrupt().attr('d', oldCoast).attr('opacity', 0.8).transition().duration(700).attr('opacity', 0);
      coastPath.attr('d', newCoast).attr('stroke-opacity', 0).transition().delay(350).duration(500).attr('stroke-opacity', 1);
    }

    // Neighbourhoods that went under since "then": outlined in orange, always
    showFlips(flipped);

    placeLabels(s);
    drawHeadline(s, same, animate);
    drawLegend(s, same);
    if (!dragging) placeBudget(s.budget, animate);

    clearTimeout(heavyTimer);
    if (dragging) heavyTimer = setTimeout(() => drawHeavy(s, same), 120);
    else drawHeavy(s, same);
  }

  // Orange outlines: by default the neighbourhoods that went under since "then"; while a period is
  // hovered in the tide chart, the ones that went under in that step
  function showFlips(list) {
    gFlip.selectAll('path').data(list, c => c).join('path').attr('d', c => path(byComm.get(c)))
      .attr('fill', 'none').attr('stroke', theme.accent).attr('stroke-width', 1.8).attr('stroke-linejoin', 'round');
  }
  const eqBudget = () => {                 // the budget that reaches as many neighbourhoods now as yours did then
    if (!C || !C.k1 || C.k1 === C.k2 || cur.thenPeriod === cur.period) return NaN;
    const edges = C.set.map(c => S.get(c).edge).sort(d3.ascending);
    return ceilBudget(edges[C.k1 - 1]);
  };

  function drawHeadline(s, same, animate) {
    const b = `<strong>${aed(s.budget)}</strong>`;
    const home = `a typical ${s.size} m² ${homeWord()}`;
    let html;
    if (same) html = `${b} buys ${home} in <strong>${C.k2}</strong> of ${C.n} neighbourhoods in ${periodLabel(s.period)}.`;
    else {
      const eq = eqBudget();
      html = `${b} buys ${home} in <strong>${C.k1}</strong> of ${C.n} neighbourhoods in ${periodLabel(s.thenPeriod)}, ` +
        `${C.k2 < C.k1 ? 'but only' : 'and'} <strong style="color:${theme.depth.deep}">${C.k2}</strong> in ${periodLabel(s.period)}.` +
        (Number.isFinite(eq) && C.k2 !== C.k1
          ? ` <span style="color:${theme.quiet}">To reach ${C.k1} again you would need</span> <strong>${aed(eq)}</strong>.` : '');
    }
    headline.html(html);
    modeNums.text(m => {
      const c2 = m === s.mode && !same ? C : comparable(statsFor(s.thenPeriod, { ...s, mode: m }), statsFor(s.period, { ...s, mode: m }));
      return same ? `${c2.k2} of ${c2.n}` : `${c2.k1} → ${c2.k2} of ${c2.n}`;
    });
    budgetBig.text(aed(s.budget));
    budgetSub.text(`for ${s.size} m² · up to AED ${fmt(s.budget / s.size)} per m²`);
    tideTitle.text(`How many of the ${C.n} neighbourhoods your budget reaches, period by period`);
    const sw = (bg, label, extra = '') => `<span style="display:inline-flex;align-items:center;gap:5px"><span style="display:inline-block;` +
      `width:12px;height:10px;border-radius:2px;background:${bg};${extra}"></span>${label}</span>`;
    tideSub.html(sw(sandFill, 'within reach') + sw(waterFill, 'out of reach') +
      sw('repeating-linear-gradient(45deg,#c9d0d8 0 2px,#f1f3f6 2px 5px)', 'too few sales') +
      (Number.isFinite(eqBudget()) ? `<span style="display:inline-flex;align-items:center;gap:5px"><span style="display:inline-block;width:16px;` +
        `border-top:1.5px dashed ${theme.ink}"></span>${aed(eqBudget())}</span>` : ''));
  }

  function drawLegend(s, same) {
    legText.html(`<strong>Sand</strong>: your budget buys a typical home<br>` +
      `<strong style="color:${theme.depth.deep}">Water</strong>: it doesn't (deeper = fewer homes)`);
    legNames.html(`Names: the ${C.n} counted, where<br>they don't overlap · hover for others`);
    legOther.html((same ? '' : `<span><span style="display:inline-block;width:12px;height:10px;border:2px solid ${theme.accent};border-radius:2px;vertical-align:-1px;margin-right:5px"></span>` +
      `<strong>${flipped.length}</strong> went under since ${periodLabel(s.thenPeriod)}</span>`) +
      `<span><span style="display:inline-block;width:12px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:5px;background:${surface ? 'radial-gradient(circle at 35% 35%,#ffffff,#b9c3ce)' : `repeating-linear-gradient(45deg, ${theme.fog} 0 2px, #ffffff 2px 5px)`}"></span>` +
      `Fog: under 20 sales</span>`);
  }

  let heavyTimer = null;
  function drawHeavy(s, same) {
    // Earlier coastlines (tide marks): the "then" one clearer, the others faint. Click one to compare against it.
    const earlier = PERIOD_KEYS.slice(0, PERIOD_KEYS.indexOf(s.period));
    const tides = earlier.map(p => ({ p, d: path(coastFor(statsFor(p, s))) || '' }));
    const tg = gTide.selectAll('g').data(tides, t => t.p).join(enter => {
      const g = enter.append('g').style('cursor', 'pointer');
      g.append('path').attr('class', 'tide-line').attr('fill', 'none').attr('stroke', theme.coastline)
        .attr('stroke-dasharray', '1 3.5').attr('stroke-linecap', 'round').attr('pointer-events', 'none');
      g.append('path').attr('class', 'tide-hit').attr('fill', 'none').attr('stroke', 'transparent')
        .attr('stroke-width', 10).attr('pointer-events', 'stroke');
      return g;
    });
    tg.select('.tide-line').attr('d', t => t.d)
      .attr('stroke-width', t => t.p === s.thenPeriod ? 1.5 : 1).attr('stroke-opacity', t => t.p === s.thenPeriod ? 0.75 : 0.3);
    tg.select('.tide-hit').attr('d', t => t.d)
      .on('mouseenter', function () { d3.select(this.parentNode).select('.tide-line').attr('stroke-opacity', 1).attr('stroke-width', 2); })
      .on('mousemove', (event, t) => showTip(event, `<strong>${periodLabel(t.p)} coastline</strong><br>` +
        `<span style="color:${theme.quiet}">${t.p === s.thenPeriod ? 'The period you are comparing against.' : `Click to compare against ${periodLabel(t.p)}.`}</span>`))
      .on('mouseleave', function (event, t) {
        hideTip();
        d3.select(this.parentNode).select('.tide-line')
          .attr('stroke-opacity', t.p === s.thenPeriod ? 0.75 : 0.3).attr('stroke-width', t.p === s.thenPeriod ? 1.5 : 1);
      })
      .on('click', (event, t) => ev.emit('thenPeriod', t.p));

    drawTide(s, same, s.budget, !!prev && !dragging);
    drawStrip(cur);
  }

  function tideCounts(s, b) {
    const st = { ...s, budget: b };
    return PERIOD_KEYS.map(p => {
      const Sp = statsFor(p, st);
      let land = 0, water = 0, fog = 0;
      C.set.forEach(c => { const x = Sp.get(c); if (!charted(x)) fog++; else if (isLand(x)) land++; else water++; });
      return { p, land, water, fog, Sp };
    });
  }
  function drawTide(s, same, b = s.budget, animate = false) {
    const n = C.n;
    ty.domain([0, Math.max(1, n)]);
    const rows = tideCounts(s, b);
    const T = animate && !reduceMotion ? d3.transition().duration(600).ease(d3.easeCubicInOut) : null;
    const go = sel => T ? sel.interrupt().transition(T) : sel.interrupt();
    const band = (lo, hi) => d3.area().x(d => tx(d.p)).y0(d => ty(lo(d))).y1(d => ty(hi(d)))(rows);
    go(areaSand).attr('d', band(() => 0, d => d.land));
    go(areaWater).attr('d', band(d => d.land, d => d.land + d.water));
    go(areaFog).attr('d', band(d => d.land + d.water, () => n));
    go(tideLine).attr('d', d3.line().x(d => tx(d.p)).y(d => ty(d.land))(rows));

    // the current period's column, and a light grid of counts
    const step = tx.step();
    colBand.attr('x', tx(s.period) - step / 2 + 4).attr('width', step - 8);
    const yt = ty.ticks(4).filter(v => Number.isInteger(v));
    gTideGrid.selectAll('line').data(yt).join('line').attr('x1', tm.l).attr('x2', CW - tm.r + 8)
      .attr('y1', v => ty(v)).attr('y2', v => ty(v)).attr('stroke', '#ffffff').attr('stroke-opacity', 0.55);
    gTideGrid.selectAll('text').data(yt).join('text').attr('x', tm.l - 6).attr('y', v => ty(v)).attr('dy', '0.35em')
      .attr('text-anchor', 'end').attr('fill', theme.quiet).style('font-size', '10.5px').text(v => v);

    // counts on the tide line, one per period
    const pts = gTidePts.selectAll('g').data(rows, d => d.p).join(enter => {
      const g = enter.append('g');
      g.append('circle').attr('r', 4.5).attr('fill', '#ffffff').attr('stroke', theme.coastline).attr('stroke-width', 2);
      g.append('text').attr('text-anchor', 'middle').attr('paint-order', 'stroke').attr('stroke', '#ffffff')
        .attr('stroke-width', 3.5).attr('stroke-linejoin', 'round');
      return g;
    });
    go(pts).attr('transform', d => `translate(${tx(d.p)},${ty(d.land)})`);
    pts.select('text').attr('y', -10).attr('fill', theme.ink)
      .style('font', d => `${d.p === s.period ? 800 : 700} ${d.p === s.period ? 14 : 12.5}px ${theme.font}`).text(d => d.land);

    // area names at the right edge, inside each band when there is room
    const last = rows[rows.length - 1], xr = tx(last.p) + 10;
    const lab = [];
    if (last.land && ty(0) - ty(last.land) > 13) lab.push({ y: ty(last.land / 2), t: `${last.land} within reach`, c: theme.ink });
    if (last.water && ty(last.land) - ty(last.land + last.water) > 13) lab.push({ y: ty(last.land + last.water / 2), t: `${last.water} out of reach`, c: theme.depth.deep });
    gAreaLabels.selectAll('text').data(lab).join('text').attr('x', xr).attr('y', d => d.y).attr('dy', '0.35em')
      .attr('fill', d => d.c).style('font', `600 11px ${theme.font}`).text(d => d.t);

    // x axis: the four periods, with "then" and "now" tags
    const ax = gAxis.selectAll('g').data(PERIOD_KEYS).join(enter => {
      const g = enter.append('g');
      g.append('text').attr('class', 'p').attr('text-anchor', 'middle');
      g.append('text').attr('class', 'tag').attr('text-anchor', 'middle').style('font-size', '10px');
      return g;
    }).attr('transform', p => `translate(${tx(p)},${TH - tm.b + 16})`);
    ax.select('.p').attr('fill', p => p === s.period ? theme.ink : theme.quiet)
      .style('font', p => `${p === s.period ? 700 : 400} 11px ${theme.font}`).text(p => periodLabel(p));
    ax.select('.tag').attr('y', 13).attr('fill', p => p === s.period ? theme.ink : theme.quiet)
      .text(p => p === s.period ? 'now (on the map)' : (!same && p === s.thenPeriod) ? 'then' : '');

    // dashed: the budget that reaches as many now as yours did then, across all four periods
    const eq = eqBudget();
    eqHit.selectAll('*').remove();
    if (Number.isFinite(eq) && !dragging) {
      const er = tideCounts(s, eq);
      go(eqLine).attr('d', d3.line().x(d => tx(d.p)).y(d => ty(d.land))(er)).attr('opacity', 1);
      // labelled where it matters: at the period on the map, where it meets "then"'s count
      const le = er.find(d => d.p === s.period), atEnd = s.period === PERIOD_KEYS[PERIOD_KEYS.length - 1];
      eqHit.on('click', () => ev.emit('budget', eq)).append('title').text(`Set your budget to ${aed(eq)}`);
      eqHit.append('text').attr('x', tx(le.p) + (atEnd ? 10 : 0)).attr('y', ty(le.land) - (atEnd ? 8 : 12))
        .attr('text-anchor', atEnd ? 'start' : 'middle').attr('fill', theme.ink)
        .style('font', `600 10.5px ${theme.font}`).attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3)
        .text(`${short$(eq)} reaches ${le.land} ›`);
    } else if (!Number.isFinite(eq)) eqLine.attr('opacity', 0);

    // period columns: hover previews that period on the map, click shows it
    gCols.selectAll('rect').data(rows, d => d.p).join('rect').attr('x', d => tx(d.p) - step / 2).attr('width', step)
      .attr('y', tm.t - 12).attr('height', TH - tm.t - tm.b + 40).attr('fill', 'transparent')
      .style('cursor', d => d.p === s.period ? 'default' : 'pointer')
      .on('mouseenter', (event, d) => hoverPeriod(d, rows, true))
      .on('mousemove', (event, d) => showTip(event, periodTip(d, rows)))
      .on('mouseleave', (event, d) => { hoverPeriod(d, rows, false); hideTip(); })
      .on('click', (event, d) => { hideTip(); hoverPeriod(d, rows, false); if (d.p !== cur.period) ev.emit('period', d.p); });
  }
  const stepChanges = (d, rows) => {
    const i = rows.findIndex(r => r.p === d.p);
    if (i < 1) return { under: [], back: [] };
    const P0 = rows[i - 1].Sp, P1 = d.Sp;
    return { prev: rows[i - 1].p, under: C.set.filter(c => isLand(P0.get(c)) && isWater(P1.get(c))),
      back: C.set.filter(c => isWater(P0.get(c)) && isLand(P1.get(c))) };
  };
  const listNames = list => { const nm = list.map(c => shortName(nameOf(c))); return nm.length > 4 ? `${nm.slice(0, 4).join(', ')} and ${nm.length - 4} more` : nm.join(', '); };
  function periodTip(d, rows) {
    const ch = stepChanges(d, rows);
    return `<strong>${periodLabel(d.p)}</strong>: <strong>${d.land}</strong> within reach · ${d.water} out of reach` +
      (d.fog ? ` · ${d.fog} too few sales` : '') +
      (ch.under.length ? `<br><span style="color:${theme.accent};font-weight:600">Went under since ${periodLabel(ch.prev)}:</span> ${listNames(ch.under)}` : '') +
      (ch.back.length ? `<br>Came back within reach: ${listNames(ch.back)}` : '') +
      `<br><span style="color:${theme.quiet}">${d.p === cur.period ? 'This period is on the map.' : 'Its coastline is dashed on the map. Click to show it.'}</span>`;
  }
  function hoverPeriod(d, rows, on) {
    hoverGuide.attr('x1', tx(d.p)).attr('x2', tx(d.p)).attr('stroke-opacity', on ? 0.5 : 0);
    if (on) { if (d.p !== cur.period) preview(d.Sp); showFlips(stepChanges(d, rows).under); }
    else { endPreview(); showFlips(flipped); }
  }

  // Budget bar, handle, the big number, and the "reach again" mark; while dragging, the tide redraws live
  function placeBudget(b, animate, xOverride) {
    if (!cur || !C) return;
    const x = xOverride ?? bx(b);
    const t = animate && !reduceMotion ? d3.transition().duration(450).ease(d3.easeCubicOut) : null;
    const go = sel => t ? sel.interrupt().transition(t) : sel.interrupt();
    go(barFill).attr('width', Math.max(0, x - bm.l));
    go(knob).attr('transform', `translate(${x},${barY})`);
    knob.attr('aria-valuenow', b).attr('aria-valuetext', aed(b));
    budgetBig.text(aed(b));
    budgetSub.text(`for ${cur.size} m² · up to AED ${fmt(b / cur.size)} per m²`);
    if (xOverride != null) drawTide(cur, cur.thenPeriod === cur.period, b, false);

    eqMark.selectAll('*').remove();
    const eq = eqBudget();
    if (Number.isFinite(eq)) {
      const ex = bx(eq);
      eqMark.on('click', () => ev.emit('budget', eq)).append('title').text(`Set your budget to ${aed(eq)}`);
      eqMark.append('path').attr('d', `M${ex},${barY - 7}l-5,-8h10z`).attr('fill', '#ffffff')
        .attr('stroke', theme.ink).attr('stroke-width', 1.4);
      if (Math.abs(ex - x) > 30) eqMark.append('text').attr('x', ex).attr('y', barY - 18).attr('text-anchor', 'middle')
        .attr('fill', theme.ink).attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3)
        .style('font', `600 10px ${theme.font}`).text(`${short$(eq)} reaches as many as in ${periodLabel(cur.thenPeriod)}`);
    }
  }

  // The selected (or hovered) neighbourhood under the chart: its typical price in each period,
  // each cell in the colour that neighbourhood has on the map in that period
  function drawStrip(s) {
    if (!s) return;
    gStrip.selectAll('*').remove();
    const c = s.hovered || s.selected;
    if (!c || !byComm.has(c)) {
      gStrip.append('text').attr('x', CW / 2).attr('y', 34).attr('text-anchor', 'middle').attr('fill', theme.quiet)
        .style('font-size', `${theme.size.small}px`).text('Hover or click a neighbourhood to see its typical price in each period');
      return;
    }
    gStrip.append('text').attr('x', 0).attr('y', 12).attr('fill', theme.ink).style('font', `700 ${theme.size.small}px ${theme.font}`)
      .text(`${nameOf(c)}`).append('tspan').attr('fill', theme.quiet).style('font-weight', 400)
      .text(` · typical ${s.size} m² ${homeWord()} in each period`);
    const w = Math.min(tx.step() - 8, 92);
    PERIOD_KEYS.forEach(p => {
      const st = statsFor(p, s).get(c);
      const ok = charted(st), out = ok ? outOf(st) : 0;
      const g = gStrip.append('g').attr('transform', `translate(${tx(p)},38)`);
      g.append('rect').attr('x', -w / 2).attr('y', -13).attr('width', w).attr('height', 26).attr('rx', 6)
        .attr('fill', !st ? noSales : !ok ? 'url(#vb-tide-fog)' : depthColor(out))
        .attr('stroke', p === s.period ? theme.ink : 'none').attr('stroke-width', 1.5);
      g.append('text').attr('text-anchor', 'middle').attr('dy', '0.35em')
        .attr('fill', ok && out > 0.62 ? '#ffffff' : theme.ink).style('font', `700 11.5px ${theme.font}`)
        .text(!st ? 'no sales' : !ok ? `${st.n} sales` : aed(st.edge).replace('AED ', ''));
    });
  }

  function drawMarks(s) {
    modeButtons
      .attr('aria-pressed', d => String(d === s.mode))
      .style('background-color', d => d === s.mode ? '#ffffff' : 'transparent')
      .style('color', d => d === s.mode ? theme.ink : theme.quiet)
      .style('box-shadow', d => d === s.mode ? '0 1px 3px rgba(15,30,50,0.14)' : 'none');

    const fogHighlight = s.highlight === 'fog';
    commPaths.attr('stroke', f => fogHighlight && kindOf(commOfF(f)) === 'fog' ? theme.accent : '#ffffff')
      .attr('stroke-width', f => fogHighlight && kindOf(commOfF(f)) === 'fog' ? 1.5 : 0.6);

    const marks = [];
    (s.pinned || []).forEach((c, i) => marks.push({ c, kind: 'pinned', i }));
    if (s.hovered && s.hovered !== s.selected) marks.push({ c: s.hovered, kind: 'hovered' });
    if (s.selected) marks.push({ c: s.selected, kind: 'selected' });
    gMarks.selectAll('path').data(marks.filter(m => byComm.has(m.c)), m => m.kind + m.c).join('path')
      .attr('d', m => path(byComm.get(m.c))).attr('fill', 'none').attr('stroke', theme.ink)
      .attr('stroke-width', m => m.kind === 'selected' ? 3 : m.kind === 'hovered' ? 2 : 1.6)
      .attr('stroke-dasharray', m => m.kind === 'pinned' ? '4 3' : null);
    drawStrip(s);
    forcedLabels(s);
  }

  // ---------- the moving water and fog ----------
  // Masks are rasterised from the same shapes as the map; while dragging they refresh a few times a
  // second with a short cross-fade, otherwise once per change with a long one that rides the tide.
  const drawCtxPath = d3.geoPath(projection);
  let maskTimer = null, lastMask = 0;
  function updateSurface(ms) {
    if (!surface) return;
    const run = () => {
      lastMask = performance.now();
      const groups = { water: [], fog: [], land: [] };
      features.forEach(f => {
        const st = S.get(commOfF(f));
        if (isWater(st)) groups.water.push(f); else if (isLand(st)) groups.land.push(f); else if (st) groups.fog.push(f);
      });
      surface.setMasks((ctx, which) => { drawCtxPath.context(ctx); groups[which].forEach(f => drawCtxPath(f)); drawCtxPath.context(null); },
        reduceMotion ? 0 : ms, performance.now());
      wake();
    };
    clearTimeout(maskTimer);
    const since = performance.now() - lastMask;
    if (dragging && since < 70) maskTimer = setTimeout(run, 70 - since); else run();
  }
  let raf = null, visible = true, clock = null;
  function frame(now) {
    const fading = surface.draw(clock ? clock() : now / 1000, now);
    raf = visible && (!reduceMotion || fading) ? requestAnimationFrame(frame) : null;
  }
  function wake() { if (surface && !raf && visible) raf = requestAnimationFrame(frame); }
  if (surface && 'IntersectionObserver' in window) new IntersectionObserver(es => {
    visible = es[es.length - 1].isIntersecting; if (visible) wake();
  }).observe(mapBox.node());

  const DATA_KEYS = ['period', 'thenPeriod', 'mode', 'homeType', 'money', 'dropExtremes', 'budget', 'size'];
  return {
    update(s) {
      cur = s;
      const dataChanged = !prev || DATA_KEYS.some(k => prev[k] !== s[k]);
      if (dataChanged) drawData(s, !!prev && !dragging);
      const pinsChanged = !prev || (prev.pinned || []).join() !== (s.pinned || []).join();
      if (dataChanged || prev.selected !== s.selected || prev.hovered !== s.hovered || pinsChanged ||
          prev.highlight !== s.highlight) drawMarks(s);
      prev = s;
    },
    on: ev.on,
    // for recording demos at a steady frame rate: replace the clock (null restores real time)
    _setClock: fn => { clock = fn; },
    // for tests and the referee script: the numbers this view shows
    _debug: s => ({ comparable: comparable(statsFor(s.thenPeriod, s), statsFor(s.period, s)) })
  };
}
