// Scenario: a WHOLE GAME played with one phone on a bad connection.
//
// This exists because of a gap, not because of a specific bug. Three
// game-breaking faults were fixed in the days before it was written — the
// host's screen not following the room, the final question desyncing, and a
// player's answer row going missing — and every one of them was proven against
// a scenario that applies adverse conditions to ONE MOMENT and then takes them
// away. Nobody has played a full game on a bad link, from the lobby to the
// results, with every fix in place at once.
//
// That is what a real playtest does and what a machine can get closest to. It
// is NOT a substitute for a person holding a phone: this is Chromium against an
// in-memory store, so it cannot see iOS Safari, a keyboard, a real radio, or
// anything about how the game FEELS. Say that plainly rather than reporting
// this as "playtested".
//
// The lag belongs to ONE robot, which is the whole point. Every other slowness
// knob in this harness lives on the store and slows the room equally, so a
// screen queued behind a network call still arrives when everybody else's does.
// Real bad connections belong to one person, and every symptom the owner has
// reported is about the asymmetry.
//
// Run: node tests/harness/scenario-badnetwork.mjs [--lag=1500] [--on=Alice]
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const QUESTIONS = 5;             // + 1 final wager question — 5 is the SMALLEST
                                 // option host.html offers. The first version asked for
                                 // 3, the click found nothing, `.catch(() => {})` ate it,
                                 // and the run silently played the 10-question default.
const FINAL_WAGER_SECONDS = 20;  // mirrors FINAL_WAGER_TIMER_SECONDS

const LAG = Number((process.argv.find(a => a.startsWith('--lag=')) || '').split('=')[1] || 1500);
const LAGGY = (process.argv.find(a => a.startsWith('--on=')) || '').split('=')[1] || 'Alice';

const problems = [];
const note = m => console.log('   ·', m);

