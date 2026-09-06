import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, noteServerFunctions } from './client.js';
import { logger, reportWriteFailure } from '../logger.js';
import { STALE_TIMEOUT_MS } from '../constants.js';
import { notifyConnectionLost, notifyConnectionRestored } from '../utils.js';

// ============================================
// Player Management
// ============================================

/**
 * Add a player to a room.
 */
export async function addPlayer(roomId, displayName, isHost = false, userId = null, extras = {}) {
  // Deliberately does NOT set last_seen_at. That column is missing from the
  // live players table, and Postgres rejects an entire INSERT for an unknown
  // column — writing it here would stop anyone joining at all, exactly as the
  // same mistake silently killed every game_plays insert. The staleness check
  // falls back to joined_at instead, so a missing column cannot get anyone
  // kicked. Add it here once migration 027 is confirmed applied.
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

  // A REFUSED INSERT IS NOT ALWAYS A CONNECTION PROBLEM, and saying so is the
  // fault this project has recorded most often. Two rules can refuse this row,
  // both with 42501, and the honest message is different for each:
  //
  //   058  claiming the host flag in a room that already has a live host —
  //        handled in claimSeat, which downgrades the claim before it gets here
  //   065  this person was KICKED out of this room
  //
  // So on a refusal we ASK, rather than guessing from the code. op_is_banned is
  // callable by clients precisely so the screen can tell the truth: "you were
  // removed from this room" is actionable, and "check your connection" sends
  // somebody to fix a network that was never broken. That exact wrong message
  // is what an AFK host saw over and over on 2026-09-05.
  if (error) {
    let banned = false;
    // `userId` is the auth identity the caller already resolved — the same one
    // the policy checks. Using it rather than importing auth.js keeps this
    // module free of a cycle (auth.js reaches this file through supabase.js),
    // and a player with no id is exactly the case that cannot be banned anyway.
    if (error.code === '42501' && userId) {
      const { data: isBanned } = await supabase.rpc('op_is_banned', {
        p_room_id: roomId, p_user_id: userId,
      });
      banned = !!isBanned;
    }
    if (banned) {
      reportWriteFailure('Join room', error, 'You were removed from this room');
      return { data: null, error, banned: true };
    }
    reportWriteFailure('Join room', error, "Couldn't join the room — check your connection and try again");
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Take a seat in a room, reusing the one you already have rather than adding
 * another.
 *
 * THE BUG THIS EXISTS FOR. A person who left and came back appeared in the
 * lobby two, three, four times over — reported from a live game as three copies
 * of one player. Two faults stacked into a ratchet that could only get worse:
 *
 *   * join.html called addPlayer unconditionally, with no check at all. Leave
 *     with a phone that never fired its unload beacon — locked screen, dead
 *     battery, lost signal — and rejoining made a SECOND row.
 *   * ensureCurrentPlayer in the lobby then adopted an existing row only when
 *     there was EXACTLY ONE match, and otherwise created another. So at two
 *     duplicates it made a third, at three a fourth, and it could never get
 *     back to the one case it knew how to handle. Every rejoin from then on
 *     added another copy, for the life of the room.
 *
 * WHO YOU ARE is a user id when signed in, which is exact, and a display name
 * when not, which is not. That difference is the whole design here:
 *
 *   * Signed in — any row with your user id is yours. Take the newest, delete
 *     the rest. One account, one seat.
 *   * A guest — a same-name row that is STILL ALIVE might genuinely be somebody
 *     else who picked your name, so it is left alone and you get a new seat.
 *     Only rows that have gone quiet are treated as your abandoned ones, and
 *     those are cleaned up. Being wrong here costs somebody their seat
 *     mid-game, which is worse than an extra row.
 *
 * Liveness falls back to joined_at, because addPlayer does not write
 * last_seen_at and a row that never heartbeated would otherwise look ancient.
 */
export async function claimSeat({ roomId, displayName, userId = null, isHost = false, extras = {}, priorPlayerId = null }) {
  const { data: rows, error: readErr } = await supabase
    .from('players').select('*').eq('room_id', roomId);
  if (readErr) {
    logger.warn('Supabase', 'claimSeat could not read the room, adding a seat', readErr);
    return addPlayer(roomId, displayName, isHost, userId, extras);
  }

  const all = rows || [];
  const now = Date.now();
  const seenAt = p => new Date(p.last_seen_at || p.joined_at || 0).getTime();
  const alive = p => now - seenAt(p) < STALE_TIMEOUT_MS;

  // A REMEMBERED SEAT ID IS PROOF, AND IT BEATS EVERY GUESS BELOW.
  //
  // The guest rule further down skips rows that are still alive, because a
  // same-name row might genuinely be somebody else. That left one duplicate
  // path wide open: a guest who CLOSES THE TAB loses sessionStorage, comes back
  // through the join screen within the stale window, finds their own row still
  // alive — and is handed a brand new one beside it. Two Bobs, and the reported
  // "3 profiles of my friend... after he left and rejoined" is this repeated.
  //
  // recallSeat keeps the previous player id in localStorage, which survives the
  // browser closing. If a row in this room still carries that id, it is not a
  // guess about who somebody is; it is the seat they were sitting in.
  if (priorPlayerId) {
    const exact = all.find(p => String(p.id) === String(priorPlayerId));
    if (exact) return { data: exact, error: null };
  }

  const mine = userId
    ? all.filter(p => p.user_id && String(p.user_id) === String(userId))
    : all.filter(p => !p.user_id && p.display_name === displayName && !alive(p));

  if (mine.length === 0) {
    // ASKING TO COME BACK AS HOST WHEN SOMEBODY ELSE ALREADY IS ONE IS REFUSED
    // BY THE DATABASE, NOT SOFTENED.
    //
    // Migration 058's INSERT policy is `NOT is_host OR NOT
    // op_room_has_live_host(room_id)`, so a row carrying is_host into a room
    // that has a live host is rejected outright with 42501 — and addPlayer
    // reports that as "Couldn't join the room — check your connection and try
    // again", which is a lie about the cause and about the remedy.
    //
    // A host who goes AFK long enough has their seat swept and somebody else
    // promoted, while their own sessionStorage still says isHost. Every attempt
    // to come back then asks for a crown the room has already given away, so
    // the refusal repeats for as long as they keep trying. Reported from a live
    // game: "I went AFK from the lobby, it said I could not join a bunch of
    // times, the lobby was still active but it didn't show me as a player."
    //
    // 058's own comment says the client's `someoneElseIsHost` check is what
    // decides this — and that check lived in js/game/init.js and NOWHERE ELSE,
    // so the lobby handed the crown straight back into a refusal. It belongs
    // here, where every seat in the app is claimed, rather than being stated
    // once more in a fourth place and forgotten in a fifth.
    const liveHostElsewhere = isHost && all.some(p =>
      p.is_host && alive(p) && !p.is_bot
      && !(userId && p.user_id && String(p.user_id) === String(userId)));
    if (liveHostElsewhere) {
      logger.info('Supabase', 'claimSeat: the room already has a live host, taking an ordinary seat');
    }
    return addPlayer(roomId, displayName, isHost && !liveHostElsewhere, userId, extras);
  }

  // Newest first — the freshest row is the one carrying the most recent state.
  mine.sort((a, b) => seenAt(b) - seenAt(a));
  const [keep, ...duplicates] = mine;

  // Through op_remove_player (migration 057), not a direct delete — `players`
  // has no DELETE policy for clients once that is applied, and a refused delete
  // returns no error and zero rows, so this would have gone on reporting that
  // it had tidied up.
  //
  // The caller is the seat being KEPT, which is what makes this legitimate
  // server-side: a duplicate carries the same user_id (rule 3), and for a guest
  // with no id at all the rows reaching this loop were already filtered to ones
  // that have gone quiet, which rule 4 covers. Either way it is never "remove an
  // arbitrary live stranger".
  for (const dup of duplicates) {
    const { error } = await removePlayer(dup.id, roomId, keep.id);
    if (error) logger.warn('Supabase', 'claimSeat could not clear a duplicate seat', error);
  }
  if (duplicates.length) {
    logger.info('Supabase', `claimSeat reclaimed a seat and cleared ${duplicates.length} duplicate(s)`);
  }

  return { data: keep, error: null };
}

/**
 * Add a practice bot to a room.
 *
 * A bot is an ordinary `players` row with is_bot set, so it shows up in the
 * lobby, the reveal and the scoreboard through the code that already exists.
 * Only a human can create one, and only from a lobby they are hosting — there
 * are no bot-only rooms.
 *
 * If migration 030 has not been run, `is_bot` does not exist and Postgres
 * rejects the whole INSERT. That surfaces as a toast rather than a silent
 * no-op, which is the entire point of reportWriteFailure: the schema-drift
 * bugs in this project were all invisible because nothing told anybody.
 */
export async function addBot(roomId, displayName, { avatarColor, avatarEmoji } = {}) {
  const payload = {
    room_id: roomId,
    display_name: displayName,
    is_host: false,
    is_bot: true,
    is_ready: true,
    joined_at: new Date().toISOString()
  };
  if (avatarColor) payload.avatar_color = avatarColor;
  if (avatarEmoji) payload.avatar_emoji = avatarEmoji;

  const { data, error } = await supabase
    .from('players')
    .insert(payload)
    .select()
    .single();

  if (reportWriteFailure('Add bot', error, "Couldn't add the practice bot")) {
    return { data: null, error };
  }
  return { data, error: null };
}

/**
 * Promote a player to host. Sets is_host on the player and updates room's host_name.
 */
export async function promoteToHost(roomId, playerId, displayName, callerId) {
  // TAKE THE CROWN OFF EVERYONE ELSE FIRST.
  //
  // This used to only set the flag on the new host and never clear it on the
  // old one, so every promotion ADDED a host. A live game ended up with two
  // abandoned copies of one player both flagged host while the only person
  // actually in the lobby was not — and since "is there a host" was answered by
  // those rows, nothing ever corrected it.
  //
  // Clearing first, not last: if the second statement fails the room briefly
  // has no host, which promotion is designed to fix on its next pass. The other
  // order leaves two hosts, which nothing was looking for.
  // One statement server-side, which also removes the clear-then-set race: the
  // function does both inside a single call, in that order, for the reason
  // below.
  const served = await setHostRoleOnServer(roomId, callerId, playerId, 'host', true);

  // Whether the FALLBACK landed, when there was a fallback. Its two writes
  // used to be logged and thrown away, and this returned ok unconditionally —
  // so the one path where 058 has revoked the column but the function is also
  // missing reported a promotion that could not have happened, and the caller
  // announced it. The other three role functions already returned `!error`
  // here; this one did not, which is the same rule stated four times and
  // followed three.
  let fallbackOk = true;
  if (!served.handled) {
    const { error: clearError } = await supabase
      .from('players').update({ is_host: false })
      .eq('room_id', roomId).neq('id', playerId);
    if (clearError) logger.error('Supabase', 'promoteToHost could not clear the previous host', clearError);

    const { error: setError } = await supabase
      .from('players').update({ is_host: true }).eq('id', playerId);
    if (setError) logger.error('Supabase', 'promoteToHost player update failed', setError);
    // The SET is what makes somebody host. A failed clear leaves a spare crown,
    // which promotion fixes on its next pass; a failed set leaves nobody at
    // all, and the caller must not say otherwise.
    fallbackOk = !setError;
  }

  // The room's host_name either way — `rooms` UPDATE is still open, and this is
  // a display field rather than an authority one.
  const { error: roomError } = await supabase
    .from('rooms').update({ host_name: displayName }).eq('id', roomId);
  if (roomError) logger.error('Supabase', 'promoteToHost room update failed', roomError);

  // WHETHER THE ROLE ACTUALLY MOVED. Every caller used to assume it did and
  // then announce it in chat — see the note on setHostRoleOnServer. When the
  // server DECLINES (a live host is already there, which is the guard working)
  // this is false, and the caller must not claim otherwise.
  return { ok: served.handled ? served.ok : fallbackOk };
}

/**
 * Grant or take the host / co-host role, through the server. Needs migration 058.
 *
 * `players` no longer grants a client UPDATE on `is_host` or `is_cohost` — the
 * columns, not the policy, are what stop it, so a direct write is refused
 * outright rather than silently matching zero rows. That matters: a host
 * overrides the machine's verdict on any answer, and migration 041 makes that
 * amend the PERMANENT question_history of every player it touches, so one
 * request used to take over a game AND let the taker rewrite other people's
 * records.
 *
 * The server allows it when the caller IS the current host — a deliberate
 * transfer — or when the room has no live host at all, which is the promotion
 * path after somebody has gone. Never while a live host is sitting there.
 *
 * → true when the server handled it; false when the function is missing, so the
 *   caller can fall back to the old direct write and this stays safe to deploy
 *   before the SQL is run.
 */
async function setHostRoleOnServer(roomId, callerId, targetId, role, value) {
  if (!roomId || !callerId || !targetId) return { handled: false, ok: false };
  const { data, error } = await supabase.rpc('op_set_host_role', {
    p_room_id: roomId,
    p_caller_id: callerId,
    p_target_id: targetId,
    p_role: role,
    p_value: value,
  });
  if (error) {
    if (functionMissing(error)) { noteServerFunctions(false); return { handled: false, ok: false }; }
    logger.error('Supabase', 'op_set_host_role failed', error);
    // Reached the server and failed — do NOT retry directly, 058 revoked the
    // column. handled means "the fallback must not run"; ok means "the role
    // actually changed", and those are different questions.
    return { handled: true, ok: false };
  }
  if (data !== 'ok') {
    // Not a fault the player can act on: both the lobby and the stale sweep
    // race to promote, so "a live host is already here" is the guard working.
    logger.debug('Supabase', `op_set_host_role declined: ${data}`, { role, targetId });
  }
  return { handled: true, ok: data === 'ok' };
}

/**
 * Demote a player from host status.
 */
export async function demoteHost(playerId, roomId, callerId) {
  const served = await setHostRoleOnServer(roomId, callerId, playerId, 'host', false);
  if (served.handled) return { ok: served.ok };

  const { error } = await supabase.from('players').update({ is_host: false }).eq('id', playerId);
  if (error) logger.error('Supabase', 'demoteHost failed', error);
  return { ok: !error };
}

/**
 * Promote a player to co-host.
 *
 * → { ok } — DID THE ROLE ACTUALLY MOVE. These four used to return nothing at
 * all, so every caller assumed success: the lobby marked the player co-host in
 * its own list AND posted "X is now co-host" to the chat, whether or not the
 * write landed. op_set_host_role DECLINES when the room's own state does not
 * allow it — which is the guard working, not a fault — and a decline was
 * indistinguishable from a success. CLAUDE.md records co-host "silently doing
 * nothing, for months"; this is a fresh way to reach the same place.
 */
export async function promoteToCohost(playerId, roomId, callerId) {
  const served = await setHostRoleOnServer(roomId, callerId, playerId, 'cohost', true);
  if (served.handled) return { ok: served.ok };

  const { error } = await supabase.from('players').update({ is_cohost: true }).eq('id', playerId);
  reportWriteFailure('Promote co-host', error, "Couldn't make them co-host");
  return { ok: !error };
}

/**
 * Demote a player from co-host status.
 */
export async function demoteCohost(playerId, roomId, callerId) {
  const served = await setHostRoleOnServer(roomId, callerId, playerId, 'cohost', false);
  if (served.handled) return { ok: served.ok };

  const { error } = await supabase.from('players').update({ is_cohost: false }).eq('id', playerId);
  reportWriteFailure('Demote co-host', error, "Couldn't remove co-host");
  return { ok: !error };
}

/**
 * Remove a player from a room. Needs migration 057.
 *
 * `roomId` and `callerId` are REQUIRED, and deliberately not optional. Without
 * them the server cannot tell a player leaving from a stranger removing
 * somebody mid-game, and an optional parameter that a call site forgets fails
 * SILENTLY — which is how `amendQuestionHistory` quietly stopped correcting
 * anybody's history when it gained a required roomId and one caller was missed.
 * `scripts/check-arity.mjs` fails the build on a call that drops either.
 *
 * op_remove_player allows exactly four things, checked against the room's own
 * state rather than the caller's word: you are leaving, the host is removing a
 * BOT, the seat has genuinely gone quiet (measured on the database's clock), or
 * it is a duplicate carrying your own user id.
 *
 * FALLS BACK to the direct delete when the function is missing, so this is safe
 * to deploy before the SQL is run — the direction this project has repeatedly
 * got wrong. Once 057 IS applied the fallback is refused by RLS, silently and
 * correctly, and the RPC is the only path.
 */
export async function removePlayer(playerId, roomId, callerId) {
  if (playerId && roomId && callerId) {
    const { data, error } = await supabase.rpc('op_remove_player', {
      p_room_id: roomId,
      p_caller_id: callerId,
      p_target_id: playerId,
    });
    if (!error) {
      // 'not allowed' is the guard working, not a fault: both stale sweeps run
      // on every client and race each other, and the server re-checks silence
      // against its own clock. A toast here would fire constantly.
      if (data === 'not allowed') {
        logger.debug('Supabase', 'op_remove_player declined — the rules do not allow this removal', { playerId });
      }
      return { error: null, outcome: data };
    }
    if (!functionMissing(error)) {
      logger.error('Supabase', 'op_remove_player failed', error);
      return { error };
    }
    noteServerFunctions(false);
  }

  const { error } = await supabase
    .from('players')
    .delete()
    .eq('id', playerId);

  if (error) logger.error('Supabase', 'removePlayer failed', error);
  return { error };
}

/**
 * The host removes a player. Needs migration 065.
 *
 * TWO ACTIONS, ONE CALL, and the difference is the whole point:
 *   ban=false  EJECT — they leave the room and can come back with the code.
 *   ban=true   KICK  — they leave, and that room refuses them for as long as
 *                     it exists (a room survives Play Again, so a kick lasts
 *                     the sitting rather than one game).
 *
 * NO FALLBACK, deliberately, and this is the opposite call from removePlayer.
 * That one falls back to a direct delete because leaving a room has to work
 * whether or not the SQL is applied. This has never worked before 065: there
 * IS no old path, and inventing one would mean a direct delete that RLS
 * refuses silently — the host presses the button, nothing happens, and nothing
 * says so. With the function missing, `unavailable` reaches the caller and the
 * screen can tell the truth.
 *
 * The three outcomes are kept apart rather than flattened to a boolean:
 * 'removed', 'removed_no_ban' (there was no identity to keep out) and
 * 'not allowed'. "We kicked them" and "we removed them and could not keep them
 * out" are different facts and the host is entitled to know which happened.
 */
export async function kickPlayer(playerId, roomId, callerId, ban = false) {
  const { data, error } = await supabase.rpc('op_kick_player', {
    p_room_id: roomId,
    p_caller_id: callerId,
    p_target_id: playerId,
    p_ban: !!ban,
  });
  if (!error) return { outcome: data, error: null };
  if (functionMissing(error)) {
    noteServerFunctions(false);
    return { outcome: 'unavailable', error: null };
  }
  logger.error('Supabase', 'op_kick_player failed', error);
  return { outcome: null, error };
}

/**
 * Fire-and-forget player removal using fetch with keepalive.
 * Reliable during page unload (beforeunload / pagehide).
 * Used ONLY for explicit leave actions (Leave button, Back button).
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
 * Fire-and-forget soft disconnect signal using fetch with keepalive.
 * Sets disconnected_at on the player row WITHOUT deleting it.
 * Used on beforeunload/pagehide so refresh can resume the session.
 * If the player comes back (refresh), playerHeartbeat clears this.
 * If they don't (tab close), stale check removes them after timeout.
 */
export function markDisconnectedBeacon(playerId) {
  fetch(`${SUPABASE_URL}/rest/v1/players?id=eq.${playerId}`, {
    method: 'PATCH',
    headers: {
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: JSON.stringify({ disconnected_at: new Date().toISOString() }),
    keepalive: true
  });
}

/**
 * Update last_seen_at and clear disconnected_at for a player.
 * Called every 15s as a DB heartbeat, and immediately on session resume.
 * Proves the player is still alive; stale check uses last_seen_at for cleanup.
 */
export async function playerHeartbeat(playerId) {
  const { error } = await supabase
    .from('players')
    .update({ last_seen_at: new Date().toISOString(), disconnected_at: null })
    .eq('id', playerId);
  if (error) logger.error('Supabase', 'playerHeartbeat failed', error);
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
    logger.error('Supabase', 'fetchPlayers failed', error);
    return [];
  }
  return data;
}

/**
 * Toggle a player's ready status.
 */
/**
 * Ready up, and SAY SO when the seat is not there.
 *
 * This was a bare UPDATE whose result was thrown away. An update against a row
 * that no longer exists matches ZERO ROWS and returns NO ERROR — so the button
 * flipped, the list redrew, and nothing was written. Reported from a live game
 * as "had to leave and rejoin in order to even ready up and have the game
 * start": the client was holding a seat the room did not have, and every press
 * reported success.
 *
 * `missing` is a THIRD answer, kept apart from both success and failure,
 * because the caller can do something about this one that it cannot do about a
 * dropped connection: take a seat again and try once more.
 */
export async function toggleReady(playerId, isReady) {
  const { data, error } = await supabase
    .from('players')
    .update({ is_ready: isReady })
    .eq('id', playerId)
    .select('id');

  if (error) {
    reportWriteFailure('Ready toggle', error, "Couldn't update your ready status");
    return { error };
  }
  // No error and no row is the silence this whole codebase is built around
  // noticing. Deliberately NOT toasted here — the caller repairs the seat and
  // retries, and a message for something it is about to fix is noise.
  if (!data || data.length === 0) {
    logger.warn('Supabase', 'toggleReady matched no row — this seat is not in the room', { playerId });
    return { error: null, missing: true };
  }
  return { error: null };
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
      try { callback(payload); } catch (e) { logger.error('Supabase', 'Player change callback error', e); }
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        notifyConnectionRestored();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (err) logger.error('Supabase', 'Players subscription error', err);
        logger.warn('Supabase', 'Players subscription failed, status: ' + status);
        notifyConnectionLost();
      }
    });
}

