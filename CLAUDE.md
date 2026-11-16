# Oracle Party

A mobile-only browser trivia party game. Players join a room with a 4-letter
code, type answers, and wager points on their own confidence.

**This file is the short guide. The full record is `docs/HISTORY.md`** (10,000
lines: every fault, measurement and owner decision, newest first). Do not read
it whole. **Search it by keyword before re-investigating a bug, reopening a
design decision, or trusting a claim about the live database.** Code comments
citing "CLAUDE.md #N" mean the numbered facts in that file.

Keep this file short. Record a new fault as a dated entry at the top of
`docs/HISTORY.md`; change this file only when a rule, the architecture or an
owner decision changes, in the same commit as the change.

Last rewritten 2026-11-15, after a clean 3-player-plus-bot playtest (owner's
report: several rounds, no major bugs, only minor polish).

---

## Basics

- **Live site:** https://oracleparty.github.io
- **Deploy branch:** `claude/setup-oracle-party-PHRgj` (GitHub Pages serves it).
  There is no `main` or `master`.
- **Stack:** vanilla HTML / CSS / JS ES modules, no framework. Supabase
  (Postgres + Realtime + Auth), client loaded from `esm.sh`. Service worker
  `sw.js`.
- **Supabase project:** `zzpqymehapwbjupphxec.supabase.co`. Dev sessions are
  firewalled from it; only CI (`scripts/probe-db.mjs`) and the owner's SQL
  Editor can see the live database.
- **Mobile only**, 320px to 430px wide, `100dvh`. The one exception is
  `admin.html`, a desktop workbench (sidebar shell at 900px+).
- ~4,859 questions, 12 categories with subcategories (`js/categories.js`).

## Working with the owner

The owner is not a coder. They design by interview and by looking at real
screens, and they are usually right when they push back.

- **Ask before deciding anything this file does not cover.** A question from
  the owner is not an instruction.
- **Only change what was asked.** Working code calibrated on a real phone is
  not improved on a hunch. The Title Builder wheel was rebuilt unasked once and
  reverted in full.
- **Never generate title words, bot numbers or acceptable answers.** These are
  the owner's. Model-written title text has been deleted twice. The only
  exception is the mechanical placeholder (`placeholderWord`: tier + subject).
