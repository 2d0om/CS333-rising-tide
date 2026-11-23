// src/viewB.js — the Buyer view, "The Sea"
// Sand is where your budget buys a typical home; water is where it does not, deeper where fewer
// homes are within reach.
// Contract: createViewB(container, data, theme, { width, height, guessFirst? }) -> { update(state), on(event, handler) }
// Opens with "draw your guess" (AED 1M, 80 m², 2015–26) over the panel; guessFirst: false skips it.
// Emits: select, pin, hover, mode, thenPeriod, period, budget.
//
// Design rules for this view:
//   * Plain words and counts: "AED 1.2M buys a typical 80 m² apartment in 19 of the 27
//     neighbourhoods in 2015–17, but only 9 in 2024–26."
//   * What matters is on screen without hovering: the two big numbers (then → now), the floor plan of
//     the home the budget buys, the typical price in each period, the line chart of the m² the budget
//     buys each year, and orange outlines on the neighbourhoods that went under. Clicking a
//     neighbourhood adds its own line to the chart. Hover only highlights and adds a tooltip.
//   * Every colour is exact: one fill per community from its own sales. The coastline runs along
//     real community borders, never interpolated. Moving water and fog (surface.js) only add light
//     and texture; names, borders, the coastline and selections stay above them.
//   * Everything fits one screen: a title on top; the map on the left with your budget right on top
//     of it; the finding, two filters and the line chart on the right.
//   * Only things that respond look like they respond. Areas with no sales do nothing.
import { emitter } from './emitter.js';
import * as R from './rules.js';
import { createSurface } from './surface.js';

