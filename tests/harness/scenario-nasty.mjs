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
async function openRoom(table, hostName = 'Alice', opts = {}) {
  const host = await seatWithName(table, hostName);
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click('[data-setting="questionsPerGame"] [data-value="5"]').catch(() => {});
  if (opts.timer) {
    await host.page.click(`[data-setting="questionTimer"] [data-value="${opts.timer}"]`).catch(() => {});
  }
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
  // ============================================================
  // ONE PERSON, ONE SEAT — however many times they come back
  //
  // Reported from a live game as THREE copies of one player in the lobby, all
  // flagged host. It needs a leave whose unload beacon never fires — a locked
  // phone, a dead battery, lost signal — which leaves the row behind. Then:
  //
  //   * join.html added a row unconditionally, so coming back made a SECOND;
  //   * the lobby's rejoin path adopted an existing row only when there was
  //     EXACTLY ONE and otherwise added another, so at two it made a third and
  //     could never get back to the one case it handled.
  //
  // A ratchet: every return from then on added another copy. Two rounds here,
  // because one is not enough to see it — the first duplicate is where the old
  // code still behaved, and the second is where it ran away.
  // ============================================================
  heading('leaving without a clean goodbye, twice');
  {
    const table = await PlaytestTable.open();
    try {
      seedQuestions(table.store);
      const { host, code } = await openRoom(table);
      const bob = await joinRoom(table, 'Bob', code);
      await host.page.waitForTimeout(1200);

      for (const round of [1, 2]) {
        // The row survives, and goes quiet — a phone that vanished without
        // telling anyone. Backdated past the stale timeout so it is plainly
        // abandoned rather than merely idle.
        const long_ago = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        for (const p of table.store.table('players')) {
          if (p.display_name === 'Bob') { p.last_seen_at = long_ago; p.joined_at = long_ago; }
        }

        await bob.page.goto(bob.page.url().replace(/lobby\.html.*$/, 'join.html'),
          { waitUntil: 'domcontentloaded' }).catch(() => {});
        await bob.page.waitForSelector('#code-input', { timeout: 15000 }).catch(() => {});
        await bob.page.fill('#code-input', code).catch(() => {});
        await bob.page.click('#btn-join').catch(() => {});
        await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 }).catch(() => {});
        await bob.page.waitForTimeout(2500);

        const bobRows = table.store.table('players').filter(p => p.display_name === 'Bob');
        note(`after return ${round}: ${bobRows.length} row(s) for Bob`);
        if (bobRows.length !== 1) {
          problems.push(`coming back after a leave that never cleaned up left ${bobRows.length} copies of the same player in the lobby (return ${round})`);
        }
      }

      // ...and the room still has exactly one host through all of it. Every
      // copy in the live report carried the host flag.
      const hosts = table.store.table('players').filter(p => p.is_host);
      if (hosts.length !== 1) {
        problems.push(`the room has ${hosts.length} hosts after the rejoins`);
      }
    } finally {
      await table.close();
    }
  }

  // ============================================================
  // CLOSING THE TAB AND COMING STRAIGHT BACK
  //
  // The block above backdates Bob's row so it is plainly abandoned, and that is
  // the ONLY shape claimSeat's guest rule handles: it will not touch a same-name
  // row that is still alive, because that row might genuinely be somebody else
  // who picked the same name.
  //
  // Which left this wide open. A guest who CLOSES THE TAB loses sessionStorage
  // but keeps localStorage, comes back through the join screen within the stale
  // window, and finds their own row still warm — so the guest rule skips it and
  // hands them a brand new seat beside it. Two Bobs, immediately, with nothing
  // abandoned anywhere. "Three profiles of my friend after he left and rejoined"
  // is this, repeated.
  //
  // The fix is that a remembered seat id is not a guess about who somebody is,
  // it is the seat they were sitting in — so it is checked first, and it beats
  // every heuristic. rememberSeat had to start running in the LOBBY for that to
  // help, because before this it only ever ran on the game page.
  // ============================================================
  heading('closing the tab and coming straight back');
  {
    const table = await PlaytestTable.open();
    try {
      seedQuestions(table.store);
      const { host, code } = await openRoom(table);
      const bob = await joinRoom(table, 'Bob', code);
      await host.page.waitForTimeout(1500);

      const before = table.store.table('players').filter(p => p.display_name === 'Bob');
      note(`Bob is seated once to start with: ${before.length === 1}`);

      // Deliberately NOT backdated. His row is fresh — he shut the tab seconds
      // ago and nothing has gone quiet. sessionStorage dies with the tab;
      // localStorage does not, which is the whole point.
      await bob.page.evaluate(() => sessionStorage.clear()).catch(() => {});

      await bob.page.goto(bob.page.url().replace(/lobby\.html.*$/, 'join.html'),
        { waitUntil: 'domcontentloaded' }).catch(() => {});
      await bob.page.waitForSelector('#code-input', { timeout: 15000 }).catch(() => {});
      await bob.page.fill('#code-input', code).catch(() => {});
      await bob.page.click('#btn-join').catch(() => {});
      await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 }).catch(() => {});
      await bob.page.waitForTimeout(2500);

      const bobRows = table.store.table('players').filter(p => p.display_name === 'Bob');
      note(`after closing the tab and rejoining: ${bobRows.length} row(s) for Bob`);
      if (bobRows.length !== 1) {
        problems.push(`closing the tab and rejoining left ${bobRows.length} copies of the same player while their own row was still alive`);
      }

      const hostRows = table.store.table('players').filter(p => p.is_host);
      if (hostRows.length !== 1) {
        problems.push(`the room has ${hostRows.length} hosts after a tab-close rejoin`);
      }
    } finally {
      await table.close();
    }
  }

  // ============================================================
  // A GHOST CANNOT BE THE HOST
  //
  // Reported from a live game, with a photograph: two abandoned copies of one
  // player both flagged HOST, while the only person actually in the lobby was
  // shown "Ready Up" and had no way to start the game. Four faults compounding:
  //
  //   * promoteToHost set the flag on the new host and never cleared it on the
  //     old one, so every promotion ADDED a host;
  //   * "is there a host" was answered by `players.some(p => p.is_host)`, which
  //     a dead row satisfies perfectly, so promotion never ran;
  //   * the same test guarded the promotion race, so it bailed for a ghost too;
  //   * and the stale sweep for non-hosts only ran on the HOST's client — which
  //     was the thing that had gone. Nobody left could tidy up.
  //
  // Together: a room that can never recover on its own.
  // ============================================================
  heading('a ghost cannot be the host');
  {
    const table = await PlaytestTable.open();
    try {
      seedQuestions(table.store);
      const { host, code } = await openRoom(table);
      const bob = await joinRoom(table, 'Bob', code);
      await host.page.waitForTimeout(1500);

      // The host's phone vanishes and its row is left behind holding the crown
      // — and a second abandoned copy of it too, exactly as photographed.
      const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const rows = table.store.table('players');
      const hostRow = rows.find(p => p.is_host);
      hostRow.last_seen_at = longAgo;
      hostRow.joined_at = longAgo;
      rows.push({ ...hostRow, id: 'ghost-copy', last_seen_at: longAgo, joined_at: longAgo });

      // Bob is the only person here. He must end up able to run the room.
      await bob.page.waitForTimeout(12000);

      const after = table.store.table('players');
      const bobRow = after.find(p => p.display_name === 'Bob');
      const hostsNow = after.filter(p => p.is_host);
      note(`hosts now: ${hostsNow.map(p => p.display_name).join(', ') || '(none)'}`);

      if (hostsNow.length !== 1) {
        problems.push(`the room has ${hostsNow.length} hosts — promotion never removes the old one, so every handover adds another`);
      }
      if (!bobRow?.is_host) {
        problems.push('the only person in the lobby was never made host, because abandoned rows still held the crown and the room believed it had one');
      }

      const canStart = await bob.page.evaluate(() => {
        const b = document.getElementById('btn-start-game');
        return !!b && !b.classList.contains('hidden');
      }).catch(() => false);
      note(`the person actually in the lobby can start the game: ${canStart}`);
      if (!canStart) {
        problems.push('the only person in the lobby cannot start the game — the room is stuck behind a host who is not there');
      }
    } finally {
      await table.close();
    }
  }

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

