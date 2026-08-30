import { supabase } from './client.js';
import { logger } from '../logger.js';
import { PROFILE_SEARCH_LIMIT, PROFILE_TAG_CANDIDATES, MIN_HOST_RATINGS } from '../constants.js';
import { pickProfileByTag } from '../utils.js';

// ============================================
// PROFILES & AUTH HELPERS
// ============================================

/**
 * Generate an unused 4-digit discriminator for a display name.
 */
export async function generateDiscriminator(displayName) {
  const wanted = (displayName || '').trim().toLowerCase();
  for (let attempt = 0; attempt < 25; attempt++) {
    const disc = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    // KEYED ON THE DISCRIMINATOR, and the name compared here.
    //
    // This used to filter `.eq('display_name', displayName)` — case-SENSITIVE —
    // while fetchProfileByTag looked the same person up case-INSENSITIVELY.
    // Two halves of one rule disagreeing, which is the shape this codebase
    // keeps producing: "Alice" and "alice" could both be handed #1234, because
    // neither uniqueness check could see the other, and from that moment
    // NEITHER of them could be found by tag at all.
    const { data, error } = await supabase
      .from('profiles')
      .select('display_name')
      .eq('discriminator', disc)
      .limit(PROFILE_TAG_CANDIDATES);
    // A FAILED READ IS NOT AN ABSENT ROW. The old code destructured `data`
    // only, so any error — a network blip, a refusal — left it undefined and
    // this handed out a discriminator that may well be taken. Trying another is
    // free; handing out a duplicate is permanent.
    if (error) continue;
    const taken = (data || []).some(r => (r.display_name || '').trim().toLowerCase() === wanted);
    if (!taken) return disc;
  }
  // Fallback: find any unused discriminator
  const { data: taken } = await supabase
    .from('profiles')
    .select('discriminator')
    .eq('display_name', displayName);
  const takenSet = new Set((taken || []).map(r => r.discriminator));
  for (let i = 0; i < 10000; i++) {
    const disc = String(i).padStart(4, '0');
    if (!takenSet.has(disc)) return disc;
  }
  return null;
}

/**
 * Create a profile row for a newly registered user.
 */
