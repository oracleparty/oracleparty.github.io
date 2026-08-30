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
  // The GLOBAL board reads player_totals_computed (migration 032), which counts
  // each answered question once. It was absent from this list for the same
  // reason player_stats_computed was: it is a view added later, and the list
  // was written from the table names. Its absence is quieter than the one above
  // — fetchPlayerTotalsForLeaderboard falls back to summing the per-category
  // rollups — but the fallback counts a question filed under two topics TWICE,
  // and 11% of the bank carries more than one category. So the board still
  // draws, with inflated totals, and nothing anywhere says why.
  'player_totals_computed',
  // Migration 029 — what people actually typed.
  'answer_tally',
  // Migration 054 — would you play with this host again.
  //
  // host_ratings ALWAYS READS AS rows=0 HERE, BY DESIGN. Its rows carry
  // voter_id and voter_name, and a public SELECT would let a host look up who
  // thumbs-downed them, so the policy admits admins only — and this probe is an
  // anonymous visitor. An RLS filter returns zero rows rather than an error, so
  // "readable rows=0" is the CORRECT output and not a table to investigate.
  // host_reputation is the aggregate, and that one really is public.
  'host_ratings', 'host_reputation',
  // Migration 063 — the words the owner writes, as content rather than code.
  // Reads as rows=0 until somebody has written one, which is correct output,
  // not a fault: the collection ships empty by design and a slot with no word
  // simply does not exist for players.
  'title_words',
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
  // question_health is a VIEW over questions, and migration 025 selects `q.id`
  // — so its key column is `id`, not `question_id`. It was listed as
  // `question_id` here, which does not exist: PostgREST answered 42703, the
  // sample came back empty, and every write verdict for this object read
  // "no rows to probe with" for a view holding 4,859 of them. A probe that
  // cannot find a column reports the same thing as a probe that found an empty
  // table — CLAUDE.md #6, in miniature.
  answer_tally: 'question_id',
};
const pkOf = t => PK[t] || 'id';

function pgCode(body) {
  try { return JSON.parse(body || '{}').code || null; } catch { return null; }
}

