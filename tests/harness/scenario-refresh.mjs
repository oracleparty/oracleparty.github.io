// Scenario: a player and the host REFRESH at every phase of a game.
// Stress plan item 4 (docs/STRESS-PLAN.md, 2026-11-06).
//
// One reload per phase, alternating host and guest:
//   question@1 (Bob, before answering) · reveal@1 (Alice, the host) ·
//   scores@2 (Bob) · question@3 (Alice, before answering) ·
//   final wager (Bob, after locking 20) · final question (Alice)
// Eight seconds after each reload the phone must be on the ROOM's phase and
// round, showing that phase's screen; if the round is a question it has not
// answered, it must be able to answer; its bet buttons must be exactly the bets
// the server still holds. At the end: results, every scoreboard agrees with the
// rows, bets 1..N each spent once, and Bob's locked final bet survived.
//
// Run: node tests/harness/scenario-refresh.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const N = 5;
const SCREEN_FOR_PHASE = {
  countdown: 'countdown-screen', question: 'question-screen', reveal: 'reveal-screen',
  answer_reveal: 'reveal-screen', scores_reveal: 'scores-screen', difficulty_vote: 'question-screen',
  final_wager: 'final-wager-screen', final_question: 'question-screen', results: 'results-screen',
};
const PLAN = [
  { phase: 'question', round: 1, who: 'Bob', beforeAnswering: true },
  { phase: 'reveal', round: 1, who: 'Alice' },
  { phase: 'scores_reveal', round: 2, who: 'Bob' },
  { phase: 'question', round: 3, who: 'Alice', beforeAnswering: true },
  { phase: 'final_wager', round: N - 1, who: 'Bob', afterLocking: true },
  { phase: 'final_question', round: N, who: 'Alice', beforeAnswering: true },
];

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
  const everyone = [host, ...guests];
  const byName = Object.fromEntries(everyone.map(r => [r.name, r]));
  await host.page.waitForTimeout(1200);
  for (const g of guests) await clickIfReady(g, '#btn-ready');
  await host.page.waitForTimeout(800);
  await clickIfReady(host, '#btn-start-game');
  for (const r of everyone) await r.page.waitForURL('**/game.html*', { timeout: 25000 });

  const consoleErrors = [];
  for (const r of everyone) {
    r.page.on('pageerror', e => consoleErrors.push(`${r.name} THREW: ${(e.message || String(e)).slice(0, 200)}`));
    r.page.on('console', m => {
      const t = m.text();
      if (m.type() === 'error' && !/\[Slow(Submit|Request)\]/.test(t)) consoleErrors.push(`${r.name} console: ${t.slice(0, 200)}`);
    });
  }

  const room = () => table.store.table('rooms')[0];
  const pid = name => table.store.table('players').find(p => p.display_name === name)?.id;
  const rowsOf = name => table.store.table('answers').filter(a => String(a.player_id) === String(pid(name)));
  const done = new Set();
  let step = 0, pending = null, lastKey = null, since = Date.now(), finished = false;
  const deadline = Date.now() + 330000;

  while (!finished && Date.now() < deadline) {
    const rm = room();
    const key = `${rm?.game_phase}@${rm?.current_question}`;
    if (key !== lastKey) { lastKey = key; since = Date.now(); note(`room: ${key} ${at()}`); }

    // Judge a reload eight seconds on.
    if (pending && Date.now() - pending.at > 8000) {
      const r = byName[pending.who];
      // Sampled over ~2s, not once: a screen fade leaves NO screen active for
      // half a second, and one glance inside it reads as "no screen at all".
      let own = null;
      for (let i = 0; i < 6; i++) {
        own = await r.page.evaluate(() => ({ phase: window.__state?.gamePhase, q: window.__state?.currentQuestion,
          screen: document.querySelector('.screen.active')?.id || null })).catch(() => null);
        if (own?.screen) break;
        await r.page.waitForTimeout(400);
      }
      const rq = room()?.current_question, rp = room()?.game_phase;
      const hasRow = rowsOf(r.name).some(a => a.question_number === rq && String(a.submitted_answer || '').trim() !== '__WAGER_LOCKED__');
      const canType = await r.page.locator('#answer-input').isEnabled().catch(() => false)
        && await r.page.locator('#answer-input').isVisible().catch(() => false);
      note(`${r.name} 8s after reloading at ${pending.label}: own ${JSON.stringify(own)}, room ${rp}@${rq}`);
      if (!own || own.phase !== rp || own.q !== rq) {
        problems.push(`${r.name} reloaded at ${pending.label} and 8s later its game said ${own?.phase}@${own?.q} while the room was on ${rp}@${rq}`);
      } else if (['question', 'final_question'].includes(rp) && !hasRow && !(own.screen === 'question-screen' && canType)) {
        problems.push(`${r.name} reloaded during ${rp}@${rq}, has not answered, and cannot (screen ${own.screen})`);
      } else if (!(['question', 'final_question'].includes(rp) && hasRow && own.screen === 'reveal-screen')
                 && SCREEN_FOR_PHASE[rp] && own.screen !== SCREEN_FOR_PHASE[rp]) {
        problems.push(`${r.name} reloaded at ${pending.label}: right phase, wrong screen (${own.screen}, want ${SCREEN_FOR_PHASE[rp]})`);
      }
      pending = null;
    }

    const plan = PLAN[step];
    for (const r of everyone) {
      const s = await screenOf(r);
      // Time to reload this phone?
      if (!pending && plan && r.name === plan.who && rm?.game_phase === plan.phase && rm?.current_question === plan.round) {
        const own = await r.page.evaluate(() => window.__state?.gamePhase).catch(() => null);
        const lockedOk = !plan.afterLocking || await r.page.locator('#fw-status:not(.hidden)').isVisible().catch(() => false);
        if (own === plan.phase && lockedOk && Date.now() - since > 1500) {
          pending = { who: r.name, label: `${plan.phase}@${plan.round}`, at: Date.now() };
          step++;
          note(`reloading ${r.name} at ${plan.phase}@${plan.round} ${at()}`);
          await r.page.reload({ waitUntil: 'domcontentloaded' }).catch(e => problems.push(`${r.name} reload failed: ${e.message.split('\n')[0]}`));
          continue;
        }
      }
      if (s === 'question-screen') {
        const n = await r.page.evaluate(() => window.__state?.currentQuestion).catch(() => null);
        if (n == null || done.has(`${r.name}:${n}`)) continue;
        // The phone due to reload "before answering" holds off until it has.
        if (plan?.beforeAnswering && plan.who === r.name && plan.round === n) continue;
        if (!await r.page.locator('#answer-input').isEnabled().catch(() => false)) continue;
        const qText = await r.page.textContent('#question-text').catch(() => '');
        const qn = (qText.match(/Test question (\d+)/) || [])[1];
        if (!qn) continue;
        if (n < N) {
          // THE BET BUTTONS MUST BE THE BETS THE SERVER STILL HOLDS — a reload
          // rebuilds them from the rows, so this is where a wrong rebuild shows.
          const grid = await r.page.evaluate(() => [...document.querySelectorAll('#question-screen .wager-btn')]
            .map(b => ({ v: Number(b.dataset.value), used: b.classList.contains('wager-btn--correct') || b.classList.contains('wager-btn--incorrect') }))).catch(() => []);
          if (grid.length === N) {
            const spent = new Set(rowsOf(r.name).filter(a => a.question_number < n && a.wager != null).map(a => a.wager));
            const shown = new Set(grid.filter(b => b.used).map(b => b.v));
            if ([...spent].some(v => !shown.has(v)) || [...shown].some(v => !spent.has(v))) {
              problems.push(`round ${n}: ${r.name}'s bet buttons show used [${[...shown].sort()}] but the server spent [${[...spent].sort()}]`);
            }
          }
          await r.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first().click({ timeout: 1500 }).catch(() => {});
        }
        await r.page.fill('#answer-input', r.name === 'Carol' ? 'carol guess' : `Answer ${qn}`).catch(() => {});
        if (await clickIfReady(r, '#btn-submit-answer')) done.add(`${r.name}:${n}`);
      } else if (s === 'final-wager-screen') {
        if (!done.has(`${r.name}:fw`)) {
          await r.page.locator('#final-wager-screen [data-wager="20"]').first().click({ timeout: 1500 }).catch(() => {});
          await r.page.locator('#final-wager-screen .dv-option[data-difficulty="medium"]').first().click({ timeout: 1500 }).catch(() => {});
          if (await r.page.locator('#fw-status:not(.hidden)').isVisible().catch(() => false)) done.add(`${r.name}:fw`);
        }
        // The host waits for the scheduled reload on this screen to have happened.
        if (r === host && !(plan?.phase === 'final_wager')) await clickIfReady(host, '#btn-fw-reveal');
      } else if (s === 'reveal-screen') {
        const holdForReload = plan && plan.phase === rm?.game_phase && plan.round === rm?.current_question;
        if (r === host && !holdForReload && !pending && ['reveal', 'answer_reveal'].includes(rm?.game_phase) && Date.now() - since > 2500) {
          await clickIfReady(host, '#btn-next-question');
        }
      } else if (s === 'scores-screen') {
        const holdForReload = plan && plan.phase === rm?.game_phase && plan.round === rm?.current_question;
        if (r === host && !holdForReload && !pending && Date.now() - since > 2000) await clickIfReady(host, '#btn-scores-action');
      } else if (s === 'podium-screen') {
        await clickIfReady(r, '#podium-screen');
      } else if (s === 'results-screen' && r === host) {
        finished = true;
      }
    }
    await host.page.waitForTimeout(300);
  }
  await host.page.waitForTimeout(3000);

  if (step < PLAN.length) problems.push(`only ${step} of ${PLAN.length} reloads happened (stuck before ${PLAN[step]?.phase}@${PLAN[step]?.round})`);
  if (!finished) problems.push(`the game never reached results — stuck on ${lastKey}`);
  for (const name of ['Alice', 'Bob', 'Carol']) {
    const rs = rowsOf(name).sort((a, b) => a.question_number - b.question_number);
    note(`${name}'s rows: ${JSON.stringify(rs.map(a => `${a.question_number}:${a.submitted_answer || '(blank)'}/${a.wager}/${a.score_earned}`))}`);
    const bets = rs.filter(a => a.question_number < N).map(a => a.wager);
    if (new Set(bets).size !== bets.length) problems.push(`${name} spent a bet twice: ${JSON.stringify(bets)}`);
    const blanks = rs.filter(a => !String(a.submitted_answer || '').trim()).map(a => a.question_number);
    if (blanks.length) problems.push(`${name} has a blank for round(s) ${blanks.join(', ')} — a reload cost them the round`);
  }
  const bobFinal = rowsOf('Bob').find(a => a.question_number === N);
  if (bobFinal && bobFinal.wager !== 20) problems.push(`Bob locked 20 on the final wager, reloaded, and the final stood at ${bobFinal.wager}`);

  const boards = [];
  for (const r of everyone) {
    boards.push({ name: r.name, board: await r.page.evaluate(() => [...document.querySelectorAll('#results-list .results-row')].map(row => {
      const t = row.textContent.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
      const nums = t.match(/-?\d+/g) || [];
      return `${(row.querySelector('[class*="name"]')?.textContent || '').trim().split(/\s/)[0]}=${nums[nums.length - 1] ?? '?'}`;
    })).catch(() => []) });
  }
  const ref = boards.find(b => b.board.length);
  for (const b of boards) {
    note(`${b.name}'s scoreboard: ${JSON.stringify(b.board)}`);
    if (finished && ref && JSON.stringify(b.board) !== JSON.stringify(ref.board)) problems.push(`scoreboards disagree: ${ref.name} vs ${b.name}`);
  }
  if (finished && ref) {
    for (const entry of ref.board) {
      const nm = entry.slice(0, entry.lastIndexOf('=')), val = Number(entry.slice(entry.lastIndexOf('=') + 1));
      if (!pid(nm)) continue;
      const total = rowsOf(nm).reduce((t, a) => t + (a.score_earned || 0), 0);
      if (total !== val) problems.push(`the scoreboard says ${nm} has ${val}; the stored rows add up to ${total}`);
    }
  }
  const notMine = table.store.table('error_logs').filter(e => String(e.message || '').includes('AnswerNotMine'));
  if (notMine.length) problems.push(`${notMine.length} false [AnswerNotMine] report(s) — first: ${notMine[0].message}`);
  if (consoleErrors.length) {
    for (const e of consoleErrors.slice(0, 5)) note(`console: ${e}`);
    problems.push(`${consoleErrors.length} console error(s) — first: ${consoleErrors[0]}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}
console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ refresh scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