// ============================================
// GAME PLAYS (play/completion tracking)
// ============================================

export async function insertGamePlay({ roomId, playerId, playerName, category, subcategory, totalQuestions, gameKey }) {
  // record_game_play (migration 034) counts ROUNDS, not rooms. A room survives
  // "Play Again", so the old plain upsert had a group's whole evening counting
  // as one play each — under-counting exactly the people who play most.
  //
  // gameKey is the room's countdown timestamp, rewritten at the start of every
  // game and identical on every phone in the room. The function only advances
  // the counter when the key CHANGES, so calling this twice for one round is
  // harmless — which matters, because the caller fires from a phase transition
  // that is not guaranteed to happen exactly once.
  const { error } = await supabase.rpc('record_game_play', {
    p_room_id: roomId,
    p_player_id: playerId,
    p_player_name: playerName,
    p_category: category,
    p_subcategory: subcategory || null,
    p_total_questions: totalQuestions,
    p_game_key: gameKey || null,
  });
  if (!error) return;

  // Migration 034 not applied yet. Fall back to the original write, which
  // records the play but counts one per room rather than one per round.
  logger.warn('Supabase', 'record_game_play unavailable, falling back to upsert', error);
  const row = {
    room_id: roomId,
    player_id: playerId,
    player_name: playerName,
    category,
    total_questions: totalQuestions,
    questions_answered: 0,
    started_at: new Date().toISOString(),
    completed: false
  };
  if (subcategory) row.subcategory = subcategory;
  const { error: upsertError } = await supabase
    .from('game_plays')
    .upsert(row, { onConflict: 'room_id,player_id' });

  if (upsertError) logger.error('Supabase', 'insertGamePlay failed', upsertError);
}

