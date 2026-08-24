import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY, noteServerFunctions } from './client.js';
import { logger, reportWriteFailure } from '../logger.js';
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

  if (reportWriteFailure('Join room', error, "Couldn't join the room — check your connection and try again")) {
    return { data: null, error };
  }
  return { data, error: null };
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
export async function promoteToHost(roomId, playerId, displayName) {
  const [playerResult, roomResult] = await Promise.all([
    supabase.from('players').update({ is_host: true }).eq('id', playerId),
    supabase.from('rooms').update({ host_name: displayName }).eq('id', roomId)
  ]);
  if (playerResult.error) logger.error('Supabase', 'promoteToHost player update failed', playerResult.error);
  if (roomResult.error) logger.error('Supabase', 'promoteToHost room update failed', roomResult.error);
}

/**
 * Demote a player from host status.
 */
export async function demoteHost(playerId) {
  const { error } = await supabase.from('players').update({ is_host: false }).eq('id', playerId);
  if (error) logger.error('Supabase', 'demoteHost failed', error);
}

/**
 * Promote a player to co-host.
 */
export async function promoteToCohost(playerId) {
  const { error } = await supabase.from('players').update({ is_cohost: true }).eq('id', playerId);
  reportWriteFailure('Promote co-host', error, "Couldn't make them co-host");
}

/**
 * Demote a player from co-host status.
 */
export async function demoteCohost(playerId) {
  const { error } = await supabase.from('players').update({ is_cohost: false }).eq('id', playerId);
  reportWriteFailure('Demote co-host', error, "Couldn't remove co-host");
}

/**
 * Remove a player from a room.
 */
export async function removePlayer(playerId) {
  const { error } = await supabase
    .from('players')
    .delete()
    .eq('id', playerId);

  if (error) logger.error('Supabase', 'removePlayer failed', error);
  return { error };
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
export async function toggleReady(playerId, isReady) {
  const { error } = await supabase
    .from('players')
    .update({ is_ready: isReady })
    .eq('id', playerId);

  reportWriteFailure('Ready toggle', error, "Couldn't update your ready status");
  return { error };
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
      // The machine's verdict, kept separate because is_correct is overwritten
      // in place when a host flips a judgement. Comparing the two is how a bad
      // answer key gets detected later.
      auto_correct: isCorrect,
      score_earned: scoreEarned
    }, { onConflict: 'room_id,player_id,question_number' })
    .select()
    .single();

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
export async function deleteAnswersByRoom(roomId) {
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
  const { error } = await supabase
    .from('answers')
    .update({ player_id: newPlayerId })
    .eq('room_id', roomId)
    .eq('player_id', oldPlayerId);

  if (error) logger.error('Supabase', 'reassignPlayerAnswers failed', error);
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
