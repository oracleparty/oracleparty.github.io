// Scenario: the host presses Next on a slow link and a room re-read lands in
// the gap. Found by the stress playtest, 2026-11-06 (docs/STRESS-PLAN.md).
//
// `scenario-badnetwork --lag=1500 --on=Alice` froze 3 runs in 3 at the same
// place: the room re-asked round 3 and the host sat on round 3's scoreboard
// with Next refused for ever. The mechanism:
//
//   * Next Question moves this phone to the next round AT ONCE and writes the
//     room behind it (clear the clock, then the phase) — on a 1500ms link that
//     is ~2s during which the phone is AHEAD of the room;
//   * the 60-second room poll (syncToCurrentState) happened to land in that
//     gap, read the room still on the scoreboard, saw a DIFFERENT round number
//     and adopted it — the direction rule was only ever asked when the round
//     number matched — so the host went BACKWARDS to the scoreboard;
//   * the phase write then read `state.currentQuestion` after its own await and
//     announced the OLD round again, and `_advancedFrom` refused every later
//     press of Next, because this phone had already advanced out of that round.
//
// SET, NOT RACED: instead of waiting for the 60s poll to collide, this fires
// the same re-read on purpose the moment the host presses Next — exactly what a
// host who glances at another app and comes back does (a `visibilitychange`).
//
// Run: node tests/harness/scenario-staleresync.mjs [--lag=1500]
import { PlaytestTable } from './harness.js';
import { isStaleRoomEvent } from '../../js/game/phase-order.js';

const CATEGORY = 'history';
const LAG = Number((process.argv.find(a => a.startsWith('--lag=')) || '').split('=')[1] || 1500);
const problems = [];
const note = m => console.log('   ·', m);

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
      acceptable_answers: [], incorrect_answers: [], categories: [CATEGORY], subcategory: null,
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
  await clickIfReady(bob, '#btn-ready');
  await host.page.waitForTimeout(800);
  await clickIfReady(host, '#btn-start-game');
  for (const r of [host, bob]) await r.page.waitForURL('**/game.html*', { timeout: 25000 });

  host.slowConnection(LAG);
  note(`Alice (host) is on a ${LAG}ms round trip`);

  // Every phase/round the host's own GAME passes through, sampled in the page.
  await host.page.evaluate(() => {
    window.__trail = []; let last = null;
    setInterval(() => {
      const st = window.__state;
      if (!st) return;
      const k = `${st.gamePhase}@${st.currentQuestion}`;
      if (k !== last) { window.__trail.push(k); last = k; }
    }, 50);
  });

  const roomRounds = [];
  let pokes = 0;
  const done = new Set();
  let finished = false;
  const deadline = Date.now() + 200000;
  while (!finished && Date.now() < deadline) {
    const rm = table.store.table('rooms')[0];
    if (rm && roomRounds[roomRounds.length - 1] !== rm.current_question) roomRounds.push(rm.current_question);
    for (const r of [host, bob]) {
      const s = await screenOf(r);
      if (s === 'question-screen') {
        const n = await r.page.evaluate(() => window.__state?.currentQuestion).catch(() => null);
        const key = `${r.name}:${n}`;
        if (done.has(key)) continue;
        if (!await r.page.locator('#answer-input').isEnabled().catch(() => false)) continue;
        await r.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first().click({ timeout: 1500 }).catch(() => {});
        await r.page.fill('#answer-input', `${r.name} ${n}`).catch(() => {});
        if (await clickIfReady(r, '#btn-submit-answer')) done.add(key);
      } else if (s === 'final-wager-screen') {
        await r.page.locator('#final-wager-screen [data-wager="10"]').first().click({ timeout: 1500 }).catch(() => {});
        await r.page.locator('#final-wager-screen .dv-option[data-difficulty="medium"]').first().click({ timeout: 1500 }).catch(() => {});
        if (r === host) await clickIfReady(host, '#btn-fw-reveal');
      } else if (s === 'scores-screen' && r === host) {
        const label = (await host.page.textContent('#btn-scores-action').catch(() => '') || '').trim();
        if (/next question/i.test(label) && await clickIfReady(host, '#btn-scores-action')) {
          // The re-read lands while the press is still being written.
          await host.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
          pokes++;
          note(`host pressed "${label}" and the room was re-read straight away (poke ${pokes})`);
          await host.page.waitForTimeout(3000);
        } else {
          await clickIfReady(host, '#btn-scores-action');
        }
      } else if (s === 'reveal-screen' && r === host) {
        await clickIfReady(host, '#btn-next-question');
      } else if (s === 'podium-screen') {
        await clickIfReady(r, '#podium-screen');
      } else if (s === 'results-screen' && r === host) {
        finished = true;
      }
    }
    await host.page.waitForTimeout(400);
  }

  const trail = await host.page.evaluate(() => window.__trail).catch(() => []);
  note(`host's own game: ${trail.join(' -> ')}`);
  note(`room rounds in order: ${roomRounds.join(' -> ')}`);
  if (pokes < 2) problems.push(`only ${pokes} Next press(es) were re-read in flight, so the check barely ran`);
  for (let i = 1; i < trail.length; i++) {
    const [cp, cq] = trail[i - 1].split('@');
    const [ip, iq] = trail[i].split('@');
    if (isStaleRoomEvent({ incomingPhase: ip, incomingQuestion: Number(iq), currentPhase: cp, currentQuestion: Number(cq) })) {
      problems.push(`the host's game went BACKWARDS: ${trail[i - 1]} -> ${trail[i]} — a room read taken while its own Next was still being written was believed`);
    }
  }
  for (let i = 1; i < roomRounds.length; i++) {
    if (roomRounds[i] < roomRounds[i - 1]) {
      problems.push(`the ROOM went back from round ${roomRounds[i - 1]} to round ${roomRounds[i]} — the host announced a round that was already over`);
    }
  }
  if (!finished) {
    const rm = table.store.table('rooms')[0];
    problems.push(`the game never reached results — stuck on ${rm?.game_phase}@${rm?.current_question}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}
console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ stale-resync scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
