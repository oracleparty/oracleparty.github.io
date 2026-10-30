// Scenario: the ways players get into a game, other than being handed a code.
//
//   1. A public game appears in the public list for a stranger.
//   2. An invite-only game does NOT appear there. (Privacy: a leak here means
//      private games are listed to everyone.)
//   3. Tapping a public game actually gets you in.
//   4. Hot join — joining a room whose game is already running lands you in
//      the game rather than the lobby, and you can still play.
//   5. A wrong room code is refused with a visible message rather than
//      silently doing nothing.
//
// Run: node tests/harness/scenario-join.mjs
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
      // Half filed under a real subcategory, so a room can be hosted on one and
      // the public list has something specific to advertise.
      subcategory: i % 2 === 0 ? 'ancient' : null,
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


/**
 * Reload, and if it hangs, SAY WHY.
 *
 * This reload has timed out at 30s roughly one run in five under load, and
 * three times in CI. Two mitigations were tried on hypotheses — persisting the
 * fake session, and waiting only for domcontentloaded — and the second CI run
 * after both failed in exactly the same place, so neither was the cause. That
 * is the point at which guessing stops being worth anything.
 *
 * So the failure now reports the state of the page instead of just the
 * exception: where it thinks it is, whether it is still there, what the app
 * logged, and whether a navigation of the app's OWN was in flight — a reload
 * racing `navigateWithFade` would look exactly like this and is invisible from
 * the outside.
 */
