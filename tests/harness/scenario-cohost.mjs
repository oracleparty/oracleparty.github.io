// Scenario: co-host — the feature that had never run.
//
// promoteToCohost() writes players.is_cohost, and that column did not exist on
// the live database until migration 027. Every promotion failed and was only
// logged, so this code path has never executed against a working schema. It
// deserves the most suspicion of anything in the app.
//
//   1. The host can promote another player to co-host, and it sticks.
//   2. The co-host badge is visible to everyone, not just the host.
//   3. A co-host can advance the game — that is the whole point of the role.
//   4. A co-host does NOT get host-only powers they should not have.
//   5. Demoting works, and the co-host loses the ability to advance.
//
// Run: node tests/harness/scenario-cohost.mjs
import { PlaytestTable, pressPlayerCardAction } from './harness.js';

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
      // MIXED, NOT ALL 'medium'. The final question is SWAPPED for one matching
      // the difficulty vote, and with a bank of a single difficulty
      // fetchQuestionByDifficulty finds nothing, the swap silently never
      // happens, and question_ids never changes — so the final-question check
      // below would agree with itself whatever the code did. CLAUDE.md records
      // this exact trap costing scenario-fullgame its own coverage.
      difficulty: ['easy', 'medium', 'hard'][i % 3],
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
  await host.page.waitForTimeout(300);
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);
  const code = await host.textOf('#lobby-code');

  const bob = await seat('Bob');       // will become co-host
  const carol = await seat('Carol');   // stays an ordinary player
  for (const r of [bob, carol]) {
    await r.goto('join.html');
    await r.page.waitForSelector('#code-input', { timeout: 15000 });
    await r.page.fill('#code-input', code);
    await r.page.click('#btn-join');
    await r.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  }
  await host.page.waitForTimeout(2000);

  // ============================================================
  // 1. PROMOTE TO CO-HOST
  // ============================================================
  heading('promoting a co-host');
  const bobId = table.store.table('players').find(p => p.display_name === 'Bob')?.id;
  // THE CONTROL LIVES IN THE PLAYER'S CARD NOW, not on the row.
  const promoted = await pressPlayerCardAction(host.page, bobId, /make co-host/i);
  note(`Bob's card offers: ${JSON.stringify(promoted.labels)}`);
  if (!promoted.pressed) {
    problems.push(`the host is not offered "Make co-host" on another player's card (offers: ${JSON.stringify(promoted.labels)})`);
  } else {

    const bobRow = table.store.table('players').find(p => p.display_name === 'Bob');
    note(`Bob is_cohost in the database: ${bobRow?.is_cohost}`);
    if (!bobRow?.is_cohost) {
      problems.push('promoting to co-host did not persist — the write was discarded');
    }

    // ============================================================
    // 2. EVERYONE SEES THE BADGE
    // ============================================================
    heading('co-host badge visibility');
    for (const r of [host, bob, carol]) {
      const sees = await r.page.evaluate(() =>
        !!document.querySelector('.badge--cohost')).catch(() => false);
      note(`${r.name} sees a co-host badge: ${sees}`);
      if (!sees) problems.push(`${r.name} cannot see that anyone is co-host`);
    }

    // Bob's own client must know it is co-host, or it will not show controls.
    const bobKnows = await bob.page.evaluate(() => {
      const stored = sessionStorage.getItem('oracle_party_room');
      return stored ? !!JSON.parse(stored).isCohost : null;
    }).catch(() => null);
    note(`Bob's own session records isCohost: ${bobKnows}`);
    if (!bobKnows) problems.push('the promoted player\'s own client does not know it is co-host');

    // ============================================================
    // A PROMOTION THAT DID NOT LAND MUST NOT BE ANNOUNCED
    //
    // promoteToCohost and its three siblings used to return NOTHING, so the
    // lobby marked the player co-host in its own list and posted "X is now
    // co-host" to the chat whether or not the write landed. op_set_host_role
    // DECLINES when the room's state does not allow it — that is the guard
    // working — and a decline was indistinguishable from a success. The host
    // saw a badge nobody else had, the room was told it happened, and the
    // co-host got none of the powers. CLAUDE.md records co-host "silently doing
    // nothing, for months"; this is a fresh route to the same place.
    //
    // failFunction is what makes this reachable: the store could only model
    // "not installed", which takes the fallback rather than the decline.
    // ============================================================
    heading('a co-host promotion that fails');
    const carolId = table.store.table('players').find(p => p.display_name === 'Carol')?.id;

    // ============================================================
    // ONE CO-HOST, AND THE SCREEN SAYS SO
    //
    // handleCohostToggle has always demoted the existing co-host before
    // promoting, so the room could never hold two — SILENTLY. Tapping a second
    // star stripped the first person with nothing said but a chat line the host
    // may never read. The offer is hidden while a co-host exists now.
    //
    // BOTH HALVES, or this cannot fail: the offer is gone from Carol, AND the
    // current co-host keeps their own button. Hiding both would make the role
    // permanent for the life of the room, and a check for only the first would
    // pass on that.
    // ============================================================
    const carolCard = await pressPlayerCardAction(host.page, carolId, /__never__/);
    const bobCard = await pressPlayerCardAction(host.page, bobId, /__never__/);
    note(`with Bob co-host — Carol's card: ${JSON.stringify(carolCard.labels)}, Bob's card: ${JSON.stringify(bobCard.labels)}`);
    if (carolCard.labels.some(l => /make co-host/i.test(l))) {
      problems.push('the room already has a co-host and the host is still offered "Make co-host" on somebody else — pressing it strips the first person with no warning');
    }
    if (!bobCard.labels.some(l => /remove as co-host/i.test(l))) {
      problems.push(`the current co-host cannot be removed either — the role is now permanent for the life of the room (offers: ${JSON.stringify(bobCard.labels)})`);
    }

    // THE REFUSED-PROMOTION CHECK STILL HAS TO RUN, and hiding the offer is
    // exactly how it would have been lost: "a control that only moved out of
    // somewhere is a control that was deleted". So take the role off Bob, make
    // the refused attempt on Carol, and give it back — section 5 below demotes
    // Bob for real and needs him holding it.
    await pressPlayerCardAction(host.page, bobId, /remove as co-host/i);

    {
      const chatBefore = table.store.table('chat_messages').length;
      table.store.failFunction('op_set_host_role');
      const refused = await pressPlayerCardAction(host.page, carolId, /make co-host/i);
      table.store.unfailFunction('op_set_host_role');
      if (!refused.pressed) {
        problems.push(`with no co-host in the room the offer did not come back (offers: ${JSON.stringify(refused.labels)})`);
      }

      const carolRow = table.store.table('players').find(p => p.id === carolId);
      const shownAsCohost = await host.page.evaluate(id =>
        !!document.querySelector(`[data-player-id="${id}"] .badge--cohost`), carolId).catch(() => null);
      const announced = table.store.table('chat_messages')
        .slice(chatBefore).map(m => m.message || '').join(' | ');
      const toasted = await host.page.evaluate(() =>
        [...document.querySelectorAll('.toast, #toast')].map(t => t.textContent.trim()).join(' | ')
      ).catch(() => '');
      note(`refused promotion: stored is_cohost=${carolRow?.is_cohost}, badge shown=${shownAsCohost}, chat ${JSON.stringify(announced)}, toast ${JSON.stringify(toasted)}`);

      if (carolRow?.is_cohost) {
        problems.push('a refused co-host promotion still changed the stored row');
      }
      if (shownAsCohost) {
        problems.push('the promotion was refused and the lobby still shows a co-host badge — the host sees a role nobody else has');
      }
      if (/is now co-host/i.test(announced)) {
        problems.push('the promotion was refused and the room was told it happened');
      }
      // EITHER MESSAGE IS CORRECT. Only one co-host is allowed at a time, so
      // this path clears the existing one FIRST — and when that step is the one
      // refused, stopping there is right: promoting on top of a demotion that
      // did not land would leave the room with two. What matters is that the
      // host is told something rather than watching a tap do nothing.
      if (!/couldn.t (make them co-host|change co-host)/i.test(toasted)) {
        problems.push(`a refused co-host promotion said nothing to the host (toasts: ${JSON.stringify(toasted)})`);
      }
    }

    // Put Bob back, so section 5 tests a real demotion rather than an absence.
    await pressPlayerCardAction(host.page, bobId, /make co-host/i);
    const bobBack = table.store.table('players').find(p => p.id === bobId);
    note(`Bob restored as co-host: ${bobBack?.is_cohost}`);
    if (!bobBack?.is_cohost) {
      problems.push('could not re-promote Bob after the refused-promotion check — the sections below are testing nothing');
    }
  }

  // ============================================================
  // 5 (in the lobby, where the button lives). DEMOTE, THEN RE-PROMOTE
  // ============================================================
  heading('demotion');
  const demoted = await pressPlayerCardAction(host.page, bobId, /remove as co-host/i);
  note(`co-host card offers: ${JSON.stringify(demoted.labels)}`);
  if (!demoted.pressed) {
    problems.push(`no "Remove as co-host" control appears on the card of a player who is already co-host (offers: ${JSON.stringify(demoted.labels)})`);
  } else {
    const sysMsgs = table.store.table('chat_messages').map(m => m.message).filter(Boolean);
    note(`system messages: ${JSON.stringify(sysMsgs.slice(-3))}`);
    const updates = table.store.log.filter(o => o.table === 'players' && o.action === 'update');
    note(`player update ops: ${JSON.stringify(updates.map(u => JSON.stringify(u.payload)).slice(-4))}`);
    const afterDemote = table.store.table('players').find(p => p.display_name === 'Bob');
    note(`Bob is_cohost after demote: ${afterDemote?.is_cohost}`);
    if (afterDemote?.is_cohost) problems.push('Demote did not remove the co-host flag');

    const bobStillThinks = await bob.page.evaluate(() => {
      const stored = sessionStorage.getItem('oracle_party_room');
      return stored ? !!JSON.parse(stored).isCohost : null;
    }).catch(() => null);
    note(`Bob's own session still records isCohost: ${bobStillThinks}`);
    if (bobStillThinks) {
      problems.push('a demoted co-host still believes it is co-host — it would keep host controls');
    }

    // Put the role back so the in-game checks below have a co-host to test.
    await pressPlayerCardAction(host.page, bobId, /make co-host/i);
    const rePromoted = table.store.table('players').find(p => p.display_name === 'Bob')?.is_cohost;
    note(`Bob re-promoted: ${rePromoted}`);
    if (!rePromoted) problems.push('could not re-promote a demoted player to co-host');
  }

  // ============================================================
  // EJECT AND KICK (migration 065)
  // ============================================================
  //
  // The database refused BOTH of these until 065: op_remove_player allows
  // exactly four removals and "the host removes a live human" was not one of
  // them, by design. So this is the first check in the repo that a host can
  // remove anybody at all.
  //
  // BOTH HALVES, as everywhere else here. That the removal happens, and that
  // the DIFFERENCE between the two survives — an ejected player walks back in,
  // a kicked one does not. A check for only the first passes on a build where
  // kick is just a slower eject.
  heading('ejecting and kicking');
  {
    const carolId = table.store.table('players').find(p => p.display_name === 'Carol')?.id;
    const carolUser = table.store.table('players').find(p => p.display_name === 'Carol')?.user_id;
    const card = await pressPlayerCardAction(host.page, carolId, /^Remove /);
    note(`Carol's card offers: ${JSON.stringify(card.labels)}`);
    if (!card.pressed) {
      problems.push(`the host is offered no way to remove a player (offers: ${JSON.stringify(card.labels)})`);
    }
    const stillThere = table.store.table('players').some(p => String(p.id) === String(carolId));
    note(`Carol's seat after eject: ${stillThere ? 'still there' : 'gone'}`);
    if (stillThere) problems.push('the host pressed Remove and the player stayed');

    // AN EJECTED PLAYER CAN COME BACK. This is the half that makes "eject" a
    // different word from "kick", and without it the two are the same button.
    const tryJoin = (name, uid) => table.store.execute({
      table: 'players', action: 'insert',
      payload: { room_id: table.store.table('rooms')[0].id, display_name: name,
                 user_id: uid, joined_at: new Date().toISOString() },
    });
    const rejoin = await tryJoin('Carol', carolUser);
    note(`an ejected player rejoining: ${rejoin.error ? rejoin.error.code : 'allowed'}`);
    if (rejoin.error) {
      problems.push(`an EJECTED player was refused a seat (${rejoin.error.code}) — eject is supposed to be recoverable`);
    }

    // ACCEPT THE CONFIRM. Playwright DISMISSES dialogs by default, so without
    // this the kick is cancelled and every assertion below would be measuring
    // a button that was never really pressed.
    host.page.once('dialog', d => d.accept());

    // KICK: gone, and refused on the way back.
    const carolAgain = table.store.table('players').find(p => p.display_name === 'Carol')?.id;
    const kicked = await pressPlayerCardAction(host.page, carolAgain, /^Kick /);
    note(`kick pressed: ${kicked.pressed}, offers were ${JSON.stringify(kicked.labels)}`);
    if (!kicked.pressed) {
      problems.push(`the host is offered no way to kick a player (offers: ${JSON.stringify(kicked.labels)})`);
    }
    const kickedGone = !table.store.table('players').some(p => String(p.id) === String(carolAgain));
    note(`Carol's seat after kick: ${kickedGone ? 'gone' : 'still there'}`);
    if (!kickedGone) problems.push('the host pressed Kick and the player stayed');

    const retry = await tryJoin('Carol', carolUser);
    note(`a kicked player rejoining: ${retry.error ? retry.error.code : 'ALLOWED'}`);
    if (!retry.error) {
      problems.push('a KICKED player walked straight back into the room — the ban does nothing');
    }

    // AND NOBODY ELSE IS CAUGHT BY IT. A ban that refused everybody would pass
    // the check above perfectly.
    const bystander = await tryJoin('Dave', 'user-dave');
    note(`somebody else joining after a kick: ${bystander.error ? bystander.error.code : 'allowed'}`);
    if (bystander.error) {
      problems.push(`the kick locked OTHER people out of the room too (${bystander.error.code})`);
    }
  }

  // ============================================================
  // 3 + 4. CO-HOST POWERS IN GAME
  // ============================================================
  heading('co-host controls in game');
  await host.page.waitForSelector('#btn-start-game', { state: 'visible', timeout: 20000 }).catch(() => {});
  for (let i = 0; i < 12; i++) {
    await clickIfReady(host, '#btn-start-game');
    await host.page.waitForTimeout(700);
    if (table.store.table('rooms')[0]?.status === 'playing') break;
  }
  for (const r of [host, bob, carol]) {
    await r.page.waitForURL('**/game.html*', { timeout: 25000 })
      .catch(() => problems.push(`${r.name} never reached the game`));
  }
  await host.page.waitForTimeout(6500);

  // Everyone answers so the reveal screen appears for all three.
  for (const r of [host, bob, carol]) {
    const input = r.page.locator('#answer-input');
    if (await input.isVisible().catch(() => false)) {
      const w = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
      if (await w.isVisible().catch(() => false)) await w.click().catch(() => {});
      await input.fill('Answer 1').catch(() => {});
      await clickIfReady(r, '#btn-submit-answer');
    }
  }
  await host.page.waitForTimeout(3000);

  const canAdvance = async r => r.page.evaluate(() => {
    const el = document.querySelector('#btn-next-question');
    return !!el && el.offsetParent !== null && !el.disabled;
  }).catch(() => false);

  const bobCan = await canAdvance(bob);
  const carolCan = await canAdvance(carol);
  note(`co-host Bob can advance: ${bobCan}; ordinary player Carol can advance: ${carolCan}`);
  if (!bobCan) problems.push('a co-host cannot advance the game — the role does nothing');
  if (carolCan) problems.push('an ordinary player can advance the game — host controls are not gated');

  // A co-host advancing must actually move the room, not just their own screen.
  if (bobCan) {
    const before = table.store.table('rooms')[0]?.game_phase;
    await clickIfReady(bob, '#btn-next-question');
    await host.page.waitForTimeout(2500);
    const after = table.store.table('rooms')[0]?.game_phase;
    note(`co-host advanced the room: ${before} -> ${after}`);
    if (before === after) {
      problems.push('the co-host pressed advance and the room did not move');
    }
  }

  // ============================================================
  // WHEN op_set_phase IS REACHED AND FAILS
  //
  // Every phase change in this game used to be updateGameState, which goes
  // through reportWriteFailure and told the player "Couldn't move the game on
  // — check your connection". Routing them all through op_set_phase (migration
  // 060) kept the write and DROPPED the message: a genuine error logged and
  // returned, no fallback, nothing on screen. A transient failure became a
  // button that does nothing and a game that silently stops — in the one place
  // that matters most, because a phase change is how the game MOVES.
  //
  // No fallback is correct here — 061 revoked the column, so a direct write
  // would match zero rows and report success — which is exactly why the
  // message is the whole of the fix.
  //
  // failFunction is what makes this reachable: hideFunction models "not
  // installed", which takes the fallback and is the branch that was always
  // right.
  // ============================================================
  {
    const advance = host.page.locator('#btn-next-question');
    const pressable = await advance.evaluate(el => !!el && el.offsetParent !== null && !el.disabled)
      .catch(() => false);
    note(`host advance button pressable before the failure test: ${pressable}`);
    if (!pressable) {
      // Without a real press this check cannot fail, and a check that cannot
      // fail is worse than none.
      problems.push('could not reach an advance button to test a refused phase change');
    } else {
      table.store.failFunction('op_set_phase');
      const phaseBefore = table.store.table('rooms')[0]?.game_phase;
      await advance.click().catch(() => {});
      await host.page.waitForTimeout(2500);
      table.store.unfailFunction('op_set_phase');

      const phaseAfter = table.store.table('rooms')[0]?.game_phase;
      const toasted = await host.page.evaluate(() =>
        [...document.querySelectorAll('.toast, #toast')].map(t => t.textContent.trim()).join(' | ')
      ).catch(() => '');
      note(`refused phase change: room ${phaseBefore} -> ${phaseAfter}, toast ${JSON.stringify(toasted)}`);

      if (phaseAfter !== phaseBefore) {
        problems.push('op_set_phase failed and the room moved anyway — something wrote the phase directly');
      }
      if (!/couldn.t move the game on/i.test(toasted)) {
        problems.push(`the host pressed advance, the server failed, and nothing was said (toasts: ${JSON.stringify(toasted)})`);
      }
    }
  }

  // ============================================================
  // THE CO-HOST REVEALS THE FINAL QUESTION
  //
  // "Reveal Question" is gated on canControlGame(), so a CO-HOST or a DEPUTY
  // can press it — and handleRevealFinalQuestion SWAPS the final question for
  // one matching the difficulty vote and writes a new question_ids.
  //
  // Two things used to be written as "am I the host" that meant "am I the one
  // who did this", and both broke here:
  //
  //   * handleRoomChange ignored a question-list change when isHost, so the
  //     HOST alone never heard about the swap. Measured before the fix: the
  //     room and the co-host on q15, the host still showing q21. Since
  //     migration 046 judges against the ROOM's question, the host answers one
  //     nobody asked and is marked wrong on one they never saw. Reported from a
  //     live game as "my friend saw a different question".
  //   * the difficulty 'reveal' broadcast skipped the animation when isHost,
  //     so the host got no slot machine at all — while the presser, which the
  //     channel echoes to (broadcast:{self:true}), ran it twice.
  //
  // Checking that every phone AGREES is what catches the first; checking that
  // every phone ANIMATED catches the second. Agreement alone would pass if
  // nobody was asked anything.
  // ============================================================
  heading('the co-host reveals the final question');

  for (const r of [host, bob, carol]) {
    await r.page.evaluate(() => {
      window.__drChains = 0;
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

  const screenOf = r => r.page
    .evaluate(() => document.querySelector('.screen.active')?.id || '(none)').catch(() => '(nav)');
  const done = new Set();
  let revealed = false;
  let revealMark = 0;

  for (let i = 0; i < 220 && !revealed; i++) {
    for (const r of [host, bob, carol]) {
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
        // THE CO-HOST, not the host. That is the whole point of the section.
        if (r === bob && done.has(key) && await clickIfReady(bob, '#btn-fw-reveal')) {
          note('the co-host pressed Reveal Question');
          revealed = true;
          // AND THE HOST PRESSES IT TOO.
          //
          // Every controller has this button — it is gated on canControlGame()
          // — and handleRevealFinalQuestion awaits a fetch and a six-second
          // animation, so there is a long window in which a second press lands.
          // A second run picks its OWN random winner, fetches its OWN question
          // over state.questions[totalQuestions], and writes question_ids again,
          // racing the first. Reported from a live game: "difficulty randomizer
          // ran twice, and then advanced to differing questions for each
          // person." The checks below — everyone asked the ROOM's question —
          // are what catches it.
          //
          // Fired without awaiting the co-host's press, because the two landing
          // together is the case; a tidy sequence would let the guard win for
          // the wrong reason.
          revealMark = table.store.log.length;
          host.page.evaluate(() => document.getElementById('btn-fw-reveal')?.click()).catch(() => {});
          note('the host pressed it as well, in the same beat');
        }
      } else if (r === host) {
        if (screen === 'reveal-screen') await clickIfReady(r, '#btn-next-question');
        if (screen === 'scores-screen') await clickIfReady(r, '#btn-scores-action');
      }
    }
    await host.page.waitForTimeout(400);
  }

  if (!revealed) {
    problems.push('the co-host never got to press Reveal Question, so the final-question checks proved nothing');
  } else {
    await host.page.waitForTimeout(14000);   // let the slot machine finish everywhere
    const asked = {};
    for (const r of [host, bob, carol]) {
      asked[r.name] = (await r.page.textContent('#question-text').catch(() => null)) || '(none)';
    }
    const roomTail = table.store.table('rooms')[0]?.question_ids?.slice(-1)[0];
    const roomQ = table.store.table('questions').find(q => q.id === roomTail)?.question || '(unknown)';
    note(`room asks: ${JSON.stringify(roomQ)}`);
    for (const r of [host, bob, carol]) note(`${r.name} is asked: ${JSON.stringify(asked[r.name])}`);

    for (const r of [host, bob, carol]) {
      if (asked[r.name] !== roomQ) {
        problems.push(`${r.name} is being asked ${JSON.stringify(asked[r.name])} while the room asks ${JSON.stringify(roomQ)} — the verdict comes from the room's question, so they are judged on one they never saw`);
      }
    }

    for (const r of [host, bob, carol]) {
      const chains = await r.page.evaluate(() => window.__drChains).catch(() => -1);
      note(`${r.name} ran the difficulty reveal ${chains}x`);
      if (chains === 0) {
        problems.push(`${r.name} never saw the difficulty reveal when the co-host revealed the final question`);
      }
      // EXACTLY ONE. Two chains are ~6.5s of un-cancellable setTimeouts over a
      // single overlay, and the second one's ending puts the overlay back up
      // over the question screen the first already moved on to. This fires only
      // when the two land far enough apart for the observer to see both
      // transitions, so it is a bonus — the question-agreement checks above are
      // what reliably catch a second reveal.
      if (chains > 1) {
        problems.push(`${r.name} ran the difficulty reveal ${chains}x — two chains fighting over one overlay is the "screen half phased out between the question and the difficulty screen" report`);
      }
    }

    // HOW MANY REVEALS ACTUALLY HAPPENED, counted from the store rather than
    // from the screen. Each run of handleRevealFinalQuestion writes the
    // question list once, so two runs write it twice — and the browser-side
    // signals are unreliable here for the reason CLAUDE.md already records
    // about this animation: two chains can overlap so tightly that no observer
    // on the overlay sees both. The write is the fact.
    const listWrites = table.store.log.filter((o, i) =>
      i >= revealMark && o.table === 'rooms' && o.action === 'update'
      && o.payload && Object.prototype.hasOwnProperty.call(o.payload, 'question_ids'));
    note(`question-list writes after the second press: ${listWrites.length}`);
    if (listWrites.length > 1) {
      problems.push(`the final question was revealed ${listWrites.length} times — each run picks its own random difficulty and fetches its own question, so the room's last question depends on which write landed last`);
    }

    // AND THE OVERLAY IS NOT STILL UP. It is position:fixed over everything, so
    // a second chain finishing after the room has moved on leaves the question
    // unreadable and untappable with nothing to dismiss it.
    for (const r of [host, bob, carol]) {
      const stuck = await r.page.evaluate(() => {
        const el = document.getElementById('difficulty-reveal-overlay');
        return !!el && !el.classList.contains('hidden');
      }).catch(() => false);
      if (stuck) {
        problems.push(`${r.name} is on the final question with the difficulty overlay still covering it`);
      }
    }
  }

  for (const r of [host, bob, carol]) {
    const real = r.consoleErrors.filter(e =>
      // op_set_host_role's failure is INJECTED by the refused-promotion check
      // above, and the client logging it is the behaviour being measured.
      // Excluded by its exact shape, so a different fault still shows up.
      !/op_set_host_role failed/i.test(e) &&
      // Same for op_set_phase, injected by the refused-advance check.
      !/op_set_phase failed/i.test(e) &&
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ co-host scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
