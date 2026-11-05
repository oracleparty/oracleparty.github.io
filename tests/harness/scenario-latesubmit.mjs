// Scenario: the host submits in the last second and the answer lands too late.
//
// Reported 2026-11-05, game-breaking: "I answered, then it appeared the bot and
// my friend hadn't answered, then it kept jumping back and forth between the
// same question and answer, kept saying no answer and minimum wager ... couldn't
// even advance". Owner hosted, question ~3, a friend and the bot in the room.
//
// The mechanism, reproduced here by SETTING the timing rather than racing for
// it: Submit draws the reveal at once (optimistic, 2026-10-28) and the write
// carries on. The host's own clock expires meanwhile, the blank fill gives every
// player without a row a blank at their lowest wager ("No answer", minimum
// wager) and the room moves to `reveal`. The write then arrives after the
// server's deadline, is refused "time is up", and the old code put the host
// back on the QUESTION screen — with the room already on the reveal, whose
// phase had been handled, so nothing ever brought them back, and the Next
// button lives on the reveal. Every re-Submit went round the same loop.
//
// `store.slowFunction('op_submit_answer', 5000)` holds the request before it
// runs, so it reaches the server after `timer + 3s`. The host then waits, as a
// person does, rather than pressing on at once.
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);
const LATE_ROUND = 1;

const table = await PlaytestTable.open();
const clickIfReady = async (r, sel) => {
  const el = r.page.locator(sel).first();
  if (!await el.isVisible().catch(() => false)) return false;
  if (!await el.isEnabled().catch(() => false)) return false;
  await el.click().catch(() => {});
  return true;
};
const screenOf = r => r.page.evaluate(() => document.querySelector('.screen.active')?.id || '(none)').catch(() => '(nav)');

try {
  const rows = [];
  for (let i = 1; i <= 40; i++) {
    rows.push({ id: `q${i}`, question: `Test question ${i}?`, correct_answer: `Answer ${i}`,
      acceptable_answers: [], incorrect_answers: [`W-${i}-a`, `W-${i}-b`],
      categories: [CATEGORY], subcategory: null,
      difficulty: ['easy', 'medium', 'hard'][i % 3], format: 'open', fun_fact: null, discarded: false });
  }
  table.store.seed('questions', rows);

  const host = await table.seatSignedIn('Alice', { tier: 'Scholar' });
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click('[data-setting="questionsPerGame"] [data-value="5"]');
  await host.page.click('[data-setting="questionTimer"] [data-value="15"]').catch(() => {});
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);
  const code = await host.textOf('#lobby-code');

  const bob = await table.seat('Bob');
  await bob.page.addInitScript(() => localStorage.setItem('oracle_party_display_name', 'Bob'));
  await bob.goto('join.html');
  await bob.page.fill('#code-input', code);
  await bob.page.click('#btn-join');
  await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await bob.page.waitForTimeout(1200);
  await clickIfReady(host, '#btn-add-bot');
  await host.page.waitForTimeout(1500);
  await clickIfReady(bob, '#btn-ready');
  await host.page.waitForTimeout(800);
  await clickIfReady(host, '#btn-start-game');
  await host.page.waitForURL('**/game.html*', { timeout: 20000 });

  // Every 50ms: is the host's SCREEN a question while their GAME is past it?
  await host.page.evaluate(() => {
    window.__strandedMs = 0; window.__flips = []; let last = null, t0 = null;
    setInterval(() => {
      const s = document.querySelector('.screen.active')?.id;
      const st = window.__state;
      const k = `${s}|${st?.gamePhase}@${st?.currentQuestion}`;
      if (k !== last) { window.__flips.push(`${Math.round(performance.now())} ${k}`); last = k; }
      const stranded = s === 'question-screen' && st && !['question', 'final_question', 'loading'].includes(st.gamePhase);
      if (stranded) { t0 ??= performance.now(); window.__strandedMs = Math.max(window.__strandedMs, performance.now() - t0); }
      else t0 = null;
    }, 50);
  });

  heading(`playing: on round ${LATE_ROUND} the host submits in the last second, on a 5s server`);
  const done = new Set();
  let finished = false;
  const deadline = Date.now() + 200000;
  while (!finished && Date.now() < deadline) {
    const s = await screenOf(host);
    if (s === 'question-screen') {
      const n = await host.page.evaluate(() => window.__state?.currentQuestion);
      const live = await host.page.locator('#answer-input').isVisible().catch(() => false)
        && await host.page.locator('#answer-input').isEnabled().catch(() => false);
      if (!done.has(n) && live) {
        if (n === LATE_ROUND) {
          const left = await host.page.evaluate(() => Number(document.querySelector('#timer-text')?.textContent));
          if (!(left <= 1)) { await host.page.waitForTimeout(150); continue; }
          table.store.slowFunction('op_submit_answer', 5000);
          setTimeout(() => table.store.slowFunction('op_submit_answer', 0), 6000);
        }
        await host.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first().click({ timeout: 2000 }).catch(() => {});
        await host.page.fill('#answer-input', `alice ${n}`).catch(() => {});
        if (await clickIfReady(host, '#btn-submit-answer')) {
          done.add(n);
          if (n === LATE_ROUND) { note('submitted with under a second left; waiting like a person'); await host.page.waitForTimeout(12000); }
        }
      }
    } else if (s === 'final-wager-screen') {
      await host.page.locator('#final-wager-screen [data-wager="10"]').first().click().catch(() => {});
      await host.page.locator('#final-wager-screen .dv-option[data-difficulty="medium"]').first().click().catch(() => {});
      await clickIfReady(host, '#btn-fw-reveal');
    } else if (s === 'results-screen') {
      finished = true;
    } else {
      for (const sel of ['#btn-next-question', '#btn-scores-action', '#podium-screen']) await clickIfReady(host, sel);
    }
    if (await screenOf(bob) === 'podium-screen') await clickIfReady(bob, '#podium-screen');
    await host.page.waitForTimeout(600);
  }

  const stranded = await host.page.evaluate(() => window.__strandedMs).catch(() => 0);
  const flips = await host.page.evaluate(() => window.__flips).catch(() => []);
  note(`host screen/phase trace:\n      ${flips.join('\n      ')}`);
  note(`longest stretch on the question screen with the round over: ${Math.round(stranded)}ms`);
  if (stranded > 2000) {
    problems.push(`the host sat on the question screen for ${Math.round(stranded)}ms while the room was past it — `
      + 'the late answer was refused and sent them back to a round that had closed (the 2026-11-05 loop)');
  }
  if (!finished) problems.push('the game never reached results — the host could not advance past the late round');
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}
console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ late-submit scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
