// ============================================
// Oracle Party — Room Database Operations
// ============================================

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './client.js';
import { logger, reportWriteFailure } from '../logger.js';
import { PUBLIC_ROOMS_LIMIT, ABANDONED_ROOM_MS } from '../constants.js';
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
    // PGRST116 is .single() finding no row — a mistyped code, which is an
    // ordinary thing for a player to do, not a fault. Logging it as an error
    // wrote a row to error_logs on every typo and buried the real failures
    // among them.
    if (error.code === 'PGRST116') return { data: null, error: null };
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

  // Delete LOBBY rooms older than 2 hours. We deliberately do NOT touch
  // 'playing' rooms here, even if they're old — a casual game with friends
  // can easily run 2+ hours (long category, lots of pauses), and a stale-age
  // sweep that runs every time anyone opens the home page would otherwise
  // delete the room out from under active players. Empty rooms of any
  // status are already handled by the per-room player-count check above.
  const { data: staleLobbies } = await supabase
    .from('rooms')
    .select('id')
    .eq('status', 'lobby')
    .lt('created_at', twoHoursAgo);

  if (staleLobbies && staleLobbies.length > 0) {
    for (const room of staleLobbies) {
      await supabase.from('rooms').delete().eq('id', room.id);
    }
  }

  // ABANDONED rooms: player rows still there, but nobody behind them.
  //
  // The zero-player check above cannot catch these. A player row is removed by
  // a beacon on unload, or by another client in the room running the stale
  // sweep — so if everybody's phone dies at once, nobody sweeps, the rows sit
  // there forever, and the room reads as a game in progress. Which is what the
  // owner saw: two "active games" nobody was in. It also means the Join page
  // offers dead rooms to real players.
  //
  // last_seen_at is the evidence, and it is already maintained by the
  // heartbeat every 15 seconds. A room where EVERY human has been silent far
  // longer than any heartbeat gap has nobody in it.
  await cleanupAbandonedRooms();
}

/**
 * Delete rooms whose players have all stopped heartbeating.
 *
 * Deliberately conservative, because deleting a live room out from under a
 * game is far worse than leaving a dead one on a list:
 *
 *   · ABANDONED_ROOM_MS is much longer than the in-game stale timeout. A real
 *     game heartbeats every 15 seconds; this waits many minutes of total
 *     silence from everybody.
 *   · A player with NO last_seen_at at all means "cannot tell", not "silent
 *     since 1970" — the room is left alone. Absence of evidence is not
 *     evidence of absence, which is the mistake that once had hosts kicking
 *     every player seconds after they joined.
 *   · Bots are ignored when asking whether anyone is alive, because a bot has
 *     no browser and never heartbeats. A room containing only bots is
 *     abandoned by definition: nobody is there to play.
 */
