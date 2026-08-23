// Scenario: the two ways a host's own corrections used to wreck accuracy.
//
// player_stats_computed derives accuracy as SUM(times_correct) / SUM(times_seen)
// out of question_history, and question_history holds COUNTERS. Three call
// sites treated it as if it held a verdict, and each extra call permanently
// added an attempt the player never made:
//
//   1. HOST OVERRIDE. doReveal records the attempt. If the host then flips the
//      judgement, all three override paths called upsertQuestionHistory again
//      — times_seen 2, times_correct 1. A player who got the question right,
//      and whom the host agreed got it right, ended on 50% for it. Correcting
//      the mark made the record worse than leaving it wrong.
//
//   2. DISQUALIFY. The one action whose entire meaning is "this round does not
//      count" called upsertQuestionHistory(..., false) — a third attempt,
//      scored as a miss, on top of the one doReveal already recorded. It was
//      the single most damaging thing a host could do to everyone's accuracy.
//      It also left question_stats holding an asked-and-nobody-got-it row for
//      a question that had just been thrown out, and counted every
//      auto-correct player as times_overridden, which is the column this
//      project trusts most for spotting a bad answer key.
//
// Both are invisible from the app: nothing errors, nothing renders wrong, and
// the damage only shows up as a slightly-too-low number on a profile page
// weeks later. So this measures the rows directly.
//
// Run: node tests/harness/scenario-accuracy.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

