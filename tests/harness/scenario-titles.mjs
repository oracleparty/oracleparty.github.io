// Scenario: the Title Builder's pairing rule (owner, 2026-10-30).
//
// A rank (reel 3) may only sit beside a reel-2 word whose SUBJECT you have
// reached that step in — "Organelle Oracle" must mean you conquered Science.
// Nothing had ever driven the builder before this, so the rule is checked here
// on the real page rather than only as arithmetic.
//
// Dana is a Hermit in Science (a quarter of Space right) and only a Caveman in
// History. Her saved title is "Chronicles Hermit", which the rule forbids, so:
//
//   1. on arrival the rank steps DOWN to Caveman rather than vanishing;
//   2. Hermit stays in the column, padlocked, and says why;
//   3. picking a Science word lets Hermit pair again.
//
// Run: node tests/harness/scenario-titles.mjs
import { PlaytestTable } from './harness.js';

const problems = [];
const note = m => console.log('   ·', m);

const table = await PlaytestTable.open();

try {
  // 86 askable Space questions make a quarter (22) the Hermit goal, and the
  // fake get_topic_sizes counts them exactly as the live one does.
  const qs = [];
  for (let i = 1; i <= 86; i++) {
    qs.push({ id: `sp${i}`, question: `Space ${i}?`, correct_answer: `A${i}`, acceptable_answers: [],
      categories: ['science'], subcategory: 'space', difficulty: 'medium', format: 'open',
      fun_fact: null, discarded: false });
  }
  for (let i = 1; i <= 30; i++) {
    qs.push({ id: `hi${i}`, question: `History ${i}?`, correct_answer: `B${i}`, acceptable_answers: [],
      categories: ['history'], subcategory: 'ancient', difficulty: 'medium', format: 'open',
      fun_fact: null, discarded: false });
  }
  table.store.seed('questions', qs);

  const dana = await table.seatSignedIn('Dana');
  const row = (category, subcategory, right) => ({
    id: `st-${category}-${subcategory || 'all'}`, user_id: dana.userId, category, subcategory,
    questions_answered: right, correct_answers: right, questions_met: right, questions_mastered: right,
    games_played: 3, wins: 1,
  });
  table.store.seed('player_stats_computed', [
    row('science', null, 25), row('science', 'space', 22),
    row('history', null, 15), row('history', 'ancient', 15),
  ]);
  table.store.seed('title_unlocks', ['science', 'chronicles', 'caveman', 'hermit'].map((w, i) => ({
    id: i + 1, user_id: dana.userId, word_id: w, level: 1, unlocked_at: new Date().toISOString(),
  })));
  const profile = table.store.table('profiles').find(p => p.user_id === dana.userId);
  Object.assign(profile, { title_builder_unlocked: true, title_slot2: 'chronicles', title_slot3: 'hermit' });

  await dana.goto('profile.html');
  await dana.page.waitForSelector('#wheel-slot3 .title-wheel-item', { timeout: 15000 });

  const read = () => dana.page.evaluate(() => ({
    preview: document.querySelector('#title-preview')?.textContent,
    hermitCapped: !!document.querySelector('#wheel-slot3 .title-wheel-item--capped'),
    cappedHint: document.querySelector('#wheel-slot3 .title-wheel-item--capped')?.dataset.hint || null,
    hermitPickable: !!document.querySelector('#wheel-slot3 [data-word-id="hermit"]'),
  }));

  const before = await read();
  note(`with Chronicles: ${JSON.stringify(before)}`);
  if (before.preview !== 'Chronicles Caveman') {
    problems.push(`a History word kept a rank Dana only holds in Science — the title reads "${before.preview}", want "Chronicles Caveman"`);
  }
  if (!before.hermitCapped || before.hermitPickable) {
    problems.push('Hermit can be worn beside a History word although Dana is only a Caveman in History');
  }
  if (before.cappedHint && !/History/.test(before.cappedHint)) {
    problems.push(`the padlocked rank does not say which subject it needs: "${before.cappedHint}"`);
  }

  await dana.page.click('#wheel-slot2 [data-word-id="science"]');
  const after = await read();
  note(`with Science: ${JSON.stringify(after)}`);
  if (after.hermitCapped || !after.hermitPickable) {
    problems.push('Hermit stayed locked beside a Science word, the subject Dana earned it in');
  }
} catch (err) {
  problems.push(`threw: ${err.message.split('\n')[0]}`);
} finally {
  await table.close();
}

console.log('\n' + (problems.length ? '✗ PROBLEMS:' : '✓ titles scenario passed'));
for (const p of problems) console.log('  -', p);
process.exit(problems.length ? 1 : 0);
