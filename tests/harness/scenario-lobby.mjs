// Scenario: a host creates a room and two players join.
// Run: node tests/harness/scenario-lobby.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';

function seedQuestions(store, n = 40) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`,
      question_text: `Test question ${i}?`,
      correct_answer: `Answer ${i}`,
      acceptable_answers: [`Ans ${i}`],
      // Real schema: questions.categories is text[], not a single category.
      categories: [CATEGORY],
      subcategory: null,
      difficulty: 'medium',
      format: 'open',
      fun_fact: '',
    });
  }
  store.seed('questions', rows);
}

const table = await PlaytestTable.open();
const problems = [];

try {
  seedQuestions(table.store);

  // --- Host creates the room ---
  const host = await table.seat('Alice');
  await host.page.addInitScript(() =>
    localStorage.setItem('oracle_party_display_name', 'Alice'));
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 15000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  // Picking a category opens a subcategory sheet; "All <Category>" plays the
  // whole category.
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /', { timeout: 15000 });
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1500);

  const code = (await host.textOf('#lobby-code')) || (await host.page.evaluate(() => {
    const el = document.querySelector('[id*="code"]');
    return el ? el.textContent.trim() : null;
  }));
  console.log('room code:', code);
  if (!code || !/^[A-Z0-9]{4,6}$/.test(code)) problems.push(`host never got a valid room code (saw: ${code})`);

  // --- Two players join ---
  const joiners = [];
  for (const name of ['Bob', 'Carol']) {
    const r = await table.seat(name);
    await r.page.addInitScript(n =>
      localStorage.setItem('oracle_party_display_name', n), name);
    await r.goto('join.html');
    await r.page.waitForSelector('#code-input', { timeout: 15000 });
    await r.page.fill('#code-input', code);
    await r.page.click('#btn-join');
    await r.page.waitForURL('**/lobby.html*', { timeout: 20000 });
    joiners.push(r);
  }

  await host.page.waitForTimeout(2500);

  // --- Everyone should see all three ---
  for (const r of [host, ...joiners]) {
    const names = await r.page.evaluate(() =>
      [...document.querySelectorAll('.player-row__name, .player-item__name, [class*="player"] [class*="name"]')]
        .map(el => el.textContent.trim()).filter(Boolean));
    const unique = [...new Set(names)];
    console.log(`${r.name} sees:`, unique);
    for (const expected of ['Alice', 'Bob', 'Carol']) {
      if (!unique.some(n => n.includes(expected))) {
        problems.push(`${r.name} does not see ${expected} in the lobby`);
      }
    }
  }

  // --- Exactly one host ---
  const hostRows = table.store.table('players').filter(p => p.is_host);
  console.log('players in store:', table.store.table('players').map(p => `${p.display_name}${p.is_host ? ' (host)' : ''}`));
  if (hostRows.length !== 1) problems.push(`expected exactly 1 host, found ${hostRows.length}`);

  // ============================================================
  // BACKGROUNDING THE APP AND COMING BACK
  //
  // Reported from a playtest: a player switched to YouTube, came back, and
  // stayed greyed out — and saw everyone ELSE greyed out too. That symmetry is
  // the tell. A one-way state error greys one person for the room; both sides
  // seeing each other away is a dead socket on one side.
  //
  // Mobile browsers suspend a backgrounded WebSocket. The app re-announced
  // presence on return and every 15s after, but every one of those calls was
  // wrapped in `.catch(() => {})`, so on a dead channel all of them failed
  // silently and nothing ever checked or rebuilt.
  //
  // Faked exactly: hide the page, kill the channel the way a suspended socket
  // does, then come back.
  // ============================================================
  console.log('\n=== backgrounding and returning ===');
  const bob = joiners[0];

  const setHidden = (robot, hidden) => robot.page.evaluate(h => {
    Object.defineProperty(document, 'hidden', { value: h, configurable: true });
    Object.defineProperty(document, 'visibilityState', { value: h ? 'hidden' : 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

  const awayNamesOn = robot => robot.page.evaluate(() =>
    [...document.querySelectorAll('.player-item--away .player-item__name')]
      .map(el => el.textContent.trim()));

  await setHidden(bob, true);
  await host.page.waitForTimeout(1500);
  console.log('   · while Bob is backgrounded, Alice sees away:', await awayNamesOn(host));

  // The socket dies while the page is hidden. This is the step that makes the
  // return path fail, and without it the scenario proves nothing.
  const killed = await bob.page.evaluate(() => window.__killChannel('presence'));
  console.log(`   · killed ${killed} presence channel(s) on Bob's device`);
  if (killed === 0) problems.push('the harness could not kill a presence channel, so this test proves nothing');
  await host.page.waitForTimeout(1200);

  await setHidden(bob, false);
  await bob.page.waitForTimeout(2500);
  await host.page.waitForTimeout(1500);

  const awayForAlice = await awayNamesOn(host);
  const awayForBob = await awayNamesOn(bob);
  console.log('   · after Bob returns, Alice sees away:', awayForAlice);
  console.log('   · after Bob returns, Bob sees away:  ', awayForBob);

  if (awayForAlice.some(n => n.includes('Bob'))) {
    problems.push('Bob is still greyed out to the room after coming back — the presence channel died while backgrounded and was never rebuilt');
  }
  if (awayForBob.some(n => n.includes('Alice'))) {
    problems.push('Bob still sees Alice greyed out after coming back — his own channel is dead, so the whole room reads as away to him');
  }

  // AWAY WAITS, AND THEN IT ARRIVES. Both halves, because either alone is a
  // check that cannot fail.
  //
  // Presence flips the instant a phone backgrounds, so the room was told
  // somebody was AFK for what is usually a two-second glance at a notification
  // — the owner's report: it "seems like someone is afk so often".
  // AWAY_GRACE_MS makes the LABEL wait ten seconds. Nothing that acts on
  // absence waits: deputising and the stale sweep both read last_seen_at.
  //
  // Checking only that it is quiet early would pass with the away label deleted
  // outright; checking only that it arrives would pass with the grace removed.
  // The pair is the rule.
  const awayBadgesOn = () => host.page.evaluate(() =>
    [...document.querySelectorAll('.player-item--away .badge')].map(b => b.textContent.trim()));

  await setHidden(bob, true);
  await host.page.waitForTimeout(2500);          // well inside AWAY_GRACE_MS
  const badgesEarly = await awayBadgesOn();
  console.log('   · 2.5s after backgrounding, badges on an away row:', badgesEarly);
  if (badgesEarly.some(b => /away/i.test(b))) {
    problems.push('a player was shown as Away 2.5s after backgrounding — a glance at a notification greys somebody out in front of the whole room (AWAY_GRACE_MS)');
  }

  await host.page.waitForTimeout(9500);          // now past it
  const badgesLate = await awayBadgesOn();
  console.log('   · 12s after backgrounding, badges on an away row:', badgesLate);
  if (!badgesLate.some(b => /away/i.test(b))) {
    problems.push('an away player never carries an "Away" label at all, so the fade is the only signal and cannot be told from gone, disabled or loading');
  }
  await setHidden(bob, false);
  await host.page.waitForTimeout(1200);

  // ============================================================
  // A GUEST HAS AN IDENTITY NOW, AND IS STILL A GUEST
  // ============================================================
  //
  // Guests get an INVISIBLE ACCOUNT: a real auth user id, with no email, no
  // password and no sign-up screen. It exists so the database can tell one
  // guest from another, which is the thing that has always made `players` and
  // `rooms` impossible to lock down — "remove me" and "remove them" are the
  // same request from somebody who cannot prove who they are.
  //
  // THE DANGER IS THE OTHER DIRECTION, and it is what this checks. Around
  // thirty places in the app ask "do they have a user id?" and mean "are they a
  // real member" — whether to record stats, shape question selection, offer
  // friends, show a tier badge, list them as an account. Hand guests an id and
  // every one of those switches on silently, with every test still passing.
  // That is exactly the damage migration 049 did by closing one door without
  // enumerating what walked through it.
  //
  // So the identity is checked as PRESENT, and everything downstream of it as
  // UNCHANGED. A check for only the first would go green on the version that
  // quietly turns a guest into a member.
  console.log('\n=== a guest has an identity, and is still a guest ===');
  const guestAuth = await host.page.evaluate(async () => {
    const m = await import('/js/auth.js');
    const s = window.__fakeSession;
    return {
      hasSession: !!s?.user?.id,
      isAnonymous: s?.user?.is_anonymous === true,
      authUserId: m.getAuthUserId ? m.getAuthUserId() : '(no such function)',
      currentUser: m.getCurrentUser ? m.getCurrentUser() : '(no such function)',
      anonFlag: m.isAnonymousSession ? m.isAnonymousSession() : '(no such function)',
    };
  }).catch(e => ({ err: String(e).slice(0, 140) }));
  console.log('   · guest auth:', JSON.stringify(guestAuth));

  if (!guestAuth.hasSession || !guestAuth.isAnonymous) {
    problems.push('a guest got no invisible account — the database still cannot tell one guest from another, so players and rooms can never be locked');
  }
  if (!guestAuth.authUserId || guestAuth.authUserId === '(no such function)') {
    problems.push('getAuthUserId() gave nothing for a guest holding an invisible account');
  }
  // THE ONE THAT GUARDS EVERYTHING ELSE. getCurrentUser() is what the app reads
  // to mean "real member"; an invisible account must never come back through it.
  if (guestAuth.currentUser !== null) {
    problems.push(`getCurrentUser() returned an account for a GUEST (${JSON.stringify(guestAuth.currentUser)}) — every stats, friends, title and tier branch in the app has just switched on for people who never signed up`);
  }
  if (guestAuth.anonFlag !== true) {
    problems.push('isAnonymousSession() does not report an invisible account as one');
  }

  // Structural proof rather than a claim: if anything had started treating the
  // invisible id as a real one, it would be written onto the seat and into a
  // profile. Both must still be empty for a guest.
  const guestRows = {
    playersWithUserId: table.store.table('players').filter(p => p.user_id).length,
    players: table.store.table('players').length,
    profiles: table.store.table('profiles').length,
    history: table.store.table('question_history').length,
  };
  console.log('   · guest rows:', JSON.stringify(guestRows));
  // THE SEAT NOW CARRIES THE ID (Slice 8b), and that is the point: it makes
  // claimSeat exact for a guest instead of guessing from a display name, lets
  // their play be remembered, and is what `players` needs before it can ever be
  // locked down. Every seat must have one — a lobby where only some do means
  // the invisible account is failing for somebody.
  if (guestAuth.hasSession && guestRows.playersWithUserId !== guestRows.players) {
    problems.push(`only ${guestRows.playersWithUserId} of ${guestRows.players} guest seats carry an id — claimSeat is back to guessing who somebody is from their display name`);
  }
  // AND THE THING THAT MUST NOT FOLLOW FROM IT. A profile row is what makes
  // somebody a real member; an id is not. If signing up stops being what
  // creates a profile, every account-only feature has just opened to guests.
  if (guestRows.profiles > 0) {
    problems.push(`${guestRows.profiles} profile row(s) exist in a lobby of guests — signing up has stopped meaning anything`);
  }

  // TAPPING A GUEST MUST NOT OFFER "ADD FRIEND". The profile card used to
  // branch on "has a user id", which meant "real member" only because nobody
  // else had one. A guest has an id now, so branching on it would offer a
  // friend request to an account with no profile page — accepted by the
  // database, never seen by anybody, pending forever.
  const guestCard = await host.page.evaluate(async () => {
    const row = document.querySelector('[data-profile-user-id]');
    if (!row) return { tappable: false };
    row.click();
    await new Promise(r => setTimeout(r, 1500));
    const sheet = document.querySelector('#profile-card-sheet');
    return {
      tappable: true,
      open: !!sheet && sheet.classList.contains('active'),
      text: (sheet?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
      addFriend: !!document.querySelector('#profile-card-add-friend'),
    };
  }).catch(e => ({ err: String(e).slice(0, 120) }));
  console.log('   · tapping a guest:', JSON.stringify(guestCard));

  if (guestCard.tappable && guestCard.addFriend) {
    problems.push('tapping a GUEST offers "Add Friend" — the request would go to an account with no profile page and sit pending forever');
  }
  if (guestCard.tappable && guestCard.open && !/guest/i.test(guestCard.text || '')) {
    problems.push(`tapping a guest showed a real-member card instead of "Guest player": ${JSON.stringify(guestCard.text)}`);
  }

  // ============================================================
  // A GUEST'S LOBBY ROW SAYS "GUEST"
  // ============================================================
  //
  // The owner's call, and the honest word rather than the flattering one:
  // "Novice" is the bottom rung of a rank ladder a guest is not on. A guest has
  // no profile row, so no stats, no titles, and nothing anybody can add as a
  // friend. The profile card a tap away has said "Guest player" since it was
  // written; this row was the one place staying quiet.
  //
  // BOTH HALVES, because either alone is a check that cannot fail. That the
  // word is THERE, and that nothing else on the row went with it — a version
  // that stamped "Guest" over everybody's real title would pass the first half
  // perfectly. The mock cannot answer this: it builds its own row HTML, so only
  // a real lobby of real guests renders what _renderPlayerItem actually emits.
  const guestRow = await host.page.evaluate(() => {
    const rows = [...document.querySelectorAll('#player-list .player-item, #host-list .player-item')];
    return rows.map(r => ({
      name: (r.querySelector('.player-item__name')?.textContent || '').trim(),
      sub: (r.querySelector('.name-substack')?.textContent || '').trim(),
    }));
  }).catch(e => ({ err: String(e).slice(0, 120) }));
  console.log('   · guest lobby rows:', JSON.stringify(guestRow));

  if (Array.isArray(guestRow)) {
    const blank = guestRow.filter(r => r.name && !r.sub);
    if (blank.length) {
      problems.push(`${blank.length} lobby row(s) have nothing under the name — a guest should read "Guest": ${JSON.stringify(blank)}`);
    }
    const notGuest = guestRow.filter(r => r.name && r.sub && !/guest/i.test(r.sub));
    if (notGuest.length) {
      problems.push(`a guest's row says something other than "Guest": ${JSON.stringify(notGuest)}`);
    }
  }

  // ============================================================
  // SHUTTING THE DELETE DOOR DID NOT BREAK LEAVING (migration 057)
  // ============================================================
  //
  // `players` no longer has a DELETE policy for clients. This checks the thing
  // migration 049 failed to: that closing a door did not silently break a
  // legitimate write. 049 was written about the writes that were dangerous, and
  // broke three that were not — Play Again, rejoining and practice bots —
  // with every test still green, because a refused delete returns no error and
  // zero rows.
  //
  // BE PRECISE ABOUT WHAT THIS EXERCISES. Leaving goes through op_leave_room
  // (migration 048), not op_remove_player: handleLeave calls the server first
  // and only falls back to removePlayer when that function is missing. So this
  // does NOT test 057's rules — it tests that 057 did not break the commonest
  // seat removal in the game, which is the failure that would strand every
  // player in every room they had ever joined.
  //
  // 057's own rules are pinned in tests/sql/game-rules.sql against a real
  // Postgres, and its client path by scenario-bots, which reports "the host
  // pressed remove on the bot and it stayed" when the direct delete is put back.
  // An earlier version of this comment claimed it covered op_remove_player; it
  // does not, and the break test that proved so is why it now says which.
  // ============================================================
  // A HOST WHO WENT AFK MUST BE ABLE TO GET BACK IN
  //
  // Migration 058 refuses an INSERT carrying is_host into a room that already
  // has a live host: `NOT is_host OR NOT op_room_has_live_host(room_id)`. A
  // host who is away long enough has their seat swept and somebody else
  // promoted — while their OWN sessionStorage still says isHost. Every attempt
  // to come back then asks for a crown the room has given away, is refused
  // 42501, and surfaces as "Couldn't join the room — check your connection",
  // which is wrong about the cause and wrong about the remedy.
  //
  // Reported from a live game: "I went AFK from the lobby. When I came back it
  // said I could not join a bunch of times but still showed the lobby as
  // active. It didn't show me as a player anymore."
  //
  // 058's own comment says the client's `someoneElseIsHost` check decides this.
  // That check lived in js/game/init.js and NOWHERE ELSE, so the lobby walked
  // straight into the refusal — the "one rule, N readers, fixed in N-1" shape
  // this project keeps recording. It lives in claimSeat now, which every seat
  // in the app goes through.
  // ============================================================
  console.log('\n=== the host went AFK and came back ===');
  {
    const afk = host;
    const seatId = await afk.page
      .evaluate(() => JSON.parse(sessionStorage.getItem('oracle_party_room') || '{}').playerId)
      .catch(() => null);

    // Somebody else is the live host now, exactly as promotion leaves the room,
    // and the AFK host's seat is gone.
    const players = table.store.table('players');
    const successor = players.find(p => String(p.id) !== String(seatId) && !p.is_bot);
    if (!seatId || !successor) {
      problems.push('could not set up the AFK-host case (no seat or nobody to promote)');
    } else {
      successor.is_host = true;
      successor.last_seen_at = new Date().toISOString();
      const idx = players.findIndex(p => String(p.id) === String(seatId));
      if (idx !== -1) players.splice(idx, 1);
      console.log(`   · ${afk.name}'s seat was swept; ${successor.display_name} is host now`);

      // Their phone wakes up and the lobby re-claims a seat. sessionStorage
      // still says they are the host, which is the whole point.
      await afk.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await afk.page.waitForTimeout(6000);

      const back = table.store.table('players').filter(p => p.display_name === afk.name);
      const hosts = table.store.table('players').filter(p => p.is_host).map(p => p.display_name);
      console.log(`   · ${afk.name} rows after coming back: ${back.length}; hosts now: ${JSON.stringify(hosts)}`);

      if (back.length === 0) {
        problems.push(`${afk.name} went AFK, was swept, and could not get back into their own lobby — the room is still there and they are not in it`);
      }
      if (back.length > 1) {
        problems.push(`${afk.name} came back as ${back.length} seats`);
      }
      if (hosts.length > 1) {
        problems.push(`the room has ${hosts.length} hosts after the AFK host returned: ${JSON.stringify(hosts)}`);
      }
    }
  }

  console.log('\n=== leaving a lobby ===');
  {
    const leaver = joiners[joiners.length - 1];
    const before = table.store.table('players').length;
    const seatId = await leaver.page
      .evaluate(() => JSON.parse(sessionStorage.getItem('oracle_party_room') || '{}').playerId)
      .catch(() => null);
    await leaver.page.locator('#btn-leave').click().catch(() => {});
    await leaver.page.waitForTimeout(2500);
    const after = table.store.table('players').length;
    const stillSeated = seatId
      ? table.store.table('players').some(p => String(p.id) === String(seatId))
      : null;
    console.log(`   · players ${before} -> ${after}; the leaver's row still there: ${stillSeated}`);
    if (stillSeated === true) {
      problems.push('a player pressed Leave and their seat stayed in the room — nobody can leave, and the lobby will keep listing them forever');
    } else if (after >= before) {
      problems.push(`pressing Leave removed nobody (${before} -> ${after})`);
    }
  }

  for (const r of [host, ...joiners]) {
    if (r.consoleErrors.length) {
      problems.push(`${r.name} had ${r.consoleErrors.length} console error(s): ${r.consoleErrors[0].slice(0, 120)}`);
    }
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
