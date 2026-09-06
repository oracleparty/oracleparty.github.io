// Scenario: the final question, revealed by the HOST, over a slow connection.
//
// Reported from a live game, twice, and never reproduced:
//
//   "Last question was gamebreaking bugged. The player could answer but host
//    couldn't see the question till after the timer? Then it rerolled the
//    difficulty gave the same question and the player's prior answer was
//    locked?"
//
// Four scenarios already have the host press Reveal Question, and all four
// pass, so "nobody tests the host" was the wrong answer. What none of them has
// is a SLOW SERVER — and handleRevealFinalQuestion ends with two awaited
// network writes standing between the host and its own question screen:
//
//     await updateGameState(...)        // the question list and a null clock
//     await setPhaseOnServer(...)       // the phase every OTHER phone acts on
//     _showQuestionScreen();            // ← the host's screen, last
//
// The second write is what tells everybody else to draw the question. If it
// LANDS but its reply is slow coming back, every other phone is answering while
// the host is still awaiting — which is the report, exactly.
//
// This scenario slows op_set_phase and measures the gap.
//
// Run: node tests/harness/scenario-finalq.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const QUESTIONS = 5;
// Longer than the 6s reveal animation and than any think-time in the loop, so a
// pass cannot be the animation finishing early. Shorter than the question timer
// (30s), so "the host got there before the round ended" is a real result rather
// than the round having been abandoned.
const SLOW_MS = 12000;
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
      // MIXED. With one difficulty in the bank fetchQuestionByDifficulty finds
      // nothing, the final question is never swapped, and every check about
      // which question the room asks agrees with itself whatever the code does.
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
  await host.page.waitForTimeout(6500);

  const screenOf = r => r.page
    .evaluate(() => document.querySelector('.screen.active')?.id || '(none)').catch(() => '(nav)');

  // WHEN EACH PHONE COULD ACTUALLY SEE AND ANSWER THE FINAL QUESTION.
  //
  // Not "is the question screen active" — the screen can be up with the card
  // hidden while a clock stamp is awaited, and that is a different state. This
  // records the first moment the question TEXT is on screen and the answer box
  // is there to type into, which is what a player means by "I could answer".
  const sawFinal = {};
  let revealPressedAt = 0;
  // When the ROOM moved. Everybody else acts on this; the presser acts on the
  // reply to the write that caused it, which is the whole asymmetry.
  let roomMovedAt = 0;
  let clockAt = 0;
  const roomWatch = setInterval(() => {
    if (!revealPressedAt) return;
    const room = table.store.table('rooms')[0];
    if (!roomMovedAt && room?.game_phase === 'final_question') roomMovedAt = Date.now();
    if (roomMovedAt && !clockAt && room?.question_started_at) clockAt = Date.now();
  }, 50);
  // Armed by the press, not before — every ordinary round also puts a question
  // on screen, and a watcher running from the start records round 1 and reports
  // it as the final one. The app's own isFinalWagerRound is the discriminator.
  const watchers = [host, bob].map(r => setInterval(async () => {
    if (!revealPressedAt || sawFinal[r.name]) return;
    const ok = await r.page.evaluate(() => {
      if (!window.__state?.isFinalWagerRound) return false;
      if (document.querySelector('.screen.active')?.id !== 'question-screen') return false;
      const text = document.getElementById('question-text')?.textContent || '';
      const visible = el => el && el.style.visibility !== 'hidden' && el.offsetParent !== null;
      return !!(text.trim()
             && visible(document.querySelector('.question-card'))
             && visible(document.querySelector('#answer-form')));
    }).catch(() => false);
    if (ok) sawFinal[r.name] = Date.now();
  }, 100));

  heading('playing to the final wager');
  const done = new Set();
  let revealed = false;
  for (let i = 0; i < 240 && !revealed; i++) {
    for (const r of [host, bob]) {
      const screen = await screenOf(r);
      if (screen === 'question-screen') {
        const shown = await r.page.textContent('#question-text').catch(() => '');
        const n = (shown || '').match(/\d+/)?.[0];
        if (done.has(`${r.name}:${n}`)) continue;
        const input = r.page.locator('#answer-input');
        if (!await input.isVisible().catch(() => false)) continue;
        const w = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
        if (await w.count() > 0) await w.click().catch(() => {});
        await input.fill(n ? `Answer ${n}` : 'x').catch(() => {});
        if (await r.page.isEnabled('#btn-submit-answer').catch(() => false)) {
          await r.page.click('#btn-submit-answer').catch(() => {});
          done.add(`${r.name}:${n}`);
        }
      } else if (screen === 'final-wager-screen') {
        const key = `${r.name}:final`;
        if (!done.has(key)) {
          const opt = r.page.locator('#final-wager-screen [data-wager="20"]').first();
          if (await opt.isVisible().catch(() => false)) await opt.click().catch(() => {});
          if (await clickIfReady(r, '#btn-fw-lock')) done.add(key);
        }
        // THE HOST PRESSES IT — the ordinary case, and the reported one.
        if (r === host && done.has(key) && done.has('Bob:final')) {
          heading('the host reveals the final question, with a slow server');
          // Count the slot-machine chains. Each run of the animation shows the
          // final pill once, so two chains is "it rerolled the difficulty".
          for (const p of [host, bob]) {
            await p.page.evaluate(() => {
              window.__drChains = 0;
              // WHEN THE SLOT MACHINE APPEARED. The press hides its own button
              // and this overlay is the only thing that says anything happened,
              // so the gap between the tap and this is how long the game looks
              // broken to the person who pressed it.
              window.__drShownAt = 0;
              const ov = document.getElementById('difficulty-reveal-overlay');
              if (ov) {
                new MutationObserver(() => {
                  if (!window.__drShownAt && !ov.classList.contains('hidden')) {
                    window.__drShownAt = Date.now();
                  }
                }).observe(ov, { attributes: true, attributeFilter: ['class'] });
              }
              const fin = document.querySelector('.difficulty-reveal__final');
              if (!fin) return;
              let had = fin.classList.contains('difficulty-reveal__final--show');
              new MutationObserver(() => {
                const now = fin.classList.contains('difficulty-reveal__final--show');
                if (!had && now) window.__drChains++;
                had = now;
              }).observe(fin, { attributes: true, attributeFilter: ['class'] });
            }).catch(() => {});
          }
          host.slowConnection(SLOW_MS);
          note(`the HOST's phone now takes ${SLOW_MS}ms a round trip; Bob's is fine`);
          revealPressedAt = Date.now();
          if (await clickIfReady(host, '#btn-fw-reveal')) {
            note('the host pressed Reveal Question');
            revealed = true;
          } else {
            revealPressedAt = 0;
            host.normalConnection();
          }
        }
      } else if (r === host) {
        if (screen === 'reveal-screen') await clickIfReady(r, '#btn-next-question');
        if (screen === 'scores-screen') await clickIfReady(r, '#btn-scores-action');
      }
    }
    await host.page.waitForTimeout(400);
  }

  if (!revealed) {
    problems.push('the host never got to press Reveal Question, so nothing below was measured');
  } else {
    // Long enough for the animation (6s) AND the slow write (12s) AND a full
    // question timer (30s) to have run out, so a host that only ever arrives
    // "after the timer" still arrives before we look.
    await host.page.waitForTimeout(SLOW_MS + 48000);
    host.normalConnection();

    heading('who could see the final question, and when');
    note(`the room moved to the final question ${roomMovedAt ? `${roomMovedAt - revealPressedAt}ms after the press` : 'NEVER'}`);
    note(`the round got a clock ${clockAt ? `${clockAt - roomMovedAt}ms after that` : 'NEVER'}`);
    clearInterval(roomWatch);
    for (const r of [host, bob]) {
      const t = sawFinal[r.name];
      note(`${r.name} could answer the final question ${t ? `${t - revealPressedAt}ms after the press` : 'NEVER'}`);
    }

    if (!sawFinal.Bob) {
      problems.push('Bob never saw the final question at all — the round never reached anybody');
    } else if (!sawFinal.Alice) {
      problems.push('the HOST never saw the final question they revealed, while Bob was answering it — "the player could answer but host couldn\'t see the question"');
    } else {
      const gap = sawFinal.Alice - sawFinal.Bob;
      note(`the host was ${gap}ms behind the player`);
      // THE PRESSER MUST NOT BE LAST. Their phone already knows the question,
      // the round and the wager — every fact the screen needs — so anything
      // that puts them behind the room is a network call they are queued
      // behind. On a good connection both land in the same beat, so the
      // tolerance is for ordinary Realtime jitter and nothing more; a slow link
      // must not turn into a slow SCREEN.
      if (gap > 3000) {
        problems.push(`the host could not see the final question until ${gap}ms after the player could — their own screen was queued behind a network write`);
      }
    }

    heading('what everybody was asked');
    const asked = {};
    for (const r of [host, bob]) {
      asked[r.name] = (await r.page.textContent('#question-text').catch(() => null)) || '(none)';
    }
    const roomTail = table.store.table('rooms')[0]?.question_ids?.slice(-1)[0];
    const roomQ = table.store.table('questions').find(q => q.id === roomTail)?.question || '(unknown)';
    note(`room asks: ${JSON.stringify(roomQ)}`);
    for (const r of [host, bob]) {
      note(`${r.name} is asked: ${JSON.stringify(asked[r.name])}`);
      if (asked[r.name] !== roomQ) {
        problems.push(`${r.name} is being asked ${JSON.stringify(asked[r.name])} while the room asks ${JSON.stringify(roomQ)}`);
      }
    }

    heading('how many times the difficulty was rolled');
    for (const r of [host, bob]) {
      const chains = await r.page.evaluate(() => window.__drChains).catch(() => -1);
      note(`${r.name} ran the difficulty reveal ${chains}x`);
      if (chains > 1) {
        problems.push(`${r.name} ran the difficulty reveal ${chains}x — "it rerolled the difficulty"`);
      }
    }

    // The clock every phone but the host reads. A null stamp makes
    // getServerTimeLeft return the FULL duration, so the bar never moves.
    const room = table.store.table('rooms')[0];
    note(`room clock on the final question: ${room?.question_started_at || 'NULL'}`);
    if (!room?.question_started_at) {
      problems.push('the final round has no clock in the room — every phone but the host shows a bar that never moves');
    }
    heading('how long the press looked like nothing');
    const shownAt = await host.page.evaluate(() => window.__drShownAt).catch(() => 0);
    note(`the slot machine appeared on the host's phone ${shownAt ? `${shownAt - revealPressedAt}ms after the press` : 'NEVER'}`);
    // THE PRESS MUST DO SOMETHING AT ONCE. The button hides itself, so until
    // this overlay appears the screen says nothing happened — and the swap
    // fetch used to sit in front of it, un-timed. A whole round trip of a blank
    // screen on the button that picks the last question of the game is the
    // "couldn't see the question till after the timer" report starting.
    if (!shownAt) {
      problems.push('the difficulty reveal never appeared on the host\'s phone at all');
    } else if (shownAt - revealPressedAt > 3000) {
      problems.push(`the host pressed Reveal Question and nothing happened on screen for ${shownAt - revealPressedAt}ms — the slot machine was queued behind a read of the question bank`);
    }

    // AND THE ROUND MUST NOT HAVE TAKEN FOREVER TO BEGIN. The press has to do
    // something: the animation is the feedback, and it used to sit behind an
    // un-timed read of the question bank, so a slow phone showed nothing at all
    // between the tap and the question. Two round trips (the list, then the
    // phase) are unavoidable without a migration; a third, before any pixel
    // moves, is not.
    if (roomMovedAt && roomMovedAt - revealPressedAt > SLOW_MS * 2 + 12000) {
      problems.push(`the room took ${roomMovedAt - revealPressedAt}ms to reach the final question after the press — long enough that the timer runs out before the question arrives`);
    }
  }

  for (const w of watchers) clearInterval(w);

  console.log('');
  if (problems.length) {
    console.log('✗ PROBLEMS:');
    for (const p of problems) console.log('  -', p);
    process.exitCode = 1;
  } else {
    console.log('✓ final-question scenario passed');
  }
} finally {
  await table.close();
}
