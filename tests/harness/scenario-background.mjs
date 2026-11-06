// Scenario: a phone is put away mid-question and comes back after the round
// has closed. Stress plan item 3 (docs/STRESS-PLAN.md, 2026-11-06).
//
// The player types an answer, never presses Submit, and puts the phone in a
// pocket for N seconds — robot.goToBackground(): the page is told it is hidden
// (which is where the app sends what is typed), loses its connection, and by
// default its timers are held as iOS holds a backgrounded tab's. The room
// carries on: the round closes, the scoreboard comes and goes. Then the phone
// comes back.
//
// What must hold:
//   * within a few seconds of coming back, the phone is on the ROOM's phase
//     and round, showing that phase's screen;
//   * what they typed is their answer for that round (it went as they left);
//   * if the HOST is the one away, the round still closes without them, and
//     the game carries on once they are back;
//   * the game reaches results, and every scoreboard agrees with the rows.
//
// Run: node tests/harness/scenario-background.mjs [--who=Bob|Alice] [--secs=30] [--frozen=1]
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d;
const WHO = arg('who', 'Bob');
const SECS = Number(arg('secs', '30'));
const FROZEN = arg('frozen', '1') !== '0';
// A phone just out of a pocket is often slow for its first requests while it
// reconnects; this gives the returning phone that link from the moment it is back.
const RETURN_LAG = Number(arg('return-lag', '0'));
const t0 = Date.now();
const at = () => `+${Math.round((Date.now() - t0) / 1000)}s`;
const AWAY_ROUND = 1;
const SCREEN_FOR_PHASE = {
  countdown: 'countdown-screen', question: 'question-screen', reveal: 'reveal-screen',
  answer_reveal: 'reveal-screen', scores_reveal: 'scores-screen', difficulty_vote: 'question-screen',
  final_wager: 'final-wager-screen', final_question: 'question-screen', results: 'results-screen',
};

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
const ownState = r => r.page.evaluate(() => ({ phase: window.__state?.gamePhase, q: window.__state?.currentQuestion,
  screen: document.querySelector('.screen.active')?.id || null })).catch(() => null);

