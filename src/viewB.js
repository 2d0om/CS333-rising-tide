// src/viewB.js — View B, "The Sea" (Member 2)
// Sand is where your budget buys a typical home; water is where it does not, deeper where fewer
// homes are within reach.
// Contract: createViewB(container, data, theme, { width, height, guessFirst? }) -> { update(state), on(event, handler) }
// Opens with "draw your guess" (AED 1M, 80 m², 2015–26) over the panel; guessFirst: false skips it.
// Emits: select, pin, hover, mode, thenPeriod, period, budget.
//
// Design rules for this view:
//   * Plain words and counts, not percentages of abstractions: "AED 1.2M buys a typical 80 m²
//     apartment in 26 of 35 neighbourhoods in 2015–17, but only 11 in 2024–26."
//   * What matters is on screen without hovering: two big numbers (then → now), the reach curves
//     (one line per period: how many neighbourhoods each budget reaches), the typical price in each
//     period, and orange outlines on the neighbourhoods that went under. Clicking a neighbourhood
//     traces it through the four periods on the chart. Hover only adds a tooltip.
//   * Every colour is exact: one fill per community from its own sales. The coastline runs along
//     real community borders, never interpolated. Moving water and fog (surface.js) only add light
//     and texture; names, borders, the coastline and selections stay above them.
//   * Everything fits one screen: a title on top; the map on the left with your budget right on top
//     of it; the finding, two plain filters and the reach chart on the right.
//   * Only things that respond look like they respond. Areas with no sales do nothing.
import { emitter } from './emitter.js';
import * as R from './rules.js';
import { createSurface } from './surface.js';

export const BUILD = 'View B · blue description in the map colours · 2026-11-21';

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