export async function createProfile(userId, displayName, discriminator) {
  const { data, error } = await supabase
    .from('profiles')
    .insert({ user_id: userId, display_name: displayName, discriminator })
    .select()
    .single();

  if (error) {
    logger.error('Supabase', 'createProfile failed', error);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Fetch a profile by user_id.
 */
export async function fetchProfile(userId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    logger.error('Supabase', 'fetchProfile failed', error);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Fetch a profile by display_name + discriminator.
 */
export async function fetchProfileByTag(displayName, discriminator) {
  // NO PATTERN LANGUAGE IN THE QUERY AT ALL. The old version was
  // `.ilike('display_name', displayName).maybeSingle()`, and both halves were
  // hazards — measured against a real Postgres, not assumed:
  //
  //   ILIKE 'Bob_1'  matches Bob_1 AND Bob01. `_` is a single-character
  //                  wildcard and display names have no character restriction,
  //                  so looking up a friend by tag could return a DIFFERENT
  //                  PERSON, silently, and you would send them the request.
  //   ILIKE 'Alice'  matches alice too, so a case-variant pair sharing a
  //                  discriminator made this return two rows.
  //
  // and maybeSingle() ERRORS on more than one row, so either collision made
  // this return null — which the friend search renders as "No results found"
  // for somebody who exists. Worse, the search box's OTHER path (partial,
  // "Name#") uses a LIKE with wildcards and finds them perfectly well, so the
  // full tag failed while the shorter query worked: an inconsistency nobody
  // could report usefully.
  //
  // Keyed on the discriminator with `.eq` instead, and the name matched in JS
  // by pickProfileByTag. That removes the wildcard hazard rather than escaping
  // around it, and does not depend on how PostgREST passes a backslash through
  // to ILIKE — which is exactly the kind of thing this project has been burned
  // assuming (CLAUDE.md #10).
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('discriminator', discriminator)
    .limit(PROFILE_TAG_CANDIDATES);

  if (error) {
    logger.error('Supabase', 'fetchProfileByTag failed', error);
    return { data: null, error };
  }
  return { data: pickProfileByTag(data, displayName), error: null };
}

/**
 * Partial update of a profile.
 */
export async function updateProfile(userId, fields) {
  const { data, error } = await supabase
    .from('profiles')
    .update(fields)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) {
    logger.error('Supabase', 'updateProfile failed', error);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Fetch all player stats for a user (per-category stats).
 * Reads from computed view (derived from question_history + game_history).
 */
export async function fetchPlayerStats(userId) {
  const { data, error } = await supabase
    .from('player_stats_computed')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    logger.error('Supabase', 'fetchPlayerStats failed', error);
    return [];
  }
  return data || [];
}

/**
 * Fetch player stats for multiple users in one query (batch).
 * Reads from computed view (derived from question_history + game_history).
 */
export async function fetchPlayerStatsBatch(userIds) {
  if (!userIds || userIds.length === 0) return [];
  const { data, error } = await supabase
    .from('player_stats_computed')
    .select('*')
    .in('user_id', userIds);
  if (error) { logger.error('Supabase', 'fetchPlayerStatsBatch failed', error); return []; }
  return data || [];
}

/**
 * Fetch recent game history for a user.
 */
export async function fetchGameHistory(userId, limit = 5) {
  const { data, error } = await supabase
    .from('game_history')
    .select('*')
    .eq('user_id', userId)
    .order('played_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error('Supabase', 'fetchGameHistory failed', error);
    return [];
  }
  return data || [];
}

/**
 * Insert a game_history entry when a game completes.
 */
export async function insertGameHistoryEntry({ userId, roomId, category, subcategory, score, placement, totalPlayers }) {
  const row = {
    user_id: userId,
    room_id: roomId,
    category,
    score,
    placement,
    total_players: totalPlayers
  };
  if (subcategory) row.subcategory = subcategory;
  const { error } = await supabase.from('game_history').insert(row);
  if (error) logger.error('Supabase', 'insertGameHistoryEntry failed', error);
}

/**
 * Search profiles by display name (ILIKE), with optional discriminator filter.
 */
export async function searchProfiles(query, excludeUserId, discriminator = null) {
  let q = supabase
    .from('profiles')
    .select('*')
    .ilike('display_name', `%${query}%`)
    .neq('user_id', excludeUserId)
    .limit(PROFILE_SEARCH_LIMIT);

  if (discriminator) {
    q = q.eq('discriminator', discriminator);
  }

  const { data, error } = await q;

  if (error) {
    logger.error('Supabase', 'searchProfiles failed', error);
    return [];
  }
  return data || [];
}

// ============================================
// HOST REPUTATION (migration 054)
//
// "Would you play with this host again?" — read BEFORE joining a stranger's
// room, which is the whole reason it exists. Not "was the host correct": nobody
// can answer that about a ruling on their own answer, and a board that asked
// would reward lenient hosts and punish accurate ones.
// ============================================

/**
 * Record this player's verdict on the host of this game.
 *
 * → { ok, reason } — `reason` names a refusal that is NOT a failure, most often
 *   'host has no account', which is the ordinary case in a game among friends
 *   and must never be shown as an error.
 *
 * Everything goes through op_rate_host rather than a direct insert: the table
 * has no write policy at all, so a request crafted by hand cannot bury a
 * stranger whose game the sender was never in.
 */
export async function rateHost({ roomId, playerId, voterId, rating = null, flagReason = null, flagNote = null }) {
  if (!roomId || !playerId || !voterId) return { ok: false, reason: 'missing context' };
  const { data, error } = await supabase.rpc('op_rate_host', {
    p_room_id: roomId,
    p_player_id: playerId,
    p_voter_id: voterId,
    p_rating: rating,
    p_flag_reason: flagReason,
    p_flag_note: flagNote,
  });
  if (error) {
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) {
      logger.debug('Supabase', 'op_rate_host not installed, host ratings are off');
      return { ok: false, reason: 'not installed' };
    }
    logger.error('Supabase', 'op_rate_host failed', error);
    return { ok: false, reason: 'failed' };
  }
  return { ok: data === 'ok', reason: data === 'ok' ? null : String(data || 'refused') };
}

/**
 * Reputations for a batch of host user ids → Map(user_id → row).
 *
 * A host with NO rows is absent from the map, and callers must render that as
 * "no rating yet" rather than 0%. An unrated host and a disliked one must never
 * look alike — the same rule the admin panel counts follow, where a failed
 * count renders "?" and never "0".
 */
let _hostRatingsAvailable = true;

/**
 * Is the host-rating feature actually installed?
 *
 * FALSE ONLY AFTER A READ HAS FAILED, so it starts optimistic and cannot hide
 * the feature on a cold start. This exists because migrations here are pasted
 * by hand: without it, deploying the JavaScript before migration 054 would put
 * three buttons on the reveal screen that light up when tapped and record
 * NOTHING — a player believing they had rated somebody when they had not,
 * which is the silent-failure shape this whole codebase is built out of.
 */
export function hostRatingsAvailable() { return _hostRatingsAvailable; }

export async function fetchHostReputations(userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from('host_reputation')
    .select('*')
    .in('host_user_id', ids);
  if (error) {
    // PGRST205 is "no such relation" — migration 054 has not been run. Anything
    // else is a transient failure and must NOT switch the feature off, or one
    // dropped request would hide it for the rest of the session.
    if (error.code === 'PGRST205' || /could not find the table/i.test(error.message || '')) {
      _hostRatingsAvailable = false;
    }
    // Not an error the player should see, and not a zero: an unrated host and
    // a disliked one must never look alike.
    logger.debug('Supabase', 'host_reputation unavailable', error);
    return new Map();
  }
  _hostRatingsAvailable = true;
  return new Map((data || []).map(r => [r.host_user_id, r]));
}

/**
 * How a reputation reads on screen, in one place so every surface agrees.
 *
 * THE SAMPLE IS ALWAYS PRINTED. "100%" from two games and "100%" from two
 * hundred are different claims, and the owner asked for the sample explicitly.
 * MIN_HOST_RATINGS is the point below which a percentage says more about who
 * happened to be in the room than about the host — under it, the count is
 * shown on its own.
 */
// The default comes from the constant, not from a literal 3 sitting here. A
// hardcoded copy beside an exported constant is the one-rule-two-places hazard
// this project keeps paying for: change the constant and every caller that
// omitted the argument silently keeps the old threshold.
export function describeHostReputation(rep, minRatings = MIN_HOST_RATINGS) {
  if (!rep || !rep.ratings) return null;
  if (rep.ratings < minRatings) {
    return { text: `${rep.ratings} rating${rep.ratings === 1 ? '' : 's'}`, measured: false, flags: rep.flags || 0 };
  }
  // "RATINGS", NOT "GAMES", and the difference is real rather than pedantic.
  //
  // A rating is keyed on (host, ROOM, voter) — and a room survives Play Again,
  // so a group playing six rounds together in one evening produces ONE rating
  // from each of them, not six. That is the right unit: one considered opinion
  // per person per sitting, rather than six taps, and it stops a host farming
  // votes by running quick rematches with a friendly group.
  //
  // But it means the number is NOT a count of games, and saying so would be the
  // same mistake this project keeps making with Proficiency and Mastery — a
  // label that describes a different measurement from the one shown. This is
  // exactly the distinction the admin page already draws: six rounds with the
  // same group is six games and ONE session.
  return {
    text: `${rep.pct_positive}% · ${rep.ratings} rating${rep.ratings === 1 ? '' : 's'}`,
    measured: true,
    pct: rep.pct_positive,
    flags: rep.flags || 0,
  };
}

// ============================================
// TITLE UNLOCKS
// ============================================

/**
 * Fetch all title unlocks for a user.
 */
export async function fetchTitleUnlocks(userId) {
  const { data, error } = await supabase
    .from('title_unlocks')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    logger.error('Supabase', 'fetchTitleUnlocks failed', error);
    return [];
  }
  return data || [];
}

/**
 * Upsert a title unlock — insert new or upgrade level.
 */
export async function upsertTitleUnlock(userId, wordId, level) {
  // .limit(1) and a CHECKED read error, for the reason CLAUDE.md #10 records.
  //
  // Migration 007 declares UNIQUE(user_id, word_id) on this table — and
  // migration 003 declared UNIQUE(sender_id, receiver_id) on friend_requests,
  // which the live table turned out not to have. A declared constraint is not a
  // measured one, and the client should not need it to be right.
  //
  // Without this, one duplicate pair made maybeSingle() error, the error was
  // discarded, `existing` came back undefined, and another row was inserted.
  // evaluateUnlocks runs at the end of EVERY game, so that ratchet turns once
  // per game for the rest of the account's life — and takes the level check
  // with it, since a fresh row is written at whatever level was passed rather
  // than being compared against the level already held.
  //
  // A failed read is not an absent row: inserting when we cannot tell is the
  // step that creates the duplicate. Missing one unlock is recoverable — the
  // check runs again after the next game — so an error stops here.
  const { data: rows, error: readError } = await supabase
    .from('title_unlocks')
    .select('id, level')
    .eq('user_id', userId)
    .eq('word_id', wordId)
    .order('level', { ascending: false })
    .limit(1);
  if (readError) {
    logger.error('Supabase', 'upsertTitleUnlock read failed — not writing, an insert here would duplicate the unlock', readError);
    return;
  }
  const existing = (rows || [])[0] || null;

  if (existing) {
    if (level > existing.level) {
      const { error } = await supabase.from('title_unlocks').update({
        level,
        unlocked_at: new Date().toISOString()
      }).eq('id', existing.id);
      if (error) logger.error('Supabase', 'upsertTitleUnlock update failed', error);
    }
  } else {
    const { error } = await supabase.from('title_unlocks').insert({
      user_id: userId,
      word_id: wordId,
      level
    });
    if (error) logger.error('Supabase', 'upsertTitleUnlock insert failed', error);
  }
}

// ============================================
// LEADERBOARDS
// ============================================

/**
 * Fetch all player stats (cross-user) for leaderboard aggregation.
 * Reads from computed view. Client-side groups by user_id.
 */
/**
 * Whole-account totals for the global and friends leaderboards.
 *
 * Reads player_totals_computed (migration 032), which counts each answered
 * question ONCE. The per-category view cannot: it files a question under every
 * topic it carries — correctly, because getting a History-and-Culture question
 * right is evidence about both — so adding those rows together counts 11% of
 * questions more than once and can reorder players who are close.
 *
 * Falls back to the per-category rollups if the view is not there yet, because
 * a leaderboard that is slightly generous beats a leaderboard that is blank.
 * Delete the fallback once migration 032 is confirmed everywhere.
 */
/**
 * Delete the signed-in player's account and everything attached to it.
 *
 * Goes through the delete_my_account() function (migration 035) rather than a
 * pile of client-side deletes, for two reasons. A browser cannot delete its own
 * auth.users row at all, so without it the account survives and the player can
 * still sign in. And seven separate deletes can fail individually, leaving
 * somebody half-deleted with no way to tell or to finish; inside the function
 * it is one transaction.
 *
 * The function takes no arguments and reads auth.uid() itself, so this cannot
 * be aimed at anyone else's account.
 *
 * Returns { error }. The caller MUST check it — reporting success on a failed
 * deletion is the worst version of the silent-failure bug this codebase is
 * full of, because the player believes their data is gone.
 */
export async function deleteMyAccount() {
  const { error } = await supabase.rpc('delete_my_account');
  if (error) {
    logger.error('Supabase', 'deleteMyAccount failed', error);
    return { error };
  }
  return { error: null };
}

/**
 * The leaderboard, for a named list of people (migration 053).
 *
 * → { rows, windowed }
 *   rows      [{ user_id, questions_met, questions_mastered }]
 *   windowed  whether a time window could actually be honoured
 *
 * There is no "everybody" mode, deliberately. The owner's decision is that the
 * board is FRIENDS ONLY: with no global prize there is very little left to fake
 * for, and a friend whose numbers look wrong can be unfriended, which is a
 * remedy a global board has no equivalent of.
 *
 * THE FALLBACK EXISTS SO THE JAVASCRIPT IS SAFE TO DEPLOY BEFORE THE SQL IS RUN.
 * That order has been got wrong repeatedly here (CLAUDE.md #3), so: if 053 is
 * not applied, this reads player_stats_computed instead, which carries the same
 * two columns per category and has been live since 031.
 *
 * `windowed` IS THE HONEST PART. The fallback has no time dimension at all —
 * player_stats_computed is lifetime — so it cannot answer "the last 30 days"
 * and must not pretend to. It returns windowed:false and the page hides the
 * period control entirely rather than showing a period beside numbers that
 * ignore it. A screen that displays the wrong answer confidently is the fault
 * this codebase is built out of.
 */
export async function fetchLeaderboard(userIds, { category = null, subcategory = null, since = null } = {}) {
  if (!userIds || userIds.length === 0) return { rows: [], windowed: true };

  const { data, error } = await supabase.rpc('get_leaderboard', {
    p_user_ids: userIds,
    p_category: category,
    p_subcategory: subcategory,
    p_since: since,
  });

  if (!error) return { rows: data || [], windowed: true };

  // PGRST202 covers "never created" AND "created under different argument
  // names", and the second is just as dead to the app as the first (#6).
  const missing = error.code === 'PGRST202'
    || /could not find the function/i.test(error.message || '');
  if (!missing) {
    logger.error('Supabase', 'get_leaderboard failed', error);
    return { rows: [], windowed: true };
  }
  logger.warn('Supabase', 'get_leaderboard not installed, falling back to player_stats_computed (no time windows)');
  return { rows: await _leaderboardFallback(userIds, category, subcategory), windowed: false };
}

async function _leaderboardFallback(userIds, category, subcategory) {
  // select('*') on purpose, the same call as fetchCategoryLeaderboard makes and
  // for the same reason: rowProficiency silently falls back to the ATTEMPT
  // counters when questions_met / questions_mastered are absent, and a short
  // column list is exactly what makes them absent. That shipped once already.
  let query = supabase.from('player_stats_computed').select('*').in('user_id', userIds);
  if (category) {
    query = query.eq('category', category);
    // The view stores one exact subcategory per row, so this cannot match a
    // whole branch the way migration 053 does. Narrower, and it says so by
    // being the fallback rather than the main path.
    query = subcategory ? query.eq('subcategory', subcategory) : query.is('subcategory', null);
  }
  const { data, error } = await query;
  if (error) { logger.error('Supabase', 'leaderboard fallback failed', error); return []; }

  // With no category the view emits a row per category AND per subcategory, so
  // summing would count a question filed under two topics twice and one with a
  // subcategory twice again. Take the rollups only and add those — the same
  // rule categoryRollupRows states, applied at the query's edge.
  const totals = new Map();
  for (const s of (data || [])) {
    if (!category && s.subcategory) continue;
    const acc = totals.get(s.user_id) || { user_id: s.user_id, questions_met: 0, questions_mastered: 0 };
    acc.questions_met += s.questions_met ?? s.questions_answered ?? 0;
    acc.questions_mastered += s.questions_mastered ?? s.correct_answers ?? 0;
    totals.set(s.user_id, acc);
  }
  return [...totals.values()];
}

export async function fetchPlayerTotalsForLeaderboard() {
  const { data, error } = await supabase
    .from('player_totals_computed')
    .select('user_id, questions_answered, correct_answers, games_played, wins');
  if (error) {
    logger.warn('Supabase', 'player_totals_computed unavailable, using per-category rollups', error);
    return fetchAllPlayerStatsForLeaderboard();
  }
  return data || [];
}

export async function fetchAllPlayerStatsForLeaderboard() {
  // Category rollups only. The view also emits a row per subcategory, and the
  // rollup already contains them, so fetching both made every leaderboard
  // total count most things twice — and unevenly, because a question with no
  // subcategory is counted once. See categoryRollupRows in js/titles.js.
  const { data, error } = await supabase
    .from('player_stats_computed')
    .select('user_id, category, questions_answered, correct_answers, games_played, wins')
    .is('subcategory', null);
  if (error) { logger.error('Supabase', 'fetchAllPlayerStatsForLeaderboard failed', error); return []; }
  return data || [];
}

/**
 * Fetch category leaderboard: top players for a specific category.
 * Minimum 20 questions answered. Sorted by accuracy desc client-side.
 */
export async function fetchCategoryLeaderboard(category, subcategory = null) {
  // SELECT * ON PURPOSE, and this was a real bug.
  //
  // The column list here named only the attempt counters, and its one consumer
  // — loadCategoryLeaderboard — ranks by rowProficiency, which reads
  // questions_met and questions_mastered (migration 040) and FALLS BACK to the
  // attempt counters when they are absent. Absent is exactly what a column list
  // that omits them produces, so the fallback fired every single time and the
  // category boards silently ranked by the lifetime hit rate 040 set out to
  // replace: a question missed once and since learned still counted against
  // you, forever. The row label said "N Qs met" while showing attempts.
  //
  // It disagreed with the profile and the global board, and nothing could say
  // so, because falling back is not an error.
  //
  // This is the same shape as fetchQuestionHistoryForUsers, which MUST select
  // last_correct for the identical reason (CLAUDE.md, Proficiency). Naming the
  // new columns explicitly would be better documentation and worse code: if
  // migration 040 has not been applied they do not exist, PostgREST answers
  // 42703, and the whole leaderboard goes blank instead of degrading. `*` lets
  // the fallback mean what it says.
  let query = supabase
    .from('player_stats_computed')
    .select('*')
    .eq('category', category)
    .gte('questions_answered', 20);
  if (subcategory) {
    query = query.eq('subcategory', subcategory);
  } else {
    query = query.is('subcategory', null);
  }
  const { data, error } = await query;
  if (error) { logger.error('Supabase', 'fetchCategoryLeaderboard failed', error); return []; }
  return data || [];
}

/**
 * Fetch game_history entries within a date range (for weekly leaderboard).
 */
export async function fetchGameHistorySince(sinceDate) {
  const { data, error } = await supabase
    .from('game_history')
    .select('user_id, score, placement, total_players, played_at')
    .gte('played_at', sinceDate);
  if (error) { logger.error('Supabase', 'fetchGameHistorySince failed', error); return []; }
  return data || [];
}

/**
 * Batch-fetch profiles for an array of user IDs (for leaderboard display).
 */
export async function fetchProfilesBatch(userIds) {
  if (!userIds.length) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, display_name, discriminator, avatar_color, avatar_emoji, title_slot1, title_slot2, title_slot3, title_builder_unlocked')
    .in('user_id', userIds);
  if (error) { logger.error('Supabase', 'fetchProfilesBatch failed', error); return []; }
  return data || [];
}

// ============================================
// SITE SETTINGS (Admin)
// ============================================

export async function fetchSiteSettings() {
  const { data, error } = await supabase.from('site_settings').select('*');
  if (error) { logger.error('Supabase', 'fetchSiteSettings failed', error); return []; }
  return data || [];
}

export async function upsertSiteSetting(key, value) {
  const { error } = await supabase.from('site_settings').upsert({
    key, value, updated_at: new Date().toISOString()
  }, { onConflict: 'key' });
  if (error) logger.error('Supabase', 'upsertSiteSetting failed', error);
}

export async function deleteSiteSetting(key) {
  const { error } = await supabase.from('site_settings').delete().eq('key', key);
  if (error) logger.error('Supabase', 'deleteSiteSetting failed', error);
}

// ============================================
// FRIENDS & FRIEND REQUESTS
// ============================================

/**
 * Send a friend request. Returns { data, error, autoAccepted }.
 * Auto-accepts if the receiver already sent a pending request to the sender.
 * Error code 23505 = duplicate request already exists.
 */
export async function sendFriendRequest(senderId, receiverId) {
  if (senderId === receiverId) {
    return { data: null, error: { message: 'Cannot send a friend request to yourself' }, autoAccepted: false };
  }

  // Check if already friends
  const already = await isFriend(senderId, receiverId);
  if (already) {
    return { data: null, error: { message: 'Already friends' }, autoAccepted: false };
  }

  // Check for reverse pending request — auto-accept if found.
  //
  // maybeSingle() ERRORS when more than one row matches, and both guards here
  // used to discard that error. A guard that fails then reads as "nothing
  // found" and falls straight through to the insert — failing open on exactly
  // the check meant to stop a duplicate.
  //
  // NOT maybeSingle(). The live table turned out to have DUPLICATE rows for the
  // same pair — three of them for one pair — which means the
  // UNIQUE(sender_id, receiver_id) that migration 003 declares was never
  // actually created (CLAUDE.md #7). maybeSingle ERRORS on more than one row,
  // so on the real data this guard could only ever fail. Migration 044 adds the
  // constraint, but this must not depend on it: the duplicates it is meant to
  // survive are exactly what exists today, on this owner's account.
  const { data: reverseRows, error: reverseErr } = await supabase
    .from('friend_requests')
    .select('*')
    .eq('sender_id', receiverId)
    .eq('receiver_id', senderId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);
  if (reverseErr) {
    logger.error('Supabase', 'sendFriendRequest reverse lookup failed', reverseErr);
    return { data: null, error: reverseErr, autoAccepted: false };
  }
  const reverseReq = reverseRows?.[0] || null;

  if (reverseReq) {
    // Auto-accept: they already want to be our friend
    const result = await acceptFriendRequest(reverseReq.id);
    return { data: result.data, error: result.error, autoAccepted: true };
  }

  // Check for an existing request in this direction — of ANY status.
  //
  // friend_requests is UNIQUE(sender_id, receiver_id), so there is at most one
  // row per direction ever. Filtering on status='pending' therefore hid the
  // case that matters: a request that was DECLINED, or accepted and later
  // unfriended, leaves the row behind, the insert below hits 23505, and the
  // app reported "Friend request already sent" — which is false, permanent,
  // and unexplainable to the person staring at it. You could never ask that
  // person again.
  //
  // Newest first and limit 1, for the same reason as the reverse lookup above:
  // duplicates exist on the live table and this cannot be the thing that
  // breaks because of them.
  const { data: existingRows, error: existingErr } = await supabase
    .from('friend_requests')
    .select('id, status')
    .eq('sender_id', senderId)
    .eq('receiver_id', receiverId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (existingErr) {
    logger.error('Supabase', 'sendFriendRequest existing lookup failed', existingErr);
    return { data: null, error: existingErr, autoAccepted: false };
  }
  const existingReq = existingRows?.[0] || null;

  if (existingReq?.status === 'pending') {
    return { data: null, error: { message: 'Friend request already sent' }, autoAccepted: false };
  }
  if (existingReq) {
    // Revive the dead row rather than inserting a second one the unique
    // constraint would refuse.
    const { data: revived, error: reviveErr } = await supabase
      .from('friend_requests')
      .update({ status: 'pending', created_at: new Date().toISOString() })
      .eq('id', existingReq.id)
      .select();
    if (reviveErr) {
      logger.error('Supabase', 'sendFriendRequest revive failed', reviveErr);
      return { data: null, error: reviveErr, autoAccepted: false };
    }
    if (!revived || revived.length === 0) {
      // Only the RECEIVER may update a request (migration 003), so the sender
      // cannot revive their own declined one. Say so rather than claiming the
      // request was sent.
      logger.error('Supabase', 'sendFriendRequest revive affected zero rows (RLS)', { id: existingReq.id });
      return {
        data: null,
        error: { message: 'They declined an earlier request, so a new one has to come from them.' },
        autoAccepted: false,
      };
    }
    return { data: revived[0], error: null, autoAccepted: false };
  }

  const { data, error } = await supabase
    .from('friend_requests')
    .insert({ sender_id: senderId, receiver_id: receiverId, status: 'pending' })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') {
      return { data: null, error: { message: 'Friend request already sent' }, autoAccepted: false };
    }
    logger.error('Supabase', 'sendFriendRequest failed', error);
    return { data: null, error, autoAccepted: false };
  }
  return { data, error: null, autoAccepted: false };
}

