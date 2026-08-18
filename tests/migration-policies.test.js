// ============================================
// Migration policy lint — catches an RLS predicate that can never match.
//
// Migration 024 granted admins the right to edit questions with:
//
//     EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_admin)
//
// profiles carries both an `id` and a `user_id`, and it is `user_id` that
// holds the authenticated user's id. So the predicate matched no row, for
// anybody, and the migration silently did nothing -- admin question edits went
// on being discarded by RLS with zero rows and no error, which is the exact
// bug that migration was written to fix. Migrations 003, 007, 009, 011, 018
// and 019 all get this right; 024 was the one that did not.
//
// A wrong RLS predicate is invisible from the outside: the database accepts
// the policy, the dashboard lists it, and writes simply keep failing silently.
// Nothing else in this project can catch that -- the unit tests never touch
// SQL, and the live probe runs as an anonymous visitor, who is correctly
// denied either way.
//
// This is a lint, not a SQL parser. It resolves the alias bound to `profiles`
// in each FROM clause and then looks for that alias comparing `.id` to
// auth.uid(). Both halves are literal string work on text this project
// controls, so the check is narrow enough to be provably sound: it can only
// fire on a real `<profiles alias>.id = auth.uid()`.
// ============================================

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(import.meta.dirname, '..', 'migrations');
const sqlFiles = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'));

// Strip `--` line comments so the explanation of the bug at the top of
// migration 028 is not itself reported as the bug.
const stripComments = sql => sql.replace(/--[^\n]*/g, '');

/**
 * Every alias bound to the profiles table, plus the bare table name.
 * `FROM profiles p` -> "p";  `FROM profiles` -> "profiles";  also `AS p`.
 */
function profileAliases(sql) {
  const aliases = new Set(['profiles']);
  const re = /\bfrom\s+profiles\s+(?:as\s+)?([a-z_][a-z0-9_]*)/gi;
  for (const m of sql.matchAll(re)) {
    const alias = m[1].toLowerCase();
    // `FROM profiles WHERE ...` — the next word is a keyword, not an alias.
    if (['where', 'on', 'join', 'inner', 'left', 'right', 'group', 'order',
         'limit', 'having', 'union', 'using', 'and', 'or'].includes(alias)) continue;
    aliases.add(alias);
  }
  return aliases;
}

describe('migration RLS policies', () => {
  for (const file of sqlFiles) {
    it(`${file}: compares auth.uid() to profiles.user_id, never profiles.id`, () => {
      const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
      if (!/\bprofiles\b/i.test(sql) || !/auth\.uid\(\)/i.test(sql)) return;

      const offenders = [];
      for (const alias of profileAliases(sql)) {
        const re = new RegExp(`\\b${alias}\\.id\\s*=\\s*auth\\.uid\\(\\)`, 'gi');
        for (const m of sql.matchAll(re)) offenders.push(m[0]);
      }

      expect(offenders, [
        `${file} matches auth.uid() against profiles.id.`,
        'profiles.user_id holds the auth user id; profiles.id is a separate',
        'column, so this predicate matches no row and the policy silently',
        'grants nothing.',
      ].join(' ')).toEqual([]);
    });
  }

  it('finds the migrations it is meant to be reading', () => {
    // A rename or a moved directory would make every check above vacuously
    // pass. Assert the corpus is really there.
    expect(sqlFiles.length).toBeGreaterThan(20);
    expect(sqlFiles).toContain('024_alternates_playcounts_admin.sql');
  });

  it('catches the exact predicate migration 024 shipped', () => {
    const bad = 'CREATE POLICY x ON questions FOR UPDATE USING (EXISTS ('
      + 'SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_admin));';
    const found = [...profileAliases(bad)]
      .flatMap(a => [...bad.matchAll(new RegExp(`\\b${a}\\.id\\s*=\\s*auth\\.uid\\(\\)`, 'gi'))]);
    expect(found.length).toBe(1);

    const good = bad.replace('p.id =', 'p.user_id =');
    const stillFound = [...profileAliases(good)]
      .flatMap(a => [...good.matchAll(new RegExp(`\\b${a}\\.id\\s*=\\s*auth\\.uid\\(\\)`, 'gi'))]);
    expect(stillFound.length).toBe(0);
  });
});