export const BUILD = 'View B · lays itself out again on resize · 2026-11-22';

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

  // Homes only: a "Unit" can also be an office, a shop or a hotel room (15% of unit sales in 2015–17),
  // which would mix non-homes into "a typical apartment". Apartments are units of sub-type Flat.
  const homeSales = data.rows
    .filter(r => r.trans_group_en === 'Sales' &&
      ((r.property_type_en === 'Unit' && r.property_sub_type_en === 'Flat') || r.property_type_en === 'Villa'))
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

  // The counted set: neighbourhoods with 20+ sales in EVERY period (27 at the defaults). One fixed
  // set means every count is "of 27" in every period, and a neighbourhood can never drop out of a
  // period's count just because it had too few sales that period (which looks like a price change
  // but is not).
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

  // ---------- by year, by how pricey an area was (the line chart) ----------
  // Three groups: the counted neighbourhoods (20+ flat sales in every period, all homes) cut into equal
  // thirds by their typical price per m² in 2015–17: the cheapest, mid-priced and priciest areas. A fixed
  // cut, so a group keeps its members whatever the filters. Years 2015 to 2026 (the window ends on 31 Aug
  // 2026, so 2026 is partial). Each year pools that year's sales with the year before and after (a 3-year
  // window): one year of the 10% sample is too thin in the smaller neighbourhoods.
  const YEARS = d3.range(R.PERIODS[PERIOD_KEYS[0]][0], R.PERIODS[PERIOD_KEYS[PERIOD_KEYS.length - 1]][1] + 1);
  const PARTIAL_YEAR = 2026;
  const YEAR_MIN = 10, RING_MIN = 5;      // a neighbourhood counts with 10+ sales in the window; a group needs 5 of them
  const ringBase = { mode: 'all', homeType: 'apartment', money: 'nominal', dropExtremes: false, budget: 1e6, size: 80,
    period: PERIOD_KEYS[PERIOD_KEYS.length - 1], thenPeriod: PERIOD_KEYS[0] };
  const base0 = pricesBy(PERIOD_KEYS[0], ringBase);
  const byPrice = reach(ringBase).set.filter(c => (base0.get(c) || []).length)
    .sort((a, b) => d3.median(base0.get(a)) - d3.median(base0.get(b)));
  const third = Math.ceil(byPrice.length / 3);
  const RINGS = [
    { key: 'cheap', name: 'Cheapest', desc: 'the cheapest third of areas in 2015–17' },
    { key: 'mid', name: 'Mid-priced', desc: 'the middle third by price in 2015–17' },
    { key: 'prime', name: 'Priciest', desc: 'the priciest third of areas in 2015–17' }
  ].map((g, i) => ({ ...g, members: byPrice.slice(i * third, (i + 1) * third) })).filter(r => r.members.length);
  const yearCache = new Map();
  function yearData(s) {                  // { pooled(c, y): prices in the 3-year window, rings: per group, per year, m² per AED }
    const key = [s.mode, s.homeType, s.money, s.dropExtremes].join('|');
    if (yearCache.has(key)) return yearCache.get(key);
    const byYC = new Map();
    for (const { r, comm } of homeSales) {
      if (!R.isHomeSale(r, s.homeType) || !R.inMode(r, s.mode)) continue;
      if (s.dropExtremes && R.isExtreme(r)) continue;
      if (!Number.isFinite(r.price)) continue;
      const y = r.date.getUTCFullYear();
      let m = byYC.get(y); if (!m) byYC.set(y, (m = new Map()));
      let a = m.get(comm); if (!a) m.set(comm, (a = []));
      a.push(R.priceIn(r, s.money));
    }
    const memo = new Map();
    const pooled = (c, y) => {           // { n, med } of the sales in years y-1, y, y+1
      const k = c + '|' + y;
      if (!memo.has(k)) {
        let a = [];
        for (let t = y - 1; t <= y + 1; t++) { const m = byYC.get(t), x = m && m.get(c); if (x) a = a.concat(x); }
        memo.set(k, { n: a.length, med: a.length ? d3.median(a) : null });
      }
      return memo.get(k);
    };
    // A group's line = its 2015–17 level (the middle neighbourhood's m² per AED) × the median of its
    // neighbourhoods' own price change since 2015–17. Each neighbourhood is compared only with itself, so
    // one dropping in or out of a year's sample cannot make the line jump.
    const base = pricesBy(PERIOD_KEYS[0], s);
    const rings = RINGS.map(ring => {
      const p0 = new Map(ring.members.filter(c => (base.get(c) || []).length >= R.MIN_SALES).map(c => [c, d3.median(base.get(c))]));
      const level = d3.median([...p0.values()], v => 1 / v);
      const ys = YEARS.map(y => {
        const rel = [];
        for (const [c, v0] of p0) { const w = pooled(c, y); if (w.n >= YEAR_MIN) rel.push(v0 / w.med); }
        return { y, f: rel.length >= RING_MIN && level ? level * d3.median(rel) : null, n: rel.length };
      });
      return { ...ring, ys };
    });
    const out = { pooled, rings };
    yearCache.set(key, out);
    return out;
  }
  // Bedrooms, to say a number of m² in words: the median size of each flat type sold in the latest period
  // (studio, 1-, 2-, 3-bed); a home counts as the type whose size it is closest to (cut halfway between).
  const lastP = PERIOD_KEYS[PERIOD_KEYS.length - 1];
  const ROOM_SIZES = [['Studio', 'a studio'], ['1 B/R', 'a 1-bed'], ['2 B/R', 'a 2-bed'], ['3 B/R', 'a 3-bed']].map(([k, w], i) => ({ i, w,
    m2: d3.median(homeSales.filter(d => d.period === lastP && d.r.property_type_en === 'Unit' && d.r.rooms_en === k), d => +d.r.procedure_area) }))
    .filter(d => d.m2 > 0);
  const bedsOf = m2 => {
    const R0 = ROOM_SIZES;
    if (!R0.length) return { i: 0, w: '' };
    if (m2 < R0[0].m2 * 0.75) return { i: -1, w: 'less than a studio' };
    if (m2 > R0[R0.length - 1].m2 * 1.3) return { i: R0.length, w: `more than ${R0[R0.length - 1].w}` };
    for (let i = 0; i < R0.length - 1; i++) if (m2 < (R0[i].m2 + R0[i + 1].m2) / 2) return R0[i];
    return R0[R0.length - 1];
  };
  const commYearly = (s, c) => {         // one neighbourhood, m² per AED in each 3-year window with 10+ sales
    const { pooled } = yearData(s);
    return YEARS.map(y => { const w = pooled(c, y); return { y, f: w.n >= YEAR_MIN ? 1 / w.med : null }; });
  };

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
  const colGap = 22, rowGap = 8;
  root.style('display', 'flex').style('flex-direction', 'column').style('gap', `${rowGap}px`)
    .style('width', `${width}px`).style('height', `${height}px`);

  // 0. The title: what this is about in one line, and what to do with it
  const header = root.append('div').style('flex', 'none');
  const titleRow = header.append('div').style('display', 'flex').style('align-items', 'center').style('gap', '6px 14px')
    .style('flex-wrap', 'wrap');
  titleRow.append('div').style('font', `700 10.5px ${theme.font}`).style('letter-spacing', '0.12em')
    .style('text-transform', 'uppercase').style('color', '#ffffff').style('background', theme.depth.deep)
    .style('padding', '3px 9px').style('border-radius', '999px').style('flex', 'none').text('The Sea · 2015–2026');
  // The title fills with water: its water level is the share of the counted neighbourhoods under water
  // right now, so dragging the budget down sinks the question and raising it brings it back up. The water
  // is a mid sea-blue that stays readable (4:1 on white); the rest is ink. Set in drawHeadline.
  const TITLE_WATER = '#3d7fb5';
  const titleEl = titleRow.append('div').attr('role', 'heading').attr('aria-level', 2)
    .style('font', `800 ${Math.round(Math.max(24, Math.min(34, width / 46)))}px/1.12 ${theme.font}`)
    .style('letter-spacing', '-0.015em').style('flex', 'none').style('color', theme.ink)
    .style('background-image', `linear-gradient(to bottom, ${theme.ink} 0 50%, ${TITLE_WATER} 50% 100%)`)
    .style('background-size', '100% 200%').style('background-position', '0 0%')
    .style('-webkit-background-clip', 'text').style('background-clip', 'text')
    .style('-webkit-text-fill-color', 'transparent')
    .style('transition', 'background-position 0.9s cubic-bezier(.45,.05,.35,1)')
    .text('How much of Dubai can your budget keep above water?');
  // The description, in the map's own colours: the words sand and water look like the map's sand and water
  const SAND_WORD = '#a8803a';
  const sub = titleRow.append('div').style('font', `500 ${theme.size.label}px/1.4 ${theme.font}`)
    .style('color', theme.depth.deep).style('flex', '1 1 300px').style('min-width', '0');
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
  const stripH = 46;
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

  // 1. The finding: one sentence with two labelled numbers, and beside them the home that budget buys
  //    (the niche: the same money buys a smaller home), as two floor plans drawn to the same scale.
  const headline = panel.append('div').style('min-height', '112px').style('flex', 'none');   // never squeezed under the next row
  const headLead = headline.append('div').style('font-size', `${theme.size.label + 1.5}px`).style('line-height', '1.4');
  const headRow = headline.append('div').style('display', 'flex').style('align-items', 'flex-end').style('gap', '12px')
    .style('margin', '6px 0 5px');
  const headNums = headRow.append('div').style('display', 'flex').style('align-items', 'flex-start').style('gap', '14px');
  const PLAN_W = 188, PLAN_H = 64, PLAN_TX = 72;          // squares up to 62 px wide; the words start at x = 72
  const planWrap = headRow.append('div').style('margin-left', 'auto').style('flex', 'none').style('position', 'relative')
    .style('width', `${PLAN_W}px`).style('height', `${PLAN_H}px`);
  const planSvg = planWrap.append('svg').attr('width', PLAN_W).attr('height', PLAN_H).attr('aria-hidden', true)
    .style('display', 'block').style('overflow', 'visible');
  // The floor plan folds away with its own title; its space stays, so nothing else moves.
  let planOn = true;
  const planTitle = () => `<span style="display:inline-block;width:12px;color:${theme.quiet}">${planOn ? '▾' : '▸'}</span>The home it buys`;
  const planToggle = planWrap.append('button').attr('type', 'button').attr('aria-expanded', 'true')
    .attr('title', 'Show or hide the floor plan')
    .style('position', 'absolute').style('left', `${PLAN_TX}px`).style('top', '-2px').style('padding', '0')
    .style('border', '0').style('background', 'none').style('cursor', 'pointer').style('color', theme.ink)
    .style('font', `700 11px ${theme.font}`).style('white-space', 'nowrap')
    .html(planTitle())
    .on('click', () => {
      planOn = !planOn;
      planSvg.style('visibility', planOn ? 'visible' : 'hidden');
      planToggle.attr('aria-expanded', String(planOn)).html(planTitle());
    });
  const headFoot = headline.append('div');

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
  // 3. The line chart, and its key underneath. The three price groups on one ordered scale: the darker the
  //    line, the pricier the areas (as on the map, where deeper water is further out of reach). Teal,
  //    blue-violet, plum: none is sand, sea or coral, which already mean something on the map. Each is at
  //    least 3:1 against both the sand and the sea behind it.
  const chartHead = panel.append('div').style('font', `600 ${theme.size.small + 0.5}px ${theme.font}`).style('min-height', '16px');
  const chartBox = panel.append('div').style('margin-top', '-6px');
  const RING_COL = ['#1f8a7e', '#5a62c4', '#3c1d5c'], RING_TEXT = RING_COL;
  const sw = (css) => `<span style="display:inline-block;vertical-align:middle;margin-right:5px;${css}"></span>`;
  const keyLine = c => sw(`width:16px;height:0;border-top:3px solid ${c};border-radius:2px`);
  panel.append('div').style('margin-top', '-8px').style('font', `500 11px/1.55 ${theme.font}`).style('color', theme.quiet)
    .html(`<div style="display:flex;flex-wrap:wrap;gap:0 12px;color:${theme.ink}">` +
      `<span>${keyLine(RING_COL[0])}Cheapest</span><span>${keyLine(RING_COL[1])}Mid-priced</span>` +
      `<span>${keyLine(RING_COL[2])}Priciest areas <span style="color:${theme.quiet}">(2015–17 prices)</span></span></div>`);

  // ---------- map: data underneath, moving water and fog in the middle, names and lines on top ----------
  const legendH = 0;            // the key is a small box in the bottom-right corner, not a band
  const KEY_W = 262, KEY_H = 150;
  const svg = mapBox.append('svg').attr('width', mapW).attr('height', mapH)
    .attr('viewBox', `0 0 ${mapW} ${mapH}`).attr('role', 'img')
    .attr('aria-label', 'Map of Dubai neighbourhoods: sand where your budget buys a typical home, water where it does not')
    .style('display', 'block').style('position', 'absolute').style('left', 0).style('top', 0);
  const projection = d3.geoMercator().fitExtent([[10, 8], [mapW - 10, mapH - 8]],
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

  // The key, in the empty bottom-right corner of the map: what sand, water, orange and fog mean
  const legend = mapBox.append('div').style('position', 'absolute').style('right', '10px').style('bottom', '10px')
    .style('width', `${KEY_W}px`).style('box-sizing', 'border-box').style('background', 'rgba(255,255,255,0.94)')
    .style('border', `1px solid ${theme.grid}`).style('border-radius', '8px')
    .style('display', 'flex').style('flex-direction', 'column').style('gap', '6px').style('padding', '8px 10px')
    .style('font-size', '11px').style('line-height', '1.35').style('pointer-events', 'none');
  const kw = KEY_W - 22;
  const legScale = legend.append('div').style('display', 'flex').style('flex-direction', 'column').style('gap', '4px');
  const legSvg = legScale.append('svg').attr('width', kw).attr('height', 30).attr('aria-hidden', true);
  const kg = legSvg.append('defs').append('linearGradient').attr('id', 'vb-key');
  [...d3.range(0, 0.5, 0.05), 0.4999, 0.5, ...d3.range(0.55, 1.001, 0.05)]
    .forEach(t => kg.append('stop').attr('offset', t).attr('stop-color', depthColor(t)));
  legSvg.append('rect').attr('y', 4).attr('width', kw).attr('height', 10).attr('rx', 2).attr('fill', 'url(#vb-key)');
  legSvg.append('line').attr('x1', kw / 2).attr('x2', kw / 2).attr('y1', 1).attr('y2', 17).attr('stroke', theme.coastline).attr('stroke-width', 2);
  [[0, 'all homes in reach', 'start'], [kw / 2, 'half', 'middle'], [kw, 'none', 'end']].forEach(([x, t, a]) =>
    legSvg.append('text').attr('x', x).attr('y', 28).attr('text-anchor', a).attr('fill', theme.quiet).style('font-size', '10px').text(t));
  const legText = legScale.append('div');
  const legOther = legend.append('div').style('display', 'flex').style('flex-direction', 'column').style('gap', '2px');
  const legNames = legend.append('div').style('color', theme.quiet);

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
    const inKey = b => b.x1 > mapW - KEY_W - 14 && b.y1 > mapH - KEY_H - 14;
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
          if (fits(b, it.a.ring) && !overlaps(b) && !inKey(b)) { placed.push(b); out.push({ ...it, lines, px }); return; }
        }
        if (!C.set.includes(it.c)) return;          // counted neighbourhoods: a smaller name, even if it overhangs
        const b = box(it.a.x, it.a.y, lines, 9);
        if (!overlaps(b) && !inKey(b) && b.x0 > 2 && b.x1 < mapW - 2 && b.y1 < mapH - 2) { placed.push(b); out.push({ ...it, lines, px: 9 }); }
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

  // ---------- the line chart ----------
  // x = year, y = the m² your budget buys there (linear, from 0). One line per price group (cheapest,
  // mid-priced, priciest third of the counted neighbourhoods, by 2015–17 prices), plus a dashed orange
  // line for the clicked neighbourhood. The 80 m² waterline splits sand (above) from sea (below).
  // PCOL: the colour of each period on its button, light → dark in time order.
  const PCOL = ['#b3bfcc', '#8c9fb5', '#5f7d9c', theme.depth.deep];
  const pcol = p => PCOL[Math.min(PCOL.length - 1, PERIOD_KEYS.indexOf(p))];
  const CW = panelW;
  const kids = panel.selectAll(':scope > div').nodes().filter(n => n !== chartBox.node());
  const usedH = d3.sum(kids, n => n.getBoundingClientRect().height) + 12 * kids.length - 6 * 3;
  const chartH = Math.max(220, Math.min(440, panelH - usedH));
  const chart = chartBox.append('svg').attr('width', CW).attr('height', chartH).style('display', 'block').style('overflow', 'visible');
  const cm = { l: 34, r: 50, t: 10 };                  // the right margin holds each line's last value
  const plotB = chartH - 24;
  const yx = d3.scaleLinear().domain([YEARS[0], YEARS[YEARS.length - 1]]).range([cm.l + 8, CW - cm.r - 8]);
  const ym = d3.scaleLinear().range([plotB, cm.t]);
  const halfStep = (yx(YEARS[0] + 1) - yx(YEARS[0])) / 2;
  const gGrid = chart.append('g').attr('pointer-events', 'none');
  const periodBand = chart.append('rect').attr('y', cm.t).attr('height', plotB - cm.t).attr('fill', theme.ink)
    .attr('fill-opacity', 0.05).attr('pointer-events', 'none');
  const bandFor = p => { const [a, b] = R.PERIODS[p]; periodBand.attr('x', yx(a) - halfStep).attr('width', yx(b) - yx(a) + 2 * halfStep); };
  const sandBg = chart.append('rect').attr('x', cm.l).attr('width', CW - cm.r - cm.l).attr('fill', '#efe3c8')
    .attr('fill-opacity', 0.28).attr('pointer-events', 'none');
  const seaBg = chart.append('rect').attr('x', cm.l).attr('width', CW - cm.r - cm.l).attr('fill', theme.depth.shallow)
    .attr('fill-opacity', 0.2).attr('pointer-events', 'none');
  const waterLine = chart.append('line').attr('x1', cm.l).attr('x2', CW - cm.r).attr('stroke', theme.depth.deep)
    .attr('stroke-width', 1.5).attr('pointer-events', 'none');
  const waterLab = chart.append('text').attr('x', cm.l + 5).attr('fill', theme.depth.deep).attr('paint-order', 'stroke')
    .attr('stroke', '#ffffff').attr('stroke-width', 3).style('font', `600 10.5px ${theme.font}`).attr('pointer-events', 'none');
  const gRingLines = chart.append('g').attr('pointer-events', 'none');
  const selPath = chart.append('path').attr('fill', 'none').attr('stroke', theme.accent).attr('stroke-width', 2.2)
    .attr('stroke-dasharray', '6 3')
    .attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round').attr('pointer-events', 'none');
  const gUnder = chart.append('g').attr('pointer-events', 'none');      // where a ring went under, and when
  const gPeak = chart.append('g').attr('pointer-events', 'none');       // the one peak worth naming
  const gHover = chart.append('g').attr('pointer-events', 'none').attr('opacity', 0);
  const hoverRule = gHover.append('line').attr('y1', cm.t).attr('y2', plotB).attr('stroke', theme.ink)
    .attr('stroke-opacity', 0.3).attr('stroke-dasharray', '3 3');
  const hoverDot = gHover.append('circle').attr('r', 4.5).attr('stroke', '#ffffff').attr('stroke-width', 1.5);
  const plotHit = chart.append('rect').attr('x', cm.l).attr('y', cm.t).attr('width', CW - cm.r - cm.l)
    .attr('height', plotB - cm.t).attr('fill', 'transparent').style('cursor', 'crosshair');
  const gEnd = chart.append('g');                                       // the line names, at the right
  chart.append('g').attr('pointer-events', 'none').selectAll('text').data(YEARS).join('text')
    .attr('x', y => yx(y)).attr('y', plotB + 15).attr('text-anchor', 'middle').attr('fill', theme.quiet)
    .style('font-size', '10.5px').text(y => `’${String(y).slice(2)}`);
  const lineOf = d3.line().defined(d => d.v != null).x(d => yx(d.y)).y(d => ym(d.v)).curve(d3.curveMonotoneX);

  const tickVals = [400e3, 600e3, 800e3, 1e6, 1.5e6, 2e6, 3e6, 4e6];   // the budget bar's labels

  // ---------- your budget: a bar right on top of the map ----------
  // Same log scale as the chart. Each notch is one counted neighbourhood at its typical price in the
  // period on the map: sand once your budget reaches it, sea-blue while it is out of reach. So the bar
  // shows where the next neighbourhoods come into reach before you drag. The orange notch is the one
  // you clicked.
  const labW = 116, trackY = 20;
  const ssvg = strip.append('svg').attr('width', mapW).attr('height', stripH).style('display', 'block').style('overflow', 'visible');
  ssvg.append('defs').append('filter').attr('id', 'vb-knob-shadow').attr('x', '-60%').attr('y', '-60%').attr('width', '220%').attr('height', '220%')
    .append('feDropShadow').attr('dx', 0).attr('dy', 1.5).attr('stdDeviation', 2).attr('flood-color', '#0b2540').attr('flood-opacity', 0.28);
  const barX = d3.scaleLog().domain([BUDGET_MIN, BUDGET_MAX]).range([labW + 12, mapW - 14]).clamp(true);
  ssvg.append('text').attr('x', 2).attr('y', 10).attr('fill', theme.quiet).style('font', `700 10.5px ${theme.font}`)
    .style('letter-spacing', '0.08em').text('YOUR BUDGET');
  const sVal = ssvg.append('text').attr('x', 2).attr('y', 37).attr('fill', theme.ink)
    .style('font', `800 21px ${theme.font}`).style('font-variant-numeric', 'tabular-nums');
  const sHit = ssvg.append('rect').attr('x', barX.range()[0] - 10).attr('y', 2).attr('width', barX.range()[1] - barX.range()[0] + 20)
    .attr('height', 40).attr('fill', 'transparent').style('cursor', 'pointer');
  ssvg.append('rect').attr('x', barX.range()[0]).attr('y', trackY - 3).attr('width', barX.range()[1] - barX.range()[0]).attr('height', 6)
    .attr('rx', 3).attr('fill', '#e3e8ee').attr('pointer-events', 'none');
  const sFill = ssvg.append('rect').attr('x', barX.range()[0]).attr('y', trackY - 3).attr('height', 6).attr('rx', 3)
    .attr('fill', theme.depth.deep).attr('pointer-events', 'none');
  const gNotch = ssvg.append('g');
  ssvg.append('g').attr('pointer-events', 'none').selectAll('text').data(tickVals).join('text')
    .attr('x', v => barX(v)).attr('y', trackY + 22).attr('text-anchor', 'middle').attr('fill', theme.quiet)
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
    .style('padding', '8px 11px').style('font-size', `${theme.size.small}px`).style('line-height', '1.55')
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
    if (!charted(st)) return `${head}Too few sales to show: ${st ? st.n : 0} in ${periodLabel(cur.period)} (20 needed).`;
    const same = cur.thenPeriod === cur.period, land = isLand(st);
    return `${head}A typical ${cur.size} m² ${homeWord()} here: <strong>${aed(st.edge)}</strong>` +
      (!same && charted(stThen) ? ` <span style="color:${theme.quiet}">(${aed(stThen.edge)} in ${periodLabel(cur.thenPeriod)})</span>` : '') +
      `<br><strong>${pctFmt(st.shareWithin)}</strong> of the homes sold here fit your ${aed(cur.budget)}` +
      `<br><strong style="color:${land ? SAND_WORD : theme.depth.deep}">${land ? 'Within reach: sand on the map' : 'Out of reach: water on the map'}</strong>` +
      `${statusOf(c, cur) ? ` <span style="color:${theme.quiet}">· ${statusOf(c, cur).toLowerCase()}</span>` : ''}`;
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
  const keyNs = `keydown.vb${Math.random().toString(36).slice(2, 7)}`;
  d3.select(window).on(keyNs, event => {
    if (event.key === 'Escape' && cur && cur.selected) ev.emit('select', null);
  });

  modeButtons
    .on('click', (event, m) => { endPreview(); ev.emit('mode', m); })
    .on('mouseenter', (event, m) => { if (cur && m !== cur.mode) preview(statsFor(cur.period, { ...cur, mode: m })); })
    .on('mouseleave', endPreview);
  function preview(Sp) { previewPath.attr('d', path(coastFor(Sp))).attr('opacity', 1); coastPath.attr('opacity', 0.25); }
  function endPreview() { previewPath.attr('opacity', 0); coastPath.attr('opacity', 1); if (cur) bandFor(cur.period); }

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
  // The line chart: hover a year to read the nearest line there (the floor plan shows that home); hover a
  // line (or its value) to outline its group's neighbourhoods on the map. Hover only: nothing here is clicked.
  const gRingMarks = top.append('g').attr('pointer-events', 'none');
  function outlineRing(i) {
    const members = i == null ? [] : RINGS[i].members.filter(c => byComm.has(c));
    gRingMarks.selectAll('path').data(members, c => c).join('path').attr('d', c => path(byComm.get(c)))
      .attr('fill', theme.ink).attr('fill-opacity', 0.08).attr('stroke', theme.ink).attr('stroke-width', 1.6)
      .attr('stroke-dasharray', '4 2');
  }
  const yearAt = event => Math.max(YEARS[0], Math.min(YEARS[YEARS.length - 1], Math.round(yx.invert(d3.pointer(event, chart.node())[0]))));
  // The box beside the chart: which line, that year's home and today's, in m² and in bedrooms, with the two
  // homes drawn as floor plans (then dashed, now filled, same scale). The headline's floor plan never
  // changes on hover: it always shows the area you clicked (or the typical one).
  function chartBoxTip(L, d) {
    const y = d.y, v = d.v, last = L.last, now = last && last.y !== y ? last.v : null;
    const big = Math.max(v, now || 0), k = Math.min(4.4, 54 / Math.sqrt(big)), side = m => k * Math.sqrt(m), H = Math.ceil(side(big)) + 2;
    const sq = (m, then) => `<rect x="1" y="${H - 1 - side(m)}" width="${side(m)}" height="${side(m)}" ` +
      (then ? `fill="none" stroke="#5f6f80" stroke-width="1.2" stroke-dasharray="3 2"` : `fill="${L.col}" fill-opacity="0.85"`) + '/>';
    const plan = `<svg width="${Math.ceil(side(big)) + 2}" height="${H}" style="flex:none;display:block">` +
      (now != null ? sq(now, false) + sq(v, true) : sq(v, false)) + '</svg>';
    // a small key mark before each row: dashed = that year, filled = now
    const mark = then => `<span style="display:inline-block;width:9px;height:9px;margin-right:6px;vertical-align:-1px;` +
      (then ? 'border:1.2px dashed #5f6f80' : `background:${L.col};opacity:.85`) + '"></span>';
    const row = (then, when, m) => `<div>${mark(then)}<span style="display:inline-block;min-width:36px;color:${theme.quiet}">${when}</span>` +
      `<b>${Math.round(m)} m²</b> · ${bedsOf(m).w}</div>`;
    const words = ['', 'one', 'two', 'three', 'four'];
    const k2 = now != null ? bedsOf(v).i - bedsOf(now).i : 0;
    const verdict = k2 > 0 ? `${words[k2] || k2} bedroom${k2 > 1 ? 's' : ''} less` : k2 < 0 ? `${words[-k2] || -k2} bedroom${k2 < -1 ? 's' : ''} more` : '';
    const yLab = y === PARTIAL_YEAR ? '2026' : String(y);
    tip.html(`<div style="font-weight:700;color:${L.text}">${L.label}</div>` +
      `<div style="color:${theme.quiet};margin-bottom:5px">What ${aed(cur.budget)} buys here</div>` +
      `<div style="display:flex;gap:10px;align-items:flex-end">${plan}<div>` +
      (now != null ? row(true, yLab, v) + row(false, 'now', now) : row(false, yLab, v)) +
      (verdict ? `<div style="margin-top:3px;font-weight:700;color:${theme.ink}">${verdict.charAt(0).toUpperCase() + verdict.slice(1)}</div>` : '') +
      `</div></div>`).style('opacity', 1);
    // to the left of the chart, level with the point, kept inside the view
    const rr = root.node().getBoundingClientRect(), cr = chart.node().getBoundingClientRect();
    const tw = tip.node().offsetWidth, th = tip.node().offsetHeight;
    const left = cr.left - rr.left - tw - 12, top = cr.top - rr.top + ym(v) - th / 2;
    tip.style('left', `${Math.max(4, left)}px`).style('top', `${Math.max(4, Math.min(height - th - 4, top))}px`);
  }
  plotHit.on('mousemove', event => {
    if (!cur || !ringView) return;
    const y = yearAt(event), my = d3.pointer(event, chart.node())[1];
    let best = null;
    ringView.lines.forEach(L => {
      const d = L.pts.find(q => q.y === y);
      if (d && d.v != null) { const dy = Math.abs(ym(d.v) - my); if (!best || dy < best.dy) best = { L, d, dy }; }
    });
    if (!best) { gHover.attr('opacity', 0); hideTip(); return; }
    hoverRule.attr('x1', yx(y)).attr('x2', yx(y));
    hoverDot.attr('cx', yx(y)).attr('cy', ym(best.d.v)).attr('fill', best.L.col);
    gHover.attr('opacity', 1); gPeak.attr('opacity', 0);
    outlineRing(best.L.ring);
    chartBoxTip(best.L, best.d);
  })
    .on('mouseleave', () => { gHover.attr('opacity', 0); gPeak.attr('opacity', 1); outlineRing(null); hideTip(); });
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
    // One sentence, with the two counts as big labelled numbers and the floor plan beside them. The odd
    // cases (nothing or everything in reach) are said in words, never as "0 → 0".
    const home = `a typical ${s.size} m² ${homeWord()}`;
    const money = `<strong>${aed(s.budget)}</strong>`;
    const num = (v, c, t) => `<div><div style="font-size:44px;font-weight:800;line-height:1;color:${c};font-variant-numeric:tabular-nums">${v}</div>` +
      `<div style="font-size:11px;color:${theme.quiet};margin-top:5px">${t}</div></div>`;
    const cheapest = Sp => d3.min(C.set, c => Sp.get(c).edge);
    let lead, nums = '', foot = '';
    if (!C.n) lead = 'Too few sales of these homes to compare neighbourhoods.';
    else if (C.k1 === 0 && C.k2 === 0) {
      lead = `${money} doesn't buy ${home} in any of the ${C.n} neighbourhoods${same ? ` in ${periodLabel(s.period)}` : ', then or now'}.`;
      // said beside the floor plan (where the big numbers would be), so the headline keeps its height
      nums = `<div style="font-size:${theme.size.small + 0.5}px;line-height:1.45;color:${theme.ink}">The cheapest needed <strong>${aed(cheapest(Sthen))}</strong>` +
        `${same ? '' : ` in ${periodLabel(s.thenPeriod)} and <strong>${aed(cheapest(S))}</strong> in ${periodLabel(s.period)}`}.</div>`;
    } else if (C.k1 === C.n && C.k2 === C.n) {
      lead = `${money} buys ${home} in all ${C.n} neighbourhoods${same ? ` in ${periodLabel(s.period)}` : ', then and now'}.`;
    } else {
      lead = `${money} buys ${home} in`;
      nums = same ? num(C.k2, theme.depth.deep, periodLabel(s.period))
        : num(C.k1, '#8493a5', periodLabel(s.thenPeriod)) + `<div style="font-size:26px;color:${theme.quiet};line-height:44px">→</div>` +
          num(C.k2, theme.depth.deep, periodLabel(s.period));
      foot = `<div style="font-size:${theme.size.small + 0.5}px;color:${theme.quiet}">of the ${C.n} neighbourhoods with enough sales to compare</div>`;
    }
    headLead.html(lead); headNums.html(nums); headFoot.html(foot);
    const under = C.n ? (C.n - C.k2) / C.n : 0;           // the title's water level
    titleEl.style('transition', reduceMotion || dragging ? 'none' : 'background-position 0.9s cubic-bezier(.45,.05,.35,1)')
      .style('background-position', `0 ${(under * 100).toFixed(1)}%`);
    describe(s.size, homeWord());
    // The "why" (off-plan rose from 5 to 7 in 10 sales, at about 1.5x resale) is said in the talk, not shown.
  }

  function drawLegend(s, same) {
    legText.html(`<strong style="color:#a8803a">Sand</strong>: your budget buys a typical home. ` +
      `<strong style="color:${theme.depth.deep}">Water</strong>: it doesn't; deeper = fewer homes in reach.`);
    legNames.html(`Names: the ${C.n} counted · hover for others`);
    legOther.html((same ? '' : `<span><span style="display:inline-block;width:12px;height:10px;border:2px solid ${theme.accent};border-radius:2px;vertical-align:-1px;margin-right:5px"></span>` +
      `<strong>${flipped.length}</strong> went under since ${periodLabel(s.thenPeriod)}</span>`) +
      `<span><span style="display:inline-block;width:12px;height:10px;border-radius:2px;vertical-align:-1px;margin-right:5px;background:${surface ? 'radial-gradient(circle at 35% 35%,#ffffff,#b9c3ce)' : `repeating-linear-gradient(45deg, ${theme.fog} 0 2px, #ffffff 2px 5px)`}"></span>` +
      `Fog: under 20 sales</span>`);
  }

  let heavyTimer = null;
  function drawHeavy(s, same) {
    // Earlier coastlines (tide marks): the "then" one (2015–17) clearer, the others faint.
    const earlier = PERIOD_KEYS.slice(0, PERIOD_KEYS.indexOf(s.period));
    const tides = earlier.map(p => ({ p, d: path(coastFor(statsFor(p, s))) || '' }));
    const tg = gTide.selectAll('g').data(tides, t => t.p).join(enter => {
      const g = enter.append('g');
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
      .on('mousemove', (event, t) => showTip(event, `<strong>The coast in ${periodLabel(t.p)}</strong><br>` +
        `<span style="color:${theme.quiet}">At your budget, the sand ended here then.</span>`))
      .on('mouseleave', function (event, t) {
        hideTip();
        d3.select(this.parentNode).select('.tide-line')
          .attr('stroke-opacity', t.p === s.thenPeriod ? 0.75 : 0.3).attr('stroke-width', t.p === s.thenPeriod ? 1.5 : 1);
      });

    drawCurve(s, same);
  }

  function drawCurve(s, same) {
    // Each period's typical prices for the counted neighbourhoods: the budget bar's notches, the period
    // buttons' prices and the map's preview read these.
    periodsInfo = PERIOD_KEYS.map(p => {
      const Sp = p === s.period ? S : p === s.thenPeriod ? Sthen : statsFor(p, s);
      const edges = C.set.filter(c => charted(Sp.get(c))).map(c => Sp.get(c).edge).sort(d3.ascending);
      return { p, edges, Sp };
    }).filter(d => d.edges.length);
    drawNotches(s);
    placeBudget(s.budget, !!prev && !dragging);
    drawTrace(cur);
  }

  // The niche: homes shrink. The space your budget buys (budget / price per m²) as two nested floor plans
  // to the same scale (area = m²): then (dashed) and now (filled). By default: 2015–17 vs the period on the
  // map, for the clicked neighbourhood or the typical (middle) one. Hovering the line chart shows that
  // line's year against its "now".
  function renderPlan({ a, aText, z, zText, where }) {
    planSvg.selectAll('*').remove();
    if (z == null) return;
    // One fixed scale up to about 120 m², so sizes compare across budgets; bigger homes shrink the scale,
    // and then a dotted typical-home outline appears so the change of scale is visible.
    const size = cur ? cur.size : 80;
    const K = 5.6, big = Math.max(a || 0, z), k = Math.min(K, (PLAN_H - 2) / Math.sqrt(big)), side = v => k * Math.sqrt(v);
    const x0 = 1, base = PLAN_H - 1;
    // then: a light ghost behind and a dashed outline on top, so it shows whether the home shrank or grew
    if (a != null) planSvg.append('rect').attr('x', x0).attr('y', base - side(a)).attr('width', side(a)).attr('height', side(a))
      .attr('fill', '#eef2f7');
    planSvg.append('rect').attr('x', x0).attr('y', base - side(z)).attr('width', side(z)).attr('height', side(z))
      .attr('fill', theme.depth.deep).attr('fill-opacity', 0.88);
    if (a != null) planSvg.append('rect').attr('x', x0).attr('y', base - side(a)).attr('width', side(a)).attr('height', side(a))
      .attr('fill', 'none').attr('stroke', '#5f6f80').attr('stroke-width', 1.2).attr('stroke-dasharray', '3 2');
    // the change, written inside the filled square when it is big enough
    if (a != null && side(z) >= 28) {
      const d = z / a - 1, txt = Math.abs(d) < 0.03 ? 'same' : `${d > 0 ? '+' : '−'}${Math.round(Math.abs(d) * 100)}%`;
      planSvg.append('text').attr('x', x0 + side(z) / 2).attr('y', base - side(z) / 2 + 4).attr('text-anchor', 'middle')
        .attr('fill', '#ffffff').style('font', `700 10.5px ${theme.font}`).text(txt);
    }
    if (k < K) planSvg.append('rect').attr('x', x0).attr('y', base - side(size)).attr('width', side(size)).attr('height', side(size))
      .attr('fill', 'none').attr('stroke', '#ffffff').attr('stroke-width', 1.2).attr('stroke-dasharray', '1 2');
    const lx = PLAN_TX + 12;
    const line = (y, t, font, fill) => planSvg.append('text').attr('x', lx).attr('y', y).attr('fill', fill).style('font', `${font} ${theme.font}`).text(t);
    if (a != null) line(29, `${Math.round(a)} m² ${aText}`, '600 11px', '#5f6f80');
    line(a != null ? 46 : 33, `${Math.round(z)} m² ${zText}`, '800 12px', theme.depth.deep);
    line(62, where.length > 20 ? where.slice(0, 19) + '…' : where, '500 11px', theme.quiet);
  }
  function drawPlan(s, c) {
    const same = s.thenPeriod === s.period;
    const perM2 = Sp => c ? (charted(Sp.get(c)) ? Sp.get(c).edge / s.size : null) : d3.median(C.set, x => Sp.get(x).edge) / s.size;
    const m2 = Sp => { const v = perM2(Sp); return v ? Math.round(s.budget / v) : null; };
    renderPlan({ a: same ? null : m2(Sthen), aText: `in ${periodLabel(s.thenPeriod)}`, z: m2(S),
      zText: `in ${periodLabel(s.period)}`, where: c ? `in ${shortName(nameOf(c))}` : 'in a typical area' });
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
      showTip(event, `<strong>${nameOf(d.c)}</strong><br>A typical ${cur.size} m² ${homeWord()} here: <strong>${aed(d.e)}</strong> ` +
        `<span style="color:${theme.quiet}">(${periodLabel(cur.period)})</span><br>` +
        (d.e <= cur.budget ? `<strong style="color:${SAND_WORD}">Within your budget</strong>`
          : `<strong style="color:${theme.depth.deep}">${aed(d.e - cur.budget)} more than your budget</strong>`));
    })
      .on('mouseleave', () => { if (cur && cur.hovered) ev.emit('hover', null); hideTip(); })
      .on('click', (event, d) => ev.emit('select', cur.selected === d.c ? null : d.c));
  }

  // Budget line, handle, the two dots (then, now) and the arrow to the budget that reaches as many now
  function placeBudget(b, animate, raw) {
    if (!cur || !C) return;
    const v = raw ?? b, xs = barX(v);
    const t = animate && !reduceMotion ? d3.transition().duration(450).ease(d3.easeCubicOut) : null;
    const go = sel => t ? sel.interrupt().transition(t) : sel.interrupt();
    go(sFill).attr('width', Math.max(0, xs - barX.range()[0]));
    go(knob).attr('transform', `translate(${xs},${trackY})`);
    const label = aed(b);
    sVal.text(label);
    knob.attr('aria-valuenow', b).attr('aria-valuetext', label);
    colourNotches(b);
    drawRings(cur, v, t);
  }

  // The line chart: the home your budget buys each year (m² = budget × m² per AED), one line per price group
  // (cheapest, mid-priced, priciest areas as priced in 2015–17) and a dashed coral line for the clicked
  // neighbourhood. The waterline is the typical home (80 m²): below it, that group's typical neighbourhood
  // is water on the map. Marked live from the data: where each ring went under
  // for good, and the one peak worth naming.
  let ringView = null;
  function drawRings(s, B, t) {
    const { rings } = yearData(s), size = s.size;
    const go = sel => t ? sel.interrupt().transition(t) : sel.interrupt();
    const lastOf = pts => { const P = pts.filter(d => d.v != null); return P.length ? P[P.length - 1] : null; };
    const lines = rings.map((r, i) => {
      const pts = r.ys.map(d => ({ y: d.y, v: d.f == null ? null : d.f * B }));
      return { key: r.key, name: `${r.name} areas`, label: `${r.name} areas`, col: RING_COL[i], text: RING_TEXT[i],
        ring: i, pts, last: lastOf(pts), where: `in ${r.name.toLowerCase()} areas` };
    });
    const c = selectedOf(s);
    let sel = null;
    if (c) {
      const pts = commYearly(s, c).map(d => ({ y: d.y, v: d.f == null ? null : d.f * B }));
      const nm = shortName(nameOf(c));
      if (pts.some(d => d.v != null)) sel = { key: 'sel', name: nm.length > 14 ? nm.slice(0, 13) + '…' : nm, label: nm,
        col: theme.accent, text: theme.accent, ring: null, pts, last: lastOf(pts), where: `in ${nm}` };
    }
    const all = sel ? [...lines, sel] : lines;
    ringView = { lines: all };
    chartHead.html('The home your budget buys, in m²' + (sel ? `<span style="font-weight:600;color:${theme.accent};margin-left:10px">` +
      `<span style="display:inline-block;width:16px;border-top:2.5px dashed ${theme.accent};vertical-align:middle;margin-right:5px"></span>${sel.label}</span>` : ''));

    const vmax = d3.max(all, L => d3.max(L.pts, d => d.v)) || size;
    ym.domain([0, Math.max(size * 1.3, vmax * 1.18)]).nice(4);
    const yt = ym.ticks(4).filter(v => v > 0 && ym(v) > cm.t + 8);   // none right under the "m²" label
    gGrid.selectAll('line').data(yt, v => v).join('line').attr('x1', cm.l).attr('x2', CW - cm.r).attr('stroke', theme.grid)
      .attr('y1', v => ym(v)).attr('y2', v => ym(v));
    gGrid.selectAll('text').data(yt, v => v).join('text').attr('x', cm.l - 6).attr('dy', '0.35em').attr('text-anchor', 'end')
      .attr('fill', theme.quiet).style('font-size', '10.5px').text(v => v).attr('y', v => ym(v));

    bandFor(s.period);
    const wy = ym(size);
    go(sandBg).attr('y', cm.t).attr('height', Math.max(0, wy - cm.t));
    go(seaBg).attr('y', wy).attr('height', Math.max(0, plotB - wy));
    go(waterLine).attr('y1', wy).attr('y2', wy);
    // the waterline's label sits at the left unless a line runs right through it there; then at the right
    // (tries above the line, left / right / middle, then just under it)
    const busy = (years, ty) => all.some(L => L.pts.some(d => years.includes(d.y) && d.v != null && Math.abs(ym(d.v) - (ty - 4)) < 10));
    const spans = [{ ys: YEARS.slice(0, 4), x: cm.l + 5, a: 'start' }, { ys: YEARS.slice(-4), x: CW - cm.r - 5, a: 'end' },
      { ys: YEARS.slice(4, 8), x: yx(YEARS[4]), a: 'start' }];
    const spots = [...spans.map(q => ({ ...q, ty: wy - 5 })), ...spans.map(q => ({ ...q, ty: wy + 14 }))];
    const spot = spots.find(q => !busy(q.ys, q.ty)) || spots[0];
    waterLab.text(`${size} m²: a typical flat`).attr('x', spot.x).attr('text-anchor', spot.a);
    go(waterLab).attr('y', spot.ty);

    gRingLines.selectAll('path').data(lines, L => L.key).join('path').attr('fill', 'none').attr('stroke-linejoin', 'round')
      .attr('stroke-linecap', 'round').attr('stroke', L => L.col).attr('stroke-width', 2.5)
      .call(p => go(p).attr('d', L => lineOf(L.pts)));
    if (sel) { if (!selPath.attr('d')) selPath.attr('d', lineOf(sel.pts)); selPath.attr('opacity', 1); go(selPath).attr('d', lineOf(sel.pts)); }
    else selPath.interrupt().attr('opacity', 0).attr('d', null);

    // went under for good: the last time a ring's line crosses the waterline and stays under to the end,
    // after at least two years in a row above it (a one-year blip above the line is not "went under")
    const unders = [];
    lines.forEach(L => {
      const P = L.pts.filter(d => d.v != null);
      if (!P.length || P[P.length - 1].v >= size) return;
      let j = P.length - 1;
      while (j >= 0 && P[j].v < size) j--;
      if (j < 1 || P[j - 1].v < size) return;            // never (or only briefly) above the line: nothing to mark
      const a = P[j], z = P[j + 1], f = (a.v - size) / (a.v - z.v);
      unders.push({ L, x: yx(a.y + f * (z.y - a.y)), year: z.y });
    });
    gUnder.selectAll('circle').data(unders, d => d.L.key).join('circle').attr('r', 4).attr('stroke', '#ffffff')
      .attr('stroke-width', 1.5).attr('fill', d => d.L.col).attr('cx', d => d.x).attr('cy', wy);
    const below = wy + 30 < plotB;
    // one label, "under in 2025 · 2026", each year in the colour of the line that went under then
    gUnder.selectAll('text').remove();
    if (unders.length) {
      // one entry per year: lines that went under in the same year share it, written in ink
      const us = d3.groups(unders.slice().sort((a, b) => a.x - b.x), u => u.year)
        .map(([year, g]) => ({ year, x: d3.max(g, u => u.x), L: g.length > 1 ? { text: theme.ink } : g[0].L })), parts = ['under in ', ...us.flatMap((u, i) => i ? [' · ', u] : [u])];
      const txt = parts.map(q => typeof q === 'string' ? q : q.year).join(''), w = textW(txt, 10.5, 700);
      const xr = Math.min(CW - cm.r - 2, Math.max(cm.l + w, us[us.length - 1].x + 30));
      // the first height (just under the waterline, then lower in the sea, then above it) where no line
      // runs through the label
      const y0 = yx.invert(xr - w), y1 = yx.invert(xr);
      const clear = ty => !all.some(L => L.pts.some((d, i) => {
        const e = L.pts[i + 1];
        if (d.v == null || !e || e.v == null || e.y < y0 || d.y > y1) return false;
        const lo = Math.min(ym(d.v), ym(e.v)), hi = Math.max(ym(d.v), ym(e.v));
        return hi > ty - 13 && lo < ty + 4;
      }));
      const tries = [wy + 15, wy + 30, wy + 45, plotB - 6, wy - 9].filter(ty => ty > cm.t + 10 && ty < plotB - 2);
      const ty = tries.find(clear) ?? (below ? wy + 15 : wy - 9);
      const t = gUnder.append('text').attr('x', xr).attr('y', ty).attr('text-anchor', 'end')
        .attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3).style('font', `700 10.5px ${theme.font}`);
      parts.forEach(q => t.append('tspan').attr('fill', typeof q === 'string' ? theme.ink : q.L.text).text(typeof q === 'string' ? q : q.year));
    }

    // the one peak worth naming: a ring that rose 10%+ above its start, then lost a quarter or more
    let peak = null;
    lines.forEach(L => {
      const P = L.pts.filter(d => d.v != null);
      if (P.length < 4) return;
      const hi = d3.greatest(P, d => d.v), first = P[0], last = P[P.length - 1];
      if (hi === first || hi === last) return;
      const drop = (hi.v - last.v) / hi.v, rise = (hi.v - first.v) / first.v;
      if (drop >= 0.25 && rise >= 0.1 && (!peak || drop > peak.drop)) peak = { L, d: hi, drop };
    });
    gPeak.selectAll('*').remove();
    if (peak) {
      const px = yx(peak.d.y), py = ym(peak.d.v), txt = `${Math.round(peak.d.v)} m² around ${peak.d.y}`, w = textW(txt, 11, 700);
      gPeak.append('circle').attr('cx', px).attr('cy', py).attr('r', 4).attr('fill', peak.L.col).attr('stroke', '#ffffff').attr('stroke-width', 1.5);
      gPeak.append('text').attr('x', Math.max(cm.l, Math.min(CW - cm.r - w, px - w / 2))).attr('y', py - 9).attr('fill', peak.L.text)
        .attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.5).style('font', `700 11px ${theme.font}`).text(txt);
    }

    // names at the right, spread so they never overlap
    const ends = all.map(L => { const P = L.pts.filter(d => d.v != null), e = P[P.length - 1]; return e && { L, y: ym(e.v), v: e.v }; })
      .filter(Boolean).sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 16) ends[i].y = ends[i - 1].y + 16;
    const over = ends.length ? ends[ends.length - 1].y - (plotB + 4) : 0;
    if (over > 0) ends.forEach(e => { e.y -= over; });
    gEnd.selectAll('text').data(ends, e => e.L.key).join(enter => enter.append('text').attr('y', e => e.y))
      .attr('x', CW - cm.r + 8).attr('dy', '0.35em').attr('fill', e => e.L.text)
      .style('font', e => `${e.L.ring == null ? 700 : 600} 11px ${theme.font}`).style('cursor', 'default')
      .text(e => `${Math.round(e.v)} m²`)
      .on('mouseenter', (event, e) => outlineRing(e.L.ring)).on('mouseleave', () => outlineRing(null))
      .call(p => go(p).attr('y', e => e.y))
      .each(function (e) { d3.select(this).selectAll('title').data([0]).join('title').text(e.L.ring == null ? `${e.L.label}: what your budget buys there now` : `${e.L.label}: ${RINGS[e.L.ring].members.length} of the 27 neighbourhoods, grouped by their 2015–17 price`); });
  }

  // The period buttons show the typical 80 m² price in each period (the clicked neighbourhood's, or the
  // middle one's); the clicked neighbourhood also gets its own line in the line chart.
  const selectedOf = s => s && s.selected && byComm.has(s.selected) && charted(S.get(s.selected)) ? s.selected : null;
  function drawTrace(s) {
    if (!s || !C || !periodsInfo.length) return;
    const c = selectedOf(s);
    const pts = periodsInfo.map(d => {
      if (c) { const st = d.Sp.get(c); return { p: d.p, e: charted(st) ? st.edge : null }; }
      return { p: d.p, e: d.edges[Math.ceil(d.edges.length / 2) - 1] };
    });
    drawRings(s, s.budget, null);

    drawPlan(s, c);

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
      bEl.append('div').attr('class', 'pr').style('font-weight', 700).style('font-variant-numeric', 'tabular-nums').style('margin-top', '3px');
      return bEl;
    })
      .attr('aria-pressed', d => String(d.p === s.period))
      .attr('title', d => d.p === s.period ? 'This period is on the map' : `Show ${periodLabel(d.p)} on the map`)
      .style('background-color', d => d.p === s.period ? theme.ink : '#eef1f5')
      .style('color', d => d.p === s.period ? '#ffffff' : theme.ink)
      .style('box-shadow', d => d.p === s.period ? '0 1px 4px rgba(15,30,50,0.18)' : 'none')
      .on('click', (event, d) => { endPreview(); if (d.p !== cur.period) ev.emit('period', d.p); })
      .on('mouseenter', (event, d) => {
        const pi = periodsInfo.find(x => x.p === d.p);
        if (!pi || d.p === cur.period) return;
        preview(pi.Sp);
        bandFor(d.p);
      })
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
  let io = null;
  if (surface && 'IntersectionObserver' in window) (io = new IntersectionObserver(es => {
    visible = es[es.length - 1].isIntersecting; if (visible) wake();
  })).observe(mapBox.node());

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
  // Before the map, the reader draws what happened to one fixed budget: 1 million AED, a typical
  // 80 m² apartment, the same 27 neighbourhoods. The 2015–17 point is given; they draw the rest.
  // Most people draw a steady fall. The data says the opposite first: homes got cheaper until 2020,
  // so the budget reached MORE neighbourhoods (15 → 19), and then 14 went under in one period (→ 3).
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
  // The reader's own line is raspberry: apart from the sand, the sea, and the orange of a selection.
  // The label is the loudest line until the guess is made; then it folds away with the instruction.
  const GUESS = '#d6336c';
  const M = d3.format('~g')(G.budget / 1e6);
  const fold = sel => sel.style('overflow', 'hidden').style('transition', 'max-height .5s, opacity .35s, margin .5s');
  const tag = fold(gx.append('div')).style('max-height', '28px').style('font', `800 15px ${theme.font}`)
    .style('letter-spacing', '0.1em').style('text-transform', 'uppercase').style('color', GUESS)
    .html(`<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${GUESS};` +
      `margin-right:8px;vertical-align:1px"></span>Before the map: make a guess`);
  const gHead = gx.append('div').style('font', `800 22px/1.2 ${theme.font}`)
    .text(`In how many neighbourhoods can ${M}\u00a0million\u00a0AED buy a typical apartment?`);
  const gLede = gx.append('div').style('font-size', `${theme.size.label + 1}px`).style('line-height', '1.45').style('color', theme.ink)
    .html(`In ${periodLabel(P[0])}: <strong>${truth[0]}&nbsp;of the&nbsp;${gn}</strong> main neighbourhoods, where a typical ` +
      `${G.size}&nbsp;m² apartment cost ${M}&nbsp;million&nbsp;AED or less.`);
  const task = fold(gx.append('div')).style('max-height', '48px').style('font', `700 ${theme.size.label + 1}px/1.45 ${theme.font}`)
    .style('color', GUESS).text(`Draw your guess up to ${periodLabel(P[L])}.`);

  // Nothing in this column may shrink (a squeezed line gets clipped), so the chart takes what is left.
  // On a short screen the words get a little smaller first, so the chart keeps room to draw in.
  gx.selectAll(':scope > div').style('flex', 'none');
  const measureTop = () => d3.sum(gx.selectAll(':scope > div').nodes(), n => n.getBoundingClientRect().height) + 3 * 8 || 140;
  let usedTop = measureTop();
  const room = () => panelH - usedTop - 80 - 44 - 8 * 4;
  if (room() < 220) {
    tag.style('font-size', '13px'); gHead.style('font-size', '19px');
    gLede.style('font-size', `${theme.size.label}px`); task.style('font-size', `${theme.size.label}px`);
    usedTop = measureTop();
  }
  const GW = panelW, GH = Math.max(150, Math.min(400, room()));
  const gm = { l: 28, r: 46, t: 26, b: 30 };
  const gsvg = gx.append('svg').attr('width', GW).attr('height', GH).style('display', 'block').style('flex', 'none')
    .style('touch-action', 'none').style('overflow', 'visible').style('user-select', 'none');
  const gX = d3.scalePoint().domain(P).range([gm.l + 16, GW - gm.r]);
  const gY = d3.scaleLinear().domain([0, gn]).range([GH - gm.b, gm.t]);
  const xy = (i, v) => [gX(P[i]), gY(v)];
  const gyt = gY.ticks(3).filter(Number.isInteger);
  gsvg.append('g').selectAll('line').data(gyt).join('line').attr('x1', gm.l).attr('x2', GW - gm.r + 14)
    .attr('y1', v => gY(v)).attr('y2', v => gY(v)).attr('stroke', theme.grid);
  gsvg.append('g').selectAll('text').data(gyt).join('text').attr('x', gm.l - 6).attr('y', v => gY(v)).attr('dy', '0.35em')
    .attr('text-anchor', 'end').attr('fill', theme.quiet).style('font-size', '10.5px').text(v => v);
  gsvg.append('text').attr('x', 0).attr('y', gm.t - 14).attr('fill', theme.quiet).style('font-size', '10.5px')
    .text(`neighbourhoods (of ${gn})`);
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
  const guessPath = gsvg.append('path').attr('fill', 'none').attr('stroke', GUESS).attr('stroke-width', 2.8)
    .attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round').attr('pointer-events', 'none');
  const gGuessDots = gsvg.append('g').attr('pointer-events', 'none');
  const gGuessLabs = gsvg.append('g').attr('pointer-events', 'none');   // every drawn point keeps its number
  const liveLabel = gsvg.append('text').attr('fill', GUESS).attr('paint-order', 'stroke').attr('stroke', '#ffffff')
    .attr('stroke-width', 3.5).style('font', `700 12px ${theme.font}`).attr('pointer-events', 'none');
  const gKey = gsvg.append('g').attr('pointer-events', 'none').attr('opacity', 0);
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

  const result = gx.append('div').style('flex', 'none').style('min-height', '64px').style('opacity', 0).style('transition', 'opacity .5s')
    .style('font-size', `${theme.size.label + 1}px`).style('line-height', '1.45').attr('aria-live', 'polite');
  const row = gx.append('div').style('flex', 'none').style('display', 'flex').style('align-items', 'center').style('gap', '16px');
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
  // The stroke can start anywhere from the given point on.
  const guessV = P.map((p, i) => i === 0 ? truth[0] : null);
  let lastI = null;
  const drawn = () => { let k = 0; while (k < L && guessV[k + 1] != null) k++; return k; };
  function renderGuess(active) {
    const k = drawn();
    const pts = d3.range(k + 1).map(i => xy(i, guessV[i]));
    guessPath.attr('d', k ? d3.line()(pts) : null);
    gGuessDots.selectAll('circle').data(pts.slice(1)).join('circle').attr('r', 4.5).attr('fill', GUESS)
      .attr('stroke', '#ffffff').attr('stroke-width', 1.5).attr('cx', d => d[0]).attr('cy', d => d[1]);
    // the number above each drawn point, so the guess can be read after letting go (bolder while drawing it)
    gGuessLabs.selectAll('text').data(d3.range(1, k + 1)).join('text').attr('text-anchor', 'middle').attr('fill', GUESS)
      .attr('paint-order', 'stroke').attr('stroke', '#ffffff').attr('stroke-width', 3.5).attr('stroke-linejoin', 'round')
      .style('font', i => `${i === active ? 800 : 700} ${i === active ? 13 : 12}px ${theme.font}`)
      .attr('x', i => xy(i, guessV[i])[0]).attr('y', i => xy(i, guessV[i])[1] - 10).text(i => guessV[i]);
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
  const gHit = gsvg.append('rect').attr('x', gm.l).attr('y', 0).attr('width', GW - gm.l).attr('height', GH)
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
    [tag, task].forEach(el => el.style('max-height', '0px').style('opacity', 0).style('margin-bottom', '-8px'));
    styleGo(false); goBtn.text('…');
    skipBtn.style('visibility', 'hidden');
    mapCol.style('opacity', 1);
    gKey.attr('transform', `translate(${GW - gm.r + 22},${gm.t - 14})`);
    [['your guess', GUESS, 0], ['what happened', theme.depth.deep, 1]].forEach(([t, c, k]) => {
      const g = gKey.append('g').attr('transform', `translate(0,${k * 15})`);
      g.append('circle').attr('cx', -6).attr('cy', -3.5).attr('r', 4).attr('fill', c);
      g.append('text').attr('x', -14).attr('text-anchor', 'end').attr('fill', c).style('font', `700 11px ${theme.font}`).text(t);
    });
    gKey.transition().duration(400).attr('opacity', 1);
    const SEG = reduceMotion ? 0 : 1300, DRAW = SEG * 0.8;
    const labelAt = i => {      // the real number, on the side away from the guess
      const [x, y] = xy(i, truth[i]), below = guessV[i] > truth[i];
      gGuessLabs.selectAll('text').filter(j => j === i).transition().duration(SEG ? 250 : 0)
        .attr('opacity', guessV[i] === truth[i] ? 0 : 1).attr('y', xy(i, guessV[i])[1] + (guessV[i] < truth[i] ? 19 : -10));
      gTruth.append('text').attr('x', x).attr('y', below ? y + 19 : y - 11).attr('text-anchor', 'middle')
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
    // The answer repeats the question's own terms: the budget, the home, the period, the count and out of how many
    const g = guessV[L], r = truth[L], when = periodLabel(P[L]);
    const answer = `In ${when}, ${M}&nbsp;million&nbsp;AED buys a typical ${G.size}&nbsp;m² apartment in ` +
      `<span style="color:${theme.depth.deep}">${r < truth[0] ? 'just ' : ''}${r} of the ${gn}</span> neighbourhoods.`;
    const yours = g === r ? `<span style="color:${GUESS}">You guessed ${g}: spot on.</span>`
      : `<span style="color:${GUESS}">You guessed ${g}.</span>`;
    result.html(`<div style="font-weight:800;font-size:16.5px;line-height:1.35">${answer}</div>` +
      `<div style="font-weight:700;margin-top:4px">${yours}</div>`).style('opacity', 1);
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
    // still on the guess (drawing, or reading the answer)
    get guessing() { return phase !== 'off'; },
    // before the page lays the view out again at a new size: stop its loop, listeners and water surface
    destroy() {
      d3.select(window).on(keyNs, null);
      visible = false; if (raf) cancelAnimationFrame(raf); raf = null;
      if (io) io.disconnect();
      clearTimeout(maskTimer);
      if (surface) { const gl = surface.canvas.getContext('webgl'), lose = gl && gl.getExtension('WEBGL_lose_context'); if (lose) lose.loseContext(); }
    },
    // for recording demos at a steady frame rate: replace the clock (null restores real time)
    _setClock: fn => { clock = fn; },
    // for tests and the referee script: the numbers this view shows
    _debug: s => ({ comparable: reach(s), rooms: ROOM_SIZES.map(d => `${d.w}: ${Math.round(d.m2)} m²`),
      rings: yearData(s).rings.map(r => ({ name: r.name, km: r.desc, members: r.members.map(c => shortName(nameOf(c))),
        m2: r.ys.map(d => d.f == null ? null : Math.round(d.f * s.budget)), n: r.ys.map(d => d.n) })),
      guess: { phase, truth, drawn: guessV.slice(), underLast, typical: typicalG } })
  };
}