/**
 * Fetch pending friend requests received by a user.
 */
export async function fetchPendingRequests(userId) {
  const { data, error } = await supabase
    .from('friend_requests')
    .select('*')
    .eq('receiver_id', userId)
    .eq('status', 'pending')
    .order('created_at', { ascending: false });

  if (error) {
    logger.error('Supabase', 'fetchPendingRequests failed', error);
    return [];
  }

  // One row per sender, newest first.
  //
  // The live table holds duplicate rows for the same pair — the
  // UNIQUE(sender_id, receiver_id) that migration 003 declares was never
  // created — so one person could appear in this list three times, with three
  // Accept buttons, and accepting one left the other two sitting there looking
  // unanswered. Migration 044 fixes the data; this makes the screen truthful
  // whether or not it has been run, and stays correct afterwards because a
  // deduplicated list of unique rows is just the list.
  const seen = new Set();
  const unique = [];
  for (const row of data || []) {
    const key = String(row.sender_id);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(row);
  }
  return unique;
}

/**
 * Fetch pending friend requests sent by a user.
 */
export async function fetchSentRequests(userId) {
  const { data, error } = await supabase
    .from('friend_requests')
    .select('*')
    .eq('sender_id', userId)
    .eq('status', 'pending');

  if (error) {
    logger.error('Supabase', 'fetchSentRequests failed', error);
    return [];
  }
  return data || [];
}

