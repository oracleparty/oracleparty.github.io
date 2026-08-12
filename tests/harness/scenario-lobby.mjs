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
