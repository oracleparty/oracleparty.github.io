// Scenario: HOW LONG BETWEEN A TAP AND SOMETHING HAPPENING?
//
// Run: node tests/harness/scenario-latency.mjs [--lag=300]
//
// Every other scenario asks whether the game is CORRECT. This one asks whether
// it FEELS answered — the gap between pressing a control and the first pixel
// that moves. CLAUDE.md praises exactly that measure on the final question:
// "it measures the gap between the tap and the first pixel that moves, which
// cannot be flaky and does not care how many round trips the fix happens to
// save."
//
// WHY A LAG IS INJECTED. The store is in-memory, so every request answers
// instantly and NOTHING here is slow by default. That makes the harness blind
// to the one fault this is looking for: a control that waits on the network
// before it shows anything. `robot.slowConnection(ms)` gives one phone a real
// round trip, and then a button that does three of them before drawing costs
// three times a button that does none.
//
// SO THE NUMBERS ARE NOT MILLISECONDS ANYBODY WILL EXPERIENCE. They are a
// count of round trips wearing a clock. What matters is the RATIO between
// controls, and whether a control moves at all before its network work is done.
import { PlaytestTable } from './harness.js';

const args = process.argv.slice(2);
const LAG = Number((args.find(a => a.startsWith('--lag=')) || '--lag=300').split('=')[1]);
const CATEGORY = 'history';

// A tap is "answered" once ANY of these is true. Deliberately broad: a spinner,
// a disabled button, changed text and a new screen are all feedback.
const BUDGET_MS = 2500;

