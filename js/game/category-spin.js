// The category wheel: Draft and Random rooms spin it once, in front of the
// countdown, and it lands on the subject the whole game will ask.
//
// THEATRE ONLY. The host's phone has already decided (pickWeighted in
// init.js) and written the result to rooms.draft_pick; this animates towards
// that. So two phones can light different tiles on the way and must always
// stop on the same one.
//
// No imports beyond the rules module, so the mock states can run the real
// drawing code.
import { DRAFT_CATEGORIES, DRAFT_SHORT_LABELS, draftTally, draftStatus } from '../draft-logic.js';

let _running = null;

/** The tiles, with what the room did to each. `emojiFor` maps a category to its emoji. */
export function spinTilesHtml(weights, players, emojiFor) {
  const tally = draftTally(players);
  return DRAFT_CATEGORIES.map(c => {
    const entry = tally[c];
    const status = draftStatus(entry);
    const out = !(weights?.[c] > 0);
    const cls = ['draft-tile'];
    if (out) cls.push('draft-tile--ban');
    else if (status === 'want') cls.push('draft-tile--want');
    const pips = entry && entry.blocks > 0 ? '<i></i>'.repeat(Math.min(entry.blocks, 6)) : '';
    return `<div class="${cls.join(' ')}" data-spin-category="${c}">
      <span class="draft-tile__emoji" aria-hidden="true">${emojiFor(c)}</span>
      <span class="draft-tile__label">${DRAFT_SHORT_LABELS[c]}</span>
      <span class="draft-tile__pips">${pips}</span>
    </div>`;
  }).join('');
}

/**
 * The order the light visits tiles: only tiles that could win, never the same
 * one twice running, ending on the winner. Heavier tiles are visited more.
 */
export function spinStops(weights, winner, count, roll = Math.random) {
  const live = DRAFT_CATEGORIES.filter(c => weights?.[c] > 0 || c === winner);
  const stops = [];
  let last = null;
  for (let i = 0; i < count - 1; i++) {
    const pool = live.filter(c => c !== last);
    if (pool.length === 0) { stops.push(winner); continue; }
    // Half the visits follow the odds, half wander, so a one-sided wheel still moves.
    let next = pool[Math.floor(roll() * pool.length)];
    if (roll() < 0.5) {
      const total = pool.reduce((s, c) => s + (weights?.[c] || 0), 0);
      let mark = roll() * total;
      for (const c of pool) { mark -= (weights?.[c] || 0); if (mark < 0) { next = c; break; } }
    }
    stops.push(next);
    last = next;
  }
  if (last === winner && live.length > 1 && stops.length > 0) {
    stops[stops.length - 1] = live.find(c => c !== winner && c !== stops[stops.length - 2]) || stops[stops.length - 1];
  }
  stops.push(winner);
  return stops;
}

/**
 * Play the wheel for `durationMs`, ending lit on `winner`. Resolves when it
 * has hidden itself. A second call while one is running returns the first.
 */
export function playCategorySpin({ overlay, weights, players, winner, emojiFor, labelFor, durationMs }) {
  if (_running) return _running;
  if (!overlay || !winner || !(durationMs > 900)) return Promise.resolve(false);
  _running = new Promise(resolve => {
    const tilesEl = overlay.querySelector('.category-spin__tiles');
    const finalEl = overlay.querySelector('.category-spin__final');
    tilesEl.innerHTML = spinTilesHtml(weights, players, emojiFor);
    finalEl.textContent = '';
    overlay.classList.remove('hidden', 'category-spin--landed');

    const HOLD_MS = Math.min(1500, Math.max(700, durationMs * 0.3));
    const spinMs = durationMs - HOLD_MS;
    // Decelerating steps that fill the spin time.
    const delays = [];
    let d = 70, used = 0;
    while (used + d < spinMs) { delays.push(d); used += d; d = Math.min(d + 14, 300); }
    const stops = spinStops(weights, winner, Math.max(2, delays.length + 1));
    const light = c => {
      tilesEl.querySelectorAll('.draft-tile--lit').forEach(t => t.classList.remove('draft-tile--lit'));
      tilesEl.querySelector(`[data-spin-category="${c}"]`)?.classList.add('draft-tile--lit');
    };
    let i = 0;
    const timers = [];
    const step = () => {
      light(stops[i]);
      if (i < stops.length - 1) {
        timers.push(setTimeout(step, delays[i] ?? 120));
        i++;
        return;
      }
      overlay.classList.add('category-spin--landed');
      tilesEl.querySelector(`[data-spin-category="${winner}"]`)?.classList.add('draft-tile--won');
      finalEl.textContent = `${emojiFor(winner)} ${labelFor(winner)}`;
      timers.push(setTimeout(() => {
        overlay.classList.add('hidden');
        _running = null;
        resolve(true);
      }, HOLD_MS));
    };
    step();
    overlay._cancelSpin = () => {
      timers.forEach(clearTimeout);
      overlay.classList.add('hidden');
      _running = null;
      resolve(false);
    };
  });
  return _running;
}

/** Stop a wheel in flight (leaving the page, or the game moving on without it). */
export function cancelCategorySpin(overlay) {
  overlay?._cancelSpin?.();
}