export async function incrementQuestionsAnswered(roomId, playerId) {
  // Atomic increment via Supabase RPC — avoids read-then-write race condition.
  // Falls back to client-side increment if the RPC doesn't exist yet (migration 022).
  const { error } = await supabase.rpc('increment_questions_answered', {
    p_room_id: roomId,
    p_player_id: playerId
  });

  if (error) {
    // Fallback: RPC may not be deployed yet — use direct update
    logger.warn('Supabase', 'increment RPC failed, falling back to direct update', error);
    const { data } = await supabase
      .from('game_plays')
      .select('questions_answered')
      .eq('room_id', roomId)
      .eq('player_id', playerId)
      .single();
    if (data) {
      await supabase
        .from('game_plays')
        .update({ questions_answered: (data.questions_answered || 0) + 1 })
        .eq('room_id', roomId)
        .eq('player_id', playerId);
    }
  }
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

  if (error) logger.error('Supabase', 'completeGamePlay failed', error);
}

// ============================================
// Answers
// ============================================

/**
 * Submit or update an answer for a question.
 * Uses upsert on (room_id, player_id, question_number).
 *
 * `afterServerRefusal` says this is the fallback below a rejection from
 * op_submit_answer, and it changes ONLY what the player is told. Measured
 * against a real Postgres with the UPDATE policy removed, which is the shape
 * migration 049 left `answers` in:
 *
 *   INSERT ... ON CONFLICT DO UPDATE, no conflict  -> OK, the row is written
 *   INSERT ... ON CONFLICT DO UPDATE, conflicting  -> 42501, nothing written
 *
 * So the safety valve still works for a FIRST answer, and cannot overwrite an
 * existing row — which is exactly right when the server has just said the
 * round is over: the row already there is the one that stands.
 *
 * But the generic path then fired "Your answer didn't save — check your
 * connection and try again", which is a lie in three ways: it is not the
 * connection, trying again cannot help, and something IS saved. The screen was
 * already saying the true thing ("Time's up — your last answer stands") right
 * underneath it. It also logged at ERROR, so a legitimate late submit filled
 * the console with a refusal that is the system working.
 *
 * A 42501 in this one situation is therefore expected: warn, no toast. Any
 * OTHER error here, and every error when we did not come from a refusal, is
 * reported exactly as before — the distinction is the point, and widening it
 * would put this codebase's deepest fault (#4) back into its loudest path.
 */
