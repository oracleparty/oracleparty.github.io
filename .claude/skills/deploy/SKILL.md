---
name: deploy
description: Ship the current work to the live Oracle Party site (GitHub Pages). Use only when the owner asks to deploy, ship, release or "put it live".
---

# Deploy Oracle Party

The live site is served from the branch `claude/setup-oracle-party-PHRgj`.
Pushing there changes what real players get, so do this only when the owner
has asked for a deploy in this conversation. An earlier go-ahead does not carry
over.

## Before anything

1. **Is SQL pending?** If this work includes a new migration, the owner must
   run it first, or the JavaScript must be proven safe without it (a scenario
   run with `--old-server` or `store.hideFunction`). If neither is true, stop
   and use `/sql-handover`.
2. `git status` is clean apart from the work being shipped.

## Checks (all must pass; show the output if one fails)

```bash
npm test
node scripts/layout-sweep.mjs
node scripts/layout-sweep.mjs --stress --themes=light
node scripts/check-arity.mjs
node scripts/check-rpc-args.mjs
```

If SQL or judging changed: `node scripts/verify-sql.mjs`.

Run the robot scenarios that cover what changed (`tests/harness/`). If the
engine in `js/game/` changed, run at least `scenario-fullgame`,
`scenario-nasty` and `scenario-playagain`. A scenario that passes proves
nothing until it has been seen to fail on the broken code.

## Version

```bash
node scripts/bump-version.js            # tag is today's date, e.g. 20261115
node scripts/bump-version.js 20261115b  # second deploy on the same day
```

The date-only form is a no-op the second time in a day; without a new tag the
service worker keeps serving the old files and the change appears to do
nothing. Check `CACHE_VERSION` in `sw.js` actually changed.

## Record and push

1. If a fault was fixed, add a dated entry at the top of `docs/HISTORY.md`
   (what was reported, the cause, how it was established, what check now
   fails on the old code). Update `CLAUDE.md` only if a rule, the
   architecture or an owner decision changed.
2. Commit with a message that says why, starting `Deploy <tag>:`.
3. Push the session's own branch, then the live branch:

```bash
git push -u origin <session-branch>
git push origin HEAD:claude/setup-oracle-party-PHRgj
```

If the live branch has commits this branch lacks, fetch and merge them first.
Never force-push the live branch.

## After

CI is part of done. Use the GitHub Actions tools to watch the three workflows
on the pushed commit: `ci.yml` (tests, SQL parity), `robots.yml` (three jobs),
`db-probe.yml` (the live database). Read the probe's "WHAT THIS MEANS FOR A
PLAYER" section. Report to the owner in plain language: what is live, the
version tag, and anything red, with its output.

If the owner's phone shows "Connection issue" after a deploy, it is a stale
mix of saved files; the boot guard repairs once on reload.
