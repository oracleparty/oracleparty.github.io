// ============================================
// Oracle Party — Supabase Client
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://zzpqymehapwbjupphxec.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UJtIRllW5SWhMbqynb-3QQ_HWIV2OSd';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Fetch distinct categories from the questions table with counts.
 * Questions have a `categories` text[] array column.
 * Paginates through all rows to ensure accurate counts.
 * Returns [{ name: 'history', count: 142 }, ...] sorted alphabetically.
 */
export async function fetchCategories() {
  const PAGE_SIZE = 1000;
  const counts = {};
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('questions')
      .select('categories')
      .eq('format', 'open')
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error('[Supabase] Failed to fetch categories:', error.message);
      return [];
    }

    for (const row of (data || [])) {
      // Supabase returns text[] as a JS array
      const cats = Array.isArray(row.categories) ? row.categories : [];
      for (const cat of cats) {
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }

    hasMore = data && data.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }

  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generate a random 4-letter room code (A-Z).
 */
export function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * 26)];
  return code;
}

/**
 * Create a new room in Supabase.
 * Retries once on code collision.
 */
export async function createRoom({ hostName, category, whoCanJoin, questionsPerGame, questionTimer }) {
  const roomPayload = {
    code: generateRoomCode(),
    host_name: hostName,
    category,
    who_can_join: whoCanJoin,
    questions_per_game: questionsPerGame,
    question_timer: questionTimer,
    status: 'lobby'
  };

  const { data, error } = await supabase
    .from('rooms')
    .insert(roomPayload)
    .select()
    .single();

  if (error) {
    console.error('[Supabase] Room creation failed:', error.code, error.message, error.details, error.hint);

    // Retry once on unique constraint violation (code collision)
    if (error.code === '23505') {
      roomPayload.code = generateRoomCode();
      const { data: d2, error: e2 } = await supabase
        .from('rooms')
        .insert(roomPayload)
        .select()
        .single();
      if (e2) {
        console.error('[Supabase] Room creation retry failed:', e2.code, e2.message, e2.details, e2.hint);
        return { data: null, error: e2 };
      }
      return { data: d2, error: null };
    }

    return { data: null, error };
  }

  return { data, error: null };
}

// ============================================
// Room Lookup
// ============================================

/**
 * Find a room by its 4-letter code (only lobbies).
 */
export async function findRoomByCode(code) {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('code', code.trim().toUpperCase())
    .in('status', ['lobby', 'playing'])
    .single();

  if (error) {
    console.error('[Supabase] findRoomByCode failed:', error.message);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Fetch public rooms in lobby status with player counts.
 */
export async function fetchPublicRooms() {
  const { data: rooms, error } = await supabase
    .from('rooms')
    .select('id, code, host_name, category, who_can_join, questions_per_game, question_timer, status, created_at')
    .in('status', ['lobby', 'playing'])
    .eq('who_can_join', 'anyone')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[Supabase] fetchPublicRooms failed:', error.message);
    return [];
  }

  // Get player counts for each room
  const roomIds = (rooms || []).map(r => r.id);
  if (roomIds.length === 0) return [];

  const { data: players, error: pErr } = await supabase
    .from('players')
    .select('room_id')
    .in('room_id', roomIds);

  if (pErr) {
    console.error('[Supabase] fetchPublicRooms player count failed:', pErr.message);
    // Return rooms without counts
    return rooms.map(r => ({ ...r, player_count: 0 }));
  }

  const countMap = {};
  for (const p of (players || [])) {
    countMap[p.room_id] = (countMap[p.room_id] || 0) + 1;
  }

  return rooms.map(r => ({ ...r, player_count: countMap[r.id] || 0 }));
}

/**
 * Clean up orphaned rooms (rooms with 0 players remaining).
 * Never deletes rooms that still have active players.
 */
export async function cleanupOrphanedRooms() {
  const { data: rooms } = await supabase
    .from('rooms')
    .select('id')
    .in('status', ['lobby', 'playing']);
  if (!rooms || rooms.length === 0) return;

  for (const room of rooms) {
    const { count } = await supabase
      .from('players')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', room.id);
    if (count === 0) {
      await supabase.from('rooms').delete().eq('id', room.id);
    }
  }
}

// ============================================
// Player Management
// ============================================

/**
 * Add a player to a room.
 */
export async function addPlayer(roomId, displayName, isHost = false, userId = null, extras = {}) {
  const payload = { room_id: roomId, display_name: displayName, is_host: isHost, joined_at: new Date().toISOString() };
  if (userId) payload.user_id = userId;
  if (extras.avatarColor) payload.avatar_color = extras.avatarColor;
  if (extras.avatarEmoji) payload.avatar_emoji = extras.avatarEmoji;
  if (extras.title) payload.title = extras.title;
  const { data, error } = await supabase
    .from('players')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('[Supabase] addPlayer failed:', error.message);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Promote a player to host. Sets is_host on the player and updates room's host_name.
 */
export async function promoteToHost(roomId, playerId, displayName) {
  const [playerResult, roomResult] = await Promise.all([
    supabase.from('players').update({ is_host: true }).eq('id', playerId),
    supabase.from('rooms').update({ host_name: displayName }).eq('id', roomId)
  ]);
  if (playerResult.error) console.error('[Supabase] promoteToHost player update failed:', playerResult.error.message);
  if (roomResult.error) console.error('[Supabase] promoteToHost room update failed:', roomResult.error.message);
}

/**
 * Remove a player from a room.
 */
export async function removePlayer(playerId) {
  const { error } = await supabase
    .from('players')
    .delete()
    .eq('id', playerId);

  if (error) console.error('[Supabase] removePlayer failed:', error.message);
  return { error };
}

/**
 * Fire-and-forget player removal using fetch with keepalive.
 * Reliable during page unload (beforeunload / pagehide).
 */
export function removePlayerBeacon(playerId) {
  fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${playerId}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    },
    keepalive: true
  });
}

