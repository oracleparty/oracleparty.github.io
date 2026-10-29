/**
 * The end-of-game podium: who stands where, and how the race replay moves.
 *
 * NO IMPORTS, deliberately — everything else in js/game/ pulls the Supabase
 * client from esm.sh, which the test runner cannot load, and this is the part
 * worth testing: the ranking, the order the steps stand in, and the curve the
 * bars follow. The same pattern as phase-order.js and clap-logic.js.
 */

/** Durations of the replay, in milliseconds. One run for every game length. */
export const PODIUM_TIMING = Object.freeze({
  LEAD: 300,     // a breath before anything moves
  RUN: 3200,     // ALL the regular questions together, whatever their number
  FINAL: 1300,   // the final wager gets its own, slower beat
  SETTLE: 700,   // medals, the headline and the glow arrive
});

/**
 * Each player's running total after every round: index 0 is the start (0),
 * index k is after round k-1, and the LAST entry is after the final wager.
 * Rounds are question_number 0..total-1; the final wager is question_number
 * `total` (the room holds N+1 questions and the final round is number N).
 * A round with no row for somebody is worth nothing to them.
 */
export function cumulativeSeries(answers, playerIds, totalQuestions) {
  const out = {};
  for (const id of playerIds) {
    const per = new Array(totalQuestions + 1).fill(0);
    for (const a of answers || []) {
      if (String(a.player_id) !== String(id)) continue;
      const q = Number(a.question_number);
      if (!Number.isInteger(q) || q < 0 || q > totalQuestions) continue;
      per[q] += Number(a.score_earned) || 0;
    }
    const series = [0];
    for (const s of per) series.push(series[series.length - 1] + s);
    out[id] = series;
  }
  return out;
}

/**
 * Competition ranking ("1, 1, 3"): tied scores share a place, and the next
 * place skips. `sorted` is already in descending score order.
 */
export function rankPlayers(sorted, scoreOf) {
  const ranks = [];
  sorted.forEach((p, i) => {
    const prev = i > 0 ? sorted[i - 1] : null;
    ranks.push(prev && scoreOf(prev) === scoreOf(p) ? ranks[i - 1] : i + 1);
  });
  return ranks;
}

/**
 * The podium: the top three seats, in the order they STAND on screen.
 * Three or more players stand 2nd-1st-3rd, gold in the middle. With two the
 * middle means nothing, so it reads left to right: gold, then silver.
 * `medal` is 1/2/3 from the RANK, so a tie for first is two golds.
 */
export function podiumSlots(sorted, scoreOf) {
  const ranks = rankPlayers(sorted, scoreOf);
  const top = sorted.slice(0, 3).map((player, i) => ({ player, rank: ranks[i], medal: Math.min(3, ranks[i]) }));
  if (top.length === 3) return [top[1], top[0], top[2]];
  return top;
}

/** "1st", "2nd", "3rd", "4th", "11th", "22nd" */
export function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
}

/**
 * One flowing curve through a run of per-question scores. A score only
 * changes once per question, so following the raw points makes every bar ease
 * to a stop at every question — the owner's "choppy". This is a Gaussian blend
 * of the points, pinned so it starts exactly on the first value and lands
 * exactly on the last: nothing in between is shown precisely, and nothing
 * stops. `x` runs from 0 to ys.length - 1.
 */
export function glide(ys, x) {
  const N = ys.length - 1;
  if (N <= 0) return ys[0] || 0;
  const sig = Math.max(1, N / 8);
  const g = (xx) => {
    let a = 0, w = 0;
    for (let k = 0; k <= N; k++) {
      const q = Math.exp(-((xx - k) ** 2) / (2 * sig * sig));
      a += q * ys[k]; w += q;
    }
    return a / w;
  };
  const cx = Math.min(N, Math.max(0, x));
  return g(cx) + (1 - cx / N) * (ys[0] - g(0)) + (cx / N) * (ys[N] - g(N));
}

/**
 * A player's score at replay time `t` (ms from the start of the animation).
 * The regular rounds glide; the final wager carries the bar's momentum in and
 * settles on the final score.
 */
export function replayValueAt(series, t, timing = PODIUM_TIMING) {
  const reg = series.slice(0, -1);
  const N = reg.length - 1;
  const final = series[series.length - 1];
  const tt = t - timing.LEAD;
  if (N <= 0) {
    // A game with no regular rounds: the final wager is the whole race.
    const u = Math.min(1, Math.max(0, (tt - timing.RUN) / timing.FINAL));
    return reg[0] + (final - reg[0]) * u * u * (3 - 2 * u);
  }
  if (tt <= timing.RUN) return glide(reg, Math.max(0, tt) / timing.RUN * N);
  const a = reg[N];
  const eps = 0.02;
  const slope = (glide(reg, N) - glide(reg, N - eps)) / eps * N / timing.RUN * timing.FINAL;
  const u = Math.min(1, (tt - timing.RUN) / timing.FINAL);
  const u2 = u * u, u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a + (u3 - 2 * u2 + u) * slope + (-2 * u3 + 3 * u2) * final;
}

/** When the replay has finished moving. */
export function replayEnd(timing = PODIUM_TIMING) {
  return timing.LEAD + timing.RUN + timing.FINAL;
}

/**
 * How tall a step is above the zero line (`up`) and how far a bar hangs below
 * it (`down`), in px.
 *
 * GOLD IS ALWAYS THE SAME SIZE (the owner's rule): the winner's score maps to
 * `upPx`, and everybody else is in proportion to it. When even the winner is
 * below zero the podium flips: the winner always hangs `downPx`, and everybody
 * else hangs in proportion to THAT. A bar longer than the screen is allowed to
 * run off it — the caller does not clamp.
 *
 * `scale` is the reference positive score for the replay, so a player who led
 * mid-game cannot outgrow the frame: max(winner's final score, anybody's best
 * running total).
 */
export function barSize(value, { winner, scale, upPx, downPx }) {
  const allNeg = winner <= 0;
  if (value >= 0) return { up: scale > 0 ? value / scale * upPx : 0, down: 0 };
  const down = allNeg ? (winner < 0 ? value / winner * downPx : downPx) : -value / Math.max(1, scale) * upPx;
  return { up: 0, down };
}
