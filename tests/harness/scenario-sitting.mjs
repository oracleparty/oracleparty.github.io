// Scenario: A WHOLE SITTING IN ONE ROOM — several games, Play Again between.
//
// WHY THIS EXISTS. The owner's report after a real evening: "I feel like it
// kept accumulating." One room the whole time, Play Again between games, and
// the faults got worse the longer they played.
//
// Every other scenario here plays ONE game (scenario-playagain plays two), and
// a fault that grows by a little each game is invisible at one or two. This
// plays SITTING_GAMES of them and measures, after every single one, the things
// that could be growing:
//
//   * answers left over from a finished game — the clear-out is HOST-GATED, so
//     a room that returns to the lobby without its host keeps them, and a
//     leftover row occupies the (room, player, round) key the next game's blank
//     fill needs. That is migration 066's whole subject.
//   * seats — one person, one seat, across any number of rejoins and games.
//   * the rounds actually asked — used_question_ids persists across Play Again,
//     so a room runs its own category down and games can silently shrink.
//   * Realtime channels held by each phone — a leak compounds the longer a
//     session runs, which is the definition of the report.
//   * console errors per phone, counted per game rather than in total, so a
//     rate that climbs is visible rather than a total that only ever rises.
//   * the timer element, which one bug this month deleted out of the DOM for
//     the rest of a game.
//
// It is NOT a playtest and must not be reported as one: an in-memory store on
// a fast machine cannot see a real radio or a real phone. What it CAN see is
// anything that is monotonically getting worse.
//
// --lag=N --on=Name gives ONE phone a real round trip for the WHOLE sitting.
// scenario-badnetwork does that for a single game; nothing had ever carried it
// across Play Again, and "it kept accumulating" is a statement about a sitting
// rather than about a game. A healthy sitting is clean (measured, 4 games), so
// whatever the owner saw needs a condition, and a phone on a real connection is
// the likeliest one they actually had.
//
// --leftovers makes the host's end-of-game clear-out FAIL once, which is the
// state a room is in whenever Play Again is pressed by somebody the row does
// not call host. From there every later game inherits rows it cannot see.
//
// Run: node tests/harness/scenario-sitting.mjs [--games=4] [--lag=800 --on=Bob] [--leftovers]
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : dflt;
};
const SITTING_GAMES = arg('games', 4);
const LAG = arg('lag', 0);
const LAG_ON = (process.argv.find(a => a.startsWith('--on=')) || '--on=Bob').split('=')[1];
const LEFTOVERS = process.argv.includes('--leftovers');
const STRAGGLER = process.argv.includes('--straggler');
const QUESTIONS_PER_GAME = 5;      // + 1 final = 6 rounds

const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

