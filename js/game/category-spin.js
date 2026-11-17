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

/**
 * The tiles: only subjects that can come up (owner, 2026-11-17: "it should
 * just be among what is in play"). A vetoed subject is not drawn at all.
 * `emojiFor` maps a category to its emoji.
 */
export function spinTilesHtml(weights, players, emojiFor, winner = null) {
  const tally = draftTally(players);
  return DRAFT_CATEGORIES.filter(c => weights?.[c] > 0 || c === winner).map(c => {
    const entry = tally[c];
    const status = draftStatus(entry);
    const cls = ['draft-tile'];
    if (status === 'want') cls.push('draft-tile--want');
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
    tilesEl.innerHTML = spinTilesHtml(weights, players, emojiFor, winner);
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

/**
 * THE SUBJECT CARD, "Spin: Every question". Before each question's clock
 * starts, the screen shows the round number and a big subject that rolls
 * through the subjects in play and lands on this question's. Replaced a
 * one-second flicker in the header that a playtester never noticed (owner,
 * 2026-11-17: "my friend didn't even realize what was happening").
 *
 * It plays inside the question's own sync buffer, which question.js lengthens
 * by `durationMs`, and the host stamps the round clock only after that buffer:
 * so the card never costs anyone answering time.
 *
 * `options` and `winner` are { emoji, label }. Resolves when it has hidden.
 */
export function playSubjectCard({ overlay, kicker, options, winner, durationMs }) {
  if (!overlay || !winner) return Promise.resolve(false);
  overlay._cancelCard?.();
  const kickerEl = overlay.querySelector('.subject-card__kicker');
  const emojiEl = overlay.querySelector('.subject-card__emoji');
  const labelEl = overlay.querySelector('.subject-card__label');
  const show = o => { emojiEl.textContent = o.emoji; labelEl.textContent = o.label; };
  kickerEl.textContent = kicker || '';
  overlay.classList.remove('hidden', 'subject-card--landed');

  const pool = (options || []).filter(o => o && o.label !== winner.label);
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const HOLD_MS = Math.min(900, durationMs * 0.5);
  const rollMs = (pool.length === 0 || still) ? 0 : durationMs - HOLD_MS;
  const timers = [];

  return new Promise(resolve => {
    const finish = landed => {
      timers.forEach(clearTimeout);
      overlay.classList.add('hidden');
      overlay._cancelCard = null;
      resolve(landed);
    };
    overlay._cancelCard = () => finish(false);
    const land = () => {
      show(winner);
      overlay.classList.add('subject-card--landed');
      timers.push(setTimeout(() => finish(true), durationMs - rollMs));
    };
    if (rollMs <= 0) { land(); return; }
    const started = Date.now();
    let last = null;
    let delay = 60;
    const tick = () => {
      if (Date.now() - started + delay >= rollMs) { land(); return; }
      const choices = pool.filter(o => o !== last);
      last = (choices.length ? choices : pool)[Math.floor(Math.random() * (choices.length || pool.length))];
      show(last);
      delay = Math.min(delay + 16, 200);
      timers.push(setTimeout(tick, delay));
    };
    tick();
  });
}

export function cancelSubjectCard(overlay) {
  overlay?._cancelCard?.();
}

/** Stop a wheel in flight (leaving the page, or the game moving on without it). */
export function cancelCategorySpin(overlay) {
  overlay?._cancelSpin?.();
}