function seedQuestions(store, n = 40) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`, question_text: `Test question ${i}?`,
      correct_answer: `Answer ${i}`, acceptable_answers: [`Ans ${i}`],
      categories: [CATEGORY], subcategory: null,
      difficulty: 'medium', format: 'open', fun_fact: '',
    });
  }
  store.seed('questions', rows);
}

const results = [];
const problems = [];
const note = m => console.log('   ·', m);

/**
 * Press something and time the first visible change.
 *
 * `settled` is polled every 16ms — one frame — so the number is the delay a
 * person would actually see rather than the delay of the next poll.
 */
async function timeTap(robot, label, press, probe) {
  // SNAPSHOT FIRST, THEN WAIT FOR IT TO DIFFER.
  //
  // The first version of this named the state it expected to END in, and got
  // three of them wrong — reporting "no visible change" for Start Game, which
  // certainly navigates. A predicate that names an end state is a guess about
  // markup; asking whether ANYTHING the probe can see has changed is not, and
  // it is the same measure either way: the first pixel that moves.
  const before = await robot.page.evaluate(probe).catch(() => null);
  const t0 = Date.now();
  await press();
  let ms = null;
  while (Date.now() - t0 < BUDGET_MS) {
    const now = await robot.page.evaluate(probe).catch(() => null);
    if (now !== null && now !== before) { ms = Date.now() - t0; break; }
    await robot.page.waitForTimeout(16);
  }
  results.push({ label, ms, before });
  note(`${label.padEnd(34)} ${ms === null ? `NOTHING CHANGED in ${BUDGET_MS}ms (was: ${String(before).slice(0, 60)})` : ms + 'ms'}`);
  return ms;
}

/** What the screen looks like, as one comparable string. */
const SCREEN_PROBE = () => JSON.stringify({
  path: location.pathname.split('/').pop(),
  screen: document.querySelector('.screen.active')?.id || null,
  sheets: [...document.querySelectorAll('.bottom-sheet, .modal-overlay')]
    .filter(el => el.offsetParent !== null || el.classList.contains('active')).map(el => el.id),
  ready: document.querySelector('#btn-ready')?.textContent?.trim() || null,
  // THE PRESSED BUTTON'S OWN STATE COUNTS AS FEEDBACK, and leaving it out
  // reported Start Game as 7.9 round trips of nothing when it in fact disables
  // itself and says "Starting..." before it touches the network. That is the
  // difference between "the control answered" and "the work finished", and
  // only the first one is what a person is waiting for.
  start: (() => { const b = document.querySelector('#btn-start-game');
    return b ? `${b.textContent.trim()}|${b.disabled}` : null; })(),
  advance: document.querySelector('#btn-next-question')?.textContent?.trim() || null,
  advanceOff: !!document.querySelector('#btn-next-question')?.disabled,
  advanceBusy: document.querySelector('#btn-next-question')?.className || null,
  correctShown: (() => { const c = document.querySelector('.reveal__correct');
    return !!c && c.style.display !== 'none'; })(),
});

/** The wager row's own state — a bet tap is entirely local, so this is all the
 *  feedback there is: the button highlights and Submit comes alive. */
const WAGER_PROBE = () => JSON.stringify({
  selected: document.querySelector('.wager-btn--selected')?.dataset.value || null,
  submit: document.querySelector('#btn-submit-answer')?.textContent?.trim() || null,
  submitOff: !!document.querySelector('#btn-submit-answer')?.disabled,
  error: document.querySelector('#wager-error')?.textContent || '',
});

/** Submit's own state, plus the screen. A tap is answered the moment the
 *  control says so — not when the write returns. */
const SUBMIT_PROBE = () => JSON.stringify({
  screen: document.querySelector('.screen.active')?.id || null,
  submit: document.querySelector('#btn-submit-answer')?.textContent?.trim() || null,
  submitOff: !!document.querySelector('#btn-submit-answer')?.disabled,
  inputOff: !!document.querySelector('#answer-input')?.disabled,
});

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);
  console.log(`\n=== every phone on a ${LAG}ms round trip ===`);

  const host = await table.seat('Alice');
  await host.page.addInitScript(() =>
    localStorage.setItem('oracle_party_display_name', 'Alice'));
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 15000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  // Picking a category opens a subcategory sheet; "All <Category>" plays the
  // whole category. Same sequence as scenario-lobby.
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /', { timeout: 15000 });
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1500);

  const code = (await host.textOf('#lobby-code')) || (await host.page.evaluate(() => {
    const el = document.querySelector('[id*="code"]');
    return el ? el.textContent.trim() : null;
  })) || '';
  if (!code) throw new Error('could not read the room code');
  const bob = await table.seat('Bob');
  await bob.page.addInitScript(() =>
    localStorage.setItem('oracle_party_display_name', 'Bob'));
  await bob.goto('join.html');
  await bob.page.waitForSelector('#code-input', { timeout: 15000 });
  await bob.page.fill('#code-input', code);
  await bob.page.click('#btn-join');
  await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1500);

  // Everything from here is measured on a real round trip.
  host.slowConnection(LAG);
  bob.slowConnection(LAG);

  console.log('\n=== in the lobby ===');

  // TAPPING SOMEBODY'S FACE. The owner's own hunch: "clicking profile might lag
  // a tad." The card is inserted into the DOM only at the very END of
  // showProfileCard, after its fetches.
  await timeTap(host, 'open a player profile card',
    async () => { await host.page.locator('#player-list .player-item .avatar-wrap').first().click().catch(() => {}); },
    SCREEN_PROBE);
  // CLOSE IT PROPERLY. Escape did not, and the sheet then sat over Start Game
  // and swallowed every press after it — the run reported "nothing changed"
  // for three controls that were never actually tapped. The harness lying
  // about the app, for the second time in this file.
  await host.page.locator('#profile-card-backdrop').click({ force: true }).catch(() => {});
  await host.page.waitForTimeout(600);
  const stillOpen = await host.page.evaluate(() => !!document.querySelector('#profile-card-sheet'));
  if (stillOpen) {
    await host.page.evaluate(() => document.querySelector('#profile-card-sheet')?.remove());
    note('the profile sheet would not close on its own — removed it so the rest can be measured');
  }

  await timeTap(bob, 'press Ready Up',
    async () => { await bob.page.locator('#btn-ready').click().catch(() => {}); },
    SCREEN_PROBE);
  await bob.page.waitForTimeout(800);

  await timeTap(host, 'press Start Game',
    async () => { await host.page.locator('#btn-start-game').click().catch(() => {}); },
    SCREEN_PROBE);

  await host.page.waitForURL('**/game.html*', { timeout: 25000 }).catch(() => {});
  await bob.page.waitForURL('**/game.html*', { timeout: 25000 }).catch(() => {});
  await host.page.waitForTimeout(6000);

  console.log('\n=== in a round ===');

  // HOW OFTEN IS THE WAGER GRID DESTROYED UNDER THE PLAYER'S FINGER?
  //
  // Reported from a live game: "tapping buttons (submit, bet values) slow and
  // non responsive. It was nearly game stopping." selectWager is entirely
  // local — no await, no network — so a wager tap that does nothing cannot be
  // a slow connection. It can only be a tap that never became a click.
  //
  // renderWagerGrid() does `grid.innerHTML = ''` and rebuilds every button, and
  // showQuestionScreen calls it on EVERY render, including a re-render of the
  // question already on screen. A phone fires touchstart, then click; if the
  // button is detached in between, the click never happens and the tap is
  // silently swallowed. This counts the rebuilds so the mechanism is a number
  // rather than an argument.
  for (const r of [host, bob]) {
    await r.page.evaluate(() => {
      window.__gridRebuilds = 0;
      const grid = document.querySelector('#wager-grid');
      if (!grid) return;
      new MutationObserver(muts => {
        for (const m of muts) if (m.removedNodes.length) { window.__gridRebuilds++; break; }
      }).observe(grid, { childList: true });
    }).catch(() => {});
  }

  // WAIT FOR THE ROUND TO BE LIVE FIRST. showQuestionScreen hides the card, the
  // grid, the answer box and the timer for a one-second sync buffer, and
  // Playwright's click auto-waits for an actionable element — so timing a tap
  // that starts inside that buffer measures the buffer, not the control. The
  // first version of this reported 1222ms and it was entirely that.
  await host.page.locator('#wager-grid .wager-btn').first()
    .waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  // WOULD A TAP LAND ON THE CONTROL AT ALL? The mocks cannot answer this — the
  // chat bar, the host gear and the keyboard rules only exist in a real game.
  // elementFromPoint at each button's centre is the same hit test the layout
  // sweep's COVERED check uses, asked of the two controls the owner reported.
  const reach = await host.page.evaluate(() => {
    const hit = el => {
      if (!el) return 'missing';
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return 'zero-size';
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return (top === el || el.contains(top)) ? 'ok' : (top ? (top.id || top.className || top.tagName) : 'nothing');
    };
    const btns = [...document.querySelectorAll('#wager-grid .wager-btn')];
    const sizes = btns.map(b => b.getBoundingClientRect()).map(r => Math.round(Math.min(r.width, r.height)));
    return {
      wagerBlocked: btns.map(hit).filter(x => x !== 'ok'),
      smallest: sizes.length ? Math.min(...sizes) : 0,
      submit: hit(document.querySelector('#btn-submit-answer')),
    };
  }).catch(() => null);
  if (reach) {
    note(`wager buttons ${reach.smallest}px, ${reach.wagerBlocked.length} unreachable; Submit ${reach.submit}`);
    // 44px is the floor this project already settled on for the profile card.
    if (reach.smallest && reach.smallest < 44) problems.push(`a wager button is only ${reach.smallest}px — under the 44px tap-target floor`);
    if (reach.wagerBlocked.length) problems.push(`${reach.wagerBlocked.length} wager button(s) cannot be tapped — covered by ${[...new Set(reach.wagerBlocked)].join(', ')}`);
    if (reach.submit !== 'ok') problems.push(`the Submit button cannot be tapped — ${reach.submit} is on top of it`);
  }

  await timeTap(host, 'tap a bet value', async () => {
    await host.page.locator('.wager-btn').first().click().catch(() => {});
  }, WAGER_PROBE);

  // THE BUTTON'S OWN STATE COUNTS AS FEEDBACK, and leaving it out of the probe
  // is what reported Start Game as eight round trips of nothing. Submit greys
  // itself and says "Sending…" before it touches the network; the screen does
  // not move until the write comes back, and only the first of those is what a
  // person is waiting for.
  await host.page.fill('#answer-input', 'Answer 1').catch(() => {});
  await timeTap(host, 'press Submit', async () => {
    await host.page.locator('#btn-submit-answer').click().catch(() => {});
  }, SUBMIT_PROBE);

  await bob.page.locator('.wager-btn').first().click().catch(() => {});
  await bob.page.fill('#answer-input', 'Answer 1').catch(() => {});
  await bob.page.locator('#btn-submit-answer').click().catch(() => {});
  await host.page.waitForTimeout(2500);

  for (const r of [host, bob]) {
    const n = await r.page.evaluate(() => window.__gridRebuilds ?? -1).catch(() => -1);
    note(`${r.name || 'phone'}: the wager grid was rebuilt ${n} time(s) during one question`);
    if (n > 1) problems.push(`the wager grid was rebuilt ${n} times during ONE question — every rebuild detaches the button under the player's finger, so a tap between touchstart and click is silently swallowed`);
  }

  // REVEAL RESULTS: three sequential round trips before doReveal(), with no
  // button disable and no re-entry guard.
  await timeTap(host, 'press Reveal Results',
    async () => { await host.page.locator('#btn-next-question').click().catch(() => {}); },
    SCREEN_PROBE);
  await host.page.waitForTimeout(1500);

  await timeTap(host, 'press Next / Show Scores',
    async () => { await host.page.locator('#btn-next-question').click().catch(() => {}); },
    SCREEN_PROBE);

  console.log('\n=== how long the screens take to fade ===');
  const fade = await host.page.evaluate(async () => {
    const mod = await import('/js/constants.js');
    return { fadeMs: mod.FADE_MS, transitionMs: mod.TRANSITION_MS };
  }).catch(() => null);
  if (fade) note(`screen fade ${fade.fadeMs}ms, page transition ${fade.transitionMs}ms`);

  // ============================================================
  // THE VERDICT
  //
  // A control that shows NOTHING until its network work is done is the fault;
  // the exact millisecond count is not. So the bar is expressed against the
  // injected round trip: anything that answers inside one is doing its network
  // work after it draws, which is the shape we want.
  // ============================================================
  console.log('\n=== verdict ===');
  for (const r of results) {
    if (r.ms === null) {
      problems.push(`"${r.label}" showed no visible change at all within ${BUDGET_MS}ms`);
    } else if (r.ms > LAG * 1.5) {
      problems.push(`"${r.label}" took ${r.ms}ms on a ${LAG}ms link — roughly ${(r.ms / LAG).toFixed(1)} round trips before anything moved, so it is waiting on the network before it draws`);
    }
  }
  if (!problems.length) note('every control answered inside one round trip');
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ latency scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
