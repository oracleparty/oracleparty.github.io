// Scenario: Category draft.
//
// Designed with the owner on 2026-11-15. The host picks "Draft" instead of a
// subject; in the lobby every person makes ONE move, want a category or ban
// one, shown live to the whole room and changeable until Start. A want and a
// ban on the same category cancel out. Each surviving want guarantees a share
// of the game's questions; a banned category is left out; the rest is a mix.
//
// Checked here, each in both directions where one side alone could not fail:
//   * the host is offered Draft, and the room it makes says "Draft" to everyone;
//   * a move shows on ANOTHER phone, with its consequence (+N / out / even);
//   * a move can be changed, and the seat holds exactly one;
//   * a move the database refuses is taken back off the screen;
//   * the started game holds the guaranteed questions and NOT ONE from the
//     banned subject — the bank is seeded history-first so that a broken ban
//     shows up at once (break-tested by switching inBannedCategory off);
//   * a wanted question says whose pick it was, and an ordinary one does not.
//
// Run: node tests/harness/scenario-categorydraft.mjs
import { PlaytestTable } from './harness.js';

const QUESTIONS = 5;            // 3 people → one want is worth floor(5/3) = 1
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

const SUBJECTS = ['history', 'science', 'nature', 'arts-literature', 'culture-society',
  'pop-culture', 'world-geography', 'technology', 'sports', 'food', 'logic'];

