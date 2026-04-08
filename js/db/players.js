import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from './client.js';
import { logger } from '../logger.js';
import { notifyConnectionLost, notifyConnectionRestored } from '../utils.js';

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
    logger.error('Supabase', 'addPlayer failed', error);
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
  if (error) logger.error('Supabase', 'promoteToCohost failed', error);
}

/**
 * Demote a player from co-host status.
 */
export async function demoteCohost(playerId) {
  const { error } = await supabase.from('players').update({ is_cohost: false }).eq('id', playerId);
  if (error) logger.error('Supabase', 'demoteCohost failed', error);
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

  if (error) logger.error('Supabase', 'toggleReady failed', error);
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

export async function insertGamePlay({ roomId, playerId, playerName, category, subcategory, totalQuestions }) {
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
  const { error } = await supabase
    .from('game_plays')
    .upsert(row, { onConflict: 'room_id,player_id' });

  if (error) logger.error('Supabase', 'insertGamePlay failed', error);
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
      score_earned: scoreEarned
    }, { onConflict: 'room_id,player_id,question_number' })
    .select()
    .single();

  if (error) {
    logger.error('Supabase', 'submitAnswer failed', error);
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
