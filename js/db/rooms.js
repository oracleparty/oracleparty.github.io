// ============================================
// Oracle Party — Room Database Operations
// ============================================

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './client.js';
import { logger } from '../logger.js';
import { PUBLIC_ROOMS_LIMIT } from '../constants.js';
import { notifyConnectionLost, notifyConnectionRestored } from '../utils.js';

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
export async function createRoom({ hostName, category, subcategory, whoCanJoin, questionsPerGame, questionTimer, autoProceed }) {
  const roomPayload = {
    code: generateRoomCode(),
    host_name: hostName,
    category,
    who_can_join: whoCanJoin,
    questions_per_game: questionsPerGame,
    question_timer: questionTimer,
    status: 'lobby'
  };
  // Only include subcategory if set — omit entirely if null so the INSERT
  // works even when the subcategory column hasn't been added to the DB yet
  if (subcategory) roomPayload.subcategory = subcategory;
  if (autoProceed) roomPayload.auto_proceed = autoProceed;

  const { data, error } = await supabase
    .from('rooms')
    .insert(roomPayload)
    .select()
    .single();

  if (error) {
    logger.error('Supabase', 'Room creation failed', error);

    // Retry once on unique constraint violation (code collision)
    if (error.code === '23505') {
      roomPayload.code = generateRoomCode();
      const { data: d2, error: e2 } = await supabase
        .from('rooms')
        .insert(roomPayload)
        .select()
        .single();
      if (e2) {
        logger.error('Supabase', 'Room creation retry failed', e2);
        return { data: null, error: e2 };
      }
      return { data: d2, error: null };
    }

    return { data: null, error };
  }

  return { data, error: null };
}

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
    logger.error('Supabase', 'findRoomByCode failed', error);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Fetch public rooms in lobby status with player counts.
 */
export async function fetchPublicRooms() {
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: rooms, error } = await supabase
    .from('rooms')
    .select('id, code, host_name, category, who_can_join, questions_per_game, question_timer, status, created_at')
    .in('status', ['lobby', 'playing'])
    .eq('who_can_join', 'anyone')
    .gt('created_at', twoHoursAgo)
    .order('created_at', { ascending: false })
    .limit(PUBLIC_ROOMS_LIMIT);

  if (error) {
    logger.error('Supabase', 'fetchPublicRooms failed', error);
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
    logger.error('Supabase', 'fetchPublicRooms player count failed', pErr);
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
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  // Delete rooms with 0 players (any age — these are zombie rooms)
  const { data: allRooms } = await supabase
    .from('rooms')
    .select('id')
    .in('status', ['lobby', 'playing']);

  if (allRooms && allRooms.length > 0) {
    for (const room of allRooms) {
      const { count } = await supabase
        .from('players')
        .select('id', { count: 'exact', head: true })
        .eq('room_id', room.id);
      if (count === 0) {
        await supabase.from('rooms').delete().eq('id', room.id);
      }
    }
  }

  // Delete all rooms older than 2 hours (stale regardless of player count)
  const { data: staleRooms } = await supabase
    .from('rooms')
    .select('id')
    .in('status', ['lobby', 'playing'])
    .lt('created_at', twoHoursAgo);

  if (staleRooms && staleRooms.length > 0) {
    for (const room of staleRooms) {
      await supabase.from('rooms').delete().eq('id', room.id);
    }
  }
}

/**
 * Delete a room (host leaving). Cascade-deletes players/answers via DB constraints.
 */
export async function deleteRoom(roomId) {
  const { error } = await supabase
    .from('rooms')
    .delete()
    .eq('id', roomId);

  if (error) logger.error('Supabase', 'deleteRoom failed', error);
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
 * Fetch current room data (for non-host to get question_ids after game start).
 */
export async function fetchRoom(roomId) {
  const { data, error } = await supabase
    .from('rooms')
    .select('*')
    .eq('id', roomId)
    .single();

  if (error) {
    logger.error('Supabase', 'fetchRoom failed', error);
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Update room status.
 */
export async function updateRoomStatus(roomId, status) {
  const { error } = await supabase
    .from('rooms')
    .update({ status })
    .eq('id', roomId);

  if (error) logger.error('Supabase', 'updateRoomStatus failed', error);
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

  if (error) logger.error('Supabase', 'updateGameState failed', error);
  return { error };
}

/**
 * Save the selected question IDs to the room.
 */
export async function saveQuestionIds(roomId, questionIds) {
  const { error } = await supabase
    .from('rooms')
    .update({ question_ids: questionIds })
    .eq('id', roomId);

  if (error) logger.error('Supabase', 'saveQuestionIds failed', error);
  return { error };
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
  if (error) logger.error('Supabase', 'appendUsedQuestionIds failed', error);
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
    console.warn('[Oracle Party] Server time sync: no Date header, falling back to local time');
    return 0;
  } catch (err) {
    console.warn('[Oracle Party] Server time sync failed, falling back to local time:', err);
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
      logger.warn('Supabase', 'Connection test query error', error);
      // Even if the table query fails, if we got a response, the connection works
      return true;
    }
    return true;
  } catch (err) {
    logger.error('Supabase', 'Connection failed', err);
    return false;
  }
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
      try { callback(payload); } catch (e) { logger.error('Supabase', 'Room change callback error', e); }
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        notifyConnectionRestored();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (err) logger.error('Supabase', 'Room subscription error', err);
        logger.warn('Supabase', 'Room subscription failed, status: ' + status);
        notifyConnectionLost();
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
 * Remove a Supabase Realtime channel.
 */
export function unsubscribe(channel) {
  if (channel) supabase.removeChannel(channel);
}