// Returns the sampled keys, and — when it could not sample — WHY.
//
// This used to return a bare [], so "the table is empty" and "the column name
// in PK above is wrong" produced the identical verdict downstream: "no rows to
// probe with". question_health was listed under the wrong key column for as
// long as it has been on this list, and every write verdict for it read as an
// empty view holding 4,859 rows. A probe that cannot tell those apart is the
// fault CLAUDE.md #6 is about, in the tool #6 was written for.
async function samplePks(t, n = 2) {
  const pk = pkOf(t);
  const r = await req(`${t}?select=${pk}&limit=${n}`);
  if (r.status !== 200) {
    const code = pgCode(r.body);
    return { pks: [], why: `could not sample "${pk}" (HTTP ${r.status}${code ? ` / ${code}` : ''})` };
  }
  try {
    return { pks: JSON.parse(r.body || '[]').map(row => row[pk]).filter(v => v != null), why: null };
  } catch {
    return { pks: [], why: 'could not sample (unreadable response)' };
  }
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
  const { pks, why } = await samplePks(t);
  if (why) { console.log(`  ${t.padEnd(20)} NOT PROBED — ${why}`); continue; }
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

  // Migration 051 — the three writes 049 took away.
  //
  // These are the OPPOSITE of a fallback: 049/050 shut the door these replace,
  // so when they are missing the old path is not slower, it is REFUSED, and an
  // RLS refusal returns no error. Play Again silently keeps the last game's
  // answers and a rejoining player silently loses their score.
  ['op_reset_answers', { p_room_id: NOT_A_UUID, p_caller_id: NOT_A_UUID }],
  ['op_reassign_answers', { p_room_id: NOT_A_UUID, p_old_player_id: NOT_A_UUID,
                            p_new_player_id: NOT_A_UUID }],
  ['op_bot_answer', { p_room_id: NOT_A_UUID, p_player_id: NOT_A_UUID,
                      p_question_number: 0, p_question_id: NOT_A_UUID,
                      p_wager: 0, p_answer: 'probe', p_is_correct: false }],
  // Granted to `authenticated` only, so this probe (an anonymous visitor) can
  // establish that it EXISTS but not that an admin may call it. That is the
  // right split: a visitor being able to end rooms is the thing it prevents.
  ['op_admin_end_room', { p_room_id: NOT_A_UUID }],

  // Migration 053 — the leaderboard. p_user_ids is an ARRAY, so the unparseable
  // uuid goes inside it; PostgREST casts before the body runs either way.
  ['get_leaderboard', { p_user_ids: [NOT_A_UUID], p_category: null,
                        p_subcategory: null, p_since: null }],

  // Migration 054 — host reputation. It refuses long before it writes anything
  // (the voter must have a player row in that room), and the uuid does not
  // parse in any case.
  ['op_rate_host', { p_room_id: NOT_A_UUID, p_player_id: NOT_A_UUID,
                     p_voter_id: 'probe', p_rating: 1,
                     p_flag_reason: null, p_flag_note: null }],

  // ------------------------------------------------------------------
  // Migrations 048, 049, 056, 057, 058, 060, 061 — THE LOCKDOWN.
  //
  // READ THE CONSEQUENCE FOR THESE DIFFERENTLY FROM EVERYTHING ABOVE IT.
  // The 045-047 block says the app "falls back" when a function is missing,
  // and that was true when it was written. It is not true of these, and it
  // stopped being true of some of the ones above them on 2026-08-29.
  //
  // Each of these migrations REVOKED the client's right to do the thing the
  // function replaces. So a missing function here is not a slower path, it is
  // a REFUSED one — and for the two `rooms` columns 061 took away, the refusal
  // is a hard `permission denied for column game_phase` that stops the game
  // dead. That is the 055 lesson stated in advance: a dependency that was a
  // fallback becomes load-bearing the moment you shut the door beside it, and
  // the monitoring has to be re-read in that light or it goes on describing
  // the old world confidently.
  //
  // op_advance_phase had a WHAT-THIS-MEANS entry from the day it shipped and
  // was never in this list, so the entry could never fire and the probe
  // printed "Nothing on the watch list is missing" without ever having looked.
  // The guard below this array is what stops that recurring.
  ['op_leave_room', { p_room_id: NOT_A_UUID, p_player_id: NOT_A_UUID }],
  ['op_set_judgement', { p_answer_id: NOT_A_UUID, p_is_correct: true,
                         p_caller_id: NOT_A_UUID }],
  ['op_disqualify_round', { p_room_id: NOT_A_UUID, p_question_number: 0,
                            p_caller_id: NOT_A_UUID }],
  ['op_advance_phase', { p_room_id: NOT_A_UUID, p_caller_id: NOT_A_UUID }],
  ['op_remove_player', { p_room_id: NOT_A_UUID, p_caller_id: NOT_A_UUID,
                         p_target_id: NOT_A_UUID }],
  ['op_set_host_role', { p_room_id: NOT_A_UUID, p_caller_id: NOT_A_UUID,
                         p_target_id: NOT_A_UUID, p_role: 'cohost',
                         p_value: true }],
  ['op_set_phase', { p_room_id: NOT_A_UUID, p_caller_id: NOT_A_UUID,
                     p_expected_phase: null, p_to_phase: 'lobby',
                     p_question: 0 }],
  // Granted to `authenticated` only. An anonymous probe therefore gets 42501,
  // which this script reports as installed — measured, not assumed: the same
  // shape already answers `admin_account_details  installed — HTTP 401 / 42501`
  // on every CI run. The unparseable uuid is the second guard, so the delete
  // could not run even if the grant were wrong.
  ['admin_delete_account', { p_user_id: NOT_A_UUID }],
];

