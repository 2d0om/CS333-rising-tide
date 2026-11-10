// src/load.js
const BASE = 'https://raw.githubusercontent.com/sharios/CS333/main/2026-27';
const START = Date.UTC(2015, 0, 1), END = Date.UTC(2026, 8, 1);  // 1 Jan 2015 to 31 Aug 2026, both included
export async function loadAll() {
  const day = d3.utcParse('%Y-%m-%d');                           // UTC, never local time
  const [raw, geo, metro] = await Promise.all([
    d3.csv(`${BASE}/Part%202/transactions.csv`),
    d3.json(`${BASE}/Part%202/dubai.geojson`),
    d3.json(`${BASE}/Part%203/dubai_metro_stations.geojson`)
  ]);
  raw.forEach(r => { r.date = day(r.instance_date); r.price = +r.meter_sale_price; });
  const rows = raw.filter(r => r.date && +r.date >= START && +r.date < END);
  return { raw, rows, geo, metro };  // raw = all 89,212 (for the ledger); rows = the 67,022 in the window
}
