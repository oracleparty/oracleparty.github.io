// Scenario: the signed-in half of the app, which no robot has ever touched.
//
// profile.js is 1,452 lines, titles.js 513, leaderboard.js 342, and the friends
// half of social.js another few hundred — none of it reachable by a guest, and
// every robot until now was a guest. That blind spot is not hypothetical: the
// lobby row that overflowed by 71px in a live game needed a tier badge to
// break, so it was invisible here while being obvious in the hand.
//
//   1. A signed-in player's profile page loads and shows THEM.
//   2. Their stats and category breakdown render.
//   3. The leaderboard lists real people, and the signed-in player is on it.
//   4. Friends: search, request, accept — and the friendship is mutual.
//   5. A friend request cannot be sent twice, or to yourself.
//   6. Signed-in players in a lobby render without breaking the layout.
//
// Run: node tests/harness/scenario-account.mjs
import { PlaytestTable } from './harness.js';

const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

function seedQuestions(store, n = 40) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`, question: `Test question ${i}?`, correct_answer: `Answer ${i}`,
      acceptable_answers: [], categories: ['history'], subcategory: null,
      difficulty: 'medium', format: 'open', fun_fact: null, discarded: false,
    });
  }
  store.seed('questions', rows);
}

const table = await PlaytestTable.open();

try {
  // The category grid is built from the question bank; with none seeded it
  // renders zero cards and hosting is impossible. That looked like a signed-in
  // player being unable to start a game.
  seedQuestions(table.store);
  // --- seed the kind of history a real account accumulates -----------------
  //
  // SEEDED IN THE SHAPE THE REAL VIEW RETURNS, which is not the obvious one.
  // player_stats_computed emits a row per subcategory AND a rollup row
  // (subcategory null) whose totals ALREADY CONTAIN them. Seeding only
  // rollups — which this scenario did until 2026-08-19 — makes the two
  // possible readings of the data identical, so a page that adds every row up
  // scores the same as one that adds the rollups, and the double-count bug in
  // CLAUDE.md #8 was invisible here by construction.
  //
  // THE PROFICIENCY COLUMNS ARE SEEDED TOO, and deliberately disagree with the
  // attempt counters. rowProficiency (migration 040) reads questions_met and
  // questions_mastered and FALLS BACK to questions_answered / correct_answers
  // when they are absent — so seeding only the counters makes the two readings
  // identical and any check on which one the page uses passes whatever it does.
  // That is how the category leaderboard shipped ranking by the lifetime hit
  // rate 040 replaced: its query named a column list that omitted them, the
  // fallback fired every time, and falling back is not an error.
  //
  // Proficiency is deliberately the LOWER number here, so a page showing the
  // old measure is visible rather than merely different.
  const stats = (userId, category, answered, correct, games, wins, subcategory = null, met = null, mastered = null) => ({
    id: `st-${userId}-${category}-${subcategory || 'all'}`,
    user_id: userId, category, subcategory,
    questions_answered: answered, correct_answers: correct,
    questions_met: met ?? answered, questions_mastered: mastered ?? correct,
    games_played: games, wins,
  });

  const alice = await table.seatSignedIn('Alice', { tier: 'Oracle', title: 'Keeper of Secrets' });
  const bob = await table.seatSignedIn('Bob', { tier: 'Scholar' });
  const carol = await table.seatSignedIn('Carol', { tier: 'Novice' });

  // The leaderboard reads player_stats_computed — a VIEW that aggregates
  // question_history against questions (migration 017), not the player_stats
  // table. Seeding the table left the leaderboard empty and looked like a bug
  // in the app; it was a bug in this scenario.
  //
  // Alice's TRUE totals are the rollups only: 14 + 9 = 23 games, 6 + 2 = 8
  // wins, 120 + 80 = 200 questions. The subcategory rows below are a
  // breakdown of those same numbers, not extra play, and the assertions
  // further down check the page agrees.
  const ALICE_GAMES = 23, ALICE_WINS = 8, ALICE_ANSWERED = 200;
  table.store.seed('player_stats_computed', [
    stats(alice.userId, 'history', 120, 96, 14, 6, null, 60, 30),
    stats(alice.userId, 'science', 80, 51, 9, 2),
    stats(bob.userId, 'history', 60, 33, 7, 1),
    stats(carol.userId, 'history', 20, 8, 3, 0),
    // The breakdown inside those rollups.
    stats(alice.userId, 'history', 70, 58, 8, 4, 'ancient'),
    stats(alice.userId, 'history', 50, 38, 6, 2, 'medieval'),
    stats(alice.userId, 'science', 80, 51, 9, 2, 'space'),
    stats(bob.userId, 'history', 60, 33, 7, 1, 'ancient'),
  ]);

  // Whole-account totals (migration 032), which the global and friends boards
  // read instead of adding the per-category rows up.
  //
  // Alice's correct answers here are 140, NOT the 96 + 51 = 147 her category
  // rows sum to. That gap is the point: 7 of her correct answers were on
  // questions filed under two topics, so the per-category rows count them
  // twice and the true figure is lower. If the board ever shows 147 it has
  // gone back to summing categories.
  const ALICE_POINTS = 140;
  table.store.seed('player_totals_computed', [
    { user_id: alice.userId, questions_answered: 190, correct_answers: ALICE_POINTS, games_played: ALICE_GAMES, wins: ALICE_WINS },
    { user_id: bob.userId, questions_answered: 60, correct_answers: 33, games_played: 7, wins: 1 },
    { user_id: carol.userId, questions_answered: 20, correct_answers: 8, games_played: 3, wins: 0 },
  ]);
  // The mastery tree and the Map are built from question_history joined to
  // questions, which is a different source from player_stats_computed above —
  // seeding one says nothing about the other. Filed across two categories and
  // three subcategories so that drilling into History has something to show
  // and Science is a category with mastery but no subcategory breakdown.
  table.store.seed('questions', [
    { id: 'qm1', question: 'Mastered ancient?', correct_answer: 'A', acceptable_answers: [],
      categories: ['history'], subcategory: 'ancient', difficulty: 'easy', format: 'open',
      fun_fact: null, discarded: false },
    { id: 'qm2', question: 'Mastered ancient two?', correct_answer: 'B', acceptable_answers: [],
      categories: ['history'], subcategory: 'ancient', difficulty: 'easy', format: 'open',
      fun_fact: null, discarded: false },
    { id: 'qm3', question: 'Mastered medieval?', correct_answer: 'C', acceptable_answers: [],
      categories: ['history'], subcategory: 'medieval', difficulty: 'easy', format: 'open',
      fun_fact: null, discarded: false },
    { id: 'qm4', question: 'Mastered space?', correct_answer: 'D', acceptable_answers: [],
      categories: ['science'], subcategory: 'space', difficulty: 'easy', format: 'open',
      fun_fact: null, discarded: false },
    // Met and currently WRONG. Mastery counts last_correct only, so this one
    // must not appear anywhere — a map that counts it is counting attempts.
    { id: 'qm5', question: 'Met but missed?', correct_answer: 'E', acceptable_answers: [],
      categories: ['science'], subcategory: 'space', difficulty: 'easy', format: 'open',
      fun_fact: null, discarded: false },
  ]);
  table.store.seed('question_history', [
    { user_id: alice.userId, question_id: 'qm1', times_seen: 1, times_correct: 1, last_correct: true },
    { user_id: alice.userId, question_id: 'qm2', times_seen: 2, times_correct: 1, last_correct: true },
    { user_id: alice.userId, question_id: 'qm3', times_seen: 1, times_correct: 1, last_correct: true },
    { user_id: alice.userId, question_id: 'qm4', times_seen: 1, times_correct: 1, last_correct: true },
    { user_id: alice.userId, question_id: 'qm5', times_seen: 3, times_correct: 2, last_correct: false },
  ]);

  table.store.seed('game_history', [
    { id: 'gh1', user_id: alice.userId, room_id: 'r1', category: 'history', subcategory: null,
      score: 62, placement: 1, total_players: 4, played_at: new Date().toISOString() },
    { id: 'gh2', user_id: alice.userId, room_id: 'r2', category: 'science', subcategory: null,
      score: 40, placement: 3, total_players: 4, played_at: new Date(Date.now() - 864e5).toISOString() },
  ]);

  // ============================================================
  // 1 + 2. THE PROFILE PAGE
  // ============================================================
  heading('profile page for a signed-in player');
  await alice.goto('profile.html');
  await alice.page.waitForTimeout(2500);

  const shownName = await alice.page.textContent('#profile-name').catch(() => '');
  note(`profile shows: ${JSON.stringify((shownName || '').trim())}`);
  if (!shownName || !shownName.includes('Alice')) {
    problems.push(`the profile page does not show the signed-in player's name (got ${JSON.stringify(shownName)})`);
  }

  const statsText = await alice.page.textContent('#profile-stats').catch(() => '');
  note(`stats block length: ${(statsText || '').trim().length} chars`);
  if (!(statsText || '').trim()) {
    problems.push('the profile stats block is empty for a player with recorded stats');
  }

  // THE NUMBERS, not just that there are some.
  //
  // "the block is not empty" passes just as happily on doubled totals, which
  // is how the profile shipped for months showing twice the games anybody had
  // played. Reading the value out is the difference between checking a page
  // rendered and checking it is telling the truth.
  const statNums = await alice.page.evaluate(() =>
    [...document.querySelectorAll('#profile-stats .profile-stat')].map(el => ({
      label: (el.querySelector('.profile-stat__label')?.textContent || '').trim(),
      value: (el.querySelector('.profile-stat__value')?.textContent || '').trim(),
    }))).catch(() => []);
  note(`profile stats: ${JSON.stringify(statNums)}`);

  const statValue = label => statNums.find(s => s.label.toLowerCase() === label)?.value;
  const games = statValue('games');
  const wins = statValue('wins');
  if (games !== String(ALICE_GAMES)) {
    problems.push(`profile shows ${games} games where the rollups say ${ALICE_GAMES}` +
      (games === String(ALICE_GAMES * 2)
        ? ' — exactly double, so the subcategory rows are being added to their own rollup'
        : ''));
  }
  if (wins !== String(ALICE_WINS)) {
    problems.push(`profile shows ${wins} wins where the rollups say ${ALICE_WINS}`);
  }
  // Accuracy is derived from the same sums. It survives an even double count
  // by cancelling, so it is checked to catch an UNEVEN one — a question with
  // no subcategory is counted once and one with a subcategory twice.
  //
  // Computed from the PROFICIENCY columns, because that is what the profile
  // shows (migration 040): Alice's mastered over met across her two rollups,
  // 30 + 51 over 60 + 80. Deliberately not the attempt counters — her History
  // row is seeded so the two disagree, which is what makes it possible to tell
  // which measure a page is using at all.
  const acc = statValue('accuracy');
  const expectedAcc = `${Math.round(((30 + 51) / (60 + 80)) * 100)}%`;
  if (acc !== expectedAcc) {
    problems.push(`profile accuracy reads ${acc}, expected ${expectedAcc} from the rollups`);
  }

  const catText = await alice.page.textContent('#profile-categories').catch(() => '');
  if (!(catText || '').trim()) {
    problems.push('the per-category breakdown is empty for a player with stats in two categories');
  }

  // The mastery tree is driven by get_mastery_counts, which the probe now
  // reports as installed. Until the fake store implemented it, an unknown RPC
  // came back null-with-no-error — indistinguishable from a function that
  // exists and found nothing — so this block was empty in every run and the
  // line below only ever printed "(empty)".
  const masteryText = await alice.page.textContent('#profile-mastery').catch(() => '');
  note(`mastery block: ${(masteryText || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '(empty)'}`);
  if (!(masteryText || '').includes('History')) {
    problems.push('the mastery tree is empty for a player with mastered questions in History');
  }

  // ---- THE MAP ------------------------------------------------------------
  //
  // Its whole reason for existing alongside the list below it is that it shows
  // categories NOBODY has touched. The list cannot: it only renders what
  // somebody has started. So the thing to check is not that it draws — it is
  // that it draws twelve cells when Alice has played two categories.
  const cellCount = await alice.page.locator('#profile-map .hexcell').count().catch(() => 0);
  if (cellCount !== 12) {
    problems.push(`the Map draws ${cellCount} cells, expected all 12 categories including the untouched ones`);
  }
  const emptyCount = await alice.page.locator('#profile-map .hexcell--empty').count().catch(() => 0);
  if (emptyCount === 0) {
    problems.push('every Map cell reads as filled, so a category Alice has never played looks the same as one she has');
  }
  note(`map: ${cellCount} cells, ${emptyCount} untouched`);

  // Drill in and back out. This is the only interaction on the page, and it
  // fetches per-subcategory counts it does not already have — so it has to
  // render before they arrive as well as after.
  await alice.page.locator('#profile-map .hexcell--open[data-key="history"]').click().catch(() => {});
  await alice.page.waitForTimeout(900);
  const backVisible = await alice.page.locator('#profile-map-back').isVisible().catch(() => false);
  const drilledCells = await alice.page.locator('#profile-map .hexcell').count().catch(() => 0);
  if (!backVisible) {
    problems.push('tapping a Map cell did not open it — no way back means it never drilled in');
  }
  if (drilledCells !== 4) {
    problems.push(`opening History shows ${drilledCells} cells, expected its 4 subcategories`);
  }
  const drilledCaption = await alice.page.textContent('#profile-map-caption').catch(() => '');
  note(`map drilled: ${drilledCells} cells — ${(drilledCaption || '').trim()}`);

  await alice.page.locator('#profile-map-back').click().catch(() => {});
  await alice.page.waitForTimeout(400);
  const backAgain = await alice.page.locator('#profile-map .hexcell').count().catch(() => 0);
  if (backAgain !== 12) {
    problems.push(`going back from a Map category shows ${backAgain} cells, expected all 12 again`);
  }

  // ============================================================
  // 3. LEADERBOARD — friends only, ranked on what you KNOW
  //
  // The board no longer ranks on "points" (correct_answers, a count of
  // ATTEMPTS) and is no longer global. It reads get_leaderboard (migration
  // 053) over question_history, and offers two measures.
  //
  // THE SEEDING BELOW MAKES THE TWO MEASURES DISAGREE ON PURPOSE. Bob has more
  // questions mastered than Alice; Alice gets a larger SHARE of what she has
  // met right than Bob does. So the two orders are inverted, and a page that
  // ignored the toggle — or ranked on the wrong column — would show the same
  // order twice. Without that inversion any check here passes whatever the
  // page does, which is the "check that cannot fail" this project keeps
  // deleting.
  // ============================================================
  // ============================================================
  // THE COLLECTION COLLAPSES BY SUBJECT
  //
  // Twelve subjects laid open is a scroll nobody finishes, and it gets worse
  // with every word written — the collection is designed for roughly a hundred.
  // "It rendered" is not "it works": a header that draws a chevron and opens
  // nothing draws exactly as happily, which is the lesson the admin panels and
  // the deputy's dead buttons both taught.
  // ============================================================
  heading('the collection collapses by subject');
  {
    await alice.page.locator('#btn-open-gallery, #title-builder-locked').first()
      .click().catch(() => {});
    await alice.page.waitForTimeout(1500);

    const heads = alice.page.locator('.title-gallery__group--toggle');
    const n = await heads.count().catch(() => 0);
    const openAtFirst = await alice.page
      .locator('.title-gallery__group--toggle[aria-expanded="true"]').count().catch(() => 0);
    note(`subject headers: ${n}, open on arrival: ${openAtFirst}`);
    if (n < 2) {
      problems.push(`the collection shows ${n} collapsible subjects — Knowledge is not grouped, so it is one long scroll again`);
    }
    if (openAtFirst !== 0) {
      problems.push(`${openAtFirst} subject(s) already open on arrival — the point of the collapse is that the page starts short`);
    }

    // OPENING ONE MUST ACTUALLY SHOW ITS WORDS.
    await heads.first().click().catch(() => {});
    await alice.page.waitForTimeout(500);
    const visibleRows = await alice.page
      .locator('#title-gallery-body [data-subject-body]:not([hidden]) .title-row').count().catch(() => 0);
    note(`rows visible after opening the first subject: ${visibleRows}`);
    if (visibleRows === 0) {
      problems.push('opening a subject revealed no words — the header toggles and nothing happens');
    }

    // AND ONLY ONE AT A TIME, or the scroll grows straight back.
    if (n > 1) {
      await heads.nth(1).click().catch(() => {});
      await alice.page.waitForTimeout(500);
      const openNow = await alice.page
        .locator('.title-gallery__group--toggle[aria-expanded="true"]').count().catch(() => 0);
      const bodiesShown = await alice.page
        .locator('#title-gallery-body [data-subject-body]:not([hidden])').count().catch(() => 0);
      note(`after opening a second subject: ${openNow} header(s) open, ${bodiesShown} list(s) shown`);
      if (openNow !== 1 || bodiesShown !== 1) {
        problems.push(`opening a second subject left ${openNow} open — they are meant to close each other`);
      }
    }
    await alice.page.locator('#btn-close-gallery').click().catch(() => {});
    await alice.page.waitForTimeout(400);
  }

  heading('leaderboard');

  const dave = await table.seatSignedIn('Dave', { tier: 'Oracle' });

  // Alice and Bob and Carol are friends. Dave is NOT, and has the best numbers
  // of anybody — so if he appears, the board is not friends-only.
  table.store.seed('friendships', [
    { id: 'fr-ab', user_a: alice.userId, user_b: bob.userId, source: 'lobby' },
    { id: 'fr-ac', user_a: alice.userId, user_b: carol.userId, source: 'lobby' },
  ]);

  const lbQuestions = [];
  const lbHistory = [];
  const addKnowledge = (who, prefix, met, mastered, category = 'history') => {
    for (let i = 1; i <= met; i++) {
      const id = `${prefix}${i}`;
      lbQuestions.push({
        id, question: `${prefix} ${i}?`, correct_answer: 'x', acceptable_answers: [],
        categories: [category], subcategory: null, difficulty: 'easy', format: 'open',
        fun_fact: null, discarded: false,
      });
      lbHistory.push({
        user_id: who, question_id: id, times_seen: 1,
        times_correct: i <= mastered ? 1 : 0,
        last_correct: i <= mastered,
        last_seen_at: new Date().toISOString(),
      });
    }
  };
  // Alice already holds 5 met / 4 mastered from the mastery seeding above.
  addKnowledge(alice.userId, 'la', 10, 9);    // -> 15 met, 13 mastered, 87%
  addKnowledge(bob.userId,   'lb', 30, 20);   // -> 30 met, 20 mastered, 67%
  addKnowledge(carol.userId, 'lc', 4, 4);     // -> 4 met, 4 mastered, 100% but under the floor
  addKnowledge(dave.userId,  'ld', 40, 39);   // best on both measures, and not a friend
  table.store.seed('questions', lbQuestions);
  table.store.seed('question_history', lbHistory);

  const ALICE_MASTERED = 13, BOB_MASTERED = 20, CAROL_MASTERED = 4;

  const boardText = async () =>
    ((await alice.page.textContent('#lb-list').catch(() => '')) || '').replace(/\s+/g, ' ').trim();
  // Who is listed, in the order the page put them in.
  const boardOrder = () => alice.page.evaluate(() =>
    [...document.querySelectorAll('#lb-list .leaderboard-row__name')].map(e => e.textContent.trim())
  ).catch(() => []);

  await alice.goto('leaderboard.html');
  await alice.page.waitForTimeout(2500);

  const mastered = await boardText();
  const masteredOrder = await boardOrder();
  note(`mastered board: ${masteredOrder.join(' > ')} — ${mastered.slice(0, 110)}`);

  if (!masteredOrder.includes('Alice')) {
    problems.push('the signed-in player is missing from their own leaderboard');
  }
  if (masteredOrder.includes('Dave')) {
    problems.push('a player who is NOT a friend appears on the board — it is not friends-only');
  }
  if (!mastered.includes(String(ALICE_MASTERED))) {
    problems.push(`the board does not show Alice's ${ALICE_MASTERED} mastered questions (got: ${mastered.slice(0, 90)})`);
  }
  // Counting ATTEMPTS instead of questions is the old measure. Alice's
  // player_stats_computed rows say 200 answered / 140 correct; neither should
  // appear anywhere on this page.
  if (/\b(200|140|147)\b/.test(mastered)) {
    problems.push(`the board is showing attempt counts (200/140/147), not distinct questions: ${mastered.slice(0, 90)}`);
  }
  if (masteredOrder.indexOf('Bob') > masteredOrder.indexOf('Alice')) {
    problems.push(`Bob has ${BOB_MASTERED} mastered to Alice's ${ALICE_MASTERED} but is ranked below her`);
  }
  if (!masteredOrder.includes('Carol')) {
    problems.push(`Carol has ${CAROL_MASTERED} mastered and is missing from the Mastered board`);
  }

  // --- the toggle ---------------------------------------------------------
  const profTab = alice.page.locator('.profile-tab[data-measure="proficiency"]').first();
  if (!await profTab.isVisible().catch(() => false)) {
    problems.push('there is no Proficiency toggle on the leaderboard');
  } else {
    await profTab.click().catch(() => {});
    await alice.page.waitForTimeout(1500);
    const prof = await boardText();
    const profOrder = await boardOrder();
    note(`proficiency board: ${profOrder.join(' > ')} — ${prof.slice(0, 110)}`);

    // THE INVERSION. Alice knows a larger share of what she has met; Bob has
    // mastered more questions. If the order is the same on both toggles the
    // page is ranking on one thing and labelling the other.
    if (profOrder.indexOf('Alice') > profOrder.indexOf('Bob')) {
      problems.push(`Alice is at 87% to Bob's 67% but is ranked below him — the Proficiency toggle is not changing the ranking`);
    }
    // Carol is 4-for-4, a perfect score from four questions. The floor exists
    // so that cannot outrank a large sample, and she must be absent rather than
    // shown at 100%.
    if (profOrder.includes('Carol')) {
      problems.push('Carol qualifies on Proficiency with only 4 questions met — the sample floor is not being applied');
    }
    // The sample is always printed beside the percentage. "87%" and "87% of 15"
    // are different claims.
    if (!/\d+ of \d+ known/.test(prof)) {
      problems.push(`the Proficiency board shows a percentage with no sample beside it: ${prof.slice(0, 90)}`);
    }
  }

  // --- a category filter --------------------------------------------------
  //
  // Back to Mastered first. On Proficiency this board is empty either way —
  // Alice's two science questions are under the sample floor — and an empty
  // list would pass a "Bob is absent" check whether the filter worked or not.
  await alice.page.locator('.profile-tab[data-measure="mastered"]').first().click().catch(() => {});
  await alice.page.waitForTimeout(800);
  await alice.page.selectOption('#lb-category-select', 'science').catch(() => {});
  await alice.page.waitForTimeout(1500);
  const scienceOrder = await boardOrder();
  const scienceText = await boardText();
  note(`science board: ${scienceOrder.join(' > ') || '(nobody)'} — ${scienceText.slice(0, 80)}`);
  // Alice has exactly one mastered science question (qm4) and one she currently
  // gets wrong (qm5). Everybody else's history is filed under history only.
  if (!scienceOrder.includes('Alice')) {
    problems.push('Alice has a mastered science question but is missing from the science board');
  }
  if (scienceOrder.includes('Bob')) {
    problems.push('Bob has no science history at all but appears on the science board — the category filter is not being applied');
  }
  if (!/\b1\b/.test(scienceText) || !scienceText.includes('2 met')) {
    problems.push(`the science board does not show Alice's 1 mastered of 2 met: ${scienceText.slice(0, 80)}`);
  }
  await alice.page.selectOption('#lb-category-select', '').catch(() => {});
  await alice.page.waitForTimeout(800);

  // ============================================================
  // THE BOARD WITH MIGRATION 053 NOT RUN
  //
  // Migrations here are pasted by hand, so "the JavaScript is live and the SQL
  // is not" is a real state the app runs in — and it is the state the fallback
  // exists for. An RPC this store does not implement used to answer null with
  // NO error, which is what an installed function returning nothing looks like,
  // so this path could not be reached from a scenario at all.
  // ============================================================
  heading('the leaderboard with get_leaderboard not installed');
  table.store.hideFunction('get_leaderboard');
  await alice.goto('leaderboard.html');
  await alice.page.waitForTimeout(2500);
  const fallbackOrder = await boardOrder();
  const fallbackText = await boardText();
  note(`fallback board: ${fallbackOrder.join(' > ') || '(empty)'} — ${fallbackText.slice(0, 90)}`);
  if (!fallbackOrder.includes('Alice')) {
    problems.push('with get_leaderboard missing the board goes blank instead of falling back to player_stats_computed');
  }
  // And it must not offer a period it cannot honour: player_stats_computed is
  // lifetime-only, so a period control beside numbers that ignore it would be
  // a lie the screen tells confidently.
  const periodVisible = await alice.page.locator('#lb-period-select').isVisible().catch(() => false);
  if (periodVisible) {
    problems.push('the period control is offered on the fallback path, which has no time dimension at all');
  }
  table.store.showFunction('get_leaderboard');

  // The board needed Alice to HAVE friends; the friend-request checks below need
  // her not to, or every send is refused with "Already friends" and five of them
  // fail for a reason that has nothing to do with what they test. Cleared here
  // rather than seeded later, so the two sections cannot interfere in either
  // direction.
  table.store.table('friendships').length = 0;

  // ============================================================
  // 4 + 5. FRIENDS
  // ============================================================
  heading('friend requests');
  await alice.goto('profile.html');
  await alice.page.waitForTimeout(2000);

  const friendsTab = alice.page.locator('.profile-tab[data-tab="friends"]').first();
  if (!await friendsTab.isVisible().catch(() => false)) {
    problems.push('a signed-in player is not offered the Friends tab');
  } else {
    await friendsTab.click().catch(() => {});
    await alice.page.waitForTimeout(1200);

    const search = alice.page.locator('#friends-search-input');
    if (!await search.isVisible().catch(() => false)) {
      problems.push('the friends tab has no search box');
    } else {
      await search.fill('Bob').catch(() => {});
      await alice.page.waitForTimeout(2000);

      // Send the request through whatever button the results offer.
      const addBtn = alice.page.locator('button:has-text("Add"), .friend-add-btn, [data-add-friend]').first();
      if (!await addBtn.isVisible().catch(() => false)) {
        problems.push('searching for an existing player offers no way to send a friend request');
      } else {
        await addBtn.click().catch(() => {});
        await alice.page.waitForTimeout(2000);

        const reqs = table.store.table('friend_requests');
        note(`friend_requests rows: ${reqs.length} ${JSON.stringify(reqs.map(r => `${r.status}`))}`);
        if (reqs.length !== 1) {
          problems.push(`sending one friend request stored ${reqs.length} rows`);
        }
        if (reqs[0] && reqs[0].sender_id !== alice.userId) {
          problems.push('the friend request was not attributed to the sender');
        }

        // --- 5. the same request must not be sendable twice ---
        if (await addBtn.isVisible().catch(() => false)) {
          await addBtn.click().catch(() => {});
          await alice.page.waitForTimeout(1500);
          const after = table.store.table('friend_requests');
          if (after.length > 1) {
            problems.push(`a duplicate friend request was accepted — ${after.length} rows for one pair`);
          }
        }

        // --- 4. the recipient sees it and can accept ---
        await bob.goto('profile.html');
        await bob.page.waitForTimeout(2200);
        const bobFriendsTab = bob.page.locator('.profile-tab[data-tab="friends"]').first();
        if (await bobFriendsTab.isVisible().catch(() => false)) {
          await bobFriendsTab.click().catch(() => {});
          await bob.page.waitForTimeout(1500);
          const accept = bob.page.locator('button:has-text("Accept"), .friend-accept-btn, [data-accept-request]').first();
          if (!await accept.isVisible().catch(() => false)) {
            problems.push('the recipient of a friend request is not offered a way to accept it');
          } else {
            await accept.click().catch(() => {});
            await bob.page.waitForTimeout(2000);
            const friendships = table.store.table('friendships');
            note(`friendships rows: ${friendships.length}`);
            if (friendships.length === 0) {
              problems.push('accepting a friend request created no friendship');
            }
            const stillPending = table.store.table('friend_requests').filter(r => r.status === 'pending');
            if (stillPending.length) {
              problems.push('an accepted friend request is still pending');
            }
          }
        }
      }
    }
  }

  // ============================================================
  // 5a-bis. FINDING SOMEBODY BY THEIR EXACT TAG, "Name#1234"
  //
  // This path had NO robot coverage at all. Every scenario searched by plain
  // name, which goes through searchProfiles; the exact-tag branch calls
  // fetchProfileByTag, and nothing had ever exercised it. Same lesson as a page
  // with no mock — a branch nobody drives is a branch nobody is checking.
  //
  // It used to be `.ilike('display_name', name).eq('discriminator', d)
  // .maybeSingle()`, and every part of that was a hazard. Measured against a
  // real Postgres: ILIKE 'Alice' also matches 'alice', and ILIKE 'Bob_1' also
  // matches 'Bob01', because `_` is a single-character wildcard and display
  // names have no character restriction. maybeSingle() ERRORS on more than one
  // row, so either collision returned null — which the friend search renders as
  // "No results found" for a person who plainly exists, while the shorter
  // "Name#" query finds them perfectly well.
  // ============================================================
  console.log('\n=== finding a friend by their exact tag ===');
  {
    const profiles = table.store.table('profiles');
    const bobProfile = profiles.find(p => p.user_id === bob.userId);
    if (!bobProfile?.discriminator) {
      problems.push('Bob has no discriminator, so the exact-tag lookup cannot be checked');
    } else {
      // An impostor differing from Bob ONLY by case, holding the same
      // discriminator. Reachable on the live database because
      // generateDiscriminator used to check uniqueness case-SENSITIVELY while
      // this lookup matched case-INSENSITIVELY, so neither could see the other.
      const impostorId = 'impostor-user-id';
      profiles.push({
        id: 'impostor-profile-id',
        user_id: impostorId,
        display_name: String(bobProfile.display_name).toLowerCase() === bobProfile.display_name
          ? String(bobProfile.display_name).toUpperCase()
          : String(bobProfile.display_name).toLowerCase(),
        discriminator: bobProfile.discriminator,
      });
      const tag = `${bobProfile.display_name}#${bobProfile.discriminator}`;
      note(`searching "${tag}" with a case-variant impostor on the same tag`);

      await alice.page.goto(alice.page.url().split('?')[0]).catch(() => {});
      await alice.page.waitForTimeout(1500);
      const tab = alice.page.locator('.profile-tab[data-tab="friends"]').first();
      await tab.click().catch(() => {});
      await alice.page.waitForTimeout(800);
      const box = alice.page.locator('#friends-search-input');
      await box.fill(tag).catch(() => {});
      await alice.page.waitForTimeout(2200);

      const shown = await alice.page.evaluate(() => {
        const el = document.querySelector('#friends-search-results')
          || document.querySelector('.profile-search-results');
        return el ? el.innerText.trim().slice(0, 200) : '(no results container)';
      }).catch(e => `(threw: ${String(e).slice(0, 60)})`);
      note(`results: ${JSON.stringify(shown)}`);

      if (/no results/i.test(shown)) {
        problems.push(`searching a player's exact tag "${tag}" reported "No results found" for somebody who exists — the ILIKE collision is back`);
      } else if (!shown.includes(bobProfile.display_name)) {
        problems.push(`searching "${tag}" did not show ${bobProfile.display_name} — it resolved to somebody else, and a friend request would go to the wrong person`);
      } else {
        note('the exact tag found the right person despite the collision');
      }

      // Leave the store as it was found: later sections count profiles.
      const at = profiles.findIndex(p => p.user_id === impostorId);
      if (at !== -1) profiles.splice(at, 1);
    }
  }

  // ============================================================
  // 5b. ASKING AGAIN AFTER A DECLINE
  //
  // friend_requests is UNIQUE(sender_id, receiver_id), so there is at most one
  // row per direction EVER. The send path filtered its "already exists?" check
  // on status='pending', so a DECLINED row was invisible to it, the insert hit
  // the unique constraint, and the app reported "Friend request already sent"
  // — false, permanent, and unexplainable to the person looking at it. You
  // could never ask that person again as long as the account existed.
  //
  // Driven through the db layer rather than the UI: the bug is in what the
  // guard looks at, and the UI cannot even reach the second attempt.
  // ============================================================
  heading('asking again after a decline');
  {
    const rows = table.store.table('friend_requests');
    rows.length = 0;
    rows.push({ id: 900, sender_id: alice.userId, receiver_id: carol.userId, status: 'declined',
                created_at: new Date(Date.now() - 86400000).toISOString() });

    const again = await alice.page.evaluate(async ([from, to]) => {
      const mod = await import('./js/supabase.js');
      const res = await mod.sendFriendRequest(from, to);
      return { error: res.error?.message || null, autoAccepted: res.autoAccepted };
    }, [alice.userId, carol.userId]).catch(err => ({ threw: err.message }));
    note(`re-sending after a decline: ${JSON.stringify(again)}`);

    const after = table.store.table('friend_requests');
    note(`rows now: ${JSON.stringify(after.map(r => r.status))}`);

    if (again.error) {
      problems.push(`a declined request could not be re-sent: "${again.error}" — the person can never be asked again`);
    }
    if (after.length !== 1) {
      problems.push(`re-sending produced ${after.length} rows for one pair, and the table is UNIQUE on that pair`);
    }
    if (after[0]?.status !== 'pending') {
      problems.push(`the request is "${after[0]?.status}" after being re-sent, so it will never appear in their list`);
    }
  }

  // ============================================================
  // 5b-ii. DUPLICATE ROWS FOR THE SAME PAIR
  //
  // Measured on the live database: three rows for one (sender, receiver) pair,
  // which the declared UNIQUE(sender_id, receiver_id) makes impossible — so
  // that constraint was never created. Migration 044 adds it and cleans up,
  // but the client must not DEPEND on it: the duplicates it has to survive are
  // the ones sitting in the owner's account right now.
  //
  // Both lookups used maybeSingle(), which ERRORS on more than one row, so on
  // the real data every guard on that pair could only fail. That is how the
  // duplicates were written in the first place, and how two people who each
  // sent the other a request are still not friends five months later.
  // ============================================================
  heading('duplicate rows for one pair');
  {
    const rows = table.store.table('friend_requests');
    rows.length = 0;
    // Three from Carol to Alice, exactly the shape found live.
    for (let i = 0; i < 3; i++) {
      rows.push({ id: 910 + i, sender_id: carol.userId, receiver_id: alice.userId,
                  status: 'pending', created_at: new Date(Date.now() - (3 - i) * 60000).toISOString() });
    }

    // Alice's pending list must show ONE Carol, not three. Three Accept buttons
    // for one person means accepting once leaves two looking unanswered.
    const listed = await alice.page.evaluate(async (uid) => {
      const mod = await import('./js/supabase.js');
      const pending = await mod.fetchPendingRequests(uid);
      return pending.map(r => r.sender_id);
    }, alice.userId).catch(err => ({ threw: err.message }));
    note(`pending senders shown to Alice: ${JSON.stringify(listed)}`);
    if (!Array.isArray(listed) || listed.length !== 1) {
      problems.push(`one person's duplicated requests appear ${Array.isArray(listed) ? listed.length : '?'} times in the list — accepting one leaves the others looking unanswered`);
    }

    // And Alice sending to Carol must AUTO-ACCEPT off the duplicated reverse
    // requests rather than erroring or inserting a mirror-image row. Failing
    // this is precisely what left two willing people unfriended.
    const sent = await alice.page.evaluate(async ([from, to]) => {
      const mod = await import('./js/supabase.js');
      const res = await mod.sendFriendRequest(from, to);
      return { error: res.error?.message || null, autoAccepted: !!res.autoAccepted };
    }, [alice.userId, carol.userId]).catch(err => ({ threw: err.message }));
    note(`sending into duplicated reverse requests: ${JSON.stringify(sent)}`);

    if (sent.error) {
      problems.push(`duplicate rows made sending fail outright: "${sent.error}"`);
    }
    if (!sent.autoAccepted) {
      problems.push('a request back to somebody who already asked was not auto-accepted — this is how two people who both said yes stayed unfriended');
    }
    if (table.store.table('friendships').length === 0) {
      problems.push('the mutual request created no friendship');
    }
    table.store.table('friendships').length = 0;
  }

  // ============================================================
  // 5b-ii-b. THE SAME FAULT, ONE TABLE ALONG
  //
  // `friendships` has no unique constraint either until migration 044 is run,
  // and isFriend used maybeSingle() — which ERRORS on more than one row. Two
  // people who each accepted the other produce two rows for one pair, and from
  // that moment isFriend returned FALSE for people who really are friends:
  //
  //   * sendFriendRequest's "Already friends" guard fell straight through;
  //   * the profile offered "Add Friend" to an existing friend;
  //   * the friends list showed that person twice, with two Remove buttons,
  //     one of which would look like it did nothing.
  //
  // Fixing the request table without checking the friendship table would have
  // left the same shape one join away. When a lookup breaks on duplicates, look
  // for every OTHER lookup keyed on the same pair.
  // ============================================================
  heading('duplicate rows in the friendships table');
  {
    const ships = table.store.table('friendships');
    ships.length = 0;
    const [a, b] = [alice.userId, carol.userId].sort();
    ships.push({ id: 'fs-1', user_a: a, user_b: b, source: 'lobby', created_at: new Date().toISOString() });
    ships.push({ id: 'fs-2', user_a: a, user_b: b, source: 'request', created_at: new Date().toISOString() });

    const answers = await alice.page.evaluate(async ([me, them]) => {
      const mod = await import('./js/supabase.js');
      const friends = await mod.fetchFriends(me);
      return {
        isFriend: await mod.isFriend(me, them),
        listed: friends.map(f => f.user_id),
        created: await mod.createFriendship(me, them, 'lobby').then(r => r.error?.message || null),
      };
    }, [alice.userId, carol.userId]).catch(err => ({ threw: err.message }));
    note(`with two rows for one pair: ${JSON.stringify(answers)}`);
    note(`friendships rows after: ${table.store.table('friendships').length}`);

    if (!answers.isFriend) {
      problems.push('two rows for one pair made isFriend say they are NOT friends — every guard keyed on it fails open');
    }
    if (!Array.isArray(answers.listed) || answers.listed.length !== 1) {
      problems.push(`the friends list shows that person ${Array.isArray(answers.listed) ? answers.listed.length : '?'} times`);
    }
    if (table.store.table('friendships').length !== 2) {
      problems.push(`befriending somebody already befriended changed the row count to ${table.store.table('friendships').length}`);
    }
    ships.length = 0;
  }

  // ============================================================
  // 5b-iii. A CHECK CONSTRAINT NOBODY KNEW ABOUT
  //
  // THIS IS THE ROOT CAUSE OF THE REPORTED BUG. The live `friendships` table
  // carries a constraint named friendships_source_check which appears in NO
  // migration in this repo, and it REJECTS source = 'request' — the only value
  // any caller passes, from acceptFriendRequest. So every accept died on a
  // 23514, surfaced as the word "Error" on the button, and nobody could accept
  // a friend request at all.
  //
  // No scenario could see it, because the fake store accepted any row. A store
  // that never refuses cannot test code whose job is to survive a refusal.
  // ============================================================
  heading('a CHECK constraint the repo has never heard of');
  {
    const rows = table.store.table('friend_requests');
    rows.length = 0;
    rows.push({ id: 920, sender_id: carol.userId, receiver_id: alice.userId,
                status: 'pending', created_at: new Date().toISOString() });
    table.store.table('friendships').length = 0;
    // Exactly the live constraint, measured:
    //   CHECK (source = ANY (ARRAY['lobby', 'search']))
    // plus NOT NULL on the column, which is what made "just omit it" fail too.
    table.store.addCheck('friendships',
      row => row.source === 'lobby' || row.source === 'search',
      'friendships_source_check');
    table.store.addCheck('friendships',
      row => row.source != null,
      'friendships_source_not_null');

    const accepted = await alice.page.evaluate(async (id) => {
      const mod = await import('./js/supabase.js');
      const res = await mod.acceptFriendRequest(id);
      return { error: res.error?.message || null };
    }, 920).catch(err => ({ threw: err.message }));
    note(`accepting against the constraint: ${JSON.stringify(accepted)}`);
    note(`friendships now: ${table.store.table('friendships').length}`);

    if (accepted.error) {
      problems.push(`accepting failed outright against a CHECK constraint: "${accepted.error}" — this is the live bug, nobody can become anybody's friend`);
    }
    const made = table.store.table('friendships');
    if (made.length !== 1) {
      problems.push('accepting produced no friendship, so the two people are still not friends');
    }
    // And it must have written a value the constraint allows, not null — the
    // first attempt at this fix omitted the column and the live database
    // refused it with 23502.
    if (made[0] && !['lobby', 'search', 'request'].includes(made[0].source)) {
      problems.push(`the friendship was written with source=${JSON.stringify(made[0].source)}, which no allowed value covers`);
    }
    table.store.clearChecks('friendships');
    table.store.table('friendships').length = 0;
  }

  // ============================================================
  // 5c. AN ACCEPT THE DATABASE REFUSES
  //
  // Only the RECEIVER may update a request (migration 003), and an RLS refusal
  // returns ZERO ROWS AND NO ERROR. Without a row-count check the page said
  // "Accepted!" and the two people were not friends — the same silent-success
  // shape as CLAUDE.md #4 and #5, in the one feature where both parties
  // remember what they were told.
  // ============================================================
  heading('an accept the database refuses');
  {
    const rows = table.store.table('friend_requests');
    rows.length = 0;
    rows.push({ id: 901, sender_id: carol.userId, receiver_id: alice.userId, status: 'pending',
                created_at: new Date().toISOString() });
    table.store.table('friendships').length = 0;
    table.store.denyWrites('friend_requests');

    const refused = await alice.page.evaluate(async (id) => {
      const mod = await import('./js/supabase.js');
      const res = await mod.acceptFriendRequest(id);
      return { error: res.error?.message || null };
    }, 901).catch(err => ({ threw: err.message }));
    note(`accept when refused: ${JSON.stringify(refused)}`);
    table.store.allowWrites('friend_requests');

    if (!refused.error) {
      problems.push('a refused accept reported success — the two people are told they are friends and are not');
    }
    if (table.store.table('friendships').length > 0) {
      problems.push('a refused accept created a friendship anyway');
    }
  }

  // ============================================================
  // 6. SIGNED-IN PLAYERS IN A LOBBY
  // ============================================================
  heading('a lobby of signed-in players');
  await alice.goto('host.html');
  await alice.page.waitForSelector('.category-card', { timeout: 20000 });
  await alice.page.click('.category-card[data-category="history"]');
  await alice.page.waitForTimeout(800);
  await alice.page.click('text=/^All /');
  await alice.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await alice.page.click('#btn-host-game');
  await alice.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await alice.page.waitForTimeout(1200);
  const code = await alice.textOf('#lobby-code');

  for (const r of [bob, carol]) {
    await r.goto('join.html');
    await r.page.waitForSelector('#code-input', { timeout: 15000 });
    await r.page.fill('#code-input', code);
    await r.page.click('#btn-join');
    await r.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  }
  await alice.page.waitForTimeout(2000);

  // ---- CHAT KEEPS PEOPLE'S FACES ON RELOAD -------------------------------
  //
  // The chat history is drawn from the messages table; the AVATARS come from
  // the player list. Re-entering a lobby loads the history first, so every
  // bubble fell back to a plain letter and somebody's chosen face vanished
  // from their own messages. Reported after a real game, on Play Again — a
  // reload is the same ordering and is what this reproduces.
  await alice.page.fill('#chat-drawer-input', 'hello from Alice').catch(() => {});
  await alice.page.click('#btn-chat-send').catch(() => {});
  await alice.page.waitForTimeout(1200);

  // FORCE THE LOSING ORDER. The lobby used to load its players and its chat
  // history concurrently, and every run here happened to schedule the players
  // first — so the bug was invisible by luck. Slowing the player read makes the
  // messages win every time, which is what a real phone did.
  table.store.slowReads('players', 1500);
  await alice.page.reload();
  await alice.page.waitForTimeout(4000);
  table.store.normalReads('players');

  const aliceAvatar = table.store.table('players')
    .find(p => p.display_name === 'Alice')?.avatar_emoji;
  const bubbleFace = await alice.page.evaluate(() => {
    const b = [...document.querySelectorAll('.chat-bubble')]
      .find(x => (x.dataset.author || '') === 'Alice');
    return b ? (b.querySelector('.avatar')?.textContent || '').trim() : '(no bubble)';
  }).catch(() => '(unreadable)');
  note(`Alice's avatar is ${JSON.stringify(aliceAvatar || '(none)')}; her chat bubble shows ${JSON.stringify(bubbleFace)}`);
  if (aliceAvatar && bubbleFace !== aliceAvatar) {
    problems.push(`after reloading the lobby Alice's chat bubble shows ${JSON.stringify(bubbleFace)} instead of her avatar ${JSON.stringify(aliceAvatar)} — the history is drawn before the player list arrives`);
  }

  // Promote one, which is the exact combination that overflowed in a live game.
  const bobId = table.store.table('players').find(p => p.display_name === 'Bob')?.id;
  await alice.page.locator(`.cohost-btn[data-cohost-id="${bobId}"]`).first().click().catch(() => {});
  await alice.page.waitForTimeout(2000);

  const layout = await alice.page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const rows = [...document.querySelectorAll('#player-list .player-item, #host-list .player-item')];
    return {
      vw,
      docScrollW: document.documentElement.scrollWidth,
      widest: Math.max(0, ...rows.map(r => r.scrollWidth)),
      widestClient: Math.max(0, ...rows.map(r => r.clientWidth)),
      heights: rows.map(r => Math.round(r.getBoundingClientRect().height)),
    };
  }).catch(() => null);

  if (!layout) {
    problems.push('could not measure the lobby after promoting a signed-in co-host');
  } else {
    note(`viewport=${layout.vw} page scrollWidth=${layout.docScrollW} row scrollW=${layout.widest} clientW=${layout.widestClient}`);
    note(`row heights: [${layout.heights.join(', ')}]`);
    if (layout.docScrollW > layout.vw) {
      problems.push(`the lobby is ${layout.docScrollW - layout.vw}px wider than the screen — the page can be dragged sideways`);
    }
    if (layout.widest > layout.widestClient + 1) {
      problems.push(`a player row overflows by ${layout.widest - layout.widestClient}px`);
    }
    const uniq = [...new Set(layout.heights)];
    if (uniq.length > 1 && Math.max(...uniq) - Math.min(...uniq) > 1) {
      problems.push(`player rows are ragged: ${JSON.stringify(layout.heights)}`);
    }
  }

  // ============================================================
  // 7. PROFILE SAVES MUST NOT LIE
  //
  // Five of the six profile writes discarded their result and updated the
  // screen anyway, so a refused write left the player looking at a change that
  // did not exist until they reloaded — the same shape as the admin page
  // reporting "Saved!" for months while RLS threw every write away.
  // ============================================================
  heading('a profile save the database refuses');
  await alice.goto('profile.html');
  await alice.page.waitForTimeout(2500);

  table.store.denyWrites('profiles');

  const favBtns = alice.page.locator('.profile-fav-cat');
  const favCount = await favBtns.count().catch(() => 0);
  note(`favourite-category buttons: ${favCount}`);
  if (favCount < 2) {
    problems.push('the profile page offers no favourite-category buttons to exercise a save with');
  } else {
    // Pick one that is not already selected.
    let target = null;
    for (let i = 0; i < favCount; i++) {
      const b = favBtns.nth(i);
      if (!(await b.evaluate(el => el.classList.contains('selected')).catch(() => true))) { target = b; break; }
    }
    if (!target) {
      note('every category already selected; skipped');
    } else {
      const cat = await target.getAttribute('data-cat').catch(() => null);
      await target.click().catch(() => {});
      await alice.page.waitForTimeout(2000);

      const stuckSelected = await target.evaluate(el => el.classList.contains('selected')).catch(() => false);
      note(`after a refused save, "${cat}" still shows as selected: ${stuckSelected}`);
      if (stuckSelected) {
        problems.push('a refused save left the choice highlighted — the page shows a selection the database never accepted');
      }

      const toastText = await alice.page.evaluate(() =>
        [...document.querySelectorAll('[class*="toast"]')]
          .map(t => (t.textContent || '').trim()).filter(Boolean).join(' | ')).catch(() => '');
      note(`toast after refusal: ${JSON.stringify(toastText.slice(0, 80))}`);

      // ---- A REFUSED NAME SAVE MUST NOT BECOME YOUR NAME ----
      //
      // The name editor puts its own ERROR MESSAGE into the input as the value
      // ("Could not update name" / "Name taken with your #tag") and restores
      // the real name two seconds later. It also cleared its re-entry guard
      // immediately, so a blur inside that window ran the save again — reading
      // the error text as what the player had typed and sending it as their
      // display name.
      //
      // Blurring right after a failed save is the natural thing to do, which is
      // what makes this reachable rather than theoretical.
      const nameEl = alice.page.locator('#profile-name').first();
      if (await nameEl.isVisible().catch(() => false)) {
        await nameEl.click().catch(() => {});
        await alice.page.waitForTimeout(500);
        const nameInput = alice.page.locator('#edit-display-name');
        if (await nameInput.isVisible().catch(() => false)) {
          await nameInput.fill('Renamed').catch(() => {});
          await nameInput.press('Enter').catch(() => {});
          await alice.page.waitForTimeout(600);   // inside the 2s error window
          const shown = await nameInput.inputValue().catch(() => '(gone)');
          note(`input shows after a refused rename: ${JSON.stringify(shown)}`);
          // Tap back into the field and away again, which is the actual user
          // action. A plain blur() proves nothing here: setting `disabled =
          // true` before the write already blurred the input, so by then it is
          // not focused and blur() is a no-op that fires no event. The check
          // has to re-focus first or it passes whatever the code does.
          await alice.page.evaluate(() => {
            const el = document.querySelector('#edit-display-name');
            if (!el) return;
            el.focus();
            el.blur();
          });
          await alice.page.waitForTimeout(1200);

          const attempted = table.store.log
            .filter(e => e.table === 'profiles' && e.action === 'update')
            .map(e => e.payload?.display_name).filter(Boolean);
          note(`display_name values the app tried to save: ${JSON.stringify(attempted)}`);
          const junk = attempted.filter(v => /could not|name taken/i.test(String(v)));
          if (junk.length) {
            problems.push(`a failed rename tried to save its own error message as the display name: ${JSON.stringify(junk)}`);
          }
        }
      }
      if (!toastText) {
        problems.push('a refused profile save told the player nothing at all');
      }

      const stored = table.store.table('profiles').find(p => p.user_id === alice.userId);
      if (stored?.favorite_category === cat) {
        problems.push('a refused write changed the stored profile anyway');
      }
    }
  }

  table.store.allowWrites('profiles');

  for (const r of [alice, bob, carol]) {
    // PGRST116 from updateProfile is provoked on purpose by the refusal check
    // above — logging it is the correct behaviour being tested, not a fault.
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e)
      && !/updateProfile failed|PGRST116/i.test(e)
      // Deliberate: sections 5c and the denyWrites tests provoke exactly these,
      // and a scenario that fails on the log line proving its own fix works is
      // a scenario nobody can add a refusal test to.
      && !/zero rows/i.test(e)
      // Deliberate: section 5b-iii provokes the 23514 that the retry then
      // works around, and the loud log is part of the fix rather than a fault.
      && !/CHECK constraint/i.test(e));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
  }
  // ============================================================
  // DELETING AN ACCOUNT
  //
  // Irreversible, so the two things that matter are that it removes
  // EVERYTHING attached to the account, and that a refusal is never reported
  // as success — telling somebody their data is gone when it is not is the
  // worst version of the silent-failure bug this codebase keeps producing.
  // ============================================================
  heading('deleting an account');

  const before = {
    profiles: table.store.table('profiles').filter(r => String(r.user_id) === String(carol.userId)).length,
    stats: table.store.table('player_stats_computed').filter(r => String(r.user_id) === String(carol.userId)).length,
  };
  note(`Carol before: ${JSON.stringify(before)}`);

  await carol.goto('profile.html');
  await carol.page.waitForTimeout(2500);

  const deleteBtn = carol.page.locator('#profile-delete-account');
  if (!await deleteBtn.isVisible().catch(() => false)) {
    problems.push('a signed-in player is offered no way to delete their account');
  } else {
    await deleteBtn.click().catch(() => {});
    await carol.page.waitForTimeout(500);

    // A stray tap must not be able to destroy an account.
    const armedWithoutTyping = await carol.page.evaluate(() => {
      const b = document.querySelector('#profile-delete-go');
      return !!b && !b.disabled;
    }).catch(() => false);
    note(`delete button armed before typing DELETE: ${armedWithoutTyping}`);
    if (armedWithoutTyping) {
      problems.push('the permanent-delete button is clickable before the confirmation is typed');
    }

    // Wrong word must not arm it either.
    await carol.page.fill('#profile-delete-input', 'delete me').catch(() => {});
    await carol.page.waitForTimeout(200);
    const armedByWrongWord = await carol.page.evaluate(() => {
      const b = document.querySelector('#profile-delete-go');
      return !!b && !b.disabled;
    }).catch(() => false);
    if (armedByWrongWord) problems.push('any text arms the permanent-delete button, not just DELETE');

    await carol.page.fill('#profile-delete-input', 'DELETE').catch(() => {});
    await carol.page.waitForTimeout(300);

    const goBtn = carol.page.locator('#profile-delete-go');
    const armed = await goBtn.isEnabled().catch(() => false);
    note(`delete button armed after typing DELETE: ${armed}`);
    if (!armed) {
      problems.push('typing DELETE does not enable the permanent-delete button');
    } else {
      await goBtn.click().catch(() => {});
      await carol.page.waitForTimeout(3000);

      const after = {
        profiles: table.store.table('profiles').filter(r => String(r.user_id) === String(carol.userId)).length,
        stats: table.store.table('player_stats_computed').filter(r => String(r.user_id) === String(carol.userId)).length,
        history: table.store.table('game_history').filter(r => String(r.user_id) === String(carol.userId)).length,
        friendships: table.store.table('friendships').filter(r =>
          String(r.user_a) === String(carol.userId) || String(r.user_b) === String(carol.userId)).length,
      };
      note(`Carol after: ${JSON.stringify(after)}`);
      for (const [what, n] of Object.entries(after)) {
        if (n > 0) problems.push(`deleting the account left ${n} row(s) in ${what}`);
      }

      // Nobody else's data may be touched. This is the check that catches a
      // function taking a user id instead of reading it from the session.
      const aliceSurvives = table.store.table('profiles')
        .filter(r => String(r.user_id) === String(alice.userId)).length;
      note(`Alice's profile still present after Carol deleted hers: ${aliceSurvives === 1}`);
      if (aliceSurvives !== 1) {
        problems.push('deleting one account removed another player\'s data');
      }
    }
  }

} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ account scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
