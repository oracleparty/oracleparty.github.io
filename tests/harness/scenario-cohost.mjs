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
  const cohostBtn = host.page.locator(`.cohost-btn[data-cohost-id="${bobId}"]`).first();
  if (!await cohostBtn.isVisible().catch(() => false)) {
    problems.push('the host is not offered a Co-Host button for another player');
  } else {
    await cohostBtn.click().catch(() => {});
    await host.page.waitForTimeout(2500);

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
  }

  // ============================================================
  // 5 (in the lobby, where the button lives). DEMOTE, THEN RE-PROMOTE
  // ============================================================
  heading('demotion');
  const demoteBtn = host.page.locator(`.cohost-btn--demote[data-cohost-id="${bobId}"]`).first();
  if (!await demoteBtn.isVisible().catch(() => false)) {
    problems.push('no Demote button appears for a player who is already co-host');
  } else {
    const btnInfo = await host.page.evaluate(id => {
      const b = document.querySelector(`.cohost-btn--demote[data-cohost-id="${id}"]`);
      return b ? { classes: b.className, id: b.dataset.cohostId, text: b.textContent.trim() } : null;
    }, bobId).catch(() => null);
    note(`demote button: ${JSON.stringify(btnInfo)}`);

    // Do NOT swallow this: a click that Playwright refuses (intercepted by an
    // overlay, detached mid-render) is indistinguishable from a dead button
    // once the error is caught.
    let clickErr = null;
    await demoteBtn.click({ timeout: 8000 }).catch(e => { clickErr = e.message.split('\n')[0]; });
    note(`demote click error: ${clickErr || 'none'}`);
    await host.page.waitForTimeout(2500);
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
    await host.page.locator(`.cohost-btn[data-cohost-id="${bobId}"]`).first().click().catch(() => {});
    await host.page.waitForTimeout(2500);
    const rePromoted = table.store.table('players').find(p => p.display_name === 'Bob')?.is_cohost;
    note(`Bob re-promoted: ${rePromoted}`);
    if (!rePromoted) problems.push('could not re-promote a demoted player to co-host');
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

  for (const r of [host, bob, carol]) {
    const real = r.consoleErrors.filter(e =>
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
