/**
 * The podium: the first of the two end-of-game screens.
 *
 * Gold, silver and bronze stand on steps whose heights replay the game — every
 * bar starts at 0, glides through the running totals, and the final wager
 * settles it. Gold's step is the one fixed size and everything else is in
 * proportion to it; a score below zero hangs under the floor and may run off
 * the bottom of the screen. Tap anywhere to go on to the scoreboard, or it goes
 * by itself a few seconds after the replay ends.
 *
 * Designed with the owner over a long run of mockups (2026-10-28) — see the
 * CLAUDE.md entry. The arithmetic lives in podium-logic.js, which is tested.
 *
 * It imports nothing that reaches Supabase, so scripts/mock-states.js can load
 * THIS module and the layout sweep reviews the podium that ships.
 */
import { $, escapeHtml, renderAvatar } from '../utils.js';
import { logger } from '../logger.js';
import { state, showScreen } from './state.js';
import {
  PODIUM_TIMING, cumulativeSeries, podiumSlots, rankPlayers, ordinal,
  replayValueAt, replayEnd, barSize,
} from './podium-logic.js';

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };
const LABEL_INSIDE_MIN = 46;   // px a bar needs before its number fits inside it
const FOOT_RESERVE = 64;       // the "tap to continue" card, when nothing hangs below the floor
const NEG_RESERVE = 62;        // room under the floor for a hanging bar's number
const DOWN_PX = 40;            // the winner's drop when even the winner is below zero
const UP_MAX = 250;
const GOLD_GAP = 24;            // headline -> winner's picture, and winner's title -> gold step            // gold's step on a tall phone; the owner's 320x523 gets ~230

let _running = null;

/** A camelCase or digit boundary is where a long name may break; a word itself never is, if avoidable. */
function softBreaks(name) {
  return escapeHtml(name).replace(/([a-z])([A-Z0-9])/g, '$1<wbr>$2');
}

function clamp01(x) { return Math.min(1, Math.max(0, x)); }
function smooth(x) { return x * x * (3 - 2 * x); }

/**
 * Show the podium and resolve when the player moves on. Never rejects: a
 * decoration must not be able to keep anybody from their results, so any
 * failure resolves at once and the caller shows the scoreboard.
 */
export function showPodium({ sorted, scores, allAnswers }) {
  if (_running) _running.finish();
  return new Promise(resolve => {
    try {
      _running = runPodium({ sorted, scores, allAnswers }, () => { _running = null; resolve(); });
    } catch (e) {
      logger.warn('Podium', 'could not draw the podium', e);
      _running = null;
      resolve();
    }
  });
}

/** Cut the podium short (the room moved on, or cleanup). */
export function stopPodium() { if (_running) _running.finish(); }

