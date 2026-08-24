// ============================================
// Oracle Party — Practice Bots
//
// A bot is a `players` row with is_bot set. It has no browser, so the host's
// device answers on its behalf — the same device that already owns the phase,
// the timer and the judging (see CLAUDE.md #1).
//
// FOUR RULES, and every one of them is a decision the owner made:
//
//   1. Only a human adds or removes a bot, and only from a lobby. There are no
//      bot-only rooms.
//   2. A bot is never host or co-host.
//   3. Nothing a bot does is recorded — not to question_stats, not to
//      answer_tally, not to anyone's game history. Its answers come from a
//      percentage somebody chose, so counting them would put an invented
//      number into the only real data this project has.
//   4. Nobody waits for a bot. It answers the instant the question starts.
//
// WRONG ANSWERS ARE NEVER INVENTED. 80% of the question bank still carries the
// original multiple-choice distractors in `questions.incorrect_answers`, which
// nothing else reads. A bot that misses picks one of those. A question with
// none stored gets a blank — the bot did not know it, and that is the honest
// display for it.
//
// ONE ACCURACY, FOR NOW. BOT_ACCURACY is a coin flip, and that is the whole
// justification: it is the only number that does not pretend to know how hard
// the questions are. Per-category strengths come later, from measured data.
// ============================================

import { state, getCorrectAnswer } from './state.js';
import { logger } from '../logger.js';
import { BOT_ACCURACY, BOT_FINAL_WAGER } from '../constants.js';
import { fetchAllAnswers, insertAnswersIfAbsent, upsertAnswers, botAnswerOnServer } from '../supabase.js';
import { computeScoreEarned } from './scoring-helpers.js';
import { pickBotWager, lowestUnusedWager, chooseBotAnswer } from './bot-logic.js';

/** What the bot needs to know about a question, in the shape bot-logic wants. */
function questionFacts(question) {
  return {
    correctAnswer: getCorrectAnswer(question),
    incorrectAnswers: question.incorrect_answers
  };
}

/** Every bot in the room. */
export function getBots(players = state.players) {
  return (players || []).filter(p => p.is_bot);
}

/** Everyone who is not a bot. Used wherever "is anybody still here" is asked. */
export function getHumans(players = state.players) {
  return (players || []).filter(p => !p.is_bot);
}

/**
 * Wagers each player has already spent, from every answer in the room.
 * Returns Map<playerId, Set<wager>>.
 */
function usedWagersByPlayer(allAnswers) {
  const map = new Map();
  for (const a of allAnswers || []) {
    const key = String(a.player_id);
    if (!map.has(key)) map.set(key, new Set());
    if (a.wager != null) map.get(key).add(a.wager);
  }
  return map;
}

/**
 * Answer the current question for every bot in the room.
 *
 * Host only. Every device runs this file, and the host is the one device that
 * already decides when the question starts — see CLAUDE.md #1. The write goes
 * through insertAnswersIfAbsent (ON CONFLICT DO NOTHING), so if a co-host or a
 * deputy ever reaches this too, the first answer stands and the second is a
 * no-op instead of the bot's answer changing under everyone.
 *
 * Deliberately NOT used for the final question: that row already exists as the
 * __WAGER_LOCKED__ placeholder, and DO NOTHING would leave the placeholder in
 * place. lockBotFinalWagers / answerFinalQuestionForBots handle that round.
 */
export async function answerQuestionForBots() {
  const bots = getBots();
  if (bots.length === 0) return;
  if (!state.room?.isHost) return;
  if (state.isFinalWagerRound) return;

  const question = state.questions[state.currentQuestion];
  if (!question) return;

  const allAnswers = await fetchAllAnswers(state.room.id);
  const spent = usedWagersByPlayer(allAnswers);
  const alreadyAnswered = new Set(
    allAnswers
      .filter(a => a.question_number === state.currentQuestion)
      .map(a => String(a.player_id))
  );

  const rows = [];
  for (const bot of bots) {
    if (alreadyAnswered.has(String(bot.id))) continue;
    // Answer first, then wager: a BLANK takes the cheapest wager left rather
    // than a random one. A blank is not the bot being unsure — it is the
    // question having no stored wrong answer to give it — but staking 8 points
    // on an empty box looks broken, and the owner chose the minimum.
    const { text, isCorrect } = chooseBotAnswer(questionFacts(question), { accuracy: BOT_ACCURACY });
    const used = spent.get(String(bot.id)) || new Set();
    const wager = text.trim()
      ? pickBotWager(used, state.totalQuestions)
      : lowestUnusedWager(used, state.totalQuestions);
    rows.push({
      roomId: state.room.id,
      playerId: bot.id,
      questionNumber: state.currentQuestion,
      questionId: question.id,
      wager,
      submittedAnswer: text,
      isCorrect,
      scoreEarned: computeScoreEarned(isCorrect, wager, false)
    });
  }

  if (rows.length === 0) return;
  const { error } = await insertAnswersIfAbsent(rows, 'answerQuestionForBots');
  if (error) logger.warn('Bots', 'Could not answer for bots', error);
}

