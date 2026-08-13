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

async function seatWithName(table, name, opts) {
  const r = await table.seat(name, opts);
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

    // Age the dead host past HOST_HANDOVER_MS (30s) but well short of
    // STALE_TIMEOUT_MS (120s), so this exercises the deputy path rather than
    // removal-and-promotion. Backdating by ten minutes tested the old
    // behaviour instead: the host was removed outright and someone inherited
    // the role, which is a different code path entirely.
    const staleAt = new Date(Date.now() - 60 * 1000).toISOString();
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

    // Design: while the host is merely ABSENT the crown stays with them and
    // someone else is deputised to advance. What matters is that a live player
    // CAN move the game on, not who holds the title.
    // The absent host should still hold the crown and still be in the room:
    // they are away, not gone, and must get their game back on return.
    const stillSeated = remaining.some(p => p.display_name === deadHostName);
    const stillHost = remaining.some(p => p.display_name === deadHostName && p.is_host);
    if (!stillSeated) {
      problems.push('host was removed after only 60s away — should keep their seat until the removal threshold');
    } else if (!stillHost) {
      problems.push('host lost the crown after only 60s away — should be deputised, not replaced');
    } else {
      note('absent host kept their seat and the crown');
    }

    const liveHosts = remaining.filter(p => p.is_host && p.display_name !== deadHostName);
    if (liveHosts.length > 0) {
      problems.push(`${liveHosts.map(h => h.display_name).join(', ')} took the crown instead of deputising`);
    }

    const deputies = [];
    for (const r of [bob, carol]) {
      const can = await r.page.evaluate(() => {
        for (const sel of ['#btn-next-question', '#btn-scores-action', '#btn-fw-reveal']) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) return true;
        }
        return false;
      }).catch(() => false);
      if (can) deputies.push(r.name);
    }
    for (const r of [bob, carol]) {
      const diag = await r.page.evaluate(() => ({
        deputy: window.__state?.isDeputy,
        isHost: window.__state?.room?.isHost,
        phase: window.__state?.gamePhase,
        players: (window.__state?.players || []).map(p => `${p.display_name}:host=${!!p.is_host}:seen=${p.last_seen_at ? 'y' : 'n'}`),
      })).catch(e => ({ err: String(e).slice(0, 80) }));
      note(`${r.name} diag: ${JSON.stringify(diag)}`);
    }
    note(`can advance the game: ${deputies.join(', ') || 'NOBODY'}`);
    if (deputies.length === 0) {
      problems.push('host went away and nobody can advance — the room is stuck');
    }

    const newHostRobot = [bob, carol].find(r => deputies.includes(r.name));
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

