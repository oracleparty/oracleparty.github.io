// Scenario: the admin dashboard, which no robot has ever opened.
//
// It is gated on profiles.is_admin, so it was unreachable until the harness
// learned to sign in — and it is the owner's only tool for acting on the
// questions players report. It has also been the single richest source of
// silent failure in this project: for months it reported "Saved!" while RLS
// discarded every write, because a denied policy returns no error at all.
//
//   1. A signed-in NON-admin cannot open it.
//   2. An admin can, and the dashboard counts what is actually there.
//   3. Flagged questions appear, with the reason players gave.
//   4. Question Health lists questions and opens on flags.
//   5. Editing acceptable answers saves, and says so.
//   6. When the database REFUSES the write, the page says so rather than
//      claiming success. This is the one that matters.
//
// Run: node tests/harness/scenario-admin.mjs
import { PlaytestTable } from './harness.js';

const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

const table = await PlaytestTable.open();

try {
  const QIDS = ['q1', 'q2', 'q3'];
  table.store.seed('questions', QIDS.map((id, i) => ({
    id, question: `Test question ${i + 1}?`, correct_answer: `Answer ${i + 1}`,
    acceptable_answers: [], categories: ['history'], subcategory: null,
    difficulty: 'medium', format: 'open', fun_fact: null, discarded: false,
  })));

  // question_health is a VIEW in the real database. The store serves it as a
  // plain table, which is fine — the page only reads it.
  table.store.seed('question_health', [
    { id: 'q1', question: 'Test question 1?', correct_answer: 'Answer 1', acceptable_answers: [],
      categories: ['history'], subcategory: null, difficulty: 'medium', format: 'open',
      times_asked: 12, times_correct: 4, times_overridden: 0, pct_correct: 33,
      thumbs_up: 1, thumbs_down: 4, total_votes: 5, pct_liked: 20, flags: 3,
      last_asked_at: new Date().toISOString() },
    { id: 'q2', question: 'Test question 2?', correct_answer: 'Answer 2', acceptable_answers: ['A2'],
      categories: ['history'], subcategory: null, difficulty: 'medium', format: 'open',
      times_asked: 9, times_correct: 8, times_overridden: 0, pct_correct: 89,
      thumbs_up: 6, thumbs_down: 0, total_votes: 6, pct_liked: 100, flags: 0,
      last_asked_at: new Date().toISOString() },
    { id: 'q3', question: 'Test question 3?', correct_answer: 'Answer 3', acceptable_answers: [],
      categories: ['history'], subcategory: null, difficulty: 'medium', format: 'open',
      times_asked: 4, times_correct: 2, times_overridden: 2, pct_correct: 50,
      thumbs_up: 0, thumbs_down: 1, total_votes: 1, pct_liked: 0, flags: 1,
      last_asked_at: new Date().toISOString() },
  ]);

  // What people typed, most common first. The point of this data is that
  // "JFK" appearing eleven times against an answer key of "Kennedy" is one
  // missing acceptable answer, not eleven wrong people.
  table.store.seed('answer_tally', [
    { question_id: 'q1', answer_key: 'answer 1', answer_shown: 'Answer 1', times_given: 9 },
    { question_id: 'q1', answer_key: 'ansewr 1', answer_shown: 'Ansewr 1', times_given: 4 },
    { question_id: 'q1', answer_key: 'no idea', answer_shown: 'no idea', times_given: 2 },
  ]);

  table.store.seed('question_feedback', [
    { id: 'f1', question_id: 'q1', voter_id: 'device:aaa', room_id: null,
      player_name: 'Dana', feedback_type: 'flag', flag_reason: 'wrong_answer' },
    { id: 'f2', question_id: 'q1', voter_id: 'device:bbb', room_id: null,
      player_name: 'Eli', feedback_type: 'flag', flag_reason: 'typo' },
    { id: 'f3', question_id: 'q3', voter_id: 'device:ccc', room_id: null,
      player_name: 'Fay', feedback_type: 'flag', flag_reason: 'outdated' },
    { id: 'f4', question_id: 'q2', voter_id: 'device:ddd', room_id: null,
      player_name: 'Gus', feedback_type: 'thumbs_up', flag_reason: null },
  ]);

  // ============================================================
  // 1. THE GATE
  // ============================================================
  heading('a signed-in non-admin is turned away');
  const player = await table.seatSignedIn('Player', { isAdmin: false });
  await player.goto('admin.html');
  await player.page.waitForTimeout(3000);
  const playerUrl = player.page.url();
  note(`non-admin ended up at: ${playerUrl.split('/').pop()}`);
  if (playerUrl.includes('admin.html')) {
    problems.push('a signed-in player who is NOT an admin can open the admin dashboard');
  }

  // ============================================================
  // 2. THE DASHBOARD
  // ============================================================
  heading('dashboard counts');
  const admin = await table.seatSignedIn('Roman', { isAdmin: true, tier: 'Oracle' });

  // Two live rooms, one playing; one abandoned room with a stale player in it.
  const now = Date.now();
  table.store.seed('rooms', [
    { id: 'room-live-1', code: 'AAAA', host_name: 'Roman', category: 'history', status: 'playing',
      who_can_join: 'anyone', questions_per_game: 5, question_timer: 30, created_at: new Date().toISOString() },
    { id: 'room-live-2', code: 'BBBB', host_name: 'Dana', category: 'history', status: 'lobby',
      who_can_join: 'anyone', questions_per_game: 5, question_timer: 30, created_at: new Date().toISOString() },
  ]);
  table.store.seed('players', [
    // Two genuinely present.
    { id: 'p1', room_id: 'room-live-1', display_name: 'Roman', is_host: true,
      last_seen_at: new Date(now - 5000).toISOString(), joined_at: new Date(now - 60000).toISOString() },
    { id: 'p2', room_id: 'room-live-1', display_name: 'Dana', is_host: false,
      last_seen_at: new Date(now - 8000).toISOString(), joined_at: new Date(now - 60000).toISOString() },
    // Silent for an hour — gone, and must not be counted as online.
    { id: 'p3', room_id: 'room-live-2', display_name: 'Ghost', is_host: true,
      last_seen_at: new Date(now - 3600000).toISOString(), joined_at: new Date(now - 3600000).toISOString() },
    // Left behind by a room that no longer exists. This is the row that made
    // "players online" climb forever when the count had no filter at all.
    { id: 'p4', room_id: 'room-deleted', display_name: 'Orphan', is_host: false,
      last_seen_at: new Date(now - 2000).toISOString(), joined_at: new Date(now - 120000).toISOString() },
  ]);

  await admin.goto('admin.html');
  await admin.page.waitForTimeout(3500);
  if (!admin.page.url().includes('admin.html')) {
    problems.push('an admin was redirected away from the admin dashboard');
  }

  const stat = async id => (await admin.page.textContent(id).catch(() => '')).trim();
  const online = await stat('#stat-online');
  const games = await stat('#stat-games');
  const accounts = await stat('#stat-accounts');
  note(`online=${online} games=${games} accounts=${accounts}`);

  // Two present players in live rooms. Not the hour-silent one, and not the
  // orphan whose room is gone.
  if (online !== '2') {
    problems.push(`"players online" reported ${JSON.stringify(online)}, expected 2 — a stale player or an orphaned row is being counted`);
  }
  if (games !== '1') {
    problems.push(`"games in progress" reported ${JSON.stringify(games)}, expected 1`);
  }
  if (accounts !== '2') {
    problems.push(`"total accounts" reported ${JSON.stringify(accounts)}, expected 2`);
  }

  // ============================================================
  // 3. FLAGGED QUEUE
  // ============================================================
  heading('flagged questions');
  const flagged = (await admin.page.textContent('#flagged-queue').catch(() => '')) || '';
  note(`flagged queue: ${flagged.replace(/\s+/g, ' ').trim().slice(0, 110)}`);
  if (/No flagged questions/i.test(flagged)) {
    problems.push('the flagged queue says there are none, with three flags in the database');
  }
  if (!flagged.includes('Test question 1')) {
    problems.push('the most-flagged question is not listed in the flagged queue');
  }
  if (!/wrong_answer|typo/i.test(flagged)) {
    problems.push('the flagged queue does not show the reason players gave');
  }

  // ============================================================
  // 4. QUESTION HEALTH
  // ============================================================
  heading('question health');
  const qhRows = await admin.page.locator('#qh-list .admin-flag-row').count().catch(() => 0);
  note(`question health rows: ${qhRows}`);
  if (qhRows === 0) {
    const qhText = (await admin.page.textContent('#qh-list').catch(() => '')) || '';
    problems.push(`question health listed nothing — page says: ${qhText.replace(/\s+/g, ' ').trim().slice(0, 90)}`);
  }

  const sortValue = await admin.page.inputValue('#qh-sort').catch(() => null);
  note(`question health opens sorted by: ${sortValue}`);
  if (sortValue !== 'flags') {
    problems.push(`the question list opens on "${sortValue}" rather than flags, so reported questions do not surface first`);
  }

  // ============================================================
  // 5. EDITING ALTERNATES — THE HAPPY PATH
  // ============================================================
  heading('adding an acceptable answer');
  const firstRow = admin.page.locator('#qh-list .admin-flag-row').first();
  if (qhRows > 0) {
    await firstRow.locator('.admin-q-row__text').click().catch(() => {});
    await admin.page.waitForTimeout(500);
    const box = firstRow.locator('.qh-alts');
    if (!await box.isVisible().catch(() => false)) {
      problems.push('tapping a question does not open its answer editor');
    } else {
      await box.fill('JFK\nKennedy').catch(() => {});
      await firstRow.locator('.qh-save').click().catch(() => {});
      await admin.page.waitForTimeout(1500);

      const status = (await firstRow.locator('.qh-status').textContent().catch(() => '')) || '';
      note(`status after saving: ${JSON.stringify(status.trim())}`);
      if (!/saved/i.test(status)) {
        problems.push(`saving alternates did not report success — said ${JSON.stringify(status.trim())}`);
      }

      const stored = table.store.table('questions').find(q => q.id === 'q1');
      note(`stored alternates: ${JSON.stringify(stored?.acceptable_answers)}`);
      if (!Array.isArray(stored?.acceptable_answers) || stored.acceptable_answers.length !== 2) {
        problems.push(`the alternates were not written to the question (got ${JSON.stringify(stored?.acceptable_answers)})`);
      }
    }
  }

  // ============================================================
  // 5b. WHAT PEOPLE TYPED
  //
  // It has to appear next to the box for adding acceptable answers, because
  // the whole value is reading "Ansewr 1 x4" and adding it in the same place.
  // ============================================================
  heading('the answers people gave');
  const tallyText = (await firstRow.locator('.qh-tally').textContent().catch(() => '')) || '';
  note(`tally shows: ${tallyText.replace(/\s+/g, ' ').trim().slice(0, 100)}`);
  if (!tallyText.trim()) {
    problems.push('opening a question shows nothing about what people have typed');
  }
  if (!tallyText.includes('Ansewr 1')) {
    problems.push('a common misspelling is missing from the list of what people typed');
  }
  if (!/9/.test(tallyText) || !/4/.test(tallyText)) {
    problems.push('the counts are not shown next to the answers');
  }
  // The correct answer must be marked, or every list looks like a list of
  // problems and the real ones stop standing out.
  if (!/accepted/i.test(tallyText)) {
    problems.push('nothing marks which answers the game already accepts');
  }

  // ============================================================
  // 6. EDITING ALTERNATES WHEN THE DATABASE REFUSES
  //
  // The whole point. An RLS refusal returns NO error and zero rows, so a page
  // that only checks `error` reports success while saving nothing. That is
  // precisely what happened here for months, and what migration 028 exists to
  // fix. The page must notice and say so.
  // ============================================================
  heading('the database refuses the write');
  table.store.denyWrites('questions');

  const before = JSON.stringify(table.store.table('questions').find(q => q.id === 'q1')?.acceptable_answers);
  await firstRow.locator('.qh-alts').fill('this must not appear').catch(() => {});
  await firstRow.locator('.qh-save').click().catch(() => {});
  await admin.page.waitForTimeout(1500);

  const deniedStatus = (await firstRow.locator('.qh-status').textContent().catch(() => '')) || '';
  note(`status when refused: ${JSON.stringify(deniedStatus.trim())}`);
  if (/^saved/i.test(deniedStatus.trim())) {
    problems.push('the page reported "Saved" while the database refused the write — the silent-failure bug is back');
  }
  if (!/permission|denied|not saved/i.test(deniedStatus)) {
    problems.push(`a refused write produced an unhelpful message: ${JSON.stringify(deniedStatus.trim())}`);
  }

  const after = JSON.stringify(table.store.table('questions').find(q => q.id === 'q1')?.acceptable_answers);
  if (before !== after) {
    problems.push('a refused write changed the stored question anyway');
  }
  table.store.allowWrites('questions');

  for (const r of [admin, player]) {
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3|zero rows|permission/i.test(e));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ admin scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