export async function submitAnswer({ roomId, playerId, questionNumber, questionId, wager, submittedAnswer, isCorrect, scoreEarned, afterServerRefusal = false }) {
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
      // The machine's verdict, kept separate because is_correct is overwritten
      // in place when a host flips a judgement. Comparing the two is how a bad
      // answer key gets detected later.
      auto_correct: isCorrect,
      score_earned: scoreEarned
    }, { onConflict: 'room_id,player_id,question_number' })
    .select()
    .single();

  if (afterServerRefusal && error?.code === '42501') {
    logger.warn('Supabase', 'the server refused this answer and a row already stands for it, so nothing was overwritten', {
      questionNumber
    });
    return { data: null, error };
  }

  if (reportWriteFailure('Submit answer', error, "Your answer didn't save — check your connection and try again")) {
    return { data: null, error };
  }
  return { data, error: null };
}

// ============================================
// The server's versions (migrations 045 / 046)
//
// The game is moving off the host's phone. These call the database functions
// that judge and record an answer, so every phone in the room reads ONE verdict
// computed once instead of each browser deciding for itself.
//
// Both fall back to the client-side path when the function is not installed,
// which is what makes the JavaScript safe to deploy before the SQL is run —
// the reverse order has broken this project repeatedly (CLAUDE.md #3).
// ============================================

