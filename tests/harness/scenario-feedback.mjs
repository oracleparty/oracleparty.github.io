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

  // A HOST WITH AN ACCOUNT, so the host-review row has somewhere to attach.
  // A reputation belongs to a user id, and a guest has none — that is what
  // guest play means, and the row hides itself entirely for a guest host. Both
  // robots stay guests as voters, which is the case that matters: gating the
  // vote behind sign-up would leave most games unrated.
  const HOST_USER = '00000000-0000-4000-8000-00000000host';
  {
    const hostRow = table.store.table('players').find(p => p.display_name === 'Alice');
    if (hostRow) hostRow.user_id = HOST_USER;
    table.store.seed('profiles', [{ user_id: HOST_USER, display_name: 'Alice', discriminator: '0001' }]);
  }

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

  // ============================================================
  // 5b. A LATE SUBMIT IS THE SYSTEM WORKING, NOT A FAILURE
  //
  // Once the round is closed the player already holds a row — the blank fill
  // wrote one, or on the final round the __WAGER_LOCKED__ placeholder did. If
  // they press Submit now, op_submit_answer refuses ("time is up") and the
  // client falls back to a direct upsert, which HITS that row.
  //
  // Measured against a real Postgres in the shape migration 049 left `answers`:
  // a non-conflicting ON CONFLICT DO UPDATE is written, a conflicting one is
  // refused with 42501. So the right thing happens — the row already there
  // stands — but the player was shown "Your answer didn't save — check your
  // connection and try again", which is wrong three times over, on top of the
  // correct message the screen was already showing.
  //
  // Found because this fired INTERMITTENTLY in scenario-social, where whether
  // a submit lands before or after expiry is a matter of timing. Driven
  // directly here so it happens every run.
  // ============================================================
  heading('a submit refused after the round closed');
  if (bobAnswer) {
    const roomId = table.store.table('rooms')[0]?.id;
    const qId = table.store.table('answers').find(a => a.question_number === 0)?.question_id;

    const lateSubmit = (afterServerRefusal) => bob.page.evaluate(async (args) => {
      document.querySelectorAll('.toast').forEach(t => t.remove());
      const m = await import('/js/supabase.js');
      const res = await m.submitAnswer({
        roomId: args.roomId, playerId: args.playerId, questionNumber: 0,
        questionId: args.qId, wager: 4, submittedAnswer: 'too late',
        isCorrect: false, scoreEarned: 0,
        afterServerRefusal: args.afterServerRefusal,
      });
      await new Promise(r => setTimeout(r, 400));   // the toast import is async
      return {
        code: res?.error?.code || null,
        toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '),
      };
    }, { roomId, playerId: bobPlayerId, qId, afterServerRefusal });

    const quiet = await lateSubmit(true).catch(e => ({ code: 'threw', toast: e.message }));
    note(`refused-after-rejection: code=${quiet.code}, toast=${JSON.stringify(quiet.toast)}`);
    if (quiet.code !== '42501') {
      problems.push(`a late submit onto an existing row should be refused with 42501, got ${quiet.code} — either the door is open or the row was not there`);
    }
    if (quiet.toast) {
      problems.push(`a late submit told the player ${JSON.stringify(quiet.toast)} — the round is closed and their answer stands, so this is a lie about the connection`);
    }
    const stillTheirs = table.store.table('answers')
      .find(a => String(a.player_id) === String(bobPlayerId) && a.question_number === 0);
    if (stillTheirs?.submitted_answer !== TYPED) {
      problems.push(`a late submit overwrote a stored answer — ${JSON.stringify(stillTheirs?.submitted_answer)} replaced the player's text`);
    }

    // THE NEGATIVE HALF. Without it the check above passes just as happily when
    // nothing ever toasts, which is exactly the "check that cannot fail" this
    // project keeps deleting. The same call WITHOUT the flag must still shout.
    const loud = await lateSubmit(false).catch(e => ({ code: 'threw', toast: e.message }));
    note(`refused-without-the-flag: code=${loud.code}, toast=${JSON.stringify(loud.toast)}`);
    if (!/didn.t save|could not save|connection/i.test(loud.toast || '')) {
      problems.push('a refused write with no refusal context said NOTHING to the player — the quiet path above is therefore measuring nothing');
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
  // 5c. LOCKING A FINAL WAGER MUST NOT NEED TO OVERWRITE ANYTHING
  //
  // lockInFinalWager writes the __WAGER_LOCKED__ placeholder so the rest of the
  // room can see the number. It used an UPSERT — and migration 049 revoked
  // UPDATE on `answers`, so the moment ANY row already existed at the final
  // question (the blank fill runs when the 20s wager clock expires) locking
  // raised 42501: the placeholder never landed, nobody saw the wager, and the
  // player was told their answer had not saved because of their connection.
  //
  // Found as an intermittent console error in scenario-social — about one run
  // in five, depending on whether a player locked before or after the fill.
  // Driven directly here so it is the same every time.
  //
  // DO NOTHING is the correct rule, not a workaround: the server's own
  // op_submit_answer keeps `existing.wager` on the final round, because LOCKED
  // IS LOCKED, and a placeholder must never overwrite a real answer.
  // ============================================================
  heading('locking a final wager onto an existing row');
  {
    const roomRow = table.store.table('rooms')[0];
    const SLOT = 3;                       // a round nothing has written to yet
    table.store.seed('answers', [{
      id: 'preexisting-final', room_id: roomRow.id, player_id: bobPlayerId,
      question_number: SLOT, question_id: null, wager: 2,
      submitted_answer: '', is_correct: false, auto_correct: false, score_earned: 0,
    }]);

    const lock = (fn) => bob.page.evaluate(async (args) => {
      document.querySelectorAll('.toast').forEach(t => t.remove());
      const m = await import('/js/supabase.js');
      const row = {
        roomId: args.roomId, playerId: args.playerId, questionNumber: args.slot,
        questionId: null, wager: 20, submittedAnswer: '__WAGER_LOCKED__',
        isCorrect: false, scoreEarned: 0,
      };
      const res = args.fn === 'insertAnswersIfAbsent'
        ? await m.insertAnswersIfAbsent([row], 'lockInFinalWager')
        : await m.submitAnswer(row);
      await new Promise(r => setTimeout(r, 400));
      return {
        code: res?.error?.code || null,
        toast: [...document.querySelectorAll('.toast')].map(t => t.textContent).join(' | '),
      };
    }, { roomId: roomRow.id, playerId: bobPlayerId, slot: SLOT, fn });

    const now = await lock('insertAnswersIfAbsent').catch(e => ({ code: 'threw', toast: e.message }));
    note(`lock with the current write: code=${now.code}, toast=${JSON.stringify(now.toast)}`);
    if (now.code) problems.push(`locking a final wager onto an existing row failed with ${now.code} — the player's chosen wager never reaches the room`);
    if (now.toast) problems.push(`locking a final wager told the player ${JSON.stringify(now.toast)}`);
    const untouched = table.store.table('answers').find(a => a.id === 'preexisting-final');
    if (untouched?.submitted_answer === '__WAGER_LOCKED__') {
      problems.push('the placeholder overwrote a row that was already there — a locked wager must never replace a real answer or a blank');
    }

    // THE NEGATIVE HALF: the write this replaced. Without it, the check above
    // passes for a build where `answers` is wide open and proves nothing about
    // the door 049 shut.
    const before = await lock('submitAnswer').catch(e => ({ code: 'threw', toast: e.message }));
    note(`lock the old way (upsert): code=${before.code}, toast=${JSON.stringify(before.toast)}`);
    if (before.code !== '42501') {
      problems.push(`an upsert onto an existing answer row was NOT refused (got ${before.code}) — either the door is open in this harness or the row was not there, and the check above is measuring nothing`);
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

  // ============================================================
  // A REFUSED RATING MUST NOT LOOK LIKE A SAVED ONE
  //
  // question_feedback reads empty on the live database and a playtest reported
  // flags never reaching the admin page. An RLS refusal returns NO error — it
  // writes nothing and reports success — so until the row count is checked, a
  // refused rating and a rating nobody gave produce exactly the same silence.
  // ============================================================
  // ============================================================
  // 6. WOULD YOU PLAY WITH THIS HOST AGAIN? (migration 054)
  //
  // The row sits below the answers on the reveal, apart from the question
  // feedback above it — they carry the same three icons and mean different
  // things, and a player tapping the wrong pair would be silently wrong.
  //
  // The checks that matter are about WHO MAY VOTE, because a reputation
  // anybody can move from outside the room is worth nothing.
  // ============================================================
  heading('rating the host');
  {
    const reviewVisible = async (r) => r.page.evaluate(() => {
      const el = document.querySelector('#reveal-host-review');
      return !!el && el.style.display !== 'none' && el.offsetParent !== null;
    }).catch(() => false);

    const bobSees = await reviewVisible(bob);
    const hostSees = await reviewVisible(host);
    note(`host-review row — Bob: ${bobSees}, the host themselves: ${hostSees}`);
    if (!bobSees) {
      problems.push('a player is never offered the chance to rate a signed-in host');
    }
    if (hostSees) {
      problems.push('the host is offered the chance to rate themselves');
    }

    const before = table.store.table('host_ratings').length;
    await bob.page.locator('[data-host-vote="down"]').first().click().catch(() => {});
    await bob.page.waitForTimeout(1200);
    const rows = table.store.table('host_ratings');
    note(`host_ratings after Bob votes: ${JSON.stringify(rows.map(r => ({ r: r.rating, f: r.flag_reason })))}`);
    if (rows.length !== before + 1) {
      problems.push(`Bob's thumbs-down wrote ${rows.length - before} rows, expected 1`);
    } else if (rows[rows.length - 1].rating !== -1) {
      problems.push(`Bob's thumbs-down was stored as ${rows[rows.length - 1].rating}, not -1`);
    }

    // ONE VOTE PER PLAYER PER GAME. Changing your mind must replace the vote,
    // not add another — otherwise a single person in a long game outweighs
    // everybody in a short one, which is the flaw in rating per round.
    await bob.page.locator('[data-host-vote="up"]').first().click().catch(() => {});
    await bob.page.waitForTimeout(1200);
    const afterChange = table.store.table('host_ratings');
    note(`after changing to thumbs-up: ${afterChange.length} row(s), rating ${afterChange[afterChange.length - 1]?.rating}`);
    if (afterChange.length !== before + 1) {
      problems.push(`changing a vote added a row — ${afterChange.length} where there should be ${before + 1}`);
    }
    if (afterChange[afterChange.length - 1]?.rating !== 1) {
      problems.push('changing the vote to thumbs-up did not replace the thumbs-down');
    }

    // A flag is a report of misconduct and must survive a later thumbs-up.
    await bob.page.locator('[data-host-vote="flag"]').first().click().catch(() => {});
    await bob.page.waitForTimeout(600);
    await bob.page.locator('[data-host-reason="unfair_judging"]').first().click().catch(() => {});
    await bob.page.waitForTimeout(1200);
    const flagged = table.store.table('host_ratings')[before];
    note(`flag on the row: ${JSON.stringify(flagged?.flag_reason)}`);
    if (flagged?.flag_reason !== 'unfair_judging') {
      problems.push(`flagging the host recorded ${JSON.stringify(flagged?.flag_reason)}`);
    }
    await bob.page.locator('[data-host-vote="up"]').first().click().catch(() => {});
    await bob.page.waitForTimeout(900);
    if (table.store.table('host_ratings')[before]?.flag_reason !== 'unfair_judging') {
      problems.push('a later thumbs-up withdrew the flag — a report of misconduct must not be retractable by a tap');
    }

    // AND THE GUARD. Driven directly, because the UI gives no way to aim a vote
    // at a game you were not in — which is exactly why the rule has to live in
    // the database rather than in the screen.
    const outsider = await bob.page.evaluate(async () => {
      const m = await import('/js/supabase.js');
      return m.rateHost({
        roomId: '00000000-0000-4000-8000-000000000999',
        playerId: '00000000-0000-4000-8000-000000000998',
        voterId: 'device:outsider',
        rating: -1,
      });
    }).catch(e => ({ ok: false, reason: 'threw: ' + e.message }));
    note(`a vote aimed at a room the voter was never in: ${JSON.stringify(outsider)}`);
    if (outsider.ok) {
      problems.push('somebody who was not in the game was able to rate its host');
    }
  }

  heading('a rating that cannot be saved says so');
  {
    table.store.denyWrites('question_feedback');
    const before = table.store.table('question_feedback').length;
    const thumbs = host.page.locator('.feedback-btn[data-type="thumbs_up"]').first();
    if (!await thumbs.isVisible().catch(() => false)) {
      problems.push('the feedback buttons were gone before the refusal check could run');
    } else {
      await thumbs.click().catch(() => {});
      await host.page.waitForTimeout(2000);
      const after = table.store.table('question_feedback').length;
      const toast = await host.page.evaluate(() =>
        [...document.querySelectorAll('[class*="toast"]')]
          .map(e => e.textContent.trim()).filter(Boolean).join(' | ')).catch(() => '');
      note(`refused write: rows ${before} -> ${after}, player told: ${JSON.stringify(toast)}`);
      if (after !== before) {
        problems.push('denyWrites did not refuse the write, so the check below proves nothing');
      } else if (!/couldn.t save|could not save|permission/i.test(toast)) {
        problems.push('a refused rating was not surfaced to the player — this is the silence that makes an empty question_feedback table impossible to diagnose');
      }
    }
    table.store.allowWrites('question_feedback');
  }

  // ============================================================
  // WHAT PEOPLE TYPED
  //
  // The host records each answer's text when it advances the round, so a
  // missing acceptable answer can be spotted without anyone noticing it by
  // hand. Two things must hold: real answers are counted, and a BOT's answer
  // never is — a bot's answer comes from a percentage somebody chose, so
  // counting it would make this data partly that invented number.
  // ============================================================
  heading('recording what people typed');

  // Recording happens in handleNextQuestion, which is wired to the SCORES
  // screen's action button — not the reveal screen's, which only moves on to
  // the scoreboard.
  //
  // Driven by whatever screen the host is actually on rather than a fixed
  // number of clicks: phases arrive over Realtime and a counted sequence
  // desynchronises, then reports its own impatience as a bug.
  const advance = async (rounds = 1) => {
    for (let i = 0; i < rounds * 6; i++) {
      const screen = await activeScreen(host);
      if (screen === 'reveal-screen') await clickIfReady(host, '#btn-next-question');
      else if (screen === 'scores-screen') await clickIfReady(host, '#btn-scores-action');
      else if (screen === 'question-screen') break;
      await host.page.waitForTimeout(1200);
    }
  };
  await advance();
  await host.page.waitForTimeout(1500);

  // Named explicitly: if these stop being called, question_stats and the
  // answer tally both go quietly empty, which is how question_stats came to
  // hold nothing at all on the live database for months.
  const rpcOps = new Set(table.store.log.filter(o => o.action === 'rpc').map(o => o.table));
  note(`rpc calls seen: ${JSON.stringify([...rpcOps])}`);
  if (!rpcOps.has('record_question_outcome')) {
    problems.push('record_question_outcome was never called — question performance is not being recorded');
  }
  if (!rpcOps.has('record_answer_text')) {
    problems.push('record_answer_text was never called — nothing is recording what players typed');
  }
  const tally = table.store.table('answer_tally');
  note(`answer_tally: ${JSON.stringify(tally.map(t => `${t.answer_shown} x${t.times_given}`))}`);
  if (tally.length === 0) {
    problems.push('nothing was recorded about what players typed');
  }
  if (!tally.some(t => t.answer_shown === TYPED)) {
    problems.push('the typed-but-unsubmitted answer was not counted in what people typed');
  }
  // A blank is somebody running out of time and says nothing about the
  // question; counting it would bury the real answers underneath it.
  if (tally.some(t => !String(t.answer_shown).trim())) {
    problems.push('a blank answer was recorded as if it were an answer');
  }

  // Now the bot rule. There are no bots yet, so a real player is flagged as
  // one on the host's side — which is exactly what the guard reads. This pins
  // it so it cannot be quietly dropped when bots do arrive.
  heading('a bot answer is never counted');
  const BOT_TEXT = 'this came from a bot and must not be counted';
  await host.page.evaluate(name => {
    const st = window.__state;
    const p = (st?.players || []).find(p => p.display_name === name);
    if (p) p.is_bot = true;
  }, 'Bob').catch(() => {});

  const bobInput2 = bob.page.locator('#answer-input');
  if (await bobInput2.isVisible().catch(() => false)) {
    const w = bob.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
    if (await w.isVisible().catch(() => false)) await w.click().catch(() => {});
    await bobInput2.fill(BOT_TEXT).catch(() => {});
    await clickIfReady(bob, '#btn-submit-answer');
  }
  const hostInput2 = host.page.locator('#answer-input');
  if (await hostInput2.isVisible().catch(() => false)) {
    const w = host.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
    if (await w.isVisible().catch(() => false)) await w.click().catch(() => {});
    await hostInput2.fill('a real human answer').catch(() => {});
    await clickIfReady(host, '#btn-submit-answer');
  }
  await host.page.waitForTimeout(2500);

  // FLAG IT IN THE STORE TOO, and this is a fix to the check rather than to the
  // app. Marking Bob a bot only in the host's `window.__state` is lost the
  // moment that client re-fetches players — checkStalePresence does so on every
  // call — so whether this check could see the guard at all depended on how
  // long the run happened to take. Adding a section earlier in the scenario
  // made it fail, which is the giveaway: a flaky check is a real failure with a
  // timing condition attached.
  //
  // Set AFTER both players have submitted, deliberately. A row with is_bot set
  // is one the host's browser will answer FOR (answerQuestionForBots), so
  // flagging it before the round would have the host writing Bob's answer.
  {
    const bobRow = table.store.table('players').find(p => p.display_name === 'Bob');
    if (bobRow) bobRow.is_bot = true;
  }
  await advance();
  await host.page.waitForTimeout(1500);

  const tally2 = table.store.table('answer_tally');
  note(`after the bot round: ${JSON.stringify(tally2.map(t => t.answer_shown))}`);
  if (tally2.some(t => t.answer_shown === BOT_TEXT)) {
    problems.push('a bot answer was recorded in what people typed — this data would be partly an invented number');
  }
  if (!tally2.some(t => t.answer_shown === 'a real human answer')) {
    problems.push('the human answer in that round was not recorded, so the bot guard is excluding too much');
  }

  for (const r of [host, bob]) {
    const real = r.consoleErrors.filter(e =>
      // "Save feedback affected zero rows" is the refusal THIS scenario caused
      // on purpose above, and logging it loudly is the behaviour being tested.
      !/Save feedback affected zero rows/i.test(e) &&
      // The NEGATIVE half of "a submit refused after the round closed" provokes
      // this on purpose, to prove the quiet path is quiet for a reason. Logging
      // it loudly is the behaviour being tested.
      !/Submit answer failed/i.test(e) &&
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
