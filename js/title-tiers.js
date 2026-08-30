// ============================================
// Oracle Party — Title tier rules
//
// THE SINGLE DEFINITION OF WHAT EARNS A WORD. Designed with the owner on
// 2026-08-29; see "The agreed shape of titles" in CLAUDE.md for why each piece
// is the way it is. Nothing here is wired into gameplay yet — the admin page
// reads it first, so the owner can see which topics qualify and what to write.
//
// NO IMPORTS, deliberately. Everything else in this project that needed unit
// testing pulls the Supabase client from esm.sh somewhere up its import chain,
// and the test runner cannot load that. Same rule as honeycomb.js, radar.js and
// game/bot-logic.js.
// ============================================

/**
 * ONE MEASURE THROUGHOUT: questions you currently get right.
 *
 * Never a percentage of what you have MET. That measure falls when you meet a
 * new question and get it wrong, so a title built on it is taken away for being
 * curious — which is exactly what the old rank formula did.
 */
export const TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/**
 * How big a topic must be before it offers a tier at all.
 *
 * A 30-question topic cannot carry a meaningful 25% word, and 100% of it is not
 * the same achievement as 100% of a 300-question one. Below the floor a topic
 * still counts towards its SUBJECT's words — it just has none of its own.
 */
export const TOPIC_FLOOR = { uncommon: 60, epic: 80, legendary: 100 };

/** The share of a topic you must get right. */
export const TOPIC_SHARE = { uncommon: 0.25, epic: 0.75, legendary: 1.00 };

/**
 * Subject-level words.
 *
 * `common` is the on-ramp — deliberately cheap, because somebody who unlocks
 * nothing in their first month never comes back to unlock anything.
 *
 * `rare` is BREADTH: a share of EVERY topic in the subject, which is different
 * work from going deep in one. Its `floorRight` stops it coming out easier than
 * uncommon in a subject whose topics are all small — without that guard a
 * subject with two 40-question topics would hand out a rare for 20 right.
 *
 * `mythic` is the whole subject, perfectly. No floor needed: it is its own.
 */
export const SUBJECT_RULE = {
  common:  { right: 10 },
  rare:    { everyTopicShare: 0.25, floorRight: 100 },
  mythic:  { share: 1.00 },
};

/**
 * A "miscellaneous" topic carries no words of its own.
 *
 * Several are big enough to qualify — science/misc has 148 askable questions,
 * culture-society/misc has 101 — but a word meaning "you have mastered
 * Miscellaneous" says nothing about what somebody knows, which is the entire
 * job of this column. Their questions still count towards their SUBJECT's
 * words, so nothing is wasted; they just cannot be the thing you wear.
 */
export function isMiscTopic(key) {
  if (!key) return false;
  return key === 'misc' || String(key).endsWith('-misc');
}

/**
 * Which tiers a topic of this size can offer.
 *
 * @param {number} size questions in the topic that the game can actually ASK.
 * @param {string} [key] the topic's key, so a misc topic can be excluded.
 */
export function tiersForTopic(size, key = null) {
  if (isMiscTopic(key)) return [];
  return ['uncommon', 'epic', 'legendary'].filter(t => size >= TOPIC_FLOOR[t]);
}

/**
 * The frozen target for one topic word: how many questions you must get right.
 *
 * FROZEN MEANS COMPUTED ONCE AND STORED. Recomputing this live would move a
 * player's goal backwards every time the bank grew — "13 more to go" becoming
 * "31 more to go" is the worst feeling in a collection. This function is how the
 * number is first arrived at, not how it is read afterwards.
 *
 * Returns null when the topic is too small to offer that tier.
 */
export function topicTarget(size, tier) {
  if (!TOPIC_SHARE[tier]) return null;
  if (size < TOPIC_FLOOR[tier]) return null;
  return Math.ceil(size * TOPIC_SHARE[tier]);
}

/**
 * The frozen targets for a subject's words.
 *
 * `rare` returns a per-topic requirement AND the overall floor, because both
 * must hold: a quarter of every topic, and 100 right in the subject altogether.
 */
export function subjectTargets(subjectSize, topicSizes) {
  const everyTopic = {};
  for (const [key, size] of Object.entries(topicSizes || {})) {
    everyTopic[key] = Math.ceil(size * SUBJECT_RULE.rare.everyTopicShare);
  }
  return {
    common:  SUBJECT_RULE.common.right,
    rare:    { everyTopic, atLeast: SUBJECT_RULE.rare.floorRight },
    mythic:  Math.ceil(subjectSize * SUBJECT_RULE.mythic.share),
  };
}

/**
 * Has this player earned a topic word?
 *
 * ONCE EARNED, KEPT FOREVER — which this function cannot express, because it
 * only sees the present. The caller must never take a word away on a false
 * answer here: a count CAN fall (getting wrong something you used to know), and
 * a collectible that evaporates because you forgot one question is a bad
 * collectible. Store the unlock; do not recompute it as a live truth.
 */
export function meetsTopic(rightInTopic, target) {
  return target != null && rightInTopic >= target;
}

/**
 * The rarity a topic word carries, given which tier slot it fills.
 * Kept as a function so callers never hardcode the mapping.
 */
export function rarityForTopicTier(tier) {
  return tier;
}


/**
 * A PLACEHOLDER'S TEXT, BY RULE — never invented.
 *
 * The owner's format: the tier, then what it is about. "Epic Science",
 * "Legendary Ancient". That is deliberately mechanical: the real words are the
 * owner's to write, and two earlier attempts at model-written title text were
 * deleted at their instruction. A placeholder must read as scaffolding, not as
 * somebody's idea of a good word.
 *
 * CAPPED AT 24 CHARACTERS, because that is what the table allows
 * (title_words_word_check). Truncation happens on a word boundary where one
 * exists, so "Legendary Ancient & Classical" becomes "Legendary Ancient" rather
 * than "Legendary Ancient & Clas".
 */
export const PLACEHOLDER_MAX = 24;

export function placeholderWord(tier, label) {
  const tidy = String(label || '').replace(/\s*&.*$/, '').trim();
  const tierWord = String(tier || '').charAt(0).toUpperCase() + String(tier || '').slice(1);
  const full = `${tierWord} ${tidy}`.trim();
  if (full.length <= PLACEHOLDER_MAX) return full;

  // Drop whole words off the end until it fits; if even the tier alone is too
  // long something is very wrong, so fall back to a hard cut rather than an
  // empty string — a slot with a blank word cannot be saved at all.
  const parts = full.split(/\s+/);
  while (parts.length > 1 && parts.join(' ').length > PLACEHOLDER_MAX) parts.pop();
  const out = parts.join(' ');
  return out.length <= PLACEHOLDER_MAX ? out : full.slice(0, PLACEHOLDER_MAX).trim();
}
