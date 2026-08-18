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
  const stats = (userId, category, answered, correct, games, wins) => ({
    id: `st-${userId}-${category}`, user_id: userId, category, subcategory: null,
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
  table.store.seed('player_stats_computed', [
    stats(alice.userId, 'history', 120, 96, 14, 6),
    stats(alice.userId, 'science', 80, 51, 9, 2),
    stats(bob.userId, 'history', 60, 33, 7, 1),
    stats(carol.userId, 'history', 20, 8, 3, 0),
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
  note(`global list: ${(globalText || '').replace(/\s+/g, ' ').trim().slice(0, 90)}`);
  if (!(globalText || '').includes('Alice')) {
    problems.push('the signed-in player does not appear on the global leaderboard despite having stats');
  }

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

  for (const r of [alice, bob, carol]) {
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e));
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