function seedQuestions(store) {
  const rows = [];
  let n = 0;
  const add = (cats, count) => {
    for (let i = 0; i < count; i++) {
      n++;
      rows.push({
        id: `q${n}`, question: `Test question ${n}?`, correct_answer: `Answer ${n}`,
        acceptable_answers: [], incorrect_answers: [`Wrong ${n}`],
        categories: cats, subcategory: null,
        difficulty: ['easy', 'medium', 'hard'][n % 3], format: 'open',
        fun_fact: null, discarded: false,
      });
    }
  };
  // HISTORY FIRST, and a lot of it. The mix is read from the front of the
  // table, so if the ban ever stops working the game fills with history.
  add(['history'], 60);
  add(['history', 'science'], 6);          // filed under both: banned wins
  for (const s of SUBJECTS.filter(s => s !== 'history')) add([s], 14);
  store.seed('questions', rows);
}

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);
  const questionsById = new Map(table.store.table('questions').map(q => [q.id, q]));
  const room = () => table.store.table('rooms')[0];
  const seatRow = name => table.store.table('players').find(p => p.display_name === name);

  async function seat(name) {
    const r = await table.seat(name);
    await r.page.addInitScript(n => localStorage.setItem('oracle_party_display_name', n), name);
    return r;
  }
  async function join(r, code) {
    await r.goto('join.html');
    await r.page.waitForSelector('#code-input', { timeout: 15000 });
    await r.page.fill('#code-input', code);
    await r.page.click('#btn-join');
    await r.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  }
  /** Open the sheet, tap a category, then want / ban / clear it. */
  async function move(r, category, kind) {
    await r.page.click('#btn-draft-move');
    await r.page.waitForSelector('#draft-sheet.active', { timeout: 5000 });
    await r.page.click(`[data-draft-category="${category}"]`);
    await r.page.click(`[data-draft-kind="${kind}"]`);
    await r.page.waitForTimeout(700);
  }
  const chips = r => r.page.evaluate(() =>
    [...document.querySelectorAll('#draft-chips .draft-chip')].map(c => ({
      title: c.getAttribute('title'),
      state: c.querySelector('.draft-chip__state')?.textContent.trim(),
      faces: c.querySelectorAll('.draft-face').length,
      kind: [...c.classList].find(k => k.startsWith('draft-chip--')),
    })));
  const chipFor = async (r, title) => (await chips(r)).find(c => c.title === title);

  heading('the host is offered Draft and makes a Draft room');
  const alice = await seat('Alice');
  await alice.goto('host.html');
  await alice.page.waitForSelector('.category-card', { timeout: 20000 });
  const offered = await alice.page.waitForSelector('#btn-draft:not(.hidden)', { timeout: 8000 })
    .then(() => true).catch(() => false);
  if (!offered) problems.push('the host is not offered Draft on Choose Category');
  await alice.page.click('#btn-draft');
  await alice.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
  const badge = await alice.textOf('.selected-category__name');
  if (!/^Draft$/.test((badge || '').trim())) problems.push(`the settings screen calls the choice "${badge}", want "Draft"`);
  await alice.page.click(`[data-setting="questionsPerGame"] [data-value="${QUESTIONS}"]`).catch(() => {});
  await alice.page.click('#btn-host-game');
  await alice.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  await alice.page.waitForTimeout(1000);
  note(`room: category=${room()?.category} subcategory=${room()?.subcategory}`);
  if (room()?.subcategory !== '__draft__') problems.push('the room was not created as a Draft room');
  const code = await alice.textOf('#lobby-code');

  const bob = await seat('Bob');
  const carol = await seat('Carol');
  await join(bob, code);
  await join(carol, code);
  await alice.page.waitForTimeout(1500);

  for (const r of [alice, bob, carol]) {
    const label = (await r.textOf('#lobby-category') || '').trim();
    if (label !== 'Draft') problems.push(`${r.name}'s lobby card reads "${label}", want "Draft"`);
    const bar = await r.page.locator('#draft-bar').isVisible().catch(() => false);
    if (!bar) problems.push(`${r.name} has no draft bar in a Draft room`);
  }

  heading('a move shows on every phone, with what it does');
  await move(alice, 'science', 'want');
  note(`Alice's seat: ${seatRow('Alice')?.draft_move}`);
  if (seatRow('Alice')?.draft_move !== 'want:science') problems.push("Alice's want was not saved on her seat");
  await bob.page.waitForTimeout(800);
  let chip = await chipFor(bob, 'Science');
  if (!chip) problems.push("Bob cannot see Alice's move");
  else if (chip.state !== '+1' || chip.faces !== 1) problems.push(`Bob sees Science as ${JSON.stringify(chip)}, want +1 with one face`);
  const mine = (await alice.textOf('#btn-draft-move') || '').trim();
  if (!/Science/.test(mine)) problems.push(`Alice's own button reads "${mine}" after her move`);

  heading('a want and a ban on one category cancel out');
  await move(bob, 'science', 'ban');
  await carol.page.waitForTimeout(800);
  chip = await chipFor(carol, 'Science');
  if (chip?.state !== 'even' || chip?.faces !== 2) problems.push(`a want and a ban on Science read ${JSON.stringify(chip)}, want "even" with two faces`);

  heading('a move can be changed, and a seat holds one');
  await move(bob, 'history', 'ban');
  if (seatRow('Bob')?.draft_move !== 'ban:history') problems.push(`Bob's seat holds "${seatRow('Bob')?.draft_move}" after changing his move`);
  await carol.page.waitForTimeout(800);
  const afterChange = await chips(carol);
  note(`Carol sees: ${afterChange.map(c => `${c.title} ${c.state}`).join(', ')}`);
  if (afterChange.find(c => c.title === 'Science')?.state !== '+1') problems.push('Science did not return to +1 when the ban moved away');
  if (afterChange.find(c => c.title === 'History')?.state !== 'out') problems.push('a banned category does not read "out"');

  heading('a move the database refuses comes back off the screen');
  // An ERROR, not a silent zero rows: a zero-row refusal re-reads the players
  // and would redraw correctly even if the screen never took the move back, so
  // it cannot test that. (Found by break test: the first version passed with
  // the take-back removed.)
  table.store.addCheck('players', row => row.draft_move !== 'want:sports', 'players_draft_move_shape');
  await carol.page.click('#btn-draft-move');
  await carol.page.waitForSelector('#draft-sheet.active', { timeout: 5000 });
  await carol.page.click('[data-draft-category="sports"]');
  await carol.page.click('[data-draft-kind="want"]');
  // Read the screen THE MOMENT the refusal is announced. A heartbeat or the
  // 8-second player poll replaces the local row with the server's and would
  // repair a move left on screen, hiding the fault from any later look.
  await carol.page.waitForFunction(() =>
    [...document.querySelectorAll('.toast')].some(t => /draft move/i.test(t.textContent)), null, { timeout: 5000 }).catch(() => {});
  const refusedBtn = (await carol.textOf('#btn-draft-move') || '').trim();
  const refusedChip = await chipFor(carol, 'Sports');
  await carol.page.waitForTimeout(700);
  table.store.clearChecks('players');
  if (seatRow('Carol')?.draft_move) problems.push('a refused move was stored anyway');
  const told = await carol.page.evaluate(() =>
    [...document.querySelectorAll('.toast')].some(t => /draft move/i.test(t.textContent))).catch(() => false);
  if (!told) problems.push('a draft move failed to save and Carol was told nothing');
  if (refusedBtn !== 'Make your move') problems.push(`Carol's move was refused and her button still reads "${refusedBtn}"`);
  if (refusedChip) problems.push('a refused move is still drawn as a chip');
  // The refusal may have surfaced the removed-seat notice path; it must not have.
  const removed = await carol.page.locator('#removed-modal.active').isVisible().catch(() => false);
  if (removed) problems.push('a refused draft move told Carol she was removed from the room');

  await move(carol, 'science', 'want');
  await alice.page.waitForTimeout(800);
  chip = await chipFor(alice, 'Science');
  if (chip?.state !== '+2' || chip?.faces !== 2) problems.push(`two wants on Science read ${JSON.stringify(chip)}, want +2 with two faces`);

  heading('the game is built from the moves');
  for (const r of [bob, carol]) await r.page.click('#btn-ready').catch(() => {});
  await alice.page.waitForTimeout(600);
  await alice.page.click('#btn-start-game');
  await alice.page.waitForURL('**/game.html*', { timeout: 20000 });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !(room()?.question_ids?.length)) await alice.page.waitForTimeout(250);
  const ids = room()?.question_ids || [];
  const cats = ids.map(id => questionsById.get(id)?.categories || []);
  const regular = cats.slice(0, QUESTIONS);
  const scienceCount = regular.filter(c => c.includes('science')).length;
  const historyCount = cats.filter(c => c.includes('history')).length;
  note(`question list: ${cats.map(c => c.join('+')).join(' | ')}`);
  if (ids.length !== QUESTIONS + 1) problems.push(`the game holds ${ids.length} questions, want ${QUESTIONS + 1}`);
  if (new Set(ids).size !== ids.length) problems.push('the drafted game asks the same question twice');
  if (scienceCount < 2) problems.push(`two wants on Science guaranteed 2 questions and the game holds ${scienceCount}`);
  if (historyCount > 0) problems.push(`History was banned and the game holds ${historyCount} history question(s)`);

  heading('a wanted question says whose pick it was');
  await bob.page.waitForSelector('#question-screen.active #question-text', { timeout: 30000 }).catch(() => {});
  await bob.page.waitForFunction(() => {
    const el = document.querySelector('#question-text');
    return el && el.textContent.trim().length > 0 && el.offsetParent !== null;
  }, null, { timeout: 30000 }).catch(() => problems.push('Bob never saw the first question of the drafted game'));
  const shown = await bob.page.evaluate(() => ({
    text: document.querySelector('#question-text')?.textContent.trim(),
    header: document.querySelector('#question-category')?.textContent.trim(),
    width: document.querySelector('#question-category')?.scrollWidth,
    room: document.querySelector('.game-progress')?.clientWidth,
  }));
  const q = [...questionsById.values()].find(x => x.question === shown.text);
  note(`Bob's header: "${shown.header}" for a ${q?.categories.join('+')} question`);
  if (!q) problems.push(`Bob is shown a question the bank does not hold: "${shown.text}"`);
  else if (q.categories.includes('science')) {
    if (!/Science/.test(shown.header) || !/Alice & Carol's pick/.test(shown.header)) {
      problems.push(`a Science question's header reads "${shown.header}", want the subject and "Alice & Carol's pick"`);
    }
  } else {
    if (/pick/.test(shown.header)) problems.push(`a question nobody wanted claims to be a pick: "${shown.header}"`);
    if (/Draft|Wild/.test(shown.header)) problems.push(`the header names the mode, not the question's subject: "${shown.header}"`);
  }

  const errors = [alice, bob, carol].flatMap(r => (r.consoleErrors || []).map(e => `${r.name}: ${e}`));
  if (errors.length) note(`console errors: ${errors.slice(0, 5).join(' || ')}`);

  console.log('\n' + (problems.length ? `FAILED — ${problems.length} problem(s):` : 'PASSED — category draft works'));
  for (const p of problems) console.log('  ✗', p);
  process.exitCode = problems.length ? 1 : 0;
} catch (err) {
  console.error('\nSCENARIO CRASHED:', err);
  process.exitCode = 1;
} finally {
  await table.close();
}
