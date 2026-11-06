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
  no wording changes.
- **SQL is allowed** (the owner pastes it later). A new migration must: pass
  `node scripts/verify-sql.mjs` with new rules that fail when the fix is reverted; end
  with a SELECT verification (one row per rule, `ok`); be added to verify-sql's list;
  and come with a comment-stripped copy in the scratchpad ready to paste. **The JS must
  stay safe BEFORE the SQL is run** (detect the missing function and fall back) — the
  deploy goes live before the owner pastes anything. List every pending migration at
  the top of Results.
- Before any push: `npx vitest run`, `node scripts/check-rpc-args.mjs`,
  `node scripts/check-arity.mjs`, and the robot scenarios touching the change.
  Then `node scripts/bump-version.js <date+letter>` and push to `claude/setup-oracle-party-PHRgj`.
- A new permanent check goes in `.github/workflows/robots.yml` only if it is stable (3 passes).
- Record every finding — fixed or not — in the Results section below and a short
  CLAUDE.md entry in the same commit.

## Results (2026-11-06, run unattended)

**Pending migrations: NONE.** Every fix below is JavaScript; nothing needs
pasting into the SQL editor.

**Six faults found and fixed (five in the run, a sixth as a follow-up), each reproduced by a robot, each break-tested**
(the fix reverted, the check watched failing, the fix restored from a `cp`
backup). Full regression afterwards: all 30 runs of every CI robot plus the
new ones green on the final code.

| # | Scenario | What happened | Fixed | How proven |
|---|---|---|---|---|
| 1 | Slow phone all game (`badnetwork` 800/1500/3000 x Bob/Alice x 3) | 800ms: 6/6 clean. Bob 1500: 3/3 clean. **Alice (host) 1500: 3/3 FROZE at round 3** — host back on round 3's scoreboard, the room re-asking round 3, Next refused for good. Alice 3000: one backwards jump on the final round. Bob 3000: "never showed the scoreboard" — the robot host presses Next 2.8s into each scoreboard, shorter than Bob's 3s read; refusing to draw a late scoreboard over the next question is the 10-23 design, not a fault. The other 3000ms "failures" were the app's own `[SlowSubmit]` recorder counted as errors (the scenario now ignores it). | **Yes** — see A | `scenario-staleresync` (new) forces the re-read on every Next at 1500ms: old code 8 backwards jumps by name, fixed code clean; `badnetwork` host 1500 3/3 and 3000 3/3 clean after |
| 2 | Last-second answers every round (`lastsecond`, new: host, guests, final round; "fast" and "paused" typists; 7s server hold) | Nobody stranded, drafts kept the text AND the bet, every late phone's own row honest, boards agree with the rows. **But the bet buttons drifted after every refused late answer** (9 disagreements per game): the phone offered a bet the server had spent, and the server silently swapped the next pick. | **Yes** — see B | with the reconcile off: the same 9 disagreements |
| 3 | Phone in a pocket (`background`, new; harness `goToBackground`/`comeBack`) — typed, never pressed Submit, away 10-60s, frozen or running, slow on return | Typed text always carried (it is sent as the phone leaves). **Three faults, all from timers held while away and run on return:** the HOST's held round timer closed the room's NEWER round 12s early for everybody; a returning PLAYER's late auto-submit filed its old round's answer and bet in the new round's slot, spending one bet twice; and (found in the trace) `[AnswerNotMine]` filed a false report on EVERY deliberate Submit since 11-03. | **Yes** — see C, D, E | each break-tested: "round 2 closed 12s BEFORE its clock ran out"; "Bob spent bet 2 more than once: [1,2,2,3,4]"; "17 false [AnswerNotMine] reports" |
| 4 | Refresh at every phase (`refresh`, new: player at question/scores/final wager, host at reveal/question/final question) | Every reload lands on the room's phase and round, can still answer, bet buttons right, Bob's locked final 20 survives. **No fault.** | — | 2 clean runs |
| 5 | Host's phone dies at each phase (`hostleaves`, new: killed outright, no beacon) | At question, reveal, scores, final wager and final question: the game finishes every time, deputy controls after ~30s, seat released at 120s, the two boards agree; longest stall 31-44s. Observation, not a break: until the host is replaced every round starts ~10s late, because only the host stamps a round's clock and the backstop repairs it after 8s. **No fault.** | — | all five phases clean |
| 6 | Several games in one room (`sitting --games=4`, and with `--lag=800 --on=Bob`) | Both: 18 answers / 3 seats / 6 rounds every game, channels flat (8 and 9), 0 errors per game — **nothing accumulates**, with or without the slow phone. | — | both clean |

