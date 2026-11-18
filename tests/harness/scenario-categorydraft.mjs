// Scenario: Draft and Random — one spin at Start picks the game's subject.
//
// Designed with the owner on 2026-11-15/16. The host picks "Draft" or "Random"
// instead of a subject. In a Draft lobby every person makes ONE move: a want
// puts a block for that category on the wheel, a ban takes one off. At Start
// the host's phone spins (wanted categories share 95% by blocks, untouched
// ones share a 1-in-20 upset, banned ones cannot come up), writes the result
// to the room, and every phone plays the wheel in front of the countdown and
// then asks questions from that one subject. Random is the same spin over
// every subject with no lobby step.
//
// THE ODDS are pinned exactly by tests/draft-logic.test.js. This scenario
// checks the plumbing a unit test cannot: moves reaching other phones, a
// refused move coming back off the screen, the pick reaching the room and
// every phone, the wheel actually playing, and the game being built from the
// pick. The outcome of a spin is random, so every assertion here holds for
// any legal outcome.
//
// Run: node tests/harness/scenario-categorydraft.mjs
import { PlaytestTable } from './harness.js';

const QUESTIONS = 5;
const problems = [];
const note = m => console.log('   ·', m);
const heading = m => console.log(`\n=== ${m} ===`);

const SUBJECTS = ['history', 'science', 'nature', 'arts-literature', 'culture-society',
  'pop-culture', 'world-geography', 'technology', 'sports', 'food', 'logic'];
const LABELS = {
  'history': 'History', 'science': 'Science', 'nature': 'Nature',
  'arts-literature': 'Arts & Literature', 'culture-society': 'Culture & Society',
  'pop-culture': 'Pop Culture', 'world-geography': 'World Geography',
  'technology': 'Technology', 'sports': 'Sports', 'food': 'Food & Drink', 'logic': 'Logic',
};

function seedQuestions(store) {
  const rows = [];
  let n = 0;
  for (const s of SUBJECTS) {
    for (let i = 0; i < 14; i++) {
      n++;
      rows.push({
        id: `q${n}`, question: `Test question ${n}?`, correct_answer: `Answer ${n}`,
        acceptable_answers: [], incorrect_answers: [`Wrong ${n}`],
        categories: [s], subcategory: null,
        difficulty: ['easy', 'medium', 'hard'][n % 3], format: 'open',
        fun_fact: null, discarded: false,
      });
    }
  }
  store.seed('questions', rows);
}

const table = await PlaytestTable.open();

