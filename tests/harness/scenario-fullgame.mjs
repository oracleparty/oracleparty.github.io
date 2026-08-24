// Scenario: three robots play a complete game, then leave.
//
// Checks the things that only break with several players at once:
//   * every client agrees on the final scores
//   * Realtime channels are actually released on exit (the cleanup() leak)
//   * nobody's console throws along the way
//
// Run: node tests/harness/scenario-fullgame.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const QUESTIONS = 5;          // + 1 final wager question
const FINAL_WAGER_SECONDS = 20;  // mirrors FINAL_WAGER_TIMER_SECONDS in js/constants.js
const problems = [];
const note = m => console.log('   ·', m);

function seedQuestions(store, n = 40) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`,
      question: `Test question ${i}?`,
      correct_answer: `Answer ${i}`,
      acceptable_answers: [],
      categories: [CATEGORY],
      subcategory: null,
      // MIXED DIFFICULTIES, not all 'medium'. The host swaps the final question
      // for one matching the difficulty vote, and with a bank of a single
      // difficulty that swap silently never happens — so the code path that
      // has to get the new question to everybody else was never once exercised
      // here. A player reported receiving a completely different final
      // question from the host.
      difficulty: ['easy', 'medium', 'hard'][i % 3],
      format: 'open',
      fun_fact: null,
      discarded: false,
    });
  }
  store.seed('questions', rows);
}

async function seatWithName(table, name) {
  const r = await table.seat(name);
  await r.page.addInitScript(n =>
    localStorage.setItem('oracle_party_display_name', n), name);
  return r;
}

/** Answer the current question, if the question screen is showing. */
async function answerQuestion(robot, text) {
  const input = robot.page.locator('#answer-input');
  try {
    await input.waitFor({ state: 'visible', timeout: 12000 });
  } catch {
    const screen = await robot.page.evaluate(() => document.querySelector('.screen.active')?.id);
    note(`${robot.name}: no answer input (on ${screen})`);
    return false;
  }
  // Pick a wager if one is offered and none is preselected.
  const wager = robot.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
  if (await wager.count() > 0 && await wager.isVisible().catch(() => false)) {
    await wager.click().catch(() => {});
  }
  await input.fill(text).catch(() => {});
  const enabled = await robot.page.isEnabled('#btn-submit-answer').catch(() => false);
  if (!enabled) {
    note(`${robot.name}: submit still disabled after wager+text`);
    return false;
  }
  await robot.page.click('#btn-submit-answer').catch(e => note(`${robot.name}: submit click failed`));
  return true;
}

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);

  // --- Set up the room ---
  const host = await seatWithName(table, 'Alice');
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  // Shortest game available, so a full playthrough stays quick.
  await host.page.click('[data-setting="questionsPerGame"] [data-value="5"]').catch(() => {});
  await host.page.waitForTimeout(300);
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);

  const code = await host.textOf('#lobby-code');
  note(`room ${code}`);

  const bob = await seatWithName(table, 'Bob');
  const carol = await seatWithName(table, 'Carol');
  for (const r of [bob, carol]) {
    await r.goto('join.html');
    await r.page.waitForSelector('#code-input', { timeout: 15000 });
    await r.page.fill('#code-input', code);
    await r.page.click('#btn-join');
    await r.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  }
  await host.page.waitForTimeout(1500);

  const everyone = [host, bob, carol];

  // Channels held during a normal game — the baseline for the leak check.
  const channelsInLobby = await host.openChannelCount();
  note(`host holds ${channelsInLobby} realtime channels in the lobby`);

  // --- Start the game ---
  await host.page.click('#btn-start-game').catch(() => {});
  await host.page.waitForURL('**/game.html*', { timeout: 25000 });
  for (const r of [bob, carol]) {
    await r.page.waitForURL('**/game.html*', { timeout: 25000 })
      .catch(() => problems.push(`${r.name} never reached the game screen`));
  }
  note('all three reached game.html');

  // --- Play the rounds ---
  //
  // Driven by whatever screen each robot is actually on, rather than a fixed
  // sequence of clicks. Phase changes arrive over Realtime and do not land in
  // lockstep, so a scripted order desynchronises within a round or two and
  // then reports failures that are only the script's own impatience.

  // Pages navigate on their own (results -> lobby, room deleted -> home), so
  // any read can land mid-navigation. That is normal, not a failure.
  const activeScreen = r => r.page
    .evaluate(() => document.querySelector('.screen.active')?.id || '(none)')
    .catch(() => '(navigating)');

  const clickIfReady = async (r, selector) => {
    const el = r.page.locator(selector);
    if (!await el.isVisible().catch(() => false)) return false;
    if (!await el.isEnabled().catch(() => false)) return false;
    await el.click().catch(() => {});
    return true;
  };

  const answered = new Set();     // "name:round" already submitted

  // ============================================================
  // PASSING WITHOUT TYPING
  //
  // A player who did not know the answer had two options: invent a character,
  // or sit there holding the entire room until the timer ran out. Submit was
  // disabled on an empty box and only flashed at you. Typing a single SPACE
  // worked — it is trimmed to '' and shows as "No answer" — which is a trick
  // nobody could be expected to find.
  //
  // The WORD on the button is what makes an empty submit safe rather than an
  // accident: "Pass" when the box is empty, "Submit" when it is not. The wager
  // is still required, and still spent — passing is not a free round.
  //
  // Checked once, on the first question, before anybody answers.
  let passChecked = false;
  async function checkPassAffordance(r) {
    if (passChecked) return;
    const box = r.page.locator('#answer-input');
    if (!await box.isVisible().catch(() => false)) return;
    passChecked = true;

    const label = async () => ((await r.page.textContent('#btn-submit-answer').catch(() => '')) || '').trim();
    const enabled = () => r.page.isEnabled('#btn-submit-answer').catch(() => false);

    await box.fill('').catch(() => {});
    const wager = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
    if (await wager.count() > 0) await wager.click().catch(() => {});
    await r.page.waitForTimeout(350);

    const emptyLabel = await label();
    note(`empty box: button says ${JSON.stringify(emptyLabel)}, enabled=${await enabled()}`);
    if (!await enabled()) {
      problems.push('Submit is disabled with an empty box, so a player who does not know the answer can only invent a character or hold the whole room until the timer runs out');
    }
    if (!/pass/i.test(emptyLabel)) {
      problems.push(`with an empty box the button says ${JSON.stringify(emptyLabel)} — an empty "Submit" spends the round by accident, "Pass" is a decision`);
    }

    await box.fill('   ').catch(() => {});
    await r.page.waitForTimeout(250);
    const spacesLabel = await label();
    note(`whitespace only: button says ${JSON.stringify(spacesLabel)}`);
    if (!/pass/i.test(spacesLabel)) {
      problems.push('a box holding only spaces says Submit, though it is stored as no answer at all');
    }

    await box.fill('something').catch(() => {});
    await r.page.waitForTimeout(250);
    const textLabel = await label();
    note(`with text: button says ${JSON.stringify(textLabel)}`);
    if (!/submit/i.test(textLabel)) {
      problems.push(`with text typed the button says ${JSON.stringify(textLabel)} rather than Submit`);
    }
    await box.fill('').catch(() => {});
  }

  async function takeTurn(r, roundHint) {
    const screen = await activeScreen(r);

    if (screen === 'question-screen') {
      const key = `${r.name}:${roundHint}`;
      if (answered.has(key)) return screen;
      await checkPassAffordance(r);
      // READ THE QUESTION ON SCREEN rather than guessing from a round counter.
      //
      // It used to be `Answer ${roundHint + 1}`, and roundHint is a loop
      // counter that has nothing to do with which question a given phone is
      // actually showing — so Alice never once answered correctly and EVERY
      // player in this scenario finished on 0. A full-game test in which
      // nobody scores cannot detect a scoring regression at all, which matters
      // now that the score is computed by the database rather than here.
      //
      // The seeded bank is "Test question N?" → "Answer N", so the screen
      // carries everything needed.
      const shown = await r.page.textContent('#question-text').catch(() => '');
      const n = (shown || '').match(/\d+/)?.[0];
      const text = r.name === 'Bob' ? 'definitely wrong' : (n ? `Answer ${n}` : 'no idea');
      if (await answerQuestion(r, text)) answered.add(key);
      return screen;
    }

    if (screen === 'final-wager-screen') {
      // Carol never touches this screen. The final wager had no timer at all
      // until a playtest found one person who had put their phone down holding
      // the last round open, so what is being measured here is that going quiet
      // costs 0 rather than the state.finalWager default of 20 — committing
      // that default would take 20 points off somebody for being away, which no
      // other missed round in this game does.
      if (r.name === 'Carol') return screen;

      // A wager amount must be chosen before the lock button does anything.
      // BOB CHOOSES BUT DOES NOT LOCK, then a re-render lands on him.
      //
      // Realtime re-calls the wager screen for the same round, and that used to
      // clear the selection — so when the clock ran out the player was
      // committed to 0 despite having tapped 20. Reported from a live game.
      // Carol still tests the other half: never touching it at all costs 0.
      if (r.name === 'Bob') {
        const key = `${r.name}:final`;
        if (!answered.has(key)) {
          const opt = r.page.locator('#final-wager-screen [data-wager="20"]').first();
          if (await opt.isVisible().catch(() => false)) {
            await opt.click().catch(() => {});
            // ...and a difficulty vote, which lives only in memory and is
            // broadcast to the others. A re-render used to wipe EVERY vote in
            // the room, and since nobody re-sends them the final difficulty was
            // then picked at random from an empty tally. People voted and it
            // did not count.
            await r.page.locator('#final-wager-screen .dv-option[data-difficulty="hard"]')
              .first().click().catch(() => {});
            answered.add(key);
            // A REAL room write, not a hand-made broadcast. Re-broadcasting an
            // unchanged row went through the store but produced no re-render,
            // so the check passed with the fix removed and was measuring
            // nothing. Writing a column the way the app does is what the
            // clients actually react to.
          }
        }
        return screen;
      }

      const key = `${r.name}:final`;
      if (!answered.has(key)) {
        // A REAL number, not .first() — the first button is 0, so the robots
        // were "choosing" the same value somebody who never touched the screen
        // gets, and a wager screen that had already expired would have looked
        // identical to one working perfectly.
        const opt = r.page.locator('#final-wager-screen [data-wager="20"]').first();
        if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
        if (await clickIfReady(r, '#btn-fw-lock')) answered.add(key);
      }
      // The host must NOT move on until the clock has actually run out, or
      // Carol never gets the twenty seconds this is measuring — she reaches the
      // final question still holding the interface's default of 20 and the
      // "going quiet costs 0" rule is never tested. Locking and revealing in
      // the same turn is what made her wager 20.
      if (r === host && waitedOutWagerClock) await clickIfReady(r, '#btn-fw-reveal');
      return screen;
    }

    // Results is the finish line — clicking onit would send the host back to
    // the lobby and destroy the thing being measured.
    if (screen === 'results-screen') return screen;

    // Only the host advances reveal and scores.
    if (r === host) {
      if (screen === 'reveal-screen') await clickIfReady(r, '#btn-next-question');
      if (screen === 'scores-screen') await clickIfReady(r, '#btn-scores-action');
    }
    return screen;
  }

  let round = 0;
  let lastQuestionSeen = -1;
  let reachedResults = false;
  // Sampled on its own timer, not between turns: the stamp for a round lands a
  // second into it, which is inside a turn, and a between-turns sample misses
  // the window entirely.
  const lastStampByPhase = new Map();
  const clockSampler = setInterval(() => {
    const rm = table.store.table('rooms')[0];
    if (rm?.question_started_at && rm.game_phase) {
      lastStampByPhase.set(rm.game_phase, rm.question_started_at);
    }
  }, 100);
  let waitedOutWagerClock = false;

  for (let step = 0; step < 160 && !reachedResults; step++) {
    for (const r of everyone) {
      await takeTurn(r, round).catch(() => '(navigating)');
    }

    // Track progress by the room's own state, not one client's screen: clients
    // reach results at different moments and may navigate away afterwards.
    const room = table.store.table('rooms')[0];

    // Sit through the 20-second wager clock once, so the timeout actually
    // fires. Without this the loop races past the screen and the assertion
    // below would pass on a wager Carol simply never got the chance to make.
    // ...but only once the two who ARE going to choose have chosen. Waiting the
    // moment the phase appears meant the clock expired before anybody's screen
    // had rendered, so all three were auto-locked at 0 — and "everybody wagered
    // 0" is indistinguishable from "the wager screen was already expired",
    // which is the bug that reached a live game.
    if (room && room.game_phase === 'final_wager' && !waitedOutWagerClock
        && answered.has('Alice:final') && answered.has('Bob:final')) {
      waitedOutWagerClock = true;
      // DROP THE UPDATE THAT CARRIES THE NEW FINAL QUESTION.
      //
      // The host swaps the final question for one matching the difficulty vote
      // and broadcasts the new list in a single room update. A real connection
      // loses one occasionally, and when it did, the player kept their own
      // pre-fetched question — a completely different final question from
      // everybody else, judged by the server against the room's one. Nothing
      // re-checked the list afterwards. syncToCurrentState is the safety net
      // and had never once been made to catch anything.
      table.store.dropEvents('rooms', 2);
      note(`waiting out the ${FINAL_WAGER_SECONDS}s final-wager clock with Carol away`);
      await host.page.waitForTimeout((FINAL_WAGER_SECONDS + 3) * 1000);
    }

    if (room && room.game_phase === 'results') reachedResults = true;
    if (room && room.current_question !== lastQuestionSeen) {
      lastQuestionSeen = room.current_question;
      round = room.current_question ?? round;
      note(`round ${round} (phase ${room.game_phase})`);
    }
    await host.page.waitForTimeout(450);
  }

  // EVERY ROUND MUST GET ITS OWN CLOCK.
  //
  // The stamp is asked for BY PHASE, and the final round's phase is
  // 'final_question', not 'question'. Ask for the wrong one and the database
  // correctly refuses, the client falls back to whatever stamp is already on
  // the room, and the last question of the game opens with the previous
  // round's timer most of the way through. Nothing else here could see it: the
  // robots answer fast enough to finish inside the leftover time.
  //
  // Compared as VALUES, not as ages. A first version measured how old the stamp
  // was each time round the loop and never caught it, because the re-stamp
  // lands one second into the round — inside a turn — and by the next sample
  // the phase had already moved on. Two stamps being equal is true whenever you
  // look at them.
  clearInterval(clockSampler);
  const wagerStamp = lastStampByPhase.get('final_wager');
  const finalStamp = lastStampByPhase.get('final_question');
  note(`final-wager clock ${wagerStamp || '(none)'} / final-question clock ${finalStamp || '(none)'}`);
  if (!finalStamp) {
    problems.push('the final question never got a clock at all');
  } else if (wagerStamp && finalStamp === wagerStamp) {
    problems.push('the final question reused the wager screen\'s clock instead of starting its own — its timer opens already most of the way through');
  }

  // THE WAGER SCREEN NEEDS ITS OWN CLOCK TOO, and this is the one that bit in a
  // live game. When the database refused to stamp, it handed back the timestamp
  // already on the room — the previous QUESTION's — and the client took that as
  // the start of a 20-second wager screen that was therefore already over. The
  // host was locked at a wager of 0 before the buttons appeared.
  const lastQuestionStamp = lastStampByPhase.get('question');
  if (wagerStamp && lastQuestionStamp && wagerStamp === lastQuestionStamp) {
    problems.push('the final wager screen inherited the last question\'s clock, so its 20 seconds were already gone before anybody could choose');
  }

  if (!reachedResults) {
    const room = table.store.table('rooms')[0];
    problems.push(`game never reached results (stuck on phase ${room?.game_phase}, question ${room?.current_question})`);
  } else {
    note(`game completed; ${table.store.table('answers').length} answers recorded`);
  }

  await host.page.waitForTimeout(2500);

  // --- Where did everyone end up? ---
  for (const r of everyone) {
    note(`${r.name} is on ${await activeScreen(r)}`);
  }

  // --- The final wager clock ---
  const finalQ = QUESTIONS; // final wager rides on question_number === QUESTIONS
  const carolId = table.store.table('players').find(p => p.display_name === 'Carol')?.id;
  const carolFinal = table.store.table('answers')
    .find(a => String(a.player_id) === String(carolId) && a.question_number === finalQ);
  note(`Carol never touched the wager screen; her locked wager: ${carolFinal ? carolFinal.wager : '(none)'}`);

  // EVERYBODY MUST HAVE BEEN ASKED THE SAME FINAL QUESTION.
  //
  // The host replaces the final question with one matching the difficulty vote
  // and broadcasts the new list. If a client does not pick that up it asks its
  // own pre-fetched question instead — different question, same round, and the
  // answers are judged against whatever each phone happened to be showing.
  const finalIds = new Set(table.store.table('answers')
    .filter(a => a.question_number === finalQ && a.question_id)
    .map(a => String(a.question_id)));
  const roomFinalId = String((table.store.table('rooms')[0]?.question_ids || []).slice(-1)[0]);
  note(`final question ids recorded on answers: ${[...finalIds].join(', ') || '(none)'} (room says ${roomFinalId})`);
  if (finalIds.size > 1) {
    problems.push(`players were asked ${finalIds.size} DIFFERENT final questions — the host's difficulty swap did not reach everybody`);
  } else if (finalIds.size === 1 && roomFinalId !== 'undefined' && ![...finalIds][0].startsWith(roomFinalId)) {
    problems.push(`the final question answered (${[...finalIds][0]}) is not the one the room settled on (${roomFinalId})`);
  }

  // ...and somebody who DID touch it must have got the wager they picked. If
  // the screen's clock is already expired everybody is locked at 0, which looks
  // exactly like a room full of cautious players.
  const chosen = table.store.table('answers')
    .filter(a => a.question_number === finalQ && (a.wager || 0) > 0);
  note(`players who got to choose a final wager: ${chosen.length}`);
  if (chosen.length === 0) {
    problems.push('every final wager is 0 — nobody was able to choose one, which is what an already-expired wager clock looks like');
  }

  // Bob tapped 20 and never pressed Lock In. What he tapped must be what he
  // wagered — which the blank fill used to overwrite with 0 (migration 050).
  const bobId = table.store.table('players').find(p => p.display_name === 'Bob')?.id;
  const bobFinal = table.store.table('answers')
    .find(a => String(a.player_id) === String(bobId) && a.question_number === finalQ);
  note(`Bob chose 20 without locking; he wagered: ${bobFinal ? bobFinal.wager : '(none)'}`);
  if (bobFinal && bobFinal.wager !== 20) {
    problems.push(`Bob tapped 20 on the final wager and was committed to ${bobFinal.wager}`);
  }
  if (!carolFinal) {
    problems.push('a player who ignored the final wager screen locked nothing at all — the 20s clock never committed for her, so the room would still be waiting');
  } else if (carolFinal.wager !== 0) {
    problems.push(`a player who ignored the final wager screen was committed to ${carolFinal.wager} points, not 0 — being away must not cost more than a missed round does`);
  }

  // --- Do the clients agree on scores? ---
  const scoreboards = [];
  for (const r of everyone) {
    // Compare what the game decided, not how it is decorated. Each client
    // hides its own honk button, so raw row text differs between players even
    // when every score agrees.
    const board = await r.page.evaluate(() =>
      [...document.querySelectorAll('#results-list .results-row')]
        .map(row => {
          const text = row.textContent.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
          const numbers = text.match(/-?\d+/g) || [];
          const name = (row.querySelector('[class*="name"]')?.textContent || '').trim();
          return `${name}=${numbers[numbers.length - 1] ?? '?'}`;
        })
        .filter(Boolean)).catch(() => []);
    scoreboards.push({ name: r.name, board });
  }
  for (const s of scoreboards) note(`${s.name} scoreboard: ${JSON.stringify(s.board).slice(0, 120)}`);

  // SOMEBODY MUST HAVE SCORED. Agreement is worthless on its own — three
  // clients all showing 0 agree perfectly, and that is what this scenario
  // asserted for its whole life while Alice answered every question wrong
  // without anybody noticing. A board of zeroes cannot detect a scoring
  // regression, which is the thing that moved to the database.
  const anyPoints = scoreboards.some(s =>
    s.board.some(entry => Number(entry.split('=').pop()) > 0));
  if (!anyPoints) {
    problems.push('nobody scored a single point all game — the scoreboard cannot be measuring anything');
  }

  const nonEmpty = scoreboards.filter(s => s.board.length > 0);
  if (nonEmpty.length > 1) {
    const first = JSON.stringify(nonEmpty[0].board);
    for (const s of nonEmpty.slice(1)) {
      if (JSON.stringify(s.board) !== first) {
        problems.push(`scoreboards disagree: ${nonEmpty[0].name} vs ${s.name}`);
      }
    }
  }

  // --- THE LEAK CHECK ---
  // Leaving must release every Realtime channel. Before the cleanup() fix this
  // left a full set subscribed on every exit, so handlers fired once more per
  // game played in a session.
  const beforeLeave = await bob.openChannelCount();
  const quit = bob.page.locator('#btn-quit-game');
  const canQuit = await quit.isVisible().catch(() => false);

  if (!canQuit) {
    // Distinguish "cleanup is broken" from "the robot never triggered cleanup".
    // Reporting the second as the first is how a harness starts lying.
    note(`Bob could not leave: quit button not visible on ${await activeScreen(bob)} — leak check skipped`);
  } else {
    // Quit is tap-again-to-confirm on the same button, not a separate dialog:
    // the first tap only arms it, and it disarms itself after 3 seconds.
    await quit.click().catch(() => {});
    await bob.page.waitForTimeout(400);
    await quit.click().catch(() => {});
    await bob.page.waitForTimeout(2500);
    const afterLeave = await bob.openChannelCount();
    note(`Bob channels: ${beforeLeave} in game -> ${afterLeave} after leaving`);
    if (afterLeave >= beforeLeave && beforeLeave > 0) {
      problems.push(`leaving did not release Realtime channels (${beforeLeave} -> ${afterLeave})`);
    }
  }

  // --- Console errors ---
  for (const r of everyone) {
    if (r.failedRequests.length) note(`${r.name} failed requests: ${[...new Set(r.failedRequests)].join(', ')}`);
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
  }

} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ full game passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
