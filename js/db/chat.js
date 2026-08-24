import { supabase } from './client.js';
import { logger } from '../logger.js';
import { CHAT_MESSAGES_LIMIT } from '../constants.js';
import { fetchRoom } from './rooms.js';
import { fetchPlayers } from './players.js';
import { notifyConnectionLost, notifyConnectionRestored } from '../utils.js';

/**
 * Send a chat message.
 */
export async function sendMessage(roomId, playerName, message) {
  const { data, error } = await supabase
    .from('chat_messages')
    .insert({ room_id: roomId, player_name: playerName, message })
    .select('id')
    .maybeSingle();

  if (error) logger.error('Supabase', 'sendMessage failed', error);
  return { data, error };
}

/**
 * Toggle a heart on a chat message. Adds or removes the player name from the hearts JSONB array.
 */
export async function toggleMessageHeart(messageId, playerName) {
  // Read current hearts
  const { data: msg, error: fetchErr } = await supabase
    .from('chat_messages')
    .select('hearts')
    .eq('id', messageId)
    .single();

  if (fetchErr) { logger.error('Supabase', 'toggleMessageHeart fetch failed', fetchErr); return null; }

  const hearts = Array.isArray(msg?.hearts) ? msg.hearts : [];
  const idx = hearts.indexOf(playerName);
  if (idx >= 0) {
    hearts.splice(idx, 1);
  } else {
    hearts.push(playerName);
  }

  const { error: updateErr } = await supabase
    .from('chat_messages')
    .update({ hearts })
    .eq('id', messageId);

  if (updateErr) logger.error('Supabase', 'toggleMessageHeart update failed', updateErr);
  return hearts;
}

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

    if (error) logger.error('Supabase', 'archiveChatMessages failed', error);
  } catch (err) {
    logger.error('Supabase', 'archiveChatMessages error', err);
  }
}

/**
 * Fetch chat messages for a room.
 *
 * `since` is an ISO timestamp: nothing sent before it is returned. That is how
 * somebody walking into a room stops arriving to the whole transcript of what
 * was said before they got there — see rememberChatCutoff in auth.js for what
 * this does and does not protect.
 *
 * Omitting it reads everything, which is what archiveChatMessages needs: the
 * archive is the room's record, not one player's view of it.
 */
export async function fetchMessages(roomId, since = null) {
  let query = supabase
    .from('chat_messages')
    .select('*')
    .eq('room_id', roomId);

  if (since) query = query.gte('created_at', since);

  const { data, error } = await query
    .order('created_at', { ascending: true })
    .limit(CHAT_MESSAGES_LIMIT);

  if (error) {
    logger.error('Supabase', 'fetchMessages failed', error);
    return [];
  }
  return data;
}

/**
 * Subscribe to new chat messages in a room.
 */
export function subscribeToMessages(roomId, callback) {
  return supabase.channel(`room-${roomId}-messages`)
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'chat_messages',
      filter: `room_id=eq.${roomId}`
    }, (payload) => {
      try { callback(payload); } catch (e) { logger.error('Supabase', 'Message callback error', e); }
    })
    .subscribe((status, err) => {
      if (status === 'SUBSCRIBED') {
        notifyConnectionRestored();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (err) logger.error('Supabase', 'Messages subscription error', err);
        logger.warn('Supabase', 'Messages subscription failed, status: ' + status);
        notifyConnectionLost();
      }
    });
}
