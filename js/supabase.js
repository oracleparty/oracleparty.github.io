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
    return rooms.map(r => ({ ...r, player_count: '?' }));
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
export async function addPlayer(roomId, displayName, isHost = false) {
  const { data, error } = await supabase
    .from('players')
    .insert({ room_id: roomId, display_name: displayName, is_host: isHost, joined_at: new Date().toISOString() })
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

    const { error } = await supabase
      .from('chat_archive')
      .upsert({
        room_id: roomId,
        room_code: roomData.code || null,
        category: roomData.category || null,
        archived_at: new Date().toISOString(),
        messages
      }, { onConflict: 'room_id' });

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
    }, (payload) => callback(payload))
    .subscribe();
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
    }, (payload) => callback(payload))
    .subscribe();
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
export async function fetchQuestionsByCategory(category, limit) {
  const fetchCount = Math.min(limit * 3, 100);
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

  // Shuffle and take requested count
  for (let i = data.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [data[i], data[j]] = [data[j], data[i]];
  }
  return data.slice(0, limit);
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
 * Subscribe to answer changes in a room (inserts + updates for host override).
 */
export function subscribeToAnswers(roomId, callback) {
  return supabase.channel(`room-${roomId}-answers`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'answers',
      filter: `room_id=eq.${roomId}`
    }, (payload) => callback(payload))
    .subscribe();
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
