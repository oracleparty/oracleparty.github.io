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
  // Finished games for the admin, so the account panel has something to
  // summarise. Without these the panel's "plays most" line never runs at all —
  // which is how the first version of this scenario failed to catch a missing
  // CATEGORY_META import: the guard existed, the test data never reached it.
  //
  // Three games across TWO rooms on purpose: games and sessions must come out
  // as different numbers, or an assertion on both proves only one.
  table.store.seed('game_history', [
    { id: 1, user_id: 'user-roman', room_id: 'past-room-1', category: 'history',
      subcategory: null, score: 42, placement: 1, total_players: 3,
      played_at: new Date(now - 86400000).toISOString() },
    { id: 2, user_id: 'user-roman', room_id: 'past-room-1', category: 'history',
      subcategory: null, score: 31, placement: 2, total_players: 3,
      played_at: new Date(now - 86000000).toISOString() },
    { id: 3, user_id: 'user-roman', room_id: 'past-room-2', category: 'science',
      subcategory: null, score: 18, placement: 3, total_players: 4,
      played_at: new Date(now - 3600000).toISOString() },
  ]);

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
  // 2b. PANEL COUNTS
  //
  // The sections are closed now and load on demand, so the number on a closed
  // row is the only thing telling an admin there is anything to look at. If
  // that number is wrong or missing the redesign has made the page worse, not
  // shorter — nobody opens a panel that looks empty.
  // ============================================================
  heading('panel counts');
  const countOf = async key =>
    (await admin.page.textContent(`[data-count="${key}"]`).catch(() => '') || '').trim();

  const flagCount = await countOf('flagged');
  note(`closed-panel counts: flagged=${JSON.stringify(flagCount)} questions=${JSON.stringify(await countOf('questions'))}`);
  if (!/3\s*flags/i.test(flagCount)) {
    problems.push(`the closed Flagged Questions row reads ${JSON.stringify(flagCount)} with three flags in the database — an admin has no reason to open it`);
  }
  const alerted = await admin.page.locator('[data-count="flagged"].admin-panel__count--alert').count().catch(() => 0);
  if (alerted !== 1) {
    problems.push('a non-zero flag count is not highlighted, so it reads the same as an empty section');
  }

  // Opening a panel is what fetches it. Everything below has to knock first.
  const openPanel = async key => {
    await admin.page.click(`.admin-panel__head[data-panel="${key}"]`).catch(() => {});
    await admin.page.waitForTimeout(900);
    const expanded = await admin.page
      .getAttribute(`.admin-panel__head[data-panel="${key}"]`, 'aria-expanded').catch(() => null);
    if (expanded !== 'true') {
      problems.push(`the ${key} panel did not open when tapped`);
    }
  };

  // ============================================================
  // 3. FLAGGED QUEUE
  // ============================================================
  heading('flagged questions');
  await openPanel('flagged');
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
  await openPanel('health');
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

  // ============================================================
  // STAT DRILL-DOWNS
  //
  // The four numbers at the top now open the list they were counted from.
  // The checks that matter are the guards on the destructive one: an admin
  // must not be offered a Delete button on their own row or on another
  // admin's, because the database refuses both and a button that always
  // fails is worse than no button.
  // ============================================================
  heading('stat drill-downs');
  await admin.goto('admin.html');
  await admin.page.waitForTimeout(2500);

  for (const which of ['online', 'games', 'accounts', 'today']) {
    const card = admin.page.locator(`[data-drill="${which}"]`);
    if (!await card.isVisible().catch(() => false)) {
      problems.push(`the ${which} stat card is not tappable`);
      continue;
    }
    await card.click().catch(() => {});
    await admin.page.waitForTimeout(900);
    const open = await admin.page.evaluate(() => {
      const panel = document.querySelector('#stat-drill');
      const body = document.querySelector('#stat-drill-body');
      return {
        shown: !!panel && !panel.classList.contains('hidden'),
        title: (document.querySelector('#stat-drill-title')?.textContent || '').trim(),
        text: (body?.textContent || '').trim().slice(0, 60),
        errored: !!body?.querySelector('.stat-drill__error'),
        stillLoading: (body?.textContent || '').includes('Loading...'),
      };
    }).catch(() => ({}));
    note(`${which}: ${JSON.stringify(open)}`);
    if (!open.shown) problems.push(`tapping the ${which} stat opened nothing`);
    if (open.errored) problems.push(`the ${which} list reported an error: ${open.text}`);
    if (open.stillLoading) problems.push(`the ${which} list never finished loading`);
  }

  // Tapping the open card again closes it.
  await admin.page.locator('[data-drill="today"]').click().catch(() => {});
  await admin.page.waitForTimeout(500);
  const closed = await admin.page.evaluate(() =>
    document.querySelector('#stat-drill')?.classList.contains('hidden')).catch(() => false);
  note(`tapping the open card again closes it: ${closed}`);
  if (!closed) problems.push('tapping an open stat card again does not close its list');

  // The guards on Delete.
  await admin.page.locator('[data-drill="accounts"]').click().catch(() => {});
  await admin.page.waitForTimeout(1200);
  const guards = await admin.page.evaluate(() =>
    [...document.querySelectorAll('#stat-drill-body .stat-drill__row')].map(row => ({
      name: (row.querySelector('.stat-drill__name')?.textContent || '').trim(),
      hasDelete: !!row.querySelector('[data-del-account]'),
    }))).catch(() => []);
  note(`account rows: ${JSON.stringify(guards)}`);

  // ============================================================
  // TAPPING AN ACCOUNT OPENS IT
  //
  // The dashboard listed eleven accounts, most of them called "New Player",
  // with no way to tell a real person from an abandoned sign-up and no action
  // but Delete. The panel answers that — but the half that identifies somebody
  // reads auth.users through a database function, so it is the half most
  // likely to be missing, and it must degrade to a partial answer rather than
  // an error.
  //
  // This also guards a live ReferenceError: renderAccountDetail reads
  // CATEGORY_META, which was NOT imported when it was written. The
  // module-integrity check passed because it only verifies FUNCTIONS, and
  // nothing here runs until a row is actually tapped.
  // ============================================================
  heading('opening an account');
  {
    const firstRow = admin.page.locator('#stat-drill-body [data-account]').first();
    if (!await firstRow.isVisible().catch(() => false)) {
      problems.push('no account row was openable — the list is not clickable at all');
    } else {
      await firstRow.click().catch(() => {});
      await admin.page.waitForTimeout(1500);

      const panel = await admin.page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-account-detail]')]
          .find(e => e.style.display !== 'none');
        if (!el) return null;
        return {
          text: el.textContent.replace(/\s+/g, ' ').trim(),
          rows: el.querySelectorAll('.account-detail__row').length,
          stillLoading: /Loading/.test(el.textContent),
        };
      }).catch(() => null);

      note(`panel: ${panel ? JSON.stringify(panel).slice(0, 200) : '(never opened)'}`);

      if (!panel) {
        problems.push('tapping an account opened nothing');
      } else {
        if (panel.stillLoading) problems.push('the account panel never finished loading');
        if (panel.rows === 0) problems.push('the account panel opened empty');
        if (!/Games played/i.test(panel.text)) {
          problems.push('the account panel does not say how many games they have played');
        }
        if (!/Sessions/i.test(panel.text)) {
          problems.push('the account panel does not say how many sessions — games and sessions answer different questions and both were asked for');
        }
        // Three games across two rooms. If these came out equal the panel
        // would be reporting one number twice under two labels.
        if (!/Games played 3/i.test(panel.text)) {
          problems.push(`games played is wrong — expected 3, panel says: ${panel.text.slice(0, 120)}`);
        }
        if (!/Sessions 2/i.test(panel.text)) {
          problems.push(`sessions is wrong — three games across two rooms is 2 sessions, panel says: ${panel.text.slice(0, 120)}`);
        }
        // Reached only when the player HAS games, which is what makes the
        // CATEGORY_META line execute.
        if (!/Plays most/i.test(panel.text)) {
          problems.push('the account panel does not say which categories they play');
        }
      }

      // A console error here means something in the panel threw. That is the
      // shape a missing import takes, and it fires only on this tap.
      const threw = admin.consoleErrors.filter(e =>
        /is not defined|ReferenceError|Cannot read/i.test(e));
      if (threw.length) {
        problems.push(`opening an account threw: ${threw[0].slice(0, 160)}`);
      }
    }
  }
  if (guards.length === 0) {
    problems.push('the accounts list is empty even though accounts exist');
  } else {
    const mine = guards.find(g => g.name.startsWith('Roman'));
    if (mine && mine.hasDelete) {
      problems.push("the admin is offered a Delete button on their OWN account row");
    }
  }

  // ============================================================
  // EVERY PANEL OPENS
  //
  // Each section is fetched the first time it is opened, so eight sections
  // mean eight code paths that now run at a moment nothing used to run at.
  // Before this they all ran at page load, where one throwing loader was
  // loud; now a broken one shows as a panel that opens and stays blank.
  //
  // Also pins one-at-a-time. Two open panels on a phone is the scroll this
  // redesign exists to remove, and it is the kind of thing that regresses
  // silently because the page still works.
  // ============================================================
  heading('every panel opens');
  await admin.goto('admin.html');
  await admin.page.waitForTimeout(2500);

  for (const key of ['flagged', 'health', 'questions', 'games', 'errors', 'chat', 'announcement', 'flags']) {
    await admin.page.click(`.admin-panel__head[data-panel="${key}"]`).catch(() => {});
    await admin.page.waitForTimeout(800);

    const state = await admin.page.evaluate(k => {
      const body = document.getElementById(`panel-${k}`);
      const heads = [...document.querySelectorAll('.admin-panel__head')];
      return {
        expanded: heads.find(h => h.dataset.panel === k)?.getAttribute('aria-expanded'),
        hidden: body ? body.hidden : null,
        error: (body?.querySelector('.admin-panel__error')?.textContent || '').trim(),
        stillLoading: /Loading\.\.\./.test(body?.textContent || ''),
        openCount: heads.filter(h => h.getAttribute('aria-expanded') === 'true').length,
      };
    }, key).catch(() => ({}));

    note(`${key}: ${JSON.stringify(state)}`);
    if (state.expanded !== 'true' || state.hidden !== false) {
      problems.push(`the ${key} panel did not open when tapped`);
    }
    if (state.error) problems.push(`the ${key} panel failed to load: ${state.error.slice(0, 120)}`);
    if (state.stillLoading) problems.push(`the ${key} panel never finished loading`);
    if (state.openCount > 1) {
      problems.push(`opening ${key} left ${state.openCount} panels open — they are meant to be one at a time`);
    }
  }

  // ============================================================
  // REFILING A QUESTION
  //
  // A question in the wrong category needed the Supabase SQL editor — a
  // language question stuck in Food and Drink could not be moved from a
  // phone. The chips and the subcategory menu are the fix, and the thing to
  // check is not that they render but that what they write reaches the row:
  // `categories` is an array and `subcategory` a free text column with no
  // constraint behind it, so a wrong value is stored happily and shows up
  // months later as a question nobody can find.
  // ============================================================
  heading('refiling a question');
  await admin.page.click('.admin-panel__head[data-panel="questions"]').catch(() => {});
  await admin.page.waitForTimeout(1200);

  const qRow = admin.page.locator('#question-results .admin-q-row').first();
  if (!await qRow.isVisible().catch(() => false)) {
    problems.push('the question bank listed nothing to edit');
  } else {
    // The bank lists newest first, so the first row is NOT q1. Read the id off
    // the row being edited rather than assuming which one it is — asserting on
    // q1 made this report a working save as a silent failure.
    const editedId = await qRow.getAttribute('data-qid').catch(() => null);
    note(`editing question: ${editedId}`);
    await qRow.locator('.admin-q-row__summary').click().catch(() => {});
    await admin.page.waitForTimeout(400);

    const chipCount = await qRow.locator('.admin-cat-chip').count().catch(() => 0);
    note(`category chips offered: ${chipCount}`);
    if (chipCount !== 12) {
      problems.push(`the editor offers ${chipCount} category chips, expected 12 — a category with no chip cannot be filed into`);
    }

    // Seeded as history. Move it to culture-society, and file it under a
    // subcategory that only exists in the new category — which is the case
    // the picker has to get right, because the list is rebuilt from whatever
    // is ticked.
    await qRow.locator('.admin-cat-chip[data-cat="history"]').click().catch(() => {});
    await qRow.locator('.admin-cat-chip[data-cat="culture-society"]').click().catch(() => {});
    await admin.page.waitForTimeout(300);

    const subOptions = await qRow.locator('.admin-q-edit__subcategory option').allTextContents().catch(() => []);
    note(`subcategories offered after switching category: ${subOptions.map(s => s.trim()).join(', ')}`);
    if (!subOptions.some(s => /Language/i.test(s))) {
      problems.push('switching category did not rebuild the subcategory list — it still offers the old category\'s filings');
    }
    if (subOptions.some(s => /Ancient|Medieval/i.test(s))) {
      problems.push('the subcategory list still offers History filings after History was unticked');
    }

    await qRow.locator('.admin-q-edit__subcategory').selectOption('language').catch(() => {});
    await qRow.locator('.admin-q-edit__save').click().catch(() => {});
    await admin.page.waitForTimeout(1200);

    const refiled = table.store.table('questions').find(q => q.id === editedId);
    note(`stored filing: categories=${JSON.stringify(refiled?.categories)} subcategory=${JSON.stringify(refiled?.subcategory)}`);
    if (JSON.stringify(refiled?.categories) !== JSON.stringify(['culture-society'])) {
      problems.push(`refiling did not write the categories (row says ${JSON.stringify(refiled?.categories)})`);
    }
    if (refiled?.subcategory !== 'language') {
      problems.push(`refiling did not write the subcategory (row says ${JSON.stringify(refiled?.subcategory)})`);
    }

    // The row on screen must agree with what was stored, or the next tap
    // edits from a stale starting point.
    const summary = (await qRow.locator('.admin-q-row__meta').textContent().catch(() => '')) || '';
    if (!summary.includes('culture-society')) {
      problems.push(`the row still shows the old category after saving: ${summary.replace(/\s+/g, ' ').trim()}`);
    }

    // A question in no category is drawable by nothing, and the editor must
    // refuse rather than store it.
    await qRow.locator('.admin-cat-chip[data-cat="culture-society"]').click().catch(() => {});
    await qRow.locator('.admin-q-edit__save').click().catch(() => {});
    await admin.page.waitForTimeout(800);
    const stranded = table.store.table('questions').find(q => q.id === editedId);
    const refusal = (await qRow.locator('.admin-q-edit__status').textContent().catch(() => '')) || '';
    note(`saving with no category said: ${JSON.stringify(refusal.trim())}`);
    if ((stranded?.categories || []).length === 0) {
      problems.push('a question was saved into no category at all — nothing can ever draw it again');
    }
    if (!/at least one category/i.test(refusal)) {
      problems.push(`saving with no category gave an unhelpful message: ${JSON.stringify(refusal.trim())}`);
    }
  }

  // Tapping the open one again closes it. Whichever one is open — the
  // section above leaves the question bank showing, and hardcoding a panel
  // name here made this report "does not close" when it had merely opened a
  // different one.
  const openNow = await admin.page.evaluate(() =>
    document.querySelector('.admin-panel__head[aria-expanded="true"]')?.dataset.panel).catch(() => null);
  note(`panel open before the close test: ${openNow}`);
  if (openNow) await admin.page.click(`.admin-panel__head[data-panel="${openNow}"]`).catch(() => {});
  await admin.page.waitForTimeout(400);
  const anyOpen = await admin.page.evaluate(() =>
    document.querySelectorAll('.admin-panel__head[aria-expanded="true"]').length).catch(() => -1);
  note(`panels open after tapping the open one again: ${anyOpen}`);
  if (anyOpen !== 0) problems.push('tapping an open panel again does not close it');

} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ admin scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
