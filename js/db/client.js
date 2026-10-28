// ============================================
// Oracle Party — Supabase Client (shared)
// All domain modules import from here.
// ============================================

// Pinned major version. Stays on supabase-js 2.x (locks out v3 breaking
// changes) but allows minor + patch updates so we get bug fixes and stay
// compatible with the new sb_publishable_* / sb_secret_* key format that
// landed in recent 2.x releases. The SW caches the resolved URL aggressively
// so a flaky esm.sh after first load can't break the app.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://zzpqymehapwbjupphxec.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_UJtIRllW5SWhMbqynb-3QQ_HWIV2OSd';

// ============================================
// HOW LONG DID THAT REQUEST TAKE — measured on the real phone.
//
// Owner, 2026-10-28: "Answers are taking over 5 seconds to send sometimes."
// Nothing in this repo can see a phone's connection — the robots' database is
// in memory — so every request is timed here, and one slower than
// SLOW_REQUEST_MS is written to error_logs (the admin page's Error Logs) with
// what it was. lastRequestMs() lets a caller compare its own end-to-end time
// with the network's: the difference is time spent waiting INSIDE the phone
// before the request left (supabase-js holds every request behind its auth
// session check), which is a different fault from a slow road.
// ============================================
const SLOW_REQUEST_MS = 2000;
const _lastMs = new Map();   // short request name -> ms of its last fetch

function _requestName(url) {
  try {
    const u = new URL(url);
    return u.pathname.replace(/^\/(rest|auth|functions)\/v1\//, '$1:').slice(0, 60);
  } catch { return String(url).slice(0, 60); }
}

export function lastRequestMs(name) { return _lastMs.get(name) ?? null; }

async function timedFetch(input, init) {
  const url = typeof input === 'string' ? input : input?.url || '';
  const name = _requestName(url);
  const t0 = performance.now();
  try {
    return await fetch(input, init);
  } finally {
    const ms = Math.round(performance.now() - t0);
    _lastMs.set(name, ms);
    // Never time the error log's own write: a slow one would log itself.
    if (ms >= SLOW_REQUEST_MS && !name.includes('error_logs')) {
      import('../logger.js').then(({ recordFault }) => recordFault('SlowRequest',
        `${name} took ${ms}ms on the network`,
        `online=${navigator.onLine} visible=${document.visibilityState}`)).catch(() => {});
    }
  }
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  global: { fetch: timedFetch },
});


// ============================================
// Are the server-side game functions installed?
//
// The page-unload path cannot await anything, so it has to already know which
// way to leave. This records what the ordinary awaited calls have learned.
//
// UNKNOWN COUNTS AS PRESENT. Getting it wrong in that direction leaves a player
// row behind for the stale sweep to tidy; getting it wrong in the other
// direction means a phone deletes a room by its own local count, which is the
// race migration 048 exists to end. One is untidy, the other loses a game.
// ============================================

let _serverFns = null;   // null = nobody has found out yet

export function noteServerFunctions(present) { _serverFns = present; }
export function serverFunctionsMissing() { return _serverFns === false; }
