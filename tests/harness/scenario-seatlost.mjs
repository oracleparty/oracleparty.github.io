// Scenario: the host's phone sleeps long enough to lose its seat, mid-game.
//
// Reported from a real game on 2026-10-26:
//
//   "I had gone afk for a few minutes. Came back it said i was host. Started
//    round. Then got notification i wasnt host. Then friend said ... he
//    believes he was host but his only host power was to edit scores he
//    couldnt update scores or move on to the next question and said marker at
//    bottom said waiting for host. On his end it looked like i eventually left
//    the lobby. On my end i'm still in, but dont see myself in."
//
// Two faults, one on each phone:
//
//   * BOB, handed the game ON THE SCOREBOARD. The promotion path un-hid the
//     advance button and nothing else: no label, no onclick, "Waiting for
//     host..." left up. Edit Scores was the one control it wired properly.
//   * ALICE, whose seat the others swept while her phone slept. Nothing on the
//     game page noticed the seat had gone, so she kept host controls the
//     server refused and sat absent from her own player list.
//
// SET, NOT WAITED FOR: the sweep is the row disappearing, removed from the
// store WITHOUT a Realtime event, because the live database sends none this
// page can receive (a DELETE payload carries only the key, and the
// subscription filters on room_id). Waiting two real minutes would test the
// clock, not the fault.
//
// Run: node tests/harness/scenario-seatlost.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const QUESTIONS = 5;
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

  const players = () => table.store.table('players');

  heading('round 0, played to the scoreboard');
  for (const r of [host, bob]) {
    await r.page.waitForSelector('#answer-input', { state: 'visible', timeout: 20000 })
      .catch(() => problems.push(`${r.name} never got an answer box in round 0`));
    await r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)')
      .first().click().catch(() => {});
    await r.page.fill('#answer-input', 'Answer 1').catch(() => {});
    await r.page.click('#btn-submit-answer').catch(() => {});
  }
  for (let i = 0; i < 40 && room()?.game_phase !== 'scores_reveal'; i++) {
    await clickIfReady(host, '#btn-next-question');
    await host.page.waitForTimeout(400);
  }
  if (room()?.game_phase !== 'scores_reveal') {
    problems.push(`the host could not reach the scoreboard (room is on ${room()?.game_phase})`);
  }
  await bob.page.waitForFunction(() => document.querySelector('.screen.active')?.id === 'scores-screen', null, { timeout: 15000 })
    .catch(() => problems.push('Bob never reached the scoreboard'));
  await host.page.waitForTimeout(2500);   // the scoreboard animation draws its footer last

  heading("Alice's phone sleeps, and the room gives her seat up");
  const aliceId = await host.page.evaluate(() => window.__state?.room?.playerId);
  const rows = players();
  const idx = rows.findIndex(p => String(p.id) === String(aliceId));
  if (idx === -1) problems.push("could not find Alice's seat to remove");
  else rows.splice(idx, 1);      // no broadcast: the live page receives none
  note(`removed seat ${aliceId}; ${players().length} left`);

  heading('Bob is handed the game on the scoreboard');
  let promotedAt = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 45000) {
    if (players().some(p => p.is_host)) { promotedAt = Date.now() - t0; break; }
    await bob.page.waitForTimeout(250);
  }
  note(`Bob promoted ${promotedAt ?? 'never'}ms after the seat went`);
  if (promotedAt === null) problems.push('nobody was promoted after the host\'s seat went');
  await bob.page.waitForTimeout(800);
  const footer = await bob.page.evaluate(() => {
    const b = document.querySelector('#btn-scores-action');
    const w = document.querySelector('#scores-waiting-host');
    return {
      waitingShown: !!w && !w.classList.contains('hidden'),
      button: b && !b.classList.contains('hidden') ? b.textContent.trim() : null,
      wired: !!b?.onclick,
    };
  });
  note(`Bob's footer: ${JSON.stringify(footer)}`);
  if (footer.waitingShown) problems.push('Bob runs the game and his scoreboard still says "Waiting for host..."');
  if (!footer.button || !footer.wired) {
    problems.push(`Bob runs the game and has no working advance button (${JSON.stringify(footer)}) — "couldn't move on to the next question"`);
  } else {
    await bob.page.click('#btn-scores-action').catch(() => {});
    await bob.page.waitForTimeout(2500);
    if (!(room()?.current_question === 1 && ['countdown', 'question'].includes(room()?.game_phase))) {
      problems.push(`Bob pressed "${footer.button}" and the room stayed on ${room()?.game_phase}@${room()?.current_question}`);
    }
  }

  heading('Alice comes back');
  await host.page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  const told = await host.page.waitForFunction(
    () => document.querySelector('#seat-lost-modal')?.classList.contains('active'), null, { timeout: 10000 })
    .then(() => true).catch(() => false);
  const aliceControls = await host.page.evaluate(() => ({
    isHost: !!window.__state?.room?.isHost,
    advance: ['btn-scores-action', 'btn-next-question', 'btn-edit-scores']
      .filter(id => { const e = document.getElementById(id); return e && !e.classList.contains('hidden') && e.offsetParent; }),
  }));
  note(`Alice told: ${told}; ${JSON.stringify(aliceControls)}`);
  if (!told) problems.push('Alice\'s seat is gone and her phone never said so — "I\'m still in, but don\'t see myself in"');
  if (aliceControls.isHost || aliceControls.advance.length) {
    problems.push(`Alice has no seat and still holds host controls: ${JSON.stringify(aliceControls)}`);
  }

  if (told) {
    heading('Alice taps Rejoin');
    await host.page.click('#seat-lost-rejoin').catch(() => {});
    await host.page.waitForTimeout(6000);
    const back = players().filter(p => p.display_name === 'Alice');
    note(`Alice's seats now: ${JSON.stringify(back.map(p => ({ host: !!p.is_host })))}`);
    if (back.length !== 1) problems.push(`after Rejoin Alice holds ${back.length} seats, not 1`);
    else {
      if (back[0].is_host) problems.push('Alice came back and took the crown off Bob');
      const mine = table.store.table('answers').filter(a => String(a.player_id) === String(back[0].id));
      if (!mine.length) problems.push("Alice rejoined and her round-0 answer did not come with her");
    }
    const screen = await host.page.evaluate(() => document.querySelector('.screen.active')?.id || '(none)').catch(() => '(nav)');
    note(`Alice is on ${screen}`);
    if (!['countdown-screen', 'question-screen', 'reveal-screen', 'scores-screen'].includes(screen)) {
      problems.push(`after Rejoin Alice is on ${screen}, not in the game`);
    }
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
  console.log('\n✓ seat-lost scenario passed');
}
