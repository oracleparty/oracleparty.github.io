// Scenario: Chaos mode, and a player's own honk sound switch.
//
// Asked for by the owner on 2026-10-26. Ordinarily a honk is DROPPED while
// somebody is answering — the game's own rule, and the default. Chaos mode is a
// room setting the host turns on; everybody can see it is on, and honks then
// arrive at every moment of the game. Separately, every player has a speaker
// button that turns honk SOUND off on their own phone — the ducks still show,
// so a muted player still sees what everybody else is hearing.
//
// Checked in both directions, because either alone cannot fail:
//   * with Chaos ON, a honk reaches somebody on the question screen;
//   * with Chaos OFF, the same honk does not — the default is untouched.
//   * with sound OFF, a received honk plays no sound and still shows a duck;
//   * with sound back ON, it plays.
//
// The honk is sent through the page's own honk module (dynamic import of the
// same URL the game imports, so it is the same instance), because the question
// screen carries no honk button — the honk has to come from somebody on a
// different screen, which is exactly the case Chaos exists for.
//
// Run: node tests/harness/scenario-chaos.mjs
import { PlaytestTable } from './harness.js';

const CATEGORY = 'history';
const QUESTIONS = 5;
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

function seedQuestions(store, n = 40) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: `q${i}`, question: `Test question ${i}?`, correct_answer: `Answer ${i}`,
      acceptable_answers: [], incorrect_answers: [`Wrong ${i}`],
      categories: [CATEGORY], subcategory: null,
      difficulty: ['easy', 'medium', 'hard'][i % 3], format: 'open',
      fun_fact: null, discarded: false,
    });
  }
  store.seed('questions', rows);
}

const clickIfReady = async (r, sel) => {
  const el = r.page.locator(sel).first();
  if (!await el.isVisible().catch(() => false)) return false;
  if (!await el.isEnabled().catch(() => false)) return false;
  await el.click().catch(() => {});
  return true;
};

