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
