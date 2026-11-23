// src/rules.js
export const MIN_SALES = 20;
export const PERIODS = { '2015-17': [2015, 2017], '2018-20': [2018, 2020], '2021-23': [2021, 2023], '2024-26': [2024, 2026] };
export const periodOf = r => {
  const y = r.date.getUTCFullYear();
  return Object.keys(PERIODS).find(p => y >= PERIODS[p][0] && y <= PERIODS[p][1]);
};
export const isHomeSale = (r, homeType) =>
  r.trans_group_en === 'Sales' && r.property_type_en === (homeType === 'villa' ? 'Villa' : 'Unit');
export const inMode = (r, mode) => mode === 'all' ||
  r.reg_type_en === (mode === 'offplan' ? 'Off-Plan Properties' : 'Existing Properties');
export const isExtreme = r => r.price < 1000 || r.price > 100000;  // removed only when dropExtremes is on
// Price level relative to 2025 (World Bank CPI via FRED); 2026 held at 2025
export const PRICE_LEVEL = { 2015: 0.8836, 2016: 0.898, 2017: 0.9156, 2018: 0.9438, 2019: 0.9255, 2020: 0.9063,
  2021: 0.9079, 2022: 0.9559, 2023: 0.9715, 2024: 0.9877, 2025: 1, 2026: 1 };
export const priceIn = (r, money) => money === 'real' ? r.price / PRICE_LEVEL[r.date.getUTCFullYear()] : r.price;
// One community in one period: its filtered prices, sorted, give n and
//   shareWithin = share of prices <= budget / size.
// Land (sand) = n >= MIN_SALES and shareWithin >= 0.5; water = n >= MIN_SALES and shareWithin < 0.5.
// Match communities with String(feature.properties.COMM_NUM) === row.comm_num.
