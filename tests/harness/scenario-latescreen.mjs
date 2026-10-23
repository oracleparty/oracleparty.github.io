// Scenario: a scoreboard that finishes loading AFTER the next question arrived.
//
// Reported from a real game on 2026-10-23, the first since September:
//
//   "By the time I got to question 2, my friend did not see the question I was
//    on until I clicked reveal. Game is broken, stopped there."
//
// and, asked what the friend's screen showed: "still the scoreboard".
//
// showScoresScreen fetches every answer BEFORE it switches the screen. On a
// slow link that fetch is still out when the host presses Next Question, so
// the next question arrives, draws itself — and then the scoreboard's fetch
// comes back and puts the scoreboard up ON TOP of it. Nothing ever puts the
// question back: every later event for that round is the round the phone
// already believes it is on, and handlePhaseTransition refuses a phase it is
// already on. Only the host's Reveal, a new PHASE, moves the screen again.
//
// SET, NOT RACED. scenario-badnetwork plays whole games on a bad link and
// cannot see this, because its robot host reveals two seconds into every
// question — the window closes before anybody would notice. A real host waits
// for their friend. So this one slows ONE phone across exactly the scoreboard,
// has the host advance the moment it can, and then looks.
//
// Run: node tests/harness/scenario-latescreen.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const QUESTIONS = 5;
// Each request on Bob's phone takes this long; Realtime reaches him half of it
// late. The scoreboard's read therefore lands about SLOW_MS after Bob hears the
// scores phase, while the next question reaches him about SLOW_MS/2 after the
// host presses Next — which the host does within a few seconds. 8s leaves
// several seconds of margin either side, so a pass or a fail is not timing luck.
const SLOW_MS = 8000;
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

