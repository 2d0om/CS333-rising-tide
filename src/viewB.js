// src/viewB.js — View B, "The Sea" (Member 2)
// Sand is where your budget reaches; the deeper the water, the fewer homes you could buy.
// Contract: createViewB(container, data, theme, { width, height }) -> { update(state), on(event, handler) }
// Emits: select, pin, hover, mode, thenPeriod, period, budget.
//
// Design rules for this view:
//   * What matters is on screen without hovering: the headline, the annotation under it, the
//     communities that went under since "then" (outlined), and the land curve with its numbers.
//     Hover and click only add detail (overview first, details on demand).
//   * Every colour is exact: one fill per community from its own sales. The coastline runs along
//     real community borders, never interpolated. The moving light on the water never changes colour.
//   * Only things that respond look like they respond: communities with data, fog (hover only),
//     earlier coastlines, the curve and the budget line. Areas with no sales do nothing.
import { emitter } from './emitter.js';
import * as R from './rules.js';
import { createSeaLight } from './seashader.js';

export const BUILD = 'View B · land curve + honest map · 2026-11-13';

const PERIOD_KEYS = Object.keys(R.PERIODS);
const periodLabel = p => p.replace('-', '–');
const fmt = d3.format(',.0f');
const pctFmt = d3.format('.0%');
const aed = v => v >= 1e6 ? `AED ${d3.format('.2~f')(v / 1e6)}M` : `AED ${d3.format(',.0f')(v / 1e3)}k`;
const MODE_LABEL = { all: 'All homes', offplan: 'Off-plan only', ready: 'Ready only' };
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
  function statsFor(period, s) {           // Map comm -> { n, p50, shareWithin, edge }
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
  const gap = 10, toolbarH = 40, headH = 60, keyH = 30, chartH = 170;
  const mapH = Math.max(300, height - toolbarH - headH - keyH - chartH - gap * 4);

  const toolbar = root.append('div').style('height', `${toolbarH}px`).style('display', 'flex')
    .style('align-items', 'center').style('gap', '18px').style('flex-wrap', 'wrap');
  const modeGroup = toolbar.append('div').attr('role', 'group').attr('aria-label', 'Which homes')
    .style('display', 'flex').style('gap', '6px');
  const modeButtons = modeGroup.selectAll('button').data(['all', 'offplan', 'ready']).join('button')
    .attr('type', 'button').text(d => MODE_LABEL[d])
    .style('font', `600 ${theme.size.small}px ${theme.font}`).style('padding', '6px 12px')
    .style('border-radius', '8px').style('cursor', 'pointer');
  const budgetText = toolbar.append('div').style('font-size', `${theme.size.small}px`).style('color', theme.quiet);

  // Headline + one annotation line: the finding, always visible
  const head = root.append('div').style('min-height', `${headH}px`).style('margin-top', `${gap}px`);
  const headline = head.append('div').style('font-size', `${theme.size.label + 1}px`).style('line-height', '1.4');
  const annotation = head.append('div').style('font-size', `${theme.size.small}px`).style('color', theme.quiet)
    .style('line-height', '1.45').style('margin-top', '3px');

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

  // ---------- land curve ----------
  // How far does a budget reach? x = budget (log), y = share of the comparable communities on land.
  // Each step of a line is one community crossing to land. Position, not colour, carries the comparison.
  const chart = root.append('svg').attr('width', width).attr('height', chartH)
    .style('display', 'block').style('margin-top', `${gap}px`).style('overflow', 'visible');
  const cm = { l: 46, r: 18, t: 26, b: 26 };
  const cx = d3.scaleLog().domain([BUDGET_MIN, BUDGET_MAX]).range([cm.l, width - cm.r]).clamp(true);
  const cy = d3.scaleLinear().domain([0, 1]).range([chartH - cm.b, cm.t]);
  const chartTitle = chart.append('text').attr('x', 0).attr('y', 12).attr('fill', theme.ink)
    .style('font', `600 ${theme.size.small}px ${theme.font}`);
  const chartLegend = chart.append('text').attr('x', width).attr('y', 12).attr('text-anchor', 'end')
    .attr('fill', theme.quiet).style('font-size', `${theme.size.small}px`);
  const gGrid = chart.append('g');
  [0, 0.5, 1].forEach(v => {
    gGrid.append('line').attr('x1', cm.l).attr('x2', width - cm.r).attr('y1', cy(v)).attr('y2', cy(v))
      .attr('stroke', v === 0.5 ? '#d5dbe2' : theme.grid);
    gGrid.append('text').attr('x', cm.l - 6).attr('y', cy(v)).attr('dy', '0.35em').attr('text-anchor', 'end')
      .attr('fill', theme.quiet).style('font-size', '10.5px').text(pctFmt(v));
  });
  const xTicks = gGrid.append('g');
  [400e3, 600e3, 800e3, 1e6, 1.5e6, 2e6, 3e6, 4e6].forEach(v =>
    xTicks.append('text').datum(v).attr('x', cx(v)).attr('y', chartH - 6).attr('text-anchor', 'middle')
      .attr('fill', theme.quiet).style('font-size', '10.5px').text(aed(v).replace('AED ', '')));
  const plotBg = chart.append('rect').attr('x', cm.l).attr('y', cm.t).attr('width', width - cm.l - cm.r)
    .attr('height', chartH - cm.t - cm.b).attr('fill', 'transparent').style('cursor', 'ew-resize');
  const gLines = chart.append('g');
  const budgetLine = chart.append('line').attr('y1', cm.t - 4).attr('y2', chartH - cm.b + 2)
    .attr('stroke', theme.ink).attr('stroke-width', 1.4).attr('pointer-events', 'none');
  const gEq = chart.append('g');
  const gDots = chart.append('g').attr('pointer-events', 'none');
  const gEdges = chart.append('g').attr('pointer-events', 'none');   // the selected community's edge, then and now
  const handle = chart.append('g').attr('tabindex', 0).attr('role', 'slider')
    .attr('aria-label', 'Your budget. Left and right arrows change it.')
    .attr('aria-valuemin', BUDGET_MIN).attr('aria-valuemax', BUDGET_MAX).style('cursor', 'ew-resize').style('outline', 'none');
  const handleRect = handle.append('rect').attr('y', chartH - cm.b + 1).attr('height', 20).attr('rx', 10).attr('fill', theme.ink);
  const handleText = handle.append('text').attr('y', chartH - cm.b + 11).attr('dy', '0.35em').attr('text-anchor', 'middle')
    .attr('fill', '#ffffff').style('font', `600 10.5px ${theme.font}`);
  const step = d3.line().curve(d3.curveStepAfter).x(d => cx(d[0])).y(d => cy(d[1]));

  // ---------- tooltip and card ----------
  const tip = root.append('div').style('position', 'absolute').style('pointer-events', 'none')
    .style('background', '#ffffff').style('border', `1px solid ${theme.grid}`).style('border-radius', '8px')
    .style('padding', '7px 10px').style('font-size', `${theme.size.small}px`).style('line-height', '1.45')
    .style('box-shadow', '0 2px 8px rgba(0,0,0,0.08)').style('max-width', '260px').style('opacity', 0).style('z-index', 3);
  function showTip(event, html) {
    const [x, y] = d3.pointer(event, container);
    tip.html(html).style('opacity', 1).style('left', `${Math.min(x + 14, width - 270)}px`).style('top', `${y + 14}px`);
  }
  const hideTip = () => tip.style('opacity', 0);

  const mapTop = () => svg.node().getBoundingClientRect().top - container.getBoundingClientRect().top;
  const card = root.append('div').style('position', 'absolute').style('right', '12px').style('width', '280px')
    .style('background', 'rgba(255,255,255,0.97)').style('border', `1px solid ${theme.grid}`).style('border-radius', '10px')
    .style('box-shadow', '0 4px 16px rgba(15,30,50,0.12)').style('padding', '12px 14px')
    .style('font-size', `${theme.size.small}px`).style('line-height', '1.5').style('display', 'none').style('z-index', 2);

  // ---------- state ----------
  let prev = null, cur = null, S = new Map(), Sthen = new Map(), C = null, dragging = false;
  let readoutValues = null, flipped = [], periodsInfo = [];
  const lastOut = new Map();

  // ---------- interactions ----------
  function tipForCommunity(c) {
    const st = S.get(c);
    const other = alsoKnownAs(c) ? `<br><span style="color:${theme.quiet}">${alsoKnownAs(c)}</span>` : '';
    const head = `<strong>${nameOf(c)}</strong>${other}<br>`;
    if (!charted(st)) return `${head}Only ${st ? st.n : 0} sale${st && st.n === 1 ? '' : 's'} in ${periodLabel(cur.period)}: too few to trust (20 needed).`;
    return `${head}<strong>${pctFmt(st.shareWithin)}</strong> of homes within your budget · ${fmt(st.n)} sales<br>` +
      `<span style="color:${theme.quiet}">Click for details</span>`;
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

  // Budget: drag across the curve, click a spot, or use the arrow keys on the handle
  let pending = null;
  function sendBudget(b) {
    b = Math.max(BUDGET_MIN, Math.min(BUDGET_MAX, b));
    placeBudget(b, false);
    budgetText.html(budgetHtml(b, cur.size));
    if (pending == null) requestAnimationFrame(() => { const v = pending; pending = null; if (v != null) ev.emit('budget', v); });
    pending = b;
  }
  const atX = x => roundBudget(cx.invert(x));
  const drag = d3.drag().container(chart.node()).clickDistance(4)
    .on('drag', e => { if (cur) { dragging = true; sendBudget(atX(e.x)); } })
    .on('end', () => requestAnimationFrame(() => requestAnimationFrame(() => { dragging = false; })));
  plotBg.call(drag).on('click', event => { if (cur) ev.emit('budget', atX(d3.pointer(event, chart.node())[0])); });
  handle.call(drag).on('keydown', event => {
    const f = { ArrowLeft: 1 / 1.1, ArrowDown: 1 / 1.1, ArrowRight: 1.1, ArrowUp: 1.1, PageDown: 1 / 1.5, PageUp: 1.5 }[event.key];
    if (!f || !cur) return;
    event.preventDefault();
    ev.emit('budget', roundBudget(Math.max(BUDGET_MIN, Math.min(BUDGET_MAX, cur.budget * f))));
  }).on('focus', () => handleRect.attr('fill', theme.accent)).on('blur', () => handleRect.attr('fill', theme.ink));

  const budgetHtml = (b, size) => `Your budget <strong style="color:${theme.ink}">${aed(b)}</strong> for ${size} m² ` +
    `→ up to AED ${fmt(b / size)} per m² · <span style="color:${theme.quiet}">drag the line on the chart below to change it</span>`;

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
    keyFlip.html(same ? '' : `${swatch('transparent', theme.accent)}went under since ${periodLabel(s.thenPeriod)}`);

    drawHeadline(s, same, cameBack, animate);
    budgetText.html(budgetHtml(s.budget, s.size));

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
      ? `At ${b}, <strong>${pctFmt(v[0])}</strong> of communities with enough sales are within reach in ${periodLabel(s.period)}.`
      : `At ${b}, <strong>${pctFmt(v[0])}</strong> of these ${C.n} communities were within reach in ${periodLabel(s.thenPeriod)}. ` +
        `In ${periodLabel(s.period)}: <strong>${pctFmt(v[1])}</strong>.`;
    headline.interrupt();
    if (!animate || reduceMotion) headline.html(render(target));
    else { const i = d3.interpolate(from, target); headline.transition().duration(650).tween('n', () => t => headline.html(render(i(t)))); }

    // Annotation: who went under, where, and how much of it is the kind of home being sold
    const parts = [];
    if (!same && flipped.length) {
      const names = flipped.slice().sort((a, b2) => S.get(b2).n - S.get(a).n).map(nameOf);
      const km = d3.median(flipped, kmFromCentre);
      const residents = d3.sum(flipped, pop);
      parts.push(`<span style="color:${theme.accent};font-weight:600">${flipped.length} went under</span> since ${periodLabel(s.thenPeriod)}` +
        (Number.isFinite(km) ? `, typically ${Math.round(km)} km from Downtown` : '') + `: ${names.slice(0, 3).join(', ')}` +
        (names.length > 3 ? ` and ${names.length - 3} more` : '') + (residents ? ` (${d3.format('.2~s')(residents)} residents in 2019)` : '') + '.');
    }
    if (!same && cameBack.length) parts.push(`${cameBack.length} came back within reach.`);
    const lines = [parts.join(' ')];
    if (!same) {
      // The budget that reaches as far now as yours did then (the dashed step on the chart)
      const edges = C.set.map(c => S.get(c).edge).sort(d3.ascending);
      const k = Math.ceil(C.land1 * edges.length - 1e-9);
      const eq = k >= 1 ? ceilBudget(edges[k - 1]) : NaN;
      const reach = Number.isFinite(eq) && Math.abs(C.land2 - C.land1) > 1e-9
        ? `To reach as far as in ${periodLabel(s.thenPeriod)} you would need <strong style="color:${theme.ink}">${aed(eq)}</strong>. ` : '';
      const others = ['all', 'ready', 'offplan'].filter(m => m !== s.mode).map(m => {
        const c2 = comparable(statsFor(s.thenPeriod, { ...s, mode: m }), statsFor(s.period, { ...s, mode: m }));
        return `${MODE_LABEL[m].replace(' only', '').toLowerCase()} ${pctFmt(c2.land1)} → ${pctFmt(c2.land2)}`;
      });
      lines.push(`${reach}Same budget by type of home: ${others.join(', ')}.`);
    }
    annotation.html(lines.filter(Boolean).join('<br>'));
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
      const edges = set.filter(c => charted(Sp.get(c))).map(c => Sp.get(c).edge).sort(d3.ascending);
      const n = edges.length;
      const pts = [[BUDGET_MIN, d3.bisectRight(edges, BUDGET_MIN) / n]];
      edges.forEach((e, i) => { if (e > BUDGET_MIN && e < BUDGET_MAX) pts.push([e, (i + 1) / n]); });
      pts.push([BUDGET_MAX, d3.bisectRight(edges, BUDGET_MAX) / n]);
      const share = set.filter(c => charted(Sp.get(c))).length
        ? set.filter(c => isLand(Sp.get(c))).length / set.filter(c => charted(Sp.get(c))).length : NaN;
      return { p, pts, edges, n, share, Sp };
    }).filter(d => d.n > 0);
    const role = p => p === s.period ? 'now' : (!same && p === s.thenPeriod) ? 'then' : 'other';
    const order = { other: 0, then: 1, now: 2 };
    const lines = gLines.selectAll('g').data(periodsInfo.slice().sort((a, b) => order[role(a.p)] - order[role(b.p)]), d => d.p)
      .join(enter => {
        const g = enter.append('g').style('cursor', 'pointer');
        g.append('path').attr('class', 'ln').attr('fill', 'none').attr('stroke-linejoin', 'round');
        g.append('path').attr('class', 'hit').attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 10);
        return g;
      }).order();
    lines.select('.ln').interrupt()
      .attr('stroke', d => role(d.p) === 'now' ? theme.depth.deep : role(d.p) === 'then' ? theme.quiet : lineGrey)
      .attr('stroke-width', d => role(d.p) === 'now' ? 2.4 : role(d.p) === 'then' ? 1.8 : 1.2)
      .attr('d', d => step(d.pts));
    lines.select('.hit').attr('d', d => step(d.pts))
      .on('mouseenter', (event, d) => {
        lines.filter(x => x.p === d.p).select('.ln').attr('stroke-width', 2.6);
        if (d.p !== s.period) preview(d.Sp);
      })
      .on('mousemove', (event, d) => showTip(event, `<strong>${periodLabel(d.p)}</strong>: ${pctFmt(d.share)} within reach at your budget<br>` +
        `<span style="color:${theme.quiet}">${d.p === s.period ? 'The period on the map.' : 'Dashed on the map. Click to show this period.'}</span>`))
      .on('mouseleave', (event, d) => {
        hideTip(); endPreview();
        lines.filter(x => x.p === d.p).select('.ln').attr('stroke-width', role(d.p) === 'now' ? 2.4 : role(d.p) === 'then' ? 1.8 : 1.2);
      })
      .on('click', (event, d) => { event.stopPropagation(); hideTip(); endPreview(); if (d.p !== s.period) ev.emit('period', d.p); });

    chartTitle.text(`How far does a budget reach? Share of the ${set.length} communities within reach, by budget (${s.size} m²)`);
    chartLegend.html(same ? `<tspan fill="${theme.depth.deep}" font-weight="600">— ${periodLabel(s.period)}</tspan>  <tspan fill="${lineGrey}">— other periods</tspan>`
      : `<tspan fill="${theme.depth.deep}" font-weight="600">— ${periodLabel(s.period)}</tspan>  <tspan fill="${theme.quiet}">— ${periodLabel(s.thenPeriod)}</tspan>  <tspan fill="#9aa3ad">— other periods</tspan>`);
    placeBudget(s.budget, !dragging && !!prev);
  }

  // Budget line, the two dots where it meets "then" and "now", and the budget that reaches as far now as yours did then
  function placeBudget(b, animate) {
    if (!cur || !C) return;
    const x = cx(b);
    const t = animate && !reduceMotion ? d3.transition().duration(450).ease(d3.easeCubicOut) : null;
    const go = sel => t ? sel.transition(t) : sel;
    go(budgetLine.interrupt()).attr('x1', x).attr('x2', x);
    const label = aed(b);
    const w = label.length * 6.2 + 18;
    go(handleRect.interrupt()).attr('x', x - w / 2).attr('width', w);
    go(handleText.interrupt()).attr('x', x);
    handleText.text(label);
    handle.attr('aria-valuenow', b).attr('aria-valuetext', label);
    xTicks.selectAll('text').attr('opacity', v => Math.abs(cx(v) - x) < w / 2 + 16 ? 0 : 1);

    const same = cur.thenPeriod === cur.period;
    const shareAt = d => d ? d3.bisectRight(d.edges, b) / d.n : NaN;
    const now = periodsInfo.find(d => d.p === cur.period), then = same ? null : periodsInfo.find(d => d.p === cur.thenPeriod);
    const dots = [now && { k: 'now', v: shareAt(now), c: theme.depth.deep, p: cur.period },
      then && { k: 'then', v: shareAt(then), c: theme.quiet, p: cur.thenPeriod }].filter(Boolean);
    const side = d => (d.k === 'now') === (x < width - 200);   // true: label to the right
    gDots.selectAll('g').data(dots, d => d.k).join(enter => {
      const g = enter.append('g');
      g.append('circle').attr('r', 4.5).attr('stroke', '#ffffff').attr('stroke-width', 1.5);
      g.append('text').attr('dy', '0.35em').attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3)
        .style('font', `600 ${theme.size.small}px ${theme.font}`);
      return g;
    }).each(function (d) {
      const g = d3.select(this);
      // keep the two labels apart when the dots are close
      go(g.select('circle').interrupt()).attr('cx', x).attr('cy', cy(d.v)).attr('fill', d.c);
      go(g.select('text').interrupt()).attr('x', side(d) ? x + 9 : x - 9).attr('y', cy(d.v));
      g.select('text').attr('text-anchor', side(d) ? 'start' : 'end').attr('fill', d.c)
        .text(`${pctFmt(d.v)} in ${periodLabel(d.p)}`);
    });

    // Same reach now: the smallest budget at which "now" reaches the share "then" reached at your budget
    gEq.selectAll('*').remove();
    if (then && now) {
      const target = shareAt(then), k = Math.ceil(target * now.n - 1e-9);
      if (k >= 1 && k <= now.n && Math.abs(shareAt(now) - target) > 1e-9) {
        const eq = ceilBudget(now.edges[k - 1]);
        const x2 = cx(eq), y2 = cy(target);
        gEq.append('line').attr('x1', x).attr('x2', x2).attr('y1', y2).attr('y2', y2)
          .attr('stroke', theme.depth.deep).attr('stroke-dasharray', '2 3').attr('pointer-events', 'none');
        gEq.append('circle').attr('cx', x2).attr('cy', y2).attr('r', 3.5).attr('fill', '#ffffff')
          .attr('stroke', theme.depth.deep).attr('stroke-width', 1.6).attr('pointer-events', 'none');
        const up = eq > b;
        const lab = gEq.append('text').attr('x', x2 + (up ? 7 : -7)).attr('y', y2 + 14).attr('text-anchor', up ? 'start' : 'end')
          .attr('fill', theme.depth.deep).attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3)
          .style('font', `600 ${theme.size.small}px ${theme.font}`).style('cursor', 'pointer')
          .text(`${aed(eq)} ›`);
        lab.append('title').text(`Click to set your budget to ${aed(eq)}`);
        lab.on('click', () => ev.emit('budget', eq));
      }
    }
  }

  // Selection card: details on demand, words and numbers only
  function drawCard(s) {
    const c = s.selected;
    if (!c || !byComm.has(c)) { card.style('display', 'none'); gEdges.selectAll('*').remove(); return; }
    const st = S.get(c), stThen = Sthen.get(c), same = s.thenPeriod === s.period;
    const seq = PERIOD_KEYS.map(p => { const x = statsFor(p, s).get(c); return { p, k: !x ? 'none' : !charted(x) ? 'fog' : isLand(x) ? 'land' : 'water', x }; });
    const firstWater = seq.findIndex((d, i) => d.k === 'water' && seq.slice(0, i).some(e => e.k === 'land'));
    const status = seq.every(d => d.k !== 'water' && d.k !== 'land') ? 'Not enough sales in any period.'
      : seq.filter(d => d.k === 'land' || d.k === 'water').every(d => d.k === 'water') ? 'Out of reach in every period with enough sales.'
      : seq.filter(d => d.k === 'land' || d.k === 'water').every(d => d.k === 'land') ? 'Within reach in every period with enough sales.'
      : firstWater >= 0 ? `Went under in ${periodLabel(seq[firstWater].p)}.` : 'Came back within reach.';
    const chip = d => `<span title="${periodLabel(d.p)}" style="display:inline-block;width:46px;margin-right:3px;text-align:center;font-size:10px;color:${theme.quiet}">` +
      `<span style="display:block;height:8px;border-radius:2px;margin-bottom:2px;background:${d.k === 'none' ? noSales : d.k === 'fog' ? fogBg : depthColor(outOf(d.x))};` +
      `border:1px solid ${d.p === s.period ? theme.ink : 'transparent'}"></span>${periodLabel(d.p).slice(2)}</span>`;
    const row = (label, a, b) => `<div style="display:flex;justify-content:space-between;gap:8px"><span style="color:${theme.quiet}">${label}</span><span>${a}</span></div>`;
    const edgeNow = charted(st) ? aed(st.edge) : '—', edgeThen = charted(stThen) ? aed(stThen.edge) : '—';
    const change = charted(st) && charted(stThen) ? ` <span style="color:${theme.quiet}">(${d3.format('+.0%')(st.edge / stThen.edge - 1)})</span>` : '';
    const html =
      `<div style="display:flex;justify-content:space-between;align-items:start;gap:8px">` +
        `<div><strong style="font-size:${theme.size.label}px">${nameOf(c)}</strong>` +
        (alsoKnownAs(c) ? `<div style="color:${theme.quiet}">${alsoKnownAs(c)}</div>` : '') + `</div>` +
        `<button type="button" data-act="close" aria-label="Close" style="border:0;background:none;font-size:16px;line-height:1;cursor:pointer;color:${theme.quiet}">×</button></div>` +
      `<div style="margin:6px 0 4px">${status}</div>` +
      `<div style="margin-bottom:8px">${seq.map(chip).join('')}</div>` +
      `<div style="color:${theme.quiet};margin-bottom:2px">Budget for half the homes here (${s.size} m²)</div>` +
      (same ? row(periodLabel(s.period), edgeNow, '') : row(periodLabel(s.thenPeriod), edgeThen) + row(periodLabel(s.period), `<strong>${edgeNow}</strong>${change}`)) +
      `<div style="color:${theme.quiet};margin:6px 0 2px">Homes within ${aed(s.budget)}</div>` +
      (same ? row(periodLabel(s.period), charted(st) ? pctFmt(st.shareWithin) : '—')
        : row(`${periodLabel(s.thenPeriod)} → ${periodLabel(s.period)}`,
          `${charted(stThen) ? pctFmt(stThen.shareWithin) : '—'} → <strong>${charted(st) ? pctFmt(st.shareWithin) : '—'}</strong>`)) +
      `<div style="color:${theme.quiet};margin-top:2px">${st ? fmt(st.n) : 0} sales in ${periodLabel(s.period)}</div>` +
      `<div style="display:flex;gap:6px;margin-top:10px">` +
        (isWater(st) ? `<button type="button" data-act="budget" title="The budget at which half the homes here are within reach" style="${btn(true)}">Use ${aed(ceilBudget(st.edge))}</button>` : '') +
        `<button type="button" data-act="pin" style="${btn(false)}">${(s.pinned || []).includes(c) ? 'Unpin' : 'Pin'}</button></div>`;
    card.html(html).style('display', 'block');
    card.style('top', `${mapTop() + mapH - card.node().offsetHeight - 12}px`);
    card.selectAll('button[data-act]').on('click', function () {
      const act = this.getAttribute('data-act');
      if (act === 'close') ev.emit('select', null);
      if (act === 'budget') ev.emit('budget', ceilBudget(st.edge));
      if (act === 'pin') ev.emit('pin', c);
    });

    // On the chart: where this community crosses to land, then and now (ticks on the budget axis)
    const ticks = [charted(stThen) && !same ? { v: stThen.edge, c: theme.quiet } : null, charted(st) ? { v: st.edge, c: theme.ink } : null].filter(Boolean);
    gEdges.selectAll('*').remove();
    ticks.forEach(t2 => gEdges.append('path').attr('d', `M${cx(t2.v)},${chartH - cm.b - 1}l-4,-7h8z`).attr('fill', t2.c));
    if (ticks.length) gEdges.append('text').attr('x', cx(d3.max(ticks, t2 => t2.v)) + 7).attr('y', chartH - cm.b - 4)
      .attr('fill', theme.ink).style('font-size', '10px').attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3)
      .text(nameOf(c));
  }
  const btn = primary => `font:600 ${theme.size.small}px ${theme.font};padding:5px 10px;border-radius:7px;cursor:pointer;white-space:nowrap;` +
    (primary ? `background:${theme.ink};color:#fff;border:1px solid ${theme.ink}` : `background:#fff;color:${theme.ink};border:1px solid ${theme.grid}`);

  function drawMarks(s) {
    modeButtons
      .attr('aria-pressed', d => String(d === s.mode))
      .style('background', d => d === s.mode ? theme.ink : '#ffffff')
      .style('color', d => d === s.mode ? '#ffffff' : theme.ink)
      .style('border', d => `1px solid ${d === s.mode ? theme.ink : theme.grid}`);

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
      // the card is rebuilt only when what it says changes (never on hover, so its buttons stay clickable)
      if (dataChanged || prev.selected !== s.selected || pinsChanged) drawCard(s);
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