// FUNCTIONS THAT CANNOT BE PROBED WITHOUT DOING THE THING THEY DO.
//
// Both take NO arguments, so there is no unparseable value to stop the body
// running — the trick every entry above depends on. Calling them would sweep
// real rooms and delete a real account. An honest gap beats a guess, which is
// the same call this script already makes about DELETE permissions.
//
// They are listed rather than merely omitted so the guard below can tell
// "deliberately not probed" from "forgotten", and so a reader can see that the
// blind spot was chosen.
const UNPROBEABLE_RPCS = new Map([
  ['op_sweep_rooms', 'takes no arguments and its body deletes abandoned rooms'],
  ['delete_my_account', 'takes no arguments and its body deletes an account'],
]);

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
for (const [fn, why] of UNPROBEABLE_RPCS) {
  console.log(`  ${fn.padEnd(34)} NOT PROBED — ${why}`);
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
  { object: 'op_advance_phase', kind: 'rpc',
    fix: 'run migrations/056_the_game_advances_without_the_host.sql',
    breaks: ['a round only ends if the host\'s phone is awake — a locked screen mid-question strands the whole room, and a host who dies before the clock is stamped strands it forever'] },
  { object: 'get_leaderboard', kind: 'rpc',
    fix: 'run migrations/053_leaderboard_by_what_you_know.sql',
    breaks: [
      'the leaderboard falls back to player_stats_computed, which has no time dimension',
      'so the period control disappears — all-time still works, and by design says so rather than lying',
    ] },
  { object: 'op_rate_host', kind: 'rpc',
    fix: 'run migrations/054_host_reputation.sql',
    breaks: ['nobody can rate a host, silently — the buttons are there and the vote goes nowhere'] },
  { object: 'host_reputation', kind: 'table',
    fix: 'run migrations/054_host_reputation.sql',
    breaks: [
      'every host reads as "new host" on the join list, however many games they have run',
      'and the admin page cannot show who has been reported, so a flag reaches nobody',
    ] },
  { object: 'title_words', kind: 'table',
    fix: 'run migrations/063_title_words_are_content.sql',
    breaks: [
      'the owner cannot write a title word at all — the admin panel saves nothing and says permission denied',
      'so the collection is frozen at whatever is hard-coded, and the ~86 unwritten words can never be added',
      'players see only the coded words, which is not an error state and looks exactly like a finished collection',
    ] },
  { object: 'player_totals_computed', kind: 'table',
    fix: 'run migrations/032_totals_and_mastery.sql',
    breaks: [
      'the GLOBAL leaderboard falls back to summing the per-category rollups, which draws fine and is WRONG',
      'a question filed under two categories is counted twice there — 11% of the bank carries more than one',
      'so the people who play the broadest categories are ranked highest, and nothing says so',
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
    // SINCE MIGRATION 055 THIS IS NO LONGER A DEGRADED FALLBACK, IT IS TOTAL.
    // 055 revoked the client's own INSERT and UPDATE on question_history, so
    // the per-device fallback in doReveal is refused. With this function gone,
    // NOTHING records a round: no accuracy, no proficiency, no mastery, no tier,
    // no title, and an empty leaderboard — accumulating silently, because a
    // permission working and a feature dead look identical from a browser.
    breaks: ['NOTHING records a round at all, so accuracy, proficiency, mastery, tiers, titles and the leaderboard all stop moving — the client fallback is refused by migration 055'] },
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

  // 051 is not a fallback. 049/050 already shut the door these replace, so
  // missing here means the write is REFUSED, silently, and has been since.
  { object: 'op_reset_answers', kind: 'rpc',
    fix: 'run migrations/051_the_three_writes_049_took_away.sql',
    breaks: ["Play Again does not clear the last game's answers, so the next game's scoreboard is computed over a game that already finished"] },
  { object: 'op_reassign_answers', kind: 'rpc',
    fix: 'run migrations/051_the_three_writes_049_took_away.sql',
    breaks: ['a player who rejoins loses their score and their used wagers, and can spend a wager twice'] },
  { object: 'op_bot_answer', kind: 'rpc',
    fix: 'run migrations/051_the_three_writes_049_took_away.sql',
    breaks: ['a practice bot never answers the final question of any game'] },
  { object: 'op_admin_end_room', kind: 'rpc',
    fix: 'run migrations/051_the_three_writes_049_took_away.sql',
    breaks: ["the admin dashboard's End button on a stuck room does nothing and says it worked"] },

  // THE LOCKDOWN (048, 049, 056, 057, 058, 060, 061). Each of these replaces a
  // right the client no longer has, so "missing" means REFUSED, not "slower".
  // The last two are the loud ones: 061 revoked the column itself, so the
  // fallback raises `permission denied for column game_phase` and the game
  // stops rather than quietly disagreeing with itself.
  { object: 'op_leave_room', kind: 'rpc',
    fix: 'run migrations/048_only_the_rules_delete_a_room.sql',
    breaks: [
      'nobody can delete a room they have emptied, so finished games stay listed as live',
      'and the Join page offers real players rooms nobody is in',
    ] },
  { object: 'op_set_judgement', kind: 'rpc',
    fix: 'run migrations/049_only_a_host_changes_a_verdict.sql',
    breaks: ["a host cannot override the machine's verdict — the button moves and the score does not, silently, because a refused UPDATE returns no error"] },
  { object: 'op_disqualify_round', kind: 'rpc',
    fix: 'run migrations/049_only_a_host_changes_a_verdict.sql',
    breaks: ['a host cannot throw out a round; it reports success and the points stand'] },
  // op_advance_phase's entry is up with player_stats_computed, where it has
  // been since 056 shipped — unprobed, and therefore unable to fire, until now.
  { object: 'op_remove_player', kind: 'rpc',
    fix: 'run migrations/057_only_the_rules_remove_a_player.sql',
    breaks: [
      'the stale sweep cannot release an abandoned seat, so ghosts accumulate in every lobby',
      'and the host cannot remove a practice bot',
    ] },
  { object: 'op_set_host_role', kind: 'rpc',
    fix: 'run migrations/058_only_the_rules_make_you_host.sql',
    breaks: [
      'NOBODY CAN BE MADE HOST — a room whose host leaves is frozen for everybody still in it',
      'and co-host cannot be granted or taken away',
    ] },
  { object: 'op_set_phase', kind: 'rpc',
    fix: 'run migrations/060_the_server_moves_the_game_on.sql (and 061)',
    breaks: [
      'NO GAME CAN START OR ADVANCE AT ALL — 061 revoked the column, so the fallback',
      'raises "permission denied for column game_phase" and every phone shows',
      "\"Couldn't move the game on\" on every button in the game",
    ] },
];

// EVERY RPC NAMED HERE MUST ACTUALLY BE PROBED.
//
// op_advance_phase had an entry above from the day it shipped and was never in
// RPC_PROBES, so `broken` could never contain it and this script reported
// "Nothing on the watch list is missing" for a function it had not looked at —
// the single most reassuring output for a completely unknown state, which is
// CLAUDE.md #6 in one line. A watch list that watches nothing is worse than no
// watch list, because it is believed.
const unwatched = CONSEQUENCES
  .filter(c => c.kind === 'rpc')
  .map(c => c.object)
  .filter(name => !RPC_PROBES.some(([fn]) => fn === name)
                  && !UNPROBEABLE_RPCS.has(name));
// And no object may appear twice, or a reader gets the same paragraph twice and
// has to work out whether it is one fault or two. Caught while writing the
// check above: the lockdown block restated op_advance_phase, which already had
// an entry, and the unwatched list printed the name twice — which is what made
// the duplicate visible at all.
const seen = new Set();
const duplicated = CONSEQUENCES.map(c => c.object).filter(o => seen.size === seen.add(o).size);

if (unwatched.length || duplicated.length) {
  console.log('\n*** THIS SCRIPT IS BROKEN ***');
  if (unwatched.length) {
    console.log('  These have a "what this means" entry but are never probed, so');
    console.log('  their consequence can never fire and their absence reads as health:');
    for (const name of unwatched) console.log(`      ${name}`);
  }
  if (duplicated.length) {
    console.log('  These are named by more than one entry, so a reader is told twice:');
    for (const name of duplicated) console.log(`      ${name}`);
  }
  process.exitCode = 1;
}

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
  // THIS PROBE CANNOT VERIFY MIGRATION 055, AND A GREEN LINE HERE MUST NOT BE
  // READ AS THOUGH IT HAD. 055 revoked the INSERT and UPDATE that let a
  // SIGNED-IN player write their own history — and this script runs as an
  // anonymous visitor, who was refused by the old policies too, because they
  // required `user_id = auth.uid()` and anon has no uid. So the write section
  // reported "refused" before 055 and reports "refused" after it: the same
  // answer for the wide-open state and the shut one.
  //
  // That is the exact failure shape #6 is a catalogue of — a check that returns
  // the same result whatever the truth is. Naming it here rather than adding a
  // check that cannot fail: verifying 055 needs a signed-in session, which this
  // script deliberately does not have, and the migration's own verification
  // block (run as the owner, looking at pg_policies) is what settles it.
  // tests/sql/game-rules.sql pins the behaviour against a real Postgres.
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
  // One row per user, not per category — that is the whole difference.
  player_totals_computed: ['user_id', 'questions_answered', 'correct_answers',
                           'games_played', 'wins'],
  host_ratings:     ['host_user_id', 'room_id', 'voter_id', 'voter_name',
                     'rating', 'flag_reason', 'flag_note'],
  host_reputation:  ['host_user_id', 'ratings', 'thumbs_up', 'thumbs_down',
                     'pct_positive', 'flags'],
  // target_right IS THE ONE THAT WILL BITE. applyWordOverlay skips any row
  // without a usable target, so a missing column does not error — it silently
  // drops every word the owner has ever written, with nothing on any screen.
  // That exact fault shipped once already in the fetch's own column list.
  title_words:      ['slot', 'category', 'subcategory', 'tier', 'word', 'target_right'],
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
// DOES A REJOINING PLAYER GET THEIR SCORE BACK?
//
// CLAUDE.md promises they do: the seat is released after STALE_TIMEOUT_MS and
// "rejoining reassigns previous answers to the new player row, so score and
// history survive". reassignPlayerAnswers finds those rows BY THE OLD
// player_id — so the promise is only true if the rows still carry it after the
// player row is gone. Nobody has ever checked, and the section above honestly
// reports that the OpenAPI description cannot say.
//
// PostgREST's EMBEDDING can, without a password and without writing anything.
// `answers?select=id,players(id)` only resolves when PostgREST knows a
// relationship between the two tables; with none it answers 400 / PGRST200.
//
// That is half the fact, and the app's own behaviour supplies the other half:
//
//   * NO relationship  -> deleting a player leaves its answers untouched, with
//                         their player_id intact. Reassignment works and the
//                         promise holds.
//   * A relationship   -> deleting a player must DO something to them, and
//                         every possibility is broken: CASCADE deletes the
//                         answers, SET NULL strips the id off them, and
//                         NO ACTION / RESTRICT raises 23503 so the player row
//                         cannot be removed at all — leaving a seat nothing can
//                         sweep for everybody who actually played. Embedding
//                         cannot see WHICH; migration 052 records it while
//                         dropping the key, which is the only moment it can be
//                         known.
//
// So a relationship here means the rejoin promise has never been kept, long
// before migration 049 revoked anything.
// ============================================

console.log('\n--- CAN A REJOINING PLAYER RECOVER THEIR ANSWERS? ---');
{
  const probeEmbed = async (child) => {
    const r = await req(`answers?select=id,${child}(id)&limit=1`);
    const code = pgCode(r.body);
    if (r.status >= 200 && r.status < 300) return { linked: true, code };
    if (code === 'PGRST200' || /could not find a relationship/i.test(r.body || '')) {
      return { linked: false, code };
    }
    return { linked: null, code, status: r.status };
  };

  const toPlayers = await probeEmbed('players');
  const toRooms = await probeEmbed('rooms');

  const say = (label, r) =>
    console.log(`  answers -> ${label}: ${
      r.linked === true ? 'RELATED' : r.linked === false ? 'no relationship' : `cannot tell (${r.status} ${r.code || ''})`}`);
  say('players', toPlayers);
  say('rooms', toRooms);

  if (toPlayers.linked === true) {
    console.log('  *** A RELEASED SEAT TAKES ITS ANSWERS WITH IT. ***');
    console.log('      reassignPlayerAnswers / op_reassign_answers have nothing to move, so');
    console.log('      "rejoining restores your score" is NOT true and never has been.');
    console.log('      Fix: run migrations/052_answers_outlive_the_seat.sql — it drops the');
    console.log('      key the way 033 did for game_plays, and reports what it had been doing. An');
    console.log('      answer is a record of a round that was played, and once the seat is');
    console.log('      gone there is nothing left for it to point at.');
  } else if (toPlayers.linked === false) {
    console.log('  A released seat leaves its answers behind, carrying the old player_id.');
    console.log('  Reassignment has something to work with, and the rejoin promise holds.');
  } else {
    console.log('  Could not establish it from here. Run the FOREIGN KEYS section of');
    console.log('  scripts/inspect-db.sql in the SQL editor and read confdeltype.');
  }
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
  const subsByCat = new Map();
  for (const cat of known) {
    const set = new Set();
    for (const s of flattenSubcategories(cat)) { knownSubs.add(s.key); set.add(s.key); }
    subsByCat.set(cat, set);
  }

  // Paged, because the bank is ~4,859 rows and PostgREST caps a page.
  const badCats = new Map();
  const badSubs = new Map();
  // TOPIC SIZES, for the title tiers. Counted with format = 'open' because that
  // is what every question-fetch path in js/db/questions.js filters on, so it is
  // the set the game can actually ASK. A target measured against anything wider
  // would make "100% of a topic" unreachable — the same shape as the legendary
  // that was defined twice and could be earned by nobody.
  const topicSize = new Map();   // "category / subcategory" -> count
  let seen = 0, page = 0, more = true;
  while (more && page < 12) {
    const from = page * 1000;
    const res = await req(`questions?select=categories,subcategory,format&limit=1000&offset=${from}`);
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
      // ONLY LEGITIMATE PAIRS. 11% of questions carry more than one category
      // while `subcategory` is a single field, so a history/culture question
      // filed under "ancient" would otherwise invent a topic called
      // "culture-society / ancient" — and counting all observed pairs reported
      // 114 topics where the app offers 42. The app asks
      // fetchQuestionCount(category, sub) only for subs in THAT category's
      // tree, so the probe must count the same way or its targets describe
      // topics no player can ever be shown.
      if (r.format === 'open' && s) {
        for (const c of r.categories || []) {
          if (!known.has(c)) continue;
          if (!(subsByCat.get(c) || new Set()).has(s)) continue;
          const key = `${c} / ${s}`;
          topicSize.set(key, (topicSize.get(key) || 0) + 1);
        }
      }
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

    // --- what each topic is big enough to offer, and the frozen target ---
    const { tiersForTopic, topicTarget } =
      await import('../js/title-tiers.js').catch(() => import('./../js/title-tiers.js'));
    console.log('\n--- TOPIC SIZES AND TITLE TARGETS (askable questions only) ---');
    console.log('  Paste a target next to a word in js/titles.js as');
    console.log("  unlock: { type: 'count', condition: { category, subcategory, right } }.");
    console.log('  FROZEN once written: adding questions must never move a goal.\n');
    const sized = [...topicSize].sort((a, b) => b[1] - a[1]);
    let offersAny = 0;
    for (const [key, n] of sized) {
      const tiers = tiersForTopic(n, key.split(' / ')[1]);
      if (tiers.length) offersAny++;
      const targets = tiers.length
        ? tiers.map(t => `${t} ${topicTarget(n, t)}`).join(', ')
        : 'too small for words of its own';
      console.log(`  ${key.padEnd(34)} ${String(n).padStart(4)}   ${targets}`);
    }
    console.log(`\n  ${offersAny} of ${sized.length} topics can carry words of their own.`);
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