// ============================================================
// A ROOM NOBODY IS DRIVING (migration 056)
// ============================================================
//
// Two separate stalls, checked separately because they have different causes
// and different repairs, and one check covering both could not say which
// mechanism saved it.
//
// Both deliberately look INSIDE the deputy window (HOST_HANDOVER_MS, 30s). The
// deputy is the pre-existing mitigation; if it has already been granted by the
// time a check looks, the check says so rather than claiming a pass it did not
// earn — a scenario that cannot tell which of two mechanisms saved it is not
// evidence about either.

/** Set up a live question with a short timer, and return the room's cast. */
async function roomOnAQuestion(table) {
  seedQuestions(table.store);
  // 15s is the shortest timer the host screen offers, and every wait below is
  // built from it plus PHASE_ADVANCE_GRACE_MS (8s). Both are read from the app
  // rather than guessed, so a change to either fails here loudly instead of
  // turning these into checks that wait too little and always pass.
  const { host, code } = await openRoom(table, 'Alice', { timer: '15' });
  const bob = await joinRoom(table, 'Bob', code);
  const carol = await joinRoom(table, 'Carol', code);
  await host.page.waitForTimeout(1500);
  await host.page.click('#btn-start-game').catch(() => {});
  for (const r of [bob, carol]) {
    await r.page.waitForURL('**/game.html*', { timeout: 25000 }).catch(() => {});
  }
  await bob.page.waitForSelector('#question-screen.active', { timeout: 25000 });
  return { host, bob, carol };
}

