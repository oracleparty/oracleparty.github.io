// Scenario: play a game, hit Play Again, play a second one.
//
// This is the most common thing real players do — finish, go again — and the
// least tested. Play Again resets a large amount of state by hand, and
// anything it forgets leaks into the next game: stale scores, wagers that
// cannot be picked again, answers from the previous round.
//
// Run: node tests/harness/scenario-playagain.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

function seedQuestions(store, n = 60) {
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

async function answerQuestion(r, text) {
  const input = r.page.locator('#answer-input');
  try {
    await input.waitFor({ state: 'visible', timeout: 10000 });
  } catch { return false; }
  const wager = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
  if (await wager.isVisible().catch(() => false)) await wager.click().catch(() => {});
  await input.fill(text).catch(() => {});
  if (!await r.page.isEnabled('#btn-submit-answer').catch(() => false)) return false;
  await r.page.click('#btn-submit-answer').catch(() => {});
  return true;
}

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);

  async function seat(name) {
    const r = await table.seat(name);
    await r.page.addInitScript(n =>
      localStorage.setItem('oracle_party_display_name', n), name);
    return r;
  }

  const host = await seat('Alice');
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
  const code = await host.textOf('#lobby-code');

  const bob = await seat('Bob');
  await bob.goto('join.html');
  await bob.page.waitForSelector('#code-input', { timeout: 15000 });
  await bob.page.fill('#code-input', code);
  await bob.page.click('#btn-join');
  await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1500);

  const everyone = [host, bob];

  /** Drive a whole game from whatever screen each robot is on. */
  async function playAGame(label) {
    heading(label);
    // Wait for the lobby to be ready rather than clicking blind: after Play
    // Again the page has only just loaded, and a click that lands too early
    // does nothing while looking like a failure to start.
    await host.page.waitForSelector('#btn-start-game', { state: 'visible', timeout: 20000 }).catch(() => {});
    let started = false;
    for (let attempt = 0; attempt < 12 && !started; attempt++) {
      await clickIfReady(host, '#btn-start-game');
      await host.page.waitForTimeout(700);
      const room = table.store.table('rooms')[0];
      started = room?.status === 'playing' || (room?.question_ids || []).length > 0;
    }
    if (!started) problems.push(`${label}: Start Game never took effect`);
    for (const r of everyone) {
      await r.page.waitForURL('**/game.html*', { timeout: 25000 })
        .catch(() => problems.push(`${label}: ${r.name} never reached the game`));
    }

    const answered = new Set();
    let done = false;
    for (let step = 0; step < 170 && !done; step++) {
      for (const r of everyone) {
        const room = table.store.table('rooms')[0];
        // Stop driving the moment the ROOM says the game is over. Checking the
        // screen instead races the transition: the results screen can be up
        // while .screen.active still reports scores, and one extra click there
        // sends the host back to the lobby — which then looks like "Play Again
        // is missing" when it was never reached.
        if (room?.game_phase === 'results') break;
        const screen = await activeScreen(r);
        const q = room?.current_question ?? 0;

        if (screen === 'question-screen') {
          const key = `${r.name}:${q}`;
          if (!answered.has(key)) {
            if (await answerQuestion(r, `Answer ${q + 1}`)) answered.add(key);
          }
        } else if (screen === 'final-wager-screen') {
          const key = `${r.name}:final`;
          if (!answered.has(key)) {
            const opt = r.page.locator('#final-wager-screen [data-wager]').first();
            if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
            if (await clickIfReady(r, '#btn-fw-lock')) answered.add(key);
          }
          if (r === host) await clickIfReady(r, '#btn-fw-reveal');
        } else if (screen !== 'results-screen' && r === host) {
          if (screen === 'reveal-screen') await clickIfReady(r, '#btn-next-question');
          if (screen === 'scores-screen') await clickIfReady(r, '#btn-scores-action');
        }
      }
      const room = table.store.table('rooms')[0];
      if (room?.game_phase === 'results') done = true;
      await host.page.waitForTimeout(420);
    }

    if (!done) {
      const room = table.store.table('rooms')[0];
      problems.push(`${label}: never reached results (phase ${room?.game_phase}, question ${room?.current_question})`);
    } else {
      note(`${label} finished; ${table.store.table('answers').length} answers in the room`);
    }
    return done;
  }

  // ---- GAME ONE ----
  if (!await playAGame('game one')) throw new Error('first game did not finish');

  for (const r of everyone) {
    const url = r.page.url().split('/').pop();
    const screen = await activeScreen(r);
    const btns = await r.page.evaluate(() =>
      [...document.querySelectorAll('button')]
        .filter(b => b.offsetParent !== null)
        .map(b => `${b.id || '(no id)'}:"${b.textContent.trim().slice(0, 18)}"`)
    ).catch(() => []);
    note(`${r.name} at end of game one -> ${url} / ${screen} / visible buttons: ${btns.join(', ')}`);
  }

  // ---- PLAY AGAIN ----
  heading('play again');
  await host.page.waitForTimeout(1500);
  const playAgainVisible = await host.page.locator('#btn-play-again').isVisible().catch(() => false);
  if (!playAgainVisible) {
    problems.push(`Play Again button is not visible on ${await activeScreen(host)}`);
  } else {
    await host.page.click('#btn-play-again').catch(() => {});
  }
  // Non-host is offered a notice rather than being yanked out.
  await bob.page.waitForTimeout(2000);
  await clickIfReady(bob, '#btn-return-lobby');
  await clickIfReady(bob, '#btn-play-again');

  for (const r of everyone) {
    await r.page.waitForURL('**/lobby.html*', { timeout: 25000 })
      .catch(() => problems.push(`${r.name} did not get back to the lobby after Play Again`));
  }
  await host.page.waitForTimeout(2500);
  note(`back in lobby: ${table.store.table('players').map(p => p.display_name).join(', ')}`);

  // The room itself must be genuinely reset, not merely re-labelled.
  const room = table.store.table('rooms')[0];
  if (room) {
    if (room.game_phase !== 'lobby') problems.push(`room phase is "${room.game_phase}" after Play Again, expected "lobby"`);
    if (room.status !== 'lobby') problems.push(`room status is "${room.status}" after Play Again, expected "lobby"`);
    if ((room.question_ids || []).length !== 0) problems.push(`question_ids still holds ${room.question_ids.length} entries after Play Again`);
    if (room.current_question !== 0) problems.push(`current_question is ${room.current_question} after Play Again, expected 0`);
  }
  const leftoverAnswers = table.store.table('answers').length;
  note(`answers left in the room: ${leftoverAnswers}`);
  if (leftoverAnswers > 0) {
    problems.push(`${leftoverAnswers} answers from the previous game were not cleared — they will be counted again`);
  }

  // ---- GAME TWO ----
  const secondFinished = await playAGame('game two');

  if (secondFinished) {
    for (const r of everyone) {
      const board = await r.page.evaluate(() =>
        [...document.querySelectorAll('#results-list .results-row')]
          .map(row => row.textContent.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim())
      ).catch(() => []);
      note(`${r.name} game-two board: ${JSON.stringify(board).slice(0, 140)}`);
    }

    // Wagers are 1..N used once each. If the second game inherited the first
    // game's used-wager map, players would run out of wagers to pick.
    for (const r of everyone) {
      const exhausted = await r.page.evaluate(() =>
        (window.__state?.usedWagers instanceof Map)
          ? window.__state.usedWagers.size
          : -1).catch(() => -1);
      note(`${r.name} used-wager count at end of game two: ${exhausted}`);
      if (exhausted > 6) {
        problems.push(`${r.name} carried wagers across games — ${exhausted} used in a 5-question game`);
      }
    }
  }

  for (const r of everyone) {
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ play again passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