/**
 * Delete a room (host leaving). Cascade-deletes players/answers via DB constraints.
 */
export async function deleteRoom(roomId) {
  const { error } = await supabase
    .from('rooms')
    .delete()
    .eq('id', roomId);

  if (error) console.error('[Supabase] deleteRoom failed:', error.message);
  return { error };
}

/**
 * Fire-and-forget room deletion using fetch with keepalive.
 * Reliable during page unload (beforeunload / pagehide).
 */
export function deleteRoomBeacon(roomId) {
  fetch(`${SUPABASE_URL}/rest/v1/rooms?id=eq.${roomId}`, {
    method: 'DELETE',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
    },
    keepalive: true
  });
}

/**
 * Fetch all players in a room.
 */
export async function fetchPlayers(roomId) {
  const { data, error } = await supabase
    .from('players')
    .select('*')
    .eq('room_id', roomId)
    .order('joined_at', { ascending: true });

  if (error) {
    console.error('[Supabase] fetchPlayers failed:', error.message);
    return [];
  }
  return data;
}

/**
 * Toggle a player's ready status.
 */
export async function toggleReady(playerId, isReady) {
  const { error } = await supabase
    .from('players')
    .update({ is_ready: isReady })
    .eq('id', playerId);

  if (error) console.error('[Supabase] toggleReady failed:', error.message);
  return { error };
}

// ============================================
// Chat
// ============================================

/**
 * Send a chat message.
 */
export async function sendMessage(roomId, playerName, message) {
  const { error } = await supabase
    .from('chat_messages')
    .insert({ room_id: roomId, player_name: playerName, message });

  if (error) console.error('[Supabase] sendMessage failed:', error.message);
  return { error };
}

/**
 * Archive chat messages for a room into chat_archive table.
 * Stores the entire conversation as ONE row per room with a JSON array of messages.
 * Called when the game ends (before room might be deleted).
 */
/**
 * Archive chat messages for a room into chat_archive table.
 * Table schema: id (uuid PK), room_code, category, host_name, player_count,
 * messages (jsonb), game_started_at, archived_at.
 * Note: The live table was restructured and no longer has a room_id column.
 * We insert a new row per game (not upsert by room_id).
 */
export async function archiveChatMessages(roomId) {
  try {
    const { data: roomData } = await fetchRoom(roomId);
    if (!roomData) return;

    const rawMessages = await fetchMessages(roomId);
    if (!rawMessages || rawMessages.length === 0) return;

    // Shape each message to only keep what we need
    const messages = rawMessages.map(m => ({
      player_name: m.player_name,
      message: m.message,
      timestamp: m.created_at
    }));

    // Count current players for the archive record
    const players = await fetchPlayers(roomId);

    const { error } = await supabase
      .from('chat_archive')
      .insert({
        room_code: roomData.code || null,
        category: roomData.category || null,
        host_name: roomData.host_name || null,
        player_count: players.length,
        messages,
        game_started_at: roomData.created_at || new Date().toISOString(),
        archived_at: new Date().toISOString()
      });

    if (error) console.error('[Supabase] archiveChatMessages failed:', error.message);
  } catch (err) {
    console.error('[Supabase] archiveChatMessages error:', err);
  }
}