function seedQuestions(store, n = 40) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`,
      question: `Test question ${i}?`,
      correct_answer: `Answer ${i}`,
      acceptable_answers: [],
      incorrect_answers: [`Wrong ${i}`],
      categories: [CATEGORY],
      subcategory: null,
      difficulty: ['easy', 'medium', 'hard'][i % 3],
      format: 'open',
      fun_fact: null,
      discarded: false,
    });
  }
  store.seed('questions', rows);
}

const clickIfReady = async (r, sel) => {
  const el = r.page.locator(sel).first();
  if (!await el.isVisible().catch(() => false)) return false;
  if (!await el.isEnabled().catch(() => false)) return false;
  await el.click().catch(() => {});
  return true;
};

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);

  async function seat(name) {
    const r = await table.seat(name);
    await r.page.addInitScript(n =>
      localStorage.setItem('oracle_party_display_name', n), name);
    return r;
  }

  const host = await seat('Alice');
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click(`[data-setting="questionsPerGame"] [data-value="${QUESTIONS}"]`).catch(() => {});
  await host.page.waitForTimeout(300);
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);
  const code = await host.textOf('#lobby-code');

  const bob = await seat('Bob');
  await bob.goto('join.html');
  await bob.page.waitForSelector('#code-input', { timeout: 15000 });
  await bob.page.fill('#code-input', code);
  await bob.page.click('#btn-join');
  await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(2000);

  heading('starting the game');
  await clickIfReady(bob, '#btn-ready');
  await host.page.waitForTimeout(800);
  await host.page.waitForSelector('#btn-start-game', { state: 'visible', timeout: 20000 }).catch(() => {});
  for (let i = 0; i < 12; i++) {
    await clickIfReady(host, '#btn-start-game');
    await host.page.waitForTimeout(700);
    if (table.store.table('rooms')[0]?.status === 'playing') break;
  }
  for (const r of [host, bob]) {
    await r.page.waitForURL('**/game.html*', { timeout: 25000 })
      .catch(() => problems.push(`${r.name} never reached the game`));
  }

  const screenOf = r => r.page
    .evaluate(() => document.querySelector('.screen.active')?.id || '(none)').catch(() => '(nav)');
  const ownPhase = r => r.page
    .evaluate(() => `${window.__state?.gamePhase}@${window.__state?.currentQuestion}`).catch(() => '(nav)');
  const room = () => table.store.table('rooms')[0];

  heading('round 0, played normally');
  // Both answer, so the host's Reveal Results is the ordinary press.
  for (const r of [host, bob]) {
    await r.page.waitForSelector('#answer-input', { state: 'visible', timeout: 20000 })
      .catch(() => problems.push(`${r.name} never got an answer box in round 0`));
    await r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)')
      .first().click().catch(() => {});
    await r.page.fill('#answer-input', 'Answer 1').catch(() => {});
    await r.page.click('#btn-submit-answer').catch(() => {});
  }
  // Reveal Results, then — on the same button — Show Scores. Bob's link goes
  // bad in between, so the scores phase is the first thing he hears slowly.
  for (let i = 0; i < 30 && room()?.game_phase !== 'answer_reveal'; i++) {
    await clickIfReady(host, '#btn-next-question');
    await host.page.waitForTimeout(500);
  }
  if (room()?.game_phase !== 'answer_reveal') {
    problems.push(`the host could not reveal round 0 (room is on ${room()?.game_phase})`);
  }
  await host.page.waitForTimeout(1500);

  bob.slowConnection(SLOW_MS);
  note(`Bob's link is now ${SLOW_MS}ms a round trip`);
  const t0 = Date.now();
  for (let i = 0; i < 20 && room()?.game_phase !== 'scores_reveal'; i++) {
    await clickIfReady(host, '#btn-next-question');
    await host.page.waitForTimeout(300);
  }
  if (room()?.game_phase !== 'scores_reveal') {
    problems.push(`the host could not show the scores (room is on ${room()?.game_phase})`);
  }

  heading('the host moves on the moment it can');
  for (let i = 0; i < 40 && room()?.game_phase !== 'question'; i++) {
    await clickIfReady(host, '#btn-scores-action');
    await host.page.waitForTimeout(250);
  }
  if (room()?.game_phase !== 'question' || room()?.current_question !== 1) {
    problems.push(`the host could not start round 1 (room is on ${room()?.game_phase}@${room()?.current_question})`);
  }
  note(`round 1 announced ${Date.now() - t0}ms after the scores were shown`);

  // Watch Bob's screen until well after his slow scoreboard read has come back.
  // The timeline is what says whether the question arrived and was then
  // covered, or simply arrived late — two different faults.
  const timeline = [];
  let lastSeen = null;
  const watchUntil = t0 + SLOW_MS * 2 + 4000;
  while (Date.now() < watchUntil) {
    const seen = `${await screenOf(bob)} (own ${await ownPhase(bob)})`;
    if (seen !== lastSeen) { timeline.push(`${Date.now() - t0}ms ${seen}`); lastSeen = seen; }
    await host.page.waitForTimeout(250);
  }
  note(`Bob's screen: ${timeline.join('  ->  ')}`);

  bob.normalConnection();
  await host.page.waitForTimeout(1500);

  heading('where Bob ended up');
  const endScreen = await screenOf(bob);
  const endPhase = await ownPhase(bob);
  const canType = await bob.page.locator('#answer-input').isVisible().catch(() => false)
    && await bob.page.locator('#answer-input').isEnabled().catch(() => false);
  note(`room ${room()?.game_phase}@${room()?.current_question}; Bob shows ${endScreen}, own ${endPhase}, can type: ${canType}`);

  if (room()?.game_phase === 'question' && room()?.current_question === 1) {
    if (endScreen !== 'question-screen') {
      problems.push(`the room is asking question 2 and Bob's screen shows ${endScreen} — the late scoreboard covered the question, which is the reported "my friend was still on the scoreboard"`);
    } else if (!canType) {
      problems.push('Bob is on the question screen but cannot type an answer');
    }
    if (timeline.some(t => t.includes('question-screen')) && endScreen === 'scores-screen') {
      note('the question DID arrive first and was then drawn over — the timeline above shows the order');
    }
  } else {
    problems.push(`the room left round 1 before the check (${room()?.game_phase}@${room()?.current_question}) — nothing was tested`);
  }
} catch (err) {
  problems.push(`scenario threw: ${err.message}`);
} finally {
  await table.close();
}

if (problems.length) {
  console.log('\n✗ PROBLEMS:');
  for (const p of problems) console.log('  -', p);
  process.exitCode = 1;
} else {
  console.log('\n✓ late-screen scenario passed');
}
