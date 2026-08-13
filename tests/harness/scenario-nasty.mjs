// Scenario: the things that actually break games with real people.
//
//   1. The host's phone dies mid-question — no goodbye, no cleanup.
//      Does the room hang forever, or does someone else take over?
//   2. A player drops and rejoins.
//      Do they get back in, and does the room end up with two hosts?
//   3. Two players answer in the same instant.
//      Does either submission get lost?
//
// Each is checked independently and reported separately, so one failure does
// not hide the others.
//
// Run: node tests/harness/scenario-nasty.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

function seedQuestions(store, n = 40) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`,
      question: `Test question ${i}?`,
      correct_answer: `Answer ${i}`,
      acceptable_answers: [],
      categories: [CATEGORY],
      subcategory: null,
      difficulty: 'medium',
      format: 'open',
      fun_fact: null,
      discarded: false,
    });
  }
  store.seed('questions', rows);
}

async function seatWithName(table, name) {
  const r = await table.seat(name);
  await r.page.addInitScript(n =>
    localStorage.setItem('oracle_party_display_name', n), name);
  return r;
}

const activeScreen = r => r.page
  .evaluate(() => document.querySelector('.screen.active')?.id || '(none)')
  .catch(() => '(gone)');

/** Host a room and return { host, code }. */
async function openRoom(table, hostName = 'Alice') {
  const host = await seatWithName(table, hostName);
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click('[data-setting="questionsPerGame"] [data-value="5"]').catch(() => {});
  await host.page.waitForTimeout(300);
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);
  return { host, code: await host.textOf('#lobby-code') };
}

async function joinRoom(table, name, code) {
  const r = await seatWithName(table, name);
  await r.goto('join.html');
  await r.page.waitForSelector('#code-input', { timeout: 15000 });
  await r.page.fill('#code-input', code);
  await r.page.click('#btn-join');
  await r.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  return r;
}

// ============================================================
// 1. HOST'S PHONE DIES MID-QUESTION
// ============================================================
async function hostDisappearsMidQuestion() {
  heading('host phone dies mid-question');
  const table = await PlaytestTable.open();
  try {
    seedQuestions(table.store);
    const { host, code } = await openRoom(table);
    const bob = await joinRoom(table, 'Bob', code);
    const carol = await joinRoom(table, 'Carol', code);
    await host.page.waitForTimeout(1500);

    await host.page.click('#btn-start-game').catch(() => {});
    for (const r of [bob, carol]) {
      await r.page.waitForURL('**/game.html*', { timeout: 25000 }).catch(() => {});
    }
    await host.page.waitForTimeout(6000);   // through the countdown

    note(`before: Bob on ${await activeScreen(bob)}`);

    // Kill the host outright: no unload beacon, no cleanup, nothing.
    await host.killAbruptly();
    note('host killed with no cleanup');

    // A killed browser leaves its player row behind, still flagged as host.
    // Counting host rows would therefore report success while the room is
    // actually leaderless, so the dead host must be excluded explicitly.
    const deadHostName = host.name;

    // Takeover is gated on the stale threshold (3 minutes when no goodbye
    // beacon was sent). Waiting that out would make this scenario useless, so
    // age the dead host's heartbeat directly and let the survivors notice.
    const staleAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    for (const row of table.store.table('players')) {
      row.last_seen_at = row.display_name === deadHostName ? staleAt : fresh;
    }
    note('dead host backdated past the stale threshold');

    // Survivors re-check every STALE_CHECK_INTERVAL (30s) but only refetch
    // players from the database every third check, so a change made here can
    // take up to 90 seconds to be noticed. Wait long enough to cover that.
    await bob.page.waitForTimeout(40000);

    note(`after: Bob on ${await activeScreen(bob)}, Carol on ${await activeScreen(carol)}`);

    const remaining = table.store.table('players');
    note(`players left: ${remaining.map(p => `${p.display_name}${p.is_host ? '*' : ''}`).join(', ')}`);

    const liveHosts = remaining.filter(p => p.is_host && p.display_name !== deadHostName);
    const deadStillHost = remaining.some(p => p.display_name === deadHostName && p.is_host);

    if (liveHosts.length === 0) {
      problems.push(deadStillHost
        ? 'host died and was never replaced — their row still holds the host flag, so the room cannot advance'
        : 'host died and nobody was promoted — the room cannot advance');
    } else if (liveHosts.length > 1) {
      problems.push(`host died and ${liveHosts.length} players promoted themselves — duplicate hosts`);
    } else {
      note(`promoted: ${liveHosts[0].display_name}`);
    }

    // Whoever took over must actually be able to drive the game.
    const newHostRobot = [bob, carol].find(r => liveHosts.some(h => h.display_name === r.name));
    if (newHostRobot) {
      // Check each control separately: .first() returns the first match in DOM
      // order, which is often a hidden button from another screen, and would
      // report "no controls" while a working one sits right there.
      const controls = ['#btn-next-question', '#btn-scores-action', '#btn-submit-answer', '#btn-fw-reveal'];
      const visible = [];
      for (const sel of controls) {
        if (await newHostRobot.page.locator(sel).isVisible().catch(() => false)) visible.push(sel);
      }
      const canAdvance = visible.length > 0;
      note(`${newHostRobot.name} visible controls: ${visible.join(', ') || 'none'}`);
      if (!canAdvance) {
        problems.push(`${newHostRobot.name} was promoted but has no control visible on ${await activeScreen(newHostRobot)}`);
      } else {
        note(`${newHostRobot.name} has working controls`);
      }
    }
  } catch (err) {
    problems.push(`host-death scenario threw: ${err.message.split('\n')[0]}`);
  } finally {
    await table.close();
  }
}

// ============================================================
// 2. PLAYER DROPS AND REJOINS
// ============================================================
async function playerDropsAndRejoins() {
  heading('player drops and rejoins');
  const table = await PlaytestTable.open();
  try {
    seedQuestions(table.store);
    const { host, code } = await openRoom(table);
    const bob = await joinRoom(table, 'Bob', code);
    await host.page.waitForTimeout(1500);

    const before = table.store.table('players').length;
    note(`${before} players before the drop`);

    // Reload rather than close: this is the refresh case, which used to be
    // treated as leaving for good.
    await bob.page.reload({ waitUntil: 'domcontentloaded' });
    await bob.page.waitForTimeout(5000);

    const after = table.store.table('players');
    const bobRows = after.filter(p => p.display_name === 'Bob');
    note(`after refresh: ${after.map(p => p.display_name).join(', ')}`);

    if (bobRows.length === 0) {
      problems.push('refreshing removed the player from the room entirely');
    } else if (bobRows.length > 1) {
      problems.push(`refreshing created ${bobRows.length} duplicate rows for the same player`);
    }

    const hosts = after.filter(p => p.is_host);
    if (hosts.length !== 1) {
      problems.push(`after a refresh the room has ${hosts.length} hosts`);
    }

    const hostSeesBob = await host.page.evaluate(() =>
      document.body.innerText.includes('Bob')).catch(() => false);
    if (!hostSeesBob) {
      problems.push('host cannot see the player after they refreshed');
    } else {
      note('host still sees Bob');
    }

    // The reported bug: still visible a few seconds later, not kicked.
    await host.page.waitForTimeout(8000);
    const stillThere = table.store.table('players').some(p => p.display_name === 'Bob');
    if (!stillThere) {
      problems.push('player was removed by the stale check while sitting in the lobby');
    } else {
      note('Bob still present 8s later — not auto-kicked');
    }
  } catch (err) {
    problems.push(`rejoin scenario threw: ${err.message.split('\n')[0]}`);
  } finally {
    await table.close();
  }
}

// ============================================================
// 3. SIMULTANEOUS ANSWERS
// ============================================================
async function simultaneousAnswers() {
  heading('two players answer at the same instant');
  const table = await PlaytestTable.open();
  try {
    seedQuestions(table.store);
    const { host, code } = await openRoom(table);
    const bob = await joinRoom(table, 'Bob', code);
    const carol = await joinRoom(table, 'Carol', code);
    await host.page.waitForTimeout(1500);

    await host.page.click('#btn-start-game').catch(() => {});
    for (const r of [bob, carol]) {
      await r.page.waitForURL('**/game.html*', { timeout: 25000 }).catch(() => {});
    }
    await host.page.waitForTimeout(6000);

    const submit = async (r, text) => {
      const input = r.page.locator('#answer-input');
      await input.waitFor({ state: 'visible', timeout: 12000 });
      const wager = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
      if (await wager.isVisible().catch(() => false)) await wager.click().catch(() => {});
      await input.fill(text).catch(() => {});
      await r.page.click('#btn-submit-answer').catch(() => {});
    };

    // Fire all three without awaiting in turn, so they race.
    await Promise.all([
      submit(host, 'Answer 1'),
      submit(bob, 'Answer 1'),
      submit(carol, 'Answer 1'),
    ]);
    await host.page.waitForTimeout(3000);

    const answers = table.store.table('answers').filter(a => a.question_number === 0);
    const byPlayer = new Set(answers.map(a => String(a.player_id)));
    note(`${answers.length} answers recorded from ${byPlayer.size} distinct players`);

    if (byPlayer.size !== 3) {
      problems.push(`3 players answered simultaneously but only ${byPlayer.size} submissions were stored`);
    }
    if (answers.length !== byPlayer.size) {
      problems.push(`duplicate answer rows: ${answers.length} rows for ${byPlayer.size} players`);
    }

    // Everyone should see all three on the reveal screen.
    for (const r of [host, bob, carol]) {
      const shown = await r.page.evaluate(() =>
        document.querySelectorAll('#reveal-answers .answer-row').length).catch(() => -1);
      note(`${r.name} sees ${shown} answer rows`);
      if (shown !== -1 && shown < 3) {
        problems.push(`${r.name} sees only ${shown} of 3 answers on the reveal screen`);
      }
    }
  } catch (err) {
    problems.push(`simultaneous-answer scenario threw: ${err.message.split('\n')[0]}`);
  } finally {
    await table.close();
  }
}

await hostDisappearsMidQuestion();
await playerDropsAndRejoins();
await simultaneousAnswers();

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ all nasty scenarios passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
