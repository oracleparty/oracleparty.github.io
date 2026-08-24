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

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);


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
