// src/standalone.js
// Runs View B on its own page: the public link (index.html) and the dev page (dev/viewB.html).
// It stands in for main.js: it keeps a local state and applies the view's own events to it.
// When the window changes size (full screen, a resized window, the joint page resizing its frame) the view
// is laid out again at the new size and keeps its state; a reader still on the guess starts the guess again.
import { loadAll } from './load.js';
import theme from './theme.js';
import { createViewB } from './viewB.js';

export async function runViewB(el, { onEvent = () => {}, chrome = 0 } = {}) {
  const data = await loadAll();
  // fill the window so everything is visible at once; chrome = px taken by anything above or below the view
  const sizeNow = () => ({ width: Math.min(1480, innerWidth - 32), height: Math.max(560, innerHeight - 32 - chrome) });
  let size = sizeNow(), guessFirst = !new URLSearchParams(location.search).has('noguess'), view;

  let state = { budget: 1200000, size: 80, period: '2024-26', thenPeriod: '2015-17', mode: 'all',
    money: 'nominal', homeType: 'apartment', selected: '346', pinned: [], hovered: null,
    unlocked: true, dropExtremes: false, highlight: null };   // '346' = Business Bay
  const set = patch => { state = { ...state, ...patch }; view.update(state); };
  const keyFor = { select: 'selected', hover: 'hovered', mode: 'mode', thenPeriod: 'thenPeriod', period: 'period', budget: 'budget' };

  function build() {
    view = createViewB(el, data, theme, { ...size, guessFirst });
    ['select', 'pin', 'hover', 'mode', 'thenPeriod', 'period', 'budget'].forEach(ev => view.on(ev, v => {
      onEvent(ev, v);
      if (ev === 'pin') {
        const p = state.pinned;
        set({ pinned: p.includes(v) ? p.filter(x => x !== v) : [...p, v].slice(-4) });
      } else set({ [keyFor[ev]]: v });
    }));
    view.update(state);
  }
  build();

  let t;
  addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => {
      const s = sizeNow();
      if (Math.abs(s.width - size.width) < 2 && Math.abs(s.height - size.height) < 2) return;
      size = s; guessFirst = guessFirst && view.guessing;
      view.destroy(); build();
    }, 200);
  });
  window.__viewB = { get view() { return view; }, get state() { return state; }, set };   // for automated checks
  return view;
}