try {
  const rows = [];
  for (let i = 1; i <= 40; i++) {
    rows.push({ id: `q${i}`, question: `Test question ${i}?`, correct_answer: `Answer ${i}`,
      acceptable_answers: [], incorrect_answers: [], categories: [CATEGORY], subcategory: null,
      difficulty: ['easy', 'medium', 'hard'][i % 3], format: 'open', fun_fact: null, discarded: false });
  }
  table.store.seed('questions', rows);

  // Only the phone that goes away needs the timer hold.
  const host = await table.seatSignedIn('Alice', { tier: 'Scholar', pocketable: WHO === 'Alice' });
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

  const guests = [];
  for (const name of ['Bob', 'Carol']) {
    const g = await table.seat(name, { pocketable: WHO === name });
    await g.page.addInitScript(n => localStorage.setItem('oracle_party_display_name', n), name);
    await g.goto('join.html');
    await g.page.fill('#code-input', code);
    await g.page.click('#btn-join');
    await g.page.waitForURL('**/lobby.html*', { timeout: 20000 });
    guests.push(g);
  }
  const everyone = [host, ...guests];
  const away = everyone.find(r => r.name === WHO);
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
  const done = new Set();
  let typed = null, wentAwayAt = null, cameBackAt = null, landed = null;
  let roomWhileAway = new Set();
  let lastKey = null, since = Date.now();
  let finished = false;
  const deadline = Date.now() + 260000 + SECS * 1000;

  while (!finished && Date.now() < deadline) {
    const rm = room();
    const key = `${rm?.game_phase}@${rm?.current_question}`;
    if (key !== lastKey) {
      // A ROUND CLOSED ON THE CLOCK BEFORE ITS CLOCK RAN OUT. `reveal` is only
      // ever written by the timer path (Reveal Results writes answer_reveal),
      // so a reveal before `started + timer` is a stale timer ending a round
      // that is still running — everybody still typing gets a blank.
      if (rm?.game_phase === 'reveal' && rm.question_started_at) {
        const secs = rm.current_question >= 5 ? 30 : 15;
        const early = new Date(rm.question_started_at).getTime() + secs * 1000 - Date.now();
        if (early > 1000) problems.push(`round ${rm.current_question} was closed on the clock ${Math.round(early / 1000)}s BEFORE its clock ran out (${at()}) — a stale timer ended a running round`);
      }
      lastKey = key; since = Date.now(); note(`room: ${key} ${at()}`);
    }
    if (wentAwayAt && !cameBackAt) roomWhileAway.add(key);

    // Back out of the pocket.
    if (wentAwayAt && !cameBackAt && Date.now() - wentAwayAt >= SECS * 1000) {
      if (RETURN_LAG) away.slowConnection(RETURN_LAG);
      await away.comeBack();
      cameBackAt = Date.now();
      note(`${away.name} is back after ${SECS}s (room is on ${key})`);
    }
    // Where did it land, a few seconds later?
    if (cameBackAt && !landed && Date.now() - cameBackAt >= 6000 + 2 * RETURN_LAG) {
      const awayIdNow = table.store.table('players').find(p => p.display_name === WHO)?.id;
      const rq = room()?.current_question;
      landed = { own: await ownState(away), room: `${room()?.game_phase}@${rq}`,
        canType: await away.page.locator('#answer-input').isEnabled().catch(() => false)
          && await away.page.locator('#answer-input').isVisible().catch(() => false),
        hasRow: table.store.table('answers').some(a => String(a.player_id) === String(awayIdNow) && a.question_number === rq) };
      note(`${away.name} 6s after coming back: own ${JSON.stringify(landed.own)}, room ${landed.room}`);
    }

    for (const r of everyone) {
      if (r.away) continue;
      const s = await screenOf(r);
      if (s === 'question-screen') {
        const n = await r.page.evaluate(() => window.__state?.currentQuestion).catch(() => null);
        if (n == null || done.has(`${r.name}:${n}`)) continue;
        if (!await r.page.locator('#answer-input').isEnabled().catch(() => false)) continue;
        const qText = await r.page.textContent('#question-text').catch(() => '');
        const qn = (qText.match(/Test question (\d+)/) || [])[1];
        if (!qn) continue;
        if (r === away && n === AWAY_ROUND && !wentAwayAt) {
          // Type, never press Submit, and put the phone away.
          await r.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first().click({ timeout: 1500 }).catch(() => {});
          await r.page.locator('#answer-input').pressSequentially(`Answer ${qn}`, { delay: 20 }).catch(() => {});
          typed = `Answer ${qn}`;
          await r.goToBackground({ frozen: FROZEN });
          wentAwayAt = Date.now();
          done.add(`${r.name}:${n}`);
          note(`${r.name} typed "${typed}" in round ${n} and put the phone away (${FROZEN ? 'frozen' : 'still running'}) for ${SECS}s`);
          continue;
        }
        if (n < 5) await r.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first().click({ timeout: 1500 }).catch(() => {});
        await r.page.fill('#answer-input', r.name === 'Carol' ? 'carol guess' : `Answer ${qn}`).catch(() => {});
        if (await clickIfReady(r, '#btn-submit-answer')) done.add(`${r.name}:${n}`);
      } else if (s === 'final-wager-screen') {
        // SHORT taps, once: a locked bet's buttons stop being clickable, and a
        // default click waits 30s for them — which once stalled this whole loop
        // past the final question, so nobody answered it.
        if (!done.has(`${r.name}:fw`)) {
          await r.page.locator('#final-wager-screen [data-wager="10"]').first().click({ timeout: 1500 }).catch(() => {});
          await r.page.locator('#final-wager-screen .dv-option[data-difficulty="medium"]').first().click({ timeout: 1500 }).catch(() => {});
          if (await r.page.locator('#fw-status:not(.hidden)').isVisible().catch(() => false)) done.add(`${r.name}:fw`);
        }
        await clickIfReady(r, '#btn-fw-reveal');
      } else if (s === 'reveal-screen') {
        // Whoever holds the controls (the host, or a deputy while the host is
        // away) waits like a person, then moves on.
        if (['reveal', 'answer_reveal'].includes(rm?.game_phase) && Date.now() - since > 2500) {
          await clickIfReady(r, '#btn-next-question');
        }
      } else if (s === 'scores-screen') {
        if (Date.now() - since > 2000) await clickIfReady(r, '#btn-scores-action');
      } else if (s === 'podium-screen') {
        await clickIfReady(r, '#podium-screen');
      } else if (s === 'results-screen' && r === host) {
        finished = true;
      }
    }
    await guests[guests.length - 1].page.waitForTimeout(300);
  }
  await host.page.waitForTimeout(3000);

  // ---------------- judging ----------------
  if (!wentAwayAt) problems.push(`${WHO} never got to round ${AWAY_ROUND}'s question, so nothing was tested`);
  note(`room phases while ${WHO} was away: ${[...roomWhileAway].join(', ')}`);
  if (wentAwayAt && ![...roomWhileAway].some(k => !k.startsWith('question@'))) {
    problems.push(`the round never closed while ${WHO} was away (${[...roomWhileAway].join(', ')}) — `
      + (WHO === host.name ? 'nobody else could end the host\'s round' : 'the test did not cross the round\'s close'));
  }
  if (landed?.own) {
    const [rp, rq] = landed.room.split('@');
    const wantScreen = SCREEN_FOR_PHASE[rp];
    const ownRight = landed.own.phase === rp && String(landed.own.q) === rq;
    if (!ownRight) problems.push(`${WHO} came back and 6s later its game said ${landed.own.phase}@${landed.own.q} while the room was on ${landed.room}`);
    else if (['question', 'final_question'].includes(rp) && !landed.hasRow
             && !(landed.own.screen === 'question-screen' && landed.canType)) {
      problems.push(`${WHO} came back during ${landed.room}, has not answered it, and cannot: its screen shows ${landed.own.screen}`
        + `${landed.own.screen === 'question-screen' ? ' with the answer box shut' : ''} — the round will close on them`);
    } else if (wantScreen && landed.own.screen !== wantScreen
             && !(['question', 'final_question'].includes(rp) && landed.hasRow && landed.own.screen === 'reveal-screen')) {
      problems.push(`${WHO} came back to the right phase (${landed.room}) but its screen shows ${landed.own.screen}, not ${wantScreen}`);
    }
  } else if (cameBackAt) {
    problems.push(`${WHO} came back and its state could not be read`);
  }
  const awayId = table.store.table('players').find(p => p.display_name === WHO)?.id;
  if (!awayId) problems.push(`${WHO} has no seat any more after ${SECS}s away`);
  const row = table.store.table('answers').find(a => String(a.player_id) === String(awayId) && a.question_number === AWAY_ROUND);
  note(`${WHO}'s rows: ${JSON.stringify(table.store.table('answers').filter(a => String(a.player_id) === String(awayId))
    .sort((a, b) => a.question_number - b.question_number).map(a => `${a.question_number}:${a.submitted_answer || '(blank)'}/${a.wager}/${a.score_earned}`))}`);
  // Every round the room asked must have been answerable by everybody: a
  // phone that missed one only because its screen was wrong scored a blank.
  const roomRounds = new Set(table.store.table('answers').map(a => a.question_number));
  for (const n of roomRounds) {
    // A round whose question ran while they were away is theirs to have missed.
    if (n === AWAY_ROUND || n >= 5 || roomWhileAway.has(`question@${n}`)) continue;
    const r = table.store.table('answers').find(a => String(a.player_id) === String(awayId) && a.question_number === n);
    if (!String(r?.submitted_answer || '').trim()) problems.push(`${WHO} has a BLANK for round ${n}, a round they were back for — they were never able to answer it`);
  }
  if (typed && String(row?.submitted_answer || '').trim() !== typed) {
    problems.push(`${WHO} typed "${typed}" and left; the stored answer for round ${AWAY_ROUND} is ${JSON.stringify(row?.submitted_answer ?? null)}`);
  }
  // Everybody who stayed put answers every round, the final included: a blank
  // for one of them means a screen (or this robot) stalled and the round was lost.
  for (const p of table.store.table('players').filter(p => !p.is_bot && p.display_name !== WHO)) {
    const blanks = table.store.table('answers').filter(a => String(a.player_id) === String(p.id)
      && !String(a.submitted_answer || '').trim()).map(a => a.question_number);
    if (blanks.length) problems.push(`${p.display_name}, who never left, has a blank for round(s) ${blanks.join(', ')}`);
  }
  // THE WAGER RULE: with N questions, bets 1..N are each spent exactly once.
  // A returning phone's late write once filed its old round's answer — and bet —
  // in the next round's slot, and the bet was spent twice.
  for (const p of table.store.table('players').filter(p => !p.is_bot)) {
    const bets = table.store.table('answers').filter(a => String(a.player_id) === String(p.id)
      && a.question_number < 5 && String(a.submitted_answer || '').trim() !== '__WAGER_LOCKED__').map(a => a.wager);
    const twice = bets.filter((b, i) => bets.indexOf(b) !== i);
    if (twice.length) problems.push(`${p.display_name} spent bet ${[...new Set(twice)].join(', ')} more than once: ${JSON.stringify(bets)}`);
  }
  // Every row names the question its round asked — never another round's.
  const ids = table.store.table('rooms')[0]?.question_ids || [];
  for (const a of table.store.table('answers')) {
    if (a.question_id != null && ids[a.question_number] != null && String(a.question_id) !== String(ids[a.question_number])) {
      const who = table.store.table('players').find(p => String(p.id) === String(a.player_id))?.display_name;
      problems.push(`${who}'s round-${a.question_number} row names question ${a.question_id}, but that round asked ${ids[a.question_number]}`);
    }
  }
  // [AnswerNotMine] means "this phone's own row shows text it never sent".
  // Every robot here types its own answers, so any such report is false — and
  // one was filed on EVERY deliberate Submit from 11-03 to 11-06, because the
  // optimistic row was drawn before the phone noted what it sent.
  const notMine = table.store.table('error_logs').filter(e => String(e.message || '').includes('AnswerNotMine'));
  if (notMine.length) problems.push(`${notMine.length} false [AnswerNotMine] report(s) in error_logs — first: ${notMine[0].message}`);
  if (process.env.BG_TRACE) {
    for (const op of table.store.log) {
      const t = JSON.stringify(op);
      if (t.includes(String(awayId)) && /answer|submit|draft|fill/i.test(t)) console.log('   TRACE', t.slice(0, 300));
    }
  }
  if (!finished) problems.push(`the game never reached results — stuck on ${lastKey}`);

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
      const p = table.store.table('players').find(x => x.display_name === nm);
      if (!p) continue;
      const total = table.store.table('answers').filter(a => String(a.player_id) === String(p.id)).reduce((t, a) => t + (a.score_earned || 0), 0);
      if (total !== val) problems.push(`the scoreboard says ${nm} has ${val}; the stored rows add up to ${total}`);
    }
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
console.log('\n' + (problems.length ? '✗ PROBLEMS:' : `✓ background scenario passed (${WHO}, ${SECS}s, ${FROZEN ? 'frozen' : 'running'})`));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