### The fixes

- **A — a room read older than this phone's own advance is not news**
  (`trackOwnAdvance` / `readMayPredateOwnAdvance` in `state.js`, used by
  `syncToCurrentState`). The re-sync only ever asked the direction rule when
  the ROUND matched, so a room one round BEHIND was adopted outright — and that
  is exactly what a read taken while the host's own Next is still being
  written looks like. On a 1500ms link the 60s poll kept landing in that gap.
  `_advanceFromRound` also writes the round fixed at the press (it read
  `state.currentQuestion` after its own await and announced the old round).
- **B — the bets a phone offers come from the server's rows** every time the
  scores are read (`reconcileUsedWagers`, called from `updateScores`, no extra
  trip); a grid already on screen is re-marked in place, every button asks at
  the tap. A round the read predates keeps this phone's own accepted bet
  (`_myWagerByRound`).
- **C — a held timer only closes a round still open on this phone**
  (`handleTimerExpired`: the round fixed at entry, `stillOpenHere()` before
  the read, the fill and the `reveal` write).
- **D — a submit fixes its round at the tap** (`doSubmitAnswer`): every write
  names `round`, and a reply that comes back after the phone has left that
  round touches nothing but the bet it spent.
- **E — `[AnswerNotMine]` is noted before the optimistic row is drawn.** Every
  deliberate Submit since 11-03 filed one false report, and they share
  recordFault's ten-a-minute budget with `[BotAnswer]` — the recorder meant to
  explain the bot's "No answer". **Read the error log with that in mind: every
  `[AnswerNotMine]` row before this deploy is noise.**

- **F — a question-list fetch that comes back after the room moved on does
  not go back** (follow-up, same night). In `handleRoomChange` the final
  round's branch awaits the swapped question list, then called
  `handlePhaseTransition('final_question')` regardless: on a very slow link
  with an early reveal the final question came back after its answers
  (seen at 3000ms: `answer_reveal@5 -> final_question@5`), and the reveal had
  been drawn from the OLD list — it named the wrong final question. Now a phone
  already past that round's question stays put and its reveal is corrected.
  `scenario-finalslow` (Bob on 6s from the final wager, host reveals early):
  old code goes back by name; with only the text fix removed the reveal shows
  "Test question 3?" while the room asked "Test question 5?".

### Found and NOT fixed

- **While the host is gone (before promotion), rounds start ~10s late** — only
  the host stamps the clock. Recoverable; changing who stamps is a design call.
- **At 3s+ per request a phone still LOADING routes from an older room
  snapshot** — `badnetwork --lag=3000 --on=Bob` flicked `question@0 ->
  countdown@0` at the start and corrected itself. The same "read after an
  await" shape, in `init.js`'s routing; recorded and deliberately left alone on
  10-23 because init's routing interacts with Realtime in ways no check pins.
- **The slow-phone matrix re-run on the final code (20261106b):** 800, 1500
  and 3000ms on the host and on a player — 5 of 6 clean; the sixth is the
  loading flick just above.
- **CI: the lobby robot's known intermittent leave-and-rejoin failure** (on
  record since 09-07) failed run 619 on a docs-only commit, and because it is
  the first step of its job every game robot after it was skipped.
- **Harness gaps found and closed:** fake-server answer rows lacked
  `disqualified: false` (the live column's default), so the client fell back to
  guessing "everybody wrong = thrown out"; robots tapped locked final-bet
  buttons with Playwright's 30s wait, which once stalled a loop past the final
  question.
