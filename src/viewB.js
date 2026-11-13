// src/viewB.js — View B, "The Sea" (Member 2)
// Sand is where your budget reaches; the deeper the water, the fewer homes you could buy.
// Contract: createViewB(container, data, theme, { width, height }) -> { update(state), on(event, handler) }
// Emits: select, pin, hover, mode, thenPeriod, period, budget.
//
// Design rules for this view:
//   * What matters is on screen without hovering, in as few words as possible: one headline,
//     the then → now numbers inside the mode buttons, the communities that went under (outlined,
//     counted in the key), and the reach chart with its two numbers and one arrow.
//     Hover and click only add detail (overview first, details on demand).
//   * Every colour is exact: one fill per community from its own sales. The coastline runs along
//     real community borders, never interpolated. The moving light on the water never changes colour.
//   * Only things that respond look like they respond: communities with data, fog (hover only),
//     earlier coastlines, the curve and the budget line. Areas with no sales do nothing.
import { emitter } from './emitter.js';
import * as R from './rules.js';
import { createSeaLight } from './seashader.js';

export const BUILD = 'View B · budget bar + reach chart · 2026-11-13';

const PERIOD_KEYS = Object.keys(R.PERIODS);
const periodLabel = p => p.replace('-', '–');
const fmt = d3.format(',.0f');
const pctFmt = d3.format('.0%');
const aed = v => v >= 1e6 ? `AED ${d3.format('.2~f')(v / 1e6)}M` : `AED ${d3.format(',.0f')(v / 1e3)}k`;
const MODE_LABEL = { all: 'All homes', ready: 'Ready', offplan: 'Off-plan' };
const BUDGET_MIN = 400000, BUDGET_MAX = 4000000;
const DOWNTOWN = '345';                       // Burj Khalifa community: the reference for "distance from the centre"
const LANDMARKS = ['345', '392', '381', '681', '521'];   // orientation labels only
const roundBudget = b => b < 1e6 ? Math.round(b / 1e4) * 1e4 : Math.round(b / 5e4) * 5e4;
const ceilBudget = b => Math.ceil(b / 1e4) * 1e4;

