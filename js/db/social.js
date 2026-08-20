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
  let query = supabase
    .from('player_stats_computed')
    .select('user_id, questions_answered, correct_answers, games_played, wins, subcategory')
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

  // Check for reverse pending request — auto-accept if found
  const { data: reverseReq } = await supabase
    .from('friend_requests')
    .select('*')
    .eq('sender_id', receiverId)
    .eq('receiver_id', senderId)
    .eq('status', 'pending')
    .maybeSingle();

  if (reverseReq) {
    // Auto-accept: they already want to be our friend
    const result = await acceptFriendRequest(reverseReq.id);
    return { data: result.data, error: result.error, autoAccepted: true };
  }

  // Check for existing same-direction pending request
  const { data: existingReq } = await supabase
    .from('friend_requests')
    .select('id')
    .eq('sender_id', senderId)
    .eq('receiver_id', receiverId)
    .eq('status', 'pending')
    .maybeSingle();

  if (existingReq) {
    return { data: null, error: { message: 'Friend request already sent' }, autoAccepted: false };
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
  return data || [];
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

  // Update status
  const { error: updateErr } = await supabase
    .from('friend_requests')
    .update({ status: 'accepted' })
    .eq('id', requestId);

  if (updateErr) {
    logger.error('Supabase', 'acceptFriendRequest update failed', updateErr);
    return { error: updateErr };
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
export async function createFriendship(userIdA, userIdB, source = 'lobby') {
  // Defensive: prevent self-friendship even if upstream callers pass the same id.
  // sendFriendRequest already checks, but createFriendship is also called directly
  // from auto-accept paths and lobby instant-add — belt-and-suspenders.
  if (!userIdA || !userIdB || userIdA === userIdB) {
    return { data: null, error: { message: 'Cannot create a friendship with yourself' } };
  }
  const [user_a, user_b] = [userIdA, userIdB].sort();
  const { data, error } = await supabase
    .from('friendships')
    .insert({ user_a, user_b, source })
    .select()
    .single();

  if (error) {
    // 23505 = already friends (unique constraint)
    if (error.code === '23505') return { data: null, error: null };
    logger.error('Supabase', 'createFriendship failed', error);
    return { data: null, error };
  }
  return { data, error: null };
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

  return ships.map(s => {
    const friendId = s.user_a === userId ? s.user_b : s.user_a;
    return { ...profileMap[friendId], friendshipId: s.id, friendshipSource: s.source };
  }).filter(f => f.user_id); // Filter out any missing profiles
}

/**
 * Check if two users are friends.
 */
export async function isFriend(userId, otherUserId) {
  const [user_a, user_b] = [userId, otherUserId].sort();
  const { data, error } = await supabase
    .from('friendships')
    .select('id')
    .eq('user_a', user_a)
    .eq('user_b', user_b)
    .maybeSingle();

  if (error) {
    logger.error('Supabase', 'isFriend failed', error);
    return false;
  }
  return !!data;
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