try {
  seedQuestions(table.store);
  const questionsById = new Map(table.store.table('questions').map(q => [q.id, q]));
  const roomOf = hostName => table.store.table('rooms').find(r => r.host_name === hostName);
  const seatRow = name => table.store.table('players').find(p => p.display_name === name);

  async function seat(name) {
    const r = await table.seat(name);
    await r.page.addInitScript(n => localStorage.setItem('oracle_party_display_name', n), name);
    return r;
  }
  async function hostWith(r, buttonId, { every = false } = {}) {
    await r.goto('host.html');
    await r.page.waitForSelector('.category-card', { timeout: 20000 });
    const offered = await r.page.waitForSelector(`#spin-entries:not(.hidden) ${buttonId}`, { timeout: 1500 })
      .then(() => true).catch(() => false);
    table.store.normalReads('players');
    if (!offered) { problems.push(`the host is not offered ${buttonId} on Choose Category`); return null; }
    await r.page.click(buttonId);
    await r.page.waitForSelector('#btn-host-game', { state: 'visible', timeout: 15000 });
    const badge = ((await r.textOf('.selected-category__name')) || '').trim();
    const spinRow = await r.page.locator('[data-spin-setting]').isVisible().catch(() => false);
    if (!spinRow) problems.push(`the Spin setting is not offered after choosing ${buttonId}`);
    if (every) await r.page.click('[data-setting="spinEvery"] [data-value="1"]').catch(() => {});
    await r.page.click(`[data-setting="questionsPerGame"] [data-value="${QUESTIONS}"]`).catch(() => {});
    await r.page.click('#btn-host-game');
    await r.page.waitForURL('**/lobby.html*', { timeout: 20000 });
    await r.page.waitForTimeout(1000);
    return badge;
  }
  async function join(r, code) {
    await r.goto('join.html');
    await r.page.waitForSelector('#code-input', { timeout: 15000 });
    await r.page.fill('#code-input', code);
    await r.page.click('#btn-join');
    await r.page.waitForURL('**/lobby.html*', { timeout: 20000 });
  }
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
    })));
  const chipFor = async (r, title) => (await chips(r)).find(c => c.title === title);

  /** Watch one phone through Start: did the wheel play, and where did it land? */
  const watchWheel = r => r.page.evaluate(() => new Promise(resolve => {
    const seen = { shown: false, final: '', won: '', tiles: [], card: null, cardAt: 0, cardGoneAt: 0 };
    const started = Date.now();
    const timer = setInterval(() => {
      const o = document.querySelector('#category-spin-overlay');
      if (o && !o.classList.contains('hidden')) {
        seen.shown = true;
        seen.final = o.querySelector('.category-spin__final')?.textContent.trim() || seen.final;
        seen.won = o.querySelector('.draft-tile--won')?.dataset.spinCategory || seen.won;
        if (!seen.tiles.length) seen.tiles = [...o.querySelectorAll('[data-spin-category]')].map(t => t.dataset.spinCategory);
      }
      const card = document.querySelector('#subject-card');
      if (card && !card.classList.contains('hidden')) {
        if (!seen.cardAt) seen.cardAt = Date.now();
        if (card.classList.contains('subject-card--landed')) {
          seen.card = { kicker: card.querySelector('.subject-card__kicker')?.textContent.trim(),
            label: card.querySelector('.subject-card__label')?.textContent.trim() };
        }
      } else if (seen.cardAt && !seen.cardGoneAt) seen.cardGoneAt = Date.now();
      // The question is on screen once its card (if any) has gone and the card
      // under it is visible; its text is set earlier, underneath the card.
      const question = document.querySelector('#question-screen.active #question-text');
      const cardUp = card && !card.classList.contains('hidden');
      const shown = document.querySelector('#question-screen .question-card')?.style.visibility !== 'hidden';
      if ((question && question.textContent.trim() && !cardUp && shown) || Date.now() - started > 45000) {
        clearInterval(timer);
        seen.header = document.querySelector('#question-category')?.textContent.trim();
        seen.text = question?.textContent.trim() || null;
        resolve(seen);
      }
    }, 80);
  }));

  /** Everything a started spin game must satisfy, whatever the wheel landed on. */
  async function checkStartedGame(label, hostName, phones, cannotWin = [], { every = false } = {}) {
    const room = () => roomOf(hostName);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !(room()?.question_ids?.length)) await phones[0].robot.page.waitForTimeout(200);
    const pick = room()?.draft_pick;
    const ids = room()?.question_ids || [];
    const cats = ids.map(id => questionsById.get(id)?.categories || []);
    note(`${label}: the wheel landed on "${pick}"; questions: ${cats.map(c => c.join('+')).join(' | ')}`);
    if (!SUBJECTS.includes(pick)) { problems.push(`${label}: the room's pick is "${pick}", not a subject`); return null; }
    if (cannotWin.includes(pick)) problems.push(`${label}: the wheel landed on ${pick}, which could not win`);
    if (ids.length !== QUESTIONS + 1) problems.push(`${label}: the game holds ${ids.length} questions, want ${QUESTIONS + 1}`);
    if (new Set(ids).size !== ids.length) problems.push(`${label}: the game asks the same question twice`);
    if (every) {
      // A subject per question: each must be a real one, the wheel lands on
      // question 1's, and six draws over eleven subjects do not all match.
      const subjects = cats.map(c => c[0]);
      if (subjects.some(s => !SUBJECTS.includes(s))) problems.push(`${label}: a question has no real subject: ${subjects.join(', ')}`);
      if (subjects.some(s => cannotWin.includes(s))) problems.push(`${label}: a question came from a subject that could not win`);
      if (subjects[0] !== pick) problems.push(`${label}: the wheel landed on ${pick} and question 1 is ${subjects[0]}`);
      if (new Set(subjects).size < 2) problems.push(`${label}: every question is ${subjects[0]}; a spin per question should move between subjects`);
    } else {
      const stray = cats.filter(c => !c.includes(pick)).length;
      if (stray) problems.push(`${label}: ${stray} question(s) are not from ${pick}, the subject the wheel picked`);
    }

    for (const { robot, watching } of phones) {
      const seen = await watching;
      if (every) {
        // No opening wheel: it read as one subject for the whole game. Question
        // 1 gets the same subject card as every other question.
        if (seen.shown) problems.push(`${label}: ${robot.name} saw the opening wheel in an every-question game`);
        if (!seen.card) problems.push(`${label}: ${robot.name} saw no subject card before question 1`);
        else {
          if (seen.card.kicker !== 'Question 1') problems.push(`${label}: the card's round reads "${seen.card.kicker}", want "Question 1"`);
          if (seen.card.label !== LABELS[pick]) problems.push(`${label}: the card landed on "${seen.card.label}", question 1 is ${LABELS[pick]}`);
        }
        if (!seen.text) problems.push(`${label}: ${robot.name} never reached the first question after the card`);
        continue;
      }
      if (!seen.shown) problems.push(`${label}: ${robot.name} never saw the wheel`);
      else {
        const drawnOut = seen.tiles.filter(t => cannotWin.includes(t));
        if (drawnOut.length) problems.push(`${label}: the wheel drew ${drawnOut.join(', ')}, which could not win`);
        if (seen.won !== pick) problems.push(`${label}: ${robot.name}'s wheel stopped on "${seen.won}", the room's pick is "${pick}"`);
        if (!seen.final.includes(LABELS[pick])) problems.push(`${label}: ${robot.name}'s wheel announced "${seen.final}", want ${LABELS[pick]}`);
      }
      if (!seen.text) problems.push(`${label}: ${robot.name} never reached the first question after the wheel`);
      else if (!(seen.header || '').includes(LABELS[pick])) {
        problems.push(`${label}: ${robot.name}'s question header reads "${seen.header}", want the picked subject ${LABELS[pick]}`);
      }
    }
    return pick;
  }

  // ------------------------------------------------------------------ Draft
  heading('the host is offered Draft and Random, and makes a Draft room');
  const alice = await seat('Alice');
  // The availability check HANGS (a read that never comes back in time). The
  // buttons must be offered anyway: on 2026-11-18 the owner found them missing
  // with the live database fine, because any failed check used to hide them.
  table.store.slowReads('players', 20000);
  const badge = await hostWith(alice, '#btn-draft');
  if (badge !== null && badge !== 'Draft') problems.push(`the settings screen calls the choice "${badge}", want "Draft"`);
  note(`room: category=${roomOf('Alice')?.category} subcategory=${roomOf('Alice')?.subcategory}`);
  if (roomOf('Alice')?.subcategory !== '__draft__') problems.push('the room was not created as a Draft room');
  const code = await alice.textOf('#lobby-code');

  const bob = await seat('Bob');
  const carol = await seat('Carol');
  await join(bob, code);
  await join(carol, code);
  await alice.page.waitForTimeout(1500);

  for (const r of [alice, bob, carol]) {
    const label = (await r.textOf('#lobby-category') || '').trim();
    if (label !== 'Draft') problems.push(`${r.name}'s lobby card reads "${label}", want "Draft"`);
    if (!await r.page.locator('#draft-bar').isVisible().catch(() => false)) problems.push(`${r.name} has no draft bar in a Draft room`);
  }

  heading('a want is a block, and every phone sees it');
  await move(alice, 'science', 'want');
  if (seatRow('Alice')?.draft_move !== 'want:science') problems.push("Alice's want was not saved on her seat");
  await bob.page.waitForTimeout(800);
  let chip = await chipFor(bob, 'Science');
  if (!chip) problems.push("Bob cannot see Alice's move");
  else if (chip.state !== '×1' || chip.faces !== 1) problems.push(`Bob sees Science as ${JSON.stringify(chip)}, want ×1 with one face`);
  const mine = (await alice.textOf('#btn-draft-move') || '').trim();
  if (!/Science/.test(mine)) problems.push(`Alice's own button reads "${mine}" after her move`);

  heading('a ban takes a block off');
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
  if (afterChange.find(c => c.title === 'Science')?.state !== '×1') problems.push('Science did not return to ×1 when the ban moved away');
  if (afterChange.find(c => c.title === 'History')?.state !== 'out') problems.push('a banned category does not read "out"');

  heading('a move the database refuses comes back off the screen');
  // An ERROR, not a silent zero rows: a zero-row refusal re-reads the players
  // and would redraw correctly even if the screen never took the move back.
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
  if (refusedBtn !== 'Choose') problems.push(`Carol's move was refused and her button still reads "${refusedBtn}"`);
  if (refusedChip) problems.push('a refused move is still drawn as a chip');

  await move(carol, 'science', 'want');
  await alice.page.waitForTimeout(800);
  chip = await chipFor(alice, 'Science');
  if (chip?.state !== '×2' || chip?.faces !== 2) problems.push(`two wants on Science read ${JSON.stringify(chip)}, want ×2 with two faces`);

  heading('a move survives leaving and rejoining');
  // Leaving deletes the seat, and the move lived on it (owner, 2026-11-18).
  await carol.page.locator('#btn-leave').click().catch(() => {});
  await carol.page.waitForURL('**/join.html*', { timeout: 15000 }).catch(() => {});
  await alice.page.waitForTimeout(1000);
  if (seatRow('Carol')) note(`Carol's old seat is still there after Leave (${seatRow('Carol').draft_move})`);
  await join(carol, code);
  await alice.page.waitForTimeout(1500);
  if (seatRow('Carol')?.draft_move !== 'want:science') problems.push(`Carol left and rejoined and her seat holds "${seatRow('Carol')?.draft_move}", want her move "want:science" back`);
  chip = await chipFor(alice, 'Science');
  if (chip?.state !== '×2') problems.push(`after Carol rejoined, Alice sees Science as ${JSON.stringify(chip)}, want ×2`);

  heading('Start: one spin picks the subject, on every phone');
  for (const r of [bob, carol]) await r.page.click('#btn-ready').catch(() => {});
  await alice.page.waitForTimeout(600);
  const draftPhones = [bob, carol].map(robot => ({ robot, watching: null }));
  await alice.page.click('#btn-start-game');
  await Promise.all([bob, carol].map(r => r.page.waitForURL('**/game.html*', { timeout: 20000 })));
  for (const p of draftPhones) p.watching = watchWheel(p.robot);
  // History was banned and nobody wanted it: it has no chance, upset included.
  await checkStartedGame('Draft', 'Alice', draftPhones, ['history']);

  // ----------------------------------------------------------------- Random
  heading('Random: no moves, the same spin');
  const dan = await seat('Dan');
  const eve = await seat('Eve');
  const randomBadge = await hostWith(dan, '#btn-random');
  if (randomBadge !== null && randomBadge !== 'Random') problems.push(`the settings screen calls the choice "${randomBadge}", want "Random"`);
  if (roomOf('Dan')?.subcategory !== '__random__') problems.push('the room was not created as a Random room');
  await join(eve, await dan.textOf('#lobby-code'));
  await dan.page.waitForTimeout(1500);
  const eveLabel = (await eve.textOf('#lobby-category') || '').trim();
  if (eveLabel !== 'Random') problems.push(`a Random room's lobby card reads "${eveLabel}", want "Random"`);
  // A Random room has a bar too now: vetoes only (owner, 2026-11-17).
  if (!await eve.page.locator('#draft-bar').isVisible().catch(() => false)) problems.push('a Random room shows no veto bar');

  heading('the host switches Draft / Random and Spin in the lobby');
  async function lobbyPick(kind) {
    await dan.page.click('#btn-settings');
    await dan.page.click('#settings-category-tap');
    const offered = await dan.page.waitForSelector(`#lobby-spin-entries:not(.hidden) [data-spin-kind="${kind}"]`, { timeout: 8000 })
      .then(() => true).catch(() => false);
    if (!offered) { problems.push(`the lobby's category sheet does not offer ${kind}`); return; }
    await dan.page.click(`#lobby-spin-entries [data-spin-kind="${kind}"]`);
    await dan.page.waitForTimeout(800);
  }
  await lobbyPick('draft');
  if (roomOf('Dan')?.subcategory !== '__draft__') problems.push(`switching to Draft in the lobby stored ${roomOf('Dan')?.subcategory}`);
  await eve.page.waitForTimeout(800);
  if ((await eve.textOf('#lobby-category') || '').trim() !== 'Draft') problems.push("Eve's lobby card did not follow the switch to Draft");
  if (!await eve.page.locator('#draft-bar').isVisible().catch(() => false)) problems.push('Eve has no draft bar after the switch to Draft');
  const spinShown = await dan.page.locator('#settings-modal [data-spin-setting]').isVisible().catch(() => false);
  if (!spinShown) problems.push('the lobby settings do not show Spin in a Draft room');
  await dan.page.click('#settings-modal [data-setting="spinEvery"] [data-value="1"]').catch(() => {});
  await dan.page.waitForTimeout(600);
  if (roomOf('Dan')?.subcategory !== '__draft_each__') problems.push(`Spin: Every question in the lobby stored ${roomOf('Dan')?.subcategory}`);
  await dan.page.click('#btn-close-settings').catch(() => {});
  await lobbyPick('random');
  if (roomOf('Dan')?.subcategory !== '__random_each__') problems.push(`switching to Random kept Spin as ${roomOf('Dan')?.subcategory}, want __random_each__`);
  await dan.page.click('#settings-modal [data-setting="spinEvery"] [data-value="0"]').catch(() => {});
  await dan.page.waitForTimeout(600);
  if (roomOf('Dan')?.subcategory !== '__random__') problems.push(`Spin: Once in the lobby stored ${roomOf('Dan')?.subcategory}`);
  await dan.page.click('#btn-close-settings').catch(() => {});
  await eve.page.waitForTimeout(800);
  const eveBar = (await eve.textOf('#draft-bar .draft-bar__title') || '').trim();
  if (!/Random/.test(eveBar)) problems.push(`back in Random, Eve's bar reads "${eveBar}", want the Random veto bar`);

  heading('Random: a veto, never a want, and the vetoed subject cannot come up');
  await eve.page.click('#btn-draft-move');
  await eve.page.waitForSelector('#draft-sheet.active', { timeout: 5000 });
  await eve.page.click('[data-draft-category="history"]');
  const wantOffered = await eve.page.locator('[data-draft-kind="want"]').count();
  if (wantOffered) problems.push('a Random room offers "Want"; it has vetoes only');
  const vetoWord = (await eve.textOf('[data-draft-kind="ban"]') || '').trim();
  if (!/^🚫 Veto History$/.test(vetoWord)) problems.push(`the veto button reads "${vetoWord}", want "🚫 Veto History"`);
  await eve.page.click('[data-draft-kind="ban"]');
  await eve.page.waitForTimeout(700);
  if (seatRow('Eve')?.draft_move !== 'ban:history') problems.push(`Eve's veto stored ${seatRow('Eve')?.draft_move}`);

  await eve.page.click('#btn-ready').catch(() => {});
  await dan.page.waitForTimeout(600);
  const randomPhones = [{ robot: eve, watching: null }];
  await dan.page.click('#btn-start-game');
  await eve.page.waitForURL('**/game.html*', { timeout: 20000 });
  randomPhones[0].watching = watchWheel(eve);
  await checkStartedGame('Random', 'Dan', randomPhones, ['history']);

  // ------------------------------------------------- Spin: Every question
  heading('Spin: Every question — no opening wheel, a subject card before each question');
  const fay = await seat('Fay');
  const gus = await seat('Gus');
  await hostWith(fay, '#btn-random', { every: true });
  if (roomOf('Fay')?.subcategory !== '__random_each__') problems.push(`"Every question" was chosen and the room is stored as ${roomOf('Fay')?.subcategory}`);
  await join(gus, await fay.textOf('#lobby-code'));
  await fay.page.waitForTimeout(1500);
  const gusLabel = (await gus.textOf('#lobby-category') || '').trim();
  if (gusLabel !== 'Random') problems.push(`an every-question Random room's lobby card reads "${gusLabel}", want "Random"`);
  await gus.page.click('#btn-ready').catch(() => {});
  await fay.page.waitForTimeout(600);
  const eachPhones = [{ robot: gus, watching: null }];
  await fay.page.click('#btn-start-game');
  await gus.page.waitForURL('**/game.html*', { timeout: 20000 });
  eachPhones[0].watching = watchWheel(gus);
  await checkStartedGame('Every question', 'Fay', eachPhones, [], { every: true });

  // Play round 1 and watch question 2's header roll and land on ITS subject.
  const eachIds = roomOf('Fay')?.question_ids || [];
  const second = questionsById.get(eachIds[1]);
  if (second) {
    for (const r of [fay, gus]) {
      await r.page.waitForSelector('#answer-input', { state: 'visible', timeout: 20000 }).catch(() => {});
      await r.page.locator('#question-screen .wager-btn:not(.wager-btn--correct):not(.wager-btn--incorrect)').first().click({ timeout: 5000 }).catch(() => {});
      await r.page.fill('#answer-input', `${r.name} says`).catch(() => {});
      await r.page.click('#btn-submit-answer').catch(() => {});
    }
    // Watch Gus's subject card for question 2: what it rolled through, where it
    // landed, and when it went — the round's clock must not start before that.
    const rolling = gus.page.evaluate(() => new Promise(resolve => {
      const seen = { labels: [], kicker: null, landed: null, goneAt: 0 };
      const started = Date.now();
      const timer = setInterval(() => {
        const card = document.querySelector('#subject-card');
        const kicker = card?.querySelector('.subject-card__kicker')?.textContent.trim();
        const up = card && !card.classList.contains('hidden') && kicker === 'Question 2';
        if (up) {
          seen.kicker = kicker;
          const label = card.querySelector('.subject-card__label')?.textContent.trim();
          if (label && seen.labels[seen.labels.length - 1] !== label) seen.labels.push(label);
          if (card.classList.contains('subject-card--landed')) seen.landed = label;
        } else if (seen.kicker && !seen.goneAt) {
          seen.goneAt = Date.now();
          clearInterval(timer); resolve(seen);
        }
        if (Date.now() - started > 60000) { clearInterval(timer); resolve(seen.kicker ? seen : null); }
      }, 30);
    }));
    const until = Date.now() + 60000;
    while (Date.now() < until && (roomOf('Fay')?.current_question || 0) < 1) {
      for (const sel of ['#btn-next-question', '#btn-scores-action']) {
        const el = fay.page.locator(sel).first();
        if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) await el.click().catch(() => {});
      }
      await fay.page.waitForTimeout(700);
    }
    const seen = await rolling;
    const want = LABELS[second.categories[0]];
    note(`question 2 is ${second.categories[0]}; Gus's card showed: ${seen ? seen.labels.join(' → ') : 'nothing'}`);
    if (!seen) problems.push('Every question: Gus never saw a subject card for question 2');
    else {
      if (seen.landed !== want) problems.push(`Every question: question 2's card landed on "${seen.landed}", want ${want}`);
      if (seen.labels.length < 3) problems.push(`Every question: question 2's card did not roll (it showed ${seen.labels.length} label(s))`);
      // The clock: stamped after the card, so the card costs no answer time.
      await gus.page.waitForTimeout(1500);
      const stamp = Date.parse(roomOf('Fay')?.question_started_at || '');
      const early = seen.goneAt - stamp;
      note(`round 2's clock was stamped ${early > 0 ? `${early}ms BEFORE` : `${-early}ms after`} Gus's card went`);
      if (!(stamp > 0)) problems.push('Every question: round 2 has no clock stamp');
      else if (early > 400) problems.push(`Every question: round 2's clock started ${early}ms before the subject card went — the card ate answer time`);
      else if (early < -500) problems.push(`Every question: round 2 started ${-early}ms after its subject card went — a blank pause`);
    }
  } else {
    problems.push('Every question: the game has no second question to check');
  }

  console.log('\n' + (problems.length ? `FAILED — ${problems.length} problem(s):` : 'PASSED — Draft and Random work'));
  for (const p of problems) console.log('  ✗', p);
  process.exitCode = problems.length ? 1 : 0;
} catch (err) {
  for (const p of problems) console.log('  ✗', p);
  console.error('\nSCENARIO CRASHED:', err);
  process.exitCode = 1;
} finally {
  await table.close();
}
