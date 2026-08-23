// ============================================
// Oracle Party — how hard was that question, really?
//
// NO IMPORTS, so this is unit-testable in Node. Everything around it pulls the
// Supabase client from esm.sh, which the test runner cannot load.
//
// TWO SOURCES, AND THE SWITCH BETWEEN THEM IS THE WHOLE DESIGN.
//
// Every one of the 4,859 questions carries a `difficulty` from the original
// import, so there is something honest to show from the very first game. What
// there is NOT, yet, is play data: the last probe read game_plays at 9 rows.
// A percentage from two plays is noise wearing a number's clothes, and the
// owner said so before I did.
//
// So: show the STORED difficulty until a question has been played enough times
// to speak for itself, then show what actually happened. The player never sees
// an empty slot and never sees a number built on nothing, and the changeover
// needs no migration and no announcement — it just gets truer as people play.
//
// COUNTED OVER EVERY PLAY, REPEATS INCLUDED. That is the owner's call and it
// is also what question_stats already records, so the measure and the store
// agree without anything being reinterpreted. Somebody meeting a question for
// the second time and getting it right is evidence that it is gettable.
// ============================================

// Below this, a percentage is not worth printing. 20 matches
// MIN_QUESTIONS_FOR_TITLE — this project's existing answer to "how much is
// enough to say something" — and a high threshold costs nothing here, because
// the stored difficulty covers everything underneath it. The only price of
// waiting is that the switch happens later.
export const MIN_PLAYS_FOR_MEASURED_DIFFICULTY = 20;

// Measured bands. Four, because "Very Hard" is a real thing a question can be
// and the stored scale (easy/medium/hard) has no room for it — which is part
// of why measuring is worth doing at all.
const BANDS = [
  { min: 0.75, label: 'Easy' },
  { min: 0.50, label: 'Medium' },
  { min: 0.25, label: 'Hard' },
  { min: 0,    label: 'Very Hard' },
];

const STORED_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

/**
 * What to show for one question.
 *
 * → { label, detail, measured, plays } or null when there is nothing to say.
 *
 *   label     'Easy' | 'Medium' | 'Hard' | 'Very Hard'
 *   detail    the supporting line, or '' — only ever present when measured
 *   measured  true when this came from real plays rather than the stored value
 *   plays     how many plays it is based on, 0 when stored
 *
 * Returns null rather than guessing when a question carries no stored
 * difficulty AND has not been played enough. An empty slot is honest; a made-up
 * word is not.
 */
export function describeDifficulty({ storedDifficulty, timesAsked, timesCorrect } = {}) {
  const asked = Number(timesAsked) || 0;
  const correct = Number(timesCorrect) || 0;

  if (asked >= MIN_PLAYS_FOR_MEASURED_DIFFICULTY) {
    // Clamped: a host flipping judgements can in principle push times_correct
    // above times_asked, and a ratio over 1 would fall out of the bands and
    // render nothing.
    const rate = Math.max(0, Math.min(1, correct / asked));
    const band = BANDS.find(b => rate >= b.min) || BANDS[BANDS.length - 1];
    const pct = Math.round(rate * 100);
    return {
      label: band.label,
      // The sample is part of the claim. "12%" and "12% of 20 plays" are
      // different statements and must not be printed as if they were the same.
      detail: `${pct}% get this right, from ${asked} plays`,
      measured: true,
      plays: asked,
    };
  }

  const stored = STORED_LABELS[String(storedDifficulty || '').toLowerCase()];
  if (!stored) return null;
  return { label: stored, detail: '', measured: false, plays: asked };
}