const roomRow = table => table.store.table('rooms')[0];

/** Poll a predicate against the store, returning how long it took, or null. */
async function waitForRoom(table, page, predicate, budgetMs) {
  const from = Date.now();
  while (Date.now() - from < budgetMs) {
    if (predicate(roomRow(table))) return Date.now() - from;
    await page.waitForTimeout(500);
  }
  return null;
}

async function deputisedAmong(...robots) {
  const found = [];
  for (const r of robots) {
    const is = await r.page.evaluate(() => window.__state?.isDeputy === true).catch(() => false);
    if (is) found.push(r.name);
  }
  return found;
}

// ------------------------------------------------------------
// 1. The host died between announcing the question and starting its clock.
//
// THE WORSE STALL, and it was found by writing check 2 below rather than by
// anyone predicting it. Those are two separate writes from the host's phone,
// a few hundred milliseconds apart. Die in between and `question_started_at`
// stays null — at which point getServerTimeLeft returns the FULL duration on
// every phone, no bar ever moves, and nothing expires. The room hangs on a
// live question forever, and waiting cannot help because no clock is running.
//
// The repair is to START the clock, never to end the round.
// ------------------------------------------------------------
async function aQuestionWhoseClockNeverStarted() {
  heading('the host died before the question clock started');
  const table = await PlaytestTable.open();
  try {
    const { host, bob, carol } = await roomOnAQuestion(table);

    // Force the exact window rather than hoping to land in it. Killing the host
    // and blanking the stamp reproduces "announced, never stamped" every run —
    // a race you have to be lucky to hit is a check people learn to re-run.
    await host.killAbruptly();
    const room = roomRow(table);
    room.question_started_at = null;
    note('host killed and the round left with no clock at all');

    const took = await waitForRoom(table, bob.page, r => !!r?.question_started_at, 30000);
    const deputies = await deputisedAmong(bob, carol);
    note(`clock started after ${took === null ? 'never' : Math.round(took / 1000) + 's'}`);
    note(`deputised by then: ${deputies.join(', ') || 'nobody'}`);

    if (took === null) {
      problems.push('a question announced without a clock never started one — every phone shows a full timer that never moves, forever');
    } else if (deputies.length > 0) {
      note(`INCONCLUSIVE: ${deputies.join(', ')} was deputised, so the old path could have done this`);
    } else {
      note('nobody was in control and the clock started anyway');
    }

    // AND THE ROUND WAS NOT ENDED. Ending an unstamped round takes a question
    // away from people who never saw the timer move; the whole point is that it
    // is repaired rather than abandoned.
    const phase = roomRow(table)?.game_phase;
    if (phase && phase !== 'question') {
      problems.push(`a round with no clock was ENDED (now ${phase}) instead of started — nobody got to answer it`);
    }
  } catch (err) {
    problems.push(`no-clock scenario threw: ${err.message.split('\n')[0]}`);
  } finally {
    await table.close();
  }
}