/**
 * Is this error "that function is not there"?
 *
 * PostgREST answers PGRST202 for a function it cannot resolve, which covers
 * both "never created" and "created with different argument names" — and the
 * second is just as dead to the app as the first (CLAUDE.md #6). Anything else
 * is a real failure and must NOT be read as a missing function, or a genuine
 * bug quietly becomes a silent fallback nobody ever notices.
 */
function functionMissing(error) {
  if (!error) return false;
  return error.code === 'PGRST202'
    || /could not find the function/i.test(error.message || '');
}

/**
 * Submit an answer and let the DATABASE decide what it is worth.
 *
 * → { row, error, unavailable }
 *   row.rejected is null when the answer was taken; otherwise it names why and
 *   nothing was written. A rejection is not an error — the app has to be able
 *   to tell "the timer beat you" from "the network died".
 */
export async function submitAnswerViaServer({ roomId, playerId, questionNumber, answer, wager }) {
  const { data, error } = await supabase.rpc('op_submit_answer', {
    p_room_id: roomId,
    p_player_id: playerId,
    p_question_number: questionNumber,
    p_answer: answer ?? '',
    p_wager: wager ?? null,
  });
  if (error) {
    if (functionMissing(error)) {
      logger.debug('Supabase', 'op_submit_answer not installed, judging locally');
      noteServerFunctions(false);
      return { row: null, error: null, unavailable: true };
    }
    logger.error('Supabase', 'op_submit_answer failed', error);
    return { row: null, error, unavailable: false };
  }
  // An installed function that returns nothing is a BUG, not an absent one.
  // Conflating the two is exactly how a dead feature reads as a healthy
  // fallback for months (CLAUDE.md #8).
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    logger.error('Supabase', 'op_submit_answer returned no row', { questionNumber });
    return { row: null, error: new Error('op_submit_answer returned no row'), unavailable: false };
  }
  noteServerFunctions(true);
  return { row, error: null, unavailable: false };
}

