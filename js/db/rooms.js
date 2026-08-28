// ============================================
// Oracle Party — Room Database Operations
// ============================================

import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, noteServerFunctions } from './client.js';
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
    // `subcategory` is NOT optional here even though nothing about the query
    // needs it: join.js renders each row with
    // resolveCategoryLabel(room.category, room.subcategory), so leaving it out
    // made every public game advertise itself by CATEGORY only. A room hosting
    // Ancient History appeared as plain "History", and somebody browsing the
    // list could not see what they were about to join.
    //
    // It was invisible in the harness until the fake store started honouring
    // the column list — before that it handed back whole rows and the label
    // looked right here while being wrong live.
    .select('id, code, host_name, category, subcategory, who_can_join, questions_per_game, question_timer, status, created_at')
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

  // `is_host` and `user_id` come back for the host's reputation, which is the
  // one thing on this list a player most wants BEFORE they tap a stranger's
  // room. Same lesson as `subcategory` above: the column list is part of what
  // the screen can say.
  const { data: players, error: pErr } = await supabase
    .from('players')
    .select('room_id, is_host, is_bot, user_id')
    .in('room_id', roomIds);

  if (pErr) {
    logger.error('Supabase', 'fetchPublicRooms player count failed', pErr);
    // Return rooms without counts
    return rooms.map(r => ({ ...r, player_count: 0, host_user_id: null }));
  }

  const countMap = {};
  const hostMap = {};
  for (const p of (players || [])) {
    countMap[p.room_id] = (countMap[p.room_id] || 0) + 1;
    // A bot is never the host (js/game/host-promotion.js enforces it), but the
    // filter costs nothing and states the rule where the data is read.
    if (p.is_host && !p.is_bot && p.user_id) hostMap[p.room_id] = p.user_id;
  }

  return rooms.map(r => ({
    ...r,
    player_count: countMap[r.id] || 0,
    // null when the host is a guest — which is the ordinary case, not a
    // failure, and the join list renders it as "no rating yet" rather than 0%.
    host_user_id: hostMap[r.id] || null,
  }));
}

/**
 * Clean up orphaned rooms (rooms with 0 players remaining).
 * Never deletes rooms that still have active players.
 */
export async function cleanupOrphanedRooms() {
  // THE SERVER SWEEPS, and everything below it is the pre-048 fallback.
  //
  // Migration 048 revoked DELETE on `rooms`, so every delete in this function
  // became a silent no-op — no error, zero rows. The Join page calls this and
  // nothing else, so its sweep stopped working entirely and dead rooms went
  // back to being offered to real players: exactly the "two active games
  // nobody was in" this was written to end. op_sweep_rooms applies the same
  // three rules, decided in one statement rather than read-then-delete.
  const served = await sweepRoomsOnServer();
  if (served.ok) return;

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
  // As in cleanupOrphanedRooms: 048 revoked DELETE on `rooms`, so everything
  // below is refused in silence once it is applied. The admin dashboard calls
  // this one directly before it counts, so without the server sweep the number
  // an admin reads and the list a player sees would drift apart again.
  const served = await sweepRoomsOnServer();
  if (served.ok) return;

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
 * Leave a room, and take the room with you only if nobody is left in it.
 *
 * ONE CALL INSTEAD OF READ-THEN-DECIDE-THEN-DELETE. Every caller in js/ used to
 * count the players it could see, conclude it was the last one, and delete —
 * which is a race when two people quit at once: both see two players, both
 * conclude somebody else is staying, and the room survives with nobody in it.
 * That is one of the ways "two active games nobody was in" happened.
 *
 * It also closes the hole: with migration 048 applied, `rooms` has no DELETE
 * policy at all, so this function is the only way a room can go — and it checks
 * the rule before it does.
 *
 * → { ok, outcome } — ok is false when the function is not installed, which is
 *   the caller's cue to do it the old way.
 */
export async function leaveRoomOnServer(roomId, playerId = null) {
  const { data, error } = await supabase.rpc('op_leave_room', {
    p_room_id: roomId,
    p_player_id: playerId,
  });
  if (error) {
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) {
      logger.debug('Supabase', 'op_leave_room not installed, leaving the old way');
      noteServerFunctions(false);
    } else {
      logger.error('Supabase', 'op_leave_room failed', error);
    }
    return { ok: false, outcome: null };
  }
  noteServerFunctions(true);
  return { ok: true, outcome: data || null };
}

