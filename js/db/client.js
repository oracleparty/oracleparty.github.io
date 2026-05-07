// ============================================
// Oracle Party — Supabase Client (shared)
// All domain modules import from here.
// ============================================

// Pinned to a specific Supabase JS version. Two reasons:
//  1) Immutable URL means the SW can cache aggressively (cache-first) so a
//     flaky esm.sh on subsequent loads doesn't break the app.
//  2) Guards against breaking changes in a future minor that we haven't
//     vetted. Bump deliberately when we want a newer SDK.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

export const SUPABASE_URL = 'https://zzpqymehapwbjupphxec.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_UJtIRllW5SWhMbqynb-3QQ_HWIV2OSd';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
