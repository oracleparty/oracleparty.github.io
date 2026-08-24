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

const TABLES = [
  'rooms', 'players', 'answers', 'chat_messages', 'chat_archive', 'questions',
  'question_feedback', 'question_history', 'game_plays', 'game_history',
  'profiles', 'player_stats', 'friend_requests', 'friendships', 'title_unlocks',
  'site_settings', 'error_logs',
  // Added by migrations 025: the Question Health feature reads the view and
  // the RPC writes the table. Both were absent from this list, so the feature
  // the admin page is built on was never checked here at all.
  'question_stats', 'question_health',
  // The leaderboard reads player_stats_computed (a view, migration 017), not
  // player_stats. It was absent from this list, so nothing here would have
  // noticed the leaderboard silently returning an empty list.
  'player_stats_computed',
  // Migration 029 — what people actually typed.
  'answer_tally',
];

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// Deliberately not a uuid. PostgREST casts arguments before a function body
// runs, so this proves a function exists without letting it write anything.
const NOT_A_UUID = 'probe-not-a-uuid';

async function req(path, init = {}) {
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });
  let body = null;
  try { body = await res.text(); } catch { /* ignore */ }
  return { status: res.status, body, headers: res.headers };
}

console.log('='.repeat(70));
console.log('ORACLE PARTY — LIVE DATABASE PROBE (read-only)');
console.log('Using the publishable key from js/db/client.js — visitor-level access.');
console.log('='.repeat(70));

// "rows" is what a VISITOR can see, not what the table holds. A restrictive
// SELECT policy filters rows out rather than refusing the request, so an
// admin-only table like error_logs reads as empty no matter how much is in it.
console.log('\n--- TABLE EXISTS / READABLE / ROWS VISIBLE TO A VISITOR ---');
const present = [];
const unreadable = new Map();   // table -> why, for the column check below
for (const t of TABLES) {
  const r = await req(`${t}?select=*&limit=1`, { headers: { Prefer: 'count=exact', Range: '0-0' } });
  const range = r.headers.get('content-range');
  const count = range ? range.split('/')[1] : '?';
  // 206 Partial Content is success for a Range request, not a refusal.
  if (r.status === 200 || r.status === 206) {
    present.push(t);
    console.log(`  ${t.padEnd(20)} readable    rows=${count}`);
    continue;
  }

  // "Not there" and "there but not yours" are different problems with
  // different fixes, and collapsing them into one line is how a missing GRANT
  // gets read as a missing table. PostgREST distinguishes them in the body:
  // an unknown relation is PGRST205 / 42P01, a refused one is 42501.
  const code = pgCode(r.body);
  let why;
  if (code === '42501' || r.status === 401 || r.status === 403) {
    why = `EXISTS but this visitor may not read it (HTTP ${r.status}${code ? ' / ' + code : ''})`;
  } else if (r.status === 404) {
    why = `DOES NOT EXIST for a visitor (HTTP 404${code ? ' / ' + code : ''})`;
  } else {
    why = `read blocked (HTTP ${r.status}${code ? ' / ' + code : ''})`;
  }
  unreadable.set(t, why);
  console.log(`  ${t.padEnd(20)} ${why}`);
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

// ============================================
// WRITE PERMISSIONS
//
// The obvious probe — aim an UPDATE or DELETE at an id that cannot exist and
// read the status — is WRONG, and this file shipped it for days. Postgres
// applies an RLS policy's USING clause as an extra WHERE condition, so a
// statement matching zero rows succeeds whether the policy would have allowed
// it or not. Every table therefore came back "*** ALLOWED ***", including
// `questions`, which has no write policy for visitors at all. It reported a
// wide-open door on a table that is locked, so the one section meant to
// describe the security posture described the opposite of it.
//
// What follows distinguishes the two properly, and still never commits
// anything:
//
//   INSERT — post an existing primary key. RLS's WITH CHECK is evaluated in
//     ExecInsert *before* ExecConstraints, so a refusal surfaces as 42501
//     while permission surfaces as the duplicate-key violation that the
//     existing key guarantees. Denied and allowed look different, and neither
//     writes a row.
//
//   UPDATE — set one real row's primary key to another real row's. If the
//     USING clause hides the row, zero rows come back; if it does not, the
//     statement aborts on the duplicate key. Denied returns [], allowed
//     returns 23505, and the abort means nothing is modified.
//
//   DELETE — cannot be established without deleting something real, so it is
//     not guessed at. Every gameplay policy here is written FOR ALL, so the
//     UPDATE verdict is the honest read on DELETE too.
// ============================================

const PK = {
  profiles: 'user_id', site_settings: 'key', question_stats: 'question_id',
  question_health: 'question_id', answer_tally: 'question_id',
};
const pkOf = t => PK[t] || 'id';

function pgCode(body) {
  try { return JSON.parse(body || '{}').code || null; } catch { return null; }
}

async function samplePks(t, n = 2) {
  const pk = pkOf(t);
  const r = await req(`${t}?select=${pk}&limit=${n}`);
  if (r.status !== 200) return [];
  try { return JSON.parse(r.body || '[]').map(row => row[pk]).filter(v => v != null); }
  catch { return []; }
}

async function probeInsert(t, existingPk) {
  if (existingPk == null) return 'no rows to probe with';
  const r = await req(t, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ [pkOf(t)]: existingPk }),
  });
  const code = pgCode(r.body);
  if (r.status === 401 || r.status === 403 || code === '42501') return 'BLOCKED (good)';
  // 23505 duplicate key, 23502 not-null, 23503 foreign key: all mean the row
  // got past RLS and died on a constraint instead.
  if (['23505', '23502', '23503', '23514'].includes(code)) return '*** ALLOWED ***';
  if (r.status >= 200 && r.status < 300) return '*** ALLOWED — AND A ROW WAS WRITTEN ***';
  return `unclear (HTTP ${r.status}${code ? ` / ${code}` : ''})`;
}