export function createViewB(container, data, theme, { width, height, guessFirst = true }) {
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

  // The counted set: neighbourhoods with 20+ sales in EVERY period (30 at the defaults). One fixed
  // set means every count is "of 30" in every period, and a neighbourhood can never drop out of a
  // period's count just because it had too few sales that period (which looks like a price change
  // but is not). The team's two-period like-for-like rule gives 35 for 2015–17 vs 2024–26.
  function reach(s) {
    const all = PERIOD_KEYS.map(p => statsFor(p, s));
    const set = [...all[0].keys()].filter(c => all.every(Sp => charted(Sp.get(c))));
    const S1 = statsFor(s.thenPeriod, s), S2 = statsFor(s.period, s);
    const k1 = set.filter(c => isLand(S1.get(c))).length, k2 = set.filter(c => isLand(S2.get(c))).length;
    return { set, n: set.length, k1, k2, land1: set.length ? k1 / set.length : NaN, land2: set.length ? k2 / set.length : NaN };
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
  // A title across the top. Wide: the map column on the left (your budget right on top of the map it
  // controls, the map, its key) and the panel on the right (the finding, two filters, the reach chart).
  // Narrow: everything stacked.
  const wide = width >= 900;
  const colGap = 22, rowGap = 10;
  root.style('display', 'flex').style('flex-direction', 'column').style('gap', `${rowGap}px`)
    .style('width', `${width}px`).style('height', `${height}px`);

  // 0. The title: what this is about in one line, and what to do with it
  const header = root.append('div').style('flex', 'none');
  header.append('div').style('font', `700 10.5px ${theme.font}`).style('letter-spacing', '0.12em')
    .style('text-transform', 'uppercase').style('color', theme.depth.shallow).text('The Sea · a buyer’s view of Dubai, 2015–2026');
  header.append('div').attr('role', 'heading').attr('aria-level', 2)
    .style('font', `800 25px/1.15 ${theme.font}`).style('margin-top', '3px').style('letter-spacing', '-0.01em')
    .text('Where can your budget still find dry land?');
  // The description, in the map's own colours: the words sand and water look like the map's sand and water
  const SAND_WORD = '#a8803a';
  const sub = header.append('div').style('font', `500 ${theme.size.label + 1.5}px/1.45 ${theme.font}`)
    .style('color', theme.depth.deep).style('margin-top', '4px');
  const describe = (size, word) => sub.html(`Your budget is the tide line. ` +
    `<strong style="color:${SAND_WORD}">Sand</strong> is where it still buys a typical ${size} m² ${word}; ` +
    `<strong style="color:${theme.depth.deep}">water</strong> is where it no longer does. Drag it and watch the coast move.`);
  describe(80, 'apartment');
  const headH = header.node().getBoundingClientRect().height || 64;

  const bodyH = height - headH - rowGap;
  const body = root.append('div').style('display', 'flex').style('flex-direction', wide ? 'row' : 'column')
    .style('gap', `${colGap}px`).style('flex', 'none');
  const panelW = wide ? Math.round(Math.max(360, Math.min(440, width * 0.33))) : width;
  const mapW = wide ? width - panelW - colGap : width;
  const stripH = 58;
  const mapH = wide ? bodyH - stripH : Math.max(360, bodyH - 640 - colGap - stripH);
  const panelH = wide ? bodyH : 640;

  // The map column: your budget sits right on top of the map it controls
  const mapCol = body.append('div').style('width', `${mapW}px`).style('flex', 'none')
    .style('display', 'flex').style('flex-direction', 'column');
  const strip = mapCol.append('div').style('height', `${stripH}px`).style('flex', 'none');
  const mapBox = mapCol.append('div').style('position', 'relative').style('width', `${mapW}px`).style('height', `${mapH}px`)
    .style('flex', 'none').style('border-radius', '12px').style('overflow', 'hidden');
  const panel = body.append('div').style('width', `${panelW}px`).style('height', `${panelH}px`).style('flex', 'none')
    .style('display', 'flex').style('flex-direction', 'column').style('gap', '12px').style('min-width', '0');

  // 1. The finding: one sentence with two labelled numbers
  const headline = panel.append('div').style('min-height', '150px');

  // 2. Two filters, each under a plain label
  const label = t => panel.append('div').style('font', `700 10.5px ${theme.font}`).style('letter-spacing', '0.08em')
    .style('text-transform', 'uppercase').style('color', theme.quiet).style('margin-bottom', '-6px').text(t);
  label('Which homes');
  const modeGroup = panel.append('div').attr('role', 'group').attr('aria-label', 'Which homes')
    .style('display', 'grid').style('grid-template-columns', '1fr 1fr 1fr').style('padding', '3px').style('gap', '2px')
    .style('background', '#eef1f5').style('border-radius', '10px');
  const modeButtons = modeGroup.selectAll('button').data(['all', 'ready', 'offplan']).join('button')
    .attr('type', 'button').style('font', `600 ${theme.size.small + 0.5}px ${theme.font}`).style('padding', '7px 4px')
    .style('border', '0').style('border-radius', '8px').style('cursor', 'pointer')
    .style('transition', 'background-color .2s, color .2s, box-shadow .2s')
    .text(d => MODE_LABEL[d]);

  //    The four periods in time order, each with its line colour and the typical price then (the middle
  //    neighbourhood, or the one you clicked). The dark one is on the map; click another to show it.
  const chipHead = panel.append('div').style('font', `700 10.5px ${theme.font}`).style('color', theme.quiet)
    .style('margin-bottom', '-6px').style('min-height', '14px').style('white-space', 'nowrap').style('overflow', 'hidden');
  const chips = panel.append('div').style('display', 'grid').style('grid-template-columns', 'repeat(4, 1fr)').style('gap', '6px')
    .style('min-height', '48px');
  // 3. Reach curves
  const chartHead = panel.append('div').style('font', `600 ${theme.size.small + 0.5}px ${theme.font}`).style('min-height', '16px');
  const chartBox = panel.append('div').style('margin-top', '-6px');

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
  const commPaths = svg.append('g').selectAll('path').data(features, commOfF).join('path')
    .attr('d', path).attr('fill', noSales).attr('stroke', '#ffffff').attr('stroke-width', 0.6);

  const surface = createSurface(mapW, mapH);
  if (surface) mapBox.node().appendChild(surface.canvas);

  const top = mapBox.append('svg').attr('width', mapW).attr('height', mapH).attr('aria-hidden', true)
    .style('position', 'absolute').style('left', 0).style('top', 0).style('pointer-events', 'none');
  top.append('path').attr('d', path(topojson.mesh(topo, topo.objects.c, (a, b) => a !== b))).attr('fill', 'none')
    .attr('stroke', '#ffffff').attr('stroke-opacity', 0.5).attr('stroke-width', 0.6);   // borders stay crisp above fog
  top.append('text').attr('x', 16).attr('y', 24).attr('fill', theme.quiet).attr('paint-order', 'stroke')
    .attr('stroke', '#ffffff').attr('stroke-width', 3).attr('stroke-opacity', 0.8)
    .style('font-size', `${theme.size.small}px`).style('font-style', 'italic').text('Arabian Gulf (the real sea)');
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

  // ---------- reach curves ----------
  // x = budget (log), y = how many of the comparable neighbourhoods that budget reaches. One step line
  // per period, coloured light → dark in time order (lightness for an ordered attribute); every step
  // is one neighbourhood. A curve further right means the same reach costs more. The vertical line is
  // your budget, the same one as the bar on the map: drag or click in the plot to move it too.
  const PCOL = ['#b3bfcc', '#8c9fb5', '#5f7d9c', theme.depth.deep];
  const pcol = p => PCOL[Math.min(PCOL.length - 1, PERIOD_KEYS.indexOf(p))];
  const CW = panelW;
  const kids = panel.selectAll(':scope > div').nodes().filter(n => n !== chartBox.node());
  const usedH = d3.sum(kids, n => n.getBoundingClientRect().height) + 12 * kids.length - 6 * 3;
  const chartH = Math.max(220, Math.min(440, panelH - usedH));
  const chart = chartBox.append('svg').attr('width', CW).attr('height', chartH).style('display', 'block').style('overflow', 'visible');
  const cm = { l: 30, r: 16, t: 18 };
  const plotB = chartH - 34;
  const cx = d3.scaleLog().domain([BUDGET_MIN, BUDGET_MAX]).range([cm.l, CW - cm.r]).clamp(true);
  const cy = d3.scaleLinear().range([plotB, cm.t]);
  const cdefs = chart.append('defs');
  cdefs.append('marker').attr('id', 'vb-arrow').attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
    .attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto-start-reverse')
    .append('path').attr('d', 'M0,1L9,5L0,9z').attr('fill', theme.ink);
  const gGrid = chart.append('g').attr('pointer-events', 'none');
  const plotBg = chart.append('rect').attr('x', cm.l).attr('y', cm.t).attr('width', CW - cm.l - cm.r)
    .attr('height', plotB - cm.t).attr('fill', 'transparent').style('cursor', 'pointer');
  const band = chart.append('path').attr('fill', theme.depth.shallow).attr('fill-opacity', 0.14).attr('pointer-events', 'none');
  const gLines = chart.append('g');
  const budgetLine = chart.append('line').attr('y1', cm.t - 4).attr('y2', plotB)
    .attr('stroke', theme.ink).attr('stroke-opacity', 0.55).attr('stroke-width', 1).attr('pointer-events', 'none');
  const gEq = chart.append('g');
  const gDots = chart.append('g').attr('pointer-events', 'none');
  const gTrace = chart.append('g').attr('pointer-events', 'none');
  const tickVals = [400e3, 600e3, 800e3, 1e6, 1.5e6, 2e6, 3e6, 4e6];
  chart.append('g').attr('pointer-events', 'none').selectAll('text').data(tickVals).join('text')
    .attr('x', v => cx(v)).attr('y', plotB + 15).attr('text-anchor', 'middle').attr('fill', theme.quiet)
    .style('font-size', '10.5px').text(v => short$(v));
  chart.append('text').attr('x', CW - cm.r).attr('y', plotB + 30).attr('text-anchor', 'end').attr('fill', theme.quiet)
    .style('font-size', '10.5px').attr('pointer-events', 'none').text('budget (AED) →');
  const step = d3.line().curve(d3.curveStepAfter).x(d => cx(d[0])).y(d => cy(d[1]));
  const stepArea = d3.area().curve(d3.curveStepAfter).x(d => cx(d[0])).y0(d => cy(d[1])).y1(d => cy(d[2]));

  // ---------- your budget: a bar right on top of the map ----------
  // Same log scale as the chart. Each notch is one counted neighbourhood at its typical price in the
  // period on the map: sand once your budget reaches it, sea-blue while it is out of reach. So the bar
  // shows where the next neighbourhoods come into reach before you drag. The orange notch is the one
  // you clicked.
  const labW = 116, trackY = 25;
  const ssvg = strip.append('svg').attr('width', mapW).attr('height', stripH).style('display', 'block').style('overflow', 'visible');
  ssvg.append('defs').append('filter').attr('id', 'vb-knob-shadow').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%')
    .append('feDropShadow').attr('dx', 0).attr('dy', 1.5).attr('stdDeviation', 2).attr('flood-color', '#0b2540').attr('flood-opacity', 0.28);
  const barX = d3.scaleLog().domain([BUDGET_MIN, BUDGET_MAX]).range([labW + 12, mapW - 14]).clamp(true);
  ssvg.append('text').attr('x', 2).attr('y', 15).attr('fill', theme.quiet).style('font', `700 10.5px ${theme.font}`)
    .style('letter-spacing', '0.08em').text('YOUR BUDGET');
  const sVal = ssvg.append('text').attr('x', 2).attr('y', 40).attr('fill', theme.ink)
    .style('font', `800 21px ${theme.font}`).style('font-variant-numeric', 'tabular-nums');
  const sHit = ssvg.append('rect').attr('x', barX.range()[0] - 10).attr('y', 2).attr('width', barX.range()[1] - barX.range()[0] + 20)
    .attr('height', 40).attr('fill', 'transparent').style('cursor', 'pointer');
  ssvg.append('rect').attr('x', barX.range()[0]).attr('y', trackY - 3).attr('width', barX.range()[1] - barX.range()[0]).attr('height', 6)
    .attr('rx', 3).attr('fill', '#e3e8ee').attr('pointer-events', 'none');
  const sFill = ssvg.append('rect').attr('x', barX.range()[0]).attr('y', trackY - 3).attr('height', 6).attr('rx', 3)
    .attr('fill', theme.depth.deep).attr('pointer-events', 'none');
  const gNotch = ssvg.append('g');
  ssvg.append('g').attr('pointer-events', 'none').selectAll('text').data(tickVals).join('text')
    .attr('x', v => barX(v)).attr('y', trackY + 24).attr('text-anchor', 'middle').attr('fill', theme.quiet)
    .style('font-size', '10.5px').text(v => short$(v));
  const knob = ssvg.append('g').attr('tabindex', 0).attr('role', 'slider')
    .attr('aria-label', 'Your budget. Arrow keys change it.')
    .attr('aria-valuemin', BUDGET_MIN).attr('aria-valuemax', BUDGET_MAX).style('cursor', 'grab').style('outline', 'none');
  const knobHalo = knob.append('circle').attr('r', 16).attr('fill', theme.depth.deep).attr('fill-opacity', 0);
  knob.append('circle').attr('r', 9.5).attr('fill', '#ffffff').attr('stroke', theme.depth.deep)
    .attr('stroke-width', 2.5).attr('filter', 'url(#vb-knob-shadow)');
  knob.on('mouseenter', () => knobHalo.transition().duration(150).attr('fill-opacity', 0.12))
    .on('mouseleave', () => { if (!dragging) knobHalo.transition().duration(200).attr('fill-opacity', 0); })
    .on('focus', () => knobHalo.attr('fill-opacity', 0.18)).on('blur', () => knobHalo.attr('fill-opacity', 0));
  const SAND_MARK = '#bf9f5a';
  function colourNotches(b) {
    const sel = cur && cur.selected;
    gNotch.selectAll('line.nl')
      .attr('stroke', d => d.c === sel ? theme.accent : d.e <= b ? SAND_MARK : theme.depth.deep)
      .attr('stroke-width', d => d.c === sel ? 3 : 2)
      .attr('y1', d => d.c === sel ? trackY - 17 : trackY - 13);
  }

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
  let flipped = [], periodsInfo = [];
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

  // Budget: drag the knob or anywhere on the bar above the map (or in the reach chart); click to jump;
  // arrow keys on the knob. While dragging, everything follows the pointer exactly; the budget sent is rounded.
  let pending = null;
  function sendBudget(b, raw) {
    placeBudget(b, false, raw);
    if (pending == null) requestAnimationFrame(() => { const v = pending; pending = null; if (v != null) ev.emit('budget', v); });
    pending = b;
  }
  const clampTo = (sc, x) => { const [a, z] = sc.range(); return Math.max(a, Math.min(z, x)); };
  const budgetAt = (sc, x) => sc.invert(clampTo(sc, x));
  const dragOn = (sc, node) => d3.drag().container(node).clickDistance(3)
    .on('start', () => { knobHalo.interrupt().attr('fill-opacity', 0.16); knob.style('cursor', 'grabbing'); })
    .on('drag', e => { if (cur) { dragging = true; const raw = budgetAt(sc, e.x); sendBudget(roundBudget(raw), raw); } })
    .on('end', () => {
      knob.style('cursor', 'grab'); knobHalo.transition().duration(250).attr('fill-opacity', 0);
      requestAnimationFrame(() => requestAnimationFrame(() => { dragging = false; if (cur) placeBudget(cur.budget, true); }));
    });
  const jumpOn = (sc, node) => event => { if (cur) ev.emit('budget', roundBudget(budgetAt(sc, d3.pointer(event, node)[0]))); };
  sHit.call(dragOn(barX, ssvg.node())).on('click', jumpOn(barX, ssvg.node()));
  plotBg.call(dragOn(cx, chart.node())).on('click', jumpOn(cx, chart.node()));
  knob.call(dragOn(barX, ssvg.node())).on('keydown', event => {
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
    C = reach(s);
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
    // One sentence, with the two counts as big labelled numbers. The odd cases (nothing or everything
    // in reach) are said in words, never as "0 → 0".
    const home = `a typical ${s.size} m² ${homeWord()}`;
    const money = `<strong>${aed(s.budget)}</strong>`;
    const lead = `<div style="font-size:${theme.size.label + 1.5}px;line-height:1.4">`;
    const num = (v, c, t) => `<div><div style="font-size:44px;font-weight:800;line-height:1;color:${c};font-variant-numeric:tabular-nums">${v}</div>` +
      `<div style="font-size:11px;color:${theme.quiet};margin-top:3px">${t}</div></div>`;
    const ofN = `<div style="font-size:${theme.size.small + 0.5}px;color:${theme.quiet}">of the ${C.n} neighbourhoods with enough sales to compare</div>`;
    const cheapest = Sp => d3.min(C.set, c => Sp.get(c).edge);
    let html;
    if (!C.n) html = `${lead}Too few sales of these homes to compare neighbourhoods.</div>`;
    else if (C.k1 === 0 && C.k2 === 0) html = `${lead}${money} doesn't buy ${home} in any of the ${C.n} neighbourhoods` +
      `${same ? ` in ${periodLabel(s.period)}` : ', then or now'}.</div>` +
      `<div style="font-size:${theme.size.label}px;line-height:1.45;margin-top:8px">The cheapest needed <strong>${aed(cheapest(Sthen))}</strong>` +
      `${same ? '' : ` in ${periodLabel(s.thenPeriod)} and <strong>${aed(cheapest(S))}</strong> in ${periodLabel(s.period)}`}.</div>`;
    else if (C.k1 === C.n && C.k2 === C.n) html = `${lead}${money} buys ${home} in all ${C.n} neighbourhoods` +
      `${same ? ` in ${periodLabel(s.period)}` : ', then and now'}.</div>`;
    else html = `${lead}${money} buys ${home} in</div>` +
      `<div style="display:flex;align-items:flex-start;gap:14px;margin:6px 0 5px">` +
      (same ? num(C.k2, theme.depth.deep, periodLabel(s.period))
        : num(C.k1, '#8493a5', periodLabel(s.thenPeriod)) + `<div style="font-size:26px;color:${theme.quiet};line-height:44px">→</div>` +
          num(C.k2, theme.depth.deep, periodLabel(s.period))) + `</div>${ofN}`;
    headline.html(html);
    describe(s.size, homeWord());
    // Why: computed from the same sales. What is being sold changed (more off-plan), and off-plan
    // costs more than resale in the same neighbourhood. Shown only when the data supports it.
    let why = '';
    if (!same && s.mode === 'all' && C.k2 < C.k1) {
      const cnt = (p, m) => { const mp = pricesBy(p, { ...s, mode: m }); return d3.sum(C.set, c => (mp.get(c) || []).length); };
      const share = p => cnt(p, 'offplan') / Math.max(1, cnt(p, 'offplan') + cnt(p, 'ready'));
      const off = pricesBy(s.period, { ...s, mode: 'offplan' }), rdy = pricesBy(s.period, { ...s, mode: 'ready' });
      const prem = d3.median(C.set.filter(c => (off.get(c) || []).length >= R.MIN_SALES && (rdy.get(c) || []).length >= R.MIN_SALES),
        c => d3.quantileSorted(off.get(c), 0.5) / d3.quantileSorted(rdy.get(c), 0.5));
      const a = share(s.thenPeriod), z = share(s.period);
      if (z - a >= 0.05 && prem >= 1.1) why = `<div style="font-size:${theme.size.small}px;line-height:1.45;margin-top:6px">` +
        `<strong>Why so sharp?</strong> New launches. ${Math.round(z * 10)} in 10 homes sold are now off-plan (${Math.round(a * 10)} in 10 in ${periodLabel(s.thenPeriod)}), ` +
        `at about ${d3.format('.1f')(prem)}× the resale price next door.</div>`;
    }
    headline.html(headline.html() + why);
    chartHead.html(`Neighbourhoods within reach, by budget <span style="font-weight:400;color:${theme.quiet}">· one line per period</span>`);
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

    drawCurve(s, same);
  }

  function drawCurve(s, same) {
    const set = C.set, n = C.n;
    cy.domain([0, Math.max(1, n)]);
    periodsInfo = PERIOD_KEYS.map(p => {
      const Sp = p === s.period ? S : p === s.thenPeriod ? Sthen : statsFor(p, s);
      const edges = set.filter(c => charted(Sp.get(c))).map(c => Sp.get(c).edge).sort(d3.ascending);
      const pts = [[BUDGET_MIN, d3.bisectRight(edges, BUDGET_MIN)]];
      edges.forEach((e, i) => { if (e > BUDGET_MIN && e < BUDGET_MAX) pts.push([e, i + 1]); });
      pts.push([BUDGET_MAX, d3.bisectRight(edges, BUDGET_MAX)]);
      return { p, pts, edges, Sp };
    }).filter(d => d.edges.length);
    const role = p => p === s.period ? 'now' : (!same && p === s.thenPeriod) ? 'then' : 'other';
    const widthOf = d => ({ now: 3, then: 2.4, other: 1.1 })[role(d.p)];

    const yt = cy.ticks(4).filter(Number.isInteger);
    gGrid.selectAll('line').data(yt).join('line').attr('x1', cm.l).attr('x2', CW - cm.r)
      .attr('y1', v => cy(v)).attr('y2', v => cy(v)).attr('stroke', theme.grid);
    gGrid.selectAll('text').data(yt).join('text').attr('x', cm.l - 6).attr('y', v => cy(v)).attr('dy', '0.35em')
      .attr('text-anchor', 'end').attr('fill', theme.quiet).style('font-size', '10.5px').text(v => v);

    // the reach lost between then and now, shaded
    const nowI = periodsInfo.find(d => d.p === s.period), thenI = same ? null : periodsInfo.find(d => d.p === s.thenPeriod);
    if (nowI && thenI) {
      const at = (d, b) => d3.bisectRight(d.edges, b);
      const xs = [...new Set([BUDGET_MIN, ...nowI.edges, ...thenI.edges, BUDGET_MAX])]
        .filter(b => b >= BUDGET_MIN && b <= BUDGET_MAX).sort(d3.ascending);
      band.attr('d', stepArea(xs.map(b => [b, at(nowI, b), Math.max(at(nowI, b), at(thenI, b))]))).attr('opacity', 1);
    } else band.attr('opacity', 0);

    const order = { other: 0, then: 1, now: 2 };
    const lines = gLines.selectAll('g').data(periodsInfo.slice().sort((a, b) => order[role(a.p)] - order[role(b.p)]), d => d.p)
      .join(enter => {
        const g = enter.append('g').style('cursor', 'pointer');
        g.append('path').attr('class', 'ln').attr('fill', 'none').attr('stroke-linejoin', 'round');
        g.append('path').attr('class', 'hit').attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 10);
        return g;
      }).order();
    lines.select('.ln').attr('stroke', d => pcol(d.p)).attr('stroke-width', widthOf).attr('d', d => step(d.pts));
    lines.select('.hit').attr('d', d => step(d.pts))
      .on('mouseenter', (event, d) => { if (d.p !== cur.period) preview(d.Sp); })
      .on('mousemove', (event, d) => showTip(event, `<strong>${periodLabel(d.p)}</strong>: your budget reaches ${d3.bisectRight(d.edges, cur.budget)} of ${d.edges.length}` +
        (d.edges.length < n ? ` <span style="color:${theme.quiet}">(${n - d.edges.length} had too few sales)</span>` : '') +
        `<br><span style="color:${theme.quiet}">${d.p === cur.period ? 'The period on the map.' : 'Click to show this period on the map.'}</span>`))
      .on('mouseleave', () => { hideTip(); endPreview(); })
      .on('click', (event, d) => { event.stopPropagation(); hideTip(); endPreview(); if (d.p !== cur.period) ev.emit('period', d.p); });

    drawNotches(s);
    placeBudget(s.budget, !!prev && !dragging);
    drawTrace(cur);
  }

  function drawNotches(s) {
    const items = C.set.map(c => ({ c, e: S.get(c).edge })).filter(d => d.e >= BUDGET_MIN && d.e <= BUDGET_MAX);
    const g = gNotch.selectAll('g').data(items, d => d.c).join(enter => {
      const n = enter.append('g').style('cursor', 'pointer').attr('transform', d => `translate(${barX(d.e)},0)`);
      n.append('line').attr('class', 'nl').attr('y2', trackY - 5).attr('stroke-linecap', 'round');
      n.append('rect').attr('x', -3.5).attr('width', 7).attr('y', trackY - 19).attr('height', 15).attr('fill', 'transparent');
      return n;
    });
    (dragging || reduceMotion ? g : g.transition().duration(700).ease(d3.easeSinInOut)).attr('transform', d => `translate(${barX(d.e)},0)`);
    g.on('mousemove', (event, d) => {
      if (cur.hovered !== d.c) ev.emit('hover', d.c);
      showTip(event, `<strong>${nameOf(d.c)}</strong><br>Typical ${cur.size} m² ${homeWord()}: <strong>${aed(d.e)}</strong> in ${periodLabel(cur.period)}` +
        `<br><span style="color:${theme.quiet}">${d.e <= cur.budget ? 'Within your budget' : `${aed(d.e - cur.budget)} above your budget`}</span>`);
    })
      .on('mouseleave', () => { if (cur && cur.hovered) ev.emit('hover', null); hideTip(); })
      .on('click', (event, d) => ev.emit('select', cur.selected === d.c ? null : d.c));
  }

  // Budget line, handle, the two dots (then, now) and the arrow to the budget that reaches as many now
  function placeBudget(b, animate, raw) {
    if (!cur || !C) return;
    const v = raw ?? b, x = cx(v), xs = barX(v);
    const t = animate && !reduceMotion ? d3.transition().duration(450).ease(d3.easeCubicOut) : null;
    const go = sel => t ? sel.interrupt().transition(t) : sel.interrupt();
    go(budgetLine).attr('x1', x).attr('x2', x);
    go(sFill).attr('width', Math.max(0, xs - barX.range()[0]));
    go(knob).attr('transform', `translate(${xs},${trackY})`);
    const label = aed(b);
    sVal.text(label);
    knob.attr('aria-valuenow', b).attr('aria-valuetext', label);
    colourNotches(b);

    const same = cur.thenPeriod === cur.period;
    const at = d => d ? d3.bisectRight(d.edges, b) : NaN;
    const now = periodsInfo.find(d => d.p === cur.period), then = same ? null : periodsInfo.find(d => d.p === cur.thenPeriod);
    const dots = [now && { k: 'now', v: at(now), p: cur.period }, then && { k: 'then', v: at(then), p: cur.thenPeriod }].filter(Boolean);
    const leftSide = x > cm.l + 96;
    const ys = dots.map(d => Math.min(cy(d.v), plotB - 9));      // keep the labels clear of the budget axis
    if (ys.length === 2 && Math.abs(ys[0] - ys[1]) < 15) { const mid = (ys[0] + ys[1]) / 2, up = ys[1] <= ys[0] ? 1 : 0; ys[up] = mid - 8; ys[1 - up] = mid + 8; }
    gDots.selectAll('g').data(dots, d => d.k).join(enter => {
      const g = enter.append('g');
      g.append('circle').attr('r', 5).attr('stroke', '#ffffff').attr('stroke-width', 1.5);
      g.append('text').attr('dy', '0.35em').attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.5)
        .style('font', `700 ${theme.size.small}px ${theme.font}`);
      return g;
    }).each(function (d, i) {
      const g = d3.select(this);
      go(g.select('circle')).attr('cx', x).attr('cy', cy(d.v)).attr('fill', pcol(d.p));
      go(g.select('text')).attr('x', leftSide ? x - 10 : x + 10).attr('y', ys[i]);
      g.select('text').attr('text-anchor', leftSide ? 'end' : 'start').attr('fill', d.k === 'now' ? theme.depth.deep : '#5f6f80')
        .text(`${periodLabel(d.p)}: ${d.v}`);
    });

    // the arrow: how much more money reaches as many neighbourhoods now as your budget did then
    gEq.selectAll('*').remove();
    if (then && now) {
      const k = at(then);
      if (k >= 1 && k <= now.edges.length && at(now) !== k) {
        const eq = ceilBudget(now.edges[k - 1]), x2 = cx(eq), y2 = cy(k);
        if (Math.abs(x2 - x) > 24) {
          const more = eq > b;
          gEq.append('line').attr('x1', x + (more ? 7 : -7)).attr('x2', x2 + (more ? -4 : 4)).attr('y1', y2).attr('y2', y2)
            .attr('stroke', theme.ink).attr('stroke-width', 1.4).attr('marker-end', 'url(#vb-arrow)').attr('pointer-events', 'none');
          const lab = gEq.append('g').style('cursor', 'pointer').on('click', () => ev.emit('budget', eq));
          lab.append('title').text(`Set your budget to ${aed(eq)}`);
          const fitsRight = more && x + 8 + 150 < CW - cm.r;
          lab.append('text').attr('x', more ? (fitsRight ? x + 8 : x2) : x - 8).attr('y', y2 - 8)
            .attr('text-anchor', more ? (fitsRight ? 'start' : 'end') : 'end')
            .attr('fill', theme.ink).attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.5)
            .style('font', `700 ${theme.size.small}px ${theme.font}`)
            .text(more ? `${aed(eq - b)} more to open the same ${k}` : `${aed(b - eq)} less opens the same ${k}`);
        }
      }
    }
  }

  // The trace: one neighbourhood followed through the four periods. With nothing clicked it is the
  // middle neighbourhood of each period (the typical price); click a neighbourhood and it becomes that
  // one. Its dots sit on the period curves, joined in time order; the chips above show its prices.
  function drawTrace(s) {
    if (!s || !C || !periodsInfo.length) return;
    const c = s.selected && byComm.has(s.selected) && charted(S.get(s.selected)) ? s.selected : null;
    const pts = periodsInfo.map(d => {
      let e;
      if (c) { const st = d.Sp.get(c); if (!charted(st)) return { p: d.p, e: null, n: st ? st.n : 0 }; e = st.edge; }
      else e = d.edges[Math.ceil(d.edges.length / 2) - 1];
      return { p: d.p, e, k: C.set.includes(c) || !c ? d3.bisectRight(d.edges, e) : null };
    });
    const onChart = pts.filter(q => q.e != null && q.k != null && q.e >= BUDGET_MIN && q.e <= BUDGET_MAX);
    gLines.selectAll('.ln').attr('stroke-opacity', c ? 0.55 : 1);
    band.attr('fill-opacity', c ? 0.07 : 0.14);
    gEq.attr('opacity', c ? 0 : 1).attr('pointer-events', c ? 'none' : null);   // the trace has the floor
    gTrace.selectAll('*').remove();
    if (!c) { onChart.length = 0; }           // nothing clicked: no trace on the chart, the chips carry the typical price
    gTrace.append('path').attr('d', d3.line()(onChart.map(q => [cx(q.e), cy(q.k)]))).attr('fill', 'none')
      .attr('stroke', c ? theme.ink : theme.quiet).attr('stroke-width', c ? 2.4 : 1.2).attr('stroke-dasharray', c ? null : '2 3')
      .attr('stroke-linejoin', 'round');
    onChart.forEach(q => gTrace.append('circle').attr('cx', cx(q.e)).attr('cy', cy(q.k)).attr('r', c ? 5.5 : 3.5)
      .attr('fill', pcol(q.p)).attr('stroke', c ? theme.ink : '#ffffff').attr('stroke-width', c ? 1.8 : 1.2));
    if (c && onChart.length) {
      const lastP = onChart[onChart.length - 1], lx2 = cx(lastP.e), right = lx2 + 10 + textW(shortName(nameOf(c)), 11.5, 700) < CW - 2;
      gTrace.append('text').attr('x', right ? lx2 + 10 : lx2 - 10).attr('y', cy(lastP.k) + 4).attr('text-anchor', right ? 'start' : 'end')
        .attr('fill', theme.ink).attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.5)
        .style('font', `700 11.5px ${theme.font}`).text(shortName(nameOf(c)));
    }

    // chips: the four periods in time order; the price is the clicked neighbourhood's, or the typical one
    const who = c ? ` in <span style="background:#fff4e8;color:${theme.ink};padding:1px 6px;border-radius:5px">${shortName(nameOf(c))}</span>` : '';
    chipHead.html(`<span style="letter-spacing:.08em;text-transform:uppercase">Period on the map</span>` +
      `<span style="float:right;font-weight:400">typical ${s.size} m² price, AED${who}</span>`);
    chips.selectAll('button').data(pts, d => d.p).join(enter => {
      const bEl = enter.append('button').attr('type', 'button').style('font-family', theme.font).style('text-align', 'left')
        .style('padding', '6px 8px 7px').style('border', '0').style('border-radius', '8px').style('cursor', 'pointer')
        .style('line-height', '1.25').style('transition', 'background-color .2s, color .2s, box-shadow .2s');
      bEl.append('div').attr('class', 'pl').style('font-size', '11px').style('font-weight', 600)
        .style('display', 'flex').style('align-items', 'center').style('gap', '5px');
      bEl.append('div').attr('class', 'pr').style('font-weight', 700).style('font-variant-numeric', 'tabular-nums').style('margin-top', '2px');
      return bEl;
    })
      .attr('aria-pressed', d => String(d.p === s.period))
      .attr('title', d => d.p === s.period ? 'This period is on the map' : `Show ${periodLabel(d.p)} on the map`)
      .style('background-color', d => d.p === s.period ? theme.ink : '#eef1f5')
      .style('color', d => d.p === s.period ? '#ffffff' : theme.ink)
      .style('box-shadow', d => d.p === s.period ? '0 1px 4px rgba(15,30,50,0.18)' : 'none')
      .on('click', (event, d) => { endPreview(); if (d.p !== cur.period) ev.emit('period', d.p); })
      .on('mouseenter', (event, d) => { const pi = periodsInfo.find(x => x.p === d.p); if (pi && d.p !== cur.period) preview(pi.Sp); })
      .on('mouseleave', endPreview)
      .each(function (d) {
        const el = d3.select(this), on = d.p === s.period;
        el.select('.pl').html(`<span style="display:inline-block;width:12px;height:4px;border-radius:2px;background:${pcol(d.p)};` +
          `${on ? 'box-shadow:0 0 0 1px rgba(255,255,255,.7)' : ''}"></span>${periodLabel(d.p)}`);
        el.select('.pr').style('font-size', d.e == null ? '11.5px' : '15px').style('opacity', d.e == null ? 0.65 : 1)
          .text(d.e == null ? 'few sales' : short$(d.e));
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
    forcedLabels(s);
    if (C) colourNotches(s.budget);
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
        // water carries its depth (how far past the coastline), so deeper neighbourhoods look deeper
        if (isWater(st)) groups.water.push({ f, level: 0.35 + 0.65 * (outOf(st) - 0.5) / 0.5 });
        else if (isLand(st)) groups.land.push({ f }); else if (st) groups.fog.push({ f });
      });
      surface.setMasks(groups, (ctx, f) => { drawCtxPath.context(ctx); drawCtxPath(f); drawCtxPath.context(null); },
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
  function apply(s) {
    cur = s;
    const dataChanged = !prev || DATA_KEYS.some(k => prev[k] !== s[k]);
    if (dataChanged) drawData(s, !!prev && !dragging);
    const pinsChanged = !prev || (prev.pinned || []).join() !== (s.pinned || []).join();
    if (dataChanged || prev.selected !== s.selected || prev.hovered !== s.hovered || pinsChanged ||
        prev.highlight !== s.highlight) drawMarks(s);
    if (!dataChanged && prev.selected !== s.selected) drawTrace(s);     // the chart changes on click, never on hover
    prev = s;
  }

  // ---------- your guess first ----------
  // Before the map, the reader draws what happened to one fixed budget: AED 1 million, a typical
  // 80 m² apartment, the same 30 neighbourhoods. The 2015–17 point is given; they draw the rest.
  // Most people draw a steady fall. The data says the opposite first: homes got cheaper until 2020,
  // so the budget reached MORE neighbourhoods (16 → 19), and then 16 went under in one period (→ 3).
  // On "Show me" the real line draws period by period and the map's tide follows it, so the eye moves
  // from the guess to the map. Until the reader leaves the scene the view shows the scene, not the
  // shared state; leaving via "Explore" sends the scene's budget so the map continues from what they
  // just watched. "Skip" leaves without changing anything. Nothing about the map's numbers is hidden
  // for long: one click skips.
  const G = { budget: 1e6, size: 80, mode: 'all', homeType: 'apartment', money: 'nominal', dropExtremes: false };
  const P = PERIOD_KEYS, L = P.length - 1;
  const Gset = reach({ ...G, period: P[L], thenPeriod: P[0] }).set, gn = Gset.length;
  const GS = P.map(p => statsFor(p, G));
  const truth = GS.map(Sp => Gset.filter(c => isLand(Sp.get(c))).length);
  const typicalG = GS.map(Sp => d3.median(Gset, c => Sp.get(c).edge));
  const underLast = Gset.filter(c => isLand(GS[L - 1].get(c)) && isWater(GS[L].get(c))).length;
  let external = null, override = null;
  let phase = guessFirst && gn && L >= 2 ? 'draw' : 'off';
  const effective = s => override ? { ...s, ...override, selected: null, hovered: null, pinned: [], highlight: null } : s;

  panel.style('position', 'relative');
  const gx = panel.append('div').attr('role', 'region').attr('aria-label', 'Draw your guess before the map')
    .style('position', 'absolute').style('inset', '0').style('z-index', 2).style('background', '#ffffff')
    .style('display', 'none').style('flex-direction', 'column').style('gap', '8px').style('transition', 'opacity .45s');
  const under = panel.selectAll(':scope > div').filter(function () { return this !== gx.node(); });
  if (phase === 'draw') {
    gx.style('display', 'flex');
    mapCol.style('transition', 'opacity .8s').style('opacity', 0.45).style('pointer-events', 'none');
    under.style('visibility', 'hidden');     // shadows reach past the panel's edge
    override = { ...G, period: P[0], thenPeriod: P[0] };
  }
  gx.append('div').style('font', `700 11px ${theme.font}`).style('letter-spacing', '0.08em').style('text-transform', 'uppercase')
    .style('color', theme.accent).text('Before the map: your guess');
  gx.append('div').style('font', `800 23px/1.15 ${theme.font}`).style('margin-top', '-2px')
    .text(`What could AED ${d3.format('~g')(G.budget / 1e6)} million buy?`);
  const yearsAhead = R.PERIODS[P[L]][1] - R.PERIODS[P[1]][0] + 1;
  gx.append('div').style('font-size', `${theme.size.label + 0.5}px`).style('line-height', '1.45').style('color', theme.ink)
    .html(`A typical ${G.size} m² apartment in <strong>${truth[0]}</strong> of ${gn} neighbourhoods in ${periodLabel(P[0])}. ` +
      `<strong>Draw the next ${yearsAhead} years.</strong>`);

  const usedTop = d3.sum(gx.selectAll(':scope > div').nodes(), n => n.getBoundingClientRect().height) + 2 * 8 || 110;
  const GW = panelW, GH = Math.max(210, Math.min(400, panelH - usedTop - 80 - 44 - 8 * 4));
  const gm = { l: 28, r: 46, t: 24, b: 30 };
  const gsvg = gx.append('svg').attr('width', GW).attr('height', GH).style('display', 'block')
    .style('touch-action', 'none').style('overflow', 'visible').style('user-select', 'none');
  const gX = d3.scalePoint().domain(P).range([gm.l + 16, GW - gm.r]);
  const gY = d3.scaleLinear().domain([0, gn]).range([GH - gm.b, gm.t]);
  const xy = (i, v) => [gX(P[i]), gY(v)];
  const gyt = gY.ticks(3).filter(Number.isInteger);
  gsvg.append('g').selectAll('line').data(gyt).join('line').attr('x1', gm.l).attr('x2', GW - gm.r + 14)
    .attr('y1', v => gY(v)).attr('y2', v => gY(v)).attr('stroke', theme.grid);
  gsvg.append('g').selectAll('text').data(gyt).join('text').attr('x', gm.l - 6).attr('y', v => gY(v)).attr('dy', '0.35em')
    .attr('text-anchor', 'end').attr('fill', theme.quiet).style('font-size', '10.5px').text(v => v);
  gsvg.append('text').attr('x', 0).attr('y', gm.t - 12).attr('fill', theme.quiet).style('font-size', '10.5px')
    .text(`neighbourhoods within reach (of ${gn})`);
  gsvg.append('g').selectAll('text').data(P).join('text').attr('x', p => gX(p)).attr('y', GH - gm.b + 19)
    .attr('text-anchor', 'middle').attr('fill', theme.quiet).style('font-size', '11px').text(periodLabel);
  // where to draw: a soft panel over the three unknown periods, with guides at each period
  const zx0 = gX(P[0]) + gX.step() * 0.45, zx1 = GW - gm.r + 20;
  const zone = gsvg.append('g').attr('pointer-events', 'none');
  zone.append('rect').attr('x', zx0).attr('y', gm.t - 6).attr('width', zx1 - zx0).attr('height', GH - gm.b - gm.t + 12)
    .attr('rx', 8).attr('fill', '#f3f6fa').attr('stroke', '#cfd8e3').attr('stroke-dasharray', '4 4');
  zone.selectAll('line').data(P.slice(1)).join('line').attr('x1', p => gX(p)).attr('x2', p => gX(p))
    .attr('y1', gm.t).attr('y2', GH - gm.b).attr('stroke', '#d6dee8').attr('stroke-dasharray', '2 3');
  const zoneHint = zone.append('text').attr('x', (zx0 + zx1) / 2).attr('y', gY(gn * 0.82)).attr('text-anchor', 'middle')
    .attr('fill', theme.quiet).style('font', `600 12.5px ${theme.font}`).text('Drag here to draw your line');
  const gTruth = gsvg.append('g').attr('pointer-events', 'none');
  const guessPath = gsvg.append('path').attr('fill', 'none').attr('stroke', theme.accent).attr('stroke-width', 2.6)
    .attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round').attr('pointer-events', 'none');
  const gGuessDots = gsvg.append('g').attr('pointer-events', 'none');
  const liveLabel = gsvg.append('text').attr('fill', theme.accent).attr('paint-order', 'stroke').attr('stroke', '#ffffff')
    .attr('stroke-width', 3.5).style('font', `700 12px ${theme.font}`).attr('pointer-events', 'none');
  // the given point, with a slow pulse to say "start here"
  const [sx, sy] = xy(0, truth[0]);
  const pulse = gsvg.append('circle').attr('cx', sx).attr('cy', sy).attr('r', 6).attr('fill', 'none')
    .attr('stroke', theme.depth.deep).attr('stroke-width', 1.5).attr('pointer-events', 'none');
  gsvg.append('circle').attr('cx', sx).attr('cy', sy).attr('r', 5.5).attr('fill', theme.depth.deep)
    .attr('stroke', '#ffffff').attr('stroke-width', 1.5).attr('pointer-events', 'none');
  gsvg.append('text').attr('x', sx).attr('y', sy - 12).attr('text-anchor', 'middle').attr('fill', theme.depth.deep)
    .attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.5)
    .style('font', `700 12px ${theme.font}`).attr('pointer-events', 'none').text(truth[0]);
  function beat() {
    if (phase !== 'draw' || reduceMotion) { pulse.attr('opacity', 0); return; }
    pulse.attr('r', 6).attr('opacity', 0.7).transition().duration(1400).ease(d3.easeCubicOut)
      .attr('r', 17).attr('opacity', 0).on('end', beat);
  }
  if (phase === 'draw') beat();

  const result = gx.append('div').style('min-height', '64px').style('opacity', 0).style('transition', 'opacity .5s')
    .style('font-size', `${theme.size.label + 0.5}px`).style('line-height', '1.45').attr('aria-live', 'polite');
  const row = gx.append('div').style('display', 'flex').style('align-items', 'center').style('gap', '16px');
  const goBtn = row.append('button').attr('type', 'button').text('Show me').attr('disabled', true)
    .style('font', `700 ${theme.size.label}px ${theme.font}`).style('padding', '9px 18px').style('border', '0')
    .style('border-radius', '999px').style('transition', 'background-color .2s, color .2s');
  const skipBtn = row.append('button').attr('type', 'button').text('Skip to the map')
    .style('font', `600 ${theme.size.small}px ${theme.font}`).style('padding', '4px 0').style('border', '0')
    .style('background', 'none').style('color', theme.quiet).style('text-decoration', 'underline').style('cursor', 'pointer');
  const styleGo = on => goBtn.attr('disabled', on ? null : true).style('cursor', on ? 'pointer' : 'default')
    .style('background-color', on ? theme.depth.deep : '#e7ebf0').style('color', on ? '#ffffff' : '#97a3b1');
  styleGo(false);

  // Drawing: the pointer sets the value of the nearest unknown period (whole neighbourhoods, 0 to 30).
  // Jumping ahead fills the periods in between with a straight line, so any stroke gives a full line.
  const guessV = P.map((p, i) => i === 0 ? truth[0] : null);
  let lastI = null;
  const drawn = () => { let k = 0; while (k < L && guessV[k + 1] != null) k++; return k; };
  function renderGuess(active) {
    const k = drawn();
    const pts = d3.range(k + 1).map(i => xy(i, guessV[i]));
    guessPath.attr('d', k ? d3.line()(pts) : null);
    gGuessDots.selectAll('circle').data(pts.slice(1)).join('circle').attr('r', 4).attr('fill', theme.accent)
      .attr('stroke', '#ffffff').attr('stroke-width', 1.5).attr('cx', d => d[0]).attr('cy', d => d[1]);
    if (active != null) {
      const [ax, ay] = xy(active, guessV[active]);
      liveLabel.attr('x', ax + 9).attr('y', ay - 9).text(guessV[active]);
    }
    styleGo(k === L);
  }
  function drawAt([x, y]) {
    const i = Math.max(1, Math.min(L, Math.round((x - gX(P[0])) / gX.step())));
    const v = Math.max(0, Math.min(gn, Math.round(gY.invert(y))));
    guessV[i] = v;
    const fill = (a, b) => { for (let j = a + 1; j < b; j++) guessV[j] = Math.round(guessV[a] + (guessV[b] - guessV[a]) * (j - a) / (b - a)); };
    if (lastI != null && Math.abs(i - lastI) > 1) lastI < i ? fill(lastI, i) : fill(i, lastI);
    let j0 = i - 1; while (j0 > 0 && guessV[j0] == null) j0--;
    if (j0 < i - 1) fill(j0, i);
    lastI = i;
    zoneHint.transition().duration(200).attr('opacity', 0);
    renderGuess(i);
  }
  const gDrag = d3.drag().container(gsvg.node()).clickDistance(0)
    .on('start', e => { if (phase === 'draw') { lastI = null; drawAt([e.x, e.y]); } })
    .on('drag', e => { if (phase === 'draw') drawAt([e.x, e.y]); })
    .on('end', () => { lastI = null; liveLabel.text(''); });
  const gHit = gsvg.append('rect').attr('x', zx0 - 10).attr('y', 0).attr('width', GW - zx0 + 10).attr('height', GH)
    .attr('fill', 'transparent').style('cursor', 'crosshair').call(gDrag);

  // Reveal: the real line draws period by period; with each step the map's tide moves to that period,
  // and the orange outlines show the neighbourhoods that went under in that step.
  function reveal() {
    if (phase !== 'draw' || drawn() !== L) return;
    phase = 'reveal';
    gHit.style('cursor', null).on('.drag', null);
    zone.transition().duration(400).attr('opacity', 0.35);
    liveLabel.text('');
    pulse.interrupt().attr('opacity', 0);
    styleGo(false); goBtn.text('…');
    skipBtn.style('visibility', 'hidden');
    mapCol.style('opacity', 1);
    const SEG = reduceMotion ? 0 : 1300, DRAW = SEG * 0.8;
    const labelAt = (i, dx = 0) => {      // the real number, on the side away from the guess
      const [x, y] = xy(i, truth[i]), below = guessV[i] < truth[i] ? false : guessV[i] > truth[i];
      gTruth.append('text').attr('x', x + dx).attr('y', below ? y + 18 : y - 11).attr('text-anchor', 'middle')
        .attr('fill', theme.depth.deep).attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.5)
        .style('font', `800 13px ${theme.font}`).attr('opacity', 0).text(truth[i])
        .transition().duration(SEG ? 250 : 0).attr('opacity', 1);
    };
    for (let k = 1; k <= L; k++) setTimeout(() => {
      override = { ...override, period: P[k], thenPeriod: P[k - 1] };
      if (external) apply(effective(external));
      const [x0, y0] = xy(k - 1, truth[k - 1]), [x1, y1] = xy(k, truth[k]);
      gTruth.append('line').attr('x1', x0).attr('y1', y0).attr('x2', x0).attr('y2', y0)
        .attr('stroke', theme.depth.deep).attr('stroke-width', 3.2).attr('stroke-linecap', 'round')
        .transition().duration(DRAW).ease(d3.easeCubicInOut).attr('x2', x1).attr('y2', y1)
        .on('end', () => {
          gTruth.append('circle').attr('cx', x1).attr('cy', y1).attr('r', 5.5).attr('fill', theme.depth.deep)
            .attr('stroke', '#ffffff').attr('stroke-width', 1.5);
          labelAt(k);
        });
    }, (k - 1) * SEG);
    setTimeout(showResult, L * SEG + (SEG ? 250 : 0));
  }
  function showResult() {
    phase = 'done';
    const g = guessV[L], r = truth[L];
    const [ex, ey] = xy(L, g);
    gsvg.append('text').attr('x', ex + 9).attr('y', ey).attr('dy', '0.35em').attr('fill', theme.accent)
      .style('font', `700 11px ${theme.font}`).attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3)
      .text('you');
    const score = g === r ? `Spot on: ${r}.` : `You drew ${g}. It's ${r}.`;
    // the "why", only as far as the data goes: did reach rise first, because homes got cheaper?
    const roseFirst = truth[1] > truth[0], cheaper = typicalG[1] < typicalG[0];
    const why = roseFirst
      ? `It got easier first${cheaper ? `: homes got cheaper until ${R.PERIODS[P[1]][1]}` : ''}. Then ${underLast} went under at once.`
      : `${underLast} went under in ${periodLabel(P[L])} alone.`;
    result.html(`<div style="font-weight:800;font-size:17px;margin-bottom:2px">${score}</div><div>${why}</div>`).style('opacity', 1);
    goBtn.text('Explore the map →'); styleGo(true);
  }
  function leave(continueScene) {
    if (phase === 'off') return;
    const fromScene = phase !== 'draw';
    phase = 'off'; override = null;
    gx.style('opacity', 0).style('pointer-events', 'none');
    setTimeout(() => gx.style('display', 'none'), 460);
    mapCol.style('opacity', 1).style('pointer-events', null);
    under.style('visibility', null);
    if (continueScene && fromScene && external && external.budget !== G.budget) ev.emit('budget', G.budget);
    if (external) apply(effective(external));
  }
  goBtn.on('click', () => phase === 'draw' ? reveal() : phase === 'done' ? leave(true) : null);
  skipBtn.on('click', () => leave(false));

  return {
    update(s) {
      external = s;
      apply(effective(s));
    },
    on: ev.on,
    // for recording demos at a steady frame rate: replace the clock (null restores real time)
    _setClock: fn => { clock = fn; },
    // for tests and the referee script: the numbers this view shows
    _debug: s => ({ comparable: reach(s), guess: { phase, truth, drawn: guessV.slice(), underLast, typical: typicalG } })
  };
}
