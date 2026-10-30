// ============================================
// Oracle Party — Title tier rules
//
// THE SINGLE DEFINITION OF WHAT EARNS A WORD. Designed with the owner on
// 2026-08-29; see "The agreed shape of titles" in CLAUDE.md for why each piece
// is the way it is. Revised with the owner on 2026-10-30: Rare is half of one
// topic, goals follow the topic's real size, and Uncommon / Rare / Epic are
// capped at 25 / 100 / 250.
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
 * A 30-question topic cannot carry a meaningful word, and 100% of it is not the
 * same achievement as 100% of a 300-question one. Below the floor a topic still
 * counts towards its SUBJECT's words — it just has none of its own.
 *
 * Owner's numbers (2026-10-30): 60 / 70 / 80 / 100 — each harder step needs a
 * bigger topic.
 */
export const TOPIC_FLOOR = { uncommon: 60, rare: 70, epic: 80, legendary: 100 };

/** The share of a topic you must get right. A quarter, half, three quarters, all. */
export const TOPIC_SHARE = { uncommon: 0.25, rare: 0.50, epic: 0.75, legendary: 1.00 };

/**
 * The most a step can ever ask, however big its topic grows (owner, 2026-10-30).
 *
 * Goals follow the topic's REAL size, so adding questions raises them. The caps
 * keep the easier words reachable: a quarter of a 400-question topic would be
 * 100 right, which is no longer an "uncommon" word. You earn it at whichever
 * comes first — the share or the cap. Legendary and Mythic have no cap; they
 * are meant to be the hard ones.
 */
export const TOPIC_CAP = { uncommon: 25, rare: 100, epic: 250 };

/**
 * Subject-level words.
 *
 * `common` is the on-ramp — deliberately cheap, because somebody who unlocks
 * nothing in their first month never comes back to unlock anything. Always 10.
 *
 * `mythic` is the whole subject, perfectly.
 *
 * Rare used to live here as "a quarter of EVERY topic" — the owner found it the
 * odd one out (the middle step with the fewest words) and moved it onto the
 * topic ladder as "half of one topic" on 2026-10-30.
 */
export const SUBJECT_RULE = {
  common:  { right: 10 },
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
  return ['uncommon', 'rare', 'epic', 'legendary'].filter(t => size >= TOPIC_FLOOR[t]);
}

/**
 * How many questions right a topic word asks for, at the topic's size TODAY.
 *
 * LIVE, ON THE OWNER'S INSTRUCTION (2026-10-30). This used to be frozen when a
 * word was written; the owner's rule is that the goal follows how many
 * questions there really are, with TOPIC_CAP keeping the easier steps
 * reachable. A word already earned is kept forever — only the goal for people
 * still climbing moves.
 *
 * Returns null when the topic is too small to offer that tier.
 */
export function topicTarget(size, tier) {
  if (!TOPIC_SHARE[tier]) return null;
  if (!(size >= TOPIC_FLOOR[tier])) return null;
  const share = Math.ceil(size * TOPIC_SHARE[tier]);
  const cap = TOPIC_CAP[tier];
  return cap ? Math.min(share, cap) : share;
}

/** The targets for a subject's own words: Common and Mythic. */
export function subjectTargets(subjectSize) {
  return {
    common:  SUBJECT_RULE.common.right,
    mythic:  Math.ceil(subjectSize * SUBJECT_RULE.mythic.share),
  };
}

/**
 * The live target for a word, given today's topic sizes, or null when the
 * sizes do not say (not loaded, a topic too small, a tier with no rule).
 *
 * `sizes` is the shape shapeTopicSizes returns. Common is always its fixed 10,
 * so it never needs a size.
 */
export function liveTarget(sizes, category, subcategory, tier) {
  if (tier === 'common') return SUBJECT_RULE.common.right;
  const subject = sizes?.[category];
  if (!subject) return null;
  if (!subcategory) {
    if (tier !== 'mythic' || !(subject.subjectSize >= 1)) return null;
    return subjectTargets(subject.subjectSize).mythic;
  }
  const size = subject.sizes?.[subcategory];
  if (size == null) return null;
  return topicTarget(size, tier);
}