/**
 * Give a zero to everyone in the room who never answered this question.
 *
 * ANY client may call this and it is idempotent, which is the point: the round
 * closes as soon as any phone notices the clock has run out, instead of waiting
 * on a host whose screen may be off.
 *
 * → { ok, written } — ok is false when the function is not installed, which is
 *   the caller's cue to do it the old way.
 */
export async function fillBlankAnswersViaServer(roomId, questionNumber) {
  const { data, error } = await supabase.rpc('op_fill_blank_answers', {
    p_room_id: roomId,
    p_question_number: questionNumber,
  });
  if (error) {
    if (functionMissing(error)) {
      logger.debug('Supabase', 'op_fill_blank_answers not installed, filling locally');
    } else {
      logger.error('Supabase', 'op_fill_blank_answers failed', error);
    }
    return { ok: false, written: 0 };
  }
  return { ok: true, written: Number(data) || 0 };
}

/**
 * Insert blank answers for players who never submitted, WITHOUT overwriting
 * anyone who did.
 *
 * The host fills these in when the timer expires so absent players still score
 * zero. It used to go through submitAnswer(), whose upsert MERGES on conflict —
 * so a player who typed an answer and let the timer run out could have it
 * destroyed by the host's blank. Both devices act at the same moment, on the
 * same grace period: the player submits their typed text while the host, from a
 * snapshot taken microseconds earlier, still sees them as missing and writes a
 * blank over the top. The player's answer vanished and they scored zero on
 * something they had actually typed.
 *
 * ignoreDuplicates makes this ON CONFLICT DO NOTHING, so the race cannot be
 * lost in either order: if the real answer lands first the blank does nothing,
 * and if the blank lands first the real answer merges over it.
 */
export async function insertBlankAnswers(rows) {
  if (!rows || rows.length === 0) return { error: null };
  return insertAnswersIfAbsent(rows.map(r => ({
    roomId: r.roomId,
    playerId: r.playerId,
    questionNumber: r.questionNumber,
    questionId: r.questionId,
    wager: r.wager,
    submittedAnswer: '',
    isCorrect: false,
    scoreEarned: 0
  })), 'insertBlankAnswers');
}

/**
 * Write answers that must never overwrite one that is already there.
 *
 * The mechanism insertBlankAnswers relies on, split out because bots need it
 * too: the host writes a bot's answer, and so would a co-host or a deputy who
 * happens to be running the same code. ON CONFLICT DO NOTHING means whichever
 * device gets there first wins and the rest are no-ops, so a bot can never end
 * up with two different answers depending on whose phone was quicker.
 */
