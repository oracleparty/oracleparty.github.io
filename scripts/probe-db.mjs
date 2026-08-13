// ============================================
// Live database probe — READ-ONLY, changes nothing.
//
// Runs on GitHub Actions, which (unlike a sandboxed dev session) can reach
// Supabase. Uses the publishable key already embedded in js/db/client.js, so
// it needs no secret: it sees exactly what any visitor's phone can see.
//
// Permission checks are shaped to match ZERO rows — an impossible id — so the
// database reports whether the door is open without anything being written,
// changed or removed. A 2xx with an empty result means "allowed, nothing
// matched"; 401/403 means RLS refused.
// ============================================

const URL_BASE = 'https://zzpqymehapwbjupphxec.supabase.co';
const KEY = 'sb_publishable_UJtIRllW5SWhMbqynb-3QQ_HWIV2OSd';
const IMPOSSIBLE_ID = '00000000-0000-4000-8000-000000000000';

const TABLES = [
  'rooms', 'players', 'answers', 'chat_messages', 'chat_archive', 'questions',
  'question_feedback', 'question_history', 'game_plays', 'game_history',
  'profiles', 'player_stats', 'friend_requests', 'friendships', 'title_unlocks',
  'site_settings', 'error_logs',
];

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function req(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.text(); } catch { /* ignore */ }
  return { status: res.status, body, headers: res.headers };
}

function verdict(status) {
  if (status === 401 || status === 403) return 'BLOCKED (good)';
  if (status >= 200 && status < 300)    return '*** ALLOWED ***';
  if (status === 404)                   return 'table not found';
  return `unclear (HTTP ${status})`;
}

console.log('='.repeat(70));
console.log('ORACLE PARTY — LIVE DATABASE PROBE (read-only)');
console.log('Using the publishable key from js/db/client.js — visitor-level access.');
console.log('='.repeat(70));

