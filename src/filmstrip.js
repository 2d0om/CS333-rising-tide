// src/filmstrip.js — the film strip under View B (Member 2)
// Small multiples: one mini-map per period, same encoding and same scale, so periods
// are compared side by side instead of from memory. Click a mini-map to jump to that period.
const periodLabel = p => p.replace('-', '–');
const pctFmt = d3.format('.0%');

// paint(stats) -> fill, shared with the main map so both use exactly the same colours
export function createFilmstrip(container, frameFeatures, features, theme, { width, height }, paint, onPick) {
  const gap = 10, labelH = 22;
  const w = (width - gap * 3) / 4, h = height - labelH;
  const root = d3.select(container).style('display', 'flex').style('gap', `${gap}px`);
  const commOf = f => String(f.properties.COMM_NUM);

  const projection = d3.geoMercator().fitExtent([[4, 4], [w - 4, h - 4]],
    { type: 'FeatureCollection', features: frameFeatures });
  const path = d3.geoPath(projection);
  const cellPaths = new Map(features.map(f => [commOf(f), path(f)]));

  let cells = root.selectAll('div.cell');

  return {
    update(periods, current, animate) {
      cells = root.selectAll('div.cell').data(periods, d => d.p).join(enter => {
        const cell = enter.append('div').attr('class', 'cell').style('width', `${w}px`).style('cursor', 'pointer')
          .attr('role', 'button').attr('tabindex', 0)
          .on('click', (event, d) => onPick(d.p))
          .on('keydown', (event, d) => { if (event.key === 'Enter' || event.key === ' ') onPick(d.p); });
        cell.append('div').attr('class', 'label').style('height', `${labelH}px`)
          .style('font-size', `${theme.size.small}px`).style('color', theme.ink);
        const svg = cell.append('svg').attr('width', w).attr('height', h).style('display', 'block')
          .style('border-radius', '6px');
        svg.append('rect').attr('width', w).attr('height', h).attr('fill', theme.realSea);
        svg.append('g').attr('class', 'comms').selectAll('path').data(features).join('path')
          .attr('d', f => cellPaths.get(commOf(f)))
          .attr('stroke', '#ffffff').attr('stroke-width', 0.3).attr('fill', '#f7f7f7');
        svg.append('path').attr('class', 'coast').attr('fill', 'none')
          .attr('stroke', theme.coastline).attr('stroke-width', 1.2);
        svg.append('path').attr('class', 'selected').attr('fill', 'none')
          .attr('stroke', theme.accent).attr('stroke-width', 1.6);
        return cell;
      });
      cells.select('.label').html(d => `<strong>${periodLabel(d.p)}</strong> · ${pctFmt(d.share)} land`);
      cells.select('svg')
        .style('outline', d => d.p === current ? `2px solid ${theme.ink}` : `1px solid ${theme.grid}`)
        .style('outline-offset', '-1px');
      cells.each(function (d) {
        const fills = d3.select(this).selectAll('.comms path').interrupt();
        (animate ? fills.transition().duration(500) : fills).attr('fill', f => paint(d.S.get(commOf(f))));
        d3.select(this).select('.coast').attr('d', path(d.coast));
      });
      cells.attr('aria-label', d => `Show ${periodLabel(d.p)}, ${pctFmt(d.share)} land`)
        .attr('aria-current', d => d.p === current ? 'true' : null);
    },
    mark(state) {
      cells.select('.selected').attr('d', state.selected ? (cellPaths.get(state.selected) || null) : null);
    }
  };
}
