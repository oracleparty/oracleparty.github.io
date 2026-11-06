// Scenario: the HOST's phone dies at a chosen phase and the others must finish.
// Stress plan item 5 (docs/STRESS-PLAN.md, 2026-11-06).
//
// The host is killed outright (robot.killAbruptly: no beacon, no cleanup — a
// dead battery) when the room reaches --phase in round 1 (or the final round).
// The two players left must be able to finish the game: the round ends on the
// server's clock, the deputy rule hands them the advance buttons after
// HOST_HANDOVER_MS, and promotion after STALE_TIMEOUT_MS. Nobody may be stuck.
//
// Run: node tests/harness/scenario-hostleaves.mjs --phase=question|reveal|scores_reveal|final_wager|final_question
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const N = 5;
const PHASE = (process.argv.find(a => a.startsWith('--phase=')) || '').split('=')[1] || 'question';
const ROUND = ['final_wager'].includes(PHASE) ? N - 1 : PHASE === 'final_question' ? N : 1;
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
  await host.page.waitForTimeout(1200);
  for (const g of guests) await clickIfReady(g, '#btn-ready');
  await host.page.waitForTimeout(800);
  await clickIfReady(host, '#btn-start-game');
  for (const r of [host, ...guests]) await r.page.waitForURL('**/game.html*', { timeout: 25000 });

  const consoleErrors = [];
  for (const r of guests) {
    r.page.on('pageerror', e => consoleErrors.push(`${r.name} THREW: ${(e.message || String(e)).slice(0, 200)}`));
    r.page.on('console', m => {
      const t = m.text();
      if (m.type() === 'error' && !/\[Slow(Submit|Request)\]/.test(t)) consoleErrors.push(`${r.name} console: ${t.slice(0, 200)}`);
    });
  }

  const room = () => table.store.table('rooms')[0];
  let alive = [host, ...guests];
  const done = new Set();
  let killedAt = null, lastKey = null, since = Date.now(), longestStill = 0, finished = false;
  const onResults = new Set();
  const deadline = Date.now() + 420000;

  while (!finished && Date.now() < deadline) {
    const rm = room();
    const key = `${rm?.game_phase}@${rm?.current_question}`;
    if (key !== lastKey) {
      if (killedAt) longestStill = Math.max(longestStill, Date.now() - since);
      lastKey = key; since = Date.now(); note(`room: ${key} ${at()}`);
    }
    if (!killedAt && rm?.game_phase === PHASE && rm?.current_question === ROUND && Date.now() - since > 1500) {
      await host.killAbruptly();
      killedAt = Date.now();
      alive = guests;
      note(`the host's phone died at ${key} ${at()}`);
    }
    for (const r of alive) {
      const s = await screenOf(r);
      if (s === 'question-screen') {
        const n = await r.page.evaluate(() => window.__state?.currentQuestion).catch(() => null);
        if (n == null || done.has(`${r.name}:${n}`)) continue;
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
          await r.page.locator('#final-wager-screen .dv-option[data-difficulty="medium"]').first().click({ timeout: 1500 }).catch(() => {});
          if (await r.page.locator('#fw-status:not(.hidden)').isVisible().catch(() => false)) done.add(`${r.name}:fw`);
        }
        // Before the kill the host is the one who reveals; afterwards whoever
        // holds the controls.
        if (r === host ? !(PHASE === 'final_wager' && ROUND === rm?.current_question) : true) await clickIfReady(r, '#btn-fw-reveal');
      } else if (s === 'reveal-screen') {
        const holdForKill = r === host && PHASE === rm?.game_phase && ROUND === rm?.current_question;
        if (!holdForKill && ['reveal', 'answer_reveal'].includes(rm?.game_phase) && Date.now() - since > 2500) {
          await clickIfReady(r, '#btn-next-question');
        }
      } else if (s === 'scores-screen') {
        const holdForKill = r === host && PHASE === rm?.game_phase && ROUND === rm?.current_question;
        if (!holdForKill && Date.now() - since > 2000) await clickIfReady(r, '#btn-scores-action');
      } else if (s === 'podium-screen') {
        await clickIfReady(r, '#podium-screen');
      } else if (s === 'results-screen' && killedAt && guests.includes(r)) {
        onResults.add(r.name);
        finished = guests.every(g => onResults.has(g.name));
      }
    }
    await guests[0].page.waitForTimeout(300);
  }
  await guests[0].page.waitForTimeout(3000);

  note(`the longest the room sat still after the host died: ${Math.round(longestStill / 1000)}s`);
  if (!killedAt) problems.push(`the room never reached ${PHASE}@${ROUND}, so the host was never killed`);
  const screens = await Promise.all(guests.map(screenOf));
  note(`where the players ended: ${guests.map((g, i) => `${g.name}=${screens[i]}`).join(', ')}`);
  if (!finished || screens.some(s => s !== 'results-screen')) {
    problems.push(`the game did not finish without the host (killed at ${PHASE}@${ROUND}): room ${lastKey}, players on ${screens.join(', ')}`);
  }
  const hostRow = table.store.table('players').find(p => p.display_name === 'Alice');
  note(`the host's seat afterwards: ${hostRow ? `still there, is_host=${hostRow.is_host}` : 'released'}`);
  const pid = name => table.store.table('players').find(p => p.display_name === name)?.id;
  for (const name of ['Bob', 'Carol']) {
    const rs = table.store.table('answers').filter(a => String(a.player_id) === String(pid(name)))
      .sort((a, b) => a.question_number - b.question_number);
    note(`${name}'s rows: ${JSON.stringify(rs.map(a => `${a.question_number}:${a.submitted_answer || '(blank)'}/${a.wager}`))}`);
    const bets = rs.filter(a => a.question_number < N).map(a => a.wager);
    if (new Set(bets).size !== bets.length) problems.push(`${name} spent a bet twice: ${JSON.stringify(bets)}`);
  }
  const boards = [];
  for (const r of guests) {
    boards.push({ name: r.name, board: await r.page.evaluate(() => [...document.querySelectorAll('#results-list .results-row')].map(row => {
      const t = row.textContent.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
      const nums = t.match(/-?\d+/g) || [];
      return `${(row.querySelector('[class*="name"]')?.textContent || '').trim().split(/\s/)[0]}=${nums[nums.length - 1] ?? '?'}`;
    })).catch(() => []) });
  }
  for (const b of boards) note(`${b.name}'s scoreboard: ${JSON.stringify(b.board)}`);
  if (finished && boards[0].board.length && JSON.stringify(boards[0].board) !== JSON.stringify(boards[1].board)) {
    problems.push(`the two players' scoreboards disagree: ${JSON.stringify(boards[0].board)} vs ${JSON.stringify(boards[1].board)}`);
  }
  if (consoleErrors.length) {
    for (const e of consoleErrors.slice(0, 5)) note(`console: ${e}`);
    problems.push(`${consoleErrors.length} console error(s) — first: ${consoleErrors[0]}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}
console.log('\n' + (problems.length ? `✗ PROBLEMS (host killed at ${PHASE}):` : `✓ host-leaves scenario passed (killed at ${PHASE})`));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
