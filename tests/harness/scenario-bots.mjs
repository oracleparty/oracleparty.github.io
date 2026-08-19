// Scenario: the practice bot.
//
// A bot is a `players` row with is_bot set, answered for by the host's browser.
// Four rules the owner set, and every one of them is checked here:
//
//   1. Only a human adds one, and only a host — there are no bot-only rooms.
//   2. A bot is never host or co-host.
//   3. Nothing it does is recorded — not question_stats, not answer_tally,
//      not the human's own game history.
//   4. Nobody waits for a bot: it answers the instant the question starts.
//
// Plus the two things that make it playable at all:
//
//   5. A host alone with a bot can play a whole game — that is the point.
//   6. No wrong answer is ever invented. Every miss is one of the question's
//      own stored distractors, or blank.
//
// Run: node tests/harness/scenario-bots.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const QUESTIONS = 5;   // must be one of the options host.html actually offers
const HUMAN_ANSWER = 'zzhumantyped';   // distinctive: nothing else can produce it
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

// Every question carries stored distractors, EXCEPT q3, which carries none.
// That gap is deliberate: a question with no incorrect_answers must produce a
// blank rather than an invented wrong answer, and 20% of the real bank is in
// exactly that state.
const WRONG = { q1: ['Wrong 1a', 'Wrong 1b'], q2: ['Wrong 2a'], q3: [], q4: ['Wrong 4a'], q5: ['Wrong 5a'] };

