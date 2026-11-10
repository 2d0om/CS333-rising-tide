// src/filmstrip.js — the film strip under View B (Member 2)
// Small multiples: one mini-map per period, drawn with the same water surface and the same
// colours as the main map, so periods are compared side by side instead of from memory.
// Click a mini-map to jump to that period.
import { createWaterField } from './waterfield.js';

const periodLabel = p => p.replace('-', '–');
const pctFmt = d3.format('.0%');

// look = { lut, COAST, valueOf, baseFill } from View B
export function createFilmstrip(container, frameFeatures, features, theme, { width, height }, look, onPick) {
  const gap = 10, labelH = 22;
  const w = (width - gap * 3) / 4, h = height - labelH;
  const root = d3.select(container).style('display', 'flex').style('gap', `${gap}px`);
  const commOf = f => String(f.properties.COMM_NUM);

  const projection = d3.geoMercator().fitExtent([[4, 4], [w - 4, h - 4]],
    { type: 'FeatureCollection', features: frameFeatures });
  const path = d3.geoPath(projection);
  const cellPaths = new Map(features.map(f => [commOf(f), path(f)]));
  const wf = createWaterField(features, projection, w, h, { cell: 2, soft: 1, fill: 6 });
  const uid = Math.random().toString(36).slice(2, 7);

  let cells = root.selectAll('div.cell');

  return {
    update(periods, current) {
      cells = root.selectAll('div.cell').data(periods, d => d.p).join(enter => {
        const cell = enter.append('div').attr('class', 'cell').style('width', `${w}px`).style('cursor', 'pointer')
          .attr('role', 'button').attr('tabindex', 0)
          .on('click', (event, d) => onPick(d.p))
          .on('keydown', (event, d) => { if (event.key === 'Enter' || event.key === ' ') onPick(d.p); });
        cell.append('div').attr('class', 'label').style('height', `${labelH}px`)
          .style('font-size', `${theme.size.small}px`).style('color', theme.ink);
        const svg = cell.append('svg').attr('width', w).attr('height', h).style('display', 'block')
          .style('border-radius', '6px');
        svg.append('clipPath').attr('id', d => `fs-${uid}-${d.p}`);
        svg.append('rect').attr('width', w).attr('height', h).attr('fill', theme.realSea);
        svg.append('g').attr('class', 'comms').selectAll('path').data(features).join('path')
          .attr('d', f => cellPaths.get(commOf(f))).attr('stroke', '#ffffff').attr('stroke-width', 0.3);
        svg.append('g').attr('class', 'surface').attr('clip-path', d => `url(#fs-${uid}-${d.p})`)
          .append('foreignObject').attr('x', wf.box.x).attr('y', wf.box.y)
          .attr('width', wf.box.width).attr('height', wf.box.height)
          .each(function () { this.__surface = wf.makeCanvas(); this.appendChild(this.__surface.canvas); });
        svg.append('path').attr('class', 'coast').attr('fill', 'none').attr('clip-path', d => `url(#fs-${uid}-${d.p})`)
          .attr('stroke', theme.coastline).attr('stroke-width', 1.1);
        svg.append('path').attr('class', 'selected').attr('fill', 'none')
          .attr('stroke', theme.accent).attr('stroke-width', 1.6);
        return cell;
      });
      cells.select('.label').html(d => `<strong>${periodLabel(d.p)}</strong> · ${pctFmt(d.share)} land`);
      cells.select('svg')
        .style('outline', d => d.p === current ? `2px solid ${theme.ink}` : `1px solid ${theme.grid}`)
        .style('outline-offset', '-1px');
      cells.each(function (d) {
        const cell = d3.select(this);
        const stOf = f => d.S.get(commOf(f));
        cell.selectAll('.comms path').attr('fill', f => look.baseFill(stOf(f)));
        cell.select('clipPath').selectAll('path').data(features.filter(f => look.valueOf(stOf(f)) === look.valueOf(stOf(f))))
          .join('path').attr('d', f => cellPaths.get(commOf(f)));
        const grid = wf.field(Float32Array.from(features, f => look.valueOf(stOf(f))));
        cell.select('foreignObject').node().__surface.draw(grid, look.lut);
        cell.select('.coast').attr('d', wf.line(grid, look.COAST));
      });
      cells.attr('aria-label', d => `Show ${periodLabel(d.p)}, ${pctFmt(d.share)} land`)
        .attr('aria-current', d => d.p === current ? 'true' : null);
    },
    mark(state) {
      cells.select('.selected').attr('d', state.selected ? (cellPaths.get(state.selected) || null) : null);
    }
  };
}