export async function cleanupAbandonedRooms() {
  const { data: rooms } = await supabase
    .from('rooms')
    .select('id')
    .in('status', ['lobby', 'playing']);
  if (!rooms || rooms.length === 0) return;

  const { data: players, error } = await supabase
    .from('players')
    .select('room_id, last_seen_at, is_bot')
    .in('room_id', rooms.map(r => r.id));
  if (error) { logger.error('Supabase', 'cleanupAbandonedRooms failed', error); return; }

  const byRoom = new Map();
  for (const p of players || []) {
    if (!byRoom.has(p.room_id)) byRoom.set(p.room_id, []);
    byRoom.get(p.room_id).push(p);
  }

  const cutoff = Date.now() - ABANDONED_ROOM_MS;
  for (const room of rooms) {
    const humans = (byRoom.get(room.id) || []).filter(p => !p.is_bot);
    // No humans at all is the zero-player case, already handled above; leaving
    // it here too costs nothing and covers a bots-only room.
    const anyoneAlive = humans.some(p => {
      if (!p.last_seen_at) return true;   // cannot tell — assume alive
      return new Date(p.last_seen_at).getTime() > cutoff;
    });
    if (anyoneAlive) continue;
    await supabase.from('rooms').delete().eq('id', room.id);
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

  reportWriteFailure('Update room', error, "Couldn't start the game — check your connection");
  return { error };
}

/**
 * Update game state on the room (game_phase, current_question).
 * Only the host should call this.
 */
/**
 * Stamp the start of a round with the DATABASE's clock (migration 047).
 *
 * Every timer in the game is derived from `question_started_at`, and it used to
 * be written as `Date.now() + serverTimeOffset` from the host's phone — an
 * ESTIMATE of server time. That was harmless while only browsers read it: every
 * phone reads the same stamp, so a skewed estimate skewed everybody equally.
 *
 * It stopped being harmless when the server began judging (migration 046),
 * because `op_submit_answer` compares the stamp against the database's own
 * `now()`. A host whose estimate ran slow would have every answer in the room
 * refused as late; one whose estimate ran fast would have the timer never
 * expire. Stamping from `now()` removes the disagreement rather than tolerating
 * it — one clock, by construction.
 *
 * Replaces a write the client already made, so it costs no extra round trip.
 *
 * → an ISO string, or null when the function is not installed (the caller then
 *   falls back to its own estimate, exactly as before).
 */
export async function startClockOnServer(roomId, phase, questionNumber = null) {
  const { data, error } = await supabase.rpc('op_start_clock', {
    p_room_id: roomId,
    p_phase: phase,
    p_question_number: questionNumber,
  });
  if (error) {
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) {
      logger.debug('Supabase', 'op_start_clock not installed, stamping from this device');
    } else {
      logger.error('Supabase', 'op_start_clock failed', error);
    }
    return null;
  }
  return data || null;
}

export async function updateGameState(roomId, updates) {
  const { error } = await supabase
    .from('rooms')
    .update(updates)
    .eq('id', roomId);

  reportWriteFailure('Advance game', error, "Couldn't move the game on — check your connection");
  return { error };
}

/**
 * Add one game's scores to the room's running Room Scores tally.
 *
 * The tally used to live in sessionStorage on each phone, which meant it died
 * with the tab — somebody who left and came back saw nothing — and that every
 * device kept its own version, computed from whatever games that device
 * happened to witness. Two people could read different numbers off the same
 * lobby with no way to tell which was right. Needs migration 038.
 *
 * Read-modify-write rather than a jsonb merge in SQL, because the merge would
 * have to ADD to each existing value and PostgREST cannot express that. The
 * race it exposes is not a real one: only the host writes this, once per game,
 * and there is exactly one host.
 *
 * `earned` is { displayName: pointsThisGame }. Nothing is deleted, so a player
 * who has left keeps their line — that is the point of a room tally.
 */
export async function addRoomScores(roomId, earned) {
  const { data: room, error: readErr } = await supabase
    .from('rooms')
    .select('room_scores')
    .eq('id', roomId)
    .maybeSingle();

  // Before migration 038 is applied this column does not exist and the select
  // errors. Bail rather than wiping the row with a write it cannot satisfy —
  // the lobby falls back to showing no tally, which is what it did before.
  if (readErr) {
    logger.error('Supabase', 'addRoomScores read failed', readErr);
    return { error: readErr };
  }

  const cumulative = { ...(room?.room_scores || {}) };
  for (const [name, points] of Object.entries(earned || {})) {
    cumulative[name] = (cumulative[name] || 0) + (points || 0);
  }

  const { error } = await supabase
    .from('rooms')
    .update({ room_scores: cumulative })
    .eq('id', roomId);

  if (error) logger.error('Supabase', 'addRoomScores write failed', error);
  return { error };
}

/**
 * Read the room's cumulative Room Scores tally. Returns {} when the column is
 * not there yet (migration 038 unapplied) or the room is gone, so the lobby
 * simply shows no tally rather than an error.
 */
export async function fetchRoomScores(roomId) {
  const { data, error } = await supabase
    .from('rooms')
    .select('room_scores')
    .eq('id', roomId)
    .maybeSingle();
  if (error) { logger.error('Supabase', 'fetchRoomScores failed', error); return {}; }
  return data?.room_scores || {};
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
