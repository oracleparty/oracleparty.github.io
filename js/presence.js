// ============================================
// Oracle Party — Global Presence System
// Tracks online status + activity for friends
// ============================================

import { supabase, hasFriends } from './supabase.js';

let _channel = null;
let _userId = null;
let _currentActivity = { activity: 'home' };

/**
 * Initialize global presence tracking.
 * Only joins the channel if the user has at least one friend.
 *
 * @param {string} userId - The authenticated user's ID
 * @param {boolean} [showOnline=true] - If false, don't broadcast presence
 */
export async function initGlobalPresence(userId, showOnline = true) {
  if (_channel) return; // Already initialized
  if (!showOnline) return; // User opted out of online status

  // Only track presence if user has friends (performance optimization)
  const has = await hasFriends(userId);
  if (!has) return;

  _userId = userId;

  _channel = supabase.channel('global-presence', {
    config: { presence: { key: userId } }
  });

  _channel
    .subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await _channel.track({
          userId: _userId,
          ..._currentActivity,
          timestamp: Date.now()
        });
      }
    });
}

/**
 * Update the current user's presence activity.
 * @param {Object} data - { activity: 'home'|'lobby'|'game', roomId?, roomCode?, category? }
 */
export async function updatePresence(data) {
  _currentActivity = data;
  if (_channel) {
    try {
      await _channel.track({
        userId: _userId,
        ...data,
        timestamp: Date.now()
      });
    } catch {
      // Swallow errors — presence is non-critical
    }
  }
}

/**
 * Get the current presence state map.
 * Returns { [userId]: [{ userId, activity, roomId, ... }] }
 */
export function getPresenceState() {
  if (!_channel) return {};
  return _channel.presenceState();
}

/**
 * Get presence info for a specific user.
 * Returns { activity, roomId, roomCode, category, timestamp } or null.
 */
export function getPresenceForUser(userId) {
  const state = getPresenceState();
  const entries = state[userId];
  if (!entries || entries.length === 0) return null;
  // Return the most recent entry
  return entries.reduce((latest, e) => (e.timestamp > (latest.timestamp || 0)) ? e : latest, entries[0]);
}

/**
 * Tear down the presence channel.
 */
export function destroyGlobalPresence() {
  if (_channel) {
    supabase.removeChannel(_channel);
    _channel = null;
  }
  _userId = null;
}
