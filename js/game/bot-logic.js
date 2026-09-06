// ============================================
// Oracle Party — Practice Bot Decisions (pure)
//
// Split out from bots.js so it can be unit tested. bots.js reaches the
// database, and the database client is loaded from esm.sh, which the test
// runner cannot resolve — so anything worth testing has to live where nothing
// is imported.
//
// Nothing here talks to anything. Randomness is injected so a test can pin it.
// ============================================

/**
 * Pick a wager the bot has not spent yet.
 *
 * Random among what is left, not the lowest. A human saves their big wagers
 * for questions they feel sure about; a bot with one flat accuracy has no such
 * feeling, so any deterministic rule would be a strategy it does not have.
 * Random is the honest stand-in for "no opinion", and it also stops the bot
 * being readable — one that always burned 1 first would let a player work out
 * their own standing from the bot's wager.
 *
 * Falls back to 1 if every wager is somehow spent, matching
 * findNextAvailableWager. That should be unreachable: the bot answers exactly
 * once per question and there is one wager per question.
 */
/**
 * The lowest wager the bot has not spent.
 *
 * Used when the bot is about to submit a BLANK — which happens when the
 * question carries no stored wrong answer, about 20% of the bank, so roughly
 * one in ten of a bot's rounds. Staking 8 points on an empty answer looks
 * broken, and the owner asked for the minimum instead.
 *
 * Worth being honest about the cost: this makes the bot slightly STRONGER than
 * its flat 50% suggests, because it keeps its big wagers for rounds it can
 * still win. That is accepted deliberately, and it stops here — extending the
 * same logic to every miss, which the bot also knows about in advance, would
 * make it close to unbeatable and would stop being a practice opponent.
 *
 * The same shape as findNextAvailableWager for absent humans, on purpose: a
 * round nobody answered costs the cheapest wager either way.
 */
export function lowestUnusedWager(used, totalQuestions) {
  for (let i = 1; i <= totalQuestions; i++) {
    if (!used.has(i)) return i;
  }
  return 1;
}

export function pickBotWager(used, totalQuestions, rand = Math.random) {
  const available = [];
  for (let i = 1; i <= totalQuestions; i++) {
    if (!used.has(i)) available.push(i);
  }
  if (available.length === 0) return 1;
  return available[Math.floor(rand() * available.length)];
}

/**
 * Decide what a bot types.
 *
 * WRONG ANSWERS ARE NEVER INVENTED. 80% of the question bank still carries the
 * original multiple-choice distractors in `questions.incorrect_answers`, a
 * column nothing else reads. A bot that misses picks one of those. A question
 * with none stored gets an empty string, which the reveal already renders as
 * "No answer" — honest, and visibly different from a wrong guess.
 *
 * Returns { text, isCorrect }. isCorrect is the coin flip itself, not a
 * re-judgement of the text: the host writes it straight to the answer row, so
 * a distractor that happened to fuzzy-match the answer key still counts as the
 * miss it was meant to be.
 */
export function chooseBotAnswer({ correctAnswer = '', incorrectAnswers = [] } = {}, { accuracy = 0.5, rand = Math.random } = {}) {
  if (rand() < accuracy) {
    return { text: correctAnswer || '', isCorrect: true };
  }
  const pool = Array.isArray(incorrectAnswers)
    ? incorrectAnswers.filter(a => typeof a === 'string' && a.trim())
    : [];
  if (pool.length === 0) return { text: '', isCorrect: false };
  return { text: pool[Math.floor(rand() * pool.length)], isCorrect: false };
}

/**
 * HOW GOOD IS THIS BOT AT THIS SUBJECT, as a fraction from 0 to 1.
 *
 * The one place that answers that question, so the chart on a bot's card and
 * the answers it actually gives can never drift apart. Today it is a flat
 * `accuracy` for every category — which is exactly what the bot does, a coin
 * flip on everything — so the card draws an even twelve-sided shape.
 *
 * `strengths` is where per-category numbers will go when they exist. THEY ARE
 * THE OWNER'S TO WRITE: docs/BOTS.md marks the skill table as theirs, and two
 * drafts of model-invented bot numbers have already been deleted at their
 * instruction. This function is the seam that makes adding them a data change
 * rather than a code change — nothing that reads a bot's skill needs to know
 * they arrived.
 *
 * Clamped, because a value outside 0..1 would draw an axis outside the chart's
 * own box and be silently clipped on a phone.
 */
export function botSkillFor(category, accuracy = 0.5, strengths = null) {
  const raw = (strengths && typeof strengths[category] === 'number')
    ? strengths[category]
    : accuracy;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}
