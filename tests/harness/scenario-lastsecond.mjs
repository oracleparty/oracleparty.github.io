// Scenario: somebody answers in the LAST SECOND of EVERY round, on a slow server.
//
// Stress plan item 2 (docs/STRESS-PLAN.md, 2026-11-06). scenario-latesubmit
// proves the host is not stranded when ONE late answer is refused. This plays a
// whole game where, every round, a different player — the host, a guest, the
// final round's bettor — presses Submit with under a second left while every
// `op_submit_answer` is held 5s, so it reaches the server after `timer + 3s`
// and is refused. Everybody else answers early. A bot sits in the room, as it
// did in the 2026-11-05 game.
//
// Two ways of being late, alternated, because the draft (migration 081)
// changes what the late player should end up with:
//   fast   — types and presses Submit at once. No draft is saved (Submit
//            cancels the pending one), so the refused answer leaves the blank
//            the fill wrote: score 0, or the LOCKED bet lost on the final.
//   paused — types, stops for a few seconds (a draft is saved), then presses
//            Submit late. The fill uses the draft: judged like an answer.
//
// The late player always picks their HIGHEST unspent bet, never the lowest,
// so a phone that loses track of which bet the server spent cannot agree with
// the server by coincidence (the fill's own choice is the lowest).
//
// What must hold, every round, on every phone:
//   * no phone sits on a question screen once its own game is past it;
//   * the bet buttons a phone offers are exactly the bets the server still
//     holds for that player — a spent bet offered again is silently swapped
//     by the server for another, which is "I bet 5 and it said I bet 1";
//   * after the round closes, a late player's own row says what the SERVER
//     stored, not the answer it refused;
// and at the end: the game reaches results, every scoreboard agrees, and it
// agrees with the stored rows.
//
// Run: node tests/harness/scenario-lastsecond.mjs [--final=Bob] [--final-mode=fast|paused]
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const QUESTIONS = 5;   // rounds 0..4, then the final round 5
const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const FINAL_LATE = arg('final', 'Bob');
const FINAL_MODE = arg('final-mode', 'fast');
// round -> who is late, and how
const PLAN = {
  0: { who: 'Bob', mode: 'fast' },
  1: { who: 'Alice', mode: 'fast' },
  2: { who: 'Carol', mode: 'paused' },
  3: { who: 'Bob', mode: 'paused' },
  4: { who: 'Alice', mode: 'paused' },
  [QUESTIONS]: { who: FINAL_LATE, mode: FINAL_MODE },
};
// Long enough that a send made with the display reading 1 (up to ~2s left)
// still reaches the server after `timer + 3s`.
const HOLD_MS = 7000;

const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

