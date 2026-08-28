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

  // The label, not only the fade. 40% opacity alone is ambiguous — it reads
  // equally as away, gone, disabled or still loading.
  await setHidden(bob, true);
  await host.page.waitForTimeout(1500);
  const awayBadges = await host.page.evaluate(() =>
    [...document.querySelectorAll('.player-item--away .badge')].map(b => b.textContent.trim()));
  console.log('   · badges on an away row:', awayBadges);
  if (!awayBadges.some(b => /away/i.test(b))) {
    problems.push('an away player carries no "Away" label, so the fade is the only signal and cannot be told from gone, disabled or loading');
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