/**
 * Accept a friend request. Updates status and creates the friendship.
 */
export async function acceptFriendRequest(requestId) {
  // Fetch the request to get sender/receiver
  const { data: req, error: fetchErr } = await supabase
    .from('friend_requests')
    .select('sender_id, receiver_id')
    .eq('id', requestId)
    .single();

  if (fetchErr || !req) {
    logger.error('Supabase', 'acceptFriendRequest fetch failed', fetchErr);
    return { error: fetchErr };
  }

  // Update status.
  //
  // .select() so the row count can be checked. Only the RECEIVER may update a
  // request (migration 003), and an RLS refusal returns ZERO ROWS AND NO ERROR
  // — so without this, somebody accepting a request that is not theirs, or
  // accepting from a stale list after the sender withdrew it, saw "Accepted!"
  // and became nobody's friend. That is CLAUDE.md #4 exactly.
  const { data: updated, error: updateErr } = await supabase
    .from('friend_requests')
    .update({ status: 'accepted' })
    .eq('id', requestId)
    .select();

  if (updateErr) {
    logger.error('Supabase', 'acceptFriendRequest update failed', updateErr);
    return { error: updateErr };
  }
  if (!updated || updated.length === 0) {
    logger.error('Supabase', 'acceptFriendRequest affected zero rows (RLS or withdrawn)', { requestId });
    return { error: { message: "That request couldn't be accepted — it may have been withdrawn already." } };
  }

  // Create friendship (canonical ordering)
  const { error: friendErr } = await createFriendship(req.sender_id, req.receiver_id, 'request');
  if (friendErr) {
    logger.error('Supabase', 'acceptFriendRequest createFriendship failed', friendErr);
    return { error: friendErr };
  }

  return { error: null };
}