/**
 * The same thing during page unload, where only a keepalive fetch survives.
 *
 * Deliberately mirrors deleteRoomBeacon rather than going through the client:
 * the Supabase library's request would be cancelled with the page.
 */
export function leaveRoomBeacon(roomId, playerId = null) {
  fetch(`${SUPABASE_URL}/rest/v1/rpc/op_leave_room`, {
    method: 'POST',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_room_id: roomId, p_player_id: playerId }),
    keepalive: true,
  }).catch(() => { /* the page is going away; nothing can be reported */ });
}

/**
 * Run the room cleanup rules server-side (migration 048).
 *
 * → { ok, deleted }
 */
export async function sweepRoomsOnServer() {
  const { data, error } = await supabase.rpc('op_sweep_rooms');
  if (error) {
    if (!(error.code === 'PGRST202' || /could not find the function/i.test(error.message || ''))) {
      logger.error('Supabase', 'op_sweep_rooms failed', error);
    }
    return { ok: false, deleted: 0 };
  }
  return { ok: true, deleted: Number(data) || 0 };
}

/**
 * End a room from the admin dashboard (migration 051).
 *
 * Migration 048 revoked DELETE on `rooms`, and the admin's "End" button was a
 * plain delete — so it reported success, redrew the dashboard, and the room was
 * still running. op_leave_room cannot stand in for it: that deletes a room only
 * when nobody is left, and this button exists for rooms that still have people
 * in them.
 *
 * → { ok, refused }. `refused` means the server did not accept us as an admin,
 * which must never look the same as "the room was already gone".
 */
export async function endRoomAsAdmin(roomId) {
  const { data, error } = await supabase.rpc('op_admin_end_room', { p_room_id: roomId });
  if (error) {
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) {
      return { ok: false, refused: false, unavailable: true };
    }
    logger.error('Supabase', 'op_admin_end_room failed', error);
    return { ok: false, refused: false, unavailable: false };
  }
  return { ok: data === true, refused: data === false, unavailable: false };
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
      noteServerFunctions(false);
    } else {
      logger.error('Supabase', 'op_start_clock failed', error);
    }
    return null;
  }
  return data || null;
}

/**
 * Ask the server to move a stalled round on. Needs migration 056.
 *
 * THE STALL THIS EXISTS FOR. Every phase change in this game is a write from
 * one phone, and the timer-expiry path in `handleTimerExpired` is behind
 * `canControlGame()`. When the host's screen locks mid-round, or they take a
 * call, or their signal drops, the timer runs out on every phone in the room
 * and nothing happens at all. Everyone sits on a dead question screen.
 *
 * AUTHORITY IS NOT INITIATIVE. Postgres cannot wake itself on a timer, so a
 * client still has to ask — what changes is that the ANSWER no longer comes
 * from the asker. `op_advance_phase` decides from the database's own clock and
 * every caller gets the same decision, which is what makes it safe for ANY
 * player in the room to call rather than only the host.
 *
 * It refuses unless the clock really has run out, and it waits well past the
 * point where `op_submit_answer` would still accept an answer — so a phone with
 * a fast clock cannot close a round early and turn somebody's answer into a
 * blank. Calling it too often costs nothing but a round trip.
 *
 * → the text of what the server did ('question -> reveal', 'not due', …), or
 *   null when the function is not installed. Null means "carry on exactly as
 *   before": the host's own path still ends rounds, and this is a backstop.
 */
export async function advancePhaseOnServer(roomId, callerPlayerId) {
  if (!roomId || !callerPlayerId) return null;
  const { data, error } = await supabase.rpc('op_advance_phase', {
    p_room_id: roomId,
    p_caller_id: callerPlayerId,
  });
  if (error) {
    // PGRST202 only. A function that exists under different argument names
    // answers the same way and is just as dead to us (CLAUDE.md #6), but
    // anything else is a real failure and must not be read as "not installed".
    if (error.code === 'PGRST202' || /could not find the function/i.test(error.message || '')) {
      logger.debug('Supabase', 'op_advance_phase not installed — the host still ends rounds');
      noteServerFunctions(false);
    } else {
      // Logged, never toasted. This runs on a timer on every phone in the room,
      // and the player has lost nothing when it fails — the host's own path is
      // still there. A toast per phone per round is the noise that teaches
      // people to ignore real warnings (CLAUDE.md #4).
      logger.warn('Supabase', 'op_advance_phase failed', error);
    }
    return null;
  }
  return data ?? null;
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
