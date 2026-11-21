// src/standalone.js
// Runs View B on its own page: the public link (index.html) and the dev page (dev/viewB.html).
// It stands in for main.js: it keeps a local state and applies the view's own events to it.
import { loadAll } from './load.js';
import theme from './theme.js';
import { createViewB } from './viewB.js';

export async function runViewB(el, { onEvent = () => {}, chrome = 0 } = {}) {
  const data = await loadAll();
  // fill the window so everything is visible at once; chrome = px taken by anything above or below the view
  const size = { width: Math.min(1480, innerWidth - 32), height: Math.max(560, innerHeight - 32 - chrome) };
  const view = createViewB(el, data, theme, { ...size, guessFirst: !new URLSearchParams(location.search).has('noguess') });

  let state = { budget: 1200000, size: 80, period: '2024-26', thenPeriod: '2015-17', mode: 'all',
    money: 'nominal', homeType: 'apartment', selected: '346', pinned: [], hovered: null,
    unlocked: true, dropExtremes: false, highlight: null };   // '346' = Business Bay
  const set = patch => { state = { ...state, ...patch }; view.update(state); };
  const keyFor = { select: 'selected', hover: 'hovered', mode: 'mode', thenPeriod: 'thenPeriod', period: 'period', budget: 'budget' };
  ['select', 'pin', 'hover', 'mode', 'thenPeriod', 'period', 'budget'].forEach(ev => view.on(ev, v => {
    onEvent(ev, v);
    if (ev === 'pin') {
      const p = state.pinned;
      set({ pinned: p.includes(v) ? p.filter(x => x !== v) : [...p, v].slice(-4) });
    } else set({ [keyFor[ev]]: v });
  }));
  set({});
  window.__viewB = { view, get state() { return state; }, set };   // for automated checks
  return view;
}
