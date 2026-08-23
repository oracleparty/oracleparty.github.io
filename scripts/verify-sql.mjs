#!/usr/bin/env node
// ============================================
// Oracle Party — does the SERVER judge an answer the same way the SCREEN does?
//
// The game is moving off the host's phone (CLAUDE.md #1). The first thing to
// move is the verdict on an answer, and that creates a danger this project has
// never had before: TWO implementations of the same rule. The player watches
// js/utils.js decide green or red; the score comes from op_answer_matches in
// migration 045. If those two ever disagree, the screen and the scoreboard tell
// a player different things about the same answer — which is worse than the
// bug being fixed.
//
// So they are not maintained as two things that ought to agree. This script
// runs several thousand cases through BOTH and fails on any disagreement.
//
// Usage:
//   node scripts/verify-sql.mjs                 # starts a throwaway Postgres
//   PGURL=postgres://... node scripts/verify-sql.mjs
//
// It needs a Postgres binary (any 12+) or a URL. It NEVER touches the live
// project: it applies the migrations to a scratch database and nothing here
// knows the Supabase credentials.
// ============================================

import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// js/utils.js registers online/offline listeners at import time, so it cannot
// be loaded in bare Node without a window to register them on. The unit tests
// get one from jsdom; this script is a standalone process, so it stubs the two
// things touched before any function in the file is called. Everything used
// here — fuzzyMatch, normalizeAnswer, levenshteinDistance — is pure.
const noop = () => {};
globalThis.window ??= { addEventListener: noop, removeEventListener: noop };
globalThis.document ??= { body: { classList: { remove: noop }, style: {} }, addEventListener: noop };
const { fuzzyMatch, normalizeAnswer, levenshteinDistance } = await import('../js/utils.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Migrations this script needs applied. Deliberately a list rather than "every
// .sql in the folder": most of them touch tables that do not exist in a scratch
// database, and a run that half-applies is worse than one that will not start.
const MIGRATIONS = [
  '045_server_judges_answers.sql',
  '046_server_records_answers.sql',
  '047_server_owns_the_clock.sql',
];

// 046 touches rooms, players and answers, none of which any migration in this
// repo creates — they predate the folder (CLAUDE.md #7). tests/sql/scratch-schema.sql
// is an approximation built from the column list probe-db.mjs checks against
// the live database, and it is applied first so the functions have something to
// compile against.
const SCHEMA = 'tests/sql/scratch-schema.sql';

// Rules stated as data: every row is `check | got | want`, and any row where
// the two differ is a failure that names the rule rather than a line number.
const RULES = 'tests/sql/game-rules.sql';

// ============================================
// A scratch database
// ============================================

let cleanup = () => {};

function startScratchPostgres() {
  const bin = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/15/bin', '/usr/lib/postgresql/14/bin']
    .find(p => existsSync(join(p, 'initdb')));
  if (!bin) return null;

  const dir = mkdtempSync(join(tmpdir(), 'op-pg-'));
  const data = join(dir, 'data');
  const port = 55432 + Math.floor(Math.random() * 200);
  // Postgres refuses to run as root, so when we are root it runs as `postgres`.
  const asPg = process.getuid && process.getuid() === 0;
  const run = (cmd) => execSync(asPg ? `su postgres -s /bin/bash -c ${JSON.stringify(cmd)}` : cmd,
    { stdio: 'pipe' });

  execSync(`mkdir -p ${data}`);
  if (asPg) execSync(`chmod 711 ${dir} && chown postgres:postgres ${data} && chmod 700 ${data}`);

  run(`${bin}/initdb -D ${data} -U postgres --auth=trust`);
  // The socket goes in the DATA directory, not the temp directory above it.
  // When this script runs as root the server runs as `postgres`, which can
  // traverse the outer directory but not write to it, so the postmaster dies on
  // "could not create lock file" before it ever listens.
  run(`${bin}/pg_ctl -D ${data} -o '-p ${port} -k ${data}' -l ${data}/log start -w`);
  cleanup = () => {
    try { run(`${bin}/pg_ctl -D ${data} -m immediate stop`); } catch { /* going away anyway */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ditto */ }
  };
  return { host: data, port };
}

function psql(conn, sql, opts = {}) {
  const args = conn.url
    ? [conn.url]
    : ['-h', conn.host, '-p', String(conn.port), '-U', 'postgres', '-d', 'postgres'];
  return execFileSync('psql', [...args, '-v', 'ON_ERROR_STOP=1', '-tAF', '|', '-c', sql], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', opts.quiet ? 'pipe' : 'inherit'],
  });
}

