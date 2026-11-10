// src/viewB.js — View B, "The Sea" (Member 2)
// Sand is where your budget reaches; the deeper the water, the fewer homes you could buy.
// Contract: createViewB(container, data, theme, { width, height }) -> { update(state), on(event, handler) }
// Emits: select, pin, hover, mode, thenPeriod, period, budget.
import { emitter } from './emitter.js';
import * as R from './rules.js';
import { createFilmstrip } from './filmstrip.js';

const PERIOD_KEYS = Object.keys(R.PERIODS);
const periodLabel = p => p.replace('-', '–');
const fmt = d3.format(',.0f');
const pctFmt = d3.format('.0%');
const aed = v => v >= 1e6 ? `AED ${d3.format('.2~f')(v / 1e6)}M` : `AED ${d3.format(',.0f')(v / 1e3)}k`;
const titleCase = s => s.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
const MODE_LABEL = { all: 'All homes', offplan: 'Off-plan only', ready: 'Ready only' };
const DEPTH_TEXT = {
  dry: 'Dry sand: 90%+ of homes within budget',
  wet: 'Wet sand: 50–90% within budget',
  shallow: 'Shallow water: 10–50% within budget',
  deep: 'Deep water: under 10% within budget'
};
const BUDGET_MIN = 300000, BUDGET_MAX = 6000000;   // slider range, log scale

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
  const charted = st => !!st && st.n >= R.MIN_SALES;
  const isLand = st => charted(st) && st.shareWithin >= 0.5;

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
  const chartedShare = S => {              // share of charted communities on land, one period
    const c = [...S.values()].filter(charted);
    return c.length ? c.filter(isLand).length / c.length : NaN;
  };

  // Frame the map on the communities that can be compared over time (charted in the first and last period).
  const base = { mode: 'all', homeType: 'apartment', money: 'nominal', dropExtremes: false };
  const chartedIn = p => new Set([...pricesBy(p, base)].filter(([, a]) => a.length >= R.MIN_SALES).map(([c]) => c));
  const first = chartedIn(PERIOD_KEYS[0]), last = chartedIn(PERIOD_KEYS[PERIOD_KEYS.length - 1]);
  const frameFeatures = features.filter(f => first.has(commOfF(f)) && last.has(commOfF(f)));

  const topo = topojson.topology({ c: { type: 'FeatureCollection', features } });
  const commOf = g => String(g.properties.COMM_NUM);
  const coastFor = S => topojson.mesh(topo, topo.objects.c,
    (a, b) => a !== b && isLand(S.get(commOf(a))) !== isLand(S.get(commOf(b))));

  const stations = data.metro.features.map(f => ({ name: f.properties.STATION_NAME, coords: f.geometry.coordinates }));

  // ---------- encoding ----------
  // Continuous depth = share of homes OUT of reach. Sand darkens from 0% to 50%; at 50% the
  // coastline is crossed and water deepens to 100%. The break at 50% is the coastline itself.
  const noSales = '#f7f7f7';   // neutral, never sand: no sales must not read as affordable
  const sandRamp = d3.interpolateLab(theme.depth.dry, theme.depth.wet);
  const waterRamp = d3.interpolateLab(theme.depth.shallow, theme.depth.deep);
  const outOf = st => 1 - st.shareWithin;
  const depthColor = out => out < 0.5 ? sandRamp(out / 0.5) : waterRamp((out - 0.5) / 0.5);
  const paint = st => !st ? noSales : !charted(st) ? 'url(#vb-fog)' : depthColor(outOf(st));
  const rippleOpacity = st => charted(st) && outOf(st) >= 0.5 ? 0.25 + 0.5 * (outOf(st) - 0.5) / 0.5 : 0;

  // ---------- layout ----------
  const toolbarH = 76, keyH = 40, stripH = 150, gap = 10;
  const mapH = Math.max(320, height - toolbarH - keyH - stripH - gap * 3);

  const toolbar = root.append('div').style('height', `${toolbarH}px`)
    .style('display', 'grid').style('grid-template-columns', 'auto 1fr').style('row-gap', '8px')
    .style('column-gap', '18px').style('align-items', 'center');
  const modeGroup = toolbar.append('div').attr('role', 'group').attr('aria-label', 'Which homes')
    .style('display', 'flex').style('gap', '6px');
  const budgetBox = toolbar.append('label').style('display', 'flex').style('align-items', 'center')
    .style('gap', '10px').style('font-size', `${theme.size.small}px`);
  const readout = toolbar.append('div').style('grid-column', '1 / -1')
    .style('font-size', `${theme.size.label}px`).style('color', theme.quiet);

  const modeButtons = modeGroup.selectAll('button').data(['all', 'offplan', 'ready']).join('button')
    .attr('type', 'button').text(d => MODE_LABEL[d])
    .style('font', `600 ${theme.size.small}px ${theme.font}`).style('padding', '6px 12px')
    .style('border-radius', '8px').style('cursor', 'pointer');

  // Budget slider (log scale): drag it and watch the sea retreat or take over
  const toSlider = d3.scaleLog().domain([BUDGET_MIN, BUDGET_MAX]).range([0, 1000]).clamp(true);
  budgetBox.append('span').style('font-weight', 600).text('Your budget');
  const slider = budgetBox.append('input').attr('type', 'range').attr('min', 0).attr('max', 1000).attr('step', 1)
    .attr('aria-label', 'Your budget in AED').style('flex', '1').style('accent-color', theme.depth.deep);
  const budgetText = budgetBox.append('span').style('min-width', '230px').style('color', theme.quiet);

  // Key: a continuous scale with the named zones as ticks, above the map so it never covers it
  const fogBg = `repeating-linear-gradient(45deg, ${theme.fog} 0 2px, #ffffff 2px 5px)`;
  const swatch = bg => `<span style="display:inline-block;width:12px;height:12px;border-radius:2px;` +
    `border:1px solid ${theme.grid};background:${bg};vertical-align:-2px;margin-right:4px"></span>`;
  const key = root.append('div').style('display', 'flex').style('flex-wrap', 'wrap').style('align-items', 'center')
    .style('gap', '4px 16px').style('margin-top', `${gap}px`).style('min-height', `${keyH}px`)
    .style('font-size', `${theme.size.small}px`);
  const kw = 300, kh = 12;
  const keySvg = key.append('svg').attr('width', kw + 20).attr('height', 34).attr('aria-hidden', true);
  const kg = keySvg.append('defs').append('linearGradient').attr('id', 'vb-key');
  [[0, theme.depth.dry], [0.5, theme.depth.wet], [0.5, theme.depth.shallow], [1, theme.depth.deep]]
    .forEach(([o, c]) => kg.append('stop').attr('offset', o).attr('stop-color', c));
  keySvg.append('rect').attr('x', 10).attr('y', 4).attr('width', kw).attr('height', kh).attr('rx', 2)
    .attr('fill', 'url(#vb-key)').attr('stroke', theme.grid);
  keySvg.append('line').attr('x1', 10 + kw / 2).attr('x2', 10 + kw / 2).attr('y1', 1).attr('y2', 4 + kh + 3)
    .attr('stroke', theme.coastline).attr('stroke-width', 2.2);
  [[0.1, '90%'], [0.5, '50%'], [0.9, '10%']].forEach(([o, t]) =>
    keySvg.append('text').attr('x', 10 + o * kw).attr('y', 31).attr('text-anchor', 'middle')
      .attr('fill', theme.quiet).style('font-size', '10.5px').text(t));
  key.append('span').html(`<span style="color:${theme.ink}">Share of homes within your budget</span><br>` +
    `<span style="color:${theme.quiet}">sand where most are · coastline at 50% · water where few are</span>`);
  key.append('span').html(`${swatch(fogBg)}fog: under 20 sales`);
  key.append('span').html(`${swatch(noSales)}no apartment sales`);
  key.append('em').style('color', theme.quiet).text('Water = price out of reach, not flooding.');

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
  // Ripples drift slowly over submerged communities only (still when reduced motion is on)
  const ripple = defs.append('pattern').attr('id', 'vb-ripple').attr('patternUnits', 'userSpaceOnUse')
    .attr('width', 40).attr('height', 16);
  ripple.append('path').attr('d', 'M0 8 Q 10 4.5 20 8 T 40 8').attr('fill', 'none')
    .attr('stroke', '#ffffff').attr('stroke-width', 0.8).attr('stroke-opacity', 0.45);
  if (!reduceMotion) ripple.append('animateTransform').attr('attributeName', 'patternTransform')
    .attr('type', 'translate').attr('from', '0 0').attr('to', '40 0').attr('dur', '9s').attr('repeatCount', 'indefinite');

  svg.append('rect').attr('width', width).attr('height', mapH).attr('fill', theme.realSea);
  // Open sea sits in the bottom-left corner of this frame, clear of every community
  svg.append('text').attr('x', 24).attr('y', mapH - 24).attr('text-anchor', 'start')
    .attr('fill', theme.quiet).style('font-size', `${theme.size.small}px`).style('font-style', 'italic')
    .text('Arabian Gulf (the real sea)');

  const gComm = svg.append('g');
  const gWater = svg.append('g').attr('pointer-events', 'none');
  const gTide = svg.append('g');
  const gGhost = svg.append('g').attr('pointer-events', 'none');
  const coastPath = svg.append('path').attr('fill', 'none').attr('stroke', theme.coastline)
    .attr('stroke-width', 2.2).attr('stroke-linejoin', 'round').attr('pointer-events', 'none');
  const previewPath = svg.append('path').attr('fill', 'none').attr('stroke', theme.coastline)
    .attr('stroke-width', 2.2).attr('stroke-dasharray', '6 4').attr('opacity', 0).attr('pointer-events', 'none');
  const gStations = svg.append('g').attr('pointer-events', 'none');
  const gMarks = svg.append('g').attr('pointer-events', 'none');

  const commPaths = gComm.selectAll('path').data(features, commOfF).join('path')
    .attr('d', path).attr('stroke', '#ffffff').attr('stroke-width', 0.5).attr('fill', noSales)
    .style('cursor', 'pointer');
  const waterPaths = gWater.selectAll('path').data(features, commOfF).join('path')
    .attr('d', path).attr('fill', 'url(#vb-ripple)').attr('opacity', 0);

  gStations.selectAll('circle').data(stations.filter(s => {
    const [x, y] = projection(s.coords); return x >= 0 && x <= width && y >= 0 && y <= mapH;
  })).join('circle')
    .attr('cx', d => projection(d.coords)[0]).attr('cy', d => projection(d.coords)[1])
    .attr('r', 2.2).attr('fill', theme.ink).attr('fill-opacity', 0.7).attr('stroke', '#ffffff').attr('stroke-width', 0.8);

  // How far inland each community lies (0 = by the sea, 1 = furthest inland). The Gulf is to the
  // north-west, so "inland" runs south-east across the frame. Used only to order the animation:
  // a rising sea floods coastal communities first; a falling one drains inland communities first.
  const inlandDir = [1, 0.6], norm = Math.hypot(...inlandDir);
  const inlandRaw = new Map(features.map(f => {
    const [x, y] = path.centroid(f);
    return [commOfF(f), (x * inlandDir[0] + y * inlandDir[1]) / norm];
  }));
  const inlandScale = d3.scaleLinear().domain(d3.extent([...inlandRaw.values()].filter(Number.isFinite))).clamp(true);
  const inland = c => inlandScale(inlandRaw.get(c) ?? 0);

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
    frameFeatures, features, theme, { width, height: stripH }, paint, p => ev.emit('period', p));

  // ---------- state-driven drawing ----------
  let prev = null, cur = null, S = new Map(), dragging = false, readoutValues = null;
  const lastOut = new Map();   // community -> share out of reach last drawn (for the tide direction)

  function tipForCommunity(c) {
    const st = S.get(c);
    const head = `<strong>${nameOf(c)}</strong><br>`;
    if (!st) return `${head}No ${cur.homeType === 'villa' ? 'villa' : 'apartment'} sales in ${periodLabel(cur.period)}.`;
    if (!charted(st)) return `${head}${st.n} sale${st.n === 1 ? '' : 's'} in ${periodLabel(cur.period)} — too few to trust.`;
    return `${head}${fmt(st.n)} sales in ${periodLabel(cur.period)}<br>` +
      `Typical price: AED ${fmt(st.p50)}/m²<br>` +
      `Within your budget: ${pctFmt(st.shareWithin)} of sales<br>` +
      `<span style="color:${theme.quiet}">${DEPTH_TEXT[R.depth(st.shareWithin)]}</span>`;
  }

  commPaths
    .on('mousemove', (event, f) => {
      const c = commOfF(f);
      if (cur && cur.hovered !== c) ev.emit('hover', c);
      showTip(event, tipForCommunity(c));
    })
    .on('mouseleave', () => { ev.emit('hover', null); hideTip(); })
    .on('click', (event, f) => {
      const c = commOfF(f);
      if (event.shiftKey) ev.emit('pin', c);
      else ev.emit('select', cur && cur.selected === c ? null : c);
    });

  modeButtons
    .on('click', (event, m) => { previewPath.attr('opacity', 0); coastPath.attr('opacity', 1); ev.emit('mode', m); })
    .on('mouseenter', (event, m) => {
      if (!cur || m === cur.mode) return;
      previewPath.attr('d', path(coastFor(statsFor(cur.period, { ...cur, mode: m })))).attr('opacity', 1);
      coastPath.attr('opacity', 0.25);   // fade today's coastline so the preview stands out
    })
    .on('mouseleave', () => { previewPath.attr('opacity', 0); coastPath.attr('opacity', 1); });

  let pending = null;
  slider
    .on('input', function () {
      dragging = true;
      pending = Math.round(toSlider.invert(+this.value) / 10000) * 10000;
      budgetText.text(budgetLine(pending, cur.size));
      requestAnimationFrame(() => { if (pending != null) { ev.emit('budget', pending); pending = null; } });
    })
    // release after the last queued frame, so the final drag value is drawn without a tide delay
    .on('change', () => requestAnimationFrame(() => requestAnimationFrame(() => { dragging = false; })));
  const budgetLine = (b, size) => `${aed(b)} for ${size} m² → up to AED ${fmt(b / size)} per m²`;

  function drawData(s, animate) {
    const S0 = S;
    S = statsFor(s.period, s);

    // Fills: animate as a tide when the change is a deliberate step; follow the finger while dragging.
    const dur = animate ? 600 : 90;
    const delayOf = f => {
      if (!animate) return 0;
      const c = commOfF(f), st = S.get(c);
      const now = charted(st) ? outOf(st) : -1, before = lastOut.get(c) ?? now;
      const rising = now >= before;
      return (rising ? inland(c) : 1 - inland(c)) * 450;
    };
    commPaths.interrupt().transition().delay(delayOf).duration(dur).ease(d3.easeCubicInOut)
      .attr('fill', f => paint(S.get(commOfF(f))));
    waterPaths.interrupt().transition().delay(delayOf).duration(dur).ease(d3.easeCubicInOut)
      .attr('opacity', f => rippleOpacity(S.get(commOfF(f))));
    features.forEach(f => { const st = S.get(commOfF(f)); lastOut.set(commOfF(f), charted(st) ? outOf(st) : -1); });

    // Coastline: on a deliberate step the old line fades out and the new one draws itself.
    const newCoast = path(coastFor(S));
    const oldCoast = coastPath.attr('d');
    coastPath.interrupt().attr('d', newCoast).attr('stroke-dasharray', null).attr('stroke-dashoffset', null);
    if (animate && oldCoast && oldCoast !== newCoast && !reduceMotion) {
      gGhost.append('path').attr('d', oldCoast).attr('fill', 'none').attr('stroke', theme.coastline)
        .attr('stroke-width', 2.2).attr('opacity', 0.7)
        .transition().duration(1000).attr('opacity', 0).remove();
      const len = coastPath.node().getTotalLength() || 0;
      if (len) {
        coastPath.attr('stroke-dasharray', `${len} ${len}`).attr('stroke-dashoffset', len)
          .transition().delay(200).duration(850).ease(d3.easeCubicInOut).attr('stroke-dashoffset', 0)
          .on('end', () => coastPath.attr('stroke-dasharray', null).attr('stroke-dashoffset', null));
      }
    }

    // One measure everywhere: the share of the comparable communities (20+ sales in both
    // the "then" and the current period) that are land. Readout, film strip and tide marks agree.
    const Sthen = statsFor(s.thenPeriod, s);
    const c = comparable(Sthen, S);
    const shareIn = Sp => {
      const ch = c.set.filter(x => charted(Sp.get(x)));
      return ch.length ? ch.filter(x => isLand(Sp.get(x))).length / ch.length : NaN;
    };

    // Tide marks: coastlines of earlier periods
    const earlier = PERIOD_KEYS.slice(0, PERIOD_KEYS.indexOf(s.period));
    const tides = earlier.map(p => {
      const Sp = statsFor(p, s);
      return { p, d: path(coastFor(Sp)), share: shareIn(Sp) };
    });
    const tg = gTide.selectAll('g').data(tides, t => t.p).join(enter => {
      const g = enter.append('g').style('cursor', 'pointer');
      g.append('path').attr('class', 'tide-line').attr('fill', 'none').attr('stroke', theme.coastline)
        .attr('stroke-width', 1.3).attr('stroke-opacity', 0.4);
      g.append('path').attr('class', 'tide-hit').attr('fill', 'none').attr('stroke', 'transparent').attr('stroke-width', 9);
      return g;
    });
    tg.select('.tide-line').attr('d', t => t.d);
    tg.select('.tide-hit').attr('d', t => t.d)
      .on('mousemove', (event, t) => showTip(event,
        `<strong>${periodLabel(t.p)} coastline</strong><br>${pctFmt(t.share)} of the comparable communities were land.<br>` +
        `<span style="color:${theme.quiet}">Click to compare against ${periodLabel(t.p)}.</span>`))
      .on('mouseleave', hideTip)
      .on('click', (event, t) => ev.emit('thenPeriod', t.p));

    drawReadout(s, c, animate);

    strip.update(PERIOD_KEYS.map(p => {
      const Sp = statsFor(p, s);
      return { p, S: Sp, coast: coastFor(Sp), share: shareIn(Sp) };
    }), s.period, animate);

    if (!dragging) slider.property('value', toSlider(s.budget));
    budgetText.text(budgetLine(s.budget, s.size));
    return S0;
  }

  // Readout: the numbers count to their new values instead of jumping
  function drawReadout(s, c, animate) {
    const same = s.thenPeriod === s.period;
    const target = same ? [chartedShare(S)] : [c.land1, c.land2];
    const from = readoutValues && readoutValues.length === target.length ? readoutValues : target;
    readoutValues = target;
    const render = vals => same
      ? `${MODE_LABEL[s.mode]} · ${periodLabel(s.period)} · <strong style="color:${theme.ink}">${pctFmt(vals[0])}</strong> of charted communities are land`
      : `${MODE_LABEL[s.mode]} · comparable communities on land: <strong style="color:${theme.ink}">${pctFmt(vals[0])}</strong> ` +
        `(${periodLabel(s.thenPeriod)}) → <strong style="color:${theme.ink}">${pctFmt(vals[1])}</strong> (${periodLabel(s.period)}) · ${c.n} communities`;
    readout.interrupt();
    if (!animate || reduceMotion) { readout.html(render(target)); return; }
    const interp = d3.interpolate(from, target);
    readout.transition().duration(700).tween('count', () => t => readout.html(render(interp(t))));
  }

  function drawMarks(s) {
    modeButtons
      .attr('aria-pressed', d => String(d === s.mode))
      .style('background', d => d === s.mode ? theme.ink : '#ffffff')
      .style('color', d => d === s.mode ? '#ffffff' : theme.ink)
      .style('border', d => `1px solid ${d === s.mode ? theme.ink : theme.grid}`);

    const fogHighlight = s.highlight === 'fog';
    const isFog = f => { const st = S.get(commOfF(f)); return !!st && !charted(st); };
    commPaths
      .attr('stroke', f => fogHighlight && isFog(f) ? theme.accent : '#ffffff')
      .attr('stroke-width', f => fogHighlight && isFog(f) ? 1.5 : 0.5);

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
      if (dataChanged) drawData(s, !!prev && !dragging);
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
