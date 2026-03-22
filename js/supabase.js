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
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error('[Supabase] Failed to fetch categories:', error.message);
      return [];
    }

    for (const row of data) {
      // Supabase returns text[] as a JS array
      const cats = Array.isArray(row.categories) ? row.categories : [];
      for (const cat of cats) {
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }

    hasMore = data.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }

  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generate a random 6-digit numeric room code.
 */
export function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
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

  console.log('[Supabase] Creating room:', roomPayload);

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
 * Find a room by its 6-digit code (only lobbies).
 */
export async function findRoomByCode(code) {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('code', code.trim())
    .eq('status', 'lobby')
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
    .eq('status', 'lobby')
    .eq('who_can_join', 'anyone')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('[Supabase] fetchPublicRooms failed:', error.message);
    return [];
  }

  // Get player counts for each room
  const roomIds = rooms.map(r => r.id);
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
  for (const p of players) {
    countMap[p.room_id] = (countMap[p.room_id] || 0) + 1;
  }

  return rooms.map(r => ({ ...r, player_count: countMap[r.id] || 0 }));
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
    }, (payload) => callback(payload))
    .subscribe();
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
 * Subscribe to room status changes (e.g., game start).
 */
export function subscribeToRoom(roomId, callback) {
  return supabase.channel(`room-${roomId}-status`)
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'rooms',
      filter: `id=eq.${roomId}`
    }, (payload) => callback(payload))
    .subscribe();
}

/**
 * Create a Presence channel for tracking player away/active state.
 */
export function createPresenceChannel(roomId) {
  return supabase.channel(`room-${roomId}-presence`);
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
  for (const q of data) idMap[q.id] = q;
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
    console.log('[Supabase] Connected successfully.');
    return true;
  } catch (err) {
    console.error('[Supabase] Connection failed:', err);
    return false;
  }
}
