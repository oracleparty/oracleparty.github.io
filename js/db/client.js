// ============================================
// Oracle Party — Supabase Client (shared)
// All domain modules import from here.
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const SUPABASE_URL = 'https://zzpqymehapwbjupphxec.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_UJtIRllW5SWhMbqynb-3QQ_HWIV2OSd';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
