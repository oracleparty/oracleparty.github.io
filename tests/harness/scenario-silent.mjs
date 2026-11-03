// Scenario: a player who never types must never be given an answer.
//
// Reported 2026-11-03: "My friend didn't type an answer, and somehow it
// answered Scorpio for him" — seen by both phones, so it was SAVED on his seat.
// The owner hosted, the practice bot was in, and Scorpio was one of the
// question's stored multiple-choice wrong answers: exactly what the bot picks
// from. Every wrong answer here is unique to its question and marked "WRONG-",
// so any of them on Bob's seat is the report reproduced.
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
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

try {
  const rows = [];
  for (let i = 1; i <= 40; i++) {
    rows.push({ id: `q${i}`, question: `Test question ${i}?`, correct_answer: `Answer ${i}`,
      acceptable_answers: [], incorrect_answers: [`WRONG-${i}-a`, `WRONG-${i}-b`, `WRONG-${i}-c`],
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

  heading('playing: Alice answers, Bob never touches his phone');
  const done = new Set();
  let finished = false;
  for (let step = 0; step < 400 && !finished; step++) {
    const s = await screenOf(host);
    if (s === 'question-screen') {
      const n = await host.page.evaluate(() => window.__state?.currentQuestion);
      if (!done.has(n) && await host.page.locator('#answer-input').isVisible().catch(() => false)) {
        await host.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first().click({ timeout: 2000 }).catch(() => {});
        await host.page.fill('#answer-input', `alice ${n}`).catch(() => {});
        if (await clickIfReady(host, '#btn-submit-answer')) done.add(n);
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
    // Bob's phone: tap through the podium only. Never the answer box.
    if (await screenOf(bob) === 'podium-screen') await clickIfReady(bob, '#podium-screen');
    await host.page.waitForTimeout(700);
  }
  note(`reached results: ${finished}`);
  if (!finished) problems.push('the game never reached results, so the check below saw only part of it');

  heading("Bob's saved answers");
  const players = table.store.table('players');
  const bobId = players.find(p => p.display_name === 'Bob')?.id;
  const botId = players.find(p => p.is_bot)?.id;
  for (const a of table.store.table('answers').sort((x, y) => x.question_number - y.question_number)) {
    const who = a.player_id === bobId ? 'Bob' : a.player_id === botId ? 'bot' : 'Alice';
    note(`q${a.question_number} ${who}: "${a.submitted_answer}"`);
    if (a.player_id === bobId && (a.submitted_answer || '').trim() && a.submitted_answer !== '__WAGER_LOCKED__') {
      problems.push(`Bob never typed, and his seat holds "${a.submitted_answer}" on question ${a.question_number}`);
    }
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}
console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ silent-player scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