// The screen each phase is supposed to put you on. `final_question` shares the
// question screen with an ordinary round — that is not a mistake, it is the
// same screen re-used, and it is exactly the transition the owner reported
// four times.
// READ OFF `PHASE_ORDER` IN js/game/init.js, NOT GUESSED. The first version of
// this file invented `reveal` and `scores` and missed `answer_reveal`,
// `scores_reveal` and `difficulty_vote` entirely — so the run reported phases
// the map had never heard of and the screen assertions silently skipped them.
// A check that skips what it does not recognise is a check that agrees with
// you about anything you have not thought of.
const SCREEN_FOR_PHASE = {
  countdown: 'countdown-screen',
  question: 'question-screen',
  reveal: 'reveal-screen',           // the clock ran out
  answer_reveal: 'reveal-screen',    // the host pressed Reveal Results
  scores_reveal: 'scores-screen',
  difficulty_vote: 'question-screen',
  final_wager: 'final-wager-screen',
  final_question: 'question-screen',
  results: 'results-screen',
};

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
      // Mixed, so the final question really is swapped for one matching the
      // difficulty vote. With a single-difficulty bank that swap silently
      // never happens and the desync path is never walked.
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

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);

  const host = await seatWithName(table, 'Alice');
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  // A SETTING THAT DID NOT APPLY MUST NOT BE SILENT. Swallowing this is how
  // the first run played a 10-question game while every number printed said 3.
  const qOpt = host.page.locator(`[data-setting="questionsPerGame"] [data-value="${QUESTIONS}"]`);
  if (await qOpt.count() === 0) {
    problems.push(`host.html offers no ${QUESTIONS}-question option, so this ran at whatever the default is`);
  } else {
    await qOpt.click().catch(() => {});
  }
  // The default question timer is 30s; the shortest keeps a full game inside a
  // sensible wall clock without changing anything the fixes depend on.
  await host.page.click('[data-setting="questionTimer"] [data-value="15"]').catch(() => {});
  await host.page.waitForTimeout(300);
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);

  const code = await host.textOf('#lobby-code');
  note(`room ${code}, ${QUESTIONS} questions + a final`);

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
  const laggy = everyone.find(r => r.name === LAGGY) || host;

  await host.page.click('#btn-start-game').catch(() => {});
  await host.page.waitForURL('**/game.html*', { timeout: 25000 });
  for (const r of [bob, carol]) {
    await r.page.waitForURL('**/game.html*', { timeout: 25000 })
      .catch(() => problems.push(`${r.name} never reached the game screen`));
  }

  // THE LINK GOES BAD HERE AND STAYS BAD. Applied after the lobby so the setup
  // does not spend a minute of wall clock on it; from this point every round,
  // every reveal, every scoreboard and the final question run over it.
  laggy.slowConnection(LAG);
  note(`${laggy.name} is now on a ${LAG}ms round trip, for the rest of the game`);

  // ============================================================
  // THE WATCHER
  //
  // Sampled on its own timer rather than between turns, because a screen that
  // arrives late and a screen that never arrives look identical if you only
  // look once a turn — and "it didn't move me to another page" is precisely a
  // question about arrival.
  //
  // It records what the ROOM did and what each PHONE showed. The assertion at
  // the end is "did every phone eventually reach every phase the room visited",
  // which cannot be flaky: a slow arrival still arrives.
  // ============================================================
  const phasesVisited = new Set();
  const screensShown = { Alice: new Set(), Bob: new Set(), Carol: new Set() };
  const worstLagMs = { Alice: 0, Bob: 0, Carol: 0 };
  const waitingStreak = { Alice: 0, Bob: 0, Carol: 0 };
  const waitingAfterReveal = [];   // a row that outlived the reveal
  const consoleErrors = [];
  const navigations = [];
  const roomTimeline = [];
  let lastStamp = null;
  const bootAt = Date.now();

  // BOTH KINDS. The first version listened to `console` only and reported
  // "not one console error anywhere" on a run that was stalled — an unhandled
  // promise rejection arrives as `pageerror`, never as a console message, and
  // an async function whose caller does not await it fails in exactly that
  // silent way. A check that cannot see the commonest silent failure in this
  // codebase is a check that will report health.
  for (const r of everyone) {
    r.page.on('console', m => {
      const t = m.text();
      if (t.startsWith('PROBE')) { console.log(`   probe ${r.name}: ${t}`); return; }
      if (m.type() === 'error') consoleErrors.push(`${r.name} console: ${t.slice(0, 240)}`);
    });
    r.page.on('pageerror', e => {
      consoleErrors.push(`${r.name} THREW: ${(e.message || String(e)).slice(0, 240)}`);
    });
    // A PHONE THAT LEAVES THE PAGE IS NOT A PHONE WITH A SLOW SCREEN, and the
    // two are indistinguishable from the outside — "never showed the results
    // screen" reads the same whether the screen was late or the browser was
    // somewhere else entirely. Recording the navigation is what separates them.
    r.page.on('framenavigated', f => {
      if (f !== r.page.mainFrame()) return;
      navigations.push(`${r.name} -> ${f.url().split('/').pop()} at ${Date.now() - bootAt}ms`);
    });
  }

  // A PHASE REPEATS EVERY ROUND, so "when did this phase start" has to be reset
  // on every transition. The first version stamped it the FIRST time a phase
  // was seen and compared round five's question screen against round zero's
  // clock — it reported an 88-second screen lag on a link with no lag at all.
  // A confidently wrong number is worse than no number.
  let currentPhase = null;
  let phaseStartedAt = 0;
  let arrivedThisPhase = new Set();

  const SAMPLE_MS = 400;
  // "Waiting..." rows are re-rendered a beat after `resultsRevealed` flips, so
  // a single sample can catch the previous render still on screen. That is a
  // gap, not the bug — the reported fault was a row waiting "for ever, through
  // the reveal, the verdicts and the scoreboard". Only a streak counts.
  const WAITING_STREAK_TO_FLAG = Math.ceil(3000 / SAMPLE_MS);

  const watcher = setInterval(async () => {
    const room = table.store.table('rooms')[0];
    if (!room?.game_phase) return;
    const phase = room.game_phase;
    phasesVisited.add(phase);
    // The room's STATUS is a separate column from its phase, and two different
    // handlers navigate on it. Recording both is what makes "who moved this
    // phone" answerable instead of arguable.
    const stamp = `${phase}/${room.status}`;
    if (stamp !== lastStamp) {
      lastStamp = stamp;
      roomTimeline.push(`${stamp} at ${Date.now() - bootAt}ms`);
    }
    if (phase !== currentPhase) {
      currentPhase = phase;
      phaseStartedAt = Date.now();
      arrivedThisPhase = new Set();
    }
    const want = SCREEN_FOR_PHASE[phase];
    for (const r of everyone) {
      const seen = await r.page.evaluate(() => ({
        screen: document.querySelector('.screen.active')?.id || null,
        // The fix that shipped on 2026-09-06: a player with NO answer row sat
        // on "Waiting..." through the reveal. A bad link is exactly when a row
        // is most likely to be missing.
        revealed: !!window.__state?.resultsRevealed,
        stuckWaiting: document.querySelectorAll('.answer-row__answer--waiting').length,
      })).catch(() => null);
      if (!seen?.screen) continue;
      screensShown[r.name].add(seen.screen);

      if (want && seen.screen === want && !arrivedThisPhase.has(r.name)) {
        arrivedThisPhase.add(r.name);
        const lag = Date.now() - phaseStartedAt;
        if (lag > worstLagMs[r.name]) worstLagMs[r.name] = lag;
      }

      if (seen.screen === 'reveal-screen' && seen.revealed && seen.stuckWaiting > 0) {
        waitingStreak[r.name] += 1;
        if (waitingStreak[r.name] === WAITING_STREAK_TO_FLAG) {
          // ONE MORE QUESTION BEFORE CALLING IT A FAULT: is there anything
          // still legitimately in flight? Before the fill lands, a player
          // genuinely has no row yet and WAITING is the correct reading — the
          // rule the app follows deliberately, because showing a verdict on an
          // answer somebody did send is the worse mistake. Only when the store
          // already holds an answer for every player in this round is a
          // "Waiting..." row unambiguously wrong.
          //
          // Without this the check fired on UNTOUCHED code, intermittently,
          // which would have taught the next reader to ignore it.
          const rows = table.store.table('answers')
            .filter(a => String(a.room_id) === String(room.id)
                      && a.question_number === room.current_question);
          const players = table.store.table('players')
            .filter(p => String(p.room_id) === String(room.id) && !p.is_bot);
          const everyoneHasOne = players.length > 0
            && players.every(p => rows.some(a => String(a.player_id) === String(p.id)));
          if (everyoneHasOne) {
            waitingAfterReveal.push(`${r.name} showed ${seen.stuckWaiting} row(s) reading "Waiting..." for over 3s after the reveal, though every player already has an answer stored for round ${room.current_question}`);
          }
        }
      } else {
        waitingStreak[r.name] = 0;
      }
    }
  }, SAMPLE_MS);

  // ============================================================
  // PLAYING
  //
  // Driven by whatever screen each robot is actually on. A fixed click order
  // desynchronises on a bad link within a round and then reports the script's
  // own impatience as a bug.
  // ============================================================
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

  const answered = new Set();
  const lastTapAt = new Map();
  const HUMAN_RETAP_MS = 3000;
  // Every question each phone was ASKED, per round. On a bad link this is the
  // thing that went wrong in a real game: the room moved the list on and one
  // phone kept the question it already had.
  const askedByRound = new Map();   // round -> { name: questionText }

  async function takeTurn(r, roundHint) {
    const screen = await activeScreen(r);

    if (screen === 'question-screen') {
      const shown = (await r.page.textContent('#question-text').catch(() => '')) || '';
      if (shown.trim()) {
        if (!askedByRound.has(roundHint)) askedByRound.set(roundHint, {});
        askedByRound.get(roundHint)[r.name] = shown.trim();
      }
      const key = `${r.name}:${roundHint}`;
      if (answered.has(key)) return screen;

      const input = r.page.locator('#answer-input');
      if (!await input.isVisible().catch(() => false)) return screen;
      const wager = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
      if (await wager.count() > 0 && await wager.isVisible().catch(() => false)) {
        await wager.click().catch(() => {});
      }
      // Read the question off the screen — a round counter has nothing to do
      // with which question a given phone is showing, and on a bad link that
      // is the entire point of the exercise.
      const n = shown.match(/\d+/)?.[0];
      const text = r.name === 'Bob' ? 'definitely wrong' : (n ? `Answer ${n}` : 'no idea');
      await input.fill(text).catch(() => {});
      if (await clickIfReady(r, '#btn-submit-answer')) answered.add(key);
      return screen;
    }

    if (screen === 'final-wager-screen') {
      const key = `${r.name}:final`;
      if (!answered.has(key)) {
        const opt = r.page.locator('#final-wager-screen [data-wager="20"]').first();
        if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
        await r.page.locator('#final-wager-screen .dv-option[data-difficulty="hard"]')
          .first().click().catch(() => {});
        if (await clickIfReady(r, '#btn-fw-lock')) answered.add(key);
      }
      if (r === host) await clickIfReady(r, '#btn-fw-reveal');
      return screen;
    }

    if (screen === 'results-screen') return screen;

    // THE HOST TAPS LIKE A PERSON, NOT LIKE A LOOP.
    //
    // This ran every 400ms, which meant the host hammered "Next Question"
    // eight times while one slow write was still in flight — a rate no human
    // produces, and a fine way to manufacture a fault that does not exist.
    // A person taps, waits to see whether anything happened, and taps again.
    // HUMAN_RETAP_MS is that wait; keeping the retry at all is deliberate,
    // because tapping again when nothing moves is exactly what people do on a
    // bad connection and is how the double-reveal bug was found.
    if (r === host) {
      const target = screen === 'reveal-screen' ? '#btn-next-question'
        : screen === 'scores-screen' ? '#btn-scores-action' : null;
      if (target) {
        const key = `${screen}:${roundHint}`;
        const last = lastTapAt.get(key) || 0;
        if (Date.now() - last >= HUMAN_RETAP_MS) {
          if (await clickIfReady(r, target)) lastTapAt.set(key, Date.now());
        }
      }
    }
    return screen;
  }

  let round = 0;
  let lastQuestionSeen = -1;
  let reachedResults = false;
  const startedAt = Date.now();

  // Generous: every round trip on the laggy phone costs LAG, and there are
  // several per round. A game that cannot finish inside this is itself the
  // finding, which is why the failure below names the phase it stalled on.
  const BUDGET_MS = 240000;

  for (let step = 0; step < 400 && !reachedResults; step++) {
    if (Date.now() - startedAt > BUDGET_MS) break;
    for (const r of everyone) {
      await takeTurn(r, round).catch(() => '(navigating)');
    }
    const room = table.store.table('rooms')[0];
    if (room && room.game_phase === 'results') reachedResults = true;
    if (room && room.current_question !== lastQuestionSeen) {
      lastQuestionSeen = room.current_question;
      round = room.current_question ?? round;
      note(`round ${round} (phase ${room.game_phase})`);
    }
    await host.page.waitForTimeout(400);
  }

  // GENEROUS ON PURPOSE. showResultsScreen() awaits updateScores() AND
  // archiveChatMessages() before it switches the screen, so on a 1500ms link
  // the last phone needs several seconds after the room reaches results. A
  // 2.5s wait reported that as "never showed the results screen", which is the
  // scenario's own impatience wearing the costume of a product fault — the
  // thing this project has done more often than the app has misbehaved.
  await host.page.waitForTimeout(12000);
  clearInterval(watcher);

  // ============================================================
  // WHAT THE GAME DID
  // ============================================================
  note(`phases the room visited: ${[...phasesVisited].join(', ')}`);
  note(`room timeline (phase/status): ${roomTimeline.join('  |  ')}`);
  for (const n of navigations) note(`navigation: ${n}`);
  for (const r of everyone) {
    note(`${r.name} worst screen lag ${worstLagMs[r.name]}ms; screens ${[...screensShown[r.name]].join(', ') || '(none)'}`);
  }

  if (!reachedResults) {
    const room = table.store.table('rooms')[0];
    // A STALL MUST SAY WHY. "It did not finish" is indistinguishable from
    // "the scenario never pressed the right thing", and this project has
    // reported the harness's own impatience as a product bug more than once.
    // So dump what every phone was looking at and whether the control that
    // moves the game on was there, visible and enabled.
    for (const r of everyone) {
      const seen = await r.page.evaluate(() => {
        const btn = document.querySelector('#btn-scores-action')
          || document.querySelector('#btn-next-question')
          || document.querySelector('#btn-fw-reveal');
        return {
          screen: document.querySelector('.screen.active')?.id || null,
          phase: window.__state?.gamePhase ?? null,
          q: window.__state?.currentQuestion ?? null,
          onRevealScreen: window.__state?.onRevealScreen ?? null,
          // Which screens the DOM thinks are active/visible, which is a
          // different question from which one the app believes it is on.
          activeEls: [...document.querySelectorAll('.screen.active')].map(e => e.id),
          visibleEls: [...document.querySelectorAll('.screen')]
            .filter(e => getComputedStyle(e).display !== 'none').map(e => e.id),
          btn: btn ? {
            id: btn.id,
            text: (btn.textContent || '').trim().slice(0, 40),
            visible: btn.offsetParent !== null,
            disabled: !!btn.disabled,
          } : null,
        };
      }).catch(e => ({ error: e.message }));
      note(`STALLED — ${r.name}: ${JSON.stringify(seen)}`);
    }
    // A stall WITH a thrown error is a different finding from a stall in
    // silence, and the silent one is the harder of the two to explain.
    for (const n of navigations) note(`STALLED — navigation: ${n}`);
    if (consoleErrors.length === 0) note('STALLED — and not one console error anywhere');
    else for (const e of consoleErrors.slice(0, 6)) note(`STALLED — console: ${e}`);
    problems.push(`the game never reached results on a ${LAG}ms link — stuck on phase ${room?.game_phase}, question ${room?.current_question}`);
  }

  // EVERY PHONE MUST REACH EVERY SCREEN THE ROOM WENT TO.
  //
  // This is the reported bug stated as a rule: "it didn't move me (host) to
  // another page. The other player was able to advance." A late screen still
  // arrives; a screen that never arrives is what this catches, and it cannot
  // be flaky for the same reason.
  for (const r of everyone) {
    for (const phase of phasesVisited) {
      const want = SCREEN_FOR_PHASE[phase];
      if (!want) continue;
      if (!screensShown[r.name].has(want)) {
        problems.push(`the room reached "${phase}" and ${r.name}'s screen NEVER showed ${want} — the room moved on without them`);
      }
    }
  }

  // EVERYBODY IS ASKED THE SAME QUESTION.
  //
  // Migration 046 judges against the ROOM's question, so a phone showing a
  // different one is marked wrong on a question nobody asked it.
  // READ FROM THE STORED ANSWERS, NOT OFF THE SCREENS.
  //
  // The first version bucketed "what is on your screen right now" by a loop
  // counter and reported a disagreement in every single round — because on a
  // laggy link one phone has already moved to the next question while the
  // others are still on the previous one, which is a SAMPLING SKEW and not a
  // disagreement at all. It named the app for the harness's own impatience,
  // which this project has done more often than the app has misbehaved.
  //
  // Every answer row carries the question it was answered against. Two rows
  // for the same round naming different questions is the real fault, it is
  // recorded rather than observed, and it cannot be a timing artefact.
  const byRound = new Map();
  for (const a of table.store.table('answers')) {
    if (a.question_number == null || a.question_id == null) continue;
    if (!byRound.has(a.question_number)) byRound.set(a.question_number, new Map());
    byRound.get(a.question_number).set(String(a.player_id), String(a.question_id));
  }
  for (const [rnd, byPlayer] of byRound) {
    const distinct = new Set(byPlayer.values());
    if (distinct.size > 1) {
      problems.push(`round ${rnd}: the phones ANSWERED ${distinct.size} DIFFERENT questions — ${JSON.stringify([...distinct])}`);
    }
  }
  note(`rounds with recorded answers: ${byRound.size}; screens sampled across ${askedByRound.size} round(s)`);
  if (byRound.size < 2) {
    problems.push('fewer than two rounds produced answers, so nothing about question agreement was actually tested');
  }

  // NOBODY WAITS FOR EVER. The display fix from 2026-09-06, under the
  // conditions most likely to produce a missing row.
  if (waitingAfterReveal.length) {
    problems.push(waitingAfterReveal[0]);
  }

  // EVERY ROUND GETS ITS OWN CLOCK — a stamp refused on a slow link used to
  // fall back to the previous round's, opening a timer already run down.
  const rounds = table.store.table('answers')
    .filter(a => a.question_number != null)
    .map(a => a.question_number);
  note(`answers recorded across ${new Set(rounds).size} round(s)`);

  const room = table.store.table('rooms')[0];
  if (reachedResults && !room?.question_started_at) {
    problems.push('the room finished with no clock stamp at all');
  }

  if (consoleErrors.length) {
    for (const e of consoleErrors.slice(0, 5)) note(`console: ${e}`);
    problems.push(`${consoleErrors.length} console error(s) during a game on a bad link — first: ${consoleErrors[0]}`);
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
  console.log('\n✓ bad-network scenario passed');
}
