// Scenario: HOW LONG BETWEEN A TAP AND SOMETHING HAPPENING?
//
// Run: node tests/harness/scenario-latency.mjs [--lag=300]
//
// Every other scenario asks whether the game is CORRECT. This one asks whether
// it FEELS answered — the gap between pressing a control and the first pixel
// that moves. CLAUDE.md praises exactly that measure on the final question:
// "it measures the gap between the tap and the first pixel that moves, which
// cannot be flaky and does not care how many round trips the fix happens to
// save."
//
// WHY A LAG IS INJECTED. The store is in-memory, so every request answers
// instantly and NOTHING here is slow by default. That makes the harness blind
// to the one fault this is looking for: a control that waits on the network
// before it shows anything. `robot.slowConnection(ms)` gives one phone a real
// round trip, and then a button that does three of them before drawing costs
// three times a button that does none.
//
// SO THE NUMBERS ARE NOT MILLISECONDS ANYBODY WILL EXPERIENCE. They are a
// count of round trips wearing a clock. What matters is the RATIO between
// controls, and whether a control moves at all before its network work is done.
import { PlaytestTable } from './harness.js';

const args = process.argv.slice(2);
const LAG = Number((args.find(a => a.startsWith('--lag=')) || '--lag=300').split('=')[1]);
const CATEGORY = 'history';

// A tap is "answered" once ANY of these is true. Deliberately broad: a spinner,
// a disabled button, changed text and a new screen are all feedback.
const BUDGET_MS = 2500;

function seedQuestions(store, n = 40) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`, question_text: `Test question ${i}?`,
      correct_answer: `Answer ${i}`, acceptable_answers: [`Ans ${i}`],
      categories: [CATEGORY], subcategory: null,
      difficulty: 'medium', format: 'open', fun_fact: '',
    });
  }
  store.seed('questions', rows);
}

const results = [];
const problems = [];
const note = m => console.log('   ·', m);

/**
 * Press something and time the first visible change.
 *
 * `settled` is polled every 16ms — one frame — so the number is the delay a
 * person would actually see rather than the delay of the next poll.
 */
async function timeTap(robot, label, press, settled) {
  const t0 = Date.now();
  await press();
  let ms = null;
  while (Date.now() - t0 < BUDGET_MS) {
    if (await robot.page.evaluate(settled).catch(() => false)) { ms = Date.now() - t0; break; }
    await robot.page.waitForTimeout(16);
  }
  results.push({ label, ms });
  note(`${label.padEnd(34)} ${ms === null ? `no visible change in ${BUDGET_MS}ms` : ms + 'ms'}`);
  return ms;
}

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);
  console.log(`\n=== every phone on a ${LAG}ms round trip ===`);

  const host = await table.seat('Alice');
  await host.page.addInitScript(() =>
    localStorage.setItem('oracle_party_display_name', 'Alice'));
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 15000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(600);
  await host.page.click('.subcategory-sheet__row, .category-sheet-row').catch(() => {});
  await host.page.waitForTimeout(600);
  await host.page.click('#btn-create-room').catch(() => {});
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });

  const code = (await host.textOf('#lobby-code')) || '';
  const bob = await table.seat('Bob');
  await bob.page.addInitScript(() =>
    localStorage.setItem('oracle_party_display_name', 'Bob'));
  await bob.goto('join.html');
  await bob.page.waitForSelector('#code-input', { timeout: 15000 });
  await bob.page.fill('#code-input', code);
  await bob.page.click('#btn-join');
  await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1500);

  // Everything from here is measured on a real round trip.
  host.slowConnection(LAG);
  bob.slowConnection(LAG);

  console.log('\n=== in the lobby ===');

  // TAPPING SOMEBODY'S FACE. The owner's own hunch: "clicking profile might lag
  // a tad." The card is inserted into the DOM only at the very END of
  // showProfileCard, after its fetches.
  await timeTap(host, 'open a player profile card',
    async () => { await host.page.locator('#player-list .player-item .avatar-wrap').first().click().catch(() => {}); },
    () => !!document.querySelector('.profile-card, .modal-overlay .profile-card'));
  await host.page.keyboard.press('Escape').catch(() => {});
  await host.page.waitForTimeout(400);

  await timeTap(bob, 'press Ready Up',
    async () => { await bob.page.locator('#btn-ready').click().catch(() => {}); },
    () => {
      const b = document.querySelector('#btn-ready');
      return !!b && /ready/i.test(b.textContent || '') && b.classList.length > 0
        && (b.disabled || /not ready/i.test(b.textContent) === false);
    });
  await bob.page.waitForTimeout(800);

  await timeTap(host, 'press Start Game',
    async () => { await host.page.locator('#btn-start-game').click().catch(() => {}); },
    () => location.pathname.includes('game.html')
      || !!document.querySelector('#countdown-screen.active'));

  await host.page.waitForURL('**/game.html*', { timeout: 25000 }).catch(() => {});
  await bob.page.waitForURL('**/game.html*', { timeout: 25000 }).catch(() => {});
  await host.page.waitForTimeout(6000);

  console.log('\n=== in a round ===');

  // Both answer so the reveal has something to show.
  for (const r of [host, bob]) {
    await r.page.locator('.wager-btn').first().click().catch(() => {});
    await r.page.fill('#answer-input', 'Answer 1').catch(() => {});
    await r.page.locator('#btn-submit-answer').click().catch(() => {});
  }
  await host.page.waitForTimeout(2500);

  // REVEAL RESULTS: three sequential round trips before doReveal(), with no
  // button disable and no re-entry guard.
  await timeTap(host, 'press Reveal Results',
    async () => { await host.page.locator('#btn-next-question').click().catch(() => {}); },
    () => {
      const c = document.querySelector('.reveal__correct');
      const btn = document.querySelector('#btn-next-question');
      return (!!c && c.style.display !== 'none') || (!!btn && btn.disabled);
    });
  await host.page.waitForTimeout(1500);

  await timeTap(host, 'press Next / Show Scores',
    async () => { await host.page.locator('#btn-next-question').click().catch(() => {}); },
    () => !!document.querySelector('#scores-screen.active'));

  console.log('\n=== how long the screens take to fade ===');
  const fade = await host.page.evaluate(async () => {
    const mod = await import('/js/constants.js');
    return { fadeMs: mod.FADE_MS, transitionMs: mod.TRANSITION_MS };
  }).catch(() => null);
  if (fade) note(`screen fade ${fade.fadeMs}ms, page transition ${fade.transitionMs}ms`);

  // ============================================================
  // THE VERDICT
  //
  // A control that shows NOTHING until its network work is done is the fault;
  // the exact millisecond count is not. So the bar is expressed against the
  // injected round trip: anything that answers inside one is doing its network
  // work after it draws, which is the shape we want.
  // ============================================================
  console.log('\n=== verdict ===');
  for (const r of results) {
    if (r.ms === null) {
      problems.push(`"${r.label}" showed no visible change at all within ${BUDGET_MS}ms`);
    } else if (r.ms > LAG * 1.5) {
      problems.push(`"${r.label}" took ${r.ms}ms on a ${LAG}ms link — roughly ${(r.ms / LAG).toFixed(1)} round trips before anything moved, so it is waiting on the network before it draws`);
    }
  }
  if (!problems.length) note('every control answered inside one round trip');
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ latency scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