function seedQuestions(store, n = 40) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`,
      question: `Test question ${i}?`,
      correct_answer: `Answer ${i}`,
      acceptable_answers: [],
      incorrect_answers: WRONG[`q${i}`] ?? [`Wrong ${i}a`, `Wrong ${i}b`],
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

  // The host is SIGNED IN, not a guest. game_history is only written for an
  // authenticated player, so a guest host would make the "a bot is not counted
  // in your history" check below pass vacuously — it would be measuring
  // nothing, which is the harness failure mode this project has hit most.
  const host = await table.seatSignedIn('Alice', { tier: 'Scholar' });
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click(`[data-setting="questionsPerGame"] [data-value="${QUESTIONS}"]`);
  await host.page.waitForTimeout(300);
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1500);
  const code = await host.textOf('#lobby-code');

  // Read the count back rather than trusting the click. A settings button that
  // silently missed would leave every wager assertion below comparing against
  // the wrong number and reporting the harness's own mistake as a bot bug.
  const total = table.store.table('rooms')[0]?.questions_per_game
             ?? table.store.table('rooms')[0]?.total_questions;
  note(`room is set to ${total} questions`);
  if (total !== QUESTIONS) {
    problems.push(`the room was created with ${total} questions, not ${QUESTIONS} — the setting did not take`);
  }

  // ============================================================
  // 1. ONLY A HUMAN HOST CAN ADD ONE
  // ============================================================
  heading('who can add a bot');

  const hostSeesAdd = await host.page.locator('#btn-add-bot').isVisible().catch(() => false);
  note(`host is offered the add-bot button: ${hostSeesAdd}`);
  if (!hostSeesAdd) problems.push('the host is never offered a way to add a practice bot');

  const bob = await seat('Bob');
  await bob.goto('join.html');
  await bob.page.waitForSelector('#code-input', { timeout: 15000 });
  await bob.page.fill('#code-input', code);
  await bob.page.click('#btn-join');
  await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await bob.page.waitForTimeout(1500);

  const guestSeesAdd = await bob.page.locator('#btn-add-bot').isVisible().catch(() => false);
  note(`non-host is offered the add-bot button: ${guestSeesAdd}`);
  if (guestSeesAdd) problems.push('a player who is not the host can add a bot to the room');

  // ============================================================
  // ADD IT
  // ============================================================
  heading('adding the bot');
  await clickIfReady(host, '#btn-add-bot');
  await host.page.waitForTimeout(2000);

  const botRow = table.store.table('players').find(p => p.is_bot);
  note(`bot row in the database: ${botRow ? `${botRow.display_name} (is_bot=${botRow.is_bot})` : 'none'}`);
  if (!botRow) {
    problems.push('pressing the add-bot button created no bot');
  } else {
    if (botRow.is_host) problems.push('the bot was created as host');
    if (botRow.is_cohost) problems.push('the bot was created as co-host');
  }

  // Both people can see it, not just the host who added it.
  for (const r of [host, bob]) {
    const sees = await r.page.evaluate(() => !!document.querySelector('.badge--bot')).catch(() => false);
    note(`${r.name} sees a bot badge: ${sees}`);
    if (!sees) problems.push(`${r.name} cannot see that there is a bot in the room`);
  }

  // The add button goes away once the room is at its bot limit, so add and
  // remove are never both on offer at once.
  const stillOffered = await host.page.locator('#btn-add-bot').isVisible().catch(() => false);
  note(`add-bot still offered after adding one: ${stillOffered}`);
  if (stillOffered) problems.push('the host can keep adding bots past the limit');

  // ============================================================
  // 2. NEVER HOST, NEVER CO-HOST
  // ============================================================
  heading('a bot can never be given the room');
  if (botRow) {
    const promoteOffered = await host.page.evaluate(id => ({
      transfer: !!document.querySelector(`.transfer-host-btn[data-transfer-id="${id}"]`),
      cohost: !!document.querySelector(`.cohost-btn[data-cohost-id="${id}"]`),
      remove: !!document.querySelector(`.remove-bot-btn[data-remove-bot-id="${id}"]`),
    }), botRow.id).catch(() => ({}));
    note(`controls offered on the bot's row: ${JSON.stringify(promoteOffered)}`);
    if (promoteOffered.transfer) problems.push('the host is offered a Make Host button on a bot');
    if (promoteOffered.cohost) problems.push('the host is offered a Co-Host button on a bot');
    if (!promoteOffered.remove) problems.push('the host has no way to remove a bot');
  }

  // ============================================================
  // 5. A GAME PLAYED WITH A BOT IN IT
  // ============================================================
  heading('playing a game with the bot');

  // Bob leaves, so the game is one human and one bot — the solo case the bot
  // exists for. Leaving must NOT take the room with it: the host is still here.
  await clickIfReady(bob, '#btn-leave');
  await bob.page.waitForTimeout(2500);
  const roomAfterBobLeft = table.store.table('rooms')[0];
  note(`room still exists after the second human left: ${!!roomAfterBobLeft}`);
  if (!roomAfterBobLeft) problems.push('a player leaving destroyed a room the host was still in');

  await host.page.waitForTimeout(1500);
  const canStartSolo = await host.page.evaluate(() => {
    const b = document.querySelector('#btn-start-game');
    return !!b && b.offsetParent !== null && !b.disabled;
  }).catch(() => false);
  note(`host alone with a bot can start: ${canStartSolo}`);
  if (!canStartSolo) problems.push('a host alone with a bot cannot start a game — solo play is impossible');

  for (let i = 0; i < 12; i++) {
    await clickIfReady(host, '#btn-start-game');
    await host.page.waitForTimeout(700);
    if (table.store.table('rooms')[0]?.status === 'playing') break;
  }
  await host.page.waitForURL('**/game.html*', { timeout: 25000 })
    .catch(() => problems.push('the host never reached the game'));
  await host.page.waitForTimeout(6500);

  // ============================================================
  // 4. NOBODY WAITS FOR A BOT
  //
  // Measured at the first question: by the time the human's own answer input
  // is on screen, the bot's answer is already in the database. If this ever
  // needs a wait added to pass, the bot has stopped answering immediately.
  // ============================================================
  heading('the bot answers without being waited for');
  if (botRow) {
    const early = table.store.table('answers')
      .filter(a => String(a.player_id) === String(botRow.id) && a.question_number === 0);
    note(`bot answers on the board before the human answered anything: ${early.length}`);
    if (early.length === 0) {
      problems.push('the bot had not answered by the time the question was live — somebody is waiting for it');
    }
  }

  // Play the whole game. The host drives; the bot needs no driving at all.
  const answered = new Set();
  let reachedResults = false;
  let round = 0;

  for (let step = 0; step < 200 && !reachedResults; step++) {
    const screen = await activeScreen(host);

    if (screen === 'question-screen') {
      const key = `q${round}`;
      if (!answered.has(key)) {
        const input = host.page.locator('#answer-input');
        if (await input.isVisible().catch(() => false)) {
          const w = host.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
          if (await w.count() > 0 && await w.isVisible().catch(() => false)) await w.click().catch(() => {});
          await input.fill(HUMAN_ANSWER).catch(() => {});
          if (await clickIfReady(host, '#btn-submit-answer')) answered.add(key);
        }
      }
    } else if (screen === 'final-wager-screen') {
      if (!answered.has('final')) {
        const opt = host.page.locator('#final-wager-screen [data-wager]').first();
        if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
        if (await clickIfReady(host, '#btn-fw-lock')) answered.add('final');
      }
      await clickIfReady(host, '#btn-fw-reveal');
    } else if (screen === 'reveal-screen') {
      await clickIfReady(host, '#btn-next-question');
    } else if (screen === 'scores-screen') {
      await clickIfReady(host, '#btn-scores-action');
    }

    const room = table.store.table('rooms')[0];
    if (room?.game_phase === 'results') reachedResults = true;
    if (room && room.current_question !== round) {
      round = room.current_question ?? round;
      note(`round ${round} (phase ${room.game_phase})`);
    }
    await host.page.waitForTimeout(450);
  }

  if (!reachedResults) {
    const room = table.store.table('rooms')[0];
    problems.push(`a solo game with a bot never reached results (phase ${room?.game_phase}, question ${room?.current_question})`);
  }
  await host.page.waitForTimeout(2000);

  // ============================================================
  // THE BOT PLAYED EVERY ROUND, AND SPENT EACH WAGER ONCE
  // ============================================================
  heading('the bot played a full game');
  const botAnswers = botRow
    ? table.store.table('answers').filter(a => String(a.player_id) === String(botRow.id))
    : [];
  const n = total ?? QUESTIONS;
  const regular = botAnswers.filter(a => a.question_number < n);
  note(`bot answered ${regular.length} of ${n} regular questions (+${botAnswers.length - regular.length} final)`);
  if (regular.length < n) {
    problems.push(`the bot missed ${n - regular.length} question(s) — it should never miss one`);
  }

  // Values 1..N are each used exactly once. A bot spending one twice would
  // score more than the game allows, and is the exact bug the host's blank-fill
  // had before it started computing each player's own lowest unused wager.
  const wagers = regular.map(a => a.wager).sort((a, b) => a - b);
  note(`bot wagers: ${JSON.stringify(wagers)}`);
  if (new Set(wagers).size !== wagers.length) {
    problems.push(`the bot spent a wager twice: ${JSON.stringify(wagers)} — values 1..N are each used once`);
  }
  if (wagers.some(w => w < 1 || w > n)) {
    problems.push(`the bot used a wager outside 1..${n}: ${JSON.stringify(wagers)}`);
  }

  // ============================================================
  // 6. NO WRONG ANSWER IS EVER INVENTED
  // ============================================================
  heading('every wrong answer came from the question itself');
  for (const a of botAnswers) {
    const q = table.store.table('questions').find(x => String(x.id) === String(a.question_id));
    if (!q) continue;
    const text = (a.submitted_answer || '').trim();
    if (text === '' || text === '__WAGER_LOCKED__') continue;      // blank is allowed
    const allowed = [q.correct_answer, ...(q.incorrect_answers || [])];
    if (!allowed.includes(text)) {
      problems.push(`the bot typed "${text}" for ${q.id}, which is neither the answer nor one of its stored wrong answers`);
    }
    if (text === q.correct_answer && !a.is_correct) {
      problems.push(`the bot gave the correct answer to ${q.id} and was marked wrong`);
    }
    if (text !== q.correct_answer && a.is_correct) {
      problems.push(`the bot gave a stored wrong answer to ${q.id} and was marked correct`);
    }
  }
  const blanks = botAnswers.filter(a => !(a.submitted_answer || '').trim());
  note(`bot answered blank ${blanks.length} time(s) — expected only where the question stores no wrong answers`);

  // ============================================================
  // 3. NOTHING A BOT DOES IS RECORDED
  // ============================================================
  heading('nothing the bot did was recorded');

  const tally = table.store.table('answer_tally');
  note(`answer_tally rows: ${JSON.stringify(tally.map(t => `${t.answer_key} x${t.times_given}`))}`);
  const strayTally = tally.filter(t => t.answer_key !== HUMAN_ANSWER);
  if (strayTally.length) {
    problems.push(`the bot's answers reached answer_tally: ${JSON.stringify(strayTally.map(t => t.answer_key))}`);
  }

  // question_stats counts one row per ANSWER, so a bot in the room would show
  // up as times_asked 2 where a lone human is 1. This is the check that failed
  // when the bot guard sat between the two writes instead of before them.
  const stats = table.store.table('question_stats');
  note(`question_stats: ${JSON.stringify(stats.map(s => `${s.question_id}:asked=${s.times_asked}`))}`);
  const doubled = stats.filter(s => s.times_asked > 1);
  if (doubled.length) {
    problems.push(`the bot was counted in question_stats: ${JSON.stringify(doubled.map(s => `${s.question_id} asked ${s.times_asked}x`))}`);
  }
  if (stats.length === 0) {
    problems.push('no question outcomes were recorded at all — the check above proves nothing');
  }

  // ============================================================
  // THE BOT IS NEVER SHOWN AS AWAY
  //
  // It joins no presence channel, so without the exemption it sits faded at
  // 40% opacity — the "their phone is asleep, do not wait for them" signal —
  // through every reveal and scoreboard, while being the one player that has
  // always already answered.
  // ============================================================
  heading('the bot is never faded as away');
  const faded = await host.page.evaluate(() =>
    [...document.querySelectorAll('[class*="--away"]')].map(el => el.className)).catch(() => []);
  note(`rows marked away on the results screen: ${JSON.stringify(faded)}`);
  if (faded.length) problems.push(`something is marked away in a solo game with a bot: ${JSON.stringify(faded)}`);

  // The stale sweep must not have removed it either — it sends no heartbeat,
  // so its last_seen_at never moves.
  const botStillThere = table.store.table('players').some(p => p.is_bot);
  note(`bot survived the game without being swept out: ${botStillThere}`);
  if (!botStillThere) problems.push('the bot was removed mid-game by the stale-player sweep');

  // The human's own history must be about humans. Alice is signed in, so this
  // row exists — a guest host would write nothing and the loop below would
  // pass by having nothing to look at.
  const history = table.store.table('game_history');
  note(`game_history: ${JSON.stringify(history.map(h => `place ${h.placement} of ${h.total_players}`))}`);
  if (history.length === 0) {
    problems.push('no game history was written for the signed-in host — the bot-exclusion check below proves nothing');
  }
  for (const h of history) {
    if (h.total_players > 1) {
      problems.push(`a bot was counted in the human's game history as a player (total_players=${h.total_players})`);
    }
    if (h.placement !== 1) {
      problems.push(`the only human in the room did not place 1st in their own history (placement=${h.placement})`);
    }
  }

  // ============================================================
  // REMOVING IT
  // ============================================================
  heading('removing the bot');
  await host.page.waitForTimeout(1000);
  const backToLobby = await clickIfReady(host, '#btn-play-again');
  if (backToLobby) {
    await host.page.waitForURL('**/lobby.html*', { timeout: 20000 }).catch(() => {});
    await host.page.waitForTimeout(2500);
    const id = table.store.table('players').find(p => p.is_bot)?.id;
    if (!id) {
      note('no bot in the lobby after Play Again — nothing to remove');
    } else {
      await host.page.locator(`.remove-bot-btn[data-remove-bot-id="${id}"]`).first().click().catch(() => {});
      await host.page.waitForTimeout(2000);
      const gone = !table.store.table('players').some(p => p.is_bot);
      note(`bot removed: ${gone}`);
      if (!gone) problems.push('the host pressed remove on the bot and it stayed');
      const addBack = await host.page.locator('#btn-add-bot').isVisible().catch(() => false);
      note(`add-bot offered again after removal: ${addBack}`);
      if (gone && !addBack) problems.push('after removing the bot the host cannot add another');
    }
  } else {
    note('Play Again was not available — removal checked in the lobby only');
  }

  const real = host.consoleErrors.filter(e =>
    !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e));
  if (real.length) problems.push(`Alice: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ practice bot scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