/**
 * Turn get_topic_sizes rows into { category: { subjectSize, sizes: { key: n } } }.
 *
 * A topic's size is every stored subcategory that STARTS WITH its key, because
 * that is how the game picks questions (`LIKE 'key%'`) — `human` includes
 * `human-countries`. `topicKeysFor(category)` lists the keys to measure, so this
 * module needs no imports.
 */
export function shapeTopicSizes(rows, categories, topicKeysFor) {
  const out = {};
  for (const cat of categories) {
    const mine = (rows || []).filter(r => r.category === cat);
    const sizes = {};
    for (const key of topicKeysFor(cat)) {
      sizes[key] = mine.reduce((n, r) =>
        (r.subcategory && String(r.subcategory).startsWith(key) ? n + Number(r.n || 0) : n), 0);
    }
    out[cat] = { subjectSize: mine.reduce((n, r) => n + Number(r.n || 0), 0), sizes };
  }
  return out;
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

// ============================================
// THE RANK LADDER (owner, 2026-10-30)
//
// A subject's RANK is simply the highest step reached in it, by the same rules
// that earn its words. It replaces the old accuracy x log2(questions) formula,
// which nobody — the owner included — could follow. One ladder, one set of
// rules, and the rank word says which step it is:
//
//   Caveman, Hermit, Hippie, Pilgrim, Guru, Oracle
//
// A journey towards wisdom: stuck in the cave, thinking in the cave, out
// seeking, on the sacred road, the one people travel to, the source.
// ============================================

export const RANK_TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

export const RANK_WORDS = {
  common: 'Caveman', uncommon: 'Hermit', rare: 'Hippie',
  epic: 'Pilgrim', legendary: 'Guru', mythic: 'Oracle',
};

/**
 * Where somebody stands in ONE subject.
 *
 * @param {object} p
 * @param {number} p.subjectRight   questions they currently get right in it
 * @param {number|null} p.subjectSize askable questions in it, or null if unknown
 * @param {Array<{key:string,size:number,right:number}>} p.topics
 * @returns {{ index:number, tier:string|null, next:{tier:string, needed:number}|null }}
 *
 * index is -1 for no rank yet. `next` is the nearest step ABOVE the current
 * one that the subject actually offers, and how many more right it would take
 * on the cheapest road there. A step no topic is big enough to offer is
 * skipped rather than reported as unreachable — it simply is not on this
 * subject's ladder yet.
 *
 * Sizes unknown (migration 078 not reachable) means only Common can be judged,
 * because every other step is a share of something we cannot see. That is the
 * harmless direction: a rank shown too low, never one that was not earned.
 */
export function subjectRank({ subjectRight = 0, subjectSize = null, topics = [] } = {}) {
  const words = (topics || []).filter(t => !isMiscTopic(t.key));
  const cost = (tier) => {
    if (tier === 'common') return Math.max(0, SUBJECT_RULE.common.right - subjectRight);
    if (tier === 'mythic') {
      return subjectSize >= 1 ? Math.max(0, subjectSize - subjectRight) : null;
    }
    let best = null;
    for (const t of words) {
      const target = topicTarget(t.size, tier);
      if (target == null) continue;
      const need = Math.max(0, target - (t.right || 0));
      if (best == null || need < best) best = need;
    }
    return best;
  };

  let index = -1;
  const costs = RANK_TIERS.map(cost);
  costs.forEach((c, i) => { if (c === 0) index = i; });

  let next = null;
  for (let i = index + 1; i < RANK_TIERS.length; i++) {
    if (costs[i] != null && costs[i] > 0) { next = { tier: RANK_TIERS[i], needed: costs[i] }; break; }
  }
  return { index, tier: index >= 0 ? RANK_TIERS[index] : null, next };
}

/**
 * The highest rank that may sit beside a reel-2 word (owner, 2026-10-30): a
 * rank only goes as high as your step in THAT word's subject, so "Organelle
 * Oracle" means you really did conquer Science.
 *
 * @param {Object<string,number>} rankIndexBySubject
 * @param {string|null} subject  the reel-2 word's subject, or null for none
 */
export function rankCapFor(rankIndexBySubject, subject) {
  const all = Object.values(rankIndexBySubject || {});
  if (!subject) return all.length ? Math.max(...all) : -1;
  return rankIndexBySubject?.[subject] ?? -1;
}
