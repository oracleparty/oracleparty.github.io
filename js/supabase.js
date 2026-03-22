// ============================================
// Oracle Party — Supabase Client
// ============================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://zzpqymehapwbjupphxec.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UJtIRllW5SWhMbqynb-3QQ_HWIV2OSd';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/**
 * Fetch distinct categories from the questions table with counts.
 * Questions have a `categories` text[] array column.
 * Returns [{ name: 'history', count: 142 }, ...] sorted alphabetically.
 */
export async function fetchCategories() {
  const { data, error } = await supabase
    .from('questions')
    .select('categories')
    .limit(2000);

  if (error) {
    console.error('[Supabase] Failed to fetch categories:', error.message);
    return [];
  }

  const counts = {};
  for (const row of data) {
    if (Array.isArray(row.categories)) {
      for (const cat of row.categories) {
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }
  }

  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Generate a random 6-digit numeric room code.
 */
export function generateRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/**
 * Create a new room in Supabase.
 * Retries once on code collision.
 */
export async function createRoom({ hostName, category, whoCanJoin, questionsPerGame, questionTimer }) {
  const code = generateRoomCode();

  const { data, error } = await supabase
    .from('rooms')
    .insert({
      code,
      host_name: hostName,
      category,
      who_can_join: whoCanJoin,
      questions_per_game: questionsPerGame,
      question_timer: questionTimer,
      status: 'lobby'
    })
    .select()
    .single();

  if (error) {
    // Retry once on unique constraint violation (code collision)
    if (error.code === '23505') {
      const retryCode = generateRoomCode();
      const { data: d2, error: e2 } = await supabase
        .from('rooms')
        .insert({
          code: retryCode,
          host_name: hostName,
          category,
          who_can_join: whoCanJoin,
          questions_per_game: questionsPerGame,
          question_timer: questionTimer,
          status: 'lobby'
        })
        .select()
        .single();
      if (e2) {
        console.error('[Supabase] Room creation failed on retry:', e2.message);
        return { data: null, error: e2 };
      }
      return { data: d2, error: null };
    }
    console.error('[Supabase] Room creation failed:', error.message);
    return { data: null, error };
  }

  return { data, error: null };
}

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