/**
 * Lock a final wager for every bot, as the __WAGER_LOCKED__ placeholder every
 * player writes, so the final wager list shows the bot alongside everyone else
 * instead of a permanent "Waiting...".
 *
 * The bot always wagers BOT_FINAL_WAGER. The owner set this to 20 — the bot
 * goes all in every time. It is not a read on the question (it has none); it
 * makes the last round of a practice game actually swing, which a permanent
 * middle stake never does.
 */
export async function lockBotFinalWagers() {
  const bots = getBots();
  if (bots.length === 0) return;
  if (!state.room?.isHost) return;

  const question = state.questions[state.totalQuestions];
  const rows = bots.map(bot => ({
    roomId: state.room.id,
    playerId: bot.id,
    questionNumber: state.totalQuestions,
    questionId: question ? question.id : null,
    wager: BOT_FINAL_WAGER,
    submittedAnswer: '__WAGER_LOCKED__',
    isCorrect: false,
    scoreEarned: 0
  }));

  const { error } = await insertAnswersIfAbsent(rows, 'lockBotFinalWagers');
  if (error) logger.warn('Bots', 'Could not lock final wagers for bots', error);
}

/**
 * Answer the final question for every bot.
 *
 * Separate from answerQuestionForBots because this round is the one place a
 * bot's row already exists — lockBotFinalWagers wrote the placeholder — so the
 * write has to MERGE over it rather than do nothing. That means it must run on
 * exactly one device, which is why it is gated on the real host rather than
 * canControlGame(): two devices merging different coin flips would show the
 * room two different answers.
 */
export async function answerFinalQuestionForBots() {
  const bots = getBots();
  if (bots.length === 0) return;
  if (!state.room?.isHost) return;

  const question = state.questions[state.totalQuestions];
  if (!question) return;

  const allAnswers = await fetchAllAnswers(state.room.id);
  const finalRows = new Map(
    allAnswers
      .filter(a => a.question_number === state.totalQuestions)
      .map(a => [String(a.player_id), a])
  );

  const rows = [];
  for (const bot of bots) {
    const existing = finalRows.get(String(bot.id));
    // Already answered for real — never overwrite it.
    if (existing && existing.submitted_answer !== '__WAGER_LOCKED__') continue;
    const wager = existing ? existing.wager : BOT_FINAL_WAGER;
    const { text, isCorrect } = chooseBotAnswer(questionFacts(question), { accuracy: BOT_ACCURACY });
    rows.push({
      roomId: state.room.id,
      playerId: bot.id,
      questionNumber: state.totalQuestions,
      questionId: question.id,
      wager,
      submittedAnswer: text,
      isCorrect,
      scoreEarned: computeScoreEarned(isCorrect, wager, true)
    });
  }

  if (rows.length === 0) return;

  // Through the server (051) rather than a direct upsert. The upsert merges over
  // the bot's __WAGER_LOCKED__ placeholder, which is an UPDATE, and 049 shut
  // UPDATE on `answers` — so this had stopped working silently and a bot simply
  // never answered the last question of any game.
  let unavailable = false;
  for (const row of rows) {
    const { ok, unavailable: missing } = await botAnswerOnServer(row);
    if (missing) { unavailable = true; break; }
    if (!ok) logger.warn('Bots', 'the server would not take that bot answer', row.playerId);
  }

  if (unavailable) {
    const { error } = await upsertAnswers(rows, 'answerFinalQuestionForBots');
    if (error) logger.warn('Bots', 'Could not answer the final question for bots', error);
  }
}
