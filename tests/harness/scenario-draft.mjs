// Scenario: what a player typed survives a send that arrives too late.
//
// Reported 2026-11-05: a friend's answer read "No answer" though they had typed
// one. Every phone sends its box when the clock runs out, but on a slow
// database that send can land after the server's `timer + 3s` deadline, be
// refused, and leave the blank the fill already wrote. Migration 081 keeps
// what is typed as a DRAFT while they type, and the fill uses it.
//
// SET, NOT RACED: Bob types the right answer and never presses Submit; from
// two seconds before the end every op_submit_answer is held 6s, so his
// auto-submit reaches the server after the deadline. Only a draft saved while
// he was typing can put his answer on his row.
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
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
      difficulty: 'medium', format: 'open', fun_fact: null, discarded: false });
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
  await bob.page.waitForURL('**/game.html*', { timeout: 20000 });

  console.log('\n=== round 0: Alice submits; Bob types the right answer and never presses Submit ===');
  const deadline = Date.now() + 40000;
  let typed = null, aliceDone = false, held = false;
  while (Date.now() < deadline) {
    if (!aliceDone && await screenOf(host) === 'question-screen'
        && await host.page.locator('#answer-input').isEnabled().catch(() => false)) {
      await host.page.locator('#question-screen .wager-btn').first().click({ timeout: 2000 }).catch(() => {});
      await host.page.fill('#answer-input', 'alice').catch(() => {});
      aliceDone = await clickIfReady(host, '#btn-submit-answer');
    }
    if (!typed && await screenOf(bob) === 'question-screen'
        && await bob.page.locator('#answer-input').isVisible().catch(() => false)) {
      const qText = await bob.page.textContent('#question-text').catch(() => '');
      const n = (qText.match(/Test question (\d+)/) || [])[1];
      if (n) {
        await bob.page.locator('#question-screen .wager-btn').first().click({ timeout: 2000 }).catch(() => {});
        await bob.page.locator('#answer-input').pressSequentially(`Answer ${n}`, { delay: 40 });
        typed = `Answer ${n}`;
        note(`Bob typed "${typed}" and left it`);
      }
    }
    if (typed && !held) {
      const left = await bob.page.evaluate(() => Number(document.querySelector('#timer-text')?.textContent));
      if (left <= 2) {
        table.store.slowFunction('op_submit_answer', 6000);
        held = true;
        note('every submit is now held 6s — Bob\'s auto-submit will miss the deadline');
      }
    }
    const stored = table.store.table('answers').find(a => a.question_number === 0
      && table.store.table('players').find(p => p.id === a.player_id)?.display_name === 'Bob');
    if (held && stored) break;
    await host.page.waitForTimeout(250);
  }
  await host.page.waitForTimeout(8000);   // let the held send land and be refused
  table.store.slowFunction('op_submit_answer', 0);

  const bobId = table.store.table('players').find(p => p.display_name === 'Bob')?.id;
  const row = table.store.table('answers').find(a => a.question_number === 0 && a.player_id === bobId);
  note(`Bob's stored row: ${JSON.stringify(row && { answer: row.submitted_answer, correct: row.is_correct, score: row.score_earned })}`);
  if (!typed) problems.push('Bob never got a question to type into');
  else if (!held) problems.push('the round never reached its last two seconds, so the late send was never set up');
  else if (!row) problems.push('Bob has no row at all for round 0');
  else if (String(row.submitted_answer || '').trim() !== typed) {
    problems.push(`Bob typed "${typed}" and his row says "${row.submitted_answer}" — what he typed was lost when the send arrived late`);
  } else if (!row.is_correct) {
    problems.push('Bob\'s drafted answer was right and was not judged right');
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}
console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ draft scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
