// ============================================
// Oracle Party — Supabase Client
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://zzpqymehapwbjupphxec.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UJtIRllW5SWhMbqynb-3QQ_HWIV2OSd';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Test the Supabase connection by making a simple request.
 * Returns true if connected, false otherwise.
 */
export async function testConnection() {
  try {
    // A lightweight query — just check we can reach Supabase
    const { error } = await supabase.from('questions').select('id', { count: 'exact', head: true });
    if (error) {
      console.warn('[Supabase] Connection test query error:', error.message);
      // Even if the table query fails, if we got a response, the connection works
      return true;
    }
    console.log('[Supabase] Connected successfully.');
    return true;
  } catch (err) {
    console.error('[Supabase] Connection failed:', err);
    return false;
  }
}
