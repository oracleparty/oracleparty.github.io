import { supabase } from './client.js';
import { logger } from '../logger.js';
import { PROFILE_SEARCH_LIMIT } from '../constants.js';

// ============================================
// PROFILES & AUTH HELPERS
// ============================================

/**
 * Generate an unused 4-digit discriminator for a display name.
 */
export async function generateDiscriminator(displayName) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const disc = String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    const { data } = await supabase
      .from('profiles')
      .select('user_id')
      .eq('display_name', displayName)
      .eq('discriminator', disc)
      .maybeSingle();
    if (!data) return disc;
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
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('display_name', displayName)
    .eq('discriminator', discriminator)
    .maybeSingle();

  if (error) {
    logger.error('Supabase', 'fetchProfileByTag failed', error);
    return { data: null, error };
  }
  return { data, error: null };
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
  const { data: existing } = await supabase
    .from('title_unlocks')
    .select('id, level')
    .eq('user_id', userId)
    .eq('word_id', wordId)
    .maybeSingle();

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
