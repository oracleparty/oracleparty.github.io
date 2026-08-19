// ============================================
// Oracle Party — Bot roster
//
// Definitions only. No behaviour lives here: nothing in this file answers a
// question, joins a room or writes to the database. It is a table of numbers
// somebody chose, so it can be read and argued with on its own.
//
// See docs/BOTS.md for the reasoning behind every decision below. The parts
// that matter most:
//
//   - A bot's wrong answers come from questions.incorrect_answers, the
//     original multiple-choice distractors that 80% of the bank still carries
//     and nothing has read since the game moved to typed answers. Nothing a
//     bot says is generated.
//   - Skill is per category, then adjusted by each question's difficulty.
//   - Bots are never host or co-host, are only added by a human, and are
//     always visibly bots.
// ============================================

/**
 * How much the stored difficulty moves a bot's odds, in percentage points.
 *
 * A bot with 70% in a category lands near 82% on an easy question and 55% on a
 * hard one. Deliberately gentler than it could be: pushed harder, a weak bot
 * never gets an easy question wrong and a strong one never gets a hard one
 * right, and both stop being surprising. Tune once it can be felt in play.
 */
export const DIFFICULTY_SHIFT = { easy: +12, medium: 0, hard: -15 };

/** Nothing is ever a certainty, in either direction. */
export const SKILL_FLOOR = 3;
export const SKILL_CEILING = 97;

/**
 * Wager habits.
 *
 * The wager rule is that values 1..N are each spent exactly once, so the only
 * real decision is WHEN to spend the big ones. That is the whole strategy of
 * the game, and it is where a bot's character shows without a word being said.
 */
export const WAGER_STYLE = {
  // Dumps the big numbers early, then has nothing left to bet late. Exciting
  // to play against and usually a mistake.
  reckless: { description: 'spends high wagers early', bias: 'high' },
  // Hoards the big numbers for questions it is confident about. Quietly the
  // strongest play, which is why the hardest bot uses it.
  cautious: { description: 'saves high wagers for its strong categories', bias: 'confident' },
  // No plan at all.
  erratic: { description: 'picks at random', bias: 'random' },
};

/**
 * Typing styles, applied to whichever answer the bot has chosen.
 *
 * This matters more than it sounds: every answer is read aloud off the reveal
 * screen, and "hanging gardens of babylon" in lowercase reads as a person in a
 * hurry, while perfect capitalisation every time reads as a machine. Fuzzy
 * matching already tolerates all of it, so none of this changes whether an
 * answer is judged correct.
 */
export const TYPING_STYLE = {
  clean: { lowercase: false, typoChance: 0 },
  casual: { lowercase: true, typoChance: 0 },
  sloppy: { lowercase: true, typoChance: 0.18 },
};

/**
 * Honk profiles.
 *
 * The honk is already in the game and needs nothing written, which makes it a
 * better first personality channel than chat: it cannot repeat itself into
 * being annoying, and it carries tone without words.
 *
 * `chance` is the probability of honking when a trigger fires, so the same
 * trigger reads differently per bot — Pip honking at everything is excitable,
 * The Archivist honking once a game means something happened.
 *
 * Triggers:
 *   nailedIt       this bot got one right in a category it is strong in
 *   humanNailedIt  a HUMAN got a hard question right — applause, not gloating
 *   blewIt         this bot got one wrong having staked a high wager
 *   lostLead       this bot was top of the scoreboard and no longer is
 */
export const HONK_PROFILE = {
  // Dignified. Applauds a genuinely hard answer and almost nothing else.
  reserved: { nailedIt: 0.05, humanNailedIt: 0.45, blewIt: 0.05, lostLead: 0.10 },
  // Ordinary enthusiasm.
  warm: { nailedIt: 0.30, humanNailedIt: 0.35, blewIt: 0.20, lostLead: 0.25 },
  // Honks at everything, mostly at itself.
  excitable: { nailedIt: 0.70, humanNailedIt: 0.55, blewIt: 0.60, lostLead: 0.50 },
  // Barely ever. When it does, everyone notices.
  glacial: { nailedIt: 0.02, humanNailedIt: 0.25, blewIt: 0.02, lostLead: 0.15 },
};

/**
 * The roster.
 *
 * Six, spread deliberately: two specialists with real blind spots, two
 * middling all-rounders, one genuinely hard, one genuinely easy. `base` is the
 * chance in any category not listed in `skills`.
 *
 * The blind spots are the point. A bot that is simply "70% at everything" is a
 * difficulty slider; a bot that knows its history and is hopeless at pop
 * culture is someone to play against, and it makes the category you pick a
 * real decision.
 *
 * `speed` is seconds before answering, picked randomly in that range each
 * round. Nobody answers instantly — a bot that submits in 0.4s every time is
 * unmistakably a machine, and worse, it ends the round before anyone has read
 * the question.
 *
 * `debut: true` marks the three that ship first. Six is a lot to get right
 * without having played against any of them, and these three span the whole
 * range — weakest to strongest, fastest to slowest, sloppiest to cleanest — so
 * the contrast is obvious immediately. The other three are written and waiting;
 * they turn on once the first three have been played and tuned.
 */
