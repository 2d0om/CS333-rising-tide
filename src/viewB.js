// src/viewB.js — View B, "The Sea" (Member 2)
// Sand is where your budget reaches; the deeper the water, the fewer homes you could buy.
// Contract: createViewB(container, data, theme, { width, height }) -> { update(state), on(event, handler) }
// Emits: select, pin, hover, mode, thenPeriod, period.
import { emitter } from './emitter.js';
import * as R from './rules.js';
import { createFilmstrip } from './filmstrip.js';

const PERIOD_KEYS = Object.keys(R.PERIODS);
const periodLabel = p => p.replace('-', '–');
const fmt = d3.format(',.0f');
const pctFmt = d3.format('.0%');
const titleCase = s => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const MODE_LABEL = { all: 'All homes', offplan: 'Off-plan only', ready: 'Ready only' };
const DEPTH_TEXT = {
  dry: 'Dry sand: 90%+ of homes within budget',
  wet: 'Wet sand: 50–90% within budget',
  shallow: 'Shallow water: 10–50% within budget',
  deep: 'Deep water: under 10% within budget'
};

// GeoJSON from the course may wind rings the "wrong" way for d3 (which then fills the whole globe).
function rewound(f) {
  const g = { type: 'Feature', properties: f.properties,
    geometry: { type: f.geometry.type, coordinates: f.geometry.coordinates.map(ring => ring.slice()) } };
  if (d3.geoArea(g) > 2 * Math.PI) g.geometry.coordinates = g.geometry.coordinates.map(ring => ring.reverse());
  return g;
}