/**
 * Fetch chat messages for a room.
 */
export async function fetchMessages(roomId) {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true })
    .limit(100);

  if (error) {
    console.error('[Supabase] fetchMessages failed:', error.message);
    return [];
  }
  return data;
}

// ============================================
// Realtime Subscriptions
// ============================================

/**
 * Subscribe to player changes in a room.
 * callback receives { eventType, new, old } on INSERT/UPDATE/DELETE.
 */
export function subscribeToPlayers(roomId, callback) {
  return supabase.channel(`room-${roomId}-players`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'players',
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      try { callback(payload); } catch (e) { console.error('[Supabase] Player change callback error:', e); }
    })
    .subscribe((status, err) => {
      if (err) console.error('[Supabase] Players subscription error:', err);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[Supabase] Players subscription failed, status:', status);
      }
    });
}

/**
 * Subscribe to new chat messages in a room.
 */
export function subscribeToMessages(roomId, callback) {
  return supabase.channel(`room-${roomId}-messages`)
    .on('postgres_changes', {
      event: 'INSERT',
      schema: 'public',
      table: 'chat_messages',
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      try { callback(payload); } catch (e) { console.error('[Supabase] Message callback error:', e); }
    })
    .subscribe((status, err) => {
      if (err) console.error('[Supabase] Messages subscription error:', err);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[Supabase] Messages subscription failed, status:', status);
      }
    });
}

/**
 * Subscribe to room changes (UPDATE for game state, DELETE for host leaving).
 */
export function subscribeToRoom(roomId, callback) {
  return supabase.channel(`room-${roomId}-status`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'rooms',
      filter: `id=eq.${roomId}`
    }, (payload) => {
      try { callback(payload); } catch (e) { console.error('[Supabase] Room change callback error:', e); }
    })
    .subscribe((status, err) => {
      if (err) console.error('[Supabase] Room subscription error:', err);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[Supabase] Room subscription failed, status:', status);
      }
    });
}

/**
 * Create a Presence channel for tracking player away/active state.
 */
export function createPresenceChannel(roomId, playerId) {
  return supabase.channel(`room-${roomId}-presence`, {
    config: { presence: { key: String(playerId) } }
  });
}

/**
 * Create a broadcast channel for honks.
 */
export function createHonkChannel(roomId) {
  return supabase.channel(`room-${roomId}-honks`, {
    config: { broadcast: { self: true } }
  });
}

/**
 * Create a broadcast channel for typing indicators.
 * self: false — we don't need to receive our own typing events.
 */
export function createTypingChannel(roomId) {
  return supabase.channel(`room-${roomId}-typing`, {
    config: { broadcast: { self: false } }
  });
}

/**
 * Create a broadcast channel for difficulty votes.
 */
export function createDifficultyVoteChannel(roomId) {
  return supabase.channel(`room-${roomId}-difficulty-votes`, {
    config: { broadcast: { self: true } }
  });
}

/**
 * Update room status.
 */
export async function updateRoomStatus(roomId, status) {
  const { error } = await supabase
    .from('rooms')
    .update({ status })
    .eq('id', roomId);

  if (error) console.error('[Supabase] updateRoomStatus failed:', error.message);
  return { error };
}

/**
 * Remove a Supabase Realtime channel.
 */
export function unsubscribe(channel) {
  if (channel) supabase.removeChannel(channel);
}

// ============================================
// Questions
// ============================================

/**
 * Fetch questions for a category.
 * Fetches extra and shuffles client-side since PostgREST has no random order.
 * Tries common column names for question text/answer fields.
 */
export async function fetchQuestionsByCategory(category, limit, excludeIds = []) {
  // Fetch extra to account for excluded IDs + shuffling
  const fetchCount = Math.min((limit + excludeIds.length) * 3, 200);
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .contains('categories', [category])
    .eq('format', 'open')
    .limit(fetchCount);

  if (error) {
    console.error('[Supabase] fetchQuestionsByCategory failed:', error.message);
    return [];
  }

  // Filter out previously used questions (client-side — PostgREST doesn't support NOT IN for arrays well)
  const excludeSet = new Set(excludeIds);
  const filtered = excludeSet.size > 0 ? data.filter(q => !excludeSet.has(q.id)) : data;

  // Shuffle and take requested count
  for (let i = filtered.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }
  return filtered.slice(0, limit);
}

