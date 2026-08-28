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
      await stranger.page.reload({ waitUntil: 'domcontentloaded' });
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

      await stranger.page.reload({ waitUntil: 'domcontentloaded' });
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

  for (const r of [publicHost, privateHost, stranger, latecomer, lost]) {
    const real = r.consoleErrors.filter(e =>
      !/favicon|net::ERR_|manifest|icon-\d+\.png|\.mp3/i.test(e));
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
