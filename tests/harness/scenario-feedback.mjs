// Scenario: question feedback and the timer running out.
//
//   1. Thumbs up is recorded against the question, keyed on the voter.
//   2. Changing your mind updates that vote rather than adding a second one.
//      (Vote inflation was the reason feedback moved to voter_id.)
//   3. Flagging with a reason stores the reason.
//   4. Two different players can both rate the same question.
//   5. Timer expiry — a player who answers nothing still gets scored, at zero,
//      burning their lowest unused wager. This is the rule that makes going
//      away neither rewarded nor punished, and it had no test.
//
// Run: node tests/harness/scenario-feedback.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
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

  const host = await seat('Alice');
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click('[data-setting="questionsPerGame"] [data-value="5"]').catch(() => {});
  // Shortest timer available, so the expiry check does not take a minute.
  await host.page.click('[data-setting="questionTimer"] [data-value="15"]').catch(() => {});
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

  // ============================================================
  // 5 (first, because it must happen on question one). TIMER EXPIRY
  // ============================================================
  heading('timer runs out with nobody answering');
  const beforeAnswers = table.store.table('answers').length;
  note(`answers before the timer expires: ${beforeAnswers}`);

  // Bob types an answer and never presses submit. It must survive the expiry.
  //
  // This is a real bug from a live game: the host fills blanks for everyone who
  // has not answered, and that fill used to MERGE on conflict. Both devices act
  // on the same grace period, so the player's auto-submit and the host's blank
  // race — and from a snapshot taken microseconds earlier the host still saw
  // the player as missing and wrote a blank over their typed answer.
  //
  // Deliberately wrong, so the scoring assertions below still describe a missed
  // question. What is being tested is that the TEXT survives.
  const TYPED = 'bob typed this but never pressed submit';
  const bobInput = bob.page.locator('#answer-input');
  if (await bobInput.isVisible().catch(() => false)) {
    await bobInput.fill(TYPED).catch(() => {});
    note(`Bob typed ${JSON.stringify(TYPED)} and did not submit`);
  } else {
    problems.push('Bob had no answer input to type into');
  }

  // A 15s timer plus grace.
  await host.page.waitForTimeout(20000);

  const bobPlayerId = table.store.table('players').find(p => p.display_name === 'Bob')?.id;
  const bobAnswer = table.store.table('answers')
    .find(a => String(a.player_id) === String(bobPlayerId) && a.question_number === 0);
  note(`Bob's stored answer: ${JSON.stringify(bobAnswer?.submitted_answer)}`);
  if (!bobAnswer) {
    problems.push('the player who typed without submitting got no answer row at all');
  } else if (bobAnswer.submitted_answer !== TYPED) {
    problems.push(`a typed-but-unsubmitted answer was lost — stored ${JSON.stringify(bobAnswer.submitted_answer)} instead of the typed text`);
  }

  // The check above does NOT prove the fix on its own: whether the host's blank
  // lands before or after the player's answer is a matter of timing, and in the
  // harness the player happens to win. Verified by removing the fix — the
  // scenario still passed. So force the losing order explicitly.
  //
  // This is the host acting on a snapshot taken microseconds before the
  // player's answer arrived: it fills a blank for a player who, by then,
  // already has a real answer. It must leave that answer alone.
  if (bobAnswer) {
    const roomId = table.store.table('rooms')[0]?.id;
    const qId = table.store.table('answers').find(a => a.question_number === 0)?.question_id;
    const evalErr = await host.page.evaluate(async ({ roomId, playerId, qId }) => {
      try {
        const m = await import('/js/supabase.js');
        if (typeof m.insertBlankAnswers !== 'function') return 'insertBlankAnswers is not exported';
        await m.insertBlankAnswers([{
          roomId, playerId, questionNumber: 0, questionId: qId, wager: 4
        }]);
        return null;
      } catch (e) { return e.message; }
    }, { roomId, playerId: bobPlayerId, qId }).catch(e => e.message);

    if (evalErr) {
      problems.push(`could not exercise the late blank-fill: ${evalErr}`);
    } else {
      await host.page.waitForTimeout(600);
      const after = table.store.table('answers')
        .find(a => String(a.player_id) === String(bobPlayerId) && a.question_number === 0);
      note(`Bob's answer after a late blank-fill: ${JSON.stringify(after?.submitted_answer)} wager=${after?.wager}`);
      if (after?.submitted_answer !== TYPED) {
        problems.push(`the host's late blank-fill destroyed a real answer — ${JSON.stringify(after?.submitted_answer)} replaced the player's typed text`);
      }
      if (after && after.wager !== bobAnswer.wager) {
        problems.push(`the host's late blank-fill changed the player's wager from ${bobAnswer.wager} to ${after.wager}`);
      }
    }
  }

  const expiredAnswers = table.store.table('answers');
  note(`answers after expiry: ${expiredAnswers.length}`);
  for (const a of expiredAnswers) {
    note(`   player=${a.player_id?.toString().slice(-4)} wager=${a.wager} correct=${a.is_correct} text="${a.submitted_answer}"`);
  }
  if (expiredAnswers.length === 0) {
    problems.push('the timer expired and nothing was recorded — a missed question should still score 0');
  } else {
    const scored = expiredAnswers.filter(a => a.score_earned === 0 || a.score_earned == null);
    if (scored.length !== expiredAnswers.length) {
      problems.push('a missed question awarded points');
    }
    // The rule: a missed question burns the LOWEST unused wager, which on the
    // first question is 1. Anything else means vanishing is cheaper or dearer
    // than being present and wrong.
    const wagers = expiredAnswers.map(a => a.wager);
    note(`wagers burned: ${JSON.stringify(wagers)}`);
    if (wagers.some(w => w !== 1)) {
      problems.push(`a missed first question burned wager ${JSON.stringify(wagers)} instead of the lowest (1)`);
    }
  }

  // ============================================================
  // 1-4. QUESTION FEEDBACK
  // ============================================================
  heading('question feedback');
  for (let i = 0; i < 10; i++) {
    if (await activeScreen(host) === 'reveal-screen') break;
    await host.page.waitForTimeout(800);
  }
  // Feedback only appears once the answer has been revealed — showFeedbackUI()
  // runs inside doReveal(). Rating a question you have not seen the answer to
  // would be meaningless, so the host has to reveal first.
  const revealed = await clickIfReady(host, '#btn-next-question');
  await host.page.waitForTimeout(2500);
  note(`Alice is on ${await activeScreen(host)}, revealed: ${revealed}`);

  const thumbsUp = host.page.locator('.feedback-btn[data-type="thumbs_up"]').first();
  if (!await thumbsUp.isVisible().catch(() => false)) {
    problems.push(`no feedback buttons on ${await activeScreen(host)} — players cannot rate questions`);
  } else {
    // --- 1. thumbs up is recorded ---
    await thumbsUp.click().catch(() => {});
    await host.page.waitForTimeout(2000);
    let fb = table.store.table('question_feedback');
    note(`after thumbs up: ${fb.length} row(s) — ${JSON.stringify(fb.map(f => `${f.feedback_type}/${String(f.voter_id).slice(0, 12)}`))}`);
    if (fb.length !== 1) problems.push(`a thumbs up stored ${fb.length} rows, expected 1`);
    if (fb[0] && fb[0].feedback_type !== 'thumbs_up') problems.push(`thumbs up stored as "${fb[0].feedback_type}"`);
    if (fb[0] && !fb[0].voter_id) problems.push('feedback was stored without a voter_id — votes cannot be deduplicated');

    // --- 2. changing your mind must not add a second vote ---
    await host.page.locator('.feedback-btn[data-type="thumbs_down"]').first().click().catch(() => {});
    await host.page.waitForTimeout(2000);
    fb = table.store.table('question_feedback');
    note(`after switching to thumbs down: ${fb.length} row(s), type=${fb[0]?.feedback_type}`);
    if (fb.length !== 1) {
      problems.push(`changing a vote created ${fb.length} rows — this is the vote inflation voter_id exists to prevent`);
    }
    if (fb[0] && fb[0].feedback_type !== 'thumbs_down') {
      problems.push(`changing a vote left it as "${fb[0].feedback_type}"`);
    }

    // --- 3. flag with a reason ---
    await host.page.locator('.feedback-btn[data-type="flag"]').first().click().catch(() => {});
    await host.page.waitForTimeout(900);
    const reasonBtn = host.page.locator('[data-reason="wrong_answer"]').first();
    if (!await reasonBtn.isVisible().catch(() => false)) {
      problems.push('flagging did not offer a reason to pick');
    } else {
      await reasonBtn.click().catch(() => {});
      await host.page.waitForTimeout(2000);
      fb = table.store.table('question_feedback');
      const flagged = fb.find(f => f.feedback_type === 'flag');
      note(`after flagging: ${fb.length} row(s), reason=${flagged?.flag_reason}`);
      if (!flagged) problems.push('a flag was not stored');
      else if (flagged.flag_reason !== 'wrong_answer') {
        problems.push(`flag stored reason "${flagged.flag_reason}" instead of the one chosen`);
      }
      if (fb.length !== 1) problems.push(`flagging after voting left ${fb.length} rows for one person`);
    }

    // --- 4. a second player rates the same question independently ---
    const bobThumbs = bob.page.locator('.feedback-btn[data-type="thumbs_up"]').first();
    if (await bobThumbs.isVisible().catch(() => false)) {
      await bobThumbs.click().catch(() => {});
      await bob.page.waitForTimeout(2000);
      const fb2 = table.store.table('question_feedback');
      const voters = new Set(fb2.map(f => f.voter_id));
      note(`two players rated: ${fb2.length} row(s) from ${voters.size} voter(s)`);
      if (voters.size !== 2) {
        problems.push(`two players rating the same question produced ${voters.size} distinct voter(s) — they are colliding`);
      }
    } else {
      note("Bob's feedback buttons were not visible; skipped the second-voter check");
    }
  }

  for (const r of [host, bob]) {
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ feedback scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
