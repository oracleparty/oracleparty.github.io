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

  // Two more for the answer-key review. They differ in exactly one thing —
  // whether somebody has already added an alternate — because that is the
  // distinction the scan is built on and the one most likely to break.
  table.store.seed('questions', [
    { id: 'q-unit', question: 'How tall is One World Trade Center?',
      correct_answer: '1,776 ft', acceptable_answers: [], categories: ['culture-society'],
      subcategory: null, difficulty: 'medium', format: 'open', fun_fact: null, discarded: false },
    { id: 'q-unit-ok', question: 'How tall is the Eiffel Tower?',
      correct_answer: '1,083 ft', acceptable_answers: ['1083 feet'], categories: ['culture-society'],
      subcategory: null, difficulty: 'medium', format: 'open', fun_fact: null, discarded: false },
  ]);

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
  // ON A COMPUTER, because that is what this page is now. The admin dashboard
  // is the one screen in this app that is not mobile-only: it carries ten
  // sections, the whole question bank and about 130 title slots, and four of
  // those panels are `data-desktop-only` and deliberately not offered on a
  // phone. A robot at 390px would report every one of them as broken, which
  // would be the check misreading a design decision as a fault.
  //
  // The phone half is checked separately, at the end — see "the emergency half".
  const admin = await table.seatSignedIn('Roman', { isAdmin: true, tier: 'Oracle', desktop: true });

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

  // ONE OLD ENTRY AND ONE RECENT ONE. With only old ones, a Clear button that
  // wiped the whole table would pass; with only recent ones, "nothing older
  // than 7 days" would pass whatever the button did. The pair is what makes
  // both halves of the outcome checkable.
  table.store.seed('error_logs', [
    { id: 1, timestamp: new Date(now - 30 * 86400000).toISOString(),
      type: 'onerror', message: 'ancient failure', severity: 'error' },
    { id: 2, timestamp: new Date(now - 3600000).toISOString(),
      type: 'onerror', message: 'from an hour ago', severity: 'error' },
  ]);

  // THE CHAT ARCHIVE HAD NEVER BEEN SEEDED, so that panel opened, printed
  // "No archived chats." and passed every check ever written about it. An
  // empty panel opens exactly as happily as a working one — the same shape as
  // "it opened" not being "it works".
  //
  // Three rooms, because column alignment cannot be established from one; and
  // the SECOND carries no host name and no player count, which is the shape
  // js/admin.js emits fewer meta spans for. On a desktop those spans are grid
  // columns, so a row that skips one puts its date under another row's message
  // count.
  table.store.seed('chat_archive', [
    { id: 'chat-1', room_code: 'ZMSJ', category: 'history', host_name: 'Roman',
      player_count: 4, archived_at: new Date(now - 3600000).toISOString(),
      messages: [
        { player_name: 'Roman', message: 'right who is ready then', timestamp: new Date(now - 3600000).toISOString() },
        { player_name: 'Dana', message: 'give me a sec, kettle on', timestamp: new Date(now - 3599000).toISOString() },
        { player_name: 'TimeTraveler42', message: 'I have been ready since Tuesday', timestamp: new Date(now - 3598000).toISOString() },
        { player_name: 'Dana', message: 'that is a genuinely long message typed by somebody who had a lot to say about the last answer and wanted everybody in the room to know it', timestamp: new Date(now - 3597000).toISOString() },
      ] },
    { id: 'chat-2', room_code: 'KAYS', category: 'science',
      archived_at: new Date(now - 7200000).toISOString(),
      messages: [{ player_name: 'Anna', message: 'good game', timestamp: new Date(now - 7200000).toISOString() }] },
    { id: 'chat-3', room_code: 'EXWZ', category: 'pop-culture', host_name: 'TimeTraveler42',
      player_count: 6, archived_at: new Date(now - 86400000).toISOString(),
      messages: [{ player_name: 'TimeTraveler42', message: 'same time next week', timestamp: new Date(now - 86400000).toISOString() }] },
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

  // Both percentage sorts must show something with a one-vote sample. The
  // owner reported the opposite: testing with one friend, nothing reached the
  // old minimum of 3, so "% liked" was empty — and an empty list for "not
  // enough data yet" is indistinguishable from one for "the write is broken",
  // which is the confusion this project keeps paying for.
  for (const [sort, what] of [['liked', 'votes'], ['correct', 'plays']]) {
    await admin.page.selectOption('#qh-sort', sort).catch(() => {});
    await admin.page.waitForTimeout(900);
    const ids = await admin.page.evaluate(() =>
      [...document.querySelectorAll('#qh-list .admin-flag-row')].map(r => r.dataset.qid)).catch(() => []);
    const summary = (await admin.page.textContent('#qh-summary').catch(() => '')) || '';
    note(`sorted by ${sort}: ${JSON.stringify(ids)} — ${summary.replace(/\s+/g, ' ').trim().slice(0, 86)}`);
    if (ids.length === 0) {
      problems.push(`sorting by "${sort}" listed nothing, with seeded ${what} in the database — a thin sample must still be shown, or "no data yet" looks like a broken write`);
    }
    // q3 is the THIN one — 1 vote, 4 plays. Counting rows would not catch a
    // revert to a minimum of 3, because the other two seeded questions clear
    // it; naming the question that must survive does.
    if (!ids.includes('q3')) {
      problems.push(`sorting by "${sort}" hid the thinnest-sampled question, so a room of two people sees an empty list and cannot tell recording from silence`);
    }
    // And it has to say the sample is thin, or a 100%-from-one-vote reads as
    // a fact about the question.
    if (!/noise/i.test(summary)) {
      problems.push(`sorting by "${sort}" does not warn that a small-sample percentage is noise`);
    }
  }
  await admin.page.selectOption('#qh-sort', 'flags').catch(() => {});
  await admin.page.waitForTimeout(900);

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
  // 5a. QUESTION HEALTH ON A COMPUTER
  //
  // Same measurement as the Question Bank, because the two panels now share a
  // shape deliberately: two data panels on one page that read differently is a
  // page you have to re-learn every time you switch.
  //
  // Its three controls used to stack one above another, each the width of the
  // work area with its text CENTRED, and the alternates box held two words in
  // a box as wide as the monitor. Measured while a row is OPEN, since the
  // editor is what the cap is about.
  // ============================================================
  heading('question health on a computer');
  const qhDesktop = await admin.page.evaluate(() => {
    const round = n => Math.round(n);
    const controls = document.querySelector('#panel-health .admin-qh__controls');
    const edit = document.querySelector('#panel-health .qh-edit');
    const body = document.getElementById('panel-health');
    const visible = el => el && el.offsetParent !== null;
    return {
      controlCount: controls ? controls.children.length : 0,
      controlLines: controls ? new Set([...controls.children]
        .map(el => round(el.getBoundingClientRect().y))).size : -1,
      centred: controls ? [...controls.children]
        .filter(el => getComputedStyle(el).textAlign === 'center').length : -1,
      editWidth: edit && visible(edit) ? round(edit.getBoundingClientRect().width) : -1,
      bodyWidth: body ? round(body.getBoundingClientRect().width) : -1,
    };
  }).catch(() => null);

  if (!qhDesktop) {
    problems.push('could not measure the question health layout at all');
  } else {
    note(`controls: ${qhDesktop.controlCount} on ${qhDesktop.controlLines} line(s), ${qhDesktop.centred} centred`);
    note(`editor ${qhDesktop.editWidth}px inside a ${qhDesktop.bodyWidth}px panel`);
    if (qhDesktop.controlCount > 0 && qhDesktop.controlLines !== 1) {
      problems.push(`the sort, direction and search controls sit on ${qhDesktop.controlLines} lines — three controls fit on one at this width`);
    }
    // `.input` centres its text, which is right for a four-letter room code and
    // wrong for a menu you are reading down.
    if (qhDesktop.centred > 0) {
      problems.push(`${qhDesktop.centred} of the health controls still centre their text, which is the phone's room-code styling`);
    }
    if (qhDesktop.editWidth <= 0) {
      problems.push('no question was open, so nothing about the editor was measured');
    } else if (qhDesktop.editWidth >= qhDesktop.bodyWidth) {
      problems.push(`the answer editor fills its ${qhDesktop.bodyWidth}px panel — it is not capped, so a two-word alternate sits in a box as wide as the monitor`);
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

  // ---- ending a stuck room actually ends it ------------------------------
  //
  // This button was a plain DELETE on `rooms`, which migration 048 revoked, so
  // it returned no error, deleted nothing, and redrew the dashboard as though
  // the room had ended. Nothing here had ever pressed it. It is tap-to-arm,
  // like every destructive control on this page.
  heading('ending a stuck room');
  await admin.page.locator('[data-drill="games"]').click().catch(() => {});
  await admin.page.waitForTimeout(1200);
  const endBtn = admin.page.locator('#stat-drill-body [data-end-room]').first();
  if (!await endBtn.isVisible().catch(() => false)) {
    problems.push('no way to end a room from the games list');
  } else {
    const roomId = await endBtn.getAttribute('data-end-room');
    const before = table.store.table('rooms').length;
    await endBtn.click().catch(() => {});          // arms
    await admin.page.waitForTimeout(300);
    await endBtn.click().catch(() => {});          // confirms
    await admin.page.waitForTimeout(1500);
    const stillThere = table.store.table('rooms').some(r => String(r.id) === String(roomId));
    const label = (await endBtn.textContent().catch(() => '') || '').trim();
    note(`rooms ${before} -> ${table.store.table('rooms').length}; button now "${label}"`);
    if (stillThere) {
      problems.push('the admin ended a room and the room is still running');
    }
  }

  // ---- Clear 7d+ says what it actually did -------------------------------
  //
  // It was a bare delete whose result was thrown away, followed by a redraw:
  // an RLS refusal returns no error and removes nothing, so a denied clear and
  // a successful one looked identical. Nothing had ever pressed it.
  //
  // BOTH HALVES ARE CHECKED, because either alone passes on a broken button.
  // The recent entry must survive (a Clear that wiped everything would pass a
  // check that only counted removals), and the outcome must be REPORTED (the
  // silent version deletes correctly and still tells the admin nothing, which
  // is the fault being fixed).
  heading('clearing old error logs');
  await admin.page.locator('[data-panel="errors"]').click().catch(() => {});
  await admin.page.waitForTimeout(800);
  const clearBtn = admin.page.locator('#btn-clear-old-errors');
  if (!await clearBtn.isVisible().catch(() => false)) {
    problems.push('the error log panel has no Clear button');
  } else {
    // THE REFUSAL FIRST, because that is the bug. denyWrites reproduces exactly
    // what a missing migration-019 policy does: the count still reads (admins
    // can SELECT), the delete removes nothing, and no error comes back.
    table.store.denyWrites('error_logs');
    await clearBtn.click().catch(() => {});
    await admin.page.waitForTimeout(1500);
    const refusedSaid = (await admin.page.locator('#error-clear-status').textContent().catch(() => '') || '').trim();
    const survived = table.store.table('error_logs').length;
    note(`refused clear: ${survived} entries left; screen says "${refusedSaid}"`);
    if (survived !== 2) {
      problems.push(`a refused clear removed ${2 - survived} entries — denyWrites should have stopped all of them`);
    }
    if (!/permission denied/i.test(refusedSaid)) {
      problems.push(`the clear was refused and the screen said "${refusedSaid || '(nothing)'}" — an admin cannot tell a denied clear from a done one`);
    }

    // ...then the same button working, which is the half a refusal-only check
    // would pass while the feature was completely broken.
    table.store.allowWrites('error_logs');
    await clearBtn.click().catch(() => {});
    await admin.page.waitForTimeout(1500);
    const left = table.store.table('error_logs');
    const said = (await admin.page.locator('#error-clear-status').textContent().catch(() => '') || '').trim();
    note(`error_logs left: ${left.length} (${left.map(l => l.message).join(', ') || 'none'}); screen says "${said}"`);
    if (left.some(l => l.message === 'ancient failure')) {
      problems.push('Clear 7d+ left the 30-day-old entry behind');
    }
    if (!left.some(l => l.message === 'from an hour ago')) {
      problems.push('Clear 7d+ deleted an entry from an hour ago — it should only take 7d+');
    }
    if (!said) {
      problems.push('Clear 7d+ deleted entries and told the admin nothing — a refusal would have looked exactly the same');
    }
  }


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

  // A reported host, so the Flagged Hosts panel has something to render. An
  // empty panel opens just as happily as a working one, so seeding it is what
  // makes "opened and stayed blank" a distinguishable outcome.
  table.store.seed('host_ratings', [
    { id: 'hr1', host_user_id: 'host-user-1', room_id: 'r-old', voter_id: 'device:a',
      voter_name: 'Bob', rating: -1, flag_reason: 'unfair_judging',
      flag_note: 'marked me wrong twice', created_at: new Date().toISOString() },
    { id: 'hr2', host_user_id: 'host-user-1', room_id: 'r-old2', voter_id: 'device:b',
      voter_name: 'Carol', rating: -1, flag_reason: 'ended_early',
      flag_note: null, created_at: new Date().toISOString() },
  ]);
  table.store.seed('profiles', [
    { user_id: 'host-user-1', display_name: 'Hosty', discriminator: '0007' },
  ]);

  // ============================================================
  // EVERY PANEL OPENS
  //
  // Each section is fetched the first time it is opened, so every section is a
  // code path that now runs at a moment nothing used to run at.
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

  for (const key of ['flagged', 'hosts', 'health', 'questions', 'games', 'errors', 'chat', 'announcement', 'flags', 'titlewords']) {
    await admin.page.click(`.admin-panel__head[data-panel="${key}"]`).catch(() => {});
    await admin.page.waitForTimeout(800);

    const state = await admin.page.evaluate(k => {
      const body = document.getElementById(`panel-${k}`);
      const heads = [...document.querySelectorAll('.admin-panel__head')];
      return {
        expanded: heads.find(h => h.dataset.panel === k)?.getAttribute('aria-expanded'),
        hidden: body ? body.hidden : null,
        error: (body?.querySelector('.admin-panel__error')?.textContent || '').trim(),
        stillLoading: /Loading\.\.\.|Counting the bank/.test(body?.textContent || ''),
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

  // ---- Title Words says what is missing --------------------------------
  //
  // The owner has ~106 words to write and no way to know WHICH. Targets are
  // frozen once set, so nothing else would ever say a growing bank has made a
  // topic newly eligible. "It opened" is not "it works": a loader rendering an
  // empty box opens exactly as happily as one showing the list.
  heading('title words');
  await admin.page.click('.admin-panel__head[data-panel="titlewords"]').catch(() => {});
  await admin.page.waitForTimeout(2500);
  const tw = await admin.page.evaluate(() => {
    const body = document.getElementById('panel-titlewords');
    const slots = [...(body?.querySelectorAll('.tw-slot') || [])];
    return {
      subjects: body?.querySelectorAll('.tw-subject').length || 0,
      slots: slots.length,
      empty: slots.filter(s => s.classList.contains('tw-slot--empty')).length,
      written: slots.filter(s => !s.classList.contains('tw-slot--empty')
                              && !s.classList.contains('tw-slot--none')).length,
      targets: slots.filter(s => /\d+ right/.test(s.textContent || '')).length,
      chip: (document.querySelector('[data-count="titlewords"]')?.textContent || '').trim(),
    };
  }).catch(e => ({ err: String(e).slice(0, 90) }));
  note(`title words: ${JSON.stringify(tw)}`);

  if (tw.subjects !== 12) problems.push(`Title Words listed ${tw.subjects} subjects, expected all 12`);
  // BOTH HALVES. Only-empty would pass if it never found the words that exist;
  // only-written would pass if it never showed a gap — and the gaps are the
  // entire reason the panel exists.
  if (!tw.empty) problems.push('Title Words shows no missing words — the owner cannot tell what to write');
  if (!tw.written) problems.push('Title Words found none of the words that already exist');
  if (!tw.targets) problems.push('Title Words shows no targets — no way to know what a word would require');
  if (!/^\d+ written$/.test(tw.chip || '')) problems.push(`the Title Words chip reads "${tw.chip}", expected "N written"`);

  // AND THE PANEL ACTUALLY SHOWS THE REPORT. "It opened" is not "it works" —
  // a loader that renders nothing opens exactly as happily as one that renders
  // the thing an admin came to read. A flag that reaches nowhere is theatre.
  await admin.page.click('.admin-panel__head[data-panel="hosts"]').catch(() => {});
  await admin.page.waitForTimeout(1200);
  const hostsText = ((await admin.page.textContent('#flagged-hosts').catch(() => '')) || '')
    .replace(/\s+/g, ' ').trim();
  note(`flagged hosts panel: ${hostsText.slice(0, 120)}`);
  if (!hostsText.includes('Hosty')) {
    problems.push(`the flagged-hosts panel does not name the reported host: ${hostsText.slice(0, 90)}`);
  }
  if (!/unfair judging/.test(hostsText)) {
    problems.push('the flagged-hosts panel does not say WHY the host was reported');
  }
  if (!hostsText.includes('marked me wrong twice')) {
    problems.push('a note somebody typed against a report is not shown, so the report says something is wrong with no way to find out what');
  }
  const hostsCount = ((await admin.page.textContent('[data-count="hosts"]').catch(() => '')) || '').trim();
  note(`flagged hosts count chip: ${JSON.stringify(hostsCount)}`);
  if (hostsCount === '0' || /None/i.test(hostsCount)) {
    problems.push(`the flagged-hosts count reads ${JSON.stringify(hostsCount)} with two reports stored`);
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

  // ============================================================
  // REVIEWING ANSWER KEYS
  //
  // The same rules the CI probe runs, in the browser. What matters is that
  // the list is SHORT and RIGHT: a review list that flags ordinary answers is
  // one nobody reads twice, so the control — a question whose alternate has
  // already been added — matters as much as the hit.
  // ============================================================
  heading('reviewing answer keys');
  await admin.page.click('#btn-review-answers').catch(() => {});
  await admin.page.waitForTimeout(1500);

  const reviewSummary = (await admin.page.textContent('#q-review-summary').catch(() => '')) || '';
  note(`review says: ${reviewSummary.replace(/\s+/g, ' ').trim().slice(0, 130)}`);

  const reviewed = await admin.page.evaluate(() =>
    [...document.querySelectorAll('#question-results .admin-q-row')].map(r => ({
      qid: r.dataset.qid,
      note: (r.querySelector('.admin-review__note')?.textContent || '').trim(),
    }))).catch(() => []);
  note(`flagged: ${JSON.stringify(reviewed.map(r => r.qid))}`);

  if (!reviewed.some(r => r.qid === 'q-unit')) {
    problems.push('the answer-key review did not flag "1,776 ft", where a player writing "feet" is marked wrong');
  }
  if (reviewed.some(r => r.qid === 'q-unit-ok')) {
    problems.push('the review flagged a question that already has an alternate — nagging about work already done is how a review list stops being read');
  }
  if (reviewed.some(r => /^q\d+$/.test(r.qid || ''))) {
    problems.push('the review flagged an ordinary answer like "Answer 1", so the list is noise');
  }
  const withNote = reviewed.filter(r => r.note.length > 20).length;
  if (reviewed.length > 0 && withNote !== reviewed.length) {
    problems.push(`${reviewed.length - withNote} flagged row(s) do not say what to do about it`);
  }
  if (!/candidates, not mistakes/i.test(reviewSummary)) {
    problems.push('the review does not say these are candidates rather than mistakes');
  }

  // ============================================================
  // THE QUESTION BANK IS A TABLE AND A FORM, NOT ONE STRETCHED COLUMN
  //
  // The desktop shell moved this panel into a work area four times as wide as
  // a phone and it went on rendering the phone layout: an answer field the
  // width of a monitor holding two words, a Search button that wrapped onto a
  // line of its own, and results that read as a stack of paragraphs instead of
  // something an eye can run down while looking for a misfiled question.
  //
  // Measured rather than eyeballed. Reverting the desktop rules fails the
  // column, cap and side-by-side checks by name. THE WRAP CHECK DOES NOT FIRE
  // ON THAT REVERT and is not claimed to: the row wrapped during an
  // intermediate version of this work, not in the layout that shipped before
  // it. It is a forward guard against the next control that grows, and it is
  // labelled as one rather than counted as proof.
  // ============================================================
  heading('the question bank on a computer');
  // The answer-key review leaves ONE row on screen, and one row can never show
  // that columns line up. Search the bank again for a full list.
  await admin.page.fill('#q-search', '').catch(() => {});
  await admin.page.click('#btn-search-questions').catch(() => {});
  await admin.page.waitForTimeout(1200);
  // Every editor is closed on a fresh list, and a `display:none` element
  // measures zero — which would make the width cap pass on a build that has no
  // cap at all. Open one first.
  await admin.page.locator('#question-results .admin-q-row__summary').first()
    .click().catch(() => {});
  await admin.page.waitForTimeout(400);
  const qbank = await admin.page.evaluate(() => {
    const round = n => Math.round(n);
    const filters = document.querySelector('#panel-questions .admin-filters');
    const rows = [...document.querySelectorAll('#panel-questions .admin-q-row__summary')];
    const edit = document.querySelector('#panel-questions .admin-q-row__edit');
    const body = document.getElementById('panel-questions');
    const fieldX = sel => {
      const el = edit?.querySelector(sel);
      const label = el?.closest('label');
      if (!label) return null;
      const b = label.getBoundingClientRect();
      return { x: round(b.x), y: round(b.y), w: round(b.width) };
    };
    return {
      filterLines: filters ? new Set([...filters.children]
        .map(el => round(el.getBoundingClientRect().y))).size : -1,
      filterKids: filters ? filters.children.length : 0,
      metaColumns: rows.map(r => [...r.querySelectorAll('.admin-q-row__meta span')]
        .map(sp => round(sp.getBoundingClientRect().x)).join('|')),
      rowCount: rows.length,
      editWidth: edit ? round(edit.getBoundingClientRect().width) : -1,
      // The PANEL BODY, not the work area. A first version compared against
      // `.admin-work`, whose clientWidth includes its padding — so an entirely
      // uncapped editor measured 932 inside 1012 and the check passed on the
      // build it was written to catch.
      bodyWidth: body ? round(body.getBoundingClientRect().width) : -1,
      answer: fieldX('.admin-q-edit__answer'),
      alts: fieldX('.admin-q-edit__alts'),
    };
  }).catch(() => null);

  if (!qbank) {
    problems.push('could not measure the question bank layout at all');
  } else {
    note(`filters: ${qbank.filterKids} controls on ${qbank.filterLines} line(s)`);
    note(`result rows: ${qbank.rowCount}; meta columns: ${JSON.stringify([...new Set(qbank.metaColumns)])}`);
    note(`editor ${qbank.editWidth}px inside a ${qbank.bodyWidth}px panel`);

    if (qbank.filterKids > 0 && qbank.filterLines !== 1) {
      problems.push(`the search row wrapped onto ${qbank.filterLines} lines — a search box, two menus and a button fit on one at this width`);
    }
    // `display: contents` promotes the meta spans to grid items, so every row
    // puts category, format and difficulty at the same x. Without it each row
    // clusters them under its own question and the list stops being scannable.
    const distinct = new Set(qbank.metaColumns.filter(Boolean));
    if (qbank.rowCount < 2) {
      problems.push('fewer than two result rows on screen, so column alignment was never tested');
    } else if (distinct.size !== 1) {
      problems.push(`the result rows do not share their columns — ${distinct.size} different layouts across ${qbank.rowCount} rows: ${JSON.stringify([...distinct])}`);
    }
    // An input is only as readable as it is long. The cap is what stops a
    // two-word answer sitting in a box the width of the monitor.
    if (qbank.editWidth <= 0) {
      problems.push('no editor was open, so nothing about the form was measured');
    } else if (qbank.editWidth >= qbank.bodyWidth) {
      problems.push(`the editor fills its ${qbank.bodyWidth}px panel — it is not capped, so every field is as wide as the monitor allows`);
    }
    // Answer and Alternates belong side by side; if the `:has()` placement is
    // gone they stack and the form is the phone's single column again.
    if (!qbank.answer || !qbank.alts) {
      problems.push('the editor has no Answer / Alternates fields to measure');
    } else if (qbank.answer.y !== qbank.alts.y) {
      problems.push('Answer and Alternates are on separate lines — the editor is still one stretched column');
    }
  }

  // ============================================================
  // THE CHAT ARCHIVE ON A COMPUTER
  //
  // The last `data-desktop-only` panel, and it is two shapes: a room LIST you
  // scan and a transcript you READ. Measured before any CSS was written, at
  // 1280px, both were wrong in the way this page keeps being wrong —
  //
  //   * the four meta spans sat at THREE different sets of x positions across
  //     three rooms, because they are inline spans that follow whatever the
  //     name before them happened to need;
  //   * a message ran the full 932px panel, and the speaker name column had a
  //     `min-width` that names grew past — so the message TEXT began at 428,
  //     398 and 427 on consecutive lines.
  //
  // BOTH HALVES ARE CHECKED. Asserting only the cap passes on a build whose
  // transcript is a ragged pile inside a narrow box, and asserting only the
  // alignment passes on one that reads across the whole monitor.
  // ============================================================
  heading('the chat archive on a computer');
  await admin.page.click('.admin-panel__head[data-panel="chat"]').catch(() => {});
  await admin.page.waitForTimeout(600);
  // Every transcript is closed on arrival and a `display:none` element
  // measures zero, which would make the width cap pass on a build that has no
  // cap at all. Open the first room.
  await admin.page.locator('#chat-archive .admin-chat-summary').first()
    .click().catch(() => {});
  await admin.page.waitForTimeout(400);

  const chat = await admin.page.evaluate(() => {
    const round = n => Math.round(n);
    const rooms = [...document.querySelectorAll('#chat-archive .admin-chat-summary')];
    const open = [...document.querySelectorAll('#chat-archive .admin-chat-messages')]
      .find(el => el.offsetParent !== null);
    const body = document.getElementById('panel-chat');
    return {
      roomCount: rooms.length,
      metaColumns: rooms.map(r => [...r.querySelectorAll('.admin-q-row__meta span')]
        .map(sp => round(sp.getBoundingClientRect().x)).join('|')),
      metaCounts: rooms.map(r => r.querySelectorAll('.admin-q-row__meta span').length),
      transcriptWidth: open ? round(open.getBoundingClientRect().width) : -1,
      bodyWidth: body ? round(body.getBoundingClientRect().width) : -1,
      textX: open ? [...open.querySelectorAll('.admin-chat-msg__text')]
        .map(t => round(t.getBoundingClientRect().x)) : [],
      msgCount: open ? open.querySelectorAll('.admin-chat-msg').length : 0,
    };
  }).catch(() => null);

  if (!chat) {
    problems.push('could not measure the chat archive layout at all');
  } else {
    note(`rooms: ${chat.roomCount}, meta spans per row: ${JSON.stringify(chat.metaCounts)}`);
    note(`meta columns: ${JSON.stringify([...new Set(chat.metaColumns)])}`);
    note(`transcript ${chat.transcriptWidth}px inside a ${chat.bodyWidth}px panel, ${chat.msgCount} messages`);
    note(`message text starts at: ${JSON.stringify([...new Set(chat.textX)])}`);

    if (chat.roomCount < 2) {
      problems.push('fewer than two archived rooms on screen, so column alignment was never tested');
    } else {
      // A column that only exists on some rows is not a column, it is a shove:
      // a room archived without a host name would otherwise put its date under
      // another room's message count.
      const counts = new Set(chat.metaCounts);
      if (counts.size !== 1) {
        problems.push(`archived rooms emit different numbers of meta spans (${JSON.stringify([...counts])}) — a row missing a host shifts every column after it`);
      }
      const distinct = new Set(chat.metaColumns.filter(Boolean));
      if (distinct.size !== 1) {
        problems.push(`the room rows do not share their columns — ${distinct.size} different layouts across ${chat.roomCount} rooms: ${JSON.stringify([...distinct])}`);
      }
    }
    // A LINE OF CHAT IS NOT A LINE OF DATA. Uncapped, a message runs the whole
    // panel and the eye loses its place returning to the next one.
    if (chat.transcriptWidth <= 0) {
      problems.push('no transcript was open, so nothing about the messages was measured');
    } else if (chat.transcriptWidth >= chat.bodyWidth) {
      problems.push(`the transcript fills its ${chat.bodyWidth}px panel — it is not capped, so every message is a line the width of the monitor`);
    }
    // The grid has to be on the TRANSCRIPT, not on each message: a grid aligns
    // columns only within one container, so a grid per row lines each row up
    // with itself and nothing else.
    if (chat.msgCount < 3) {
      problems.push(`only ${chat.msgCount} messages in the open transcript, so the ragged left edge could not have been seen`);
    } else if (new Set(chat.textX).size !== 1) {
      problems.push(`the messages do not share a left edge — text begins at ${JSON.stringify([...new Set(chat.textX)])}, so the speaker column is sized per row instead of across the transcript`);
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

  // ============================================================
  // DELETING SOMEBODY'S ACCOUNT
  //
  // The most dangerous button on the page, and nothing had ever pressed it —
  // the existing check only confirmed which rows OFFER it. That is the shape
  // that let the End Room button ship dead for months.
  //
  // admin_delete_account takes a user id, so it carries three guards: the
  // caller must be an admin, it refuses to delete the caller, and it refuses to
  // delete another admin. They RAISE rather than return quietly, which is what
  // turns a refusal into something the page can show.
  // ============================================================
  heading('deleting an account');
  {
    await admin.page.locator('[data-drill="accounts"]').click().catch(() => {});
    await admin.page.waitForTimeout(1200);

    const victim = table.store.table('profiles').find(p => !p.is_admin);
    const delBtn = admin.page.locator(`#stat-drill-body [data-del-account="${victim?.user_id}"]`).first();
    if (!victim || !await delBtn.isVisible().catch(() => false)) {
      problems.push('no non-admin account offered a Delete button to press');
    } else {
      // Tap-to-arm, like every destructive control here.
      await delBtn.click().catch(() => {});
      await admin.page.waitForTimeout(300);
      await delBtn.click().catch(() => {});
      await admin.page.waitForTimeout(1800);

      const stillThere = table.store.table('profiles')
        .some(p => String(p.user_id) === String(victim.user_id));
      note(`the account is gone: ${!stillThere}`);
      if (stillThere) problems.push('the admin deleted an account and the account is still there');

      const adminStillThere = table.store.table('profiles').some(p => p.is_admin);
      if (!adminStillThere) problems.push('deleting an account took the admin with it');
    }
  }

  // ============================================================
  // TITLE WORDS — the owner writes the collection from here
  //
  // This panel is the only screen anywhere that shows a slot with NO word, and
  // that is its whole job: targets are frozen when a word is saved, so nothing
  // else would ever say that a topic has grown big enough to carry a tier it
  // could not offer before. Without it the collection silently stops growing.
  //
  // "It opened" is not "it works" — the same lesson as the eight panels above
  // and the Flagged Hosts loader. So this types a word, presses Save, and reads
  // the database.
  // ============================================================
  heading('writing a title word');
  {
    await openPanel('titlewords');
    // Counting the whole bank per topic, so give it room.
    await admin.page.waitForTimeout(2500);

    const slots = await admin.page.locator('#title-words .tw-slot').count().catch(() => 0);
    note(`slots offered: ${slots}`);
    if (slots === 0) {
      problems.push('the title words panel opened and offered no slots at all to write into');
    }

    const editable = admin.page.locator('#title-words .tw-slot:has(.tw-slot__save)').first();
    if (!await editable.count().catch(() => 0)) {
      problems.push('no slot on the title words panel could be written into');
    } else {
      const where = await editable.evaluate(el => ({
        cat: el.dataset.cat, sub: el.dataset.sub || null,
        tier: el.dataset.tier, target: Number(el.dataset.target),
      }));
      note(`writing into ${where.cat}/${where.sub || '(subject)'} ${where.tier}, target ${where.target}`);

      // THE TARGET MUST BE A REAL NUMBER, or the word is saved against nothing
      // and no player can ever earn it — the unearnable-slot promise this
      // system exists to never make.
      if (!Number.isFinite(where.target) || where.target < 1) {
        problems.push(`a writable slot carries no target (${where.target}) — a word saved there could never be earned`);
      }

      // --- THE REFUSAL FIRST, because that is the bug this page keeps having.
      // An RLS refusal returns no error and zero rows, and this page has three
      // times rendered that as "Saved!". denyWrites reproduces it exactly.
      table.store.denyWrites('title_words');
      await editable.locator('.tw-slot__input').fill('Refused');
      await editable.locator('.tw-slot__save').click().catch(() => {});
      await admin.page.waitForTimeout(1200);

      const refusedRows = table.store.table('title_words').length;
      const said = (await admin.page.textContent('#title-words').catch(() => '')) || '';
      note(`after a refused save: ${refusedRows} rows, screen says permission denied: ${/permission denied|not saved/i.test(said)}`);
      if (refusedRows !== 0) {
        problems.push('denyWrites did not stop the write — this check cannot prove anything');
      } else if (!/not saved/i.test(said)) {
        problems.push('a refused title word save told the admin nothing — the word is not saved and the screen does not say so');
      }
      table.store.allowWrites('title_words');

      // --- NOW THE REAL ONE, WITH BOTH COSTS OF A SAVE MEASURED: how far it
      // moves the reader, and how much of the bank it re-counts. Neither is
      // visible from the screen and the feature works perfectly either way,
      // which is exactly why they need counting.
      // AND THE READER MUST NOT BE THROWN BACK TO THE TOP. The panel is
      // thousands of pixels long and the redraw replaces all of it, so without
      // restoring the position somebody writing the ~86 outstanding words
      // loses their place after every single one.
      //
      // THE FIRST VERSION OF THIS MEASURED ITS OWN ARTIFACT. It scrolled the
      // page deliberately, then read the position — but Playwright scrolls an
      // element into view before typing into it or clicking it, so by the time
      // Save was pressed the page had moved back to wherever that row was. It
      // reported a 3475px jump that no person could ever experience.
      //
      // So: pick a row DEEP in the panel, let the fill scroll to it, and read
      // the position that the click will actually happen from.
      // ASK WHICH ELEMENT IS SCROLLING, do not name one. This read
      // `.screen--scrollable` and reported 0px the moment the desktop shell
      // shipped — because there the page does not scroll and `.admin-work`
      // does. It found a real bug doing so: the scroll-restore in admin.js
      // named the same class and was silently dead on the new layout.
      const readScroll = () => admin.page.evaluate(() => {
        const box = document.getElementById('title-words');
        for (let n = box; n && n !== document.body; n = n.parentElement) {
          const oy = getComputedStyle(n).overflowY;
          if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n.scrollTop;
        }
        return document.scrollingElement ? document.scrollingElement.scrollTop : 0;
      });

      const again = admin.page.locator('#title-words .tw-slot:has(.tw-slot__save)').last();
      const deep = await again.evaluate(el => ({
        cat: el.dataset.cat, sub: el.dataset.sub || null,
        tier: el.dataset.tier, target: Number(el.dataset.target),
      }));
      note(`deep slot: ${JSON.stringify(deep)}`);
      await again.locator('.tw-slot__input').fill('Starbound');
      const savedFrom = await readScroll();
      if (savedFrom < 200) {
        problems.push(`the save happened at ${savedFrom}px, too near the top to tell whether the redraw moves the reader`);
      }

      const countsBefore2 = table.store.countsTaken || 0;
      await again.locator('.tw-slot__save').click().catch(() => {});
      await admin.page.waitForTimeout(2500);

      note(`row said: ${JSON.stringify((await again.textContent().catch(() => '')) || '')}`);
      const restedAt = await readScroll();
      note(`scroll: saved from ${savedFrom}px, left at ${restedAt}px`);
      if (savedFrom >= 200 && Math.abs(restedAt - savedFrom) > 300) {
        problems.push(`saving a word moved the reader from ${savedFrom}px to ${restedAt}px — writing 86 words means losing your place 86 times`);
      }

      const rows = table.store.table('title_words');
      const saved = rows.find(r => r.word === 'Starbound');
      note(`saved row: ${saved ? JSON.stringify({ cat: saved.category, sub: saved.subcategory, tier: saved.tier, target: saved.target_right }) : 'NONE'}`);
      if (!saved) {
        problems.push('the admin typed a title word, pressed Save, and nothing was written');
      } else {
        if (Number(saved.target_right) !== deep.target) {
          problems.push(`the word was saved against target ${saved.target_right}, not the ${deep.target} the slot asks for`);
        }
        if (String(saved.category) !== String(deep.cat) || String(saved.tier) !== String(deep.tier)) {
          problems.push('the word was saved against a different slot from the one it was typed into');
        }
      }
      if (rows.length !== 1) {
        problems.push(`writing one word left ${rows.length} rows — the same slot must never hold two`);
      }

      const countsAfterSave = table.store.countsTaken || 0;
      note(`question counts taken by one save: ${countsAfterSave - countsBefore2}`);
      if (countsAfterSave - countsBefore2 > 5) {
        problems.push(`saving one word re-counted the bank ${countsAfterSave - countsBefore2} times — writing 86 words would take thousands of queries`);
      }

      // --- FILLING THE EMPTY SLOTS WITH PLACEHOLDERS.
      //
      // The owner's call, reversing their own "no placeholders" rule. The
      // reasoning that rule rested on was that a player must never hit a
      // requirement and receive NOTHING — and a placeholder is not nothing, so
      // it does not apply. What it buys is a visible framework: eleven of
      // twelve subjects were showing almost no slots at all.
      const emptyBefore = await admin.page.locator('#title-words .tw-slot--empty').count().catch(() => 0);
      const fillBtn = admin.page.locator('#tw-fill');
      if (!await fillBtn.count().catch(() => 0)) {
        problems.push('no control to fill the empty slots — 86 of them means a per-row button would never be used');
      } else {
        await fillBtn.click().catch(() => {});
        await admin.page.waitForTimeout(6000);

        const rows = table.store.table('title_words');
        const placeholders = rows.filter(r => r.is_placeholder);
        note(`empty slots before: ${emptyBefore}; placeholder rows written: ${placeholders.length}`);
        if (placeholders.length === 0) {
          problems.push('the fill button wrote no placeholders at all');
        }
        // EVERY ONE MUST BE EARNABLE. A row saved without a real target is a
        // slot nobody can ever reach, which is the exact promise this system
        // must never make.
        const unearnable = placeholders.filter(r => !(Number(r.target_right) >= 1));
        if (unearnable.length) {
          problems.push(`${unearnable.length} placeholder(s) were saved with no usable target — nobody could ever earn them`);
        }
        // AND THE TEXT IS GENERATED, NOT INVENTED.
        const odd = placeholders.filter(r => !/^(Common|Uncommon|Rare|Epic|Legendary|Mythic)\b/.test(r.word || ''));
        if (odd.length) {
          problems.push(`${odd.length} placeholder(s) do not follow the tier-plus-subject rule, e.g. ${JSON.stringify(odd[0].word)}`);
        }
        const tooLong = placeholders.filter(r => (r.word || '').length > 24);
        if (tooLong.length) {
          problems.push(`${tooLong.length} placeholder(s) exceed the 24-character limit and would be refused live`);
        }
        note(`sample placeholders: ${placeholders.slice(0, 3).map(r => r.word).join(', ')}`);

        // TYPING OVER ONE MAKES IT THE OWNER'S WORD, or the count would go on
        // claiming there is work left on a slot that is finished.
        const ph = admin.page.locator('#title-words .tw-slot--placeholder').first();
        if (await ph.count().catch(() => 0)) {
          const where = await ph.evaluate(el => ({ cat: el.dataset.cat, sub: el.dataset.sub || null, tier: el.dataset.tier }));
          await ph.locator('.tw-slot__input').fill('Written');
          await ph.locator('.tw-slot__save').click().catch(() => {});
          await admin.page.waitForTimeout(2500);
          const row = table.store.table('title_words').find(r =>
            String(r.category) === String(where.cat) && String(r.tier) === String(where.tier)
            && String(r.subcategory || '') === String(where.sub || ''));
          note(`after typing over a placeholder: ${JSON.stringify({ word: row?.word, placeholder: row?.is_placeholder })}`);
          if (row?.is_placeholder) {
            problems.push('typing over a placeholder left it flagged as one — the "still to write" count would never reach zero');
          }
        }
      }

      // --- AND IT REACHES A PLAYER. A word written on this page that never
      // appears in anybody's collection is the whole feature failing quietly.
      const seen = await admin.page.evaluate(async () => {
        const mod = await import('/js/titles.js');
        const content = await import('/js/title-content.js');
        content.resetTitleWordCache();
        mod.clearWordOverlay();
        await content.loadTitleWords();
        return Object.values(mod.TITLE_WORDS).some(w => w.word === 'Starbound');
      }).catch(err => `threw: ${err.message}`);
      note(`a player's collection now contains it: ${seen}`);
      if (seen !== true) {
        problems.push(`a saved title word never reached the collection players read (${seen})`);
      }
    }
  }

  // ============================================================
  // WRITING A SUBJECT IN ONE SITTING
  //
  // There are ~86 words to write. One box, one Save, one full redraw, eighty-six
  // times is a chore that never gets finished — and the redraw is what made
  // typing ahead unsafe: it rebuilds from the database, so words typed into
  // other boxes were silently destroyed by saving any one of them.
  //
  // Three things make it a sitting rather than a chore, and the third is the one
  // that was actively losing work:
  //   1. Enter goes to the next word box (Tab lands on Save and Remove)
  //   2. one "Save N words" per subject, not per row
  //   3. an unsaved box SURVIVES the redraw that a save triggers
  // ============================================================
  heading('writing a subject in one sitting');
  {
    const boxes = admin.page.locator('.tw-slot__input');
    if (await boxes.count() === 0) {
      problems.push('the Title Words panel offers no word boxes at all, so none of this could be measured');
    } else {
      // Enter walks the WHOLE panel, so a fixed number of boxes runs off the end
      // of one subject into the next — which is what the first version of this
      // check did, and it read as the app losing a word.
      const subjectCount = await admin.page.locator('.tw-subject').count();
      let target = -1;
      let targetBoxes = 0;
      for (let i = 0; i < subjectCount; i++) {
        const n = await admin.page.locator('.tw-subject').nth(i).locator('.tw-slot__input').count();
        if (n >= 2) { target = i; targetBoxes = n; break; }
      }
      if (target === -1) {
        problems.push('no subject offers two word boxes, so typing across one cannot be measured');
      } else {
        const subject = admin.page.locator('.tw-subject').nth(target);
        const words = ['Alpha', 'Beta', 'Gamma'].slice(0, targetBoxes);
        note(`subject ${target} has ${targetBoxes} boxes; typing ${words.length}`);

        // FILL, not type: an earlier section of this scenario leaves a word in
        // one of these boxes, and typing after a click put the new text in the
        // MIDDLE of it ("RefuAlphased"). Select-all then type is what a person
        // does; fill is its equivalent here.
        await subject.locator('.tw-slot__input').nth(0).click();
        await subject.locator('.tw-slot__input').nth(0).fill(words[0]);
        await admin.page.keyboard.press('Enter');
        const focused = await admin.page.evaluate(() =>
          [...document.querySelectorAll('.tw-slot__input')].indexOf(document.activeElement));
        const wanted = await admin.page.evaluate(t => {
          const all = [...document.querySelectorAll('.tw-slot__input')];
          const mine = [...document.querySelectorAll('.tw-subject')[t].querySelectorAll('.tw-slot__input')];
          return all.indexOf(mine[1]);
        }, target);
        note(`Enter moved focus to box ${focused} (next is ${wanted})`);
        if (focused !== wanted) {
          problems.push(`Enter did not move to the next word box — writing a subject means reaching for the pointer on every line (focus went to ${focused}, wanted ${wanted})`);
        }

        for (let i = 1; i < words.length; i++) {
          await admin.page.keyboard.type(words[i]);
          if (i < words.length - 1) await admin.page.keyboard.press('Enter');
        }
        await admin.page.waitForTimeout(400);

        const saveBtn = subject.locator('.tw-subject__save');
        const label = ((await saveBtn.textContent().catch(() => '')) || '').trim();
        const dirty = await subject.locator('.tw-slot--dirty').count();
        note(`subject Save says ${JSON.stringify(label)}; ${dirty} rows marked unsaved`);
        if (!await saveBtn.isVisible().catch(() => false)) {
          problems.push('no per-subject Save button appeared after typing, so every word still needs its own tap');
        }
        if (dirty !== words.length) {
          problems.push(`${words.length} boxes were typed into but ${dirty} rows are marked unsaved — the owner cannot tell what is still to save`);
        }

        // TYPE AHEAD IN ANOTHER SUBJECT, then save this one. The redraw that
        // follows a save used to wipe it.
        const otherIdx = target === 0 ? 1 : 0;
        const otherBox = admin.page.locator('.tw-subject').nth(otherIdx).locator('.tw-slot__input').first();
        const hasOther = await otherBox.count() > 0;
        if (hasOther) await otherBox.fill('Elsewhere');
        await admin.page.waitForTimeout(200);

        await saveBtn.click();
        await admin.page.waitForTimeout(4000);

        const stored = table.store.table('title_words').map(w => w.word);
        note(`words now in the database: ${JSON.stringify(stored.slice().sort())}`);
        for (const w of words) {
          if (!stored.includes(w)) {
            problems.push(`"${w}" was typed and saved with the subject's Save button but never reached the database`);
          }
        }

        if (hasOther) {
          const survived = await admin.page.locator('.tw-subject').nth(otherIdx)
            .locator('.tw-slot__input').first().inputValue().catch(() => '');
          note(`the word typed in another subject, after the redraw: ${JSON.stringify(survived)}`);
          if (survived !== 'Elsewhere') {
            problems.push('a word typed in another subject was wiped by the redraw a save triggers — typing ahead loses work, which is the whole point of writing a sitting at a time');
          }
        }
      }
    }
  }

  // ============================================================
  // THE EMERGENCY HALF, ON A PHONE
  //
  // The admin page is built for a computer now, and the owner may still need to
  // end a stuck room or read a report from their phone. Both halves are checked,
  // because either alone is a check that cannot fail: asserting only that the
  // heavy panels are gone would pass on a build where NOTHING opened, and
  // asserting only that the light ones work would pass on the old page.
  // ============================================================
  heading('the emergency half, on a phone');
  const phone = await table.seatSignedIn('RomanPhone', { isAdmin: true });
  await phone.goto('admin.html');
  await phone.page.waitForSelector('#admin-content', { state: 'visible', timeout: 20000 }).catch(() => {});
  await phone.page.waitForTimeout(1500);

  const onPhone = await phone.page.evaluate(() => {
    const seen = {};
    document.querySelectorAll('.admin-panel__head').forEach(h => {
      seen[h.dataset.panel] = h.getBoundingClientRect().height > 0;
    });
    const note = document.querySelector('.admin-desktop-note');
    return {
      seen,
      note: note ? getComputedStyle(note).display !== 'none' : false,
      shell: document.body.classList.contains('admin-desktop'),
    };
  }).catch(() => null);
  note(`on a phone: ${JSON.stringify(onPhone)}`);

  if (!onPhone) {
    problems.push('the admin page never rendered on a phone at all');
  } else {
    // The heavy four: typing ~86 title words or refiling a 4,859-row bank is
    // not a thing a 375px screen can do, and a control that is merely miserable
    // rather than absent is the shape CLAUDE.md #4 is about.
    for (const key of ['titlewords', 'questions', 'health', 'chat']) {
      if (onPhone.seen[key]) {
        problems.push(`the ${key} panel is offered on a phone — it is desktop-only, and a control that cannot usefully be operated should not be on screen`);
      }
    }
    // AND THE URGENT ONES MUST STILL BE THERE. Without this half, hiding every
    // panel would pass the check above perfectly.
    for (const key of ['flagged', 'hosts', 'games', 'errors', 'announcement']) {
      if (!onPhone.seen[key]) {
        problems.push(`the ${key} panel is missing on a phone — this is the half somebody needs when a game is stuck and they are out`);
      }
    }
    if (!onPhone.note) {
      problems.push('nothing on the phone says where the rest of the page went — a section that simply vanishes reads as a broken page');
    }
    if (onPhone.shell) {
      problems.push('the desktop shell was built on a phone viewport');
    }
  }

} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ admin scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
