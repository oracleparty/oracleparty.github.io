// Scenario: the clock runs out on a player who has not answered, and the host
// has not pressed Reveal Results yet.
//
// Reported 2026-10-27, every round it happened: the host had answered early and
// sat on the reveal screen; the friend let the timer run out; the host's screen
// went on reading "Waiting..." for the friend — "stuck until I pressed reveal".
// The round HAD closed: the friend's phone auto-submitted and the host's phone
// filled in a blank before writing time's-up. Only the label was wrong, and it
// pointed the host at the wrong person.
//
// Checked in both directions, because either alone cannot fail:
//   * while the clock is still running, Bob's row DOES read "Waiting..." —
//     an answer may be on its way, and that rule must survive;
//   * once the room is on time's up, nobody's row reads "Waiting...".
//
// Run: node tests/harness/scenario-timesup.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

const table = await PlaytestTable.open();
try {
  const rows = [];
  for (let i = 1; i <= 30; i++) {
    rows.push({
      id: `q${i}`, question: `Test question ${i}?`, correct_answer: `Answer ${i}`,
      acceptable_answers: [], incorrect_answers: [`Wrong ${i}`],
      categories: [CATEGORY], subcategory: null,
      difficulty: ['easy', 'medium', 'hard'][i % 3], format: 'open',
      fun_fact: null, discarded: false,
    });
  }
  table.store.seed('questions', rows);

  async function seat(name) {
    const r = await table.seat(name);
    await r.page.addInitScript(n => localStorage.setItem('oracle_party_display_name', n), name);
    return r;
  }

  heading('a two-player room on the shortest clock');
  const host = await seat('Alice');
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click('[data-setting="questionsPerGame"] [data-value="5"]').catch(() => {});
  await host.page.click('[data-setting="questionTimer"] [data-value="15"]').catch(() => {});
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);
  const room = () => table.store.table('rooms')[0];
  const code = await host.textOf('#lobby-code');

  const bob = await seat('Bob');
  await bob.goto('join.html');
  await bob.page.waitForSelector('#code-input', { timeout: 15000 });
  await bob.page.fill('#code-input', code);
  await bob.page.click('#btn-join');
  await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(2000);
  await bob.page.click('#btn-ready').catch(() => {});
  await host.page.waitForTimeout(800);
  for (let i = 0; i < 12 && room()?.status !== 'playing'; i++) {
    await host.page.click('#btn-start-game').catch(() => {});
    await host.page.waitForTimeout(700);
  }
  for (const r of [host, bob]) {
    await r.page.waitForURL('**/game.html*', { timeout: 25000 })
      .catch(() => problems.push(`${r.name} never reached the game`));
  }

  heading('Alice answers; Bob does not');
  await host.page.waitForSelector('#answer-input', { state: 'visible', timeout: 25000 });
  await host.page.waitForSelector('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)', { state: 'visible', timeout: 10000 });
  await host.page.locator('.wager-btn').first().click();
  await host.page.fill('#answer-input', 'Something');
  await host.page.click('#btn-submit-answer');
  await host.page.waitForSelector('#reveal-screen.active', { timeout: 10000 })
    .catch(() => problems.push('Alice submitted and never reached the reveal screen'));

  const waitingRows = () => host.page.evaluate(() =>
    [...document.querySelectorAll('#reveal-answers .answer-row')]
      .filter(r => /Waiting/i.test(r.textContent)).length).catch(() => -1);

  await host.page.waitForTimeout(1500);
  const before = await waitingRows();
  note(`clock running, phase ${room()?.game_phase}: rows reading Waiting = ${before}`);
  if (room()?.game_phase === 'question' && before < 1) {
    problems.push('while the clock is still running Bob does not read "Waiting..." — an answer may still be on its way');
  }

  // THE MESSAGE THAT ENDS THE ROUND NEVER REACHES BOB (owner's photo,
  // 2026-10-28: question 10 of 20, timer at 0, "Time's up — your last answer
  // stands", and the game stuck there). On a bad connection one Realtime event
  // goes missing, and nothing brought the phone back: the backstop ignored the
  // server saying the round was over, and the 60s poll only caught up a phone
  // that had been in the BACKGROUND. The next room event is the round closing;
  // swallow it, for Bob only — a lost frame belongs to one connection.
  bob.deafTables = new Set(['rooms']);

  heading('the clock runs out; the host does NOT press Reveal Results');
  for (let i = 0; i < 60 && room()?.game_phase !== 'reveal'; i++) await host.page.waitForTimeout(500);
  note(`room phase: ${room()?.game_phase}`);
  if (room()?.game_phase !== 'reveal') problems.push(`the round never closed (phase ${room()?.game_phase})`);
  // Sampled for 4 seconds, not once: the label is wrong for as long as the host
  // waits, so a single glance after a redraw would be luck.
  let worst = 0;
  for (let i = 0; i < 8; i++) {
    await host.page.waitForTimeout(500);
    if (room()?.game_phase !== 'reveal') break;
    worst = Math.max(worst, await waitingRows());
  }
  const bobRow = await host.page.evaluate(() =>
    [...document.querySelectorAll('#reveal-answers .answer-row')]
      .map(r => r.textContent.replace(/\s+/g, ' ').trim()).find(t => /Bob/.test(t)) || null);
  note(`after time's up, Bob's row on Alice's screen: ${JSON.stringify(bobRow)}`);
  if (worst > 0) {
    problems.push(`time is up and Alice's screen still reads "Waiting..." on ${worst} row(s) — the round closed, it is waiting on the host`);
  }
  if (!bobRow) problems.push('Bob has no row on the reveal at all');

  heading('Bob, who never heard the round close, catches up by himself');
  bob.deafTables = null;   // he hears again; only the closing event was lost
  // The backstop asks 8s after the clock and then every 3s; well inside 20s.
  // Judged on the PHASE each phone believes, not the screen: Bob's own
  // auto-submit puts the reveal screen up while his game still thinks it is
  // on the question, which is the stuck state, only better dressed.
  for (const r of [host, bob]) {
    const t0 = Date.now();
    let st = null;
    while (Date.now() - t0 < 20000) {
      st = await r.page.evaluate(() => ({
        screen: document.querySelector('.screen.active')?.id,
        phase: window.__state?.gamePhase,
      })).catch(() => null);
      if (st && st.phase !== 'question') break;
      await r.page.waitForTimeout(500);
    }
    note(`${r.name}: ${JSON.stringify(st)} after ${Date.now() - t0}ms (room: ${room()?.game_phase})`);
    if (!st || st.phase === 'question') {
      problems.push(`${r.name} missed the message that closed the round and never caught up — still on the question, which is the owner's photo`);
    }
  }
} catch (e) {
  problems.push(`scenario crashed: ${e.stack || e}`);
} finally {
  await table.close();
}

console.log(problems.length ? `\nFAILED (${problems.length}):\n - ${problems.join('\n - ')}` : '\nPASSED');
process.exit(problems.length ? 1 : 0);