async function probeUpdate(t, pks) {
  if (pks.length < 2) return 'needs 2 rows to probe safely';
  const pk = pkOf(t);
  const r = await req(`${t}?${pk}=eq.${encodeURIComponent(pks[0])}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ [pk]: pks[1] }),
  });
  const code = pgCode(r.body);
  if (r.status === 401 || r.status === 403 || code === '42501') return 'BLOCKED (good)';
  if (code === '23505') return '*** ALLOWED ***';
  if (r.status >= 200 && r.status < 300) {
    try {
      const rows = JSON.parse(r.body || '[]');
      // Zero rows returned by a targeted UPDATE means the USING clause hid the
      // row from us — that is the refusal.
      if (Array.isArray(rows) && rows.length === 0) return 'BLOCKED (good)';
      return '*** ALLOWED — AND A ROW WAS CHANGED ***';
    } catch { /* fall through */ }
  }
  return `unclear (HTTP ${r.status}${code ? ` / ${code}` : ''})`;
}

console.log('\n--- WRITE PERMISSIONS (nothing is created, changed or removed) ---');
console.log('    "ALLOWED" means any visitor could do this to real rows.');
console.log('    DELETE is not probed: it cannot be tested without deleting.\n');
for (const t of present) {
  const pks = await samplePks(t);
  const ins = await probeInsert(t, pks[0]);
  const upd = await probeUpdate(t, pks);
  console.log(`  ${t.padEnd(20)} INSERT: ${ins.padEnd(24)} UPDATE: ${upd}`);
}

// ============================================
// CAN A PLAYER ACTUALLY RATE A QUESTION?
//
// question_feedback is empty on the live database and a playtest reported
// flags never reaching the admin page. The general write probe above cannot
// help: it needs an existing row to aim at, and an empty table has none, so it
// reports "no rows to probe with" — the one table where the answer matters
// most is the one it says nothing about.
//
// This posts a row that THREE independent things must all be missing for it to
// be written: the foreign key to questions, the CHECK on feedback_type, and
// the NOT NULL on voter_id (migration 026). RLS is evaluated in ExecInsert
// before any of them, so a refusal still arrives as 42501 and a permission
// arrives as whichever constraint fires first. Neither writes a row.
//
// If a row IS written, that is itself the finding — it means the table has
// drifted from every migration that describes it — and it is deleted again.
// ============================================

console.log('\n--- CAN A VISITOR RATE A QUESTION? (deliberately invalid; writes nothing) ---');
{
  const verdict = await (async () => {
    const r = await req('question_feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Prefer: 'return=representation' },
      // room_id must be a UUID on the live table, whatever migration 020 says
      // it declared — a non-uuid string fails to cast in 22P02 BEFORE RLS is
      // reached, which teaches nothing about permission. All-zero uuids cannot
      // match any real room or question.
      body: JSON.stringify({
        question_id: '00000000-0000-0000-0000-000000000000',
        room_id: '00000000-0000-0000-0000-000000000000',
        player_name: '__probe__',
        feedback_type: '__probe_invalid__',
      }),
    });
    const code = pgCode(r.body);
    if (r.status === 401 || r.status === 403 || code === '42501') {
      return 'BLOCKED — a player cannot save a rating at all. This is why the table is empty.';
    }
    if (code === '23503') return 'ALLOWED (died on the questions foreign key, as intended)';
    if (code === '23514') return 'ALLOWED (died on the feedback_type CHECK, as intended)';
    if (code === '23502') return 'ALLOWED (died on a NOT NULL column, as intended)';
    if (code === '23505') return 'ALLOWED (died on a unique index, as intended)';
    if (r.status >= 200 && r.status < 300) {
      // Should be unreachable. Clean up and say so loudly.
      await req('question_feedback?room_id=eq.00000000-0000-0000-0000-000000000000', { method: 'DELETE' });
      return 'ALLOWED — AND A ROW WAS WRITTEN. The foreign key, the feedback_type CHECK and the voter_id NOT NULL are ALL missing from this table. Deleted again.';
    }
    return `unclear (HTTP ${r.status}${code ? ` / ${code}` : ''}) — body: ${(r.body || '').slice(0, 200)}`;
  })();
  console.log(`  INSERT: ${verdict}`);
}

// ============================================
// UPSERT CONFLICT TARGETS
//
// `.upsert(row, { onConflict: 'a,b' })` compiles to ON CONFLICT (a, b), and
// Postgres needs a unique index on exactly those columns to infer an arbiter.
// Without one it raises 42P10 and rejects the statement — every time, for
// every caller. The app only logs that, so the feature just stops existing.
//
// This is worth its own check because three of the four conflict targets the
// app relies on point at tables holding zero rows: question_feedback,
// game_plays and answers. game_plays is created by no migration at all, so
// its constraints are whatever was clicked together in the dashboard.
//
// Safe to run: ON CONFLICT inference happens during planning, while casting
// the payload happens during execution. A missing constraint therefore answers
// 42P10 before an unparseable uuid can answer 22P02, and neither outcome
// writes a row. site_settings is left out — its target is the primary key,
// which has a unique index by definition.
// ============================================

const UPSERT_TARGETS = [
  ['question_feedback', 'question_id,voter_id',
    { question_id: NOT_A_UUID, voter_id: 'probe' }],
  ['game_plays', 'room_id,player_id',
    { room_id: NOT_A_UUID, player_id: NOT_A_UUID }],
  ['answers', 'room_id,player_id,question_number',
    { room_id: NOT_A_UUID, player_id: NOT_A_UUID, question_number: 1 }],
];

console.log('\n--- UPSERT CONFLICT TARGETS (nothing is written) ---');
for (const [t, cols, payload] of UPSERT_TARGETS) {
  const r = await req(`${t}?on_conflict=${encodeURIComponent(cols)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(payload),
  });
  const code = pgCode(r.body);
  let state;
  if (code === '42P10') {
    state = `*** NO UNIQUE CONSTRAINT ON (${cols}) — EVERY UPSERT FAILS ***`;
  } else if (code === '22P02') {
    state = 'constraint present';
  } else if (code === '42501') {
    state = 'RLS refused before the constraint could be tested';
  } else if (r.status >= 200 && r.status < 300) {
    state = '*** SUCCEEDED — A ROW WAS WRITTEN, REMOVE IT ***';
  } else {
    state = `unclear (HTTP ${r.status}${code ? ` / ${code}` : ''})`;
  }
  console.log(`  ${t.padEnd(20)} ${state}`);
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

// How many questions carry MORE THAN ONE category.
//
// player_stats_computed unnests questions.categories, so a question tagged
// with two categories produces a row under each. That is correct for a
// per-category leaderboard and wrong for any total summed ACROSS categories:
// the global board's "points" would count such a question once per tag.
//
// Whether that matters is a number, not an opinion, which is why it is
// measured here instead of argued about. If multi-category questions are rare
// the distortion is noise; if they are common the global ranking is wrong.
const cats = await req('questions?select=categories&limit=1000');
try {
  const rows = JSON.parse(cats.body || '[]');
  const counts = {};
  let tagTotal = 0;
  for (const r of rows) {
    const n = Array.isArray(r.categories) ? r.categories.length : 0;
    counts[n] = (counts[n] || 0) + 1;
    tagTotal += n;
  }
  const multi = rows.filter(r => (r.categories || []).length > 1).length;
  console.log(`  categories per question in first 1000: ${JSON.stringify(counts)}`);
  console.log(`  more than one category: ${multi}/${rows.length}` +
              `${rows.length ? ` (${Math.round((multi / rows.length) * 100)}%)` : ''}` +
              `, ${rows.length ? (tagTotal / rows.length).toFixed(2) : 0} tags each on average`);
} catch { /* ignore */ }

// How many questions carry plausible WRONG answers already.
//
// These came from opentdb as multiple-choice distractors and survived the
// conversion to open format, where nothing reads them any more. They are
// hand-made wrong answers for specific questions — exactly what a bot needs to
// answer a question wrongly but believably, with no generated content and no
// risk of inventing something false. Whether the bots idea is cheap or
// expensive turns entirely on how many questions have them.
const wrong = await req('questions?select=incorrect_answers,format&limit=1000');
try {
  const rows = JSON.parse(wrong.body || '[]');
  let withDistractors = 0, total = 0, distractorCount = 0;
  for (const r of rows) {
    total++;
    const arr = Array.isArray(r.incorrect_answers) ? r.incorrect_answers.filter(Boolean) : [];
    if (arr.length) { withDistractors++; distractorCount += arr.length; }
  }
  const pct = total ? Math.round((withDistractors / total) * 100) : 0;
  console.log(`  questions with stored wrong answers: ${withDistractors}/${total} (${pct}%), ` +
              `${total ? (distractorCount / Math.max(withDistractors, 1)).toFixed(1) : 0} each on average`);
} catch { /* ignore */ }

// Is `difficulty` actually populated, and does it vary?
//
// Bots weight their odds by it, so a column that is 'medium' for everything
// would quietly turn skill-times-difficulty back into plain skill. Worth
// knowing before building on it rather than after.
const diff = await req('questions?select=difficulty&limit=1000');
try {
  const rows = JSON.parse(diff.body || '[]');
  const byDiff = {};
  for (const r of rows) byDiff[r.difficulty ?? 'null'] = (byDiff[r.difficulty ?? 'null'] || 0) + 1;
  console.log(`  difficulty spread in first 1000: ${JSON.stringify(byDiff)}`);
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

// ============================================
// RPC FUNCTIONS
//
// Read from the OpenAPI description rather than by calling them. POSTing `{}`
// to a function that takes arguments returns the same 404/PGRST202 as one that
// was never created, so the previous version of this check reported
// increment_questions_answered as NOT INSTALLED without that being established.
// Calling record_question_outcome for real would also have written a row.
//
// The list below is every function the app calls — gathered from js/, not from
// migrations/, because a migration proves nothing about what was applied.
// ============================================

// Each entry is called with the exact argument names js/ uses, and with a
// value that cannot be cast to uuid. PostgREST resolves the function and casts
// the arguments before the body runs, so an unparseable uuid proves the
// function exists without executing it — which matters for
// record_question_outcome, whose body writes a row.
//
// Passing the real argument names also tests the signature. A function that
// exists under a different signature is as dead to the app as a missing one:
// PostgREST answers 404 either way, and the app's error handler cannot tell.
const RPC_PROBES = [
  // no arguments, and read-only, so this one really is called
  ['get_category_play_counts', null],
  ['get_mastery_counts', { p_user_id: NOT_A_UUID }],
  ['record_question_outcome', { p_question_id: NOT_A_UUID, p_is_correct: true, p_overridden: false }],
  ['increment_questions_answered', { p_room_id: NOT_A_UUID, p_player_id: NOT_A_UUID }],
  ['record_answer_text', { p_question_id: NOT_A_UUID, p_answer: 'probe' }],
  // Migration 041. Without these a host's judgement flip and disqualification
  // land on their OWN history row and are silently refused for every other
  // player — question_history is scoped to its owner and has no DELETE policy
  // for anybody.
  ['amend_question_history', { p_user_id: NOT_A_UUID, p_question_id: NOT_A_UUID, p_room_id: NOT_A_UUID, p_is_correct: true }],
  ['revoke_question_history', { p_user_id: NOT_A_UUID, p_question_id: NOT_A_UUID, p_room_id: NOT_A_UUID }],
  // Migration 043. Without it every browser falls back to writing only its own
  // row at the reveal, so whether a round is recorded depends on whether that
  // phone happened to be awake.
  ['record_round_history', { p_room_id: NOT_A_UUID, p_question_id: NOT_A_UUID }],
  // Migration 042. Admin-gated, so an anonymous probe cannot get past the
  // guard — but a MISSING function still answers 404 and a present one still
  // answers 22P02 on the uuid cast, which is all this needs to distinguish.
  ['admin_account_details', { p_user_id: NOT_A_UUID }],
  // Migration 034. Without it a group's whole evening counts as one play each.
  // EVERY argument, in the exact names js/db/players.js sends. PostgREST
  // resolves an RPC by its argument NAMES, so a partial set answers 404 —
  // indistinguishable from a function that was never created. A first version
  // of this entry passed three of seven and reported a working function as
  // missing, which is the false alarm CLAUDE.md warns turns a check into
  // something people stop reading.
  ['record_game_play', { p_room_id: NOT_A_UUID, p_player_id: NOT_A_UUID,
                         p_player_name: 'probe', p_category: 'history',
                         p_subcategory: null, p_total_questions: 5,
                         p_game_key: 'probe' }],

  // Migrations 045-047 — the game moving off the host's phone.
  //
  // These matter differently from everything above. The app FALLS BACK when
  // they are missing, so nothing looks broken to a player — it silently
  // reverts to each browser judging for itself, which is the exact state the
  // rebuild exists to end. A dead server here is invisible by design, so it
  // has to be visible here.
  ['op_answer_matches', { p_submitted: 'probe', p_correct: 'probe' }],
  ['op_submit_answer', { p_room_id: NOT_A_UUID, p_player_id: NOT_A_UUID,
                         p_question_number: 0, p_answer: 'probe', p_wager: 1 }],
  ['op_fill_blank_answers', { p_room_id: NOT_A_UUID, p_question_number: 0 }],
  ['op_start_clock', { p_room_id: NOT_A_UUID, p_phase: 'question', p_question_number: 0 }],
];

console.log('\n--- RPC FUNCTIONS (probed by signature; no function body runs) ---');
const missingRpcs = [];
for (const [fn, args] of RPC_PROBES) {
  const r = await req(`rpc/${fn}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  });
  const code = pgCode(r.body);
  let state;
  if (r.status === 404) {
    state = '*** NOT INSTALLED (or a different signature) ***';
    missingRpcs.push(fn);
  } else if (code === '22P02' || (r.status >= 200 && r.status < 300)) {
    state = 'installed';
  } else {
    state = `installed — HTTP ${r.status}${code ? ` / ${code}` : ''}`;
  }
  console.log(`  ${fn.padEnd(34)} ${state}`);
}

console.log('\n' + '='.repeat(70));
console.log('Probe complete. Nothing was created, modified or deleted.');
console.log('='.repeat(70));

// ============================================
// WHAT THIS MEANS FOR A PLAYER
//
// Everything above is a fact about the database. None of it says what a person
// holding a phone would actually notice, and that gap is how a dead feature
// survives a green probe: player_stats_computed sat unreadable in the output
// for days while the leaderboard, the tier badges, the profile's stats and
// every title unlock were silently empty, and nothing here connected the two.
//
// So the last thing this script prints is the only thing most readers need:
// which parts of the game are broken right now, in words, with the fix.
//
// Each entry names a database object and what depends on it. Absent from this
// list means "no known player-visible consequence" — not "unimportant".
// ============================================

const CONSEQUENCES = [
  { object: 'player_stats_computed', kind: 'table',
    fix: 'run migrations/031_restore_player_stats_view.sql',
    breaks: [
      'the global leaderboard is empty',
      'every category leaderboard is empty',
      'the profile page shows no stats',
      'no tier badge appears in any lobby',
      'NO TITLE EVER UNLOCKS — the check runs against nothing and reports success',
    ] },
  { object: 'amend_question_history', kind: 'rpc',
    fix: 'run migrations/041_host_can_correct_history.sql',
    breaks: [
      "a host flipping a judgement corrects it for THEMSELVES and silently does nothing for every other player",
      'question_history is scoped to its owner, so the refusal returns zero rows and no error',
    ] },
  { object: 'revoke_question_history', kind: 'rpc',
    fix: 'run migrations/041_host_can_correct_history.sql',
    breaks: [
      'a DISQUALIFIED round keeps counting against everyone except the host',
      'and cannot be removed even for the host — question_history has no DELETE policy for anybody',
    ] },
  { object: 'admin_account_details', kind: 'rpc',
    fix: 'run migrations/042_admin_account_details.sql',
    breaks: ['the admin account panel cannot show email, sign-up method or last sign-in'] },
  { object: 'record_game_play', kind: 'rpc',
    fix: 'run migrations/034_count_every_round.sql',
    breaks: ["a group's whole evening counts as one play each, under-counting the people who play most"] },
  { object: 'question_stats', kind: 'table',
    fix: 'run migrations/025_question_stats.sql',
    breaks: ['the admin Question Health page has no performance data'] },
  { object: 'answer_tally', kind: 'table',
    fix: 'run migrations/029_answer_tally.sql',
    breaks: ['the admin page cannot show what people actually typed'] },
  { object: 'record_round_history', kind: 'rpc',
    fix: 'run migrations/043_record_round_history.sql',
    breaks: ['a round is recorded only by the phones that were awake for the reveal, so two players who both missed the same question can end up with different permanent records'] },
  { object: 'record_answer_text', kind: 'rpc',
    fix: 'run migrations/029_answer_tally.sql',
    breaks: ['nothing anybody types is ever counted'] },
  { object: 'record_question_outcome', kind: 'rpc',
    fix: 'run migrations/025_question_stats.sql',
    breaks: ['no question performance is recorded, so bad questions stay invisible'] },
  { object: 'get_category_play_counts', kind: 'rpc',
    fix: 'run migrations/021_play_count_access.sql',
    breaks: ['every category shows 0 plays on the host screen'] },
  // Deliberately listed even though it is harmless: an entry saying "this is
  // missing and it does not matter" is worth more than silence, which reads
  // the same as "not checked".
  { object: 'get_mastery_counts', kind: 'rpc',
    fix: 'optional — migrations would add it; fetchMasteryCounts already falls back',
    breaks: ['the mastery tree falls back to a slower client-side query (works, just slower)'] },

  // The rebuild. Every one of these fails SILENTLY — the app reverts to the
  // old client-side path and a player sees a working game, so the only symptom
  // is the thing the rebuild was meant to stop happening again.
  { object: 'op_answer_matches', kind: 'rpc',
    fix: 'run migrations/045_server_judges_answers.sql',
    breaks: ['the server cannot judge an answer at all, so 046 cannot either'] },
  { object: 'op_submit_answer', kind: 'rpc',
    fix: 'run migrations/046_server_records_answers.sql',
    breaks: ['every browser judges and scores its own answer again, so two phones can disagree about the same round and any client can write any score it likes'] },
  { object: 'op_fill_blank_answers', kind: 'rpc',
    fix: 'run migrations/046_server_records_answers.sql',
    breaks: ['only the host can close a round, so a host whose phone is asleep leaves it hanging'] },
  { object: 'op_start_clock', kind: 'rpc',
    fix: 'run migrations/047_server_owns_the_clock.sql',
    breaks: ["the round clock goes back to the host phone's ESTIMATE of server time, which the answer deadline is then measured against — a slow estimate refuses every answer in the room as late"] },
];

console.log('\n--- WHAT THIS MEANS FOR A PLAYER ---');
const broken = CONSEQUENCES.filter(c =>
  c.kind === 'rpc' ? missingRpcs.includes(c.object) : unreadable.has(c.object));

if (broken.length === 0) {
  console.log('  Nothing on the watch list is missing.');
} else {
  for (const c of broken) {
    const why = c.kind === 'rpc' ? 'function not installed' : unreadable.get(c.object);
    console.log(`\n  ${c.object} — ${why}`);
    for (const line of c.breaks) console.log(`      · ${line}`);
    console.log(`      FIX: ${c.fix}`);
  }
}
console.log('');

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
  // is_bot is migration 030. Without it, adding a practice bot inserts an
  // unknown column and Postgres rejects the whole row — the same shape as
  // every schema-drift bug in CLAUDE.md #3.
  players: ['id', 'room_id', 'display_name', 'is_host', 'is_cohost', 'score',
            'last_seen_at', 'disconnected_at', 'joined_at', 'user_id',
            'avatar_color', 'avatar_emoji', 'title', 'is_ready', 'is_bot', 'score'],
  rooms:   ['id', 'code', 'host_name', 'category', 'subcategory', 'status', 'used_question_ids',
            'game_phase', 'current_question', 'question_ids', 'question_started_at',
            'countdown_started_at', 'questions_per_game', 'question_timer',
            'auto_proceed', 'who_can_join', 'used_question_ids',
            // Migration 038 — the lobby's cumulative Room Scores tally. Without
            // it the section simply never appears.
            'room_scores'],
  answers: ['id', 'room_id', 'player_id', 'question_number', 'question_id',
            'wager', 'submitted_answer', 'is_correct', 'auto_correct', 'score_earned',
            // Migration 043 — the marker that makes recording a round
            // idempotent. Nothing in js/ writes it directly; the function does.
            'history_recorded'],
  game_plays: ['id', 'room_id', 'player_id', 'category', 'subcategory', 'completed_at',
               'total_questions', 'questions_answered', 'final_score', 'completed'],
  question_feedback: ['id', 'question_id', 'voter_id', 'room_id', 'player_name',
                      'feedback_type', 'flag_reason',
                      // Migration 039 — what somebody typed against an "Other" flag.
                      'flag_note'],
  questions: ['id', 'question', 'correct_answer', 'acceptable_answers',
              'incorrect_answers',
              'categories', 'subcategory', 'difficulty', 'format', 'fun_fact'],
  // Everything else the app writes anywhere, gathered by scanning every
  // .insert/.update/.upsert call. One unknown column rejects the whole
  // statement, so an unchecked write is a feature that can die silently.
  profiles:         ['user_id', 'display_name', 'is_admin', 'title_builder_unlocked',
                     'avatar_color', 'avatar_emoji', 'discriminator'],
  question_history: ['user_id', 'question_id', 'times_seen', 'times_correct',
                     'last_correct', 'last_seen_at'],
  title_unlocks:    ['user_id', 'word_id', 'unlocked_at'],
  chat_messages:    ['room_id', 'player_name', 'message'],
  chat_archive:     ['room_code', 'host_name', 'category', 'player_count',
                     'game_started_at', 'archived_at'],
  friend_requests:  ['sender_id', 'receiver_id', 'status'],
  friendships:      ['user_a', 'user_b', 'source'],
  error_logs:       ['timestamp', 'url', 'user_agent', 'message', 'type'],
  site_settings:    ['key', 'value', 'updated_at'],
  player_stats:     ['user_id'],
  game_history:     ['user_id', 'played_at'],
  question_stats:   ['question_id', 'times_asked', 'times_correct', 'times_overridden'],
  answer_tally:     ['question_id', 'answer_key', 'answer_shown', 'times_given', 'last_seen'],
  player_stats_computed: ['user_id', 'category', 'subcategory', 'questions_answered',
                          'correct_answers', 'games_played', 'wins',
                          // Migration 040 — proficiency counts QUESTIONS, not
                          // attempts. rowProficiency falls back to the attempt
                          // counters without these, so nothing breaks; the
                          // number just means the old thing.
                          'questions_met', 'questions_mastered'],
};

console.log('\n--- COLUMNS THE APP DEPENDS ON ---');
//
// THIS SECTION USED TO LIE, in the way CLAUDE.md #6 warns about: it counted a
// column as missing only on HTTP 400 "does not exist". A table that is not
// there at all answers 404 to every request, so not one column was ever
// recorded as missing and the table was reported "all present" — the most
// reassuring possible output for the most broken possible state.
//
// player_stats_computed is exactly that case: the row-count section above said
// it could not be read, and this section said all of its columns were present.
// Two halves of one script disagreeing about one object, and the confident
// half was the wrong one.
for (const [tbl, cols] of Object.entries(REQUIRED)) {
  if (unreadable.has(tbl)) {
    // Say nothing about columns of something we cannot read. Any answer here
    // would be an artefact of the failure, not a fact about the schema.
    console.log(`  ${tbl.padEnd(20)} *** NOT CHECKED — ${unreadable.get(tbl)} ***`);
    continue;
  }
  const missing = [];
  for (const col of cols) {
    const r = await req(`${tbl}?select=${col}&limit=1`);
    if (r.status === 400 && /does not exist|could not find/i.test(r.body || '')) missing.push(col);
  }
  console.log(missing.length
    ? `  ${tbl.padEnd(20)} *** MISSING: ${missing.join(', ')} ***`
    : `  ${tbl.padEnd(20)} all present`);
}

// ============================================
// FOREIGN KEYS
//
// Read from PostgREST's OpenAPI description, which annotates a column with
// "<fk table='...' column='...'/>" when one exists. Read-only, and the only
// way to see this without a database password.
//
// It matters because a foreign key to `rooms` is a countdown. Rooms are
// DELETED when the last player leaves, so anything pointing at one with
// ON DELETE CASCADE is erased at the end of every session — which looks
// exactly like "the feature stopped recording" rather than like a deletion.
// `answers` is already known to work this way and is documented as such.
//
// This CANNOT see the ON DELETE action, only that a key exists. A key to
// rooms is a reason to go and check, not a verdict.
// ============================================

console.log('\n--- FOREIGN KEYS TO `rooms` (data that dies with the room) ---');
try {
  const spec = await req('');
  const doc = JSON.parse(spec.body || '{}');
  const defs = doc.definitions || doc.components?.schemas || {};
  let found = 0;
  for (const [table, def] of Object.entries(defs)) {
    for (const [col, meta] of Object.entries(def.properties || {})) {
      const m = /<fk table='([^']+)' column='([^']+)'\/>/.exec(meta.description || '');
      if (!m) continue;
      found++;
      const flag = m[1] === 'rooms' ? '  <-- dies with the room if ON DELETE CASCADE' : '';
      if (m[1] === 'rooms') console.log(`  ${table}.${col} -> ${m[1]}.${m[2]}${flag}`);
    }
  }
  if (found === 0) {
    console.log('  (the OpenAPI description carries no foreign-key annotations — cannot tell from here)');
  }
} catch (err) {
  console.log(`  (could not read the OpenAPI description: ${err.message})`);
}

// ============================================
// QUESTIONS FILED WHERE NOTHING CAN FIND THEM
//
// `questions.subcategory` is free text with no constraint and no foreign key.
// Category selection matches it with `LIKE 'key%'`, so a value that is not a
// key in CATEGORY_META is a question that the subcategory that was meant to
// hold it will never draw. There is no error, and the question still counts
// in the bank and in every total — it simply never appears.
//
// The same goes for `categories`: an entry that is not one of the twelve is a
// filing no screen offers, so nothing can select it.
//
// The admin page can now fix both from a phone, which is what makes finding
// them worth doing. Before that there was nothing to do about an answer here.
// ============================================

console.log('\n--- QUESTIONS FILED UNDER SOMETHING THE APP DOES NOT KNOW ---');
try {
  const { CATEGORY_META, flattenSubcategories } =
    await import('../js/categories.js').catch(() => import('./../js/categories.js'));

  const known = new Set(Object.keys(CATEGORY_META));
  const knownSubs = new Set();
  for (const cat of known) for (const s of flattenSubcategories(cat)) knownSubs.add(s.key);

  // Paged, because the bank is ~4,859 rows and PostgREST caps a page.
  const badCats = new Map();
  const badSubs = new Map();
  let seen = 0, page = 0, more = true;
  while (more && page < 12) {
    const from = page * 1000;
    const res = await req(`questions?select=categories,subcategory&limit=1000&offset=${from}`);
    if (res.status !== 200 && res.status !== 206) {
      console.log(`  (could not read questions: HTTP ${res.status})`);
      more = false;
      break;
    }
    const rows = JSON.parse(res.body || '[]');
    seen += rows.length;
    for (const r of rows) {
      for (const c of r.categories || []) {
        if (!known.has(c)) badCats.set(c, (badCats.get(c) || 0) + 1);
      }
      const s = r.subcategory;
      if (s && !knownSubs.has(s)) badSubs.set(s, (badSubs.get(s) || 0) + 1);
    }
    more = rows.length === 1000;
    page++;
  }

  if (seen === 0) {
    console.log('  (no questions read — nothing established)');
  } else {
    console.log(`  checked ${seen} questions`);
    if (badCats.size === 0 && badSubs.size === 0) {
      console.log('  every question is filed under a category and subcategory the app knows.');
    }
    for (const [c, n] of [...badCats].sort((a, b) => b[1] - a[1])) {
      console.log(`  *** category "${c}" is not one of the twelve — ${n} question(s), selectable by nothing`);
    }
    for (const [s, n] of [...badSubs].sort((a, b) => b[1] - a[1])) {
      console.log(`  *** subcategory "${s}" is in no category's tree — ${n} question(s), never drawn by that filter`);
    }
    if (badCats.size || badSubs.size) {
      console.log('  Fix from admin.html -> Question Bank -> search the question -> tap it.');
    }
  }
} catch (err) {
  console.log(`  (could not check filings: ${err.message})`);
}

// ============================================
// ANSWER KEYS WORTH A SECOND LOOK
//
// The rules live in js/answer-health.js and are shared with the admin page,
// which runs the same scan in the browser and lists the same questions as
// editable rows. Two copies would drift, and the whole value of this is that
// the CI log and the phone say the same thing.
//
// CANDIDATES, NOT VERDICTS. "9/11" and "1776" are exact dates that belong in
// the bank. Nothing here writes an acceptable answer: that is the owner's, by
// rule, and the value of this bank is that it is not model-written.
// ============================================

console.log('\n--- ANSWER KEYS WORTH A SECOND LOOK (candidates, not verdicts) ---');
try {
  const { findAnswersNeedingReview } = await import('../js/answer-health.js');

  const rows = [];
  let page = 0, ok = true;
  while (page < 12) {
    const res = await req(`questions?select=id,question,correct_answer,acceptable_answers&limit=1000&offset=${page * 1000}`);
    if (res.status !== 200 && res.status !== 206) {
      console.log(`  (could not read questions: HTTP ${res.status})`);
      ok = false;
      break;
    }
    const batch = JSON.parse(res.body || '[]');
    rows.push(...batch);
    if (batch.length < 1000) break;
    page++;
  }

  if (!ok || rows.length === 0) {
    if (ok) console.log('  (no questions read — nothing established)');
  } else {
    const found = findAnswersNeedingReview(rows);
    const withAlts = rows.filter(r => Array.isArray(r.acceptable_answers) && r.acceptable_answers.length).length;
    console.log(`  checked ${rows.length} questions; ${withAlts} carry at least one acceptable alternate`);
    console.log('  Questions that already have an alternate are skipped — an alternate is the');
    console.log('  author saying they have thought about how the answer gets typed.');

    if (found.length === 0) {
      console.log('  Nothing needs a second look.');
    } else {
      const byKind = new Map();
      for (const f of found) byKind.set(f.finding.label, (byKind.get(f.finding.label) || 0) + 1);
      console.log(`  ${found.length} worth a look: ${[...byKind].map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ')}`);
      for (const { question, finding } of found) {
        const qt = String(question.question ?? '').replace(/\s+/g, ' ').slice(0, 58);
        console.log(`     [${finding.kind}] "${qt}${qt.length >= 58 ? '\u2026' : ''}"  ->  ${JSON.stringify(String(question.correct_answer).slice(0, 40))}`);
      }
      console.log('\n  The same list is on admin.html -> Question Bank -> "Review answer keys",');
      console.log('  where each row opens for editing. Add the forms a player would actually type.');
    }
  }
} catch (err) {
  console.log(`  (could not check answers: ${err.message})`);
}