/**
 * Decline a friend request.
 */
export async function declineFriendRequest(requestId) {
  const { error } = await supabase
    .from('friend_requests')
    .update({ status: 'declined' })
    .eq('id', requestId);

  if (error) logger.error('Supabase', 'declineFriendRequest failed', error);
  return { error };
}

/**
 * Cancel (revoke) a pending friend request sent by the current user.
 * Deletes the request row entirely so the sender can re-send later.
 */
export async function cancelFriendRequest(requestId) {
  const { error } = await supabase
    .from('friend_requests')
    .delete()
    .eq('id', requestId);

  if (error) logger.error('Supabase', 'cancelFriendRequest failed', error);
  return { error };
}

/**
 * Create a friendship between two users (instant add from lobby/game).
 * Enforces canonical ordering: user_a < user_b.
 */
// The value the live CHECK constraint accepts today, used when the intended
// one is refused. 'search' rather than 'lobby' because a friend request is
// sent after finding somebody, which is what search means here — 'lobby' would
// claim they were added from a game they played together.
const FRIENDSHIP_SOURCE_FALLBACK = 'search';

export async function createFriendship(userIdA, userIdB, source = 'lobby') {
  // Defensive: prevent self-friendship even if upstream callers pass the same id.
  // sendFriendRequest already checks, but createFriendship is also called directly
  // from auto-accept paths and lobby instant-add — belt-and-suspenders.
  if (!userIdA || !userIdB || userIdA === userIdB) {
    return { data: null, error: { message: 'Cannot create a friendship with yourself' } };
  }
  const [user_a, user_b] = [userIdA, userIdB].sort();

  // Idempotent WITHOUT depending on the unique constraint. The 23505 branch
  // below is the proper mechanism, but `friendships` has no such constraint on
  // the live table until migration 044 is run — so until then two people who
  // each accepted the other simply got two rows, which broke isFriend and
  // listed each of them twice. The state the caller wants already exists.
  if (await isFriend(userIdA, userIdB)) return { data: null, error: null };

  const { data, error } = await supabase
    .from('friendships')
    .insert({ user_a, user_b, source })
    .select()
    .single();

  if (!error) return { data, error: null };

  // 23505 = already friends (unique constraint). Nothing to do, and not a
  // failure: the state the caller wanted is the state that exists.
  if (error.code === '23505') return { data: null, error: null };

  // 23514 = a CHECK constraint refused the row.
  //
  // THIS IS WHY ACCEPTING A FRIEND REQUEST HAD NEVER WORKED. The live
  // `friendships` table carries a constraint that appears in NO migration in
  // this repo:
  //
  //   friendships_source_check  CHECK (source = ANY (ARRAY['lobby', 'search']))
  //
  // acceptFriendRequest is the only caller of this function and it passes
  // 'request'. So every accept died here, createFriendship returned the error,
  // and the button showed "Error". Schema drift (CLAUDE.md #7) in the
  // direction this project had not seen: the live database ENFORCING a rule
  // the repo has never heard of, which reading migrations could never reveal.
  //
  // Migration 044 widens the constraint to accept 'request', which is a real
  // third source and deserves recording. This retry is what makes the app work
  // BEFORE that is run, and it costs one wrong label rather than a friendship.
  //
  // It falls back to a real value, NEVER to omitting the column: `source` is
  // also NOT NULL on the live table with no usable default, so leaving it out
  // fails with 23502 instead. Both halves were measured, the second because
  // omitting it was tried and the database refused that too.
  if (error.code === '23514' && source !== FRIENDSHIP_SOURCE_FALLBACK) {
    logger.error('Supabase', `createFriendship refused source="${source}" by a CHECK constraint — retrying as "${FRIENDSHIP_SOURCE_FALLBACK}" (run migration 044)`, error);
    const retry = await supabase
      .from('friendships')
      .insert({ user_a, user_b, source: FRIENDSHIP_SOURCE_FALLBACK })
      .select()
      .single();
    if (!retry.error) return { data: retry.data, error: null };
    if (retry.error.code === '23505') return { data: null, error: null };
    logger.error('Supabase', 'createFriendship retry failed', retry.error);
    return { data: null, error: retry.error };
  }

  logger.error('Supabase', 'createFriendship failed', error);
  return { data: null, error };
}