function seedQuestions(store, n = 20) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`,
      question: `Test question ${i}?`,
      correct_answer: `Answer ${i}`,
      acceptable_answers: [],
      incorrect_answers: [],
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

const historyFor = (store, userId, questionId) =>
  store.table('question_history').find(h =>
    String(h.user_id) === String(userId) && String(h.question_id) === String(questionId));

const describeRow = row => row
  ? `seen=${row.times_seen} correct=${row.times_correct} last=${row.last_correct}`
  : '(no row)';

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);

  // Signed in, both of them: question_history only exists for accounts, so a
  // guest game can never exercise any of this. This is the "robots sign in as
  // nobody" trap from CLAUDE.md in its other form — here the feature is
  // invisible to guests rather than the bug being.
  const host = await table.seatSignedIn('Alice');
  const bob = await table.seatSignedIn('Bob');

  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click('[data-setting="questionsPerGame"] [data-value="5"]').catch(() => {});
  // A long timer — nothing here is about expiry, and a blank-filled round
  // would muddy which write came from where.
  await host.page.click('[data-setting="questionTimer"] [data-value="60"]').catch(() => {});
  await host.page.waitForTimeout(300);
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);
  const code = await host.textOf('#lobby-code');

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

  // ------------------------------------------------------------
  // One round, answered by both. Alice right, Bob wrong.
  // ------------------------------------------------------------
  heading('one honest attempt each');

  const qId = table.store.table('rooms')[0]?.question_ids?.[0]
    || table.store.table('questions')[0].id;
  const correct = table.store.table('questions').find(q => q.id === qId)?.correct_answer;

  for (const [r, text] of [[host, correct], [bob, 'nonsense']]) {
    const input = r.page.locator('#answer-input');
    try {
      await input.waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      problems.push(`${r.name} had no answer input (on ${await activeScreen(r)})`);
      continue;
    }
    // A wager has to be assigned before Submit becomes usable — the button
    // silently stays disabled otherwise, which reads exactly like the answer
    // being rejected.
    const wager = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
    if (await wager.count() > 0 && await wager.isVisible().catch(() => false)) {
      await wager.click().catch(() => {});
    }
    await input.fill(text).catch(() => {});
    if (!await r.page.isEnabled('#btn-submit-answer').catch(() => false)) {
      problems.push(`${r.name}'s Submit stayed disabled after picking a wager and typing`);
      continue;
    }
    await r.page.click('#btn-submit-answer').catch(() => {});
    await r.page.waitForTimeout(400);
  }
  await host.page.waitForTimeout(1500);
  note(`answers stored: ${table.store.table('answers').length}`);

  // ------------------------------------------------------------
  // A RE-RENDER MUST NOT ERASE AN ANSWER ALREADY SENT
  //
  // From a playtest: "someone put an answer in and then it disappeared to no
  // answer -- seemed to recur for him and disappear on reveal".
  //
  // Realtime re-calls showQuestionScreen for the SAME question, and it used to
  // empty the answer box and reset hasSubmitted every time. The reveal then
  // auto-submits "whatever is currently typed" for anyone it believes has not
  // answered — through an UPSERT, which cheerfully replaced a real answer with
  // an empty string. The player watched their own words become "No answer".
  //
  // Forced explicitly rather than hoped for: whether a duplicate render happens
  // is a matter of Realtime timing, and a test that waits for one is measuring
  // the harness's luck. This calls the function the way Realtime would.
  // ------------------------------------------------------------
  heading('a re-render of the same question keeps the answer');

  const bobPlayerId = table.store.table('players').find(p => p.display_name === 'Bob')?.id;
  const storedBefore = table.store.table('answers')
    .find(a => String(a.player_id) === String(bobPlayerId) && a.question_number === 0);
  note(`Bob's stored answer before the re-render: ${JSON.stringify(storedBefore?.submitted_answer)}`);

  const rerenderErr = await bob.page.evaluate(async () => {
    try {
      const m = await import('/js/game/question.js');
      if (typeof m.showQuestionScreen !== 'function') return 'showQuestionScreen is not exported';
      const before = window.__state.hasSubmitted;
      m.showQuestionScreen();
      return before === true && window.__state.hasSubmitted !== true
        ? 'RESET'
        : null;
    } catch (e) { return e.message; }
  }).catch(e => e.message);

  if (rerenderErr === 'RESET') {
    problems.push('re-rendering the same question reset hasSubmitted, so the reveal will auto-submit a blank over an answer the player already sent');
  } else if (rerenderErr) {
    problems.push(`could not exercise the re-render: ${rerenderErr}`);
  } else {
    await bob.page.waitForTimeout(600);
    const typed = await bob.page.inputValue('#answer-input').catch(() => '(no input)');
    note(`Bob's answer box after the re-render: ${JSON.stringify(typed)}`);
  }

  // Host reveals. #btn-next-question is dual-purpose on the reveal screen:
  // the first press runs doReveal (judges, records history, shows the host
  // toggles and the disqualify button); a later press moves to the scoreboard.
  for (let i = 0; i < 12; i++) {
    if (await activeScreen(host) === 'reveal-screen') break;
    await host.page.waitForTimeout(800);
  }
  note(`host is on ${await activeScreen(host)} before revealing`);
  await clickIfReady(host, '#btn-next-question');
  await host.page.waitForTimeout(2500);

  // The answer itself must have survived the re-render AND the reveal's
  // auto-submit pass. This is the assertion the playtest report describes.
  const storedAfter = table.store.table('answers')
    .find(a => String(a.player_id) === String(bobPlayerId) && a.question_number === 0);
  note(`Bob's stored answer after the reveal: ${JSON.stringify(storedAfter?.submitted_answer)}`);
  if (storedBefore && storedAfter?.submitted_answer !== storedBefore.submitted_answer) {
    problems.push(`a real answer was replaced during the reveal — ${JSON.stringify(storedBefore.submitted_answer)} became ${JSON.stringify(storedAfter?.submitted_answer)}`);
  }

  let aliceRow = historyFor(table.store, host.userId, qId);
  let bobRow = historyFor(table.store, bob.userId, qId);
  note(`Alice after the reveal: ${describeRow(aliceRow)}`);
  note(`Bob after the reveal:   ${describeRow(bobRow)}`);

  if (!aliceRow || !bobRow) {
    problems.push('the reveal recorded no question_history at all — mastery and accuracy are both dead');
  } else {
    if (aliceRow.times_seen !== 1 || bobRow.times_seen !== 1) {
      problems.push(`one answered question counted as ${aliceRow.times_seen}/${bobRow.times_seen} attempts instead of 1 each`);
    }
    if (aliceRow.times_correct !== 1) problems.push('a correct answer was not counted correct');
    if (bobRow.times_correct !== 0) problems.push('a wrong answer was counted correct');
  }

  // ------------------------------------------------------------
  // 1a. THE ROUND IS RECORDED ONCE, NOT ONCE PER PHONE.
  //
  // Both facts here are the reason migration 043 exists.
  //
  // BOB IS RECORDED FROM SOMEBODY ELSE'S CALL. Every device fires
  // record_round_history, and the first one to arrive records the whole room —
  // so a player whose phone was asleep at the reveal is recorded anyway.
  // Before this, each browser wrote only its own row, and a sleeping phone
  // recorded nothing while a waking one recorded a miss: the same event
  // produced two different permanent records depending on the hardware.
  //
  // AND IT COUNTS ONCE. question_history holds COUNTERS, so a second call is a
  // second attempt — the exact damage migration 041's amend function exists to
  // undo. This fires from a phase transition, which Realtime does not promise
  // to deliver exactly once, so idempotency is not a nicety.
  // ------------------------------------------------------------
  heading('recording the round twice must not count it twice');
  const recordedTwice = await host.page.evaluate(async ([roomId, questionId]) => {
    const mod = await import('./js/supabase.js');
    const a = await mod.recordRoundHistory(roomId, questionId);
    const b = await mod.recordRoundHistory(roomId, questionId);
    return [a, b];
  }, [table.store.table('rooms')[0]?.id, qId]).catch(err => ({ threw: err.message }));
  note(`two extra calls returned: ${JSON.stringify(recordedTwice)}`);

  const aliceAfterRepeat = historyFor(table.store, host.userId, qId);
  const bobAfterRepeat = historyFor(table.store, bob.userId, qId);
  note(`Alice after two more calls: ${describeRow(aliceAfterRepeat)}`);
  note(`Bob after two more calls:   ${describeRow(bobAfterRepeat)}`);
  if (aliceAfterRepeat?.times_seen !== 1 || bobAfterRepeat?.times_seen !== 1) {
    problems.push(`re-recording the same round counted it again — Alice ${aliceAfterRepeat?.times_seen}, Bob ${bobAfterRepeat?.times_seen}, both should still be 1. Every extra call is an attempt the player never made.`);
  }

  // Every answer row for the round must carry the marker, including any
  // belonging to guests. An unmarked row is one the next call rescans.
  const unmarked = table.store.table('answers')
    .filter(a => String(a.question_id) === String(qId) && !a.history_recorded).length;
  note(`answer rows for this round still unmarked: ${unmarked}`);
  if (unmarked > 0) {
    problems.push(`${unmarked} answer row(s) were left unmarked after recording, so the next call would count the round again`);
  }

  // ONE call records the WHOLE ROOM. This is the property that makes a
  // sleeping phone survivable: whoever gets there first writes everybody's
  // row, so nobody's record depends on their own device being awake. Both
  // browsers here are alive, so the markers are cleared to put the round back
  // in the state it was in before anyone recorded it, and then it is called
  // exactly once, from one device.
  for (const a of table.store.table('answers')) {
    if (String(a.question_id) === String(qId)) a.history_recorded = false;
  }
  for (const uid of [host.userId, bob.userId]) {
    const r = historyFor(table.store, uid, qId);
    if (r) { r.times_seen = 0; r.times_correct = 0; }
  }
  const oneCall = await host.page.evaluate(async ([roomId, questionId]) => {
    const mod = await import('./js/supabase.js');
    return mod.recordRoundHistory(roomId, questionId);
  }, [table.store.table('rooms')[0]?.id, qId]).catch(err => ({ threw: err.message }));
  note(`a single call from one device recorded: ${JSON.stringify(oneCall)}`);
  if (oneCall?.recorded !== 2) {
    problems.push(`one call recorded ${oneCall?.recorded} player(s), expected 2 — the round is still being recorded per-device, so a phone asleep at the reveal records nothing`);
  }

  // ------------------------------------------------------------
  // 1. HOST OVERRIDE — a correction, not a second attempt.
  // ------------------------------------------------------------
  heading('the host changes their mind about Bob');

  const seenBefore = bobRow?.times_seen ?? null;
  const flipped = await host.page.evaluate(async () => {
    const toggles = [...document.querySelectorAll('#reveal-screen .answer-toggle--host')];
    // The row belonging to the player who got it wrong.
    const target = toggles.find(t => t.classList.contains('answer-toggle--incorrect')) || toggles[0];
    if (!target) return false;
    target.click();
    return true;
  }).catch(() => false);

  if (!flipped) {
    problems.push('no host judgement toggle was available on the reveal screen');
  } else {
    await host.page.waitForTimeout(1500);
    bobRow = historyFor(table.store, bob.userId, qId);
    note(`Bob after the host flipped him to correct: ${describeRow(bobRow)}`);

    if (!bobRow) {
      problems.push('the override erased Bob\'s question_history row');
    } else {
      if (bobRow.times_seen !== seenBefore) {
        problems.push(`a host override counted as an extra attempt — times_seen went ${seenBefore} -> ${bobRow.times_seen}. Bob answered the question once.`);
      }
      if (bobRow.times_correct !== 1) {
        problems.push(`the host marked Bob correct and his record still says times_correct=${bobRow.times_correct}`);
      }
      if (bobRow.last_correct !== true) {
        problems.push('the override did not update last_correct, so mastery still shows the old verdict');
      }
    }
  }

  // ------------------------------------------------------------
  // 2. DISQUALIFY — the round comes back out of the record.
  // ------------------------------------------------------------
  heading('the host disqualifies the round');

  const dqVisible = await host.page.locator('#btn-disqualify-round')
    .isVisible().catch(() => false);
  if (!dqVisible) {
    problems.push('the disqualify button was not offered to the host on the reveal screen');
  } else {
    await host.page.click('#btn-disqualify-round');
    await host.page.waitForTimeout(2000);

    aliceRow = historyFor(table.store, host.userId, qId);
    bobRow = historyFor(table.store, bob.userId, qId);
    note(`Alice after the disqualification: ${describeRow(aliceRow)}`);
    note(`Bob after the disqualification:   ${describeRow(bobRow)}`);

    // This was their only sighting of the question, so the honest record of a
    // round that did not count is no row at all.
    for (const [name, row] of [['Alice', aliceRow], ['Bob', bobRow]]) {
      if (!row) continue;
      if (row.times_seen > 0) {
        problems.push(`${name} was still charged ${row.times_seen} attempt(s) for a disqualified round — a round the host threw out is dragging their accuracy down`);
      }
    }
  }

  // ------------------------------------------------------------
  // THE CORRECTIONS MUST GO THROUGH THE DATABASE FUNCTION
  //
  // question_history is scoped to its owner — migration 011 grants UPDATE only
  // where user_id = auth.uid(), and grants no DELETE to anybody. So a host
  // correcting somebody ELSE'S answer with a direct write is silently refused:
  // zero rows, no error. It lands on the host's own row and nowhere else, and
  // the disqualify path cannot delete a row even for the caller.
  //
  // The fake store has no RLS, so it cannot reproduce the refusal — which is
  // exactly why this bug survived a passing scenario. What it CAN establish is
  // that the app calls amend_question_history / revoke_question_history rather
  // than touching the table, and that is the thing a future edit would undo.
  // ------------------------------------------------------------
  heading('corrections go through the database, not the table');
  {
    const rpcNames = table.store.log
      .filter(o => o.action === 'rpc')
      .map(o => o.table);
    note(`rpc calls seen: ${JSON.stringify([...new Set(rpcNames)])}`);

    if (!rpcNames.includes('amend_question_history')) {
      problems.push('a host override did not call amend_question_history — a direct write here is refused for every player but the host, silently');
    }
    if (!rpcNames.includes('revoke_question_history')) {
      problems.push('a disqualification did not call revoke_question_history — a direct write here is refused for every player but the host, and cannot delete a row at all');
    }

    // Every RPC must carry the room, because that is the only thing the
    // function can check: it refuses to touch a history row unless that player
    // really answered that question in that room. Without it the guard has
    // nothing to verify and the correction does nothing.
    const missingRoom = table.store.log.filter(o =>
      o.action === 'rpc' &&
      (o.table === 'amend_question_history' || o.table === 'revoke_question_history') &&
      !o.payload?.p_room_id);
    if (missingRoom.length) {
      problems.push(`${missingRoom.length} correction call(s) carried no room id — the database guard cannot verify the round happened and refuses them all`);
    }
  }

  // ------------------------------------------------------------
  // 3. A disqualified round is not evidence about the question either.
  // ------------------------------------------------------------
  heading('question health after a disqualified round');

  // Recording happens on ADVANCE — handleNextQuestion is wired to the SCORES
  // screen's button, not the reveal screen's, which only moves the room to the
  // scoreboard. Drive from whatever screen the host is actually on.
  for (let i = 0; i < 16; i++) {
    const screen = await activeScreen(host);
    if (screen === 'question-screen') break;
    if (screen === 'reveal-screen') await clickIfReady(host, '#btn-next-question');
    else if (screen === 'scores-screen') await clickIfReady(host, '#btn-scores-action');
    await host.page.waitForTimeout(900);
  }
  note(`host advanced to ${await activeScreen(host)}`);
  await host.page.waitForTimeout(1500);

  const stats = table.store.table('question_stats').find(s => String(s.question_id) === String(qId));
  const tally = table.store.table('answer_tally').filter(t => String(t.question_id) === String(qId));
  note(`question_stats for the disqualified question: ${stats ? JSON.stringify(stats) : '(none)'}`);
  note(`answer_tally rows for it: ${tally.length}`);

  if (stats) {
    problems.push(`a disqualified question was recorded in question_stats as asked=${stats.times_asked} correct=${stats.times_correct} overridden=${stats.times_overridden} — disqualify marks every answer wrong first, so this makes a thrown-out question look impossibly hard and inflates times_overridden`);
  }
  if (tally.length > 0) {
    problems.push('a disqualified round\'s typed answers were counted in answer_tally, which is the evidence used to fix answer keys');
  }

} catch (err) {
  problems.push(`scenario threw: ${err.message}`);
} finally {
  await table.close();
}

console.log('');
if (problems.length) {
  console.log('✗ accuracy scenario found problems:');
  for (const p of problems) console.log('   -', p);
  process.exit(1);
}
console.log('✓ accuracy scenario passed');