async function reloadAndReport(robot, label) {
  try {
    await robot.page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    return true;
  } catch (firstErr) {
    // ONE RETRY, and it is reported when it is used. The leading hypothesis is
    // a slow runner — this reproduces on a 2-core CI machine and has never
    // reproduced here, including six runs alone and a full replay of CI's
    // sequence — and a page that is merely slow should not fail a build. A page
    // that is genuinely stuck fails both attempts, so this hides nothing.
    //
    // If the retry line ever appears in a passing run, that is the evidence
    // that it IS contention rather than a fault, which is the thing two earlier
    // mitigations guessed at without establishing.
    note(`reload at ${label} timed out once, retrying — ${firstErr.message.split('\n')[0]}`);
    try {
      // WAIT FOR THE RELOAD ALREADY UNDER WAY BEFORE STARTING ANOTHER. CI on
      // 2026-10-29 showed the first one was slow, not stuck: it finished while
      // the second reload was going out, aborted it (ERR_ABORTED, "frame was
      // detached"), and every check after it passed on the reloaded page.
      const settled = await robot.page.waitForFunction(
        () => document.readyState !== 'loading' && !!document.querySelector('.screen'),
        null, { timeout: 30000 }).then(() => true).catch(() => false);
      if (!settled) await robot.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      note(`retry succeeded at ${label} — the page was slow, not stuck${settled ? ' (the first reload finished on its own)' : ''}`);
      return true;
    } catch (err) {
      const diag = await robot.page.evaluate(() => ({
      url: location.href,
      ready: document.readyState,
      screen: document.querySelector('.screen.active')?.id || '(none)',
      leaving: !!document.body?.style?.opacity && document.body.style.opacity !== '1',
    })).catch(e => ({ unreachable: String(e).slice(0, 90) }));
    note(`RELOAD FAILED TWICE at ${label}: ${err.message.split('\n')[0]}`);
    note(`   page state: ${JSON.stringify(diag)}`);
    note(`   console errors: ${JSON.stringify((robot.consoleErrors || []).slice(0, 3))}`);
    problems.push(`the page could not be reloaded at ${label}, twice — ${err.message.split('\n')[0]}`);
    return false;
    }
  }
}

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);

  async function seat(name) {
    const r = await table.seat(name);
    await r.page.addInitScript(n =>
      localStorage.setItem('oracle_party_display_name', n), name);
    return r;
  }

  /** Host a room with a given visibility, returning its code. */
  async function hostRoom(robot, whoCanJoin, subcategory = null) {
    await robot.goto('host.html');
    await robot.page.waitForSelector('.category-card', { timeout: 20000 });
    await robot.page.click(`.category-card[data-category="${CATEGORY}"]`);
    await robot.page.waitForTimeout(800);
    // A specific subcategory when asked for one — the public games list renders
    // resolveCategoryLabel(category, subcategory), and until fetchPublicRooms
    // started selecting that column every public game advertised itself by
    // category alone. Hosting on "All" could never have shown it.
    if (subcategory) {
      const pick = robot.page.locator(`[data-subcategory="${subcategory}"]`).first();
      if (await pick.isVisible().catch(() => false)) await pick.click().catch(() => {});
      else await robot.page.click('text=/^All /');
    } else {
      await robot.page.click('text=/^All /');
    }
    await robot.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
    await robot.page.click('[data-setting="questionsPerGame"] [data-value="5"]').catch(() => {});
    // Visibility is a labelled toggle group rather than an id.
    const label = whoCanJoin === 'anyone' ? 'Anyone' : 'Invite Only';
    await robot.page.locator(`button:has-text("${label}")`).first().click().catch(() => {});
    await robot.page.waitForTimeout(400);
    await robot.page.click('#btn-host-game');
    await robot.page.waitForURL('**/lobby.html*', { timeout: 20000 });
    await robot.page.waitForTimeout(1200);
    return robot.textOf('#lobby-code');
  }

  // ---- one public room, one private room ----
  const publicHost = await seat('Alice');
  const publicCode = await hostRoom(publicHost, 'anyone', 'ancient');
  const privateHost = await seat('Dave');
  const privateCode = await hostRoom(privateHost, 'invite');

  const rooms = table.store.table('rooms');
  note(`rooms: ${rooms.map(r => `${r.code}=${r.who_can_join}`).join(', ')}`);

  const publicRoom = rooms.find(r => r.code === publicCode);
  const privateRoom = rooms.find(r => r.code === privateCode);
  if (publicRoom?.who_can_join !== 'anyone') {
    problems.push(`the "Anyone" setting stored who_can_join="${publicRoom?.who_can_join}"`);
  }
  if (privateRoom?.who_can_join === 'anyone') {
    problems.push('an invite-only room was stored as public');
  }

  // A room code is six digits and public games are listed, so anybody can walk
  // into this room — and until now they arrived to the whole transcript of what
  // was said before they got there. One old message and one recent one, because
  // the cut-off is deliberately biased early (CHAT_HISTORY_GRACE_MS): a message
  // from a minute ago is MEANT to survive, and a test that only seeds old ones
  // would pass just as happily with the whole feature reverted to "hide
  // everything".
  const BACKLOG = 'said this long before Erin turned up';
  const RECENT = 'said this just now';
  table.store.seed('chat_messages', [
    { id: 'chat-old', room_id: publicRoom.id, player_name: 'Alice', message: BACKLOG,
      hearts: [], created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() },
    { id: 'chat-new', room_id: publicRoom.id, player_name: 'Alice', message: RECENT,
      hearts: [], created_at: new Date().toISOString() },
  ]);

  // ============================================================
  // 1 + 2. PUBLIC LISTING, AND PRIVACY
  // ============================================================
  heading('public games list');

  // A HOST WITH A RECORD, so the list has a reputation to show. This is the
  // surface the whole host-review feature exists for — read BEFORE you tap a
  // stranger's room — and it had no coverage at all until now.
  const PUBLIC_HOST_USER = '00000000-0000-4000-8000-0000publichost';
  {
    const publicRoomRow = table.store.table('rooms').find(r => r.code === publicCode);
    const hostRow = table.store.table('players')
      .find(p => String(p.room_id) === String(publicRoomRow?.id) && p.is_host);
    if (hostRow) hostRow.user_id = PUBLIC_HOST_USER;
    // Seeded through op_rate_host's own output shape rather than by hand, so
    // the percentage on screen has to come from the same arithmetic the view
    // does — seeding host_reputation directly would let this pass for a board
    // the ratings do not support.
    table.store.seed('host_ratings', [
      { id: 'jr1', host_user_id: PUBLIC_HOST_USER, room_id: 'old-1', voter_id: 'device:1', rating: 1 },
      { id: 'jr2', host_user_id: PUBLIC_HOST_USER, room_id: 'old-2', voter_id: 'device:2', rating: 1 },
      { id: 'jr3', host_user_id: PUBLIC_HOST_USER, room_id: 'old-3', voter_id: 'device:3', rating: 1 },
      { id: 'jr4', host_user_id: PUBLIC_HOST_USER, room_id: 'old-4', voter_id: 'device:4', rating: -1 },
    ]);
    table.store._recomputeHostReputation();
  }

  const stranger = await seat('Erin');
  await stranger.goto('join.html');
  await stranger.page.waitForSelector('#code-input', { timeout: 15000 });
  await stranger.page.waitForTimeout(3000);

  const listed = await stranger.page.evaluate(() =>
    [...document.querySelectorAll('#public-games .public-game-row')]
      .map(el => el.textContent.replace(/\s+/g, ' ').trim())).catch(() => []);
  note(`stranger sees ${listed.length} public game(s)`);
  for (const l of listed) note(`   ${l.slice(0, 80)}`);

  const showsPublic = listed.some(t => t.includes(publicCode));
  const showsPrivate = listed.some(t => t.includes(privateCode));
  if (!showsPublic) problems.push('a public game did not appear in the public games list');
  if (showsPrivate) problems.push('AN INVITE-ONLY GAME WAS LISTED PUBLICLY — private rooms are exposed');

  // The room was hosted on a SUBCATEGORY, and the listing must say so. The row
  // renders resolveCategoryLabel(category, subcategory), and fetchPublicRooms
  // did not select that column — so every public game advertised itself by
  // category alone and somebody browsing could not see what they were joining.
  // Only checked when the room really was stored with one, so a change to the
  // host UI shows up as a skip rather than as a false accusation.
  const publicRow = listed.find(t => t.includes(publicCode)) || '';
  if (publicRoom?.subcategory) {
    note(`public room is filed under "${publicRoom.subcategory}"; row reads: ${publicRow.slice(0, 70)}`);
    if (!/ancient/i.test(publicRow)) {
      problems.push(`the public games list advertises the category only — "${publicRow.slice(0, 70)}" never mentions the subcategory the room is actually on`);
    }
  } else {
    note('public room stored no subcategory — subcategory labelling not exercised');
  }

  // THE HOST'S STANDING, on the row, before anybody taps it. Three up and one
  // down is 75% of 4 — and the SAMPLE must be printed beside it, because "75%"
  // from four ratings and from four hundred are different claims.
  //
  // "ratings", not "games": a rating is keyed on the ROOM, and a room survives
  // Play Again, so six rounds with one group is one rating each. Calling it
  // games would describe a different measurement from the one shown.
  if (publicRow) {
    note(`public row reputation: ${publicRow.slice(0, 90)}`);
    if (!/75%/.test(publicRow)) {
      problems.push(`the public games list does not show the host's rating — "${publicRow.slice(0, 80)}"`);
    }
    if (!/4 ratings/.test(publicRow)) {
      problems.push('the host rating is shown without its sample size, so a percentage from four ratings looks like one from four hundred');
    }
    if (/\d+ games/.test(publicRow)) {
      problems.push('the host standing is labelled "games" — it counts rooms, and a room survives Play Again, so six rounds with one group is one rating');
    }
  }

  // ============================================================
  // 3. JOINING FROM THE LIST
  // ============================================================
  heading('joining from the public list');
  if (!showsPublic) {
    note('skipped — nothing public to tap');
  } else {
    const row = stranger.page.locator('#public-games .public-game-row').first();
    await row.click().catch(() => {});
    const arrived = await stranger.page.waitForURL('**/lobby.html*', { timeout: 20000 })
      .then(() => true).catch(() => false);
    note(`stranger reached the lobby by tapping the listing: ${arrived}`);
    if (!arrived) {
      problems.push(`tapping a public game did not join it (still on ${stranger.page.url().split('/').pop()})`);
    } else {
      await publicHost.page.waitForTimeout(2500);
      const hostSees = await publicHost.page.evaluate(() =>
        document.body.innerText.includes('Erin')).catch(() => false);
      note(`host sees the new player: ${hostSees}`);
      if (!hostSees) problems.push('a player who joined from the public list is invisible to the host');

      // ---- what a newcomer may read -------------------------------------
      heading('chat said before you arrived');
      const readChat = r => r.page.evaluate(() =>
        document.querySelector('#chat-drawer-messages')?.textContent || '').catch(() => '');

      let erinChat = await readChat(stranger);
      note(`Erin's chat mentions the backlog: ${erinChat.includes(BACKLOG)}`);
      note(`Erin's chat mentions the recent one: ${erinChat.includes(RECENT)}`);
      if (erinChat.includes(BACKLOG)) {
        problems.push('somebody who walked in off the public list can read chat from before they arrived');
      }
      if (!erinChat.includes(RECENT)) {
        problems.push('the cut-off swallowed a message from moments before joining — it is meant to be biased early');
      }

      // A refresh must not wipe what she is entitled to. The obvious reading of
      // "fresh on entry" is per page load, and that would lose the whole
      // conversation every time somebody's phone reloaded.
      // waitUntil: 'domcontentloaded', NOT the default 'load'.
      //
      // This reload timed out after 30s about one run in five under load, and
      // once in CI. What the check needs is the app re-initialised, which the
      // wait below covers separately; waiting for 'load' additionally waits for
      // every subresource, and the lobby fires a keepalive disconnect beacon on
      // unload which Playwright intercepts and which can outlive the page.
      //
      // BE HONEST ABOUT WHAT IS ESTABLISHED: that mechanism fits the symptom —
      // intermittent, load-dependent, on reload only — but it is not proven.
      // What IS certain is that this check never needed 'load', so the
      // dependency was accidental. The assertions below are untouched and still
      // fail if the chat cut-off breaks.
      await reloadAndReport(stranger, 'the chat-cutoff refresh');
      await stranger.page.waitForTimeout(3500);
      erinChat = await readChat(stranger);
      note(`after a refresh, recent still there: ${erinChat.includes(RECENT)}, backlog still hidden: ${!erinChat.includes(BACKLOG)}`);
      if (!erinChat.includes(RECENT)) {
        problems.push('refreshing wiped the chat this player had already been shown');
      }
      if (erinChat.includes(BACKLOG)) {
        problems.push('refreshing handed this player the backlog they were not shown on arrival');
      }

      // The cut-off is set ONCE and never moved forward, and this is the case
      // that proves it rather than assuming it. A rejoin deletes the player row
      // and writes a new one, stamped later — so anything that recomputed the
      // cut-off from joined_at would silently hide the conversation she had
      // just been part of. Moving the stamp forward is exactly what a rejoin
      // does, and it is the only way to make the two behaviours differ inside
      // a test that runs in seconds while the rule is written in minutes.
      const DURING = 'said this while Erin was sitting right there';
      table.store.seed('chat_messages', [
        { id: 'chat-during', room_id: publicRoom.id, player_name: 'Alice',
          message: DURING, hearts: [], created_at: new Date().toISOString() },
      ]);
      const erinRow = table.store.table('players').find(p => p.display_name === 'Erin');
      if (erinRow) erinRow.joined_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      await reloadAndReport(stranger, 'the restamped-seat refresh');
      await stranger.page.waitForTimeout(3500);
      erinChat = await readChat(stranger);
      note(`after a rejoin restamped her seat, she still sees what was said while she was here: ${erinChat.includes(DURING)}`);
      if (!erinChat.includes(DURING)) {
        problems.push('rejoining moved the chat cut-off forward and hid the conversation this player was part of');
      }
    }
  }

  // ============================================================
  // 4. HOT JOIN — a game already in progress
  // ============================================================
  heading('joining a game already in progress');
  await publicHost.page.waitForSelector('#btn-start-game', { state: 'visible', timeout: 20000 }).catch(() => {});
  for (let i = 0; i < 12; i++) {
    await clickIfReady(publicHost, '#btn-start-game');
    await publicHost.page.waitForTimeout(700);
    if (table.store.table('rooms').find(r => r.code === publicCode)?.status === 'playing') break;
  }
  await publicHost.page.waitForURL('**/game.html*', { timeout: 25000 }).catch(() => {});
  await publicHost.page.waitForTimeout(6500);
  note(`game running: room status=${table.store.table('rooms').find(r => r.code === publicCode)?.status}`);

  const latecomer = await seat('Frank');
  await latecomer.goto('join.html');
  await latecomer.page.waitForSelector('#code-input', { timeout: 15000 });
  await latecomer.page.fill('#code-input', publicCode);
  await latecomer.page.click('#btn-join');
  await latecomer.page.waitForTimeout(9000);

  const where = latecomer.page.url().split('/').pop();
  note(`latecomer landed on ${where} / ${await activeScreen(latecomer)}`);
  if (where !== 'game.html') {
    problems.push(`joining a running game landed on ${where} instead of the game`);
  } else {
    const stuck = await activeScreen(latecomer);
    if (stuck === 'game-loading' || stuck === '(none)') {
      problems.push(`a player joining mid-game is stuck on "${stuck}"`);
    }
    const inRoom = table.store.table('players').some(p => p.display_name === 'Frank');
    if (!inRoom) problems.push('a player who joined mid-game was never added to the room');
  }

  // ============================================================
  // 5. A WRONG CODE IS REFUSED VISIBLY
  // ============================================================
  heading('wrong room code');
  const lost = await seat('Gina');
  await lost.goto('join.html');
  await lost.page.waitForSelector('#code-input', { timeout: 15000 });
  await lost.page.fill('#code-input', 'ZZZZ');
  await lost.page.click('#btn-join');
  await lost.page.waitForTimeout(3000);

  const stillOnJoin = lost.page.url().includes('join.html');
  const errorText = await lost.page.evaluate(() =>
    (document.querySelector('#join-error')?.textContent || '').trim()).catch(() => '');
  note(`stayed on join page: ${stillOnJoin}, error shown: "${errorText}"`);
  if (!stillOnJoin) problems.push('a wrong room code navigated away instead of being refused');
  if (!errorText) problems.push('a wrong room code produced no visible error — it just looks broken');

  // ============================================================
  // THE NAME PROMPT'S WAY INTO AN ACCOUNT (asked for 2026-10-23: "also the
  // option to sign in or create an account, in case they don't want to be
  // guest"). The test client refuses every real sign-in and sign-up, which is
  // exactly what is wanted here: the paths worth checking are the ones that
  // come BACK to the prompt, because the sign-up box asks for a missing name by
  // calling the prompt itself — and a prompt whose Continue then belongs to
  // somebody else's promise is a page that never finishes loading.
  // ============================================================
  heading('the name prompt offers an account');
  const nameless = await table.seat('Nameless');   // no stored name, on purpose
  await nameless.goto('join.html');
  const promptUp = () => nameless.page.evaluate(() =>
    document.getElementById('display-name-modal')?.classList.contains('active'));
  await nameless.page.waitForFunction(() =>
    document.getElementById('display-name-modal')?.classList.contains('active'), null, { timeout: 15000 })
    .catch(() => problems.push('a visitor with no name was not asked for one'));
  const linksShown = await nameless.page.evaluate(() =>
    ['display-name-signin', 'display-name-signup'].every(id => {
      const el = document.getElementById(id);
      return el && el.offsetParent !== null;
    }));
  if (!linksShown) problems.push('the name prompt does not offer Sign in and Create an account');

  // Create an account with no name typed: asked for one, nothing opens.
  await nameless.page.click('#display-name-signup');
  await nameless.page.waitForTimeout(300);
  const askedForName = await nameless.page.evaluate(() =>
    (document.getElementById('display-name-error')?.textContent || '').trim());
  const signupOpenedEarly = await nameless.page.evaluate(() =>
    !!document.getElementById('signup-modal')?.classList.contains('active'));
  note(`Create an account with no name: "${askedForName}"`);
  if (!askedForName) problems.push('Create an account with an empty name box said nothing');
  if (signupOpenedEarly) problems.push('Create an account opened without a name to create it under');

  // The deep road back: Sign in -> Create one -> submit with no name stored, so
  // the sign-up box opens the name prompt for itself; the sign-up then fails
  // and is dismissed. This prompt must come back WORKING.
  await nameless.page.click('#display-name-signin');
  await nameless.page.waitForSelector('#signin-modal.active', { timeout: 5000 })
    .catch(() => problems.push('Sign in on the name prompt opened nothing'));
  await nameless.page.click('#signin-create-link');
  await nameless.page.waitForSelector('#signup-modal.active', { timeout: 5000 })
    .catch(() => problems.push('Create one on the sign-in box opened nothing'));
  await nameless.page.fill('#signup-email', 'nameless@example.com');
  await nameless.page.fill('#signup-password', 'secret123');
  await nameless.page.fill('#signup-confirm', 'secret123');
  await nameless.page.click('#signup-submit');
  await nameless.page.waitForFunction(() =>
    document.getElementById('display-name-modal')?.classList.contains('active'), null, { timeout: 5000 })
    .catch(() => problems.push('the sign-up box did not ask for the missing name'));
  await nameless.page.fill('#display-name-input', 'Nameless');
  await nameless.page.click('#display-name-submit');
  await nameless.page.waitForFunction(() =>
    (document.getElementById('signup-error')?.textContent || '').trim().length > 0, null, { timeout: 5000 })
    .catch(() => {});
  await nameless.page.click('#signup-dismiss');
  await nameless.page.waitForTimeout(400);
  if (!await promptUp()) problems.push('after a dismissed sign-up the name prompt did not come back');
  await nameless.page.click('#display-name-submit');
  // join.js attaches its listeners only once the name prompt has RESOLVED, and
  // one of them turns whatever is typed into the room code into capitals. So
  // "ab1" reading "AB" is the page having started — and "ab1" is it waiting on
  // a prompt that has already closed. (The public list cannot say this: it
  // holds its hidden empty-state from the start, so it is never empty.)
  await nameless.page.waitForTimeout(800);
  await nameless.page.fill('#code-input', 'ab1').catch(() => {});
  const typed = await nameless.page.inputValue('#code-input').catch(() => '');
  const pageStarted = typed === 'AB';
  note(`after the round trip, Continue started the page: ${pageStarted} (code box read "${typed}")`);
  if (!pageStarted) problems.push('after a side trip into an account, Continue closed the name prompt but the join page never started — Continue belonged to another promise');

  heading('the category page draws before the bank answers');
  {
    // Reported from a real phone 2026-10-26: grey boxes for a long time on
    // Choose Category. The cards waited for a read of every question in the
    // bank AND for sign-in, and a cache older than 30 minutes was thrown away.
    // One slow phone, no copy at all, a lag the reads cannot beat: the twelve
    // subjects must be there, and tappable, well inside one round trip.
    const LAG = 3000;
    const browser = await table.seat('Browsing');
    await browser.page.addInitScript(() => localStorage.setItem('oracle_party_display_name', 'Browsing'));
    await browser.goto('index.html');
    await browser.page.evaluate(() => localStorage.removeItem('op_categories'));
    browser.slowConnection(LAG);
    const t0 = Date.now();
    const nav = browser.goto('host.html').catch(() => {});
    let drawnAt = null;
    while (Date.now() - t0 < LAG * 3) {
      const n = await browser.page.evaluate(() => document.querySelectorAll('.category-card').length).catch(() => 0);
      if (n >= 12) { drawnAt = Date.now() - t0; break; }
      await new Promise(r => setTimeout(r, 25));
    }
    note(`twelve subject cards drawn after ${drawnAt ?? 'never'}ms on a ${LAG}ms link`);
    if (drawnAt === null || drawnAt > LAG * 0.8) {
      problems.push(`Choose Category showed no subjects for ${drawnAt ?? 'over ' + LAG * 3}ms on a ${LAG}ms link — the cards are waiting on the network`);
    } else {
      await browser.page.evaluate(() => document.querySelector('.category-card[data-category="science"]')?.click());
      await new Promise(r => setTimeout(r, 300));
      const opened = await browser.page.evaluate(() => document.querySelector('#subcategory-view')?.style.display !== 'none');
      if (!opened) problems.push('a subject card tapped while the page was still loading did nothing');
      const claims = await browser.page.evaluate(() => [...document.querySelectorAll('.category-card__count, .category-card__plays')]
        .map(e => e.textContent).filter(t => /null|undefined|NaN|\b0 plays/.test(t)));
      if (claims.length) problems.push(`before the counts arrived the cards claimed: ${claims.slice(0, 3).join(', ')}`);
    }
    await nav;
    browser.slowConnection(0);
  }

  heading('play counts reach a signed-in player even when other reads are slow');
  {
    // Reported 2026-10-30: "blank on every card", from a signed-in owner. The
    // counts were applied only after sign-in, the bank AND that player's
    // mastery had all answered, and a failed read left them blank all visit.
    // Seed a play, hang mastery for far longer than the check, fail the first
    // count read: the real number must still arrive, and a topic nobody has
    // played must read "0 plays" rather than nothing.
    table.store.seed('game_plays', [{ room_id: 'r-x', player_id: 'p-x', category: CATEGORY, subcategory: 'ancient', games_played: 3, completed: true }]);
    table.store.slowFunction('get_mastery_counts', 60000);
    table.store.failFunction('get_category_play_counts');
    setTimeout(() => table.store.unfailFunction('get_category_play_counts'), 1000);
    const counter = await table.seatSignedIn('Counter');
    await counter.goto('host.html').catch(() => {});
    const t0 = Date.now();
    let shown = null;
    // Earlier sections played games here too, so the seeded 3 is a floor.
    const playsAtLeast3 = t => Number((t || '').replace(/,/g, '').match(/(\d+) plays?/)?.[1] ?? -1) >= 3;
    while (Date.now() - t0 < 15000) {
      shown = await counter.page.evaluate(c =>
        document.querySelector(`.category-card[data-category="${c}"] .category-card__plays`)?.textContent, CATEGORY).catch(() => null);
      if (playsAtLeast3(shown)) break;
      await new Promise(r => setTimeout(r, 100));
    }
    note(`subject card reads "${shown}" after ${Date.now() - t0}ms (mastery hung, first count read failed)`);
    if (shown == null) note(`page: ${await counter.page.evaluate(() => location.href + ' cards=' + document.querySelectorAll('.category-card').length).catch(e => e.message)}; errors: ${counter.consoleErrors.slice(0, 3).join(' | ')}`);
    if (!playsAtLeast3(shown)) problems.push(`a signed-in player with a slow mastery read and one failed count read saw "${shown}" instead of the seeded plays — the counter waits on other reads, or never retries`);
    await counter.page.evaluate(c => document.querySelector(`.category-card[data-category="${c}"]`)?.click(), CATEGORY);
    await new Promise(r => setTimeout(r, 300));
    const rows = await counter.page.evaluate(() => [...document.querySelectorAll('#subcategory-view .subcategory-row')]
      .map(r => r.querySelector('.subcategory-row__plays')?.textContent || ''));
    const blank = rows.filter(t => !/\d+ plays?/.test(t)).length;
    note(`topics: ${rows.length} rows, ${blank} without a count`);
    if (!rows.length || blank) problems.push(`${blank} of ${rows.length} topic rows showed no play count — an unplayed topic must read 0 plays`);
    const cached = await counter.page.evaluate(() => localStorage.getItem('op_play_counts'));
    if (!cached) problems.push('the play counts were not remembered on the phone, so the next visit starts without them');
    table.store.normalFunction('get_mastery_counts');
  }

  for (const r of [publicHost, privateHost, stranger, latecomer, lost, nameless]) {
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e)
      // The test client refuses every sign-up; the name-prompt section above
      // makes one fail on purpose to walk the road back.
      && !(r === nameless && /signUp failed .*not supported in tests/.test(e)));
    if (real.length) problems.push(`${r.name}: ${real.length} console error(s) — first: ${real[0].slice(0, 140)}`);
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ join scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