export function createViewB(container, data, theme, { width, height }) {
  const ev = emitter();
  const root = d3.select(container).style('position', 'relative').style('font-family', theme.font)
    .style('color', theme.ink);
  root.selectAll('*').remove();

  // ---------- data preparation (once) ----------
  const features = data.geo.features.map(rewound);
  const byComm = new Map(features.map(f => [String(f.properties.COMM_NUM), f]));
  const pop = c => +(byComm.get(c)?.properties['Population 2019'] || 0);
  const nameOf = c => titleCase(byComm.get(c)?.properties.CNAME_E || `Community ${c}`);

  const homeSales = data.rows
    .filter(r => r.trans_group_en === 'Sales' && (r.property_type_en === 'Unit' || r.property_type_en === 'Villa'))
    .map(r => ({ r, comm: r.comm_num, period: R.periodOf(r) }));

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
  function statsFor(period, s) {           // Map comm -> { n, p10, p50, p90, shareWithin }
    const thr = s.budget / s.size;
    const out = new Map();
    for (const [comm, a] of pricesBy(period, s)) {
      out.set(comm, {
        n: a.length,
        p10: d3.quantileSorted(a, 0.1), p50: d3.quantileSorted(a, 0.5), p90: d3.quantileSorted(a, 0.9),
        shareWithin: d3.bisectRight(a, thr) / a.length
      });
    }
    return out;
  }
  const isLand = st => !!st && st.n >= R.MIN_SALES && st.shareWithin >= 0.5;
  const classOf = st => !st ? 'none' : st.n < R.MIN_SALES ? 'fog' : R.depth(st.shareWithin);

  function comparable(S1, S2) {            // like-for-like shares between two periods
    const both = [...S2.keys()].filter(c => S2.get(c).n >= R.MIN_SALES && (S1.get(c)?.n || 0) >= R.MIN_SALES);
    const land = S => both.filter(c => isLand(S.get(c)));
    const popAll = d3.sum(both, pop);
    return {
      n: both.length,
      land1: both.length ? land(S1).length / both.length : NaN,
      land2: both.length ? land(S2).length / both.length : NaN,
      res1: popAll ? d3.sum(land(S1), pop) / popAll : NaN,
      res2: popAll ? d3.sum(land(S2), pop) / popAll : NaN
    };
  }
  const chartedShare = S => {              // share of charted communities on land, one period
    const charted = [...S.values()].filter(st => st.n >= R.MIN_SALES);
    return charted.length ? charted.filter(isLand).length / charted.length : NaN;
  };

  // Frame the map on the communities that ever have enough apartment sales.
  const base = { mode: 'all', homeType: 'apartment', money: 'nominal', dropExtremes: false };
  const chartedIn = p => new Set([...pricesBy(p, base)].filter(([, a]) => a.length >= R.MIN_SALES).map(([c]) => c));
  const first = chartedIn(PERIOD_KEYS[0]), last = chartedIn(PERIOD_KEYS[PERIOD_KEYS.length - 1]);
  const frameFeatures = features.filter(f => first.has(String(f.properties.COMM_NUM)) && last.has(String(f.properties.COMM_NUM)));

  const topo = topojson.topology({ c: { type: 'FeatureCollection', features } });
  const commOf = g => String(g.properties.COMM_NUM);
  const coastFor = S => topojson.mesh(topo, topo.objects.c,
    (a, b) => a !== b && isLand(S.get(commOf(a))) !== isLand(S.get(commOf(b))));

  const stations = data.metro.features.map(f => ({ name: f.properties.STATION_NAME, coords: f.geometry.coordinates }));

  // ---------- layout ----------
  const toolbarH = 44, stripH = 150, gap = 10;
  const mapH = Math.max(320, height - toolbarH - stripH - gap * 2);

  const toolbar = root.append('div')
    .style('display', 'flex').style('align-items', 'center').style('justify-content', 'space-between')
    .style('gap', '12px').style('height', `${toolbarH}px`).style('flex-wrap', 'wrap');
  const modeGroup = toolbar.append('div').attr('role', 'group').attr('aria-label', 'Which homes')
    .style('display', 'flex').style('gap', '6px');
  const readout = toolbar.append('div').style('font-size', `${theme.size.small}px`).style('color', theme.quiet);

  const modeButtons = modeGroup.selectAll('button').data(['all', 'offplan', 'ready']).join('button')
    .attr('type', 'button').text(d => MODE_LABEL[d])
    .style('font', `600 ${theme.size.small}px ${theme.font}`).style('padding', '6px 12px')
    .style('border-radius', '8px').style('cursor', 'pointer');

  const svg = root.append('svg').attr('width', width).attr('height', mapH)
    .attr('viewBox', `0 0 ${width} ${mapH}`).attr('role', 'img')
    .attr('aria-label', 'Map of Dubai communities: sand where your budget reaches, water where it does not')
    .style('display', 'block').style('margin-top', `${gap}px`);

  const projection = d3.geoMercator().fitExtent([[16, 16], [width - 16, mapH - 16]],
    { type: 'FeatureCollection', features: frameFeatures });
  const path = d3.geoPath(projection);

  const defs = svg.append('defs');
  const hatch = defs.append('pattern').attr('id', 'vb-fog').attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 6).attr('height', 6).attr('patternTransform', 'rotate(45)');
  hatch.append('rect').attr('width', 6).attr('height', 6).attr('fill', '#ffffff');
  hatch.append('line').attr('x1', 0).attr('y1', 0).attr('x2', 0).attr('y2', 6)
    .attr('stroke', theme.fog).attr('stroke-width', 2.2);

  const noSales = '#f7f7f7';   // neutral, never sand: no sales must not read as affordable
  const fillOf = cls => cls === 'fog' ? 'url(#vb-fog)' : cls === 'none' ? noSales : theme.depth[cls];

  svg.append('rect').attr('width', width).attr('height', mapH).attr('fill', theme.realSea);
  const gulf = projection([55.03, 25.24]);
  svg.append('text').attr('x', gulf[0]).attr('y', gulf[1]).attr('text-anchor', 'middle')
    .attr('fill', theme.quiet).style('font-size', `${theme.size.small}px`).style('font-style', 'italic')
    .text('Arabian Gulf (the real sea)');

  const gComm = svg.append('g');
  const gTide = svg.append('g');
  const previewPath = svg.append('path').attr('fill', 'none').attr('stroke', theme.coastline)
    .attr('stroke-width', 1.6).attr('stroke-dasharray', '5 4').attr('opacity', 0).attr('pointer-events', 'none');
  const coastPath = svg.append('path').attr('fill', 'none').attr('stroke', theme.coastline)
    .attr('stroke-width', 2.2).attr('stroke-linejoin', 'round').attr('pointer-events', 'none');
  const gStations = svg.append('g').attr('pointer-events', 'none');
  const gMarks = svg.append('g').attr('pointer-events', 'none');

  const commPaths = gComm.selectAll('path').data(features, f => f.properties.COMM_NUM).join('path')
    .attr('d', path).attr('stroke', '#ffffff').attr('stroke-width', 0.5).attr('fill', noSales)
    .style('cursor', 'pointer');

  gStations.selectAll('circle').data(stations.filter(s => {
    const [x, y] = projection(s.coords); return x >= 0 && x <= width && y >= 0 && y <= mapH;
  })).join('circle')
    .attr('cx', d => projection(d.coords)[0]).attr('cy', d => projection(d.coords)[1])
    .attr('r', 2.4).attr('fill', theme.ink).attr('fill-opacity', 0.75).attr('stroke', '#ffffff').attr('stroke-width', 0.8);

  // Legend (bottom-left of the map)
  const legendItems = [['dry'], ['wet'], ['shallow'], ['deep'], ['fog', 'Fog: under 20 sales, too few to trust'],
    ['none', 'No apartment sales in this period']];
  const legend = svg.append('g').attr('transform', `translate(16, ${mapH - 16 - legendItems.length * 17 - 44})`);
  legend.append('rect').attr('x', -8).attr('y', -10).attr('width', 268).attr('height', legendItems.length * 17 + 52)
    .attr('rx', 8).attr('fill', '#ffffff').attr('fill-opacity', 0.92);
  legendItems.forEach(([cls, label], i) => {
    const row = legend.append('g').attr('transform', `translate(0, ${i * 17})`);
    row.append('rect').attr('width', 12).attr('height', 12).attr('y', -1).attr('rx', 2)
      .attr('fill', fillOf(cls)).attr('stroke', theme.grid);
    row.append('text').attr('x', 18).attr('y', 9).attr('fill', theme.ink)
      .style('font-size', `${theme.size.small}px`).text(label || DEPTH_TEXT[cls]);
  });
  const ly = legendItems.length * 17;
  legend.append('line').attr('x1', 0).attr('x2', 12).attr('y1', ly + 5).attr('y2', ly + 5)
    .attr('stroke', theme.coastline).attr('stroke-width', 2.2);
  legend.append('text').attr('x', 18).attr('y', ly + 9).style('font-size', `${theme.size.small}px`).attr('fill', theme.ink)
    .text('Coastline: the typical home costs your budget');
  legend.append('text').attr('x', 0).attr('y', ly + 28).style('font-size', `${theme.size.small}px`)
    .style('font-style', 'italic').attr('fill', theme.quiet).text('Water = price out of reach, not flooding.');

  // Tooltip
  const tip = root.append('div').style('position', 'absolute').style('pointer-events', 'none')
    .style('background', '#ffffff').style('border', `1px solid ${theme.grid}`).style('border-radius', '8px')
    .style('padding', '8px 10px').style('font-size', `${theme.size.small}px`).style('line-height', '1.45')
    .style('box-shadow', '0 2px 8px rgba(0,0,0,0.08)').style('max-width', '260px').style('opacity', 0);
  function showTip(event, html) {
    const [x, y] = d3.pointer(event, container);
    tip.html(html).style('opacity', 1)
      .style('left', `${Math.min(x + 14, width - 270)}px`).style('top', `${y + 14}px`);
  }
  const hideTip = () => tip.style('opacity', 0);

  // Film strip (small multiples, one mini-map per period)
  const strip = createFilmstrip(root.append('div').style('margin-top', `${gap}px`).node(),
    frameFeatures, features, theme, { width, height: stripH }, fillOf, classOf, p => ev.emit('period', p));

  // ---------- state-driven drawing ----------
  let prev = null, cur = null, S = new Map();

  function tipForCommunity(c) {
    const st = S.get(c);
    const head = `<strong>${nameOf(c)}</strong><br>`;
    if (!st) return `${head}No ${cur.homeType === 'villa' ? 'villa' : 'apartment'} sales in ${periodLabel(cur.period)}.`;
    if (st.n < R.MIN_SALES) return `${head}${st.n} sale${st.n === 1 ? '' : 's'} in ${periodLabel(cur.period)} — too few to trust.`;
    return `${head}${fmt(st.n)} sales in ${periodLabel(cur.period)}<br>` +
      `Typical price: AED ${fmt(st.p50)}/m²<br>` +
      `Within your budget: ${pctFmt(st.shareWithin)} of sales<br>` +
      `<span style="color:${theme.quiet}">${DEPTH_TEXT[R.depth(st.shareWithin)]}</span>`;
  }

  commPaths
    .on('mousemove', (event, f) => {
      const c = String(f.properties.COMM_NUM);
      if (cur && cur.hovered !== c) ev.emit('hover', c);
      showTip(event, tipForCommunity(c));
    })
    .on('mouseleave', () => { ev.emit('hover', null); hideTip(); })
    .on('click', (event, f) => {
      const c = String(f.properties.COMM_NUM);
      if (event.shiftKey) ev.emit('pin', c);
      else ev.emit('select', cur && cur.selected === c ? null : c);
    });

  modeButtons
    .on('click', (event, m) => ev.emit('mode', m))
    .on('mouseenter', (event, m) => {
      if (!cur || m === cur.mode) return;
      previewPath.attr('d', path(coastFor(statsFor(cur.period, { ...cur, mode: m })))).attr('opacity', 0.9);
    })
    .on('mouseleave', () => previewPath.attr('opacity', 0));

  function drawData(s) {
    S = statsFor(s.period, s);
    commPaths.transition().duration(500).attr('fill', f => fillOf(classOf(S.get(String(f.properties.COMM_NUM)))));
    coastPath.transition().duration(500).attr('d', path(coastFor(S)));

    // Tide marks: coastlines of earlier periods
    const earlier = PERIOD_KEYS.slice(0, PERIOD_KEYS.indexOf(s.period));
    const tides = earlier.map(p => {
      const Sp = statsFor(p, s);
      return { p, d: path(coastFor(Sp)), share: chartedShare(Sp) };
    });
    const tg = gTide.selectAll('g').data(tides, t => t.p).join(enter => {
      const g = enter.append('g').style('cursor', 'pointer');
      g.append('path').attr('class', 'tide-line').attr('fill', 'none').attr('stroke', theme.depth.deep)
        .attr('stroke-width', 1.2).attr('stroke-opacity', 0.35);
      g.append('path').attr('class', 'tide-hit').attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 9);
      return g;
    });
    tg.select('.tide-line').attr('d', t => t.d);
    tg.select('.tide-hit').attr('d', t => t.d)
      .on('mousemove', (event, t) => showTip(event,
        `<strong>${periodLabel(t.p)} coastline</strong><br>${pctFmt(t.share)} of charted communities were land.<br>` +
        `<span style="color:${theme.quiet}">Click to compare against ${periodLabel(t.p)}.</span>`))
      .on('mouseleave', hideTip)
      .on('click', (event, t) => ev.emit('thenPeriod', t.p));

    const Sthen = statsFor(s.thenPeriod, s);
    const c = comparable(Sthen, S);
    readout.html(s.thenPeriod === s.period
      ? `${MODE_LABEL[s.mode]} · ${periodLabel(s.period)} · ${pctFmt(chartedShare(S))} of charted communities are land`
      : `${MODE_LABEL[s.mode]} · comparable communities on land: <strong>${pctFmt(c.land1)}</strong> (${periodLabel(s.thenPeriod)}) → ` +
        `<strong>${pctFmt(c.land2)}</strong> (${periodLabel(s.period)}) · ${c.n} communities`);

    strip.update(PERIOD_KEYS.map(p => {
      const Sp = statsFor(p, s);
      return { p, S: Sp, coast: coastFor(Sp), share: chartedShare(Sp) };
    }), s.period);
  }

  function drawMarks(s) {
    modeButtons
      .attr('aria-pressed', d => String(d === s.mode))
      .style('background', d => d === s.mode ? theme.ink : '#ffffff')
      .style('color', d => d === s.mode ? '#ffffff' : theme.ink)
      .style('border', d => `1px solid ${d === s.mode ? theme.ink : theme.grid}`);

    const fogHighlight = s.highlight === 'fog';
    commPaths
      .attr('stroke', f => fogHighlight && classOf(S.get(String(f.properties.COMM_NUM))) === 'fog' ? theme.accent : '#ffffff')
      .attr('stroke-width', f => fogHighlight && classOf(S.get(String(f.properties.COMM_NUM))) === 'fog' ? 1.5 : 0.5);

    const marks = [];
    (s.pinned || []).forEach(c => marks.push({ c, kind: 'pinned' }));
    if (s.hovered) marks.push({ c: s.hovered, kind: 'hovered' });
    if (s.selected) marks.push({ c: s.selected, kind: 'selected' });
    gMarks.selectAll('path').data(marks.filter(m => byComm.has(m.c)), m => m.kind + m.c).join('path')
      .attr('d', m => path(byComm.get(m.c))).attr('fill', 'none')
      .attr('stroke', m => m.kind === 'hovered' ? theme.ink : theme.accent)
      .attr('stroke-width', m => m.kind === 'selected' ? 2.6 : m.kind === 'hovered' ? 1.6 : 1.8)
      .attr('stroke-dasharray', m => m.kind === 'pinned' ? '4 3' : null);
    gMarks.selectAll('text').data(marks.filter(m => m.kind !== 'hovered' && byComm.has(m.c)), m => m.kind + m.c)
      .join('text')
      .attr('x', m => path.centroid(byComm.get(m.c))[0]).attr('y', m => path.centroid(byComm.get(m.c))[1] - 8)
      .attr('text-anchor', 'middle').attr('fill', theme.ink).attr('paint-order', 'stroke')
      .attr('stroke', '#ffffff').attr('stroke-width', 3)
      .style('font', `600 ${theme.size.small}px ${theme.font}`).text(m => nameOf(m.c));

    strip.mark(s);
  }

  const DATA_KEYS = ['period', 'thenPeriod', 'mode', 'homeType', 'money', 'dropExtremes', 'budget', 'size'];
  return {
    update(s) {
      cur = s;
      const dataChanged = !prev || DATA_KEYS.some(k => prev[k] !== s[k]);
      if (dataChanged) drawData(s);
      if (dataChanged || prev.selected !== s.selected || prev.hovered !== s.hovered ||
          (prev.pinned || []).join() !== (s.pinned || []).join() || prev.highlight !== s.highlight) drawMarks(s);
      prev = s;
    },
    on: ev.on,
    // for tests and the referee script: the numbers this view shows
    _debug: s => ({ comparable: comparable(statsFor(s.thenPeriod, s), statsFor(s.period, s)),
      charted: chartedShare(statsFor(s.period, s)) })
  };
}