/**
 * Remove a friendship between two users.
 */
export async function removeFriend(userId, friendId) {
  const [user_a, user_b] = [userId, friendId].sort();
  const { error } = await supabase
    .from('friendships')
    .delete()
    .eq('user_a', user_a)
    .eq('user_b', user_b);

  if (error) logger.error('Supabase', 'removeFriend failed', error);
  return { error };
}

/**
 * Fetch all friends for a user, with their profile data.
 * Returns array of profile objects (with friendship metadata).
 */
export async function fetchFriends(userId) {
  // Get all friendships involving this user
  const { data: ships, error } = await supabase
    .from('friendships')
    .select('*')
    .or(`user_a.eq.${userId},user_b.eq.${userId}`);

  if (error) {
    logger.error('Supabase', 'fetchFriends failed', error);
    return [];
  }
  if (!ships || ships.length === 0) return [];

  // Collect friend user IDs
  const friendIds = ships.map(s => s.user_a === userId ? s.user_b : s.user_a);

  // Batch-fetch profiles
  const { data: profiles, error: pErr } = await supabase
    .from('profiles')
    .select('*')
    .in('user_id', friendIds);

  if (pErr) {
    logger.error('Supabase', 'fetchFriends profiles failed', pErr);
    return [];
  }

  // Merge: attach profile to each friendship
  const profileMap = {};
  for (const p of (profiles || [])) profileMap[p.user_id] = p;

  // ONE ROW PER PERSON, whatever the table holds. `friendships` has no unique
  // constraint until migration 044 is run, and two people who each accepted the
  // other's request produce two rows for the same pair — which listed that
  // person twice, with two different Remove buttons, one of which would appear
  // to do nothing. Keyed on the friend's id rather than the row's.
  const seen = new Set();
  return ships.map(s => {
    const friendId = s.user_a === userId ? s.user_b : s.user_a;
    return { ...profileMap[friendId], friendshipId: s.id, friendshipSource: s.source };
  }).filter(f => {
    if (!f.user_id) return false;            // profile missing
    if (seen.has(String(f.user_id))) return false;
    seen.add(String(f.user_id));
    return true;
  });
}