- **No explanatory or flavour copy in the UI** (owner, 2026-11-15: "AI text
  everywhere lowers the quality"). No taglines, hints, helper sentences or
  empty-state prose such as "Shape tonight's game". A screen gets labels and
  numbers; if a control seems to need a sentence, redesign it or ask.
- **Never tell the owner to stop or move on.** They decide when a topic is done.
- **Showing a design:** one table, rules spelled out, real numbers. When a
  spacing or layout rule is described in words, draw the candidate readings
  and ask before building. Agree the meaning first, then offer few options; do
  not spray guesses.
- **A reply to a table is not agreement to every cell.** Confirm each word or
  value by name before writing SQL or code from it.
- **Say how each claim was established** (measured, reproduced, read, or
  inferred). Several confident statements in this project turned out wrong.
- Never suggest reverting or giving up. Diagnose, reproduce, measure.
- Commit after each working milestone with a message that says why.

## Architecture as it is now

**The server decides; any phone may ask.** There is no application server:
Postgres functions (`op_*`, SECURITY DEFINER) own the rules, and clients call
them. Supabase cannot wake itself, so a phone always initiates.

| Server-side (migrations 045–081) | Function |
|---|---|
| judging, scoring, wagers, late refusal | `op_submit_answer`, `op_answer_matches`, `op_next_wager` |
| blank fill, typed drafts | `op_fill_blank_answers`, `op_save_draft` |
| round clock, timed phase changes | `op_start_clock`, `op_advance_phase`, `op_round_seconds` |
| pressed phase changes | `op_set_phase`, `op_reveal_final_question` |
| host verdicts | `op_set_judgement`, `op_disqualify_round`, `op_undisqualify_round` |
| seats, roles, removal, bans | `op_leave_room`, `op_remove_player`, `op_kick_player`, `op_set_host_role`, `op_is_banned` |
| rooms | `op_sweep_rooms`, `op_reset_answers`, `op_admin_end_room` |
| history, ratings, claps, bots | `record_round_history`, `op_rate_host`, `op_clap_answer`, `op_bot_answer` |

- **Every guest has an invisible account** (Supabase anonymous sign-in).
  `getCurrentUser()` means a real account; `getAuthUserId()` means any identity.
  Do not mix them: about thirty places treat "has a user id" as "is a member".
- **Realtime is unreliable by design.** Events arrive late, out of order or not
  at all, and a DELETE filtered by `room_id` is never delivered. Every screen
  has a poll or backstop behind it (`syncToCurrentState`, `startPhaseBackstop`,
  the clap poll, `checkStalePresence`). `isStaleRoomEvent` / `shouldSyncPhase`
  in `js/game/phase-order.js` refuse backwards moves.
- **Hosts:** one host, one optional co-host (helps run the game; who is in the
  room stays the host's). At 30s of host silence the next in line is deputised
  (may advance, crown unchanged); at 120s the seat is swept and the crown moves.
  A bot never hosts, never heartbeats, and is never swept.
- **Still open, deliberately:** anyone can write another player's
  `last_seen_at` and a room's `question_started_at`; anyone can read any
  room's chat (`privacy.html` says to treat chat as public). A host can mark
  themselves right in a solo game, so stats are not un-fakeable; the
  leaderboard is friends-only partly for that reason.

### Game flow

Lobby → countdown → each round (wager, question, typed answer) → reveal (host
may flip verdicts; players rate the question and clap one answer) → scores →
… → final wager (0/10/20, locks on tap, 20s clock) → final question (+15s) →
podium (tap to continue) → results.

### Scoring

- With N questions, wagers 1..N are each used exactly once. Correct earns the
  wager; wrong earns nothing. Never negative on regular rounds.
- The final wager is the only round that subtracts. A blank under a locked bet
  loses it; a player who never locked stakes 0.
- A missed round scores 0 and burns the player's lowest unused wager.
- A disqualified round refunds its wager (`answers.disqualified`).
- Fuzzy matching: `fuzzyMatch` in `js/utils.js` and its SQL port must agree;
  `scripts/verify-sql.mjs` runs thousands of cases through both.

## The database

- **Migrations are pasted by hand into the Supabase SQL Editor.** Nothing
  records what ran, and the live database enforces rules no migration declares.
  Never assume a column, type, constraint or policy from `migrations/`.
- **Applied as of 2026-11-06: everything through 081.** Evidence varies
  (pasted rows, CI probe, or the owner's word); see `docs/HISTORY.md` before
  relying on a specific one.
- **PENDING: 082 (Draft and Random).** Not run as of 2026-11-16. Until it is,
  `draftAvailable()` hides both from the host and nothing else changes.
- **`scripts/probe-db.mjs` runs in CI** (`db-probe.yml`) and is the only
  automated view of the live database. It exits 1 when something the app
  needs is missing. It runs as `anon`; row counts are what a visitor can see.
- **The JavaScript must be safe to deploy before its SQL is run.** Every
  `op_*` wrapper distinguishes "not installed" (take the old path) from
  "failed" (say so, revert the screen). Test the not-applied state as its own
  run (`--old-server`, `store.hideFunction`).

**Writing SQL for the owner:**

- One combined paste, comments stripped, once everything is settled.
- Verification is a plain `SELECT` returning one row per rule (`ok` / `FAIL`),
  reading `pg_proc.prosrc`, `pg_policies` or `has_column_privilege`. The editor
  may not show `RAISE NOTICE`. When showing what the result should look like,
  say plainly it is not to be run.
- New table: `REVOKE ALL ... FROM anon, authenticated` before its grants
  (Supabase default privileges grant everything), and add it to the
  `supabase_realtime` publication if any phone listens to it.
- Never drop a policy by name; loop over `pg_policies` in schema `public`, and
  match `cmd IN ('X','ALL')`. Check `roles`, not only existence.
- `now()` is transaction time. Regex word boundary is `\y`, not `\b`. No
  extensions. PostgREST resolves functions by argument names, so a misnamed
  argument reads as "not installed".
- Before shutting a permission, grep `js/` for every write to that table.
- Add the migration to the list in `scripts/verify-sql.mjs` and rules to
  `tests/sql/game-rules.sql`; a local Postgres 16 is in the dev container.

## Habits that keep being proved right

1. **A check that cannot fail is worse than none.** Break the fix on a copy
   (`cp file /tmp/…`, never `git checkout` mid-session) and watch it go red.
2. **After any fix, grep for every other place with the same shape.** The most
   repeated fault here is a rule stated N times and fixed N−1 times.
3. **Never read shared state after an `await` and act as if nothing moved.**
   Fix the round, phase and question at the tap; re-check before drawing.
4. **A write that matched zero rows returns no error.** `.select()` and count,
   or use `writeSucceeded` / `reportWriteFailure` in `js/logger.js`. A failed
   read is not an absent row; never insert on it. Use `.limit(1)`, not
   `.maybeSingle()`, on anything that could have duplicates.
5. **Failures must reach the player or `error_logs`**, not only the console
   (`recordFault`). No toasts for background chatter.
6. **Draw first, fetch behind.** A screen must not queue behind a network
   call, and a pressed button must say something at once ("Sending…"). Any
   awaited auth or network call needs a timeout; a hung promise does not throw.
7. **Missing data means "cannot tell" and takes the harmless reading** (a null
   `last_seen_at` is present; an unknown count shows `?` or `…`, never `0`).
8. **Shutting a door makes its fallback load-bearing.** Re-read the monitoring
   and every caller when a permission is revoked.
9. **When a measurement says everything is fine, or everything is broken,
   suspect the measurement.** When a number and a person disagree about the
   screen, the person is looking at the screen.
10. **"It started recently" outranks any long-standing cause you found.** Read
    the diff since the last known-good commit.
11. **A flaky failure is a real failure with a timing condition.** Set the
    state rather than racing for it; print stacks and real state, do not guess
    the call site.
12. **CI is part of done.** Check the Actions tab after every push, including
    `--stress` and the SQL job.

## Testing and tools

```bash
npm test                                    # vitest unit tests
node scripts/layout-sweep.mjs [--stress]    # every mock state, 3 themes, 320–430px
node scripts/screenshot.js --state=<name>   # then READ the screenshot
node scripts/verify-sql.mjs                 # SQL/JS judging parity + rule table
node tests/harness/scenario-<name>.mjs      # robot playtests (list: tests/harness/)
```

- **Robots** drive real browsers against an in-memory fake Supabase
  (`tests/harness/store.js`); nothing reaches production. CI: `ci.yml`,
  `robots.yml` (three jobs: game, accounts-and-network, stress), `db-probe.yml`.
- **The harness lies in the direction of permissiveness.** It cannot see
  schema drift, iOS Safari, a keyboard, or real latency. Knobs that make it
  honest: `robot.slowConnection(ms)` (one phone on a bad link; use whenever
  one player saw something another did not), `robot.deafTables`,
  `robot.goToBackground()` / `comeBack()`, `store.slowFunction`,
  `slowReads`, `slowReadReplies`, `failFunction`, `hideFunction`,
  `dropEvents`, `denyWrites`, `denyReads`, `addCheck`.
- **A healthy-game scenario proves nothing about a sick one**, and a robot
  that never waits cannot find a bug that needs patience. A mock that starts
  where the real path ends cannot see the path.
- **Pure logic lives in no-import modules** so Node can test it
  (`phase-order.js`, `timer-helpers.js`, `scoring-helpers.js`, `clap-logic.js`,
  `podium-logic.js`, `bot-logic.js`, `draft-logic.js`, `title-tiers.js`, `honeycomb.js`,
  `radar.js`, `question-selection.js`, `keyboard-inset.js`). Everything else
  imports Supabase from `esm.sh` and cannot load in the test runner.
- **If a screen's rendering changes, change its mock in the same commit**
  (`scripts/mock-states.js`). A page with no mock is a page nobody checks.
- Other guards: `tests/module-integrity.test.js` (syntax + imports),
  `scripts/check-arity.mjs`, `scripts/check-rpc-args.mjs`,
  `tests/migration-policies.test.js`, the timer-leak lint in
  `tests/phase-guards.test.js`.
- Known flakes, recorded not solved: `scenario-lobby` quick leave-and-rejoin;
  `scenario-join` slow reload on CI (retries once and says so).
  `scenario-badnetwork` and `scenario-latency` are tools, not CI gates.

### Deploying

1. `npm test` passes.
2. `node scripts/bump-version.js` (pass an explicit suffix such as `20261115b`
   for a second deploy in one day). Without it the service worker serves old JS.
3. Push to `claude/setup-oracle-party-PHRgj`, then check the Actions tab.

## Layout facts

- **Measure, never eyeball.** Playwright at 320, 375 and 430 wide, real
  dimensions, all three themes (light, dark, OLED). Zoom in on screenshots.
- **The owner's iPhone uses Display Zoom: 320px wide, ~523px visible.**
- **Root font-size is `clamp(14px, 4.2667vw, 20px)`**: 14px at 320 wide, 16px
  at 375, about 18px at 430, 20px on the desktop admin page. So `1rem` is never
  a fixed number; measure the computed size. Text scale token is `--text-base`
  (`--text-md` does not exist; an undefined variable fails silently).
- Use `dvh`, not `vh`; a fixed element sits in a viewport the person may not
  see. Short-screen rules are `@container gamescreen`, not `@media (max-height)`.
- Fixed-count grids are `repeat(N, minmax(0, 1fr))`. A flex child shrinks only
  if its parent may (`min-width: 0`). `overflow-x: hidden` is a seatbelt, not a fix.
- An author `display` rule beats `[hidden]`; inline styles beat the stylesheet;
  equal specificity is decided by file order.
- Colours are per-theme variables, measured for contrast on all three. Text
  colours (`--rarity-*`) and fill colours (`--hex-*`) are separate sets.
- Lists reserve every column on every row (crown, honk, status, clap slot).
- `textContent` on a wrapper deletes its children.
- The keyboard (`.kb-open`) needs both a shrunken viewport and a focused
  input; nothing in this repo can open a real keyboard, so say "not seen on an
  iPhone" when that is true.
- Hieroglyph watermarks: simple and centred. Do not try to make a glyph
  encircle the emoji bubble (20+ failed attempts); use `host.html?tune=𓂀`.

## Owner decisions — do not reopen without them

- **Leaderboard is friends-only**; ranks on mastery, proficiency or claps. No
  global board, no points.
- **Proficiency** = questions currently got right / questions met (latest
  verdict decides). A miss is a miss, including an away phone.
- **Host rating** asks "would you play with this host again"; thumbs need the
  whole game, the flag needs one round; who voted is private. Label: "Rate your host".
- **Claps:** one per person per round, public, never points; rate withheld
  under 20 available; bots are not clappers.
- **Bots:** one per room, 50% flat, wrong answers only from stored distractors
  or blank. Their results go to `bot_history` only, never to `question_stats`
  or `answer_tally`. Characters and numbers are the owner's (`docs/BOTS.md`).
- **Difficulty vote:** voted levels share 95% by votes, unvoted share 5%; the
  wheel always shows all three.
- **Lobby row:** avatar, name, title line ("Guest" for guests), honk, crown
  (gold host, smaller grey co-host), one grey→green ready dot. Host controls
  live on the profile card, opened by tapping the face. No rank word.
- **Removal:** Eject (can rejoin) and Kick (banned from that room). A removed
  player sees a notice with Rejoin / Leave; no silent re-seat.
- **Draft and Random** (built 2026-11-16, rules in `js/draft-logic.js`): two
  buttons above the grid on Choose Category, chosen instead of a subject. Both
  end in ONE SPIN at Start that picks the subject for the whole game, like the
  difficulty wheel. **Draft:** in the lobby each person makes one move, live
  and public, changeable until Start. A want is a block on the wheel; a ban
  takes one of that category's blocks off and keeps it out of the upset.
  Wanted categories share 95% by blocks; untouched ones share a 1-in-20
  upset; with no blocks every unbanned category is equally likely.
  **Random:** no moves, every subject equally. The host's phone spins and
  writes `rooms.draft_pick`; every phone plays the wheel in front of the
  countdown (the countdown is stamped `CATEGORY_SPIN_MS` in the future).
  Stored as `wild-card` + subcategory `__draft__` / `__random__`; moves in
  `players.draft_move` (082). Play counts and history record the picked
  subject (`playedCategory()`).
- **Game options are independent host switches** (like Chaos), set at room
  creation and locked at Start; the classic game is the default.
- **In game:** timer and Chaos lock at Start; Auto-Proceed stays changeable.
  Everyone has the gear (read-only for non-hosts) and a 🔊 switch. Honks ignore
  the silent switch. Submit shows the reveal at once.
- **End of game:** podium (glide replay, tap only, no sheen, measured 24px
  gaps) then a scrolling results page with Favourite Answers carousel.
  Review Questions is a read-only record.
- **Chat:** you arrive to an empty room (cut-off set once per room).
- **Mastery list stays** beside the Map. The Map: fill height is mastery,
  colour is rank, glow from half a topic, Mythic pulses.
- **Admin is a desktop workbench**; the phone keeps the emergency panels.
- **The Title Builder slot machine stays.** The title collection ("See all
  titles") is hidden pending a redesign that waits on the owner.

### Titles

Three reels: 1 describing word (how you play), 2 describing word (what you
know), 3 noun (rank, feat or topic noun). One switch per reel; at least one on.
Every word always shows in its own rarity colour.

| Step | Rule (questions currently right) | Topic needs | Cap |
|---|---|---|---|
| Common | 10 in the subject | — | 10 |
| Uncommon | ¼ of one topic | 60+ | 25 |
| Rare | ½ of one topic | 70+ | 100 |
| Epic | ¾ of one topic | 80+ | 250 |
| Legendary | all of one topic | 100+ | none |
| Mythic | all of the subject | — | none |

- Goals follow the topic's live size (`get_topic_sizes`); a topic under a
  step's floor keeps that step locked. Earned words are kept forever.
- **Rank ladder** (`subjectRank` in `title-tiers.js`): Caveman, Hermit, Hippie,
  Pilgrim, Guru, Oracle. A rank is capped by your step in the subject of the
  reel-2 word; Oracle, once earned, pairs with anything. Eternal = Oracle in 3.
- **Topic nouns** unlock at Rare and pair with any word.
- Words live in `title_words` (admin → Title Words). A word id carries no
  text, so renaming keeps unlocks.

| Topic | Uncommon | Rare | Epic | Legendary | Noun |
|---|---|---|---|---|---|
| Human Body | Organelle | Single-Celled | Multicellular | Bipedal | Bigfoot |
| Elements | Basic | Unstable | Periodic | Elemental | Gold-Digger |
| Space | Spacey | Gassy | Mooning | Supermassive | Alien |
| Medieval | Peasant | Diseased | Gothic | Inbred | Jester |
| Ancient | Cursed | Mummified | Civilized | Classical | Pharaoh |

**How words get chosen** (learned over ~45 rejected batches): plain textbook
vocabulary of the topic that becomes a joke about a person; one word; reel 2
must read as a describing word; a ladder climbs one notch at a time without
echoing; judge a noun by its reel-2 + reel-3 combos ("Gassy Hermit"), never
alone; no obscure references, myths, job titles or polite compliments. Agree
the stages before proposing words; show whole ladders in a table. The rejected
lists are in `docs/HISTORY.md`.

## Open work

**The owner's goal (2026-11-15): finish the half-built systems.**

- **Title words:** most topics still have no ladder; reel-1 words need an
  overhaul (raised, not started); more reel-3 feats parked (Polymath, High
  Roller, Comeback Kid, Crowd Favourite, Hype Man, Heckler, Ringleader).
- **Title collection redesign**, and a way to choose which earned words are
  "active" on the wheels (meaning not yet confirmed).
- **Bot characters** (names, strengths, speed, wager habits).
- **Sound** beyond the honk; must be mutable.
- **A real logo** (uploading one triggers Google's brand review; do it once).
- **Questions:** History's Ancient (58) and Medieval (52) need about a dozen
  each to clear the 60 floor.
- **Bluff round: designed with the owner 2026-11-15, NOT built.** A host
  switch; one round at mid-game. Everyone types a lie for a hard question,
  then picks the truth from the lies. You place a wager from your grid while
  picking, paid if you spot the truth; fooling a friend pays you THEIR bet. A
  bot's lie, and top-ups to at least 4 options in small rooms, come from the
  question's stored wrong answers (never invented). Typing the real answer as
  your lie is refused. No stats are recorded. It adds phases to the round
  engine, so it needs its own careful session; details in `docs/HISTORY.md`.
- **Parked ideas** (owner interested, not convinced): Prophecies (secret
  predictions about the night, paid at the podium). Not chosen: rivalries, a
  recap card, a daily solo game, a TV mode, player-written questions.
- **Draft and Random, next (owner chose the order):** a host setting "Spin:
  once / every question"; the per-question spin is not built. Also not done:
  the host cannot switch an existing room to or from Draft or Random in the
  lobby's category sheet, and a rejoining player's move is lost with their
  old seat.
- **Polish list from the 2026-11-14 playtest:** minor aesthetics and
  smoothness; the owner is saving it for a later session.

**Unexplained, with recorders in place** (read `error_logs` before guessing):
`[AnswerNotMine]` ("Scorpio" saved on a silent seat), `[BotAnswer]` (bot's "No
answer"), `[SeatSwept]` / `[ResultsMissing]`, `[SlowRequest]` / `[SlowSubmit]`,
"Script error." context. Also: the lobby honk with no tap, why the database
ran slow on 2026-10-29, and supabase-js is unpinned (`@2`).

## Saved commands

`.claude/skills/` holds the project's routines; use them instead of
re-deriving the steps: `/deploy`, `/sql-handover`, `/playtest-triage`,
`/word-ladder`.

## Where things are

```
index / host / join / lobby / game / profile / leaderboard / admin .html
sw.js                 service worker; version bumped by scripts/bump-version.js
css/style.css         all styles, theme variables
js/db/                Supabase access by domain (client, rooms, players,
                      questions, chat, social); js/supabase.js re-exports
js/game/              the engine: init, phases, question, reveal, scores,
                      podium, results-view, chat, host, state, bots + pure helpers
js/auth.js            names, accounts, invisible accounts, seat memory
js/lobby.js host.js join.js profile.js leaderboard.js admin.js admin-shell.js
js/titles.js title-tiers.js title-content.js     title rules, ladder, word loader
js/draft-logic.js     Draft and Random: moves, the wheel's odds, the spin (pure)
js/constants.js       every timing and threshold
migrations/           hand-applied SQL
scripts/              probe, sweep, screenshot, mocks, SQL parity, lints
tests/                vitest + tests/harness (robots) + tests/sql (rule table)
docs/                 HISTORY.md, STRESS-PLAN.md, BOTS.md, GOOGLE_SIGNIN_SETUP.md
```

Content rules: date questions ask for the year unless the exact date is
famous; number questions accept ranges; never show internal markers such as
`__WAGER_LOCKED__` to players.