// Every duck and every sound Bob's page produces, counted from page load.
const OBSERVE = () => {
  window.__ducks = 0;
  window.__plays = 0;
  const realPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) {
    if (!this.muted) window.__plays++;      // the pool's muted unlock is not a sound
    return realPlay.apply(this, a);
  };
  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.classList?.contains('honk-goose')) window.__ducks++;
    }
  }).observe(document, { childList: true, subtree: true });   // documentElement may not exist yet
};

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);

  async function seat(name) {
    const r = await table.seat(name);
    await r.page.addInitScript(n => localStorage.setItem('oracle_party_display_name', n), name);
    return r;
  }

  heading('the host creates a room — Chaos is offered and off');
  const host = await seat('Alice');
  await host.goto('host.html');
  await host.page.waitForSelector('.category-card', { timeout: 20000 });
  await host.page.click(`.category-card[data-category="${CATEGORY}"]`);
  await host.page.waitForTimeout(800);
  await host.page.click('text=/^All /');
  await host.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  const offered = await host.page.locator('[data-setting="chaos"]').isVisible().catch(() => false);
  if (!offered) problems.push('the Chaos switch is not offered on the create-room settings');
  await host.page.click(`[data-setting="questionsPerGame"] [data-value="${QUESTIONS}"]`).catch(() => {});
  // The longest clock, so every honk below lands while Bob is still answering.
  await host.page.click('[data-setting="questionTimer"] [data-value="60"]').catch(() => {});
  await host.page.click('#btn-host-game');
  await host.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(1200);
  const room = () => table.store.table('rooms')[0];
  if (room()?.chaos) problems.push('a room created with Chaos left off has it on');
  const code = await host.textOf('#lobby-code');

  const bob = await seat('Bob');
  await bob.page.addInitScript(OBSERVE);
  await bob.goto('join.html');
  await bob.page.waitForSelector('#code-input', { timeout: 15000 });
  await bob.page.fill('#code-input', code);
  await bob.page.click('#btn-join');
  await bob.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await host.page.waitForTimeout(2000);

  const bobPill = () => bob.page.evaluate(() => {
    const p = document.querySelector('#lobby-chaos');
    return !!p && !p.classList.contains('hidden') && p.offsetParent !== null;
  }).catch(() => false);
  if (await bobPill()) problems.push('Bob sees "Chaos mode" before the host turned it on');

  heading('the host turns Chaos on in the lobby — and Bob can see it');
  await host.page.click('#btn-settings');
  await host.page.waitForSelector('[data-setting="chaos"] [data-value="1"]', { state: 'visible', timeout: 5000 })
    .catch(() => problems.push('the lobby settings sheet does not offer Chaos'));
  await host.page.click('[data-setting="chaos"] [data-value="1"]').catch(() => {});
  await host.page.click('#btn-close-settings').catch(() => {});
  await host.page.waitForTimeout(1500);
  note(`room.chaos = ${room()?.chaos}`);
  if (room()?.chaos !== true) problems.push('turning Chaos on in the lobby did not reach the room');
  if (!await bobPill()) problems.push('the host turned Chaos on and Bob cannot see it');

  heading('Bob opens the lobby settings — read-only');
  await bob.page.click('#btn-settings').catch(() => problems.push('a player has no settings button in the lobby'));
  await bob.page.waitForTimeout(500);
  const lob = await bob.page.evaluate(() => {
    const m = document.querySelector('#settings-modal');
    const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
    return {
      open: !!m?.classList.contains('active'),
      readonly: !!m?.classList.contains('is-readonly'),
      toggles: [...m.querySelectorAll('.toggle-group')].filter(vis).length,
      chaos: (m.querySelector('[data-chaos-setting] .room-settings__value')?.textContent || '').trim(),
    };
  }).catch(() => null);
  note(`Bob's lobby settings: ${JSON.stringify(lob)}`);
  if (!lob?.open) problems.push('a player tapped the lobby settings and nothing opened');
  else {
    if (!lob.readonly || lob.toggles > 0) problems.push(`a player was offered the lobby's controls: ${JSON.stringify(lob)}`);
    if (!/^On/.test(lob.chaos)) problems.push(`the player's lobby settings do not say Chaos is on (read "${lob.chaos}")`);
  }
  await bob.page.click('#btn-close-settings').catch(() => {});
  await bob.page.waitForTimeout(300);

  heading("Bob's own sound switch");
  await bob.page.click('#btn-honk-sound').catch(() => problems.push('Bob has no honk sound switch in the lobby'));
  const stored = await bob.page.evaluate(() => localStorage.getItem('oracle_party_honk_sound_off'));
  if (stored !== '1') problems.push(`the sound switch did not save (stored ${stored})`);

  heading('starting the game');
  await clickIfReady(bob, '#btn-ready');
  await host.page.waitForTimeout(800);
  for (let i = 0; i < 12; i++) {
    await clickIfReady(host, '#btn-start-game');
    await host.page.waitForTimeout(700);
    if (room()?.status === 'playing') break;
  }
  for (const r of [host, bob]) {
    await r.page.waitForURL('**/game.html*', { timeout: 25000 })
      .catch(() => problems.push(`${r.name} never reached the game`));
  }

  const bobId = () => bob.page.evaluate(() => window.__state?.room?.playerId);
  const honkBob = async () => {
    const id = await bobId();
    await host.page.evaluate(async target => {
      const h = await import(new URL('js/honk.js', location.href).href);
      h.sendHonk(target);
    }, id);
    await bob.page.waitForTimeout(1200);
  };
  const counts = () => bob.page.evaluate(() => ({ ducks: window.__ducks, plays: window.__plays }));
  const onQuestion = () => bob.page.evaluate(() =>
    document.querySelector('.screen.active')?.id === 'question-screen' && !window.__state?.hasSubmitted);
  // Chaos shows as a DOT on the gear in the game header (owner, 2026-10-28),
  // not a word: the words are in the room settings sheet every player can open.
  const headerPill = () => bob.page.evaluate(() => {
    const g = document.querySelector('.screen.active .host-settings-gear');
    return !!g && !g.classList.contains('hidden') && g.classList.contains('has-mode');
  }).catch(() => false);
  const openSheet = async r => {
    await r.page.locator('.screen.active .host-settings-gear').click().catch(() => {});
    await r.page.waitForTimeout(500);
    return r.page.evaluate(() => {
      const sh = document.querySelector('#host-settings-sheet');
      const vis = el => !!el && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
      return {
        open: !!sh?.classList.contains('active'),
        readonly: !!sh?.classList.contains('is-readonly'),
        toggles: [...sh.querySelectorAll('.toggle-group')].filter(vis).length,
        returnBtn: vis(sh.querySelector('#btn-return-to-lobby')),
        chaosWords: (sh.querySelector('[data-value-for="chaos"]')?.textContent || '').trim(),
        questions: (sh.querySelector('#room-settings-questions')?.textContent || '').trim(),
      };
    }).catch(() => null);
  };
  const closeSheet = r => r.page.click('#host-settings-backdrop').catch(() => {});

  heading('round 0: Chaos ON, Bob answering, sound OFF');
  await bob.page.waitForSelector('#answer-input', { state: 'visible', timeout: 20000 })
    .catch(() => problems.push('Bob never got an answer box'));
  if (!await headerPill()) problems.push('Chaos is on and Bob\'s question screen does not say so');

  let before = await counts();
  if (!await onQuestion()) problems.push('Bob was not on the question screen when the honk was sent');
  await honkBob();
  let after = await counts();
  note(`ducks ${before.ducks}->${after.ducks}, sounds ${before.plays}->${after.plays}`);
  if (after.ducks <= before.ducks) problems.push('Chaos is on and a honk did not reach Bob while he was answering');
  if (after.plays > before.plays) problems.push('Bob turned honk sound off and a honk still played a sound');

  heading('sound back ON — the same honk plays');
  await bob.page.evaluate(async () => {
    const h = await import(new URL('js/honk.js', location.href).href);
    h.setHonkSoundOff(false);
  });
  before = await counts();
  await honkBob();
  after = await counts();
  note(`ducks ${before.ducks}->${after.ducks}, sounds ${before.plays}->${after.plays}`);
  if (after.plays <= before.plays) problems.push('Bob turned honk sound back on and a received honk played nothing');

  heading('the host turns Chaos OFF from the in-game gear');
  await host.page.locator('.screen.active .host-settings-gear').click().catch(() => {});
  await host.page.waitForSelector('[data-game-setting="chaos"] [data-value="0"]', { state: 'visible', timeout: 5000 })
    .catch(() => problems.push('the in-game settings sheet does not offer Chaos'));
  await host.page.click('[data-game-setting="chaos"] [data-value="0"]').catch(() => {});
  await host.page.click('#host-settings-backdrop').catch(() => {});
  await host.page.waitForTimeout(1500);
  if (room()?.chaos !== false) problems.push('turning Chaos off in the game did not reach the room');
  if (await headerPill()) problems.push('Chaos is off and Bob\'s screen still says Chaos');

  heading('Chaos OFF, Bob still answering — the honk is dropped, as by default');
  note(`Bob: ${await bob.page.evaluate(() => `${document.querySelector('.screen.active')?.id} submitted=${window.__state?.hasSubmitted}`)}`);
  before = await counts();
  await honkBob();
  after = await counts();
  note(`ducks ${before.ducks}->${after.ducks}, sounds ${before.plays}->${after.plays}`);
  if (!await onQuestion()) problems.push('INCONCLUSIVE: Bob left the question screen before the Chaos-off honk');
  else if (after.ducks > before.ducks || after.plays > before.plays) {
    problems.push('Chaos is off and a honk still reached Bob while he was answering — the default changed');
  }

  heading('every player can open the room settings — read-only unless host');
  // Last, so opening sheets cannot cost Bob the question screen the honk
  // checks above need. Chaos is OFF by now, so the sheet must say so.
  {
    const b = await openSheet(bob);
    note(`Bob's sheet: ${JSON.stringify(b)}`);
    if (!b?.open) problems.push('a player tapped the gear and no room settings opened');
    else {
      if (!b.readonly || b.toggles > 0) problems.push(`a player was offered the room's controls: ${JSON.stringify(b)}`);
      if (b.returnBtn) problems.push('a player was offered Return to Lobby');
      if (b.chaosWords !== 'Off') problems.push(`the host turned Chaos off and the player's sheet reads "${b.chaosWords}"`);
      if (b.questions !== String(QUESTIONS)) problems.push(`the player's sheet says ${b.questions} questions, not ${QUESTIONS}`);
    }
    await closeSheet(bob);
    const h = await openSheet(host);
    note(`Alice's sheet: ${JSON.stringify(h && { readonly: h.readonly, toggles: h.toggles, returnBtn: h.returnBtn })}`);
    if (!h?.open || h.readonly || h.toggles < 2 || !h.returnBtn) problems.push(`the host's sheet lost its controls: ${JSON.stringify(h)}`);
    await closeSheet(host);
    await host.page.waitForTimeout(400);
  }
} catch (e) {
  problems.push(`scenario crashed: ${e.stack || e}`);
} finally {
  await table.close();
}

console.log(problems.length ? `\nFAILED (${problems.length}):\n - ${problems.join('\n - ')}` : '\nPASSED');
process.exit(problems.length ? 1 : 0);