function seedQuestions(store, n = 80) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`,
      question: `Test question ${i}?`,
      correct_answer: `Answer ${i}`,
      acceptable_answers: [],
      categories: [CATEGORY],
      subcategory: null,
      difficulty: 'medium',
      format: 'open',
      fun_fact: null,
      discarded: false,
    });
  }
  store.seed('questions', rows);
}

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

async function answerQuestion(r, text) {
  const input = r.page.locator('#answer-input');
  try { await input.waitFor({ state: 'visible', timeout: 10000 }); } catch { return false; }
  const wager = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
  if (await wager.isVisible().catch(() => false)) await wager.click().catch(() => {});
  await input.fill(text).catch(() => {});
  if (!await r.page.isEnabled('#btn-submit-answer').catch(() => false)) return false;
  await r.page.click('#btn-submit-answer').catch(() => {});
  return true;
}

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);

  async function seat(name) {
    const r = await table.seat(name);
    await r.page.addInitScript(n => localStorage.setItem('oracle_party_display_name', n), name);
    return r;
  }

  const host = await seat('Alice');
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click(`[data-setting="questionsPerGame"] [data-value="${QUESTIONS_PER_GAME}"]`).catch(() => {});
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
  await host.page.waitForTimeout(1500);

  // A PRACTICE BOT, because the owner's own room had one and a bot is a player
  // row that never heartbeats — every sweep and every count has to skip it.
  await clickIfReady(host, '#btn-add-bot');
  await host.page.waitForTimeout(1200);
  note(`room seats after setup: ${table.store.table('players').map(p => p.display_name).join(', ')}`);

  const everyone = [host, bob];
  const roomRow = () => table.store.table('rooms')[0];

  if (LAG > 0) {
    const target = everyone.find(r => r.name === LAG_ON) || bob;
    target.slowConnection(LAG);
    note(`${target.name} is on a ${LAG}ms round trip for the whole sitting`);
  }

  /** What a finished game left behind, measured rather than assumed. */
  async function census(gameNo) {
    const room = roomRow();
    const answers = table.store.table('answers').filter(a => String(a.room_id) === String(room.id));
    const live = new Set((room.question_ids || []).map(String));
    const leftovers = answers.filter(a => a.question_id && !live.has(String(a.question_id)));
    // NAME THE ROW. "An answer naming a question the room is not asking" has two
    // very different causes — a straggler from a FINISHED game, and a row
    // stamped with a question id this game has since SWAPPED (the final round
    // is replaced by difficulty) — and the count alone cannot tell them apart.
    // Guessing which would be exactly the mistake this file keeps recording.
    const seatName = id => table.store.table('players')
      .find(p => String(p.id) === String(id))?.display_name || '(gone)';
    const describe = leftovers.map(a =>
      `${seatName(a.player_id)} round ${a.question_number} names ${a.question_id} `
      + `(answer ${JSON.stringify((a.submitted_answer || '').slice(0, 14))}, `
      + `room is asking ${(room.question_ids || [])[a.question_number] || '(none)'})`);
    const seats = table.store.table('players').filter(p => String(p.room_id) === String(room.id));
    const names = seats.map(p => p.display_name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);

    const perPhone = {};
    for (const r of everyone) {
      perPhone[r.name] = {
        channels: await r.openChannelCount().catch(() => -1),
        errors: r.consoleErrors.length,
        timer: await r.page.evaluate(() => ({
          bar: !!document.getElementById('timer-bar'),
          text: !!document.getElementById('timer-text'),
        })).catch(() => null),
      };
    }
    return {
      game: gameNo,
      answers: answers.length,
      leftovers: leftovers.length,
      seats: seats.length,
      dupes,
      used: (room.used_question_ids || []).length,
      list: (room.question_ids || []).length,
      // How many DISTINCT rounds actually carried an answer for a human. This
      // is the number a player feels: a round nobody has a row for was not
      // played, whatever the room's counters say.
      roundsWithAnswers: new Set(answers.map(a => a.question_number)).size,
      describe,
      perPhone,
    };
  }

  async function playAGame(n) {
    heading(`game ${n} of ${SITTING_GAMES}`);
    await host.page.waitForSelector('#btn-start-game', { state: 'visible', timeout: 25000 }).catch(() => {});
    let started = false;
    for (let attempt = 0; attempt < 14 && !started; attempt++) {
      await clickIfReady(host, '#btn-start-game');
      await host.page.waitForTimeout(700);
      const room = roomRow();
      started = room?.status === 'playing' || (room?.question_ids || []).length > 0;
    }
    if (!started) { problems.push(`game ${n}: Start Game never took effect`); return false; }

    // A GAME MUST NOT BEGIN HOLDING A FINISHED GAME'S ANSWERS.
    //
    // Measured at the START, which is the only moment a straggler is visible:
    // once the round's blank fill runs, migration 066 converts the row and it
    // stops naming an old question. So the census at the END of a game cannot
    // see what the beginning of it inherited.
    {
      const room = roomRow();
      const live = new Set((room.question_ids || []).map(String));
      const stale = table.store.table('answers').filter(a =>
        String(a.room_id) === String(room.id) && a.question_id && !live.has(String(a.question_id)));
      if (stale.length) {
        problems.push(`game ${n} STARTED holding ${stale.length} answer(s) from a finished game — invisible on every screen, and still occupying the (room, player, round) key this game's blank fill needs`);
      }
    }
    for (const r of everyone) {
      await r.page.waitForURL('**/game.html*', { timeout: 25000 })
        .catch(() => problems.push(`game ${n}: ${r.name} never reached the game`));
    }

    const answered = new Set();
    const timerGone = new Set();
    let done = false;
    for (let step = 0; step < 200 && !done; step++) {
      for (const r of everyone) {
        const room = roomRow();
        if (room?.game_phase === 'results') break;
        const screen = await activeScreen(r);
        const q = room?.current_question ?? 0;

        if (screen === 'question-screen') {
          // The timer must still BE a timer, on every question of every game.
          const t = await r.page.evaluate(() => ({
            bar: !!document.getElementById('timer-bar'),
            text: !!document.getElementById('timer-text'),
          })).catch(() => null);
          if (t && (!t.bar || !t.text)) timerGone.add(`${r.name} on round ${q}`);
          const key = `${r.name}:${q}`;
          if (!answered.has(key)) {
            if (await answerQuestion(r, `Answer ${q + 1}`)) answered.add(key);
          }
        } else if (screen === 'final-wager-screen') {
          const key = `${r.name}:final`;
          if (!answered.has(key)) {
            const opt = r.page.locator('#final-wager-screen [data-wager]').first();
            if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
            if (await clickIfReady(r, '#btn-fw-lock')) answered.add(key);
          }
          if (r === host) await clickIfReady(r, '#btn-fw-reveal');
        } else if (screen !== 'results-screen' && r === host) {
          if (screen === 'reveal-screen') await clickIfReady(r, '#btn-next-question');
          if (screen === 'scores-screen') await clickIfReady(r, '#btn-scores-action');
        }
      }
      if (roomRow()?.game_phase === 'results') done = true;
      await host.page.waitForTimeout(400);
    }
    for (const t of timerGone) {
      problems.push(`game ${n}: the timer was gone from the DOM for ${t} — a question screen with no countdown at all`);
    }
    if (!done) {
      const room = roomRow();
      problems.push(`game ${n}: never reached results (phase ${room?.game_phase}, question ${room?.current_question})`);
    }
    return done;
  }

  async function playAgain(n) {
    await host.page.waitForTimeout(1500);
    if (!await host.page.locator('#btn-play-again').isVisible().catch(() => false)) {
      problems.push(`game ${n}: Play Again is not visible on ${await activeScreen(host)}`);
      return false;
    }
    await host.page.click('#btn-play-again').catch(() => {});
    await bob.page.waitForTimeout(2000);
    await clickIfReady(bob, '#btn-return-lobby');
    await clickIfReady(bob, '#btn-play-again');
    for (const r of everyone) {
      await r.page.waitForURL('**/lobby.html*', { timeout: 25000 })
        .catch(() => problems.push(`game ${n}: ${r.name} did not get back to the lobby`));
    }
    await host.page.waitForTimeout(2500);
    return true;
  }

  const censuses = [];
  for (let n = 1; n <= SITTING_GAMES; n++) {
    // ONE FAILED CLEAR-OUT, AFTER THE FIRST GAME. That is the state a room
    // reaches whenever Play Again is pressed by somebody the row does not call
    // host — deleteAnswersByRoom sits behind `if (state.room?.isHost)` — and
    // every later game then inherits rows it can neither see nor overwrite.
    if (LEFTOVERS && n === 2) {
      table.store.failFunction('op_reset_answers', { code: '42501', message: 'seeded failure' });
      note('the end-of-game clear-out will fail once, as it does for a room whose host has gone');
    }
    const finished = await playAGame(n);
    const c = await census(n);
    censuses.push(c);
    note(`after game ${n}: ${c.answers} answers (${c.leftovers} from a finished game), `
       + `${c.seats} seats, ${c.roundsWithAnswers} rounds answered, used_question_ids=${c.used}`);
    note(`  phones: ${everyone.map(r => `${r.name} ch=${c.perPhone[r.name].channels} err=${c.perPhone[r.name].errors}`).join('  ')}`);
    if (LEFTOVERS && n === 2) table.store.unfailFunction('op_reset_answers');
    if (!finished) break;
    if (n < SITTING_GAMES) {
      if (!await playAgain(n)) break;
      // A WRITE THAT WAS STILL IN FLIGHT WHEN THE GAME ENDED.
      //
      // SET, NOT RACED. Reaching this by playing needs a phone slow enough that
      // its final-round write lands after Play Again's clear-out — measured
      // once in four games at an 800ms round trip, which is a real failure with
      // a timing condition attached and a check nobody would trust. The row
      // below is exactly what that straggler leaves: an answer naming the game
      // that has just finished, written after the room was cleared.
      if (STRAGGLER) {
        const room = roomRow();
        const bobSeat = table.store.table('players').find(p => p.display_name === 'Bob');
        const oldQuestion = (censuses[n - 1] && `q${90 + n}`) || 'q99';
        table.store.table('answers').push({
          id: `straggler-${n}`,
          room_id: room.id,
          player_id: bobSeat?.id,
          question_number: 2,
          question_id: oldQuestion,
          submitted_answer: 'late',
          wager: 3,
          is_correct: false,
          auto_correct: false,
          score_earned: 0,
          disqualified: false,
        });
        note(`a late write from game ${n} landed after the room was cleared`);
      }
    }
  }

  // ------------------------------------------------------------------
  // WHAT GREW. Each of these is a MONOTONIC comparison rather than a
  // threshold, because "it kept accumulating" is a shape, not a number — and a
  // threshold picked here would either fire on game one or never fire at all.
  // ------------------------------------------------------------------
  heading('what accumulated across the sitting');
  const first = censuses[0];
  const last = censuses[censuses.length - 1];
  if (!first || censuses.length < 2) {
    problems.push('fewer than two games completed, so nothing here can be compared');
  } else {
    note(`answers in the room: ${censuses.map(c => c.answers).join(' -> ')}`);
    note(`left over from a finished game: ${censuses.map(c => c.leftovers).join(' -> ')}`);
    note(`seats: ${censuses.map(c => c.seats).join(' -> ')}`);
    note(`rounds answered: ${censuses.map(c => c.roundsWithAnswers).join(' -> ')}`);
    note(`used_question_ids: ${censuses.map(c => c.used).join(' -> ')}`);
    for (const r of everyone) {
      note(`${r.name} channels: ${censuses.map(c => c.perPhone[r.name].channels).join(' -> ')}`);
      note(`${r.name} console errors: ${censuses.map(c => c.perPhone[r.name].errors).join(' -> ')}`);
    }

    // A FINISHED GAME'S ANSWERS MUST NOT SURVIVE INTO THE NEXT ONE. They are
    // invisible to the client (answersForCurrentGame filters them out) and they
    // still occupy the key the blank fill needs, so the player they belong to
    // gets no row for that round at all: "Waiting…" for ever and a score of
    // nothing. That is migration 066's subject, and the leftover only exists
    // once a room has played more than one game.
    const withLeftovers = censuses.filter(c => c.leftovers > 0);
    for (const c of censuses) {
      for (const d of c.describe) note(`game ${c.game} left behind: ${d}`);
    }
    if (withLeftovers.length) {
      problems.push(`answers from a finished game survived into a later one: ${withLeftovers.map(c => `game ${c.game} carried ${c.leftovers}`).join(', ')} — those rows are invisible on screen and still hold the key the blank fill needs`);
    }

    // ONE PERSON, ONE SEAT, however many games are played in the room.
    for (const c of censuses) {
      if (c.dupes.length) problems.push(`game ${c.game} ran with duplicate seats: ${c.dupes.join(', ')}`);
    }
    if (last.seats > first.seats) {
      problems.push(`the room grew from ${first.seats} seats to ${last.seats} over ${censuses.length} games — a seat is being added and never removed`);
    }

    // A LATER GAME MUST NOT BE SHORTER THAN AN EARLIER ONE. used_question_ids
    // persists across Play Again, so a room runs its own category down; the
    // fetchers top up rather than shrinking the game, and this is what says so.
    for (const c of censuses) {
      if (c.roundsWithAnswers < first.roundsWithAnswers) {
        problems.push(`game ${c.game} asked ${c.roundsWithAnswers} rounds where game 1 asked ${first.roundsWithAnswers} — the game is shrinking as the room plays on`);
      }
    }

    // A LEAK COMPOUNDS, WHICH IS THE REPORT. Channels are re-counted on the
    // lobby/results screen each time, so a steady number is correct and a
    // rising one is a subscription nobody released.
    for (const r of everyone) {
      const ch = censuses.map(c => c.perPhone[r.name].channels);
      if (ch[ch.length - 1] > ch[0]) {
        problems.push(`${r.name} held ${ch[0]} Realtime channels after game 1 and ${ch[ch.length - 1]} after game ${last.game} (${ch.join(' -> ')}) — a leak that compounds for as long as the room is open`);
      }
      // Errors are counted per GAME, not in total: a total can only rise, so a
      // rising total says nothing. A RATE that rises is the accumulation.
      const perGame = censuses.map((c, i) =>
        c.perPhone[r.name].errors - (i ? censuses[i - 1].perPhone[r.name].errors : 0));
      note(`${r.name} console errors per game: ${perGame.join(' -> ')}`);
      if (perGame[perGame.length - 1] > perGame[0] && perGame[perGame.length - 1] > 0) {
        const seen = r.consoleErrors.slice(-3).map(e => e.slice(0, 120));
        problems.push(`${r.name} produced ${perGame[0]} console error(s) in game 1 and ${perGame[perGame.length - 1]} in game ${last.game} — last: ${JSON.stringify(seen)}`);
      }
    }
  }
} catch (err) {
  problems.push(`sitting scenario threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ the sitting found problems:' : '✓ nothing accumulated across the sitting'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