// Names. Official community names are all capitals in the data: title-case them. Project names keep
// real acronyms (DMCC, JLT) but not words that only happen to be short (AL, THE, BAY).
const titleCase = s => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const NOT_ACRONYM = /^(AL|EL|THE|AND|OF|BAY|CITY|PARK|BIN|BU|UMM|ABU|RAS|NAD|NADD|HILL|HILLS|ONE|TWO|NEW|OLD|WEST|EAST)$/;
const nice = s => s.split(/\s+/).map(w => /^[A-Z]{2,4}$/.test(w) && !NOT_ACRONYM.test(w) ? w
  : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
const SHORT = { 'Jumeirah Village Circle': 'JVC', 'Jumeirah Village Triangle': 'JVT' };   // map labels only

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
  const pop = c => +(byComm.get(c)?.properties['Population 2019'] || 0);
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
  function statsFor(period, s) {           // Map comm -> { n, p50, shareWithin, edge }
    const key = [period, s.mode, s.homeType, s.money, s.dropExtremes, s.budget, s.size].join('|');
    if (statsCache.has(key)) return statsCache.get(key);
    if (statsCache.size > 400) statsCache.clear();
    const thr = s.budget / s.size;
    const out = new Map();
    for (const [comm, a] of pricesBy(period, s)) {
      out.set(comm, {
        n: a.length,
        p50: d3.quantileSorted(a, 0.5),
        shareWithin: d3.bisectRight(a, thr) / a.length,
        // the smallest budget at which half the homes here are within reach: where this community becomes land
        edge: a[Math.ceil(a.length * 0.5) - 1] * s.size
      });
    }
    statsCache.set(key, out);
    return out;
  }
  const charted = st => !!st && st.n >= R.MIN_SALES;
  const isLand = st => charted(st) && st.shareWithin >= 0.5;
  const isWater = st => charted(st) && st.shareWithin < 0.5;

  function comparable(S1, S2) {            // like-for-like shares between two periods
    const both = [...S2.keys()].filter(c => charted(S2.get(c)) && charted(S1.get(c)));
    const land = S => both.filter(c => isLand(S.get(c)));
    const popAll = d3.sum(both, pop);
    return {
      set: both,
      n: both.length,
      land1: both.length ? land(S1).length / both.length : NaN,
      land2: both.length ? land(S2).length / both.length : NaN,
      res1: popAll ? d3.sum(land(S1), pop) / popAll : NaN,
      res2: popAll ? d3.sum(land(S2), pop) / popAll : NaN
    };
  }
  const chartedShare = S => {
    const c = [...S.values()].filter(charted);
    return c.length ? c.filter(isLand).length / c.length : NaN;
  };

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
  const geoCentroid = new Map(features.map(f => [commOfF(f), d3.geoCentroid(f)]));
  const kmFromCentre = c => geoCentroid.has(DOWNTOWN) && geoCentroid.has(c)
    ? d3.geoDistance(geoCentroid.get(DOWNTOWN), geoCentroid.get(c)) * 6371 : NaN;
  const stations = data.metro.features.map(f => ({ coords: f.geometry.coordinates }));

  // ---------- encoding ----------
  // Depth = share of homes OUT of reach. Sand darkens from 0% to 50%; at 50% the coastline is
  // crossed and water deepens to 100%. Lightness carries the order; hue only says sand or sea.
  const noSales = '#f4f5f7';   // neutral and quiet: no sales must not read as affordable, or invite a hover
  const sandRamp = d3.interpolateLab(theme.depth.dry, theme.depth.wet);
  const waterRamp = d3.interpolateLab(theme.depth.shallow, theme.depth.deep);
  const outOf = st => 1 - st.shareWithin;
  const depthColor = out => out < 0.5 ? sandRamp(out / 0.5) : waterRamp((out - 0.5) / 0.5);
  const lineGrey = '#c3cad3';

  // ---------- layout ----------
  const gap = 10, toolbarH = 38, headH = 26, keyH = 30, chartH = 228;
  const mapH = Math.max(300, height - toolbarH - headH - keyH - chartH - gap * 4);

  // Which homes: a segmented control; each option carries its own then → now numbers, so the
  // comparison between ready and off-plan homes is visible without clicking anything
  const toolbar = root.append('div').style('height', `${toolbarH}px`).style('display', 'flex').style('align-items', 'center');
  const modeGroup = toolbar.append('div').attr('role', 'group').attr('aria-label', 'Which homes')
    .style('display', 'inline-flex').style('padding', '3px').style('gap', '2px')
    .style('background', '#eef1f5').style('border-radius', '10px');
  const modeButtons = modeGroup.selectAll('button').data(['all', 'ready', 'offplan']).join('button')
    .attr('type', 'button').style('font', `600 ${theme.size.small}px ${theme.font}`).style('padding', '6px 12px')
    .style('border', '0').style('border-radius', '8px').style('cursor', 'pointer')
    .style('transition', 'background-color .2s, color .2s, box-shadow .2s');
  modeButtons.append('span').text(d => MODE_LABEL[d]);
  const modeNums = modeButtons.append('span').style('font-weight', 400).style('margin-left', '7px')
    .style('font-variant-numeric', 'tabular-nums');

  // One sentence: the finding
  const headline = root.append('div').style('min-height', `${headH}px`).style('margin-top', `${gap}px`)
    .style('font-size', `${theme.size.label + 2}px`).style('line-height', '1.35');

  // Key, one row
  const fogBg = `repeating-linear-gradient(45deg, ${theme.fog} 0 2px, #ffffff 2px 5px)`;
  const swatch = (bg, border = theme.grid, w = 12) => `<span style="display:inline-block;width:${w}px;height:12px;border-radius:2px;` +
    `border:1.5px solid ${border};background:${bg};vertical-align:-2px;margin-right:5px"></span>`;
  const key = root.append('div').style('display', 'flex').style('flex-wrap', 'wrap').style('align-items', 'center')
    .style('gap', '4px 18px').style('margin-top', `${gap}px`).style('min-height', `${keyH}px`)
    .style('font-size', `${theme.size.small}px`).style('color', theme.ink);
  const kw = 180, kh = 10;
  const keyItem = key.append('span').style('display', 'inline-flex').style('align-items', 'center').style('gap', '6px');
  keyItem.append('span').text('Homes within budget');
  const keySvg = keyItem.append('svg').attr('width', kw + 16).attr('height', 26).attr('aria-hidden', true);
  const kg = keySvg.append('defs').append('linearGradient').attr('id', 'vb-key');
  [...d3.range(0, 0.5, 0.05), 0.4999, 0.5, ...d3.range(0.55, 1.001, 0.05)]
    .forEach(t => kg.append('stop').attr('offset', t).attr('stop-color', depthColor(t)));
  keySvg.append('rect').attr('x', 8).attr('y', 2).attr('width', kw).attr('height', kh).attr('rx', 2)
    .attr('fill', 'url(#vb-key)');
  keySvg.append('line').attr('x1', 8 + kw / 2).attr('x2', 8 + kw / 2).attr('y1', 0).attr('y2', kh + 4)
    .attr('stroke', theme.coastline).attr('stroke-width', 2);
  [[0, 'all'], [0.5, 'half'], [1, 'none']].forEach(([o, t]) =>
    keySvg.append('text').attr('x', 8 + o * kw).attr('y', 24).attr('text-anchor', o === 0 ? 'start' : o === 1 ? 'end' : 'middle')
      .attr('fill', theme.quiet).style('font-size', '10px').text(t));
  const keyFlip = key.append('span');
  key.append('span').html(`${swatch(fogBg)}fog: under 20 sales`);
  key.append('span').html(`${swatch(noSales)}no sales`);

  // ---------- map ----------
  const svg = root.append('svg').attr('width', width).attr('height', mapH)
    .attr('viewBox', `0 0 ${width} ${mapH}`).attr('role', 'img')
    .attr('aria-label', 'Map of Dubai communities: sand where your budget reaches, water where it does not')
    .style('display', 'block').style('margin-top', `${gap}px`).style('border-radius', '8px');
  const projection = d3.geoMercator().fitExtent([[16, 16], [width - 16, mapH - 16]],
    { type: 'FeatureCollection', features: frameFeatures });
  const path = d3.geoPath(projection);

  const defs = svg.append('defs');
  const hatch = defs.append('pattern').attr('id', 'vb-fog').attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 6).attr('height', 6).attr('patternTransform', 'rotate(45)');
  hatch.append('rect').attr('width', 6).attr('height', 6).attr('fill', '#ffffff');
  hatch.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6)
    .attr('stroke', theme.fog).attr('stroke-width', 2.2);
  const waterClip = defs.append('clipPath').attr('id', 'vb-water');

  const seaRect = svg.append('rect').attr('width', width).attr('height', mapH).attr('fill', theme.realSea);
  svg.append('text').attr('x', 18).attr('y', mapH - 18).attr('fill', theme.quiet)
    .style('font-size', `${theme.size.small}px`).style('font-style', 'italic').attr('pointer-events', 'none')
    .text('Arabian Gulf (the real sea)');

  const gComm = svg.append('g');
  const gLight = svg.append('g').attr('clip-path', 'url(#vb-water)').attr('pointer-events', 'none');
  const gTide = svg.append('g');
  const ghostCoast = svg.append('path').attr('fill', 'none').attr('stroke', theme.coastline).attr('stroke-width', 2)
    .attr('opacity', 0).attr('pointer-events', 'none');
  const coastPath = svg.append('path').attr('fill', 'none').attr('stroke', theme.coastline)
    .attr('stroke-width', 2).attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round').attr('pointer-events', 'none');
  const previewPath = svg.append('path').attr('fill', 'none').attr('stroke', theme.coastline)
    .attr('stroke-width', 2.2).attr('stroke-dasharray', '6 4').attr('opacity', 0).attr('pointer-events', 'none');
  const gFlip = svg.append('g').attr('pointer-events', 'none');
  const gStations = svg.append('g').attr('pointer-events', 'none');
  const gLabels = svg.append('g').attr('pointer-events', 'none');
  const gMarks = svg.append('g').attr('pointer-events', 'none');

  const commPaths = gComm.selectAll('path').data(features, commOfF).join('path')
    .attr('d', path).attr('fill', noSales).attr('stroke', '#ffffff').attr('stroke-width', 0.6);

  gStations.selectAll('circle').data(stations.filter(s => {
    const [x, y] = projection(s.coords); return x >= 0 && x <= width && y >= 0 && y <= mapH;
  })).join('circle')
    .attr('cx', d => projection(d.coords)[0]).attr('cy', d => projection(d.coords)[1])
    .attr('r', 1.6).attr('fill', theme.ink).attr('fill-opacity', 0.35);

  // A few well-known places, so the spread from the centre to the suburbs can be read
  gLabels.selectAll('text').data(LANDMARKS.filter(c => byComm.has(c))).join('text')
    .attr('x', c => path.centroid(byComm.get(c))[0]).attr('y', c => path.centroid(byComm.get(c))[1])
    .attr('text-anchor', 'middle').attr('dy', '0.35em').attr('fill', theme.ink).attr('fill-opacity', 0.8)
    .attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-opacity', 0.85).attr('stroke-width', 3)
    .style('font', `600 10.5px ${theme.font}`).text(c => SHORT[nameOf(c)] || nameOf(c));

  // Calm moving light on the water communities (never on sand, never a colour change)
  const light = reduceMotion ? null : createSeaLight(width, mapH);
  if (light) gLight.append('foreignObject').attr('width', width).attr('height', mapH).node().appendChild(light.canvas);

  // How far inland each community lies, to order the tide: a rising sea reaches coastal communities
  // first; a falling one drains inland first. The Gulf is north-west, so inland runs south-east.
  const inlandRaw = new Map(features.map(f => { const [x, y] = path.centroid(f); return [commOfF(f), (x + 0.6 * y)]; }));
  const inlandScale = d3.scaleLinear().domain(d3.extent([...inlandRaw.values()].filter(Number.isFinite))).clamp(true);
  const inland = c => inlandScale(inlandRaw.get(c) ?? 0);

  // ---------- reach chart + budget bar ----------
  // Top: how much of the city a budget reaches (x = budget, log; y = share of the comparable
  // communities within reach; every step is one community). "Then" and "now" are the two lines that
  // matter; the gap between them is shaded; one arrow shows the extra money that reaches as far now.
  // Bottom: the budget bar, on the same x scale. The budget line runs from the chart down into its handle.
  const chart = root.append('svg').attr('width', width).attr('height', chartH)
    .style('display', 'block').style('margin-top', `${gap}px`).style('overflow', 'visible');
  const cm = { l: 46, r: 22, t: 26 };
  const plotB = chartH - 78, barY = plotB + 30;
  const cx = d3.scaleLog().domain([BUDGET_MIN, BUDGET_MAX]).range([cm.l, width - cm.r]).clamp(true);
  const cy = d3.scaleLinear().domain([0, 1]).range([plotB, cm.t]);
  const cdefs = chart.append('defs');
  cdefs.append('filter').attr('id', 'vb-knob-shadow').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%')
    .append('feDropShadow').attr('dx', 0).attr('dy', 1.5).attr('stdDeviation', 2).attr('flood-color', '#0b2540').attr('flood-opacity', 0.28);
  cdefs.append('marker').attr('id', 'vb-arrow').attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
    .attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto-start-reverse')
    .append('path').attr('d', 'M0,1L9,5L0,9z').attr('fill', theme.depth.deep);
  const thenColor = '#8a95a3';

  const chartTitle = chart.append('text').attr('x', 0).attr('y', 11).attr('fill', theme.ink)
    .style('font', `600 ${theme.size.small}px ${theme.font}`);
  const chartLegend = chart.append('g');
  const gGrid = chart.append('g').attr('pointer-events', 'none');
  [0, 0.5, 1].forEach(v => {
    gGrid.append('line').attr('x1', cm.l).attr('x2', width - cm.r).attr('y1', cy(v)).attr('y2', cy(v))
      .attr('stroke', theme.grid).attr('stroke-dasharray', v === 0.5 ? '3 3' : null);
    gGrid.append('text').attr('x', cm.l - 8).attr('y', cy(v)).attr('dy', '0.35em').attr('text-anchor', 'end')
      .attr('fill', theme.quiet).style('font-size', '10.5px').text(pctFmt(v));
  });
  const plotBg = chart.append('rect').attr('x', cm.l).attr('y', cm.t).attr('width', width - cm.l - cm.r)
    .attr('height', plotB - cm.t).attr('fill', 'transparent').style('cursor', 'pointer');
  const band = chart.append('path').attr('fill', theme.depth.shallow).attr('fill-opacity', 0.16).attr('pointer-events', 'none');
  const gLines = chart.append('g');
  const budgetLine = chart.append('line').attr('y1', cm.t - 2).attr('y2', barY)
    .attr('stroke', theme.ink).attr('stroke-opacity', 0.55).attr('stroke-width', 1).attr('pointer-events', 'none');
  const gEq = chart.append('g');
  const gDots = chart.append('g').attr('pointer-events', 'none');
  const gPick = chart.append('g').attr('pointer-events', 'none');   // the selected / hovered community on the lines

  // Budget bar: a thin track, the part your budget covers filled, a round handle with a soft shadow
  const tickVals = [400e3, 600e3, 800e3, 1e6, 1.5e6, 2e6, 3e6, 4e6];
  const barHit = chart.append('rect').attr('x', cm.l - 10).attr('y', barY - 16).attr('width', width - cm.l - cm.r + 20)
    .attr('height', 32).attr('fill', 'transparent').style('cursor', 'pointer');
  chart.append('rect').attr('x', cm.l).attr('y', barY - 3).attr('width', width - cm.l - cm.r).attr('height', 6).attr('rx', 3)
    .attr('fill', '#e3e8ee').attr('pointer-events', 'none');
  const barFill = chart.append('rect').attr('x', cm.l).attr('y', barY - 3).attr('height', 6).attr('rx', 3)
    .attr('fill', theme.depth.deep).attr('pointer-events', 'none');
  chart.append('g').attr('pointer-events', 'none').selectAll('circle').data(tickVals).join('circle')
    .attr('cx', v => cx(v)).attr('cy', barY).attr('r', 1.4).attr('fill', '#ffffff').attr('fill-opacity', 0.9);
  const tickLabels = chart.append('g').attr('pointer-events', 'none').selectAll('text').data(tickVals).join('text')
    .attr('x', v => cx(v)).attr('y', barY + 25).attr('text-anchor', 'middle').attr('fill', theme.quiet)
    .style('font-size', '10.5px').text(v => aed(v).replace('AED ', ''));
  chart.append('text').attr('x', cm.l - 8).attr('y', barY).attr('dy', '0.35em').attr('text-anchor', 'end')
    .attr('fill', theme.ink).style('font', `600 10.5px ${theme.font}`).text('Budget');
  const knob = chart.append('g').attr('tabindex', 0).attr('role', 'slider')
    .attr('aria-label', 'Your budget. Arrow keys change it.')
    .attr('aria-valuemin', BUDGET_MIN).attr('aria-valuemax', BUDGET_MAX).style('cursor', 'grab').style('outline', 'none');
  const knobHalo = knob.append('circle').attr('r', 15).attr('fill', theme.depth.deep).attr('fill-opacity', 0);
  const knobDot = knob.append('circle').attr('r', 9).attr('fill', '#ffffff').attr('stroke', theme.depth.deep)
    .attr('stroke-width', 2.5).attr('filter', 'url(#vb-knob-shadow)');
  const bubble = knob.append('g').attr('transform', 'translate(0,25)');
  const bubbleRect = bubble.append('rect').attr('y', -11).attr('height', 22).attr('rx', 11).attr('fill', theme.ink);
  const bubbleText = bubble.append('text').attr('dy', '0.35em').attr('text-anchor', 'middle').attr('fill', '#ffffff')
    .style('font', `600 11px ${theme.font}`).style('font-variant-numeric', 'tabular-nums');
  knob.on('mouseenter', () => knobHalo.transition().duration(150).attr('fill-opacity', 0.12))
    .on('mouseleave', () => { if (!dragging) knobHalo.transition().duration(200).attr('fill-opacity', 0); })
    .on('focus', () => knobHalo.attr('fill-opacity', 0.18)).on('blur', () => knobHalo.attr('fill-opacity', 0));
  const step = d3.line().curve(d3.curveStepAfter).x(d => cx(d[0])).y(d => cy(d[1]));
  const stepArea = d3.area().curve(d3.curveStepAfter).x(d => cx(d[0])).y0(d => cy(d[1])).y1(d => cy(d[2]));

  // ---------- tooltip ----------
  const tip = root.append('div').style('position', 'absolute').style('pointer-events', 'none')
    .style('background', '#ffffff').style('border', `1px solid ${theme.grid}`).style('border-radius', '8px')
    .style('padding', '7px 10px').style('font-size', `${theme.size.small}px`).style('line-height', '1.45')
    .style('box-shadow', '0 2px 8px rgba(0,0,0,0.08)').style('max-width', '260px').style('opacity', 0).style('z-index', 3);
  function showTip(event, html) {
    const [x, y] = d3.pointer(event, container);
    tip.html(html).style('opacity', 1).style('left', `${Math.min(x + 14, width - 270)}px`).style('top', `${y + 14}px`);
  }
  const hideTip = () => tip.style('opacity', 0);

  // ---------- state ----------
  let prev = null, cur = null, S = new Map(), Sthen = new Map(), C = null, dragging = false;
  let readoutValues = null, flipped = [], periodsInfo = [];
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
    const half = `Half the homes here from <strong>${aed(st.edge)}</strong>` +
      (!same && charted(stThen) ? ` <span style="color:${theme.quiet}">(${aed(stThen.edge)} in ${periodLabel(cur.thenPeriod)})</span>` : '');
    return `${head}<strong>${pctFmt(st.shareWithin)}</strong> of homes within your budget · ${fmt(st.n)} sales<br>${half}<br>` +
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
    .on('click', (event, m) => { previewPath.attr('opacity', 0); coastPath.attr('opacity', 1); ev.emit('mode', m); })
    .on('mouseenter', (event, m) => { if (cur && m !== cur.mode) preview(statsFor(cur.period, { ...cur, mode: m })); })
    .on('mouseleave', endPreview);
  function preview(Sp) { previewPath.attr('d', path(coastFor(Sp))).attr('opacity', 1); coastPath.attr('opacity', 0.25); }
  function endPreview() { previewPath.attr('opacity', 0); coastPath.attr('opacity', 1); }

  // Budget: drag the handle (or anywhere on the bar or chart); click to jump; arrow keys on the handle.
  // While dragging, the handle and the line follow the pointer exactly; the budget sent is rounded.
  let pending = null;
  function sendBudget(b, x) {
    placeBudget(b, false, x);
    if (pending == null) requestAnimationFrame(() => { const v = pending; pending = null; if (v != null) ev.emit('budget', v); });
    pending = b;
  }
  const clampX = x => Math.max(cm.l, Math.min(width - cm.r, x));
  const atX = x => roundBudget(cx.invert(clampX(x)));
  const drag = d3.drag().container(chart.node()).clickDistance(3)
    .on('start', () => { knobHalo.interrupt().attr('fill-opacity', 0.16); knob.style('cursor', 'grabbing'); })
    .on('drag', e => { if (cur) { dragging = true; sendBudget(atX(e.x), clampX(e.x)); } })
    .on('end', () => {
      knob.style('cursor', 'grab'); knobHalo.transition().duration(250).attr('fill-opacity', 0);
      requestAnimationFrame(() => requestAnimationFrame(() => { dragging = false; if (cur) placeBudget(cur.budget, true); }));
    });
  const jump = event => { if (cur) ev.emit('budget', atX(d3.pointer(event, chart.node())[0])); };
  plotBg.call(drag).on('click', jump);
  barHit.call(drag).on('click', jump);
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
    C = comparable(Sthen, S);
    const same = s.thenPeriod === s.period;
    flipped = same ? [] : C.set.filter(c => isLand(Sthen.get(c)) && isWater(S.get(c)));
    const cameBack = same ? [] : C.set.filter(c => isWater(Sthen.get(c)) && isLand(S.get(c)));

    // Fills: exact colours. A deliberate change arrives as a tide; a drag follows the hand.
    const instant = !animate || reduceMotion;
    const dataF = [], otherF = [];
    commPaths.each(function (f) { (charted(S.get(commOfF(f))) ? dataF : otherF).push(this); });
    d3.selectAll(otherF).interrupt()
      .attr('fill', f => S.get(commOfF(f)) ? 'url(#vb-fog)' : noSales)
      .attr('pointer-events', f => S.get(commOfF(f)) ? 'all' : 'none')
      .style('cursor', f => S.get(commOfF(f)) ? 'help' : null);
    const dataSel = d3.selectAll(dataF).interrupt().attr('pointer-events', 'all').style('cursor', 'pointer');
    const delayOf = f => {
      const c = commOfF(f), now = outOf(S.get(c)), before = lastOut.get(c);
      if (before == null) return 0;
      return (now >= before ? inland(c) : 1 - inland(c)) * 450;
    };
    const fillOf = f => depthColor(outOf(S.get(commOfF(f))));
    if (instant) dataSel.attr('fill', fillOf);
    else dataSel.transition().delay(delayOf).duration(550).ease(d3.easeCubicInOut).attr('fill', fillOf);
    features.forEach(f => { const st = S.get(commOfF(f)); if (charted(st)) lastOut.set(commOfF(f), outOf(st)); });
    waterClip.selectAll('path').data(features.filter(f => isWater(S.get(commOfF(f)))), commOfF).join('path').attr('d', path);

    // Coastline: the old one fades while the new one comes in behind the tide
    const newCoast = path(coastFor(S)) || '';
    const oldCoast = coastPath.attr('d');
    coastPath.interrupt();
    if (instant || !oldCoast || oldCoast === newCoast) coastPath.attr('d', newCoast).attr('stroke-opacity', 1);
    else {
      ghostCoast.interrupt().attr('d', oldCoast).attr('opacity', 0.8).transition().duration(700).attr('opacity', 0);
      coastPath.attr('d', newCoast).attr('stroke-opacity', 0).transition().delay(350).duration(500).attr('stroke-opacity', 1);
    }

    // Communities that went under since "then": outlined, always (the finding, not a hover)
    gFlip.selectAll('path').data(flipped, c => c).join('path').attr('d', c => path(byComm.get(c)))
      .attr('fill', 'none').attr('stroke', theme.accent).attr('stroke-width', 1.6).attr('stroke-linejoin', 'round');
    keyFlip.html(same ? '' : `${swatch('transparent', theme.accent)}<strong>${flipped.length}</strong> went under since ${periodLabel(s.thenPeriod)}`);

    drawHeadline(s, same, cameBack, animate);

    clearTimeout(heavyTimer);
    if (dragging) heavyTimer = setTimeout(() => drawHeavy(s, same), 120);
    else drawHeavy(s, same);
  }

  function drawHeadline(s, same, cameBack, animate) {
    const target = same ? [chartedShare(S)] : [C.land1, C.land2];
    const from = readoutValues && readoutValues.length === target.length ? readoutValues : target;
    readoutValues = target;
    const b = `<strong>${aed(s.budget)}</strong> for ${s.size} m²`;
    const render = v => same
      ? `${b} reaches <strong>${pctFmt(v[0])}</strong> of communities with enough sales in ${periodLabel(s.period)}.`
      : `${b} reached <strong>${pctFmt(v[0])}</strong> of these ${C.n} communities in ${periodLabel(s.thenPeriod)} ` +
        `and <strong style="color:${theme.depth.deep}">${pctFmt(v[1])}</strong> in ${periodLabel(s.period)}.`;
    headline.interrupt();
    if (!animate || reduceMotion) headline.html(render(target));
    else { const i = d3.interpolate(from, target); headline.transition().duration(650).tween('n', () => t => headline.html(render(i(t)))); }

    // The same comparison for each kind of home, inside its button
    modeNums.text(m => {
      const c2 = m === s.mode ? C : comparable(statsFor(s.thenPeriod, { ...s, mode: m }), statsFor(s.period, { ...s, mode: m }));
      return same ? pctFmt(m === s.mode ? chartedShare(S) : c2.land2) : `${pctFmt(c2.land1)} → ${pctFmt(c2.land2)}`;
    });
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
    // One line per period over the same communities (those comparable between "then" and now)
    const set = C.set;
    periodsInfo = PERIOD_KEYS.map(p => {
      const Sp = p === s.period ? S : p === s.thenPeriod ? Sthen : statsFor(p, s);
      const inP = set.filter(c => charted(Sp.get(c)));
      const edges = inP.map(c => Sp.get(c).edge).sort(d3.ascending);
      const n = edges.length;
      const pts = [[BUDGET_MIN, d3.bisectRight(edges, BUDGET_MIN) / n]];
      edges.forEach((e, i) => { if (e > BUDGET_MIN && e < BUDGET_MAX) pts.push([e, (i + 1) / n]); });
      pts.push([BUDGET_MAX, d3.bisectRight(edges, BUDGET_MAX) / n]);
      const share = n ? inP.filter(c => isLand(Sp.get(c))).length / n : NaN;
      return { p, pts, edges, n, share, Sp };
    }).filter(d => d.n > 0);
    const role = p => p === s.period ? 'now' : (!same && p === s.thenPeriod) ? 'then' : 'other';
    const strokeOf = d => ({ now: theme.depth.deep, then: thenColor, other: '#d3d9e0' })[role(d.p)];
    const widthOf = d => ({ now: 2.6, then: 2, other: 1.1 })[role(d.p)];
    const order = { other: 0, then: 1, now: 2 };

    // The ground lost between then and now, shaded
    const nowI = periodsInfo.find(d => d.p === s.period), thenI = same ? null : periodsInfo.find(d => d.p === s.thenPeriod);
    if (nowI && thenI) {
      const at = (d, b) => d3.bisectRight(d.edges, b) / d.n;
      const xs = [...new Set([BUDGET_MIN, ...nowI.edges, ...thenI.edges, BUDGET_MAX])]
        .filter(b => b >= BUDGET_MIN && b <= BUDGET_MAX).sort(d3.ascending);
      band.attr('d', stepArea(xs.map(b => [b, at(nowI, b), Math.max(at(nowI, b), at(thenI, b))]))).attr('opacity', 1);
    } else band.attr('opacity', 0);

    const lines = gLines.selectAll('g').data(periodsInfo.slice().sort((a, b) => order[role(a.p)] - order[role(b.p)]), d => d.p)
      .join(enter => {
        const g = enter.append('g').style('cursor', 'pointer');
        g.append('path').attr('class', 'ln').attr('fill', 'none').attr('stroke-linejoin', 'round');
        g.append('path').attr('class', 'hit').attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 10);
        return g;
      }).order();
    lines.select('.ln').interrupt().attr('stroke', strokeOf).attr('stroke-width', widthOf).attr('d', d => step(d.pts));
    lines.select('.hit').attr('d', d => step(d.pts))
      .on('mouseenter', (event, d) => {
        lines.filter(x => x.p === d.p).select('.ln').attr('stroke-width', widthOf(d) + 1).attr('stroke', role(d.p) === 'other' ? '#9aa3ad' : strokeOf(d));
        if (d.p !== s.period) preview(d.Sp);
      })
      .on('mousemove', (event, d) => showTip(event, `<strong>${periodLabel(d.p)}</strong>: ${pctFmt(d.share)} within reach at your budget<br>` +
        `<span style="color:${theme.quiet}">${d.p === s.period ? 'The period on the map.' : 'Its coastline is dashed on the map. Click to show this period.'}</span>`))
      .on('mouseleave', (event, d) => {
        hideTip(); endPreview();
        lines.filter(x => x.p === d.p).select('.ln').attr('stroke-width', widthOf(d)).attr('stroke', strokeOf(d));
      })
      .on('click', (event, d) => { event.stopPropagation(); hideTip(); endPreview(); if (d.p !== s.period) ev.emit('period', d.p); });

    chartTitle.text(`How much of the city does your budget reach? (${set.length} communities, ${s.size} m²)`);
    // Legend, right-aligned: a short line in each style and its name
    const items = [{ c: theme.depth.deep, w: 2.6, t: periodLabel(s.period), ink: true },
      same ? null : { c: thenColor, w: 2, t: periodLabel(s.thenPeriod) },
      { c: '#c3cad3', w: 1.2, t: 'other periods' }, { c: theme.depth.shallow, w: 8, t: 'reach lost', band: !same }].filter(d => d && d.band !== false);
    chartLegend.selectAll('*').remove();
    let lx = width;
    items.slice().reverse().forEach(d => {
      const tx = chartLegend.append('text').attr('y', 11).attr('text-anchor', 'end').attr('fill', d.ink ? theme.ink : theme.quiet)
        .style('font', `${d.ink ? 600 : 400} ${theme.size.small}px ${theme.font}`).attr('x', lx).text(d.t);
      const tw = tx.node().getComputedTextLength();
      const x1 = lx - tw - 22;
      chartLegend.append('line').attr('x1', x1).attr('x2', x1 + 16).attr('y1', 7).attr('y2', 7).attr('stroke', d.c)
        .attr('stroke-width', d.w).attr('stroke-opacity', d.band ? 0.3 : 1);
      lx = x1 - 16;
    });
    placeBudget(s.budget, !dragging && !!prev);
    drawPick(cur);
  }

  // The budget line, the handle, the two dots (then, now) and the arrow to the budget that reaches as far now
  function placeBudget(b, animate, xOverride) {
    if (!cur || !C) return;
    const x = xOverride ?? cx(b);
    const t = animate && !reduceMotion ? d3.transition().duration(450).ease(d3.easeCubicOut) : null;
    const go = sel => t ? sel.interrupt().transition(t) : sel.interrupt();
    go(budgetLine).attr('x1', x).attr('x2', x);
    go(barFill).attr('width', Math.max(0, x - cm.l));
    go(knob).attr('transform', `translate(${x},${barY})`);
    const label = `${aed(b)} · ${fmt(b / cur.size)}/m²`;
    const w = label.length * 6.3 + 22;
    bubbleText.text(label);
    bubbleRect.attr('x', -w / 2).attr('width', w);
    tickLabels.attr('opacity', v => Math.abs(cx(v) - x) < w / 2 + 14 ? 0 : 1);
    knob.attr('aria-valuenow', b).attr('aria-valuetext', aed(b));

    const same = cur.thenPeriod === cur.period;
    const shareAt = d => d ? d3.bisectRight(d.edges, b) / d.n : NaN;
    const now = periodsInfo.find(d => d.p === cur.period), then = same ? null : periodsInfo.find(d => d.p === cur.thenPeriod);
    const dots = [now && { k: 'now', v: shareAt(now), c: theme.depth.deep, p: cur.period },
      then && { k: 'then', v: shareAt(then), c: thenColor, p: cur.thenPeriod }].filter(Boolean);
    const leftSide = x > cm.l + 120;     // labels sit left of the line, clear of the arrow
    const ys = dots.map(d => cy(d.v));
    if (ys.length === 2 && Math.abs(ys[0] - ys[1]) < 15) {   // keep the two labels apart
      const mid = (ys[0] + ys[1]) / 2, up = ys[1] <= ys[0] ? 1 : 0;
      ys[up] = mid - 8; ys[1 - up] = mid + 8;
    }
    gDots.selectAll('g').data(dots, d => d.k).join(enter => {
      const g = enter.append('g');
      g.append('circle').attr('r', 4.5).attr('stroke', '#ffffff').attr('stroke-width', 1.5);
      g.append('text').attr('dy', '0.35em').attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.5)
        .style('font', `600 ${theme.size.small}px ${theme.font}`);
      return g;
    }).each(function (d, i) {
      const g = d3.select(this);
      go(g.select('circle')).attr('cx', x).attr('cy', cy(d.v)).attr('fill', d.c);
      go(g.select('text')).attr('x', leftSide ? x - 10 : x + 10).attr('y', ys[i]);
      g.select('text').attr('text-anchor', leftSide ? 'end' : 'start').attr('fill', d.c)
        .text(`${pctFmt(d.v)} in ${periodLabel(d.p)}`);
    });

    // The arrow: from "then" at your budget, across to where "now" reaches as far
    gEq.selectAll('*').remove();
    if (then && now) {
      const target = shareAt(then), k = Math.ceil(target * now.n - 1e-9);
      if (k >= 1 && k <= now.n && Math.abs(shareAt(now) - target) > 1e-9) {
        const eq = ceilBudget(now.edges[k - 1]), x2 = cx(eq), y2 = cy(target);
        if (Math.abs(x2 - x) > 24) {
          const more = eq > b;
          gEq.append('line').attr('x1', x + (more ? 6 : -6)).attr('x2', x2 + (more ? -5 : 5)).attr('y1', y2).attr('y2', y2)
            .attr('stroke', theme.depth.deep).attr('stroke-width', 1.4).attr('marker-end', 'url(#vb-arrow)')
            .attr('pointer-events', 'none');
          const lab = gEq.append('g').style('cursor', 'pointer').on('click', () => ev.emit('budget', eq));
          lab.append('title').text(`Set your budget to ${aed(eq)}`);
          // label starts beside the budget line on the arrow's side, so it never covers the dot labels
          const fitsRight = more && x + 8 + 250 < width - cm.r;
          lab.append('text').attr('x', more ? (fitsRight ? x + 8 : x2) : x - 8).attr('y', y2 - 8)
            .attr('text-anchor', more ? (fitsRight ? 'start' : 'end') : 'end')
            .attr('fill', theme.depth.deep).attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.5)
            .style('font', `600 ${theme.size.small}px ${theme.font}`)
            .text(`${more ? '+' : '−'}${aed(Math.abs(eq - b)).replace('AED ', 'AED ')} reaches as far: ${aed(eq)}`);
        }
      }
    }
  }

  // The selected (and hovered) community on the chart: the step where it comes within reach, then and now
  function drawPick(s) {
    if (!s) return;
    const picks = [];
    [[s.selected, 'sel'], [s.hovered !== s.selected ? s.hovered : null, 'hov']].forEach(([c, kind]) => {
      if (!c) return;
      periodsInfo.filter(d => d.p === s.period || (d.p === s.thenPeriod && s.thenPeriod !== s.period)).forEach(d => {
        const st = d.Sp.get(c);
        if (!charted(st) || !C.set.includes(c) || st.edge < BUDGET_MIN || st.edge > BUDGET_MAX) return;
        picks.push({ c, kind, now: d.p === s.period, x: cx(st.edge), y: cy(d3.bisectRight(d.edges, st.edge) / d.n) });
      });
    });
    gPick.selectAll('circle').data(picks, d => d.kind + d.c + d.now).join('circle')
      .attr('cx', d => d.x).attr('cy', d => d.y).attr('r', d => d.kind === 'sel' ? 5.5 : 4.5).attr('fill', '#ffffff')
      .attr('stroke', d => d.now ? theme.depth.deep : thenColor).attr('stroke-width', d => d.kind === 'sel' ? 2.4 : 1.6);
    gPick.selectAll('text').data(picks.filter(d => d.now), d => d.kind + d.c).join('text')
      .attr('x', d => d.x + 8).attr('y', d => d.y + 13).attr('fill', theme.ink).attr('paint-order', 'stroke')
      .attr('stroke', '#ffffff').attr('stroke-width', 3.5).style('font', `600 10.5px ${theme.font}`).text(d => nameOf(d.c));
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
      .attr('stroke-width', m => m.kind === 'selected' ? 2.8 : m.kind === 'hovered' ? 1.8 : 1.6)
      .attr('stroke-dasharray', m => m.kind === 'pinned' ? '4 3' : null);
    gMarks.selectAll('text').data(marks.filter(m => m.kind === 'pinned' && byComm.has(m.c)), m => m.c).join('text')
      .attr('x', m => path.centroid(byComm.get(m.c))[0]).attr('y', m => path.centroid(byComm.get(m.c))[1])
      .attr('text-anchor', 'middle').attr('dy', '0.35em').attr('fill', theme.ink).attr('paint-order', 'stroke')
      .attr('stroke', '#ffffff').attr('stroke-width', 3).style('font', `700 ${theme.size.small}px ${theme.font}`)
      .text(m => m.i + 1);
  }

  // ---------- the moving light ----------
  let raf = null, visible = true, clock = null;
  function frame(now) {
    light.draw(clock ? clock() : now / 1000);
    raf = visible ? requestAnimationFrame(frame) : null;
  }
  if (light) {
    if ('IntersectionObserver' in window) new IntersectionObserver(es => {
      visible = es[es.length - 1].isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(frame);
    }).observe(svg.node());
    raf = requestAnimationFrame(frame);
  }

  const DATA_KEYS = ['period', 'thenPeriod', 'mode', 'homeType', 'money', 'dropExtremes', 'budget', 'size'];
  return {
    update(s) {
      cur = s;
      const dataChanged = !prev || DATA_KEYS.some(k => prev[k] !== s[k]);
      if (dataChanged) drawData(s, !!prev && !dragging);
      const pinsChanged = !prev || (prev.pinned || []).join() !== (s.pinned || []).join();
      if (dataChanged || prev.selected !== s.selected || prev.hovered !== s.hovered || pinsChanged ||
          prev.highlight !== s.highlight) drawMarks(s);
      if (!dataChanged && (prev.selected !== s.selected || prev.hovered !== s.hovered || prev.thenPeriod !== s.thenPeriod)) drawPick(s);
      prev = s;
    },
    on: ev.on,
    // for recording demos at a steady frame rate: replace the clock (null restores real time)
    _setClock: fn => { clock = fn; },
    // for tests and the referee script: the numbers this view shows
    _debug: s => ({ comparable: comparable(statsFor(s.thenPeriod, s), statsFor(s.period, s)),
      charted: chartedShare(statsFor(s.period, s)) })
  };
}