/**
 * Write answers that MUST replace whatever is already there.
 *
 * The final round is the one place a row already exists before the answer does
 * — every player writes a __WAGER_LOCKED__ placeholder when they lock their
 * wager — so a bot's final answer has to merge over it rather than do nothing.
 *
 * Deliberately not submitAnswer(): that one toasts "Your answer didn't save"
 * on failure, which is exactly right for a person and a lie when the host's
 * device is writing on a bot's behalf. A bot's failure is the host's log, not
 * the host's problem — if it never lands, the timer-expiry pass fills a blank
 * for the bot like any absent player.
 */
export async function upsertAnswers(rows, where = 'upsertAnswers') {
  if (!rows || rows.length === 0) return { error: null };
  const { error } = await supabase
    .from('answers')
    .upsert(rows.map(r => ({
      room_id: r.roomId,
      player_id: r.playerId,
      question_number: r.questionNumber,
      question_id: r.questionId,
      wager: r.wager,
      submitted_answer: r.submittedAnswer || '',
      is_correct: !!r.isCorrect,
      auto_correct: !!r.isCorrect,
      score_earned: r.scoreEarned || 0
    })), { onConflict: 'room_id,player_id,question_number' });

  if (error) logger.error('Supabase', where + ' failed', error);
  return { error };
}

/**
 * Write one answer on a BOT's behalf (migration 051).
 *
 * A bot is the only player that cannot write its own answer — the host's
 * browser does it. On the final round the bot already holds a __WAGER_LOCKED__
 * placeholder, so this has to merge over an existing row, which is an UPDATE,
 * which 049 closed. Without it a bot simply never answers the last question.
 *
 * The server's guard is that the target must be `is_bot`, which is far tighter
 * than "the caller is the host": nothing a person plays can be written through
 * here at all. The SCORE is computed server-side; only the coin flip is ours,
 * and a bot's accuracy is a setting rather than a fact about the answer.
 */
export async function botAnswerOnServer(row) {
  const { data, error } = await supabase.rpc('op_bot_answer', {
    p_room_id: row.roomId,
    p_player_id: row.playerId,
    p_question_number: row.questionNumber,
    p_question_id: row.questionId,
    p_wager: row.wager,
    p_answer: row.submittedAnswer || '',
    p_is_correct: !!row.isCorrect,
  });
  if (error) {
    if (!functionMissing(error)) {
      logger.warn('Supabase', 'op_bot_answer failed', error);
      return { ok: false, unavailable: false };
    }
    noteServerFunctions(false);
    return { ok: false, unavailable: true };
  }
  noteServerFunctions(true);
  if (data === false) logger.warn('Supabase', 'the server refused a bot answer', row.playerId);
  return { ok: data === true, unavailable: false };
}

export async function insertAnswersIfAbsent(rows, where = 'insertAnswersIfAbsent') {
  if (!rows || rows.length === 0) return { error: null };
  const { error } = await supabase
    .from('answers')
    .upsert(rows.map(r => ({
      room_id: r.roomId,
      player_id: r.playerId,
      question_number: r.questionNumber,
      question_id: r.questionId,
      wager: r.wager,
      submitted_answer: r.submittedAnswer || '',
      is_correct: !!r.isCorrect,
      auto_correct: !!r.isCorrect,
      score_earned: r.scoreEarned || 0
    })), { onConflict: 'room_id,player_id,question_number', ignoreDuplicates: true });

  if (error) logger.error('Supabase', where + ' failed', error);
  return { error };
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
    logger.error('Supabase', 'fetchAnswersForQuestion failed', error);
    return [];
  }
  return data;
}

/**
 * Update an answer's judgment (host override).
 */
/**
 * The host disagrees with the machine (migration 049).
 *
 * The POINTS are no longer sent — the database recomputes them from the
 * answer's own wager. That is the whole point of moving it: the old call passed
 * a verdict AND a score, so anything on the internet could set any score on any
 * answer in any live game.
 *
 * → { ok, unavailable, outcome }. `unavailable` is the ONLY cue to write
 *   directly — see below.
 *
 * NOT INSTALLED AND FAILED ARE DIFFERENT ANSWERS, and collapsing them lost a
 * host's correction in silence. Both branches used to return { ok: false }, so
 * ANY error — a blip, a timeout, a refusal — sent the caller down the direct
 * UPDATE on `answers`. Migration 049 revoked that: it matches zero rows and
 * returns NO error, so the override vanished for everybody while the host's own
 * screen showed the toggle flipped. A wrong score, silently, from the one
 * control whose whole job is fixing a wrong score.
 *
 * setPhaseOnServer and botAnswerOnServer in this same codebase already draw the
 * distinction; this and op_disqualify_round did not.
 */