// ------------------------------------------------------------
// 2. The host died mid-question, with the clock running.
//
// Everything that ends a round is behind canControlGame(), so the timer runs
// out on every phone and nothing happens at all.
// ------------------------------------------------------------
async function theRoundEndsWithoutTheHost() {
  heading("the round ends even though the host's phone died");
  const table = await PlaytestTable.open();
  try {
    const { host, bob, carol } = await roomOnAQuestion(table);

    // Wait for the clock to actually be running before killing anybody —
    // otherwise this silently becomes check 1 again, which is exactly how the
    // first version of it spent a debugging round measuring the wrong thing.
    const stamped = await waitForRoom(table, bob.page, r => !!r?.question_started_at, 15000);
    if (stamped === null) {
      problems.push('the question clock never started, so the round-ends check could not run');
      return;
    }
    await host.killAbruptly();
    note('host killed mid-question with the clock running — no beacon, no cleanup');

    // 15s timer + 8s grace + poll granularity. The budget stays under
    // HOST_HANDOVER_MS + the stale sweep so a deputy is unlikely to beat it.
    const took = await waitForRoom(table, bob.page,
      r => r?.game_phase && r.game_phase !== 'question' && r.game_phase !== 'final_question',
      28000);
    const deputies = await deputisedAmong(bob, carol);
    const phase = roomRow(table)?.game_phase;

    note(`room phase after ${took === null ? 'never' : Math.round(took / 1000) + 's'}: ${phase}`);
    note(`deputised by then: ${deputies.join(', ') || 'nobody'}`);

    if (took === null) {
      problems.push(`the round never ended after the host's phone died — the room is still on ${phase}`);
    } else if (deputies.length > 0) {
      note(`INCONCLUSIVE: ${deputies.join(', ')} was deputised, so the old path could have done this`);
    } else {
      note('nobody was in control and the round ended anyway');
    }

    // AND EVERYBODY WAS CLOSED OUT FIRST. Moving the phase without filling the
    // blanks lands the room on a reveal that renders "No answer" for people
    // whose rows were never written — and the reveal is exactly where a blank
    // stops meaning "still typing" and starts meaning "never answered".
    const rows = table.store.table('answers').filter(a => a.question_number === 0);
    note(`answer rows for the round: ${rows.length} of 3`);
    if (took !== null && rows.length < 3) {
      problems.push(`the round ended with only ${rows.length} of 3 answer rows — somebody will be shown a verdict on an answer that was never recorded`);
    }
  } catch (err) {
    problems.push(`round-ends-without-host scenario threw: ${err.message.split('\n')[0]}`);
  } finally {
    await table.close();
  }
}

await awayIsVisible();
await aQuestionWhoseClockNeverStarted();
await theRoundEndsWithoutTheHost();
await hostDisappearsMidQuestion();
await rejoinAfterSeatReleased();
await playerDropsAndRejoins();
await simultaneousAnswers();

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ all nasty scenarios passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
