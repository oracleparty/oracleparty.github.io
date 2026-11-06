// Scenario: the final question on a very slow phone, revealed early by the host.
// A follow-up to the 2026-11-06 stress playtest (docs/STRESS-PLAN.md).
//
// `scenario-badnetwork --lag=3000 --on=Bob` once showed Bob's own game going
// answer_reveal@5 -> final_question@5: the FINAL QUESTION came back after its
// answers had been revealed. The final round swaps its question for one that
// matches the difficulty vote, so every phone must fetch the new question list
// before it can draw the round — and handleRoomChange then called
// handlePhaseTransition('final_question') when that fetch came back, without
// asking whether the phone had moved on while it waited.
//
// SET, NOT RACED: Bob's link goes to 6s just before the host reveals the final
// question; Alice and Carol answer at once and the host presses Reveal Results
// the moment it can. So the reveal reaches Bob while his list fetch is still
// out, every time.
//
// What must hold: once Bob's game has shown the final round's answers it never
// goes back to the final question; the reveal he ends on names the question the
// room actually asked; and the game finishes with every board agreeing.
//
// Run: node tests/harness/scenario-finalslow.mjs [--lag=6000]
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const N = 5;
const LAG = Number((process.argv.find(a => a.startsWith('--lag=')) || '').split('=')[1] || 6000);
const problems = [];
const note = m => console.log('   ·', m);
const table = await PlaytestTable.open();
const t0 = Date.now();
const at = () => `+${Math.round((Date.now() - t0) / 1000)}s`;
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
      // Mixed, so the final question really is swapped for the vote's level.
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
  await host.page.click(`[data-setting="questionsPerGame"] [data-value="${N}"]`);
  await host.page.click('[data-setting="questionTimer"] [data-value="15"]').catch(() => {});
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);
  const code = await host.textOf('#lobby-code');
  const guests = [];
  for (const name of ['Bob', 'Carol']) {
    const g = await table.seat(name);
    await g.page.addInitScript(n => localStorage.setItem('oracle_party_display_name', n), name);
    await g.goto('join.html');
    await g.page.fill('#code-input', code);
    await g.page.click('#btn-join');
    await g.page.waitForURL('**/lobby.html*', { timeout: 20000 });
    guests.push(g);
  }
  const [bob, carol] = guests;
  const everyone = [host, bob, carol];
  await host.page.waitForTimeout(1200);
  for (const g of guests) await clickIfReady(g, '#btn-ready');
  await host.page.waitForTimeout(800);
  await clickIfReady(host, '#btn-start-game');
  for (const r of everyone) await r.page.waitForURL('**/game.html*', { timeout: 25000 });

  // Bob's own game, phase by phase, sampled in his page.
  await bob.page.evaluate(() => {
    window.__trail = []; let last = null;
    setInterval(() => {
      const st = window.__state; if (!st) return;
      const k = `${st.gamePhase}@${st.currentQuestion}`;
      if (k !== last) { window.__trail.push(k); last = k; }
    }, 50);
  });

  const room = () => table.store.table('rooms')[0];
  const done = new Set();
  let slowed = false, lastKey = null, since = Date.now(), finished = false;
  let bobRevealText = null;
  const deadline = Date.now() + 300000;
  while (!finished && Date.now() < deadline) {
    const rm = room();
    const key = `${rm?.game_phase}@${rm?.current_question}`;
    if (key !== lastKey) { lastKey = key; since = Date.now(); note(`room: ${key} ${at()}`); }
    for (const r of everyone) {
      const s = await screenOf(r);
      if (s === 'question-screen') {
        const n = await r.page.evaluate(() => window.__state?.currentQuestion).catch(() => null);
        if (n == null || done.has(`${r.name}:${n}`)) continue;
        if (r === bob && n === N) continue;   // Bob is too slow to answer the final
        if (!await r.page.locator('#answer-input').isEnabled().catch(() => false)) continue;
        const qText = await r.page.textContent('#question-text').catch(() => '');
        const qn = (qText.match(/Test question (\d+)/) || [])[1];
        if (!qn) continue;
        if (n < N) await r.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first().click({ timeout: 1500 }).catch(() => {});
        await r.page.fill('#answer-input', `Answer ${qn}`).catch(() => {});
        if (await clickIfReady(r, '#btn-submit-answer')) done.add(`${r.name}:${n}`);
      } else if (s === 'final-wager-screen') {
        if (!done.has(`${r.name}:fw`)) {
          await r.page.locator('#final-wager-screen [data-wager="10"]').first().click({ timeout: 1500 }).catch(() => {});
          await r.page.locator('#final-wager-screen .dv-option[data-difficulty="hard"]').first().click({ timeout: 1500 }).catch(() => {});
          if (await r.page.locator('#fw-status:not(.hidden)').isVisible().catch(() => false)) done.add(`${r.name}:fw`);
        }
        if (r === host && done.has('Bob:fw') && done.has('Carol:fw') && done.has('Alice:fw')) {
          if (!slowed) { bob.slowConnection(LAG); slowed = true; note(`Bob is on a ${LAG}ms link from here ${at()}`); }
          await clickIfReady(host, '#btn-fw-reveal');
        }
      } else if (s === 'reveal-screen') {
        if (r === bob && rm?.current_question === N && ['answer_reveal', 'scores_reveal'].includes(rm?.game_phase)) {
          const own = await bob.page.evaluate(() => window.__state?.gamePhase).catch(() => null);
          if (own === 'answer_reveal') bobRevealText = (await bob.page.textContent('#reveal-question-text').catch(() => '')).trim();
        }
        if (r !== host) continue;
        // The host reveals the moment it can — on the final round, early.
        if (rm?.current_question === N && rm?.game_phase === 'final_question') { await clickIfReady(host, '#btn-next-question'); continue; }
        if (['reveal', 'answer_reveal'].includes(rm?.game_phase) && Date.now() - since > (rm.current_question === N ? 12000 : 1500)) {
          await clickIfReady(host, '#btn-next-question');
        }
      } else if (s === 'scores-screen') {
        if (r === host && Date.now() - since > 1500) await clickIfReady(host, '#btn-scores-action');
      } else if (s === 'podium-screen') {
        await clickIfReady(r, '#podium-screen');
      } else if (s === 'results-screen' && r === host) {
        finished = true;
      }
    }
    await host.page.waitForTimeout(250);
  }
  await host.page.waitForTimeout(4000 + LAG);

  const trail = await bob.page.evaluate(() => window.__trail).catch(() => []);
  note(`Bob's own game: ${trail.join(' -> ')}`);
  const finalIdx = trail.findIndex(k => /^(reveal|answer_reveal|scores_reveal)@5$/.test(k));
  const backAfter = finalIdx >= 0 ? trail.slice(finalIdx + 1).find(k => k === `final_question@${N}`) : null;
  if (!slowed) problems.push('the final wager never completed, so the slow link was never applied');
  if (backAfter) {
    problems.push(`Bob's game went back to ${backAfter} after it had shown the final round's answers (${trail.slice(finalIdx).join(' -> ')}) — a question-list fetch came back and redrew a round that was over`);
  }
  const finalQid = room()?.question_ids?.[N];
  const finalText = table.store.table('questions').find(q => String(q.id) === String(finalQid))?.question;
  note(`the room's final question: ${JSON.stringify(finalText)}; Bob's reveal showed ${JSON.stringify(bobRevealText)}`);
  if (bobRevealText && finalText && bobRevealText !== finalText) {
    problems.push(`Bob's final reveal shows "${bobRevealText}" but the room asked "${finalText}" — the reveal was drawn from the old question list`);
  }
  if (!finished) problems.push(`the game never reached results — stuck on ${lastKey}`);
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}
console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ final-slow scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