export async function setJudgementOnServer(answerId, isCorrect, callerPlayerId) {
  const { data, error } = await supabase.rpc('op_set_judgement', {
    p_answer_id: answerId,
    p_is_correct: isCorrect,
    p_caller_id: callerPlayerId,
  });
  if (error) {
    if (functionMissing(error)) {
      logger.debug('Supabase', 'op_set_judgement not installed, writing directly');
      noteServerFunctions(false);
      return { ok: false, unavailable: true, outcome: null };
    }
    // Reached the server and failed. Do NOT retry directly — 049 makes that a
    // no-op that reports success.
    logger.error('Supabase', 'op_set_judgement failed', error);
    return { ok: false, unavailable: false, outcome: null };
  }
  noteServerFunctions(true);
  if (data && data !== 'changed') {
    // Refused for a reason worth seeing: the answer is gone, or this player is
    // not running the room. Silence here would look like the tap did nothing.
    logger.warn('Supabase', 'the server refused a judgement change', { outcome: data });
  }
  return { ok: true, unavailable: false, outcome: data || null };
}

/**
 * That round did not happen (migration 049). Returns rows changed, or -1 when
 * the caller is not the host.
 *
 * `unavailable` for the same reason as setJudgementOnServer above: the caller's
 * fallback is a loop of direct UPDATEs that 049 revoked, so treating a real
 * failure as "not installed" leaves a thrown-out round still paying points, with
 * nothing anywhere saying so.
 */
export async function disqualifyRoundOnServer(roomId, questionNumber, callerPlayerId) {
  const { data, error } = await supabase.rpc('op_disqualify_round', {
    p_room_id: roomId,
    p_question_number: questionNumber,
    p_caller_id: callerPlayerId,
  });
  if (error) {
    if (functionMissing(error)) {
      noteServerFunctions(false);
      return { ok: false, unavailable: true, changed: 0 };
    }
    logger.error('Supabase', 'op_disqualify_round failed', error);
    return { ok: false, unavailable: false, changed: 0 };
  }
  noteServerFunctions(true);
  return { ok: true, unavailable: false, changed: Number(data) };
}

export async function updateAnswerJudgment(answerId, isCorrect, scoreEarned) {
  const { error } = await supabase
    .from('answers')
    .update({ is_correct: isCorrect, score_earned: scoreEarned })
    .eq('id', answerId);

  if (error) logger.error('Supabase', 'updateAnswerJudgment failed', error);
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
    logger.error('Supabase', 'fetchAllAnswers failed', error);
    return [];
  }
  return data;
}

/**
 * Delete all answers for a room (used when starting a new game via Play Again).
 */
export async function deleteAnswersByRoom(roomId, callerPlayerId = null) {
  // Migration 049/050 shut UPDATE and DELETE on `answers` so a stranger could
  // not edit a live game's scores. This write is neither — it is Play Again
  // clearing the game that just ended — and it went down with them, in total
  // silence, because an RLS refusal returns no error and zero rows. The next
  // game's scoreboard was then computed over the last game's answers.
  //
  // op_reset_answers (051) is the same rule stated where it cannot be edited
  // out of a request: only the room's host may do it.
  if (callerPlayerId) {
    const { data, error } = await supabase.rpc('op_reset_answers', {
      p_room_id: roomId,
      p_caller_id: callerPlayerId,
    });
    if (!error) {
      noteServerFunctions(true);
      if (Number(data) === -1) {
        logger.warn('Supabase', 'the server refused to clear the answers — not the host');
      }
      return { error: null };
    }
    if (!functionMissing(error)) {
      logger.error('Supabase', 'op_reset_answers failed', error);
      return { error };
    }
    noteServerFunctions(false);
  }

  // Before 051 is applied. Kept so the JavaScript is safe to deploy ahead of
  // the SQL, which is the order this project has repeatedly got wrong.
  const { error } = await supabase
    .from('answers')
    .delete()
    .eq('room_id', roomId);

  if (error) logger.error('Supabase', 'deleteAnswersByRoom failed', error);
  return { error };
}

/**
 * Reassign all answers from one player to another (used on reconnect after
 * removePlayerBeacon deleted the old player row but left answers behind).
 */
export async function reassignPlayerAnswers(roomId, oldPlayerId, newPlayerId) {
  if (!oldPlayerId || !newPlayerId || String(oldPlayerId) === String(newPlayerId)) {
    return { error: null };
  }

  // Same story as deleteAnswersByRoom: an ordinary UPDATE, shut off by 049/050
  // without a sound, and what it costs is a returning player's score and their
  // used wagers. op_reassign_answers (051) allows it only for a seat that IS
  // GONE — you can never take answers off somebody still in the room.
  const { data, error } = await supabase.rpc('op_reassign_answers', {
    p_room_id: roomId,
    p_old_player_id: oldPlayerId,
    p_new_player_id: newPlayerId,
  });
  if (!error) {
    noteServerFunctions(true);
    if (Number(data) === -1) {
      logger.warn('Supabase', 'the server refused to move those answers', { oldPlayerId, newPlayerId });
    }
    return { error: null };
  }
  if (!functionMissing(error)) {
    logger.error('Supabase', 'op_reassign_answers failed', error);
    return { error };
  }
  noteServerFunctions(false);

  const { error: legacyError } = await supabase
    .from('answers')
    .update({ player_id: newPlayerId })
    .eq('room_id', roomId)
    .eq('player_id', oldPlayerId);

  if (legacyError) logger.error('Supabase', 'reassignPlayerAnswers failed', legacyError);
  return { error: legacyError };
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
      try { callback(payload); } catch (e) { logger.error('Supabase', 'Answer change callback error', e); }
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        notifyConnectionRestored();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (err) logger.error('Supabase', 'Answers subscription error', err);
        logger.warn('Supabase', 'Answers subscription failed, status: ' + status);
        notifyConnectionLost();
      }
    });
}
