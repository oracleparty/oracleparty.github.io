// Scenario: three robots play a complete game, then leave.
//
// Checks the things that only break with several players at once:
//   * every client agrees on the final scores
//   * Realtime channels are actually released on exit (the cleanup() leak)
//   * nobody's console throws along the way
//
// Run: node tests/harness/scenario-fullgame.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const QUESTIONS = 5;          // + 1 final wager question
const FINAL_WAGER_SECONDS = 20;  // mirrors FINAL_WAGER_TIMER_SECONDS in js/constants.js
const problems = [];
const note = m => console.log('   ·', m);

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

/** Answer the current question, if the question screen is showing. */
async function answerQuestion(robot, text) {
  const input = robot.page.locator('#answer-input');
  try {
    await input.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    const screen = await robot.page.evaluate(() => document.querySelector('.screen.active')?.id);
    note(`${robot.name}: no answer input (on ${screen})`);
    return false;
  }
  // Pick a wager if one is offered and none is preselected.
  const wager = robot.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
  if (await wager.count() > 0 && await wager.isVisible().catch(() => false)) {
    await wager.click().catch(() => {});
  }
  await input.fill(text).catch(() => {});
  const enabled = await robot.page.isEnabled('#btn-submit-answer').catch(() => false);
  if (!enabled) {
    note(`${robot.name}: submit still disabled after wager+text`);
    return false;
  }
  await robot.page.click('#btn-submit-answer').catch(e => note(`${robot.name}: submit click failed`));
  return true;
}

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);

  // --- Set up the room ---
  const host = await seatWithName(table, 'Alice');
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  // Shortest game available, so a full playthrough stays quick.
  await host.page.click('[data-setting="questionsPerGame"] [data-value="5"]').catch(() => {});
  await host.page.waitForTimeout(300);
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);

  const code = await host.textOf('#lobby-code');
  note(`room ${code}`);

  const bob = await seatWithName(table, 'Bob');
  const carol = await seatWithName(table, 'Carol');
  for (const r of [bob, carol]) {
    await r.goto('join.html');
    await r.page.waitForSelector('#code-input', { timeout: 15000 });
    await r.page.fill('#code-input', code);
    await r.page.click('#btn-join');
    await r.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  }
  await host.page.waitForTimeout(1500);

  const everyone = [host, bob, carol];

  // Channels held during a normal game — the baseline for the leak check.
  const channelsInLobby = await host.openChannelCount();
  note(`host holds ${channelsInLobby} realtime channels in the lobby`);

  // --- Start the game ---
  await host.page.click('#btn-start-game').catch(() => {});
  await host.page.waitForURL('**/game.html*', { timeout: 25000 });
  for (const r of [bob, carol]) {
    await r.page.waitForURL('**/game.html*', { timeout: 25000 })
      .catch(() => problems.push(`${r.name} never reached the game screen`));
  }
  note('all three reached game.html');

  // --- Play the rounds ---
  //
  // Driven by whatever screen each robot is actually on, rather than a fixed
  // sequence of clicks. Phase changes arrive over Realtime and do not land in
  // lockstep, so a scripted order desynchronises within a round or two and
  // then reports failures that are only the script's own impatience.

  // Pages navigate on their own (results -> lobby, room deleted -> home), so
  // any read can land mid-navigation. That is normal, not a failure.
  const activeScreen = r => r.page
    .evaluate(() => document.querySelector('.screen.active')?.id || '(none)')
    .catch(() => '(navigating)');

  const clickIfReady = async (r, selector) => {
    const el = r.page.locator(selector);
    if (!await el.isVisible().catch(() => false)) return false;
    if (!await el.isEnabled().catch(() => false)) return false;
    await el.click().catch(() => {});
    return true;
  };

  const answered = new Set();     // "name:round" already submitted

  async function takeTurn(r, roundHint) {
    const screen = await activeScreen(r);

    if (screen === 'question-screen') {
      const key = `${r.name}:${roundHint}`;
      if (answered.has(key)) return screen;
      const text = r.name === 'Bob' ? 'definitely wrong' : `Answer ${roundHint + 1}`;
      if (await answerQuestion(r, text)) answered.add(key);
      return screen;
    }

    if (screen === 'final-wager-screen') {
      // Carol never touches this screen. The final wager had no timer at all
      // until a playtest found one person who had put their phone down holding
      // the last round open, so what is being measured here is that going quiet
      // costs 0 rather than the state.finalWager default of 20 — committing
      // that default would take 20 points off somebody for being away, which no
      // other missed round in this game does.
      if (r.name === 'Carol') return screen;

      // A wager amount must be chosen before the lock button does anything.
      const key = `${r.name}:final`;
      if (!answered.has(key)) {
        const opt = r.page.locator('#final-wager-screen [data-wager]').first();
        if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
        if (await clickIfReady(r, '#btn-fw-lock')) answered.add(key);
      }
      if (r === host) await clickIfReady(r, '#btn-fw-reveal');
      return screen;
    }

    // Results is the finish line — clicking onit would send the host back to
    // the lobby and destroy the thing being measured.
    if (screen === 'results-screen') return screen;

    // Only the host advances reveal and scores.
    if (r === host) {
      if (screen === 'reveal-screen') await clickIfReady(r, '#btn-next-question');
      if (screen === 'scores-screen') await clickIfReady(r, '#btn-scores-action');
    }
    return screen;
  }

  let round = 0;
  let lastQuestionSeen = -1;
  let reachedResults = false;
  let waitedOutWagerClock = false;

  for (let step = 0; step < 160 && !reachedResults; step++) {
    for (const r of everyone) {
      await takeTurn(r, round).catch(() => '(navigating)');
    }

    // Track progress by the room's own state, not one client's screen: clients
    // reach results at different moments and may navigate away afterwards.
    const room = table.store.table('rooms')[0];

    // Sit through the 20-second wager clock once, so the timeout actually
    // fires. Without this the loop races past the screen and the assertion
    // below would pass on a wager Carol simply never got the chance to make.
    if (room && room.game_phase === 'final_wager' && !waitedOutWagerClock) {
      waitedOutWagerClock = true;
      note(`waiting out the ${FINAL_WAGER_SECONDS}s final-wager clock with Carol away`);
      await host.page.waitForTimeout((FINAL_WAGER_SECONDS + 3) * 1000);
    }

    if (room && room.game_phase === 'results') reachedResults = true;
    if (room && room.current_question !== lastQuestionSeen) {
      lastQuestionSeen = room.current_question;
      round = room.current_question ?? round;
      note(`round ${round} (phase ${room.game_phase})`);
    }
    await host.page.waitForTimeout(450);
  }

  if (!reachedResults) {
    const room = table.store.table('rooms')[0];
    problems.push(`game never reached results (stuck on phase ${room?.game_phase}, question ${room?.current_question})`);
  } else {
    note(`game completed; ${table.store.table('answers').length} answers recorded`);
  }

  await host.page.waitForTimeout(2500);

  // --- Where did everyone end up? ---
  for (const r of everyone) {
    note(`${r.name} is on ${await activeScreen(r)}`);
  }

  // --- The final wager clock ---
  const finalQ = QUESTIONS; // final wager rides on question_number === QUESTIONS
  const carolId = table.store.table('players').find(p => p.display_name === 'Carol')?.id;
  const carolFinal = table.store.table('answers')
    .find(a => String(a.player_id) === String(carolId) && a.question_number === finalQ);
  note(`Carol never touched the wager screen; her locked wager: ${carolFinal ? carolFinal.wager : '(none)'}`);
  if (!carolFinal) {
    problems.push('a player who ignored the final wager screen locked nothing at all — the 20s clock never committed for her, so the room would still be waiting');
  } else if (carolFinal.wager !== 0) {
    problems.push(`a player who ignored the final wager screen was committed to ${carolFinal.wager} points, not 0 — being away must not cost more than a missed round does`);
  }

  // --- Do the clients agree on scores? ---
  const scoreboards = [];
  for (const r of everyone) {
    // Compare what the game decided, not how it is decorated. Each client
    // hides its own honk button, so raw row text differs between players even
    // when every score agrees.
    const board = await r.page.evaluate(() =>
      [...document.querySelectorAll('#results-list .results-row')]
        .map(row => {
          const text = row.textContent.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
          const numbers = text.match(/-?\d+/g) || [];
          const name = (row.querySelector('[class*="name"]')?.textContent || '').trim();
          return `${name}=${numbers[numbers.length - 1] ?? '?'}`;
        })
        .filter(Boolean)).catch(() => []);
    scoreboards.push({ name: r.name, board });
  }
  for (const s of scoreboards) note(`${s.name} scoreboard: ${JSON.stringify(s.board).slice(0, 120)}`);

  const nonEmpty = scoreboards.filter(s => s.board.length > 0);
  if (nonEmpty.length > 1) {
    const first = JSON.stringify(nonEmpty[0].board);
    for (const s of nonEmpty.slice(1)) {
      if (JSON.stringify(s.board) !== first) {
        problems.push(`scoreboards disagree: ${nonEmpty[0].name} vs ${s.name}`);
      }
    }
  }

  // --- THE LEAK CHECK ---
  // Leaving must release every Realtime channel. Before the cleanup() fix this
  // left a full set subscribed on every exit, so handlers fired once more per
  // game played in a session.
  const beforeLeave = await bob.openChannelCount();
  const quit = bob.page.locator('#btn-quit-game');
  const canQuit = await quit.isVisible().catch(() => false);

  if (!canQuit) {
    // Distinguish "cleanup is broken" from "the robot never triggered cleanup".
    // Reporting the second as the first is how a harness starts lying.
    note(`Bob could not leave: quit button not visible on ${await activeScreen(bob)} — leak check skipped`);
  } else {
    // Quit is tap-again-to-confirm on the same button, not a separate dialog:
    // the first tap only arms it, and it disarms itself after 3 seconds.
    await quit.click().catch(() => {});
    await bob.page.waitForTimeout(400);
    await quit.click().catch(() => {});
    await bob.page.waitForTimeout(2500);
    const afterLeave = await bob.openChannelCount();
    note(`Bob channels: ${beforeLeave} in game -> ${afterLeave} after leaving`);
    if (afterLeave >= beforeLeave && beforeLeave > 0) {
      problems.push(`leaving did not release Realtime channels (${beforeLeave} -> ${afterLeave})`);
    }
  }

  // --- Console errors ---
  for (const r of everyone) {
    if (r.failedRequests.length) note(`${r.name} failed requests: ${[...new Set(r.failedRequests)].join(', ')}`);
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ full game passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
