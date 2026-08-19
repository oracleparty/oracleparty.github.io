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

  // The mastery tree is driven by an RPC that is NOT installed on the live
  // database (get_mastery_counts), so it must survive the fallback path.
  const masteryText = await alice.page.textContent('#profile-mastery').catch(() => '');
  note(`mastery block: ${(masteryText || '').trim().slice(0, 40) || '(empty)'}`);

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
      && !/updateProfile failed|PGRST116/i.test(e));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ account scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