function psqlFile(conn, file) {
  const args = conn.url
    ? [conn.url]
    : ['-h', conn.host, '-p', String(conn.port), '-U', 'postgres', '-d', 'postgres'];
  return execFileSync('psql', [...args, '-v', 'ON_ERROR_STOP=1', '-q', '-f', file], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
}

// Same as psqlFile, but returns the rows. Used for the game-rules script,
// which reports by emitting `check | got | want` rather than by raising.
function psqlFileTuples(conn, file) {
  const args = conn.url
    ? [conn.url]
    : ['-h', conn.host, '-p', String(conn.port), '-U', 'postgres', '-d', 'postgres'];
  // -q matters: without it psql echoes a command tag for every statement
  // ("CREATE TABLE", "DO"), and those lines were being counted as rules that
  // passed — the reported total was two higher than the number of rules that
  // exist, and any malformed row would have passed the same way.
  return execFileSync('psql', [...args, '-v', 'ON_ERROR_STOP=1', '-q', '-tAF', '|', '-f', file], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'],
  });
}

// ============================================
// The cases
//
// Two kinds, and both matter. The hand-written ones are the RULES — every
// behaviour CLAUDE.md or a playtest ever pinned down. The generated ones are
// the volume: real answers put through the mutations a person actually makes.
// ============================================

const ANSWERS = [
  'Napoleon', 'Marie Antoinette', 'The Beatles', 'São Paulo', "Côte d'Ivoire",
  'World War 2', 'Apollo 13', '1996', '1969', 'US', 'cat', 'a', 'oxygen',
  'Mount Kilimanjaro', 'Leonardo da Vinci', 'The Great Gatsby', 'photosynthesis',
  'John Wilkes Booth', 'Nelson Mandela', 'Tokyo', 'Zeus', 'mitochondria',
  'The Rolling Stones', 'Pride and Prejudice', 'hydrogen', 'Australia',
  '3.14', '42', '1 million', '2 bil', 'Jose Mourinho', 'Beyoncé', 'crème brûlée',
  'Federico Fellini', 'an apple', 'the Nile', 'DNA', 'CO2', 'H2O', 'JFK',
];

const KEYBOARD = 'abcdefghijklmnopqrstuvwxyz';

function mutate(s, rand) {
  const kind = Math.floor(rand() * 9);
  if (s.length === 0) return s;
  const at = Math.floor(rand() * s.length);
  switch (kind) {
    case 0: return s.toUpperCase();
    case 1: return s.toLowerCase();
    case 2: return `  ${s}  `;
    case 3: return s.slice(0, at) + s.slice(at + 1);                     // deletion
    case 4: return s.slice(0, at) + KEYBOARD[Math.floor(rand() * 26)] + s.slice(at); // insertion
    case 5: return s.slice(0, at) + KEYBOARD[Math.floor(rand() * 26)] + s.slice(at + 1); // substitution
    case 6: return s.replace(/[aeiou]/i, 'e');
    case 7: return s.split(/\s+/).slice(-1)[0];                          // surname only
    case 8: return s.replace(/[^\w\s]/g, '') + '.';
    default: return s;
  }
}