/**
 * Check if two users are friends.
 */
export async function isFriend(userId, otherUserId) {
  const [user_a, user_b] = [userId, otherUserId].sort();
  // NOT maybeSingle(), for the same reason sendFriendRequest stopped using it
  // (see the note above it): maybeSingle ERRORS on more than one row, and
  // `friendships` has no unique constraint on the live table until migration
  // 044 is run. Two people who each accepted the other produce two rows for one
  // pair, and from then on this returned FALSE for people who really are
  // friends — so the "Already friends" guard in sendFriendRequest fell straight
  // through, the profile offered "Add Friend" to an existing friend, and every
  // press made the duplication worse.
  //
  // limit(1) means the answer is the same whether there is one row or five.
  const { data, error } = await supabase
    .from('friendships')
    .select('id')
    .eq('user_a', user_a)
    .eq('user_b', user_b)
    .limit(1);

  if (error) {
    logger.error('Supabase', 'isFriend failed', error);
    return false;
  }
  return (data?.length || 0) > 0;
}

/**
 * Check if a user has any friends (for presence optimization).
 */
export async function hasFriends(userId) {
  const { data, error } = await supabase
    .from('friendships')
    .select('id')
    .or(`user_a.eq.${userId},user_b.eq.${userId}`)
    .limit(1)
    .maybeSingle();

  if (error) return false;
  return !!data;
}

/**
 * Subscribe to friend request changes for a user (received requests).
 */
export function subscribeToFriendRequests(userId, callback) {
  return supabase.channel(`friend-requests-${userId}`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'friend_requests',
      filter: `receiver_id=eq.${userId}`
    }, (payload) => {
      try { callback(payload); } catch (e) { logger.error('Supabase', 'Friend request callback error', e); }
    })
    .subscribe();
}

/**
 * Who an account actually is — email, sign-up method, whether the address was
 * ever confirmed, and when they last signed in.
 *
 * Goes through admin_account_details (migration 042) because all of that lives
 * in auth.users, which PostgREST does not expose and must not: every player's
 * browser carries the same publishable key, so a readable auth.users would be a
 * public mailing list. The function checks the caller is an admin and returns
 * one account at a time, so an email reaches the screen only after a deliberate
 * tap on that person.
 *
 * Returns null when the function is not installed yet or the caller is not an
 * admin. The panel then simply shows the parts it can compute from `profiles`
 * and `game_history`, which is more useful than an error.
 */
export async function fetchAdminAccountDetails(userId) {
  if (!userId) return null;
  const { data, error } = await supabase.rpc('admin_account_details', { p_user_id: userId });
  if (error) {
    logger.warn('Supabase', 'fetchAdminAccountDetails unavailable', error);
    return null;
  }
  // RETURNS TABLE gives an array even for one row.
  return Array.isArray(data) ? (data[0] || null) : (data || null);
}

/**
 * Every completed game for one account, newest first.
 *
 * game_history holds one row per player per finished game, so counting rows is
 * "games played" and counting distinct room_ids is "sessions" — six rounds with
 * the same group in one evening is six games and one session. Both are worth
 * showing: the first says what somebody did, the second says how they use it.
 */