console.log('\n--- TABLE EXISTS / READABLE / ROW COUNT ---');
const present = [];
for (const t of TABLES) {
  const r = await req(`${t}?select=*&limit=1`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  const range = r.headers.get('content-range');
  const count = range ? range.split('/')[1] : '?';
  // 206 Partial Content is success for a Range request, not a refusal.
  if (r.status === 200 || r.status === 206) {
    present.push(t);
    console.log(`  ${t.padEnd(20)} readable    rows=${count}`);
  } else if (r.status === 404) {
    console.log(`  ${t.padEnd(20)} DOES NOT EXIST`);
  } else {
    console.log(`  ${t.padEnd(20)} read blocked (HTTP ${r.status})`);
  }
}

console.log('\n--- COLUMNS (from one sample row; blank if table empty) ---');
for (const t of present) {
  const r = await req(`${t}?select=*&limit=1`);
  try {
    const rows = JSON.parse(r.body || '[]');
    console.log(`  ${t}: ${rows.length ? Object.keys(rows[0]).join(', ') : '(no rows to sample)'}`);
  } catch {
    console.log(`  ${t}: (unparseable)`);
  }
}

console.log('\n--- WRITE PERMISSIONS (zero-row probes — nothing is modified) ---');
console.log('    "ALLOWED" means any visitor could do this to real rows.\n');
for (const t of present) {
  const upd = await req(`${t}?id=eq.${IMPOSSIBLE_ID}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ id: IMPOSSIBLE_ID }),
  });
  const del = await req(`${t}?id=eq.${IMPOSSIBLE_ID}`, {
    method: 'DELETE',
    headers: { Prefer: 'return=minimal' },
  });
  console.log(`  ${t.padEnd(20)} UPDATE: ${verdict(upd.status).padEnd(16)} DELETE: ${verdict(del.status)}`);
}

console.log('\n--- QUESTION BANK SHAPE ---');
const q = await req('questions?select=*&limit=1');
try {
  const rows = JSON.parse(q.body || '[]');
  if (rows[0]) {
    for (const [k, v] of Object.entries(rows[0])) {
      const preview = Array.isArray(v) ? `[${v.join(', ')}]` : String(v ?? 'null');
      console.log(`  ${k.padEnd(22)} ${preview.slice(0, 70)}`);
    }
  }
} catch { /* ignore */ }

const fmt = await req('questions?select=format&limit=1000');
try {
  const rows = JSON.parse(fmt.body || '[]');
  const counts = {};
  for (const r of rows) counts[r.format] = (counts[r.format] || 0) + 1;
  console.log(`\n  format values in first 1000: ${JSON.stringify(counts)}`);
} catch { /* ignore */ }

console.log('\n--- FEEDBACK TABLE (the broken loop) ---');
const fb = await req('question_feedback?select=feedback_type,flag_reason&limit=1000');
if (fb.status === 200) {
  try {
    const rows = JSON.parse(fb.body || '[]');
    const byType = {};
    for (const r of rows) byType[r.feedback_type] = (byType[r.feedback_type] || 0) + 1;
    console.log(`  total feedback rows sampled: ${rows.length}`);
    console.log(`  by type: ${JSON.stringify(byType)}`);
  } catch { /* ignore */ }
} else {
  console.log(`  question_feedback not readable (HTTP ${fb.status}) — migration 020 may never have been run`);
}

console.log('\n--- RPC FUNCTIONS ---');
for (const fn of ['get_category_play_counts', 'increment_questions_answered']) {
  const r = await req(`rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  console.log(`  ${fn.padEnd(34)} HTTP ${r.status} ${r.status === 404 ? '(NOT INSTALLED)' : ''}`);
}

console.log('\n' + '='.repeat(70));
console.log('Probe complete. Nothing was created, modified or deleted.');
console.log('='.repeat(70));

// ============================================
// COLUMN EXISTENCE
//
// The tables above are mostly empty, so sampling a row reveals nothing about
// their shape. PostgREST names a missing column in its error, which makes a
// targeted select a definitive existence test.
//
// This matters because the app writes columns that may never have been
// created: an absent last_seen_at makes checkStalePresence() read every
// player as silent since epoch, and the host then kicks everyone roughly 30
// seconds after they join.
// ============================================

const REQUIRED = {
  players: ['id', 'room_id', 'display_name', 'is_host', 'is_cohost', 'score',
            'last_seen_at', 'disconnected_at', 'joined_at', 'user_id',
            'avatar_color', 'avatar_emoji', 'title', 'is_ready'],
  rooms:   ['id', 'code', 'host_name', 'category', 'subcategory', 'status',
            'game_phase', 'current_question', 'question_ids', 'question_started_at',
            'countdown_started_at', 'questions_per_game', 'question_timer',
            'auto_proceed', 'who_can_join', 'used_question_ids'],
  answers: ['id', 'room_id', 'player_id', 'question_number', 'question_id',
            'wager', 'submitted_answer', 'is_correct', 'auto_correct', 'score_earned'],
  game_plays: ['id', 'room_id', 'player_id', 'category', 'subcategory',
               'total_questions', 'questions_answered', 'final_score', 'completed'],
  question_feedback: ['id', 'question_id', 'voter_id', 'room_id', 'player_name',
                      'feedback_type', 'flag_reason'],
  questions: ['id', 'question', 'correct_answer', 'acceptable_answers',
              'categories', 'subcategory', 'difficulty', 'format', 'fun_fact'],
};

console.log('\n--- COLUMNS THE APP DEPENDS ON ---');
for (const [tbl, cols] of Object.entries(REQUIRED)) {
  const missing = [];
  for (const col of cols) {
    const r = await req(`${tbl}?select=${col}&limit=1`);
    if (r.status === 400 && /does not exist|could not find/i.test(r.body || '')) missing.push(col);
  }
  console.log(missing.length
    ? `  ${tbl.padEnd(20)} *** MISSING: ${missing.join(', ')} ***`
    : `  ${tbl.padEnd(20)} all present`);
}