function buildCases() {
  // The rules, stated as cases. Each is here because something went wrong once.
  const fixed = [
    ['Napoleon', 'Napoleon', []],
    ['  napoleon  ', 'Napoleon', []],
    ['napolean', 'Napoleon', []],
    ['bat', 'cat', []],                       // single-letter answers were ungradeable
    ['up', 'US', []],
    ['US', 'US', []],
    ['1994', '1996', []],                     // digits never fuzzy-match
    ['Appollo 13', 'Apollo 13', []],
    ['Apollo 14', 'Apollo 13', []],
    ['Antoinette', 'Marie Antoinette', []],   // surname stands for the whole name
    ['Marie', 'Marie Antoinette', []],
    ['Booth', 'John Wilkes Booth', []],
    ['Sao Paulo', 'São Paulo', []],           // accents fold, not strip
    ['Cote dIvoire', "Côte d'Ivoire", []],
    ['beatles', 'The Beatles', []],           // leading article
    ['the beatles', 'Beatles', []],
    ['nyc', 'New York', ['NYC', 'New York City']],
    ['', 'Napoleon', []],
    ['   ', 'Napoleon', []],
    ['2 bil', '2 billion', []],               // numeric abbreviations expand
    ['3 k', '3 thousand', []],
    ['h2o', 'H2O', []],
    ['water', 'H2O', ['water']],
    ['a', 'a', []],
    ['x', 'a', []],
  ];

  // Deterministic pseudo-random, so a failure is reproducible from the seed
  // printed in the output rather than being a different run every time.
  let seed = Number(process.env.SEED || 20260823);
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const generated = [];
  for (const correct of ANSWERS) {
    for (let i = 0; i < 30; i++) {
      let submitted = correct;
      const rounds = 1 + Math.floor(rand() * 3);
      for (let r = 0; r < rounds; r++) submitted = mutate(submitted, rand);
      generated.push([submitted, correct, []]);
    }
    // ...and against a DIFFERENT answer, which is the half that catches a rule
    // that is too generous. A judge that says yes to everything passes every
    // typo case ever written.
    //
    // The generated half earns its keep. Removing the accent fold from the SQL
    // does NOT break the hand-written 'Sao Paulo' / 'São Paulo' case — without
    // folding, "so paulo" and "sao paulo" are one edit apart and the fuzzy
    // tolerance covers it, so the case passes for the wrong reason. What caught
    // it was a mutated "Se Pauo.", where the two implementations disagree
    // because they are working from different normalised strings. A rule can be
    // broken in a way every case written to describe it still passes.
    for (const other of ANSWERS) {
      if (other !== correct && rand() < 0.25) generated.push([other, correct, []]);
    }
  }
  return { cases: [...fixed, ...generated], seed: Number(process.env.SEED || 20260823) };
}

// ============================================
// Run
// ============================================

const lit = s => `'${String(s).replace(/'/g, "''")}'`;
const arrLit = a => a.length === 0
  ? `ARRAY[]::text[]`
  : `ARRAY[${a.map(lit).join(',')}]::text[]`;