// ============================================================
// 4. SEAT RELEASED, THEN REJOIN
// ============================================================
async function rejoinAfterSeatReleased() {
  heading('player rejoins after their seat was released');
  const table = await PlaytestTable.open();
  try {
    seedQuestions(table.store);
    const { host, code } = await openRoom(table);
    const bob = await joinRoom(table, 'Bob', code);
    await host.page.waitForTimeout(1500);

    await host.page.click('#btn-start-game').catch(() => {});
    await bob.page.waitForURL('**/game.html*', { timeout: 25000 }).catch(() => {});
    await host.page.waitForTimeout(6000);

    // Bob answers the first question correctly, so there is history to lose.
    const answer = async (r, text) => {
      const input = r.page.locator('#answer-input');
      await input.waitFor({ state: 'visible', timeout: 12000 }).catch(() => {});
      const w = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
      if (await w.isVisible().catch(() => false)) await w.click().catch(() => {});
      await input.fill(text).catch(() => {});
      await r.page.click('#btn-submit-answer').catch(() => {});
    };
    await answer(host, 'Answer 1');
    await answer(bob, 'Answer 1');
    await host.page.waitForTimeout(2000);

    const bobRowBefore = table.store.table('players').find(p => p.display_name === 'Bob');
    const answersBefore = table.store.table('answers')
      .filter(a => String(a.player_id) === String(bobRowBefore?.id));
    note(`Bob answered ${answersBefore.length} question(s) before dropping`);
    if (answersBefore.length === 0) {
      problems.push('setup failed: Bob never recorded an answer, so rejoin cannot be judged');
      return;
    }

    // Keep the browser's storage: this is the same person reopening the app,
    // not someone arriving on a new device.
    const bobStorage = await bob.page.context().storageState();
    await bob.page.context().close();
    const removed = table.store.table('players').findIndex(p => p.display_name === 'Bob');
    if (removed !== -1) table.store.table('players').splice(removed, 1);
    note('Bob removed from the room entirely');
    await host.page.waitForTimeout(2000);

    // He comes back with the same display name.
    const bobAgain = await seatWithName(table, 'Bob', { storageState: bobStorage });
    await bobAgain.goto('join.html');
    await bobAgain.page.waitForSelector('#code-input', { timeout: 15000 });
    await bobAgain.page.fill('#code-input', code);
    await bobAgain.page.click('#btn-join');
    await bobAgain.page.waitForTimeout(6000);

    const bobRows = table.store.table('players').filter(p => p.display_name === 'Bob');
    note(`after rejoin: ${table.store.table('players').map(p => p.display_name).join(', ')}`);
    if (bobRows.length === 0) {
      problems.push('player could not rejoin after their seat was released');
      return;
    }
    if (bobRows.length > 1) {
      problems.push(`rejoining created ${bobRows.length} rows for the same player`);
    }

    // The point of holding history: his earlier answers must follow him to the
    // new seat, or he returns with his score wiped.
    const newId = String(bobRows[0].id);
    const carried = table.store.table('answers').filter(a => String(a.player_id) === newId);
    note(`answers now attached to Bob's new seat: ${carried.length} of ${answersBefore.length}`);
    if (carried.length < answersBefore.length) {
      problems.push(`rejoin lost history: ${answersBefore.length} answers before, ${carried.length} after`);
    }
  } catch (err) {
    problems.push(`rejoin-after-removal scenario threw: ${err.message.split('\n')[0]}`);
  } finally {
    await table.close();
  }
}

// ============================================================
// 5. AWAY IS VISIBLE TO EVERYONE ELSE
// ============================================================
async function awayIsVisible() {
  heading('a player who switches away is shown as away');
  const table = await PlaytestTable.open();
  try {
    seedQuestions(table.store);
    const { host, code } = await openRoom(table);
    const bob = await joinRoom(table, 'Bob', code);
    await host.page.waitForTimeout(2500);

    const bobFadedFor = async () => host.page.evaluate(() => {
      for (const el of document.querySelectorAll('.player-item')) {
        if (!el.textContent.includes('Bob')) continue;
        const faded = el.classList.contains('player-item--away') ||
                      parseFloat(getComputedStyle(el).opacity) < 0.9;
        return faded;
      }
      return null;   // Bob not rendered at all
    }).catch(() => null);

    const before = await bobFadedFor();
    note(`before switching away, host sees Bob faded: ${before}`);
    if (before === null) {
      problems.push('host cannot see Bob in the lobby at all');
      return;
    }
    if (before === true) {
      problems.push('Bob shows as away while he is present — the indicator is meaningless');
    }

    // Switching tab/app is what presence reports as away.
    await bob.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }).catch(() => {});
    await host.page.waitForTimeout(6000);

    const after = await bobFadedFor();
    note(`after switching away, host sees Bob faded: ${after}`);
    if (after !== true) {
      problems.push('a player who switched away is not shown as away to anyone else');
    }
  } catch (err) {
    problems.push(`away-visibility scenario threw: ${err.message.split('\n')[0]}`);
  } finally {
    await table.close();
  }
}

await awayIsVisible();
await hostDisappearsMidQuestion();
await rejoinAfterSeatReleased();
await playerDropsAndRejoins();
await simultaneousAnswers();

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ all nasty scenarios passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
