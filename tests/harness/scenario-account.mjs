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
  const stats = (userId, category, answered, correct, games, wins, subcategory = null) => ({
    id: `st-${userId}-${category}-${subcategory || 'all'}`,
    user_id: userId, category, subcategory,
    questions_answered: answered, correct_answers: correct,
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
    stats(alice.userId, 'history', 120, 96, 14, 6),
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
  const acc = statValue('accuracy');
  const expectedAcc = `${Math.round(((96 + 51) / ALICE_ANSWERED) * 100)}%`;
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
  // 3. LEADERBOARD
  // ============================================================
  heading('leaderboard');
  await alice.goto('leaderboard.html');
  await alice.page.waitForTimeout(2500);

  const globalText = await alice.page.textContent('#lb-global-list').catch(() => '');
  note(`global list: ${(globalText || '').replace(/\s+/g, ' ').trim().slice(0, 120)}`);
  if (!(globalText || '').includes('Alice')) {
    problems.push('the signed-in player does not appear on the global leaderboard despite having stats');
  }
  const flat = (globalText || '').replace(/\s+/g, ' ');
  if (flat.includes(`${ALICE_GAMES * 2} games`)) {
    problems.push(`the global leaderboard credits Alice with ${ALICE_GAMES * 2} games — double her ${ALICE_GAMES}, so subcategory rows are being summed with their rollup`);
  } else if (!flat.includes(`${ALICE_GAMES} games`)) {
    problems.push(`the global leaderboard does not show Alice's ${ALICE_GAMES} games (got: ${flat.slice(0, 100)})`);
  }
  // Points must come from the whole-account totals, not from adding the
  // per-category rows together.
  if (flat.includes('147 pts')) {
    problems.push('the global leaderboard shows 147 pts — the sum of Alice\'s per-category rows, which counts a question filed under two topics twice');
  } else if (!flat.includes(`${ALICE_POINTS} pts`)) {
    problems.push(`the global leaderboard does not show Alice's ${ALICE_POINTS} points (got: ${flat.slice(0, 100)})`);
  }

  // ============================================================
  // THE BOARD WHEN THE TOTALS VIEW IS NOT THERE
  //
  // Migration 032 is hand-applied, so there is a window where the app is
  // deployed and the view is not. A leaderboard that is slightly generous
  // beats one that is blank, so fetchPlayerTotalsForLeaderboard falls back to
  // the per-category rollups.
  //
  // This is only testable because the store can now answer PGRST205 rather
  // than an empty list — an unseeded table looks like an EMPTY one, and an
  // empty one never triggers a fallback.
  // ============================================================
  heading('the leaderboard with the totals view missing');
  table.store.denyReads('player_totals_computed');
  await alice.goto('leaderboard.html');
  await alice.page.waitForTimeout(2500);
  const fallbackText = (await alice.page.textContent('#lb-global-list').catch(() => '') || '')
    .replace(/\s+/g, ' ');
  note(`global list on the fallback path: ${fallbackText.trim().slice(0, 90)}`);
  if (!fallbackText.includes('Alice')) {
    problems.push('with player_totals_computed missing the global leaderboard goes blank instead of falling back');
  }
  // The fallback is the per-category rollups, so it reads 147 — generous by
  // the 7 double-counted answers, and correct about games.
  if (!fallbackText.includes(`${ALICE_GAMES} games`)) {
    problems.push(`the fallback board lost Alice's game count (got: ${fallbackText.slice(0, 90)})`);
  }
  table.store.allowReads('player_totals_computed');

  // Switching to the category tab must not blank the page.
  const catTab = alice.page.locator('[data-tab="category"], #tab-category-btn').first();
  if (await catTab.isVisible().catch(() => false)) {
    await catTab.click().catch(() => {});
    await alice.page.waitForTimeout(1500);
    const catList = await alice.page.textContent('#lb-category-list').catch(() => '');
    note(`category list after switching: ${(catList || '').replace(/\s+/g, ' ').trim().slice(0, 60) || '(empty)'}`);
  }

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