function main() {
  let conn;
  if (process.env.PGURL) {
    conn = { url: process.env.PGURL };
  } else {
    const started = startScratchPostgres();
    if (!started) {
      console.error('No Postgres available. Install one, or set PGURL to a scratch database.');
      console.error('This never runs against the live project — do not point PGURL at it.');
      process.exit(2);
    }
    conn = started;
  }

  try {
    // Supabase's roles do not exist in a scratch database and the GRANTs at the
    // end of every migration name them.
    psql(conn, `DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
    END $$;`, { quiet: true });

    psqlFile(conn, join(ROOT, SCHEMA));
    for (const m of MIGRATIONS) {
      const p = join(ROOT, 'migrations', m);
      if (!existsSync(p)) { console.error(`missing migration: ${m}`); process.exit(2); }
      psqlFile(conn, p);
    }

    const { cases, seed } = buildCases();
    console.log(`${cases.length} cases, seed ${seed}`);

    // One statement, not one per case: a round trip each would take minutes and
    // nobody would run it.
    const values = cases
      .map(([s, c, alts], i) => `(${i}, ${lit(s)}, ${lit(c)}, ${arrLit(alts)})`)
      .join(',\n');
    const out = psql(conn, `
      SELECT i, op_answer_matches(sub, corr, alts)
      FROM (VALUES ${values}) AS t(i, sub, corr, alts)
      ORDER BY i;`);

    const sqlVerdict = new Map();
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [i, v] = line.split('|');
      sqlVerdict.set(Number(i), v === 't');
    }

    const mismatches = [];
    for (let i = 0; i < cases.length; i++) {
      const [sub, corr, alts] = cases[i];
      const js = fuzzyMatch(sub, corr, alts);
      const sql = sqlVerdict.get(i);
      if (sql === undefined) { mismatches.push({ sub, corr, alts, js, sql: '(no row)' }); continue; }
      if (js !== sql) mismatches.push({ sub, corr, alts, js, sql });
    }

    if (mismatches.length) {
      console.error(`\n✗ ${mismatches.length} of ${cases.length} judged differently by the screen and the server:\n`);
      for (const m of mismatches.slice(0, 40)) {
        console.error(`  "${m.sub}" vs "${m.corr}"${m.alts.length ? ` (+${m.alts.length} alt)` : ''}`);
        console.error(`     js=${m.js}  sql=${m.sql}   normalised js="${normalizeAnswer(m.sub)}" / "${normalizeAnswer(m.corr)}"`);
      }
      if (mismatches.length > 40) console.error(`  ... and ${mismatches.length - 40} more`);
      process.exit(1);
    }

    // Normalisation and distance are checked in their own right too. A judge
    // can agree on every verdict while normalising differently, and the next
    // rule added on top of it would then diverge for reasons nobody could see.
    const normCases = [...new Set(cases.flatMap(c => [c[0], c[1]]))];
    const normOut = psql(conn, `
      SELECT i, op_normalize(s)
      FROM (VALUES ${normCases.map((s, i) => `(${i}, ${lit(s)})`).join(',')}) AS t(i, s)
      ORDER BY i;`);
    const normBad = [];
    for (const line of normOut.split('\n')) {
      if (!line.trim() && line !== '') continue;
      const idx = line.indexOf('|');
      if (idx === -1) continue;
      const i = Number(line.slice(0, idx));
      const sql = line.slice(idx + 1);
      const js = normalizeAnswer(normCases[i]);
      if (js !== sql) normBad.push({ raw: normCases[i], js, sql });
    }
    if (normBad.length) {
      console.error(`\n✗ ${normBad.length} strings normalise differently:\n`);
      for (const b of normBad.slice(0, 20)) {
        console.error(`  "${b.raw}"  js="${b.js}"  sql="${b.sql}"`);
      }
      process.exit(1);
    }

    const distPairs = cases.slice(0, 400).map(c => [normalizeAnswer(c[0]), normalizeAnswer(c[1])]);
    const distOut = psql(conn, `
      SELECT i, op_levenshtein(a, b)
      FROM (VALUES ${distPairs.map(([a, b], i) => `(${i}, ${lit(a)}, ${lit(b)})`).join(',')}) AS t(i, a, b)
      ORDER BY i;`);
    const distBad = [];
    for (const line of distOut.split('\n')) {
      if (!line.trim()) continue;
      const [i, v] = line.split('|');
      const [a, b] = distPairs[Number(i)];
      const js = levenshteinDistance(a, b);
      if (js !== Number(v)) distBad.push({ a, b, js, sql: Number(v) });
    }
    if (distBad.length) {
      console.error(`\n✗ ${distBad.length} edit distances differ:\n`);
      for (const b of distBad.slice(0, 20)) console.error(`  "${b.a}" / "${b.b}"  js=${b.js} sql=${b.sql}`);
      process.exit(1);
    }

    console.log(`✓ the server and the screen judge all ${cases.length} the same way`);
    console.log(`✓ ${normCases.length} normalisations and ${distPairs.length} edit distances agree`);

    // ---- the game rules ---------------------------------------------------
    const rulesOut = psqlFileTuples(conn, join(ROOT, RULES));
    const ruleRows = rulesOut.split('\n').filter(l => l.trim()).map(l => l.split('|'));
    // Anything that is not exactly `check | got | want` is a broken fixture,
    // not a rule. Left as-is it counts as a rule whose got and want are both
    // undefined, which passes — a line the script cannot read must never be
    // read as good news.
    const malformed = ruleRows.filter(r => r.length !== 3);
    if (malformed.length) {
      console.error(`\n✗ ${malformed.length} line(s) from the rules script are not check|got|want:\n`);
      for (const m of malformed.slice(0, 10)) console.error(`  ${JSON.stringify(m.join('|'))}`);
      process.exit(1);
    }
    const broken = ruleRows.filter(([, got, want]) => got !== want);
    if (broken.length) {
      console.error(`\n✗ ${broken.length} of ${ruleRows.length} game rules do not hold:\n`);
      for (const [name, got, want] of broken) {
        console.error(`  ${name}\n     got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
      }
      process.exit(1);
    }
    if (ruleRows.length === 0) {
      console.error('\n✗ the game-rules script produced no rows at all — it did not run');
      process.exit(1);
    }
    console.log(`✓ all ${ruleRows.length} game rules hold`);
  } finally {
    cleanup();
  }
}

main();
