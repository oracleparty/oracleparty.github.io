// ============================================
// Oracle Party — is the presence channel actually alive?
//
// NO IMPORTS, so this is unit-testable in Node. Everything else in the
// presence path pulls the Supabase client from esm.sh, which the test runner
// cannot load.
//
// WHY THIS EXISTS
//
// Reported from a playtest: a player switched to another app, came back, and
// stayed greyed out — and saw everyone ELSE greyed out too. That symmetry is
// the tell. A one-way state error greys one person for the room; a room where
// both sides see each other away is a dead socket on one side.
//
// Mobile browsers suspend a WebSocket when the page is backgrounded. The app
// re-announced presence on return, every 15 seconds, and on visibilitychange —
// but every one of those calls was wrapped in `.catch(() => {})`. On a channel
// whose socket had died, all three failed silently, forever. Nothing ever
// checked whether the channel was still joined, and nothing ever rebuilt it.
//
// WHY REBUILDING, NOT RE-SUBSCRIBING
//
// supabase-js throws "tried to subscribe multiple times" if `subscribe()` is
// called on a channel that has already joined once, so healing means creating
// a NEW channel. That is why this module only answers the question and leaves
// the rebuilding to the caller, which is the only place that knows how to
// re-wire the handlers.
// ============================================

/**
 * Can this channel still deliver presence?
 *
 * → true when it needs rebuilding.
 *
 * A channel with no readable state answers FALSE, deliberately. "I cannot
 * tell" must not become "rebuild it": a rebuild every 15 seconds would churn
 * subscriptions for every player in the room, which is worse than the fault
 * it is trying to fix, and it would be invisible because presence would
 * appear to work.
 */
export function presenceNeedsRebuild(channel) {
  if (!channel) return false;
  const state = channel.state;
  if (typeof state !== 'string') return false;
  // 'joining' is healthy and in progress. Rebuilding mid-join would abandon a
  // handshake that was about to succeed and start another one.
  return state !== 'joined' && state !== 'joining';
}