function runPodium({ sorted, scores, allAnswers }, done) {
  const screen = $('#podium-screen');
  const host = $('#podium');
  if (!screen || !host || !sorted.length) { done(); return { finish() {} }; }

  const scoreOf = p => scores[p.id] || 0;
  const slots = podiumSlots(sorted, scoreOf);
  const ranks = rankPlayers(sorted, scoreOf);
  const winner = scoreOf(sorted[0]);
  const allNeg = winner <= 0;
  const series = cumulativeSeries(allAnswers, slots.map(s => s.player.id), state.totalQuestions);
  const anyNeg = slots.some(s => scoreOf(s.player) < 0);
  const tiedTop = slots.filter(s => s.rank === 1).length > 1;

  // Somebody below the podium learns where they finished, on their own phone.
  const meIdx = sorted.findIndex(p => String(p.id) === String(state.room.playerId));
  const meLine = meIdx >= 3
    ? `<div class="podium__you">You finished <b>${ordinal(ranks[meIdx])}</b> · ${scoreOf(sorted[meIdx])} pts</div>`
    : '';

  host.className = 'podium' + (slots.length === 2 ? ' podium--two' : '');
  host.innerHTML = `
    <div class="podium__head">
      <div class="podium__kicker">${tiedTop ? 'Game over' : '🏆 Champion'}</div>
      <div class="podium__title">${tiedTop ? 'It’s a tie!' : softBreaks(sorted[0].display_name)}</div>
    </div>
    <div class="podium__stage">
      ${slots.map(s => {
        const p = s.player;
        const title = p.title ? `<div class="podium__ttl">${escapeHtml(p.title)}</div>` : '';
        return `<div class="podium__col podium__col--${s.medal}" data-player-id="${p.id}">
          <div class="podium__face">
            ${renderAvatar({ displayName: p.display_name, avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji })}
            <div class="podium__medal" aria-hidden="true">${MEDAL[s.medal]}</div>
          </div>
          <div class="podium__name">${softBreaks(p.display_name)}</div>
          ${title}
          <div class="podium__over"><span class="podium__pts"><b>0</b><small>pts</small></span></div>
          <div class="podium__step"><span class="podium__pts"><b>0</b><small>pts</small></span></div>
          <div class="podium__pit">
            <div class="podium__neg"><span class="podium__pts"><b>0</b><small>pts</small></span></div>
            <div class="podium__under"><span class="podium__pts"><b>0</b><small>pts</small></span></div>
          </div>
        </div>`;
      }).join('')}
    </div>
    <div class="podium__foot${anyNeg ? ' podium__foot--float' : ''}">
      ${meLine}
      <div class="podium__next">${anyNeg ? 'Tap to continue' : 'Tap to see the full scoreboard'}</div>
      <div class="podium__bar"><span></span></div>
    </div>`;

  showScreen(screen);

  // ----- measure, then lay out -----
  const stage = host.querySelector('.podium__stage');
  const cols = [...host.querySelectorAll('.podium__col')].map((el, i) => ({
    el, slot: slots[i],
    face: el.querySelector('.podium__face'),
    avatar: el.querySelector('.avatar'),
    medal: el.querySelector('.podium__medal'),
    over: el.querySelector('.podium__over'),
    step: el.querySelector('.podium__step'),
    neg: el.querySelector('.podium__neg'),
    under: el.querySelector('.podium__under'),
    series: series[slots[i].player.id],
    final: scoreOf(slots[i].player),
  }));

  let UP = 160, pit = 0;
  const layout = () => {
    const goldCol = cols.find(c => c.slot.medal === 1) || cols[0];
    const H = stage.clientHeight;
    const nameEl = goldCol.el.querySelector('.podium__name');
    // The winner's picture, name and title are ONE block, centred between the
    // headline and the top of gold's step (the owner's rule, 2026-10-29):
    // headline -> picture equals title -> step. Gold's step is always tall
    // enough for its number to sit inside, so its "over" label never shows
    // and gives its room to the gap.
    const gap = GOLD_GAP;
    for (const c of cols.filter(c => c.slot.medal === 1)) {   // a tie is two golds
      c.over.style.display = 'none';
      c.step.style.marginTop = `${gap}px`;
    }
    const pic = goldCol.avatar.getBoundingClientRect();
    const last = goldCol.el.querySelector('.podium__ttl') || nameEl;
    const content = last.getBoundingClientRect().bottom - pic.top + gap;
    if (allNeg) {
      // Nobody stands above the floor, so no step is reserved: everything
      // below the names is room for the bars to hang. Reserving one left a
      // band of empty screen above the pictures.
      UP = 0;
      pit = Math.max(120, H - content - gap);
    } else {
      const below = anyNeg ? NEG_RESERVE : FOOT_RESERVE;
      pit = below;
      UP = Math.max(60, H - below - content - gap);
      // A tall phone would stretch gold's step past anything that reads as a
      // podium. Past UP_MAX the spare height goes above the headline and below
      // the floor instead, so the composition sits in the middle of the screen.
      if (UP > UP_MAX) {
        const extra = UP - UP_MAX;
        host.querySelector('.podium__head').style.paddingTop = `${12 + extra * 0.55}px`;
        pit += extra * 0.45;
        UP = UP_MAX;
      }
    }
    stage.style.setProperty('--pit', `${pit}px`);
    cols.forEach(c => { c.el.querySelector('.podium__pit').style.height = `${pit}px`; });

    // Arithmetic got within a few px; the rule is exact. Stand gold at its
    // final height, MEASURE the gap above the picture, and correct by the
    // difference — in UP normally, in the hang room when everyone is below.
    const title = host.querySelector('.podium__title');
    const before = goldCol.step.style.height;
    goldCol.step.style.height = `${UP}px`;
    const above = goldCol.avatar.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
    const fix = above - gap;
    if (allNeg) {
      pit = Math.max(120, pit + fix);
      stage.style.setProperty('--pit', `${pit}px`);
      cols.forEach(c => { c.el.querySelector('.podium__pit').style.height = `${pit}px`; });
    } else {
      UP = Math.max(60, UP + fix);
    }
    goldCol.step.style.height = before;
  };
  layout();

  // The reference for positive bars: the winner, or anybody's best running
  // total if that was higher, so nobody's bar outgrows the frame mid-replay.
  const peak = Math.max(0, winner, ...cols.flatMap(c => c.series.slice(0, -1)));
  const geo = { winner, scale: peak, upPx: UP, downPx: DOWN_PX };

  const speed = (typeof window.__podiumSpeed === 'number' && window.__podiumSpeed > 0) ? window.__podiumSpeed : 1;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const END = replayEnd();
  const FINISH = END + PODIUM_TIMING.SETTLE;
  const LEAVE = FINISH + PODIUM_TIMING.HOLD;

  // Crossing below zero tips the avatar over (only when the winner is above
  // zero — when everybody is below, a whole row of upside-down faces is the
  // "too uniform" the owner turned down for the medal gag).
  for (const c of cols) {
    if (allNeg || c.final >= 0) continue;
    let cross = null;
    for (let t = 0; t <= END; t += 20) { if (replayValueAt(c.series, t) < 0) { cross = t; break; } }
    c.flipAt = cross;
  }

  const paint = (t) => {
    for (const c of cols) {
      const v = t >= END ? c.final : replayValueAt(c.series, t);
      const { up, down } = barSize(v, geo);
      const h = Math.min(up, UP);
      c.step.style.height = `${h}px`;
      c.neg.style.height = `${down}px`;
      const shown = Math.round(v);
      const started = t >= PODIUM_TIMING.LEAD;
      for (const el of [c.step, c.over, c.neg, c.under]) el.querySelector('b').textContent = String(shown);
      c.step.classList.toggle('podium__step--label', h >= LABEL_INSIDE_MIN);
      c.over.style.opacity = (started && v >= 0 && h < LABEL_INSIDE_MIN) ? '1' : '0';
      c.neg.classList.toggle('podium__neg--label', down >= LABEL_INSIDE_MIN);
      c.under.style.opacity = (v < 0 && down < LABEL_INSIDE_MIN) ? '1' : '0';
      c.under.style.transform = `translateY(${down}px)`;
      if (c.flipAt != null) {
        const p = clamp01((t - c.flipAt) / 500);
        const deg = p >= 1 ? 180 : 200 * smooth(p);
        c.avatar.style.transform = p > 0 ? `rotate(${deg}deg)` : '';
      }
      c.medal.style.opacity = String(clamp01((t - END) / 300));
    }
    const hp = clamp01((t - END - 150) / 400);
    host.querySelector('.podium__head').style.opacity = String(hp);
    host.querySelector('.podium__head').style.transform = `translateY(${(1 - hp) * -6}px)`;
    const gold = cols.find(c => c.slot.medal === 1);
    if (gold) {
      const pulse = Math.sin(clamp01((t - END) / 700) * Math.PI);
      gold.avatar.style.boxShadow = `0 0 ${28 + 18 * pulse}px ${6 + 10 * pulse}px rgba(226,181,58,${0.45 + 0.3 * pulse})`;
    }
    const fill = host.querySelector('.podium__bar span');
    if (fill) fill.style.width = `${Math.round(clamp01((t - FINISH) / PODIUM_TIMING.HOLD) * 100)}%`;
  };

  let raf = 0, finished = false, start = performance.now();
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(raf);
    screen.removeEventListener('click', finish);
    done();
  };
  const tick = (now) => {
    if (finished) return;
    const t = reduce ? FINISH + (now - start) : (now - start) * speed;
    paint(Math.min(t, FINISH));
    if (t >= LEAVE) { finish(); return; }
    raf = requestAnimationFrame(tick);
  };
  paint(reduce ? FINISH : 0);
  screen.addEventListener('click', finish);
  raf = requestAnimationFrame(tick);
  state._podiumShown = (state._podiumShown || 0) + 1;
  return { finish };
}
