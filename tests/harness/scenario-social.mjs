// Scenario: the features around the game rather than the game itself.
//
//   1. Lobby chat — does a message reach the other player?
//   2. In-game chat — same, plus the unread badge.
//   3. Honks — does tapping the duck register on the target's screen?
//   4. Host score editing — does an override reach everyone, or only the host?
//   5. Review Questions overlay — does it open and list the questions played?
//
// None of these had any coverage. They are also the parts most likely to be
// used constantly and noticed immediately when broken.
//
// Run: node tests/harness/scenario-social.mjs
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
  // .first() matters: a selector matching several elements makes Playwright's
  // strict mode throw, and a catch around it turns that into a silent "not
  // clickable" — which reads as a broken feature rather than a broken query.
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

  // ---- room with two players ----
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

  const bob = await seat('Bob');
  await bob.goto('join.html');
  await bob.page.waitForSelector('#code-input', { timeout: 15000 });
  await bob.page.fill('#code-input', code);
  await bob.page.click('#btn-join');
  await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1500);

  // ============================================================
  // 1. LOBBY CHAT
  // ============================================================
  heading('lobby chat');
  const LOBBY_MSG = 'ready when you are';
  await host.page.fill('#chat-drawer-input', LOBBY_MSG).catch(() => {});
  await clickIfReady(host, '#btn-chat-send');
  await bob.page.waitForTimeout(2500);

  const bobSawLobbyChat = await bob.page.evaluate(m =>
    (document.querySelector('#chat-drawer-messages')?.textContent || '').includes(m),
    LOBBY_MSG).catch(() => false);
  note(`Bob received the lobby message: ${bobSawLobbyChat}`);
  if (!bobSawLobbyChat) problems.push('a lobby chat message never reached the other player');

  const stored = table.store.table('chat_messages').length;
  note(`chat_messages stored: ${stored}`);
  if (stored === 0) problems.push('chat messages are not being stored at all');

  // ============================================================
  // 1b. A BUSY ROOM SHOWS THE NEWEST HUNDRED, NOT THE FIRST HUNDRED
  //
  // fetchMessages ordered ASCENDING and limited to CHAT_MESSAGES_LIMIT, which
  // asks Postgres for the OLDEST hundred rows. Past the limit, anybody
  // reloading or returning from a game saw the first hundred things ever said
  // and nothing since — and it healed itself as soon as one more message
  // arrived over Realtime, which is about as hard to report as a bug gets.
  //
  // Under the limit BOTH orderings return the identical set, so this check has
  // to push past it or it cannot fail. 120 seeded, so the oldest 20 must be
  // gone and the newest must be there.
  // ============================================================
  heading('chat history past the 100-message limit');
  {
    const roomRow = table.store.table('rooms')[0];
    const base = Date.now() - 60 * 1000;
    const bulk = [];
    for (let i = 1; i <= 120; i++) {
      bulk.push({
        id: `bulk-${i}`,
        room_id: roomRow.id,
        player_name: 'Alice',
        message: `bulk message ${String(i).padStart(3, '0')}`,
        hearts: [],
        // Well inside the room's life, and strictly increasing so "newest" is
        // unambiguous. 250ms apart keeps all 120 after Bob's entry cut-off.
        created_at: new Date(base + i * 250).toISOString(),
      });
    }
    table.store.seed('chat_messages', bulk);

    // Reload rather than waiting on Realtime: the fault is in what a returning
    // phone FETCHES, and live delivery is exactly what used to paper over it.
    await bob.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await bob.page.waitForTimeout(3000);
    await clickIfReady(bob, '#chat-bar');
    await bob.page.waitForTimeout(1200);

    const seen = await bob.page.evaluate(() => {
      const t = document.querySelector('#chat-drawer-messages')?.textContent || '';
      return {
        newest: t.includes('bulk message 120'),
        oldest: t.includes('bulk message 001'),
        rendered: (t.match(/bulk message/g) || []).length,
      };
    }).catch(() => ({ newest: false, oldest: false, rendered: 0 }));

    note(`rendered ${seen.rendered} of 120; newest present: ${seen.newest}; oldest present: ${seen.oldest}`);
    if (seen.rendered === 0) {
      problems.push('no chat history rendered at all after a reload — the fetch or the cut-off is wrong');
    } else if (!seen.newest) {
      problems.push('the most recent chat message is missing after a reload — the fetch is taking the OLDEST hundred, so a busy room loses its live conversation');
    }
  }

  // ============================================================
  // start a game for the in-game checks
  // ============================================================
  await host.page.waitForSelector('#btn-start-game', { state: 'visible', timeout: 20000 }).catch(() => {});
  for (let i = 0; i < 12; i++) {
    await clickIfReady(host, '#btn-start-game');
    await host.page.waitForTimeout(700);
    const room = table.store.table('rooms')[0];
    if (room?.status === 'playing') break;
  }
  for (const r of [host, bob]) {
    await r.page.waitForURL('**/game.html*', { timeout: 25000 })
      .catch(() => problems.push(`${r.name} never reached the game`));
  }
  await host.page.waitForTimeout(6500);   // through the countdown

  // Both answer question one so the reveal screen (honks live there) appears.
  for (const r of [host, bob]) {
    const input = r.page.locator('#answer-input');
    if (await input.isVisible().catch(() => false)) {
      const w = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
      if (await w.isVisible().catch(() => false)) await w.click().catch(() => {});
      await input.fill('Answer 1').catch(() => {});
      await clickIfReady(r, '#btn-submit-answer');
    }
  }
  await host.page.waitForTimeout(2500);
  note(`after answering: Alice on ${await activeScreen(host)}, Bob on ${await activeScreen(bob)}`);

  // ============================================================
  // 2. IN-GAME CHAT
  // ============================================================
  heading('in-game chat');
  const GAME_MSG = 'that one was rough';
  const chatBarOpened = await clickIfReady(bob, '#chat-bar');
  await bob.page.waitForTimeout(600);
  await bob.page.fill('#chat-drawer-input', GAME_MSG).catch(() => {});
  const sent = await clickIfReady(bob, '#btn-chat-send');
  note(`Bob opened the chat bar: ${chatBarOpened}, sent: ${sent}`);
  await host.page.waitForTimeout(2500);

  const hostSawGameChat = await host.page.evaluate(m =>
    (document.querySelector('#chat-drawer-messages')?.textContent || '').includes(m) ||
    (document.querySelector('#chat-bar-preview')?.textContent || '').includes(m),
    GAME_MSG).catch(() => false);
  note(`Alice received the in-game message: ${hostSawGameChat}`);
  if (!hostSawGameChat) problems.push('an in-game chat message never reached the other player');

  // ============================================================
  // 3. HONKS
  // ============================================================
  heading('honks');
  const honkBtn = host.page.locator('.honk-btn').first();
  const honkVisible = await honkBtn.isVisible().catch(() => false);
  note(`honk button visible to Alice: ${honkVisible}`);
  if (!honkVisible) {
    problems.push(`no honk button on Alice's screen (${await activeScreen(host)})`);
  } else {
    // Watch for the honker's avatar shaking BEFORE the honk, because the class
    // is added and removed again within about half a second — polling after the
    // fact would find nothing and prove nothing. from_id has always been in the
    // broadcast payload and nothing read it, so a honk used to arrive from
    // nobody in particular; this is what puts a face on it.
    const aliceId = table.store.table('players').find(p => p.display_name === 'Alice')?.id;
    const watch = r => r.page.evaluate((id) => new Promise(resolve => {
      const sel = `[data-player-id="${id}"]`;
      const seen = () => [...document.querySelectorAll(sel)]
        .some(row => (row.querySelector('.avatar') || row).classList.contains('honk-jiggle'));
      if (seen()) return resolve(true);
      const obs = new MutationObserver(() => { if (seen()) { obs.disconnect(); resolve(true); } });
      obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
      setTimeout(() => { obs.disconnect(); resolve(seen()); }, 4000);
    }), String(aliceId)).catch(() => false);

    const jiggledOnBob = watch(bob);
    const jiggledOnAlice = watch(host);

    await honkBtn.click().catch(() => {});
    await host.page.waitForTimeout(2000);

    const [bobSaw, aliceSaw] = await Promise.all([jiggledOnBob, jiggledOnAlice]);
    note(`honker's avatar shook — on Bob's screen: ${bobSaw}, on Alice's own: ${aliceSaw}`);
    if (!bobSaw && !aliceSaw) {
      problems.push("a honk did not shake the honker's avatar on any client — the quack arrives from nobody in particular");
    }

    // The badge is rendered on every client that received the honk.
    const badgeFor = async r => r.page.evaluate(() =>
      [...document.querySelectorAll('.honk-badge')]
        .filter(b => b.style.display !== 'none')
        .map(b => b.textContent.trim())).catch(() => []);
    const hostBadges = await badgeFor(host);
    const bobBadges = await badgeFor(bob);
    note(`badges — Alice sees ${JSON.stringify(hostBadges)}, Bob sees ${JSON.stringify(bobBadges)}`);
    if (hostBadges.length === 0 && bobBadges.length === 0) {
      problems.push('a honk produced no visible badge on any client');
    }
  }

  // ============================================================
  // 4. HOST SCORE EDITING
  // ============================================================
  heading('host score editing');

  // Edit Scores is deliberately hidden on the first round — there is nothing
  // behind it yet — so play a second question before looking for it. Checking
  // on round one "passes" without testing anything.
  // Advance until the room itself reports a later question AND the host is on
  // the scores screen. Returning as soon as a scores screen appears matched
  // round one's own screen and tested nothing.
  const reachScoresForQuestion = async (minQuestion) => {
    for (let i = 0; i < 40; i++) {
      const room = table.store.table('rooms')[0];
      const q = room?.current_question ?? 0;
      const screen = await activeScreen(host);
      if (q >= minQuestion && screen === 'scores-screen') return q;

      if (screen === 'question-screen') {
        for (const r of [host, bob]) {
          const input = r.page.locator('#answer-input');
          if (await input.isVisible().catch(() => false)) {
            const w = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
            if (await w.isVisible().catch(() => false)) await w.click().catch(() => {});
            await input.fill(`Answer ${q + 1}`).catch(() => {});
            await clickIfReady(r, '#btn-submit-answer');
          }
        }
      } else if (screen === 'reveal-screen') {
        await clickIfReady(host, '#btn-next-question');
      } else if (screen === 'scores-screen') {
        await clickIfReady(host, '#btn-scores-action');
      }
      await host.page.waitForTimeout(750);
    }
    return -1;
  };

  const reachedQ = await reachScoresForQuestion(1);
  note(`reached scores for question ${reachedQ}`);
  if (reachedQ < 1) problems.push('could not reach a scores screen beyond the first round');

  const editVisible = await host.page.locator('#btn-edit-scores').isVisible().catch(() => false);
  note(`Edit Scores visible to host: ${editVisible}`);
  if (!editVisible) {
    problems.push('Edit Scores is not offered to the host after the first round');
  } else {
    await clickIfReady(host, '#btn-edit-scores');
    await host.page.waitForTimeout(1200);
    const sheetOpen = await host.page.locator('#score-edit-sheet').isVisible().catch(() => false);
    note(`score edit sheet opened: ${sheetOpen}`);
    if (!sheetOpen) {
      problems.push('Edit Scores did not open its panel');
    } else {
      // Pick a question, then flip one player's judgement and check the change
      // actually reaches the other player rather than staying on the host.
      const listInfo = await host.page.evaluate(() => {
        const list = document.querySelector('#score-edit-question-list');
        const ans = document.querySelector('#score-edit-answers');
        return {
          listChildren: list ? list.children.length : -1,
          listSample: list ? [...list.children].slice(0, 3).map(c => `${c.tagName}.${c.className}:"${c.textContent.trim().slice(0,20)}"`) : [],
          answersChildren: ans ? ans.children.length : -1,
          toggles: document.querySelectorAll('.answer-toggle--host').length,
        };
      }).catch(e => ({ err: String(e).slice(0, 80) }));
      note(`sheet contents: ${JSON.stringify(listInfo)}`);

      // Scope every lookup to the sheet. `.answer-toggle--host` also matches
      // hidden leftovers on the reveal screen, and an unscoped .first() picks
      // one of those — the same trap that made a working promoted host look
      // like it had no controls.
      const picked = await clickIfReady(host, '#score-edit-question-list button');
      note(`picked a question row: ${picked}`);
      await host.page.waitForTimeout(1200);

      const afterPick = await host.page.evaluate(() => ({
        answersChildren: document.querySelector('#score-edit-answers')?.children.length ?? -1,
        togglesInSheet: document.querySelectorAll('#score-edit-sheet .answer-toggle--host').length,
      })).catch(() => ({}));
      note(`after picking a question: ${JSON.stringify(afterPick)}`);

      const toggle = host.page.locator('#score-edit-sheet .answer-toggle--host').first();
      if (!await toggle.isVisible().catch(() => false)) {
        problems.push('score edit panel opened but offered no judgement to flip');
      } else {
        const answerId = await toggle.getAttribute('data-answer-id');
        const before = table.store.table('answers').find(a => String(a.id) === String(answerId));
        const wasCorrect = !!before?.is_correct;
        await toggle.click().catch(() => {});
        await host.page.waitForTimeout(2500);

        const after = table.store.table('answers').find(a => String(a.id) === String(answerId));
        note(`judgement for that answer: ${wasCorrect} -> ${!!after?.is_correct}`);
        if (!!after?.is_correct === wasCorrect) {
          problems.push('flipping a judgement in Edit Scores did not change the stored answer');
        }
      }
    }
  }

  // ============================================================
  // 5. REVIEW QUESTIONS (results screen)
  // ============================================================
  heading('review questions overlay');
  await clickIfReady(host, '#score-edit-backdrop');
  await host.page.waitForTimeout(600);

  for (let i = 0; i < 40; i++) {
    const room = table.store.table('rooms')[0];
    if (room?.game_phase === 'results') break;
    const screen = await activeScreen(host);
    if (screen === 'question-screen' || screen === 'final-wager-screen') {
      for (const r of [host, bob]) {
        if (screen === 'final-wager-screen') {
          const o = r.page.locator('#final-wager-screen [data-wager]').first();
          if (await o.isVisible().catch(() => false)) await o.click().catch(() => {});
          await clickIfReady(r, '#btn-fw-lock');
        } else {
          const input = r.page.locator('#answer-input');
          if (await input.isVisible().catch(() => false)) {
            const w = r.page.locator('.wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first();
            if (await w.isVisible().catch(() => false)) await w.click().catch(() => {});
            await input.fill('something').catch(() => {});
            await clickIfReady(r, '#btn-submit-answer');
          }
        }
      }
      if (screen === 'final-wager-screen') await clickIfReady(host, '#btn-fw-reveal');
    } else if (screen === 'reveal-screen') {
      await clickIfReady(host, '#btn-next-question');
    } else if (screen === 'scores-screen') {
      await clickIfReady(host, '#btn-scores-action');
    }
    await host.page.waitForTimeout(700);
  }
  await host.page.waitForTimeout(2000);
  note(`Alice is on ${await activeScreen(host)}`);

  const reviewBtn = host.page.locator('#btn-review-questions');
  if (!await reviewBtn.isVisible().catch(() => false)) {
    problems.push(`Review Questions not offered on ${await activeScreen(host)}`);
  } else {
    await reviewBtn.click().catch(() => {});
    await host.page.waitForTimeout(1800);
    const listed = await host.page.evaluate(() =>
      document.querySelectorAll('#review-list > *').length).catch(() => -1);
    note(`review overlay listed ${listed} entries`);
    if (listed <= 0) problems.push('Review Questions opened but listed nothing');
  }

  for (const r of [host, bob]) {
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — ${real.map(e => e.slice(0, 700)).join(' || ')}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ social scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