/**
 * Append question IDs to a room's used_question_ids array.
 * Persists across Play Again cycles — prevents repeat questions.
 */
export async function appendUsedQuestionIds(roomId, newIds) {
  const { data: roomData } = await fetchRoom(roomId);
  const existing = roomData?.used_question_ids || [];
  const merged = [...new Set([...existing, ...newIds])];
  const { error } = await supabase
    .from('rooms')
    .update({ used_question_ids: merged })
    .eq('id', roomId);
  if (error) console.error('[Supabase] appendUsedQuestionIds failed:', error.message);
}

/**
 * Fetch a single random question by category and difficulty.
 * Used for the final question after difficulty vote.
 * Excludes any questionIds already used in this game.
 */
export async function fetchQuestionByDifficulty(category, difficulty, excludeIds = []) {
  let query = supabase
    .from('questions')
    .select('*')
    .contains('categories', [category])
    .eq('format', 'open')
    .eq('difficulty', difficulty)
    .limit(20);

  const { data, error } = await query;
  if (error || !data || data.length === 0) {
    console.warn('[Supabase] fetchQuestionByDifficulty: no questions found for', difficulty);
    return null;
  }

  // Filter out already-used questions
  const available = excludeIds.length > 0
    ? data.filter(q => !excludeIds.includes(q.id))
    : data;

  if (available.length === 0) return data[Math.floor(Math.random() * data.length)]; // Fallback: allow repeats
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Fetch questions by their IDs (preserves order via client-side sort).
 */
export async function fetchQuestionsByIds(questionIds) {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .in('id', questionIds);

  if (error) {
    console.error('[Supabase] fetchQuestionsByIds failed:', error.message);
    return [];
  }

  // Preserve order of questionIds
  const idMap = {};
  for (const q of (data || [])) idMap[q.id] = q;
  return questionIds.map(id => idMap[id]).filter(Boolean);
}

/**
 * Save the selected question IDs to the room.
 */
export async function saveQuestionIds(roomId, questionIds) {
  const { error } = await supabase
    .from('rooms')
    .update({ question_ids: questionIds })
    .eq('id', roomId);

  if (error) console.error('[Supabase] saveQuestionIds failed:', error.message);
  return { error };
}

/**
 * Update game state on the room (game_phase, current_question).
 * Only the host should call this.
 */
export async function updateGameState(roomId, updates) {
  const { error } = await supabase
    .from('rooms')
    .update(updates)
    .eq('id', roomId);

  if (error) console.error('[Supabase] updateGameState failed:', error.message);
  return { error };
}

// ============================================
// Answers
// ============================================

/**
 * Submit or update an answer for a question.
 * Uses upsert on (room_id, player_id, question_number).
 */
export async function submitAnswer({ roomId, playerId, questionNumber, questionId, wager, submittedAnswer, isCorrect, scoreEarned }) {
  const { data, error } = await supabase
    .from('answers')
    .upsert({
      room_id: roomId,
      player_id: playerId,
      question_number: questionNumber,
      question_id: questionId,
      wager,
      submitted_answer: submittedAnswer || '',
      is_correct: isCorrect,
      score_earned: scoreEarned
    }, { onConflict: 'room_id,player_id,question_number' })
    .select()
    .single();

  if (error) {
    console.error('[Supabase] submitAnswer failed:', error.message);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Fetch all answers for a specific question in a room.
 */
export async function fetchAnswersForQuestion(roomId, questionNumber) {
  const { data, error } = await supabase
    .from('answers')
    .select('*')
    .eq('room_id', roomId)
    .eq('question_number', questionNumber);

  if (error) {
    console.error('[Supabase] fetchAnswersForQuestion failed:', error.message);
    return [];
  }
  return data;
}

/**
 * Update an answer's judgment (host override).
 */
export async function updateAnswerJudgment(answerId, isCorrect, scoreEarned) {
  const { error } = await supabase
    .from('answers')
    .update({ is_correct: isCorrect, score_earned: scoreEarned })
    .eq('id', answerId);

  if (error) console.error('[Supabase] updateAnswerJudgment failed:', error.message);
  return { error };
}

/**
 * Fetch all answers for a room (for computing scores).
 */
export async function fetchAllAnswers(roomId) {
  const { data, error } = await supabase
    .from('answers')
    .select('*')
    .eq('room_id', roomId);

  if (error) {
    console.error('[Supabase] fetchAllAnswers failed:', error.message);
    return [];
  }
  return data;
}

/**
 * Delete all answers for a room (used when starting a new game via Play Again).
 */
export async function deleteAnswersByRoom(roomId) {
  const { error } = await supabase
    .from('answers')
    .delete()
    .eq('room_id', roomId);

  if (error) console.error('[Supabase] deleteAnswersByRoom failed:', error.message);
  return { error };
}

/**
 * Reassign all answers from one player to another (used on reconnect after
 * removePlayerBeacon deleted the old player row but left answers behind).
 */
export async function reassignPlayerAnswers(roomId, oldPlayerId, newPlayerId) {
  const { error } = await supabase
    .from('answers')
    .update({ player_id: newPlayerId })
    .eq('room_id', roomId)
    .eq('player_id', oldPlayerId);

  if (error) console.error('[Supabase] reassignPlayerAnswers failed:', error.message);
  return { error };
}

/**
 * Subscribe to answer changes in a room (inserts + updates for host override).
 */
export function subscribeToAnswers(roomId, callback) {
  return supabase.channel(`room-${roomId}-answers`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'answers',
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      try { callback(payload); } catch (e) { console.error('[Supabase] Answer change callback error:', e); }
    })
    .subscribe((status, err) => {
      if (err) console.error('[Supabase] Answers subscription error:', err);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[Supabase] Answers subscription failed, status:', status);
      }
    });
}

/**
 * Fetch current room data (for non-host to get question_ids after game start).
 */
export async function fetchRoom(roomId) {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('id', roomId)
    .single();

  if (error) {
    console.error('[Supabase] fetchRoom failed:', error.message);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Get the approximate server time by making a lightweight request.
 * Uses the Date header from the Supabase response.
 * Returns { serverNow: Date, offset: number } where offset = serverTime - clientTime in ms.
 */
export async function getServerTimeOffset() {
  try {
    const before = Date.now();
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rooms?select=id&limit=0`, {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
      }
    });
    const after = Date.now();
    const dateHeader = response.headers.get('date');
    if (dateHeader) {
      const serverTime = new Date(dateHeader).getTime();
      const clientMidpoint = (before + after) / 2;
      return serverTime - clientMidpoint;
    }
    return 0;
  } catch {
    return 0;
  }
}

/**
 * Test the Supabase connection by making a simple request.
 * Returns true if connected, false otherwise.
 */
export async function testConnection() {
  try {
    // A lightweight query — just check we can reach Supabase
    const { error } = await supabase.from('questions').select('id', { count: 'exact', head: true });
    if (error) {
      console.warn('[Supabase] Connection test query error:', error.message);
      // Even if the table query fails, if we got a response, the connection works
      return true;
    }
    return true;
  } catch (err) {
    console.error('[Supabase] Connection failed:', err);
    return false;
  }
}

// ============================================
// QUESTION FEEDBACK
// ============================================

export async function upsertQuestionFeedback({ questionId, roomId, playerName, feedbackType, flagReason }) {
  const { error } = await supabase
    .from('question_feedback')
    .upsert({
      question_id: questionId,
      room_id: roomId,
      player_name: playerName,
      feedback_type: feedbackType,
      flag_reason: flagReason || null
    }, { onConflict: 'question_id,room_id,player_name' });

  if (error) console.error('[Supabase] upsertQuestionFeedback failed:', error.message);
}

export async function deleteQuestionFeedback({ questionId, roomId, playerName }) {
  const { error } = await supabase
    .from('question_feedback')
    .delete()
    .match({ question_id: questionId, room_id: roomId, player_name: playerName });

  if (error) console.error('[Supabase] deleteQuestionFeedback failed:', error.message);
}

export async function fetchQuestionFeedback(roomId, playerName) {
  const { data, error } = await supabase
    .from('question_feedback')
    .select('question_id, feedback_type')
    .eq('room_id', roomId)
    .eq('player_name', playerName);

  if (error) {
    console.error('[Supabase] fetchQuestionFeedback failed:', error.message);
    return [];
  }
  return data;
}

// ============================================
// GAME PLAYS (play/completion tracking)
// ============================================

export async function insertGamePlay({ roomId, playerId, playerName, category, totalQuestions }) {
  const { error } = await supabase
    .from('game_plays')
    .upsert({
      room_id: roomId,
      player_id: playerId,
      player_name: playerName,
      category,
      total_questions: totalQuestions,
      questions_answered: 0,
      started_at: new Date().toISOString(),
      completed: false
    }, { onConflict: 'room_id,player_id' });

  if (error) console.error('[Supabase] insertGamePlay failed:', error.message);
}

export async function incrementQuestionsAnswered(roomId, playerId) {
  // Fetch current count, then increment
  const { data, error: fetchErr } = await supabase
    .from('game_plays')
    .select('questions_answered')
    .eq('room_id', roomId)
    .eq('player_id', playerId)
    .single();

  if (fetchErr || !data) {
    console.error('[Supabase] incrementQuestionsAnswered fetch failed:', fetchErr?.message);
    return;
  }

  const { error } = await supabase
    .from('game_plays')
    .update({ questions_answered: (data.questions_answered || 0) + 1 })
    .eq('room_id', roomId)
    .eq('player_id', playerId);

  if (error) console.error('[Supabase] incrementQuestionsAnswered update failed:', error.message);
}

export async function completeGamePlay({ roomId, playerId, finalScore }) {
  const { error } = await supabase
    .from('game_plays')
    .update({
      completed: true,
      completed_at: new Date().toISOString(),
      final_score: finalScore
    })
    .eq('room_id', roomId)
    .eq('player_id', playerId);

  if (error) console.error('[Supabase] completeGamePlay failed:', error.message);
}

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
    console.error('[Supabase] createProfile failed:', error.message);
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
    console.error('[Supabase] fetchProfile failed:', error.message);
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
    .eq('display_name', displayName)
    .eq('discriminator', discriminator)
    .maybeSingle();

  if (error) {
    console.error('[Supabase] fetchProfileByTag failed:', error.message);
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
    console.error('[Supabase] updateProfile failed:', error.message);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Fetch all player_stats rows for a user (per-category stats).
 */
export async function fetchPlayerStats(userId) {
  const { data, error } = await supabase
    .from('player_stats')
    .select('*')
    .eq('user_id', userId);

  if (error) {
    console.error('[Supabase] fetchPlayerStats failed:', error.message);
    return [];
  }
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
    console.error('[Supabase] fetchGameHistory failed:', error.message);
    return [];
  }
  return data || [];
}

// ============================================
// PLAYER STATS & GAME HISTORY (write)
// ============================================

/**
 * Upsert player_stats for a user+category after a game completes.
 * Increments aggregate stats (questions_answered, correct_answers, games_played, wins).
 */
export async function upsertPlayerStats(userId, category, questionsAnswered, correctAnswers, won) {
  const { data: existing } = await supabase
    .from('player_stats')
    .select('*')
    .eq('user_id', userId)
    .eq('category', category)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase.from('player_stats').update({
      questions_answered: existing.questions_answered + questionsAnswered,
      correct_answers: existing.correct_answers + correctAnswers,
      games_played: existing.games_played + 1,
      wins: existing.wins + (won ? 1 : 0)
    }).eq('id', existing.id);
    if (error) console.error('[Supabase] upsertPlayerStats update failed:', error.message);
  } else {
    const { error } = await supabase.from('player_stats').insert({
      user_id: userId,
      category,
      questions_answered: questionsAnswered,
      correct_answers: correctAnswers,
      games_played: 1,
      wins: won ? 1 : 0
    });
    if (error) console.error('[Supabase] upsertPlayerStats insert failed:', error.message);
  }
}

/**
 * Insert a game_history entry when a game completes.
 */
export async function insertGameHistoryEntry({ userId, roomId, category, score, placement, totalPlayers }) {
  const { error } = await supabase.from('game_history').insert({
    user_id: userId,
    room_id: roomId,
    category,
    score,
    placement,
    total_players: totalPlayers
  });
  if (error) console.error('[Supabase] insertGameHistoryEntry failed:', error.message);
}

// ============================================
// QUESTION MASTERY TRACKING
// ============================================

/**
 * Upsert a question_history row for a user+question.
 * Increments times_seen (always) and times_correct (if correct).
 * Foundation for future spaced repetition / adaptive question selection.
 */
export async function upsertQuestionHistory(userId, questionId, isCorrect) {
  const { data: existing } = await supabase
    .from('question_history')
    .select('id, times_seen, times_correct')
    .eq('user_id', userId)
    .eq('question_id', questionId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase.from('question_history').update({
      times_seen: existing.times_seen + 1,
      times_correct: existing.times_correct + (isCorrect ? 1 : 0),
      last_seen_at: new Date().toISOString()
    }).eq('id', existing.id);
    if (error) console.error('[Supabase] upsertQuestionHistory update failed:', error.message);
  } else {
    const { error } = await supabase.from('question_history').insert({
      user_id: userId,
      question_id: questionId,
      times_seen: 1,
      times_correct: isCorrect ? 1 : 0,
      last_seen_at: new Date().toISOString()
    });
    if (error) console.error('[Supabase] upsertQuestionHistory insert failed:', error.message);
  }
}

// ============================================
// FRIENDS & FRIEND REQUESTS
// ============================================

/**
 * Send a friend request. Returns { data, error }.
 * Error code 23505 = duplicate request already exists.
 */
export async function sendFriendRequest(senderId, receiverId) {
  if (senderId === receiverId) {
    return { data: null, error: { message: 'Cannot send a friend request to yourself' } };
  }
  const { data, error } = await supabase
    .from('friend_requests')
    .insert({ sender_id: senderId, receiver_id: receiverId, status: 'pending' })
    .select()
    .single();

  if (error) {
    console.error('[Supabase] sendFriendRequest failed:', error.message);
    return { data: null, error };
  }
  return { data, error: null };
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
    console.error('[Supabase] fetchPendingRequests failed:', error.message);
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
    console.error('[Supabase] fetchSentRequests failed:', error.message);
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
    console.error('[Supabase] acceptFriendRequest fetch failed:', fetchErr?.message);
    return { error: fetchErr };
  }

  // Update status
  const { error: updateErr } = await supabase
    .from('friend_requests')
    .update({ status: 'accepted' })
    .eq('id', requestId);

  if (updateErr) {
    console.error('[Supabase] acceptFriendRequest update failed:', updateErr.message);
    return { error: updateErr };
  }

  // Create friendship (canonical ordering)
  const { error: friendErr } = await createFriendship(req.sender_id, req.receiver_id, 'request');
  if (friendErr) {
    console.error('[Supabase] acceptFriendRequest createFriendship failed:', friendErr.message);
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

  if (error) console.error('[Supabase] declineFriendRequest failed:', error.message);
  return { error };
}

/**
 * Create a friendship between two users (instant add from lobby/game).
 * Enforces canonical ordering: user_a < user_b.
 */
export async function createFriendship(userIdA, userIdB, source = 'lobby') {
  const [user_a, user_b] = [userIdA, userIdB].sort();
  const { data, error } = await supabase
    .from('friendships')
    .insert({ user_a, user_b, source })
    .select()
    .single();

  if (error) {
    // 23505 = already friends (unique constraint)
    if (error.code === '23505') return { data: null, error: null };
    console.error('[Supabase] createFriendship failed:', error.message);
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

  if (error) console.error('[Supabase] removeFriend failed:', error.message);
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
    console.error('[Supabase] fetchFriends failed:', error.message);
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
    console.error('[Supabase] fetchFriends profiles failed:', pErr.message);
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
    console.error('[Supabase] isFriend failed:', error.message);
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
 * Search profiles by display name (ILIKE).
 */
export async function searchProfiles(query, excludeUserId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .ilike('display_name', `%${query}%`)
    .neq('user_id', excludeUserId)
    .limit(10);

  if (error) {
    console.error('[Supabase] searchProfiles failed:', error.message);
    return [];
  }
  return data || [];
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
      try { callback(payload); } catch (e) { console.error('[Supabase] Friend request callback error:', e); }
    })
    .subscribe();
}

export async function fetchCategoryPlayCounts() {
  const { data, error } = await supabase
    .from('game_plays')
    .select('category');

  if (error) {
    console.error('[Supabase] fetchCategoryPlayCounts failed:', error.message);
    return {};
  }

  const counts = {};
  for (const row of (data || [])) {
    counts[row.category] = (counts[row.category] || 0) + 1;
  }
  return counts;
}
