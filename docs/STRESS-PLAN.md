# Robot stress playtest — plan (owner away, 2026-11-06)

The owner cannot reply for the rest of this session. They asked for a robot
stress playtest: play whole robot games under bad conditions, find
game-breaking bugs before friends hit them, fix them, add a check so each one
cannot come back. Work through the list in order; stop and report when time runs out.

## Scenarios (in priority order)

1. **One phone on a slow link all game** — `scenario-badnetwork --lag=800/1500/3000 --on=Bob`
   and `--on=Alice` (host). Run each 3x. Note any stall, wrong screen, or "Waiting…" after reveal.
2. **Last-second answers every round** — extend `scenario-latesubmit`: every round, a
   different player submits in the final second with `store.slowFunction('op_submit_answer', 5000)`.
   Include the FINAL round (locked wager, +15s clock) and a non-host.
3. **A phone backgrounded mid-question** — page hidden (visibilitychange) for 10–60s
   across round close, then visible. Must land on the room's phase; draft (081) must carry text.
4. **Refresh mid-game** — reload a player AND the host at: question, reveal, scores,
   final wager, final question. Score, wagers and screen must match the room.
5. **Host leaves mid-game** — host closes tab at each phase; room must keep going
   (deputy / promotion), nobody stuck.
6. **Several games in one room** — `scenario-sitting --games=4`, plus with `--lag=800 --on=Bob`.

## Rules while the owner is away

- A bug counts only if REPRODUCED by a robot. Reproduce → fix → break-test the check
  (revert fix, watch it fail; restore from a `cp` backup, never `git checkout` a file).
- Fix only game-breakers and wrong scores/screens. No design changes, no new features,
  no wording changes, no SQL migrations (the owner cannot run them). If a fix needs SQL,
  write it down here instead.
- Before any push: `npx vitest run`, `node scripts/check-rpc-args.mjs`,
  `node scripts/check-arity.mjs`, and the robot scenarios touching the change.
  Then `node scripts/bump-version.js <date+letter>` and push to `claude/setup-oracle-party-PHRgj`.
- A new permanent check goes in `.github/workflows/robots.yml` only if it is stable (3 passes).
- Record every finding — fixed or not — in the Results section below and a short
  CLAUDE.md entry in the same commit.

## Results

(fill in as you go: scenario, what happened, fixed? how proven)