const table = await PlaytestTable.open();
const clickIfReady = async (r, sel) => {
  const el = r.page.locator(sel).first();
  if (!await el.isVisible().catch(() => false)) return false;
  if (!await el.isEnabled().catch(() => false)) return false;
  await el.click().catch(() => {});
  return true;
};
const screenOf = r => r.page.evaluate(() => document.querySelector('.screen.active')?.id || '(none)').catch(() => '(nav)');
const timeLeft = r => r.page.evaluate(() => Number(document.querySelector('#timer-text')?.textContent)).catch(() => NaN);

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
  await host.page.click(`[data-setting="questionsPerGame"] [data-value="${QUESTIONS}"]`);
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
  const byName = Object.fromEntries(everyone.map(r => [r.name, r]));
  await host.page.waitForTimeout(1200);
  await clickIfReady(host, '#btn-add-bot');
  await host.page.waitForTimeout(1500);
  for (const g of guests) await clickIfReady(g, '#btn-ready');
  await host.page.waitForTimeout(800);
  await clickIfReady(host, '#btn-start-game');
  for (const r of everyone) await r.page.waitForURL('**/game.html*', { timeout: 25000 });

  const consoleErrors = [];
  for (const r of everyone) {
    r.page.on('pageerror', e => consoleErrors.push(`${r.name} THREW: ${(e.message || String(e)).slice(0, 200)}`));
    // [SlowSubmit] / [SlowRequest] are the app's own recorders reporting the
    // slowness this scenario injects on purpose — measurements, not faults.
    r.page.on('console', m => {
      const t = m.text();
      if (m.type() === 'error' && !/\[Slow(Submit|Request)\]/.test(t)) consoleErrors.push(`${r.name} console: ${t.slice(0, 200)}`);
    });
    // Every 50ms: is this phone's SCREEN a question while its GAME is past it?
    await r.page.evaluate(() => {
      window.__strandedMs = 0; let t0 = null;
      setInterval(() => {
        const s = document.querySelector('.screen.active')?.id;
        const st = window.__state;
        const stranded = s === 'question-screen' && st && !['question', 'final_question', 'loading', 'difficulty_vote'].includes(st.gamePhase);
        if (stranded) { t0 ??= performance.now(); window.__strandedMs = Math.max(window.__strandedMs, performance.now() - t0); }
        else t0 = null;
      }, 50);
    });
  }

  const room = () => table.store.table('rooms')[0];
  const playerId = name => table.store.table('players').find(p => p.display_name === name)?.id;
  const rowsOf = (name) => table.store.table('answers').filter(a => String(a.player_id) === String(playerId(name)));
  // The regular-round bets the server has spent for this player in rounds
  // before `round` — the same rule as op_next_wager / buildUsedWagersMap.
  const serverSpent = (name, round) => new Set(rowsOf(name)
    .filter(a => a.question_number < QUESTIONS && a.question_number < round
      && String(a.submitted_answer || '').trim() !== '__WAGER_LOCKED__' && a.wager != null)
    .map(a => a.wager));

  heading('playing: every round somebody presses Submit with under a second left, on a 5s server');
  const done = new Set();          // `${name}:${round}` submitted (or deliberately skipped)
  const typed = new Map();         // `${name}:${round}` -> text typed by a late player
  const gridChecked = new Set();
  const lateOutcome = [];          // what each late player did, to judge afterwards
  const honesty = new Map();       // round -> sampled own-row text on the late phone
  const lateAt = new Map();        // round -> when the late Submit was pressed
  let lastPhaseKey = null, phaseSince = Date.now();
  let finished = false;
  const deadline = Date.now() + 330000;

  while (!finished && Date.now() < deadline) {
    const rm = room();
    const phaseKey = `${rm?.game_phase}@${rm?.current_question}`;
    if (phaseKey !== lastPhaseKey) { lastPhaseKey = phaseKey; phaseSince = Date.now(); note(`room: ${phaseKey}`); }
    const round = rm?.current_question;
    const plan = PLAN[round];

    for (const r of everyone) {
      const s = await screenOf(r);
      if (s === 'question-screen') {
        const live = await r.page.locator('#answer-input').isVisible().catch(() => false)
          && await r.page.locator('#answer-input').isEnabled().catch(() => false);
        if (!live) continue;
        const n = await r.page.evaluate(() => window.__state?.currentQuestion).catch(() => null);
        if (n == null || n !== round) continue;
        const key = `${r.name}:${n}`;

        // THE BET BUTTONS MUST BE THE BETS THE SERVER STILL HOLDS.
        if (n < QUESTIONS && !gridChecked.has(key)) {
          const grid = await r.page.evaluate(() => [...document.querySelectorAll('#question-screen .wager-btn')]
            .map(b => ({ v: Number(b.dataset.value), used: b.classList.contains('wager-btn--correct') || b.classList.contains('wager-btn--incorrect') })))
            .catch(() => []);
          if (grid.length === QUESTIONS) {
            gridChecked.add(key);
            const spent = serverSpent(r.name, n);
            const shownUsed = new Set(grid.filter(b => b.used).map(b => b.v));
            const offeredButSpent = [...spent].filter(v => !shownUsed.has(v));
            const markedButFree = [...shownUsed].filter(v => !spent.has(v));
            if (offeredButSpent.length || markedButFree.length) {
              problems.push(`round ${n}: ${r.name}'s bet buttons disagree with the server — `
                + `server spent [${[...spent].sort((a, b) => a - b)}], the phone shows used [${[...shownUsed].sort((a, b) => a - b)}]`
                + (offeredButSpent.length ? `; it OFFERS ${offeredButSpent} again, which the server will silently swap for another bet` : '')
                + (markedButFree.length ? `; it hides ${markedButFree}, which the server says is still unspent` : ''));
            }
          }
        }
        if (done.has(key)) continue;

        const qText = await r.page.textContent('#question-text').catch(() => '');
        const qn = (qText.match(/Test question (\d+)/) || [])[1];
        if (!qn) continue;
        const answer = r.name === 'Carol' && !(plan?.who === 'Carol') ? 'carol guess' : `Answer ${qn}`;
        const isLate = plan?.who === r.name;

        if (!isLate) {
          // On time: the lowest bet, answer, Submit.
          if (n < QUESTIONS) await r.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first().click({ timeout: 1500 }).catch(() => {});
          await r.page.fill('#answer-input', answer).catch(() => {});
          if (await clickIfReady(r, '#btn-submit-answer')) done.add(key);
          continue;
        }

        const left = await timeLeft(r);
        const pickHighest = async () => {
          if (n >= QUESTIONS) return null;
          const btns = r.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)');
          const c = await btns.count();
          if (!c) return null;
          await btns.nth(c - 1).click({ timeout: 1500 }).catch(() => {});
          return Number(await btns.nth(c - 1).getAttribute('data-value').catch(() => null));
        };
        if (plan.mode === 'paused' && !typed.has(key) && left <= 6) {
          const bet = await pickHighest();
          await r.page.locator('#answer-input').pressSequentially(answer, { delay: 25 }).catch(() => {});
          typed.set(key, { text: answer, bet });
          note(`round ${n}: ${r.name} typed "${answer}"${bet ? ` on bet ${bet}` : ''} and stopped (a draft should save)`);
          continue;
        }
        if (!(left <= 1)) continue;
        let bet = typed.get(key)?.bet ?? null;
        if (plan.mode === 'fast') {
          bet = await pickHighest();
          await r.page.fill('#answer-input', answer).catch(() => {});
          typed.set(key, { text: answer, bet });
        }
        table.store.slowFunction('op_submit_answer', HOLD_MS);
        setTimeout(() => table.store.slowFunction('op_submit_answer', 0), HOLD_MS + 1500);
        if (await clickIfReady(r, '#btn-submit-answer')) {
          done.add(key);
          lateAt.set(n, Date.now());
          lateOutcome.push({ round: n, name: r.name, mode: plan.mode, text: answer, bet });
          note(`round ${n}: ${r.name} pressed Submit with ${left}s left (${plan.mode})${bet ? `, bet ${bet}` : ''} — held ${HOLD_MS}ms`);
        }
      } else if (s === 'final-wager-screen') {
        const key = `${r.name}:fw`;
        if (!done.has(key)) {
          // Short taps: a locked bet's buttons stop being clickable, and a
          // default click waits 30s for them, stalling the whole loop.
          await r.page.locator('#final-wager-screen [data-wager="20"]').first().click({ timeout: 1500 }).catch(() => {});
          await r.page.locator('#final-wager-screen .dv-option[data-difficulty="medium"]').first().click({ timeout: 1500 }).catch(() => {});
          if (await r.page.locator('#fw-status:not(.hidden)').isVisible().catch(() => false)) done.add(key);
        }
        if (r === host) await clickIfReady(host, '#btn-fw-reveal');
      } else if (s === 'reveal-screen') {
        // The late phone's own row, sampled once the refused send has come back.
        const lp = plan && byName[plan.who];
        if (lp === r && !honesty.has(round) && lateAt.has(round)
            && ['reveal', 'answer_reveal'].includes(rm?.game_phase)
            && Date.now() - lateAt.get(round) > HOLD_MS + 1000) {
          const own = await r.page.evaluate(nm => {
            const row = [...document.querySelectorAll('#reveal-answers .answer-row')]
              .find(x => (x.querySelector('.answer-row__name')?.textContent || '').includes(nm));
            return row ? (row.querySelector('.answer-row__answer')?.textContent || '').trim() : null;
          }, r.name).catch(() => null);
          honesty.set(round, own);
        }
        // A person waits for the round to close and to see everybody's answer
        // before pressing on — never "Reveal early" while somebody still has
        // time on the clock, or the late player is never late.
        const settled = !lateAt.has(round) || honesty.has(round)
          || Date.now() - lateAt.get(round) > HOLD_MS + 6000;
        if (r === host && settled && ['reveal', 'answer_reveal'].includes(rm?.game_phase)
            && Date.now() - phaseSince > 1500) {
          await clickIfReady(host, '#btn-next-question');
        }
      } else if (s === 'scores-screen') {
        if (r === host) await clickIfReady(host, '#btn-scores-action');
      } else if (s === 'podium-screen') {
        await clickIfReady(r, '#podium-screen');
      } else if (s === 'results-screen' && r === host) {
        finished = true;
      }
    }
    await host.page.waitForTimeout(250);
  }
  await host.page.waitForTimeout(4000);

  // ---------------- judging ----------------
  heading('what happened');
  if (!finished) problems.push(`the game never reached results — stuck on ${lastPhaseKey}`);
  for (const r of everyone) {
    const ms = await r.page.evaluate(() => window.__strandedMs).catch(() => 0);
    if (ms > 2000) problems.push(`${r.name} sat on the question screen for ${Math.round(ms)}ms while their game was past it`);
  }
  for (const k of Object.keys(PLAN)) {
    if (!lateOutcome.some(o => String(o.round) === k)) problems.push(`round ${k}: ${PLAN[k].who} never got to press Submit late, so that round tested nothing`);
  }

  for (const o of lateOutcome) {
    const row = rowsOf(o.name).find(a => a.question_number === o.round);
    const isFinal = o.round >= QUESTIONS;
    const shown = honesty.get(o.round);
    note(`round ${o.round} ${o.name} (${o.mode}): stored ${JSON.stringify(row && { answer: row.submitted_answer, wager: row.wager, score: row.score_earned })}; own screen showed ${JSON.stringify(shown)}`);
    if (!row) { problems.push(`round ${o.round}: ${o.name} has no answer row at all`); continue; }
    const text = String(row.submitted_answer || '').trim();
    if (o.mode === 'paused') {
      if (text !== o.text) problems.push(`round ${o.round}: ${o.name} typed "${o.text}" and paused (a draft), and the stored answer is "${text}"`);
      else if (!row.is_correct) problems.push(`round ${o.round}: ${o.name}'s drafted answer was right and stored wrong`);
      if (!isFinal && o.bet && row.wager !== o.bet) problems.push(`round ${o.round}: ${o.name}'s draft carried bet ${o.bet} and the stored bet is ${row.wager}`);
    } else if (text === o.text) {
      note(`round ${o.round}: ${o.name}'s late answer was ACCEPTED (it arrived inside the server's allowance)`);
    } else if (text !== '') {
      problems.push(`round ${o.round}: ${o.name}'s refused answer left "${text}" on the row`);
    }
    if (isFinal && row.wager !== 20) problems.push(`final round: ${o.name} locked 20 and the stored bet is ${row.wager}`);
    // The screen tells the truth: the late phone's own row shows what is STORED.
    if (shown != null && text && shown !== text) {
      problems.push(`round ${o.round}: ${o.name}'s own reveal row reads "${shown}" while the server stored "${text}"`);
    }
    if (shown != null && !text && shown === o.text) {
      problems.push(`round ${o.round}: ${o.name}'s own reveal row still reads their refused answer "${shown}" — the server stored a blank`);
    }
  }

  // Every scoreboard agrees, and agrees with the stored rows.
  const boards = [];
  for (const r of everyone) {
    const board = await r.page.evaluate(() => [...document.querySelectorAll('#results-list .results-row')].map(row => {
      const t = row.textContent.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
      const nums = t.match(/-?\d+/g) || [];
      const nm = (row.querySelector('[class*="name"]')?.textContent || '').trim();
      return `${nm}=${nums[nums.length - 1] ?? '?'}`;
    })).catch(() => []);
    boards.push({ name: r.name, board });
    note(`${r.name}'s scoreboard: ${JSON.stringify(board)}`);
  }
  const ref = boards.find(b => b.board.length);
  if (!ref) problems.push('no phone shows a scoreboard at the end');
  for (const b of boards) {
    if (ref && JSON.stringify(b.board) !== JSON.stringify(ref.board)) problems.push(`scoreboards disagree: ${ref.name} ${JSON.stringify(ref.board)} vs ${b.name} ${JSON.stringify(b.board)}`);
  }
  const stored = {};
  for (const p of table.store.table('players')) {
    stored[p.display_name] = table.store.table('answers')
      .filter(a => String(a.player_id) === String(p.id)).reduce((s, a) => s + (a.score_earned || 0), 0);
  }
  note(`stored totals: ${JSON.stringify(stored)}`);
  if (ref) {
    for (const entry of ref.board) {
      const [nm, val] = [entry.slice(0, entry.lastIndexOf('=')), Number(entry.slice(entry.lastIndexOf('=') + 1))];
      const who = Object.keys(stored).find(k => nm.startsWith(k));
      if (who && stored[who] !== val) problems.push(`the scoreboard says ${who} has ${val}; the stored rows add up to ${stored[who]}`);
    }
  }
  // [AnswerNotMine] means "this phone's own row shows text it never sent".
  // Every robot here types its own answers, so any such report is false — and
  // one was filed on EVERY deliberate Submit from 11-03 to 11-06, because the
  // optimistic row was drawn before the phone noted what it sent.
  const notMine = table.store.table('error_logs').filter(e => String(e.message || '').includes('AnswerNotMine'));
  if (notMine.length) problems.push(`${notMine.length} false [AnswerNotMine] report(s) in error_logs — first: ${notMine[0].message}`);
  if (consoleErrors.length) {
    for (const e of consoleErrors.slice(0, 6)) note(`console: ${e}`);
    problems.push(`${consoleErrors.length} console error(s) — first: ${consoleErrors[0]}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}
console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ last-second scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
