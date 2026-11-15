---
name: sql-handover
description: Write a database migration for Oracle Party and hand it to the owner to run by hand in the Supabase SQL Editor, with a verification query. Use whenever a change needs new SQL (a table, column, function, policy or grant).
---

# Write a migration and hand it over

Migrations are pasted by the owner into the Supabase SQL Editor. Nothing here
can reach the live database, and nothing records what ran. The owner is not a
coder and will not run SQL more than once for one change, so everything must
be settled and proven before they see it.

## 1. Enumerate before writing

- Grep `js/` for **every** read and write of each table you touch. A revoked
  permission silently breaks writers nobody listed (it has, several times).
- Confirm every column you depend on exists live: check the latest
  `db-probe` CI output, not `migrations/`. The live schema differs from the
  files in both directions.
- Decide what the app does **before** the SQL is run. The JavaScript ships
  first or separately, so the client wrapper must tell "not installed"
  (PGRST202: take the old path or hide the feature) from "failed" (tell the
  player, revert the screen). A fallback that costs a round trip on a slow
  link is not free; preflight once if needed.

## 2. Write `migrations/NNN_what_it_does.sql`

- `CREATE OR REPLACE`, `IF NOT EXISTS`, idempotent throughout.
- Functions are `SECURITY DEFINER` with the rule inside them. A guest has an
  anonymous `auth.uid()`; a rule that must work for everyone is usually about
  the room's own state, not the caller's identity.
- **New table:** `REVOKE ALL ON t FROM anon, authenticated;` then the grants
  you mean (Supabase default privileges grant everything). If any phone
  listens to it, `ALTER PUBLICATION supabase_realtime ADD TABLE t;`.
- **Column grants** exist on `rooms` and `players`: a new client-written
  column needs its own `GRANT UPDATE (col)`.
- Never `DROP POLICY` by name. Loop over `pg_policies` where
  `schemaname = 'public'` and `cmd IN ('X','ALL')`. Check `roles` too.
- `now()` is transaction time. Regex word boundary is `\y`. No extensions.
  No inline comment between parameters in a function's argument list.
- No `ON CONFLICT` unless the unique index is known to exist live.

## 3. Prove it locally

- Add the file to the migration list in `scripts/verify-sql.mjs`.
- Write rules in `tests/sql/game-rules.sql` **before** the fix where possible:
  `check | got | want`, both halves (the refusal holds AND the legitimate path
  still works).
- `node scripts/verify-sql.mjs` (a local Postgres 16 is available).
- Break the migration on a copy and watch named rules fail.
- Mirror the behaviour in `tests/harness/store.js` (`_rpc`, `_shutDoors`,
  `_columnGrants`, and `_broadcast` for anything touching `rooms` or
  `answers`), or the robots keep allowing what the database now refuses.
- `node scripts/check-rpc-args.mjs`: argument names must match the client's.
- Add the function or column to `scripts/probe-db.mjs` (both the probed list
  and the consequence list) so CI reports it missing.

## 4. Hand over, once

Give the owner, in chat:

1. **One paste**: every statement for this change, comments stripped, in a
   single code block labelled "Run this".
2. **One verification query**, in a second block labelled "Then run this":
   a plain `SELECT` returning one row per rule with `ok` or `FAIL`, reading
   the real catalogue (`pg_proc.prosrc` for words that only the new function
   contains, `pg_policies`, `has_column_privilege`, `pg_publication_tables`).
   Never `RAISE NOTICE`; the editor may not show it. A partial paste must
   read `FAIL`.
3. What the result should look like, described in a sentence or shown as a
   table that is clearly marked **"do not run this, it is only what you
   should see"**.
4. One sentence on what changes for players, and whether to run it before or
   after the deploy.

Confirm every value by name with the owner before it goes into SQL. A reply
to a table is not agreement to every cell.

## 5. Record

When the owner reports the result, add it to the entry in `docs/HISTORY.md`
with its evidence level: pasted rows, "reported ok, not pasted", or measured
by the CI probe. Do not write "applied" on anything weaker.