export const BOT_ROSTER = [
  {
    id: 'wick',
    name: 'Professor Wick',
    emoji: '🎩',
    color: '#7C5CC2',
    blurb: 'Knows every date and no films made after 1975.',
    base: 45,
    skills: {
      'history': 92, 'arts-literature': 85, 'culture-society': 74,
      'world-geography': 62, 'science': 55,
      'pop-culture': 12, 'technology': 18, 'sports': 20,
    },
    speed: [6, 14],
    wagerStyle: 'cautious',
    typing: 'clean',
    honk: 'reserved',
    debut: true,
  },
  {
    id: 'nia',
    name: 'Nia',
    emoji: '🎧',
    color: '#C25C8D',
    blurb: 'Fast, online, and has never heard of the Treaty of Utrecht.',
    base: 48,
    skills: {
      'pop-culture': 88, 'technology': 80, 'food': 70, 'logic': 60,
      'history': 20, 'arts-literature': 28, 'nature': 35,
    },
    speed: [3, 8],
    wagerStyle: 'reckless',
    typing: 'casual',
    honk: 'warm',
  },
  {
    id: 'marisol',
    name: 'Marisol',
    emoji: '🌿',
    color: '#5CC27C',
    blurb: 'Field biologist. Ask her about anything with a coastline.',
    base: 50,
    skills: {
      'nature': 90, 'world-geography': 84, 'science': 76, 'food': 58,
      'sports': 18, 'pop-culture': 25, 'technology': 30,
    },
    speed: [5, 12],
    wagerStyle: 'cautious',
    typing: 'clean',
    honk: 'warm',
  },
  {
    id: 'bo',
    name: 'Bo',
    emoji: '⚽',
    color: '#C2A85C',
    blurb: 'Encyclopaedic on the 1998 World Cup. Less so on photosynthesis.',
    base: 42,
    skills: {
      'sports': 91, 'food': 72, 'pop-culture': 66,
      'science': 15, 'logic': 22, 'arts-literature': 18, 'technology': 28,
    },
    speed: [4, 9],
    wagerStyle: 'erratic',
    typing: 'sloppy',
    honk: 'excitable',
  },
  {
    id: 'archivist',
    name: 'The Archivist',
    emoji: '📚',
    color: '#4A5568',
    blurb: 'No blind spots. Takes its time. Beat this one and mean it.',
    base: 78,
    skills: {
      'history': 86, 'science': 84, 'arts-literature': 82,
      'logic': 80, 'pop-culture': 62, 'sports': 60,
    },
    speed: [8, 17],
    wagerStyle: 'cautious',
    typing: 'clean',
    honk: 'glacial',
    debut: true,
  },
  {
    id: 'pip',
    name: 'Pip',
    emoji: '🐣',
    color: '#5C8DC2',
    blurb: 'Answers first, thinks later. Occasionally right by accident.',
    base: 28,
    skills: {
      'pop-culture': 42, 'food': 40, 'wild-card': 35,
      'history': 15, 'science': 14, 'logic': 12,
    },
    speed: [2, 5],
    wagerStyle: 'reckless',
    typing: 'sloppy',
    honk: 'excitable',
    debut: true,
  },
];

/** The bots offered in the lobby today. */
export function debutBots() {
  return BOT_ROSTER.filter(b => b.debut);
}

/**
 * Whether a bot honks at something that just happened.
 *
 * Called per trigger, per bot. Kept pure so it can be tested without a game
 * running; the caller supplies the roll.
 */
export function shouldHonk(bot, trigger, roll = Math.random()) {
  const profile = HONK_PROFILE[bot?.honk];
  if (!profile) return false;
  const chance = profile[trigger];
  if (chance == null) return false;
  return roll < chance;
}

/** Look a bot up by its id. */
export function getBot(id) {
  return BOT_ROSTER.find(b => b.id === id) || null;
}

/**
 * A bot's chance of answering a given question correctly, as a percentage.
 *
 * Category skill first, then shifted by the question's stored difficulty, then
 * clamped so nothing is ever certain either way.
 */
export function botAccuracy(bot, category, difficulty) {
  if (!bot) return 0;
  const skill = (bot.skills && bot.skills[category] != null) ? bot.skills[category] : bot.base;
  const shift = DIFFICULTY_SHIFT[difficulty] ?? 0;
  return Math.min(SKILL_CEILING, Math.max(SKILL_FLOOR, skill + shift));
}

/**
 * A one-line summary of what a bot is good and bad at, for the lobby and for
 * the leaderboard yardstick band.
 *
 * Stating the skill out loud is deliberate: a bot's accuracy is a number
 * somebody typed rather than something it achieved, so hiding it would let it
 * be mistaken for an achievement.
 */
export function describeBot(bot, categoryLabels = {}) {
  if (!bot) return '';
  const entries = Object.entries(bot.skills || {});
  if (entries.length === 0) return `${bot.base}% everywhere`;
  const best = entries.reduce((a, b) => (b[1] > a[1] ? b : a));
  const worst = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  const label = k => categoryLabels[k] || k;
  return `strong at ${label(best[0])} (${best[1]}%), weak at ${label(worst[0])} (${worst[1]}%)`;
}