export async function fetchAccountGames(userId, limit = 200) {
  if (!userId) return [];
  const { data, error } = await supabase
    .from('game_history')
    .select('room_id, category, subcategory, score, placement, total_players, played_at')
    .eq('user_id', userId)
    .order('played_at', { ascending: false })
    .limit(limit);
  if (error) { logger.error('Supabase', 'fetchAccountGames failed', error); return []; }
  return data || [];
}

/**
 * Games and sessions for SEVERAL accounts in one query, for the collapsed list.
 * Returns { userId: { games, sessions, lastPlayed } }.
 */
export async function fetchAccountPlayCounts(userIds) {
  const ids = (userIds || []).filter(Boolean);
  if (ids.length === 0) return {};
  const { data, error } = await supabase
    .from('game_history')
    .select('user_id, room_id, played_at')
    .in('user_id', ids);
  if (error) { logger.error('Supabase', 'fetchAccountPlayCounts failed', error); return {}; }

  const out = {};
  for (const row of data || []) {
    const key = String(row.user_id);
    if (!out[key]) out[key] = { games: 0, rooms: new Set(), lastPlayed: null };
    out[key].games += 1;
    if (row.room_id) out[key].rooms.add(String(row.room_id));
    if (!out[key].lastPlayed || row.played_at > out[key].lastPlayed) {
      out[key].lastPlayed = row.played_at;
    }
  }
  for (const key of Object.keys(out)) {
    out[key] = { games: out[key].games, sessions: out[key].rooms.size, lastPlayed: out[key].lastPlayed };
  }
  return out;
}


// ============================================
// TITLE WORDS — content the owner writes, not code
//
// Migration 063. The structure of the collection is computed from
// CATEGORY_META and title-tiers.js; this table holds only the TEXT. A slot
// with no row does not exist for players, which is what makes "nobody sees a
// slot they cannot fill" true by construction rather than by care.
// ============================================

/**
 * Every word the owner has written.
 *
 * RETURNS null ON FAILURE, never []. The two mean completely different things
 * here: [] means nothing has been written yet and the gallery correctly shows
 * only the coded words, while a failed read means we do not KNOW what is
 * written. Conflating them would quietly delete the owner's whole collection
 * from the screen on one dropped request — the shape of CLAUDE.md #6, where
 * "could not look" and "nothing there" returned the same answer for months.
 */
export async function fetchTitleWords() {
  const { data, error } = await supabase
    .from('title_words')
    // target_right IS NOT OPTIONAL HERE. applyWordOverlay skips any row without
    // a usable target, so leaving it out of this list does not fail — it
    // silently drops every word the owner has ever written, with no error
    // anywhere. Exactly the fault that had the category leaderboard ranking on
    // the wrong measure for weeks because its select forgot two columns.
    .select('id, slot, category, subcategory, tier, word, target_right, is_placeholder');
  if (error) {
    // Not an error at warn-and-continue level: until 063 is applied this table
    // does not exist, and the app is expected to run exactly as before.
    logger.warn('Supabase', 'fetchTitleWords failed (migration 063 may not be applied)', error);
    return null;
  }
  return data || [];
}

/**
 * Write or replace one word.
 *
 * CHECKS THE ROW COUNT, because an RLS refusal returns no error at all — it
 * updates nothing and reports success (CLAUDE.md #4). The admin page has
 * shipped three separate saves that said "Saved!" while saving nothing, and
 * this is the check that stops a fourth.
 */
export async function saveTitleWord({ slot = 2, category, subcategory = null, tier, word, targetRight, isPlaceholder = false }) {
  const text = String(word || '').trim();
  const target = Number(targetRight);
  if (!category || !tier || !text) return { error: new Error('missing category, tier or word') };
  // THE TARGET IS FROZEN HERE, at the number the rule produces today. It must
  // never be recomputed afterwards: a share recalculated live means growing the
  // question bank pushes everybody's goal further away, which is the worst
  // thing a collection can do. Saving the same word again is how the owner
  // deliberately re-freezes it.
  if (!Number.isFinite(target) || target < 1) {
    return { error: new Error('missing target — this slot does not exist') };
  }

  // Not an upsert: the unique index treats a NULL subcategory as its own slot
  // via a PARTIAL index, and PostgREST's onConflict cannot name a partial one.
  // Delete-then-insert is exact and needs no index to be present at all.
  const existing = supabase.from('title_words').delete()
    .eq('category', category).eq('tier', tier).eq('slot', slot);
  const { error: delError } = await (subcategory
    ? existing.eq('subcategory', subcategory)
    : existing.is('subcategory', null));
  if (delError) return { error: delError };

  const { data, error } = await supabase
    .from('title_words')
    .insert({ slot, category, subcategory: subcategory || null, tier, word: text, target_right: target, is_placeholder: !!isPlaceholder })
    .select('id');
  if (error) return { error };
  if (!data || data.length === 0) {
    return { error: new Error('Permission denied — the word was not saved') };
  }
  return { data: data[0] };
}

/**
 * Remove a word, which removes the slot from the game entirely.
 *
 * COUNTS THE ROWS, and here that is safe to read as a verdict. Zero rows from
 * a delete is normally ambiguous — a refusal and "there was nothing matching"
 * look identical, which is why the admin page's "Clear 7d+" has to count first
 * — but this delete is aimed at a slot the admin is looking at a word in. It
 * is known to exist, so nothing deleted means nothing was allowed.
 */
export async function deleteTitleWord({ slot = 2, category, subcategory = null, tier }) {
  if (!category || !tier) return { error: new Error('missing category or tier') };
  const q = supabase.from('title_words').delete()
    .eq('category', category).eq('tier', tier).eq('slot', slot);
  const { data, error } = await (subcategory
    ? q.eq('subcategory', subcategory).select('id')
    : q.is('subcategory', null).select('id'));
  if (error) return { error };
  if (!data || data.length === 0) {
    return { error: new Error('Permission denied — the word was not removed') };
  }
  return { error: null };
}
