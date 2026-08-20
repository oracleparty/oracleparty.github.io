# Oracle Party

> **This file describes the code as it actually is, including what's broken.**
> The previous version described a smaller, abandoned game and misled every
> session that read it. If you change the architecture, update this file **in
> the same commit** — a change that leaves this file stale is not finished.
>
> Last verified against the code: 2026-08-19.
>
> The live database was verified directly on 2026-08-18 via
> `scripts/probe-db.mjs`. Do not trust `migrations/` as a record of what is
> applied — several were never run.
>
> **A probe result is only as good as the probe.** Three sections of that
> script have been caught reporting confident nonsense; see #6. Facts below
> that came from it have been re-measured since each fix.
>
> `player_stats_computed` was missing from the live database until
> 2026-08-19, which silently killed the leaderboard, tier badges, profile
> stats and every title unlock. Migration 031 was run and the probe confirms
> it. Kept as #8 because of how it hid, not because it is open.

## What This Is

A mobile-only browser trivia party game. Players join a room with a 6-digit
code, answer typed trivia questions, and wager points on their own confidence.
Built for playing with friends in the same room or over chat.

- **Live site:** https://oracleparty.github.io
- **Deployment branch:** `claude/setup-oracle-party-PHRgj` — GitHub Pages serves
  this branch. There is **no `main` or `master` branch** in this repo.
- **Supabase project:** `zzpqymehapwbjupphxec.supabase.co`
- **Questions in database:** ~4,859 across 12 categories with subcategories

## Tech Stack

- **Frontend:** Vanilla HTML / CSS / JavaScript ES modules. No frameworks.
- **Backend:** Supabase (Postgres + Realtime + Auth). Supabase JS client is the
  only runtime dependency, loaded from `esm.sh`.
- **Hosting:** GitHub Pages, with a service worker (`sw.js`) for offline caching.
- **Mobile only:** designed for 375px–430px width, viewport-locked (100dvh).

---

## ⚠️ Critical Architectural Facts

Read these before proposing any change to gameplay.

### 1. There is no game logic on the server

The host's browser writes `game_phase`, `current_question` and
`question_started_at` into the `rooms` row. Every other client reacts to those
writes over Realtime. **Answer judging, scoring and timers all run
independently in each player's browser.** The host's phone is the only referee.

Consequences that show up as "random" bugs:
- If the host's phone sleeps, loses signal or quits, the game can stall.
- Clients can disagree about scores, because each computes its own.
- Any player can edit any score directly (see #2).

**Migrating this to server authority (Postgres functions owning phase, timer,
judging and scoring) is the main open work item.**

### 2. Database permissions are effectively wide open

RLS is *enabled*, which makes the Supabase dashboard look secure — but the
gameplay policies are `USING (true)` / `WITH CHECK (true)`. See
`migrations/022_atomic_increment_and_rls.sql`. With the publishable key (public
by necessity, in `js/db/client.js`), anyone can read, write **and delete**
`rooms`, `players`, `answers`, `chat_messages` and `chat_archive`. Anyone can
therefore delete a room out from under a game in progress, or edit any score.

Measured on 2026-08-18, not inferred from migrations:

| Open to any visitor | Locked |
|---|---|
| `rooms`, `players`, `chat_messages`, `chat_archive`, `question_feedback`, `game_plays` | `questions`, `question_history`, `game_history`, `profiles`, `player_stats`, `site_settings`, `question_stats` |

`answers` was empty at probe time and could not be tested without writing to
it; migration 022 makes it permissive and nothing since has changed that.
`question_stats` is locked deliberately — every write goes through the
`record_question_outcome` SECURITY DEFINER function (migration 025), so a
player cannot forge question performance.

**The upsert conflict targets are sound.** `question_feedback
(question_id, voter_id)`, `game_plays (room_id, player_id)` and `answers
(room_id, player_id, question_number)` each have the unique index their
`onConflict` needs. This was checked because a missing one raises 42P10 and
kills *every* write through that path, which would have looked exactly like
the schema-drift bugs in #3 — it is not what is happening, so don't
re-investigate it.

**The question bank is safe.** 4,859 questions, and a visitor can neither edit
nor delete one. That is worth stating plainly, because an earlier version of
the probe claimed the opposite (#6), and because the bank is the one asset here
that could not be rebuilt.

Locking the rest is deliberately deferred: with judging and scoring running in
the players' browsers, the clients *need* those write rights. The lockdown
comes free with server authority (#1), and is wasted effort before it.

**But rights the app never uses are not deferred, they are just wrong.**
Migration 036 removes DELETE from `chat_messages` and `chat_archive`, and
UPDATE from `chat_archive`, having checked `js/db/chat.js` rather than assumed:
chat is inserted, read, and hearted, and never deleted by anything. Messages
disappear when their room does, by cascade, which runs as the table owner and
is unaffected by policies. Before this, any visitor could have wiped every chat
message and every archive in the game.

**What that does NOT fix, and the privacy policy now says so outright:** a
person can still READ a room's chat they were never in. Permissions decide by
identity and a guest has none — every guest is the same anonymous key. The only
real fixes are requiring sign-in, which ends guest play, or putting a server
between players and the database. That is #1, and chat privacy arrives with it.
`privacy.html` tells players to treat chat as public, which is the honest
position and better than a lock that only looks like one.

### 3. Schema drift is the single biggest source of "impossible" bugs

Migrations are hand-applied, and several were never run. Every bug of this
shape presented as something else entirely:

| Missing thing | How it looked |
|---|---|
| `players.last_seen_at` | Players kicked from the lobby seconds after joining |
| `players.is_cohost` | Co-host silently did nothing, for months |
| `game_plays.subcategory` | Play counts "mysteriously" stopped recording |
| `get_category_play_counts()` | Every category showed 0 plays |
| `questions.acceptable_answers` | Correct answers judged wrong |
| `rooms.auto_proceed` | Host setting silently ignored |

Postgres rejects an **entire INSERT** for one unknown column, and the app only
logs the failure. So one missing column silently kills a whole feature.

**Every column in that table now exists** — migrations 024–027 were run, and
the probe confirms all 18 tables have every column `js/` writes. Treat the
table above as a catalogue of how this failure *presents*, not as an open bug
list. The one thing still missing is the `get_mastery_counts` RPC, which has a
client-side fallback and so has never been noticed (#6).

**`migrations/030_bot_players.sql` adds `players.is_bot` and is the newest
hand-applied one.** Until it is run, pressing "+ Practice Bot" in the lobby
inserts an unknown column, Postgres rejects the whole INSERT, and no bot
appears — but it shows as a toast rather than silence, because `addBot` goes
through `reportWriteFailure` (#4). Check the db-probe output before concluding
the bot feature is broken.

**Run `scripts/probe-db.mjs` before believing anything about the schema.** It
runs on GitHub Actions (dev sessions are firewalled from Supabase), needs no
secret, and reports which columns exist and what any visitor is permitted to
do. `.github/workflows/db-probe.yml` triggers it on push.

**Before adding a column to any INSERT, confirm it exists.** Writing
`last_seen_at` in `addPlayer` before the column existed would have stopped
anyone joining at all.

### 4. Failures are logged, not shown

The deepest recurring fault in this codebase. On 2026-08-13 there were **94
places that log a Supabase error and 14 that tell the player anything**. Every
bug found that day was invisible for that reason: a player vanished from a
lobby, co-host did nothing, play counts stopped, the admin page reported
"Saved!" while saving nothing. All of them reached a log and stopped there.

`reportWriteFailure(where, error, playerMessage)` in `js/logger.js` logs AND
surfaces a toast; `writeSucceeded(where, result, playerMessage)` also catches
the zero-rows case, because **an RLS refusal returns no error** — it updates
nothing and reports success.

Use them for writes whose failure changes what the player experiences
(submitting an answer, joining, starting, changing a role). Do **not** use them
for background chatter like heartbeats: a toast on every dropped heartbeat is
noise, and noise is how real warnings get ignored.

### 5. Admin question edits silently do nothing

`js/admin.js` updates `questions` in three places: marking a flagged question
`removed`, editing text and answers, and editing `acceptable_answers` inline.
All three were discarded by RLS, which returns **no error and zero rows**, and
all three reported success.

Two separate faults, fixed separately:

**The reporting** is fixed. All three paths now `.select()` and check the row
count, so a refusal shows as "Permission denied" instead of "Saved!". This is
what `writeSucceeded()` in `js/logger.js` exists for (#4).

**The permission** needed migration 028, and this is worth reading closely,
because the first attempt to fix it looked like it worked and did not.
Migration 024 added an admin UPDATE policy whose predicate was
`profiles.id = auth.uid()`. `profiles` has **both** an `id` and a `user_id`,
and it is `user_id` that holds the auth user's id — every other policy in the
repo and every query in `js/` uses `user_id`. So the policy matched no row, for
anybody. It was created successfully, the dashboard listed it, and it granted
nothing. `migrations/028_fix_admin_question_policy.sql` repairs it; 024 is
corrected in place so a replay from zero is right.

`tests/migration-policies.test.js` now fails on any migration comparing
`auth.uid()` to `profiles.id`. Nothing else could have caught this: the unit
tests never touch SQL, and the live probe runs as an anonymous visitor, who is
correctly denied either way.

Player-side feedback (thumbs up/down/flag) **does** write correctly. Only the
admin's response to it was broken.

**The same shape was in the profile page.** Five of its six saves — avatar,
bio, favourite category, online visibility, title — discarded the result and
updated the screen anyway, so a refused write left the player looking at a
change that did not exist until they reloaded. A switch that shows the value
the database rejected is worse than one that refuses to move. All five now
check, surface a toast, and put the control back. `scenario-account.mjs`
proves it with `store.denyWrites('profiles')`.

**When you write a save handler, the question is not "did it error" but "is
the screen now telling the truth".**

### 6. A measurement can lie, and a confident one lies hardest

`scripts/probe-db.mjs` is the tool this file tells you to trust over
`migrations/`. On 2026-08-18 two of its sections were found to be reporting
confident nonsense, and both had been quoted as fact.

**Write permissions.** It aimed an UPDATE and a DELETE at an id that cannot
exist and read the HTTP status. That can never work: Postgres applies a
policy's `USING` clause as an extra `WHERE` condition, so a statement matching
zero rows succeeds whether or not the policy would have allowed it. Every table
came back `*** ALLOWED ***`, including `questions`, which no visitor can write
to at all. The one section describing the security posture described its
opposite.

It now posts an **existing primary key**. RLS's `WITH CHECK` is evaluated in
`ExecInsert` *before* `ExecConstraints`, so a refusal arrives as `42501` and
permission arrives as the duplicate-key violation the existing key guarantees.
Different answers, and neither writes a row. UPDATE sets one real row's key to
another real row's: hidden by `USING` means zero rows back, visible means the
statement aborts on the duplicate. DELETE is reported as **not probed**, because
establishing it means deleting something real — an honest gap beats a guess.

**RPC functions.** POSTing `{}` to a function that takes arguments returns the
same 404 as one that was never created, so `increment_questions_answered` was
reported NOT INSTALLED without that ever having been established. Reading the
OpenAPI description instead was worse: it lists no functions at all, and the
empty result was read as an empty database — so *all four* came back missing,
including one that had answered HTTP 200 five days earlier.

Each is now called with the exact argument names `js/` uses and an unparseable
uuid. PostgREST resolves and casts before the body runs, so 404 means missing,
`22P02` means present, and `record_question_outcome` never gets to write. The
real argument names also test the **signature** — a function that exists under
a different one answers 404 too, and is just as dead to the app.

Truth as of 2026-08-18: `get_category_play_counts`, `record_question_outcome`
and `increment_questions_answered` are installed. `get_mastery_counts` is not,
and `fetchMasteryCounts` has always fallen back to a client-side query, so the
mastery tree works — slowly — and nobody noticed.

**Row counts in the probe are rows a *visitor* can see.** A restrictive SELECT
policy filters rows out rather than refusing the request, so `error_logs` reads
as empty no matter how much it holds.

**A third fault, found 2026-08-19, and it had been hiding a dead feature.**
The probe said two contradictory things about `player_stats_computed` in the
same run: the row-count section could not read it, and the columns section
reported `all present`. The confident half was wrong. The columns check counted
a column as missing only on HTTP 400 "does not exist" — and a relation that is
not there answers **404** to every request, so no column was ever recorded
missing and the table came out clean. The most reassuring possible output for
the most broken possible state.

It now refuses to report on any table the read section could not reach, and it
distinguishes **missing** from **not permitted**: PostgREST answers `PGRST205`
for an unknown relation and `42501` for a refused one. Reporting a missing
GRANT as a missing table would send the next session to write a migration for
something that already exists.

What it uncovered is in #8.

**One claim in this file was not supported by the probe.** It said
`question_feedback` was "confirmed working, 3 flags and 2 thumbs-down". Every
probe run reads that table as `rows=0`, including the run on the day the claim
was written, so whatever established it, it was not this tool. The rows may
well exist and be invisible to a visitor — that is what the paragraph above
describes — but "confirmed" was too strong, and a later session would have
treated it as measured. **Say where a number came from, or do not write it
down.**

The lesson generalises past this script: **when a check reports that everything
is fine, or that everything is broken, suspect the check.** Both are shapes a
broken measurement makes far more readily than a real system does.

### 7. Migrations are applied by hand

`migrations/*.sql` are pasted into the Supabase SQL Editor manually. Nothing
records which ones were actually run, so **the live schema is not known with
certainty from this repo alone.** Run `scripts/inspect-db.sql` in the SQL Editor
to get the real picture before relying on any table or policy.

### 9. Play counts were deleted the instant they were earned

**Needs `migrations/033_play_counts_survive_the_room.sql` run by the owner.**

Measured from the SQL Editor on 2026-08-19, after the automated probe honestly
reported it could not tell (this project's OpenAPI output carries no
foreign-key annotations):

```
game_plays_room_id_fkey   -> rooms   ON DELETE CASCADE
game_plays_player_id_fkey -> players ON DELETE CASCADE
```

A room is deleted when the last player leaves, and a player's row is deleted
when they leave. Both happen at the end of **every** game, so every play record
was destroyed within seconds of being written. `game_plays` held **0 rows**,
and `get_category_play_counts()` returned nothing at all.

**Everything in the counting path was correct.** The RPC was installed, its
body counts every row, and `fetchCategoryPlayCounts` maps the result onto the
category cards properly. The symptom — every category showing 0 plays — is
listed in #3 as a signature of a missing RPC, and this time the RPC was fine
and the data was being deleted underneath it. **The same symptom has two very
different causes; check the row count before checking the function.**

Migration 033 drops both keys rather than softening them to `SET NULL`.
`game_plays` is a historical record — a game in this category was played, by
someone, at a time — and once it is over there is nothing left to point at. A
key that has to be nulled at the end of every game is not describing a real
relationship. The columns stay and remain useful while the game runs, since
`completeGamePlay` and `increment_questions_answered` both find a row by
`room_id + player_id`.

`answers` keeps its cascade deliberately: it really is scratch data for one
room, which is exactly why `question_stats` and `answer_tally` exist.

**Every play before 2026-08-19 is gone for good** — deleted, not hidden.

**A second counting fault sat behind the first.** The record is keyed on
`(room_id, player_id)` and a room survives Play Again, so a group playing six
rounds together wrote to one record six times and counted as **one play each**
— under-counting exactly the people who play most. Migration 034 keeps the
one-record-per-person-per-room shape and counts rounds on it via
`record_game_play`, because `completeGamePlay` and
`increment_questions_answered` both find a record by `room_id + player_id` and
nothing else: allowing several rows per room would have made a counting fix
quietly corrupt two other things.

The counter advances only when `p_game_key` — the room's countdown timestamp,
rewritten per game and identical on every phone — **changes**, so the caller
can fire as often as it likes. That matters: it is called from a phase
transition, which is not guaranteed to happen exactly once.

**A play is one person, one round.** The owner chose per-person over per-game.
A rejoin does not double count, because the record is written only at question
0 and now survives the player row being deleted.

**The scenario check for this was measuring nothing at first**, and it is worth
knowing how. It asserted that there were more RPC calls than counted rounds,
reading the gap as proof the idempotency guard worked — but each player calls
once per round, so 2 players x 2 rounds is 4 calls with nothing deduplicated.
Deleting the guard entirely changed the result not at all. It now checks the
property the harness can actually establish: the round key is stable within a
round and different between rounds. Verified by forcing the key to null, which
makes `games_played` stay at 1 and reports both faults by name.

### 8. `player_stats_computed` was missing, and took four features with it

**RESOLVED 2026-08-19** — migration 031 was run, and the probe now reads the
view as present. Kept here because of how long it hid and what hid it.
**Migration 032 is the follow-up and is still hand-applied by the owner**: it
adds `player_totals_computed` (honest global totals) and `get_mastery_counts`
(the RPC `fetchMasteryCounts` has always fallen back for). Both have working
fallbacks, so nothing breaks before it is run.

Measured earlier that day: the live database answered **`PGRST205`** for
`player_stats_computed` — "could not find the table in the schema cache". Not
`42501`, so it was absent rather than locked. Migration 017 created it and was
apparently never run (#7).

Four reads in `js/db/social.js` go to that view. While it was missing, each
logged and returned `[]`:

| Read | What the player sees |
|---|---|
| `fetchAllPlayerStatsForLeaderboard` | global leaderboard empty |
| `fetchCategoryLeaderboard` | every category leaderboard empty |
| `fetchPlayerStats` | profile shows no stats — **and no title ever unlocks** |
| `fetchPlayerStatsBatch` | no tier badge in any lobby |

The title system was the worst of them, and the most instructive. It did not
fail visibly: after every game `evaluateUnlocks()` was handed an empty array,
found nothing to award, and reported success. There is no error state for
"nobody ever earns anything".

**Titles unlocked before this date do not exist.** Anyone who played while the
view was missing earned nothing, and nothing backfills it — the unlock check
only runs at the end of a game. That is not a bug to fix, it is a fact about
the history.

**Do not conclude tiers work because a tier badge appeared in a playtest.**
`computeCategoryTiers([])` returns `{}`, so an empty read renders no badge at
all. The 71px lobby overflow was reproduced in the harness with a *seeded*
tier, which is not evidence about the live database.

This sat unnoticed because the probe reported the view as `all present` — see
#6. It is the strongest example in this project of the rule that follows from
it: a broken measurement does not report a broken system, it reports a
healthy one.

The probe now ends with a **WHAT THIS MEANS FOR A PLAYER** section that maps
each missing object to the features it takes down, so the next one of these is
one line of output rather than a chain of inference. As of 2026-08-19 that
section lists only `get_mastery_counts`, which is harmless and says so.

**Restoring the view exposed a second bug underneath it, in the same hour.**
`player_stats_computed` returns every number **twice**: for one player in one
category it emits a row per subcategory AND a rollup row (`subcategory` null)
that already contains their sum. Five places summed every row —

| Site | Effect |
|---|---|
| `loadGlobalTab` in `leaderboard.js` | global ranking on doubled totals |
| `loadFriendsTab` in `leaderboard.js` | same, for friends |
| the profile card in `profile.js` | games, wins, questions all doubled |
| the profile page summary in `profile.js` | same, plus Strongest/Weakest could name a category while reporting one subcategory's accuracy |
| `computeAggregateStats` in `titles.js` | **play-count titles unlock at half the games they ask for** |

The rule is now one exported function, `categoryRollupRows` in `titles.js`:
**anything that adds rows up takes the rollups only; anything that reads a
single row — a tier, a title, one category's accuracy — can use either.**
`fetchAllPlayerStatsForLeaderboard` filters at the query instead, since it has
no other caller. The per-category breakdown in `profile.js` was always right;
it had `stats.filter(s => !s.subcategory)` inline, which is what established
the intended meaning.

Nothing caught this for months because **the sums had only ever run over an
empty array.** A missing dependency does not just disable the feature that
needs it — it makes every bug downstream of that feature untestable and
invisible, and they all arrive at once on the day it is restored. Expect more
of this from the leaderboard, the profile and the title system specifically:
none of that code has ever processed a non-empty result on the live site.
`tests/titles.test.js` now fails if the double count returns (verified by
removing the fix), and `scenario-account.mjs` seeds subcategory rows so the
two possible readings of the data give different answers — with rollups alone
they are indistinguishable, which is why the scenario was blind to it.

**A third counting question, and the owner settled it.** The global board sums
across *categories*, and a question filed under two topics produces a row under
each. Measured: **105 of 1000 questions carry more than one category (11%),
1.11 tags each**. For a per-topic proficiency that duplication is correct and
stays — getting a History-and-Culture question right is evidence about both.
For the single combined total it is not, so `player_totals_computed`
(migration 032) counts each answered question once, and the leaderboards read
that instead.

**Points are correct answers, not game score, and that is deliberate.** The
owner's reasoning, which is better than the alternative: a game score depends
on which wagers a player happened to hold and on which host was judging —
including any judgement they overrode — so it is not comparable between two
people who never played together. Do not "improve" the global board by
switching it to `game_history.score`.

---

## File Structure

```
├── index.html          Splash + Home + display-name entry
├── host.html           Category browser + host settings
├── join.html           Room code entry, friends' games, public games
├── lobby.html          Lobby: chat, player list, ready state, start
├── game.html           All in-game screens (see below)
├── profile.html        Player profile, stats, mastery tree
├── leaderboard.html    Global + per-category rankings
├── admin.html          Admin dashboard (requires profiles.is_admin)
├── sw.js               Service worker — CACHE_VERSION must be bumped on deploy
├── css/style.css       All styles; CSS variables for theming
├── js/
│   ├── db/             Supabase access layer, split by domain
│   │   ├── client.js       Shared client + credentials
│   │   ├── rooms.js        Rooms, realtime channel factories
│   │   ├── players.js      Players, answers, game_plays
│   │   ├── questions.js    Questions, history, feedback
│   │   ├── chat.js         Chat messages + archive
│   │   └── social.js       Profiles, friends, stats, titles, settings
│   ├── game/           Gameplay engine (the fragile part)
│   │   ├── init.js         Boot, subscriptions, cleanup
│   │   ├── phases.js       Phase router, room/player events, countdown
│   │   ├── question.js     Question screen, wagers, submit, timer
│   │   ├── reveal.js       Answer reveal, host judgment override, feedback UI
│   │   ├── scores.js       Scores, final wager, results
│   │   ├── chat.js         In-game chat
│   │   ├── host.js         Host settings panel
│   │   ├── state.js        Shared mutable game state
│   │   ├── bots.js         Practice bots — host answers on their behalf
│   │   ├── bot-logic.js    Bot decisions, pure + unit tested (no imports)
│   │   ├── scoring-helpers.js / timer-helpers.js / host-promotion.js
│   ├── supabase.js     Re-export hub for all db/ modules
│   ├── auth.js         Display name, optional accounts, session
│   ├── host.js / join.js / lobby.js / profile.js / leaderboard.js / admin.js
│   ├── categories.js   CATEGORY_META: icons, labels, subcategories
│   ├── titles.js       Title unlock rules
│   ├── utils.js        Fuzzy answer matching, DOM helpers, escaping
│   ├── honk.js / typing.js / presence.js / theme.js / logger.js
│   └── constants.js    All timing + threshold values
├── migrations/         Hand-applied SQL (see #7 above)
├── scripts/
│   ├── screenshot.js       Playwright screenshots of mock states
│   ├── mock-states.js      Fake data for visual review
│   ├── bump-version.js     Bumps ?v= on assets + sw.js cache key
│   └── inspect-db.sql      Read-only live schema report
└── tests/              Vitest unit tests
```

## Screens

**index.html** splash → home
**host.html** `#category-screen` → `#settings-screen`
**join.html** `#join-screen`
**lobby.html** `#lobby-screen`
**game.html** `#countdown-screen` → `#question-screen` → `#reveal-screen` →
`#scores-screen` → (repeat) → `#final-wager-screen` → `#results-screen`

## Game Flow

1. **Host** picks a category (and optionally a subcategory), sets who can join,
   question count and timer, then creates the room.
2. **Players** join by 6-digit code, from a friend's lobby, or from public games.
3. **Lobby** — chat, player list, ready status. Host starts.
4. **Countdown** — synced 3-2-1-GO from a shared server timestamp.
5. **Each round** — assign a wager, read the question, type an answer, submit.
   Timer is derived from `question_started_at`, not a local clock.
6. **Reveal** — correct answer shown with every player's submission, auto-judged
   green/red. Host can flip any judgment live. Players can rate the question
   (thumbs up / thumbs down / flag with a reason).
7. **Scores** — animated scoreboard between rounds.
8. **Final wager** — bet 0, 10 or 20 points before the last question.
9. **Results** — final ranking, then back to the lobby or home.

## Scoring

- Each regular question is worth a wager the player assigns.
- With N questions, wager values 1..N are each used exactly once.
- Correct = earn the wager. Incorrect = earn nothing. **Never negative.**
- **Final wager is the exception:** 0, 10 or 20, and an incorrect answer
  *loses* those points.
- Speed does not affect scoring.
- Auto-judging fuzzy-matches against the correct answer plus stored alternates
  (`FUZZY_MATCH_THRESHOLD` in `constants.js`). Host override is final.

## Fixed in the 2026-08-20 playtest

Two real games with several people. Every one of these was invisible to the
robots until a scenario was written for it, and several were invisible to the
player too.

**A single-letter answer could not be got wrong.** The Levenshtein threshold in
`fuzzyMatch` carried a `Math.max(1, ...)` floor, so a one-character answer
allowed one edit — and one edit turns any letter into any other. "cat" took
"bat"; "US" took "up". The floor contradicted the rule it was documented as
implementing (one typo per four characters), so it is gone: under four
characters is exact after normalisation, four and up is unchanged. **415 tests
passed before and after**, which is the part worth remembering — a whole class
of answer was ungradeable and no existing test touched it.

**Refreshing gave back a wager that had already been spent.**
`buildUsedWagersMap` skipped blank answers. A missed round burns the player's
lowest unused wager, so the rebuild handed it back and it could be spent twice.
That skip was correct when the host wrote `wager=1` for every non-submitter;
since `insertBlankAnswers` began giving each player their own lowest unused
value it destroys real information. The unit test asserting the old behaviour
was **encoding the bug** and has been replaced.

**Refreshing zeroed the scoreboard, for the host only.** There are two
reconnect paths — `initHostGame` and `applyGameState` — and only the second
ever called `updateScores()`. The first set every score to 0 as a baseline and
never hydrated. Two functions doing the same job, one of which forgot half of
it; check both whenever you touch either.

**An answer already sent could be erased by a re-render.**
`showQuestionScreen` emptied the answer box and set `hasSubmitted = false`
every time it ran, and Realtime re-calls it for the same question. The wager
reset immediately below it had been guarded against exactly that for months,
with a comment saying why; the answer text never was. The reveal's tidy-up pass
then auto-submitted "whatever is currently typed" — an empty string — through
an **upsert**, replacing the real answer. Two independent fixes: a re-render of
the question already on screen leaves the box alone (`state._renderedQuestion`),
and an auto-submitted BLANK now goes through `insertBlankAnswers`
(`ON CONFLICT DO NOTHING`) so it cannot overwrite anything by any route. A
deliberate submit, and an auto-submit carrying real text, still upsert.

**The final wager had no timer at all**, so one person who had put their phone
down held the last round open indefinitely. `FINAL_WAGER_TIMER_SECONDS` is 20,
fixed rather than the room's question-timer setting — that setting is for
reading and typing, not for choosing between three buttons. On expiry whatever
they tapped stands; somebody who never touched the screen wagers **0**, not the
`state.finalWager` default of 20. That default exists to punish indecision, and
committing it on a timeout would punish absence instead, which no other round
does.

The clock runs off the room's `question_started_at`, and **the host must stamp
it AFTER broadcasting the phase, as a separate write.** The first version
stamped it inside `showFinalWagerScreen`, which runs before the broadcast, so
every other client cleared the stamp when the phase arrived and no clock ever
started. `scenario-fullgame` caught it: Carol ignored the screen and lost 20
points.

**A blank final answer wagers 0 whatever was locked in.** The final wager is
the only round that subtracts. Needed a second pass at timer expiry, because
everyone who locked a wager already has a `__WAGER_LOCKED__` row and
`insertBlankAnswers` skips them as duplicates.

**"No answer" appeared for players who were still typing.** Same placeholder:
on the final question every player has a row the moment they lock a wager, and
the reveal read that as a blank submission — so the host saw "No answer" and
concluded everyone was ready. Before the reveal a placeholder means *waiting*;
only afterwards does it mean they never answered. The same distinction fixes
the countdown, which had been hiding itself on the final question because
`answers.length === players.length` was true before anybody had typed a word.

**A disqualified round could still be marked correct**, in all three places a
host can flip a judgement. Awarding points inside a round the host has just
declared did not happen moves the score with no visible reason.

**The profile had two percentages and neither said what it measured.** The
section labelled "Categories" was always correct-over-answered — proficiency,
never completion — but nothing said so, and the Mastery bar directly above it
IS completion. Renamed to **Proficiency**, and both sections carry one line
saying which question they answer. Mastery sitting near 1% is what 4,859
questions looks like, not a bug. `scripts/mock-states.js` gained
`profile-stats`, because the only profile mock filled the Account section and
these three had never once been rendered by the sweep.

**Room Scores now live on the room** (`rooms.room_scores`, migration 038).
They were in each phone's sessionStorage, so they died with the tab — somebody
who left and came back saw nothing — and every device kept its own tally built
from whatever games that device happened to witness, so two people could read
different numbers off the same lobby. **The host writes it, once per game**:
every device computes the same scores from the same answers, so a per-device
write multiplies the tally by the room size. `scenario-playagain` counts the
writes and fails if there is more than one per game; removing the host guard
doubles Bob's total, which is what it looks like in a two-player room.

Keyed on **display name**, not player id: the row is deleted and recreated on
the very rejoin this is meant to survive, and guests have no account to key on.

**Feedback writes are now checked, not assumed.** A playtest reported flags not
reaching the admin page, and `question_feedback` reads empty. Those two facts
were impossible to act on: an RLS refusal returns no error, so a refused write
and nobody-rated-anything are the same silence. `upsertQuestionFeedback`
`.select()`s and goes through `writeSucceeded`, and the admin flagged queue
counts every kind of feedback so "no flags" and "no ratings at all" are
different sentences. **This is a diagnostic, not a diagnosis** — nothing has
yet established which of the two it is.

## Fixed in the 2026-08-18 playtest

Five bugs from one real game with two people. Recorded because each explains a
class of mistake, and because four of them were invisible to the robots.

**The lobby row could not fit its own contents.** Promoting a signed-in player
to co-host gave their row three badges — Co-Host, tier, Ready — totalling 195px
of a 327px row, while the buttons took 116px and `.name-stack` had a hard 72px
floor. Nothing could shrink, so the row overflowed by up to 71px and the whole
page became draggable sideways. Tier and title now sit under the name where
they truncate; ready state is suppressed for host and co-host, which the
"Not Ready" branch already did; `.lobby-hosts/.lobby-players` carry
`overflow-x: hidden` as a backstop. Measured at 375px and 430px across nine
content combinations, all rows uniform. **The previous fix — icon buttons and
the 72px floor — is what converted "the name disappears" into "the page
overflows".** A floor that cannot yield has to overflow somewhere.

That move had a cost of its own, found later by the contrast sweep: as badges
the tier colours sat on a badge background, and as bare text they measured
2.5:1 against the light theme. They come from CSS via `data-tier` now, with
separate values per theme, because an inline colour cannot answer to three
palettes. **Every fix is a change, and a change can break something the
original never did** — measure the thing you just touched, not only the thing
you set out to fix.

**The host destroyed answers players had typed.** On timer expiry the host
fills blank answers for anyone who has not submitted, and that fill merged on
conflict. Both devices act on the same grace period, so a player's auto-submit
and the host's blank race: from a snapshot taken microseconds earlier the host
still saw them as missing and wrote a blank over their real answer. It is
`insertBlankAnswers` now, with `ignoreDuplicates` — `ON CONFLICT DO NOTHING` —
so neither order can lose. The blank also burns each player's own lowest unused
wager instead of a hardcoded 1, which had let one player spend wager 1 twice.

**Score corrections never left the host's phone.** `handleAnswerChange` bailed
out early on the scores screen to keep the scoreboard animation from stuttering
as the next round's answers arrived. Retroactive judgment flips are UPDATEs and
were swallowed by the same guard, so the host saw their correction and nobody
else did — the room finished disagreeing about the score. UPDATEs now
re-render; INSERTs are still ignored.

**Chat grew the page instead of scrolling.** `.lobby-chat__messages` had no
height, and `scrollChatToBottom()` scrolled `.lobby-scroll` — the whole lobby.
Every message dragged the room card, player list and Start button out of view,
and returning from a game landed you at the bottom of the transcript. The pane
is now `max-height: 34vh` with its own scroll, and scrolls itself.

**The difficulty wheel teased options nobody picked.** It cycled all three
levels regardless of votes. It was changed to cycle only voted ones, sent over
the wire with the reveal so every client spins the same wheel.

**That fix was wrong in the other direction, and the next playtest found it.**
The vote is a *floor*: an all-Easy room can still land on Medium or Hard, so
all three were genuinely in play and cycling one pill was not honest, it was
just still. In a small room that agrees — the commonest case — the wheel
stopped spinning entirely and the owner reported "it doesn't cycle, it just
chooses automatically". The wheel now visits every **possible outcome**:
`allowedDifficulties(tally)` in `scoring-helpers.js`, which is the same set
`pickWeightedDifficulty` draws from, so the two cannot drift apart. An
all-Hard room still shows one pill, because Hard is then the only thing that
can happen and a spin would be a lie. `tests/scoring.test.js` asserts both
directions: nothing the picker can produce is missing from the wheel, and
nothing on the wheel is unreachable.

## Categories

`history`, `science`, `nature`, `arts-literature`, `culture-society`,
`pop-culture`, `world-geography`, `technology`, `sports`, `food`, `logic`,
`wild-card` — each with subcategories, defined in `js/categories.js`
(`CATEGORY_META`). Each has a hieroglyph icon and an emoji.

## Other Features

- **Honks** — tap to blast a sound at everyone, throttled by `HONK_THROTTLE`.
  The honker's avatar shakes on every client (`jiggleHonker` in `honk.js`), so
  a quack has a face on it. `from_id` was in the broadcast payload from the
  start and nothing read it. Works off `data-player-id`, which every
  player-listing screen already sets, so no screen needs to know honks exist.
- **Chat** — in lobby and in game, with typing indicators and message hearts
- **Accounts** — optional; guests can play everything except friends and stats.
  Email/password, or **Continue with Google** (`signInWithGoogle()` in
  `auth.js`). **Google sign-in is live as of 2026-08-19** — the owner completed
  the Google Cloud and Supabase setup in `docs/GOOGLE_SIGNIN_SETUP.md` and
  signed in end to end. If it ever reports "Google sign-in isn't switched on
  yet", that is Supabase answering *provider is not enabled* and means a
  dashboard setting, not a code fault; anything else reports "Couldn't reach
  Google". Email sign-up is unaffected either way. A Google user arrives with
  no local display name, so profile creation falls back to the name Google
  supplies; without that fallback they get no profile row and every
  account-only feature silently does nothing for them.

  **The Google screen says "Sign in to zzpqymehapwbjupphxec.supabase.co"**,
  because the sign-in genuinely happens on Supabase's server and Google shows
  the host that receives it. The owner is right that it reads as phishing to a
  normal person. Two ways out, and **do not repeat the claim that only the paid
  one works** — that was said here once and it was too strong:
    * Free: complete the consent-screen branding and verify ownership of
      `oracleparty.github.io` in Google Search Console, then pass Google's
      brand review. **Ownership is verified as of 2026-08-19** — the
      `google-site-verification` meta tag in `index.html` is what proves it,
      and Google re-checks periodically, so removing that line un-verifies the
      site. What remains is the brand review, which is deliberately parked
      until there is a real logo: uploading one is what triggers the review,
      so it is worth doing once with the finished artwork rather than twice.
    * Paid: Supabase's custom-domain add-on, which changes the host itself.
      Needs a domain the owner buys.
  **Signing in does not make the database safer** — guests still play, so the
  publishable key must still be accepted from anyone (#2).
- **Titles** — unlockable ranks based on accuracy, volume and quirks (`titles.js`)
- **Friends** — requests, accept/decline, see friends' active lobbies
- **Leaderboard** — global and per-category, plus a per-player mastery tree
- **Admin** — dashboard at `admin.html`, gated on `profiles.is_admin`. The four
  stat cards open the list they were counted from; before that they were the
  only figures on the page that could not be checked. Two actions live there:
  ending a stuck room, and deleting somebody's account via
  `admin_delete_account` (migration 037). That function takes a user id, which
  is a dangerous shape, so it carries three guards — the caller must be an
  admin (checked on `profiles.user_id`, never `profiles.id`, see #5), it
  refuses to delete the caller, and it refuses to delete another admin. Its
  delete list is deliberately identical to `delete_my_account`'s: if one grows
  a table the other does not, "I deleted my account" and "an admin deleted my
  account" stop meaning the same thing.
- **Bans are not built, and would not work yet.** Guests never sign in, so a
  ban could only bind to an account, and the banned person plays as a guest or
  clears their browser data. It becomes possible with server authority (#1),
  not before.
- **Co-host** — a second player can share host controls
- **Presence + heartbeat** — `last_seen_at` drives stale-player cleanup
- **Practice bot** — one per room, added by the host in the lobby. Makes solo
  play possible. See below.

### Wanted, not built

- **Sound.** The honk is the only sound in the game, which the owner finds dry
  in play. Candidates: countdown ticks, timer running out, correct/incorrect on
  reveal, the scoreboard animation, the difficulty wheel. Must be mutable, and
  must not fire on a phone whose ringer is off.
- **A real logo.** `icons/icon-512.png` is an "OP" monogram whose origin the
  owner does not recognise, and it is the app icon, the PWA icon and the only
  candidate for the Google consent screen. Wanted eventually, not urgent.
  Uploading any logo to that consent screen triggers Google's brand review, so
  it is worth doing once, with the real thing.
- **General UI polish.** Raised after the 2026-08-18 playtest without specific
  targets. Ask for a screen before working on this — it is not a licence to
  restyle working screens on a hunch.

  One measured target exists: the question screen's content stops at 448px
  whatever the phone, leaving **47% of an iPhone 14 empty below the answer
  box** (33% on a smaller SE). The proposal is to fill it only AFTER the player
  submits — avatars lighting up as others answer, and where you stand — so the
  screen stays calm while you are still thinking and becomes a waiting room
  once you are done. Not agreed yet.

- **Bot characters.** The plumbing is built (below); the cast is not. Names,
  per-category strengths, speed, wager habits, honking, and the leaderboard
  yardstick band are all still open, and `docs/BOTS.md` marks which numbers
  must come from the owner rather than from a model. Two earlier drafts of that
  file invented skill tables and difficulty adjustments; both were deleted at
  the owner's instruction. **Do not invent a number here.**

## Practice Bots

A bot is an ordinary row in `players` with `is_bot` set (migration 030), so it
appears in the lobby, the reveal, the scoreboard and the results through code
that already existed. The host's browser answers on its behalf — the same
device that already owns phase, timer and judging (#1).

Deliberately the plainest possible version, because none of it has been
measured: **one bot per room, 50% accuracy flat, answering instantly.** The
coin flip is the only number that makes no claim about how hard the questions
are. `js/game/bot-logic.js` holds the decisions and is unit tested;
`js/game/bots.js` holds the database side and is host-gated.

**Wrong answers are never invented.** 80% of questions still carry their
original multiple-choice distractors in `questions.incorrect_answers`, a column
nothing else reads. A bot that misses picks one. A question with none stored
gets a **blank** — the owner chose that over borrowing another question's
answer, because borrowed text was never a wrong answer to *this* question.

Four rules from the owner, and where each is enforced:

| Rule | Enforced in |
|---|---|
| Only a human host adds or removes one, only in the lobby | `renderAddBotButton` / `handleAddBot` / `handleRemoveBot` in `js/lobby.js` |
| Never host or co-host | `determineNextHost`, `handleHostPromotion`, and the row's buttons are not rendered at all |
| Nothing it does is recorded | `recordCurrentQuestionOutcomes` in `reveal.js`, and `getHumans()` for placement in `scores.js` |
| A bot never holds a room open | `humanPlayers()` in `js/lobby.js` |

Two exemptions that are not optional: a bot **sends no heartbeat and joins no
presence channel**, so it must be skipped by both stale sweeps and both away
computations. Left in, the sweep removes it partway through the game it was
added for, and the reveal shows it faded at 40% — the "do not wait for them"
signal — for the one player that has always already answered.

**The recording rule is the fragile one.** The guard has to come *before*
`recordQuestionOutcome`, not between it and `recordAnswerText`. When it sat in
the middle, the outcome was counted and only the text was skipped — the worse
half to keep, and invisible without a check. `scenario-bots.mjs` catches it:
break it and `question_stats` reads `asked=2` where a solo human is `asked=1`.

## Database Tables

`rooms`, `players`, `answers`, `chat_messages`, `chat_archive`, `questions`,
`question_feedback`, `question_history`, `question_stats`, `answer_tally`,
`game_plays`, `game_history`, `profiles`, `player_stats`, `friend_requests`,
`friendships`, `title_unlocks`, `site_settings`, `error_logs`.

---

## Presence, Away and Host Handover

The agreed model — implemented except where marked:

- **Away** is shown as soon as presence reports it: the player fades to 40%
  opacity in lobby, reveal, scores, results and final wager. The game never
  waits on an away player.
- **A missed question scores 0 and burns the player's lowest unused wager**
  (`findNextAvailableWager`). This is deliberately identical to being present,
  wagering 1 and getting it wrong — so vanishing is neither rewarded nor
  punished beyond the loss itself.
- **`HOST_HANDOVER_MS` (30s)** — the game must not stall behind one phone.
- **`STALE_TIMEOUT_MS`** — the seat is released. Rejoining reassigns previous
  answers to the new player row, so score and history survive.
- **Succession order: co-host first** (designated heir, can already advance),
  then longest-present. Absent players can neither hold nor inherit the role,
  and **neither can a bot** — a room whose host is a bot is a room nobody can
  start, advance or judge. If only bots are left there is no next host, which
  is correct: nobody is there to play.

**Deputising, not replacement.** At `HOST_HANDOVER_MS` the host *keeps the
crown* and the next in line is granted advance rights via `state.isDeputy`
(`canControlGame()` honours it). Taking the role outright meant a host who
glanced at a notification returned to find they no longer ran their own game.
The role moves permanently only on real departure, which arrives as a DELETE.

**Rejoin keeps your history.** The seat is recorded in `localStorage`
(`rememberSeat` / `recallSeat` in `auth.js`) and reclaimed on arrival by any
route. sessionStorage was used before, which dies with the tab: history
survived a refresh but not an actual return. Reclaiming also has to run
outside the missing-row branch, because a player returning through the join
screen arrives with a freshly created row and would skip it.

`checkStalePresence` re-fetches players on **every** call. It used to do so
every third call, leaving the local view of `last_seen_at` up to 90s stale, so
absence was noticed three times slower than intended.

## Who is allowed to write a statistic

**Measured from the live database on 2026-08-20, via the CI probe.**

**A visitor CAN save a rating.** `question_feedback` answered
`ALLOWED (died on a NOT NULL column, as intended)` to a deliberately invalid
insert — RLS let it through and a constraint stopped it. So the empty table is
**not** a permissions problem, and nobody should write a migration for one.
What remains is the client: a write that never fires, or a value the database
rejects. Both are now visible to the player (`writeSucceeded`), so the next
rating produces evidence instead of silence.

**A host CANNOT write another player's `question_history`.** Migration 011
grants `INSERT WITH CHECK (user_id = auth.uid())` and
`UPDATE USING (user_id = auth.uid())`, and **no DELETE policy at all**. Three
consequences, none of which error:

| Call | For yourself | For anybody else |
|---|---|---|
| `upsertQuestionHistory` from `doReveal` | works | never attempted |
| `amendQuestionHistory` (host override) | works | **silently refused** |
| `revokeQuestionHistory` (disqualify) | update branch works, **delete branch refused** | **silently refused** |

So a host's correction lands on their own row and quietly does nothing for
everyone else. The scenario passes because the fake store has no RLS.

**This is also the answer to "should statistics be per-device?".** They are,
and it is not a design decision — it is this policy, never revisited. Each
player's own browser is the only thing that can write their history, so a
phone that is asleep at the reveal records nothing, and a phone that is awake
records a miss. The same event, two different outcomes, decided by hardware.

The fix is the pattern `record_question_outcome` already uses: a SECURITY
DEFINER function that takes the whole round and writes every player's row,
called once by the host. It would also make absence and distraction consistent,
because one writer would decide both. **Not built — it needs the owner's
decision on whether an absent player's blank should count.**

## Proficiency counts questions; volume counts attempts

**Migration 040.** Proficiency is `questions_mastered / questions_met` —
distinct questions you currently get right, over distinct questions you have
met — and the most recent sighting decides, in both directions. Get it wrong
then right and the miss is gone; get it right then wrong and the mastery is.

It replaced `SUM(times_correct) / SUM(times_seen)`, a lifetime hit rate over
attempts, in which **a miss was permanent**: playing more could dilute it, and
nothing could undo it, not even learning the answer. That made the number
partly a record of how often somebody's phone had been awake at the reveal.

**This is only as good as the resurfacing rule.** A question never asked again
keeps its old verdict forever, so "recoverable" means "recoverable when it
comes back". `fetchQuestionsByCategory` already re-serves missed questions at a
flat ~5% per player per slot, and `question_history.next_eligible_at` exists on
the live table and **is read by nothing** — that column is where a real spacing
rule belongs. Treat the two as one feature.

`questions_answered` and `correct_answers` are unchanged and still count
attempts. They are the VOLUME measure, and the leaderboard's points are built
on them deliberately (see the note on points below). Only percentages moved.
The new columns are appended, because `CREATE OR REPLACE VIEW` cannot reorder
or retype existing ones — which is also the safest shape.

`rowProficiency` / `sumProficiency` in `titles.js` are the single rule, and
both **fall back to the attempt counters when the new columns are absent**, so
the app behaves exactly as before until 040 is applied rather than showing
everybody 0%. `calculateTitle` in `utils.js` duplicates the rule inline because
`titles.js` imports `utils.js` and the reverse would be a cycle;
`tests/titles.test.js` pins the two together with a case whose attempt counters
are identical and whose question verdicts are not.

**`MIN_QUESTIONS_FOR_TITLE` now counts distinct questions, not attempts**, so
it is marginally harder to reach. That is deliberate and more honest.

## Accuracy: `question_history` holds counters, not a verdict

Every accuracy in the app — profile, leaderboard, tier, title thresholds —
comes from `player_stats_computed`, which is `SUM(times_correct) /
SUM(times_seen)` over `question_history`. Those are **counters**, and
`upsertQuestionHistory` **increments** them. One call means one attempt.

Three call sites used it as if it set a verdict, and each extra call added an
attempt the player never made. Found from a 2026-08-20 playtest, where the
owner asked whether a disqualified round affects accuracy. It did — badly:

| Action | What was recorded | Effect |
|---|---|---|
| Host flips a judgement | a second attempt | got it right, host agreed, **50%** |
| Host disqualifies the round | a third attempt, marked wrong | **33%** for a round that did not count |

The disqualify case is the sharp one: the single action whose entire meaning
is *this round does not count* was the action that damaged accuracy most, and
it did so silently. There is no error and nothing renders wrong; it surfaces
weeks later as a number that is slightly too low.

Three functions now, and the distinction is the point:

- **`upsertQuestionHistory`** — one NEW attempt. Called once per player per
  question per round, from `doReveal` only.
- **`amendQuestionHistory`** — the host changed their mind. Moves
  `times_correct` and `last_correct`; `times_seen` untouched. Used by all
  three override paths (reveal screen, scores screen, review overlay).
- **`revokeQuestionHistory`** — the round was disqualified. Steps the attempt
  back out, deleting the row when it was the only sighting.

`recordCurrentQuestionOutcomes` now returns early on a disqualified question.
Disqualifying sets every answer to `is_correct = false` first, so recording it
logged the question as asked-and-nobody-got-it — making a thrown-out question
look impossibly hard — and counted every auto-correct player as
`times_overridden`, the column this project trusts most for spotting a bad
answer key. It also fed `answer_tally` text nobody was judged on.

`scenario-accuracy.mjs` reads the rows directly, because nothing about this is
visible through the UI. Verified by reverting all three fixes: it then reports
`seen=2` after an override, `seen=3` after a disqualification, and
`asked=2 correct=0 overridden=1` in `question_stats` — each by name.

**Whenever you add a write to `question_history`, ask whether it is a new
attempt or a correction to one.** A correction that increments is worse than
no correction at all.

## Question Feedback and Health

**The admin's ability to act on feedback was broken and is fixed — see #5.**
`question_feedback` is **measured empty** as of 2026-08-19 — counted from the
SQL Editor as the owner, so this is the real count and not a visitor's view of
it. An earlier claim here that it held 3 flags and 2 thumbs-down cited no
source and is withdrawn (#6).

No defect has been found behind that zero. Migration 020's policies are
`WITH CHECK (true)` for INSERT, UPDATE and DELETE, the unique index the upsert
needs is present, and `scenario-feedback.mjs` exercises the write path. The
plainest explanation is that nobody has rated a question since the table last
held anything — the UI only appears after a reveal and needs a deliberate tap.
**Do not "fix" this without first establishing a failed write**; rating one
question and re-counting is the cheap test.

- Feedback is keyed on **`voter_id`** — `user:<uuid>` signed in, otherwise
  `device:<uuid>` from localStorage. One vote per person per question, ever.
  Guests included: gating this behind sign-up would mean most questions are
  never rated, which defeats the point.
- **`question_stats`** records per-question performance for every player,
  guests included. Neither `answers` (deleted with the room) nor
  `question_history` (logged-in users only) could do this.
- Feedback only appears **after the answer is revealed** — `showFeedbackUI()`
  runs inside `doReveal()`. Rating a question you have not seen the answer to
  would be meaningless.
- **`answer_tally` records what people actually typed** (migration 029): the
  text and a count, nothing else. Not who said it, and not whether it was
  judged correct — that verdict depends on which host was judging and whether
  they overrode it, which makes it noise. Counting is on lowercased, trimmed
  text, so "JFK" and " jfk " are one row while "J.F.K." stays separate; a
  near-miss spelling is exactly what is worth seeing.

  The point is finding bad answer keys with nobody having to notice. Eleven
  people typing "JFK" against a key of "Kennedy" is one missing acceptable
  answer, not eleven wrong people. It appears inside the Question Health row,
  next to the box for adding alternates, so the data sits where the action is
  taken. It also supplies real wrong answers for bots, so none is invented.

  **Nothing a bot types is ever counted** — a bot's answer comes from a
  percentage somebody chose, so recording it would make this data partly that
  invented number. `scenario-feedback.mjs` fails by name if the guard is
  removed.

- **Recording happens on ADVANCE, not on reveal.** `recordCurrentQuestionOutcomes()`
  runs inside `handleNextQuestion`, which is wired to the SCORES screen's
  button — the reveal screen's button only moves to the scoreboard. A host who
  leaves at the results screen never records the final question. Worth knowing
  before concluding from an empty `question_stats` that the RPC is broken.

- **`times_overridden` is the most valuable column.** A host flipping a
  judgement is a human stating a valid answer was rejected — better evidence
  of a bad answer key than a flag, and it costs players no effort.
- The admin **Question Health** section sorts on any of these and edits
  `acceptable_answers` inline.
- **Never auto-generate acceptable answers.** The question bank's value is
  that it is not model-generated. The owner adds alternates by hand.

## Robot Playtesting

`tests/harness/` drives real browsers through the real UI with the Supabase
library swapped for an in-memory stand-in. **No test data ever reaches the
production database and no robot ever appears in a real lobby.**

```bash
node tests/harness/scenario-lobby.mjs      # host + 2 players see each other
node tests/harness/scenario-fullgame.mjs   # full game, score agreement, channel cleanup
node tests/harness/scenario-nasty.mjs      # host death, rejoin, simultaneous answers
node tests/harness/scenario-playagain.mjs # second game, room reset, no leakage
node tests/harness/scenario-social.mjs    # chat, honks, score editing, review
node tests/harness/scenario-join.mjs      # public listing, privacy, hot join
node tests/harness/scenario-feedback.mjs  # votes, flags, timer-expiry scoring
node tests/harness/scenario-cohost.mjs    # promote, demote, gated controls
node tests/harness/scenario-account.mjs  # profile, leaderboard, friends, signed-in lobby
node tests/harness/scenario-admin.mjs    # admin gate, counts, flags, refused writes
node tests/harness/scenario-bots.mjs     # solo game with a bot; never host, never recorded
node tests/harness/scenario-accuracy.mjs # override is not a 2nd attempt; a disqualified round is none
```

**Robots must never reach the real project.** Three beacons
(`removePlayerBeacon`, `markDisconnectedBeacon`, `deleteRoomBeacon`) call
`fetch()` against `SUPABASE_URL` directly rather than through the client, so
swapping the library is not enough — the harness also routes every request to
`*.supabase.co` to a local stub. Without that, robots on GitHub runners (which
are not firewalled) would issue real DELETEs.

They run automatically on every push via `.github/workflows/robots.yml`, kept
separate from `ci.yml` because they need a browser download and take minutes
rather than seconds.

**What it cannot catch:** schema drift. The fake store accepts any column, so
a missing column is invisible to it. That is what `probe-db.mjs` is for.

**Drive robots from whatever screen they are on, never a fixed click
sequence.** Phases arrive over Realtime and never land in lockstep, so a
scripted order desynchronises and then reports the script's own impatience as
a bug.

**The harness has misreported more often than the app has misbehaved.** Every
one of these looked like a real finding:

- seating a returning player in a fresh browser context — tests "same person,
  different device", where nothing can be recovered, while claiming to test
  rejoin. Carry `storageState` across the gap.
- backdating an absent host past the removal threshold — exercises
  removal-and-promotion while claiming to test deputising.
- counting host rows after killing the host — a dead browser leaves its row
  with the flag set, so "exactly one host" reads as success on a leaderless
  room.

**A scenario that passes proves nothing until you have watched it fail.** The
regression test for the lost-answer race (below) passed on the first run — and
passed just as happily with the fix removed, because the harness happened to
schedule the player's write before the host's. It was measuring nothing. The
race only became testable once the losing order was forced explicitly, by
calling the host's blank-fill *after* the player's answer was already stored.
Break the fix, watch the test go red, then put it back. Anything less and you
have written a test that agrees with you.

**Robots can sign in now** — `table.seatSignedIn(name, { tier, title, isAdmin })`.
It writes a `profiles` row and injects a session the shim serves from
`window.__fakeSession`, which is what `initAuth()` reads, so the app cannot tell
it from a real login.

This mattered because guests are not players. A guest has no tier, no title and
no stats, and the lobby row overflow that made the whole page draggable
sideways needed a tier badge to reproduce — so every scenario passed while a
real signed-in game broke. `scenario-account.mjs` now plays a lobby of
signed-in players and fails by 55px if that regression returns (verified by
reintroducing it). Guests remain the default elsewhere: plenty of real players
never sign in, and both kinds share a lobby.

**When a bug is reported that the robots cannot see, ask what a real account
has that a robot does not.**

**`store.denyReads(table)` simulates a relation that is not there** — an error
with code `PGRST205`, not an empty list. The difference is the whole point: an
unseeded table in the fake store returns `[]` with no error, which is what a
real *empty* table does, so any code that falls back when a relation is
missing could never be reached and the fallback shipped untested. This is
exactly the state `player_stats_computed` was in for months (#8).
`scenario-account.mjs` uses it to prove the leaderboard falls back to the
per-category rollups instead of going blank while migration 032 is unapplied.

**`store.denyWrites(table)` simulates an RLS refusal** — zero rows, no error,
exactly as Postgres behaves when a policy denies a write. This is the most
misleading thing the database does and the direct cause of #4 and #5, so it is
now testable rather than only describable. `scenario-admin.mjs` uses it to prove
the admin page says "Not saved — permission denied" instead of "Saved!";
removing the zero-row check makes that test report the silent-failure bug by
name. Use it on any new write path whose failure the player must notice.

**Writing that scenario produced four "bugs", and three were mine.** Worth
reading, because each looked completely convincing:

- an empty leaderboard — it reads `player_stats_computed`, a view, not the
  `player_stats` table the scenario seeded;
- accepting a friend request doing nothing — `friend_requests.id` is a BIGINT
  and `profile.js` calls `parseInt` on it, while the fake store handed out a
  uuid that `parseInt` turned into `NaN`. The store now issues integer ids for
  integer-PK tables;
- a signed-in player unable to host — `seatSignedIn` set no display name, so
  the name modal opened and `ensureDisplayName()` never resolved, stopping
  `init()` before it fetched anything. An empty grid with no error.

Only the fourth was in the app. **Prove the mechanism before reporting a bug**;
"the page is empty and there are no console errors" almost always means
something upstream never resolved.

**Most early failures were the harness misreading the app.** Quit is
tap-again-to-confirm on one button, not a dialog. The final wager needs an
amount chosen before it can lock. `.first()` on a multi-selector returns the
first match in DOM order, usually a hidden button from another screen. Verify
a failure is real before reporting it as one.

## Development

```bash
npm install
npm test                                   # vitest, all unit tests
npx vitest run tests/module-integrity.test.js   # import-safety check
node scripts/screenshot.js --state=<name>  # visual review
node scripts/screenshot.js --all
node scripts/bump-version.js               # REQUIRED before deploying
# bump-version derives its tag from the date, so running it twice in one day
# is a no-op. Pass an explicit suffix (e.g. 20260813b) for a same-day redeploy.
```

### Deploying

1. `npm test` must pass.
2. `node scripts/bump-version.js` — **without this the service worker keeps
   serving the old JS and your change will appear to do nothing.**
3. Push to `claude/setup-oracle-party-PHRgj`.

### Tests

`tests/module-integrity.test.js` runs `node --check` over every module and
statically verifies that every project function
a module calls is actually imported there. This exists because three such bugs
reached production: a missing `fetchRoom` left the countdown self-heal dead
(host quitting mid-countdown hung the room forever), and a missing
`hideHostSettingsGear` made `cleanup()` throw before unsubscribing Realtime
channels — leaking a full set of subscriptions on every game exit, which
compounds the longer a session runs. Unit tests could not catch these, because
a `ReferenceError` inside a function body only fires when that line runs.

The syntax check exists because a stray brace left `phases.js` unparseable and
`game.html` would not load at all, while 307 tests stayed green — nothing
imports `phases.js`. Importing each module to catch this does **not** work:
these files pull the Supabase client from `esm.sh`, and that resolution fails
first, masking the syntax error behind an unrelated one.

`tests/migration-policies.test.js` fails on any migration comparing
`auth.uid()` to `profiles.id` instead of `profiles.user_id` — the mistake that
made migration 024's admin policy grant nothing while looking installed (#5).
It is a lint, not a SQL parser: it resolves the alias bound to `profiles` in
each `FROM` clause and looks only for that alias comparing `.id` to
`auth.uid()`, which is narrow enough to be provably sound.

**Coverage is thin where it matters most.** Unit tests cover leaf helpers
(scoring math, fuzzy matching, timer math). The multiplayer engine is largely
untested. Multi-client behaviour cannot be verified by unit tests at all — it
needs browsers driven in parallel.

---

## Rules for Claude Code

### Process
- **Read this entire file before doing anything.**
- **STOP and ASK before making decisions not covered here.** Do not guess at
  product intent. The owner is not a coder and prefers being asked over
  receiving something built on a wrong assumption.
- **Only change what was asked.** If asked to fix one thing, fix that one thing.
  Working code calibrated on a real device must not be "improved" on a hunch.
- **Never give up or suggest reverting.** Diagnose. Add logging. Reproduce.
  Trace the logic. If one approach fails, try a different one.
- Commit after each working milestone, with a message explaining *why*.
- Update this file in the same commit as any architectural change.

### Measuring, not guessing
- **STOP EYEBALLING. MEASURE.** When something breaks repeatedly, you are
  guessing. Write code that reports actual values — pixel bounds, element
  dimensions, font metrics. Hieroglyph descent clipping was solved in five
  minutes once ink bounds were measured on canvas, after hours of blind tweaks.
- **Never guess CSS values.** Measure rendered dimensions with Playwright at
  **both 375px and 430px** before setting any size or position.
- **Use red overlay debugging** for positioning: render at high opacity in a
  contrasting colour and screenshot at multiple widths.
- **Measure both axes.** A fix to vertical clipping can break horizontal.
- Regex is not a JavaScript parser. If you need to analyse code structure,
  narrow the problem until a simple check is provably sound.

### Visual review

**`node scripts/layout-sweep.mjs` before any UI change.** It renders every mock
state at 375px and 430px and reports what an eye misses: elements past the
viewport, containers that can be dragged sideways, rows in one list that
disagree about their height, and classes rendered with no CSS rule anywhere.
`--stress` re-runs it with the longest plausible names and titles, on the
principle that a layout which only fits its mock data is one real display name
away from breaking. Both run in CI.

Every state runs in **all three themes**, and reports text below 3:1 contrast
against what it actually sits on. This project has always required checking
light, dark and OLED and nothing enforced it — a colour survives on white and
vanishes on black. It immediately found the tier labels at 2.5:1 (see below),
the co-host button, the Ready badge and the first-place label.

It exists because the co-host row overflowed by 71px in a live game while every
existing check passed. Two reasons it got through, both worth remembering:

1. **The robots sign in as nobody.** No tier badge, no title, no stats. The row
   needed a tier badge to break, so no scenario could ever see it.
2. **`scripts/mock-states.js` had drifted into fiction.** It rendered
   `.player-row` and `.chat-row` for the lobby — classes in neither the app nor
   the stylesheet — so `screenshot.js`, the tool this file tells you to trust,
   was reviewing unstyled markup that has never shipped. The lobby previewed
   perfectly because the preview was not a lobby.

**If you change how a screen renders, change its mock in the same commit.** The
sweep's unstyled-class check is what catches this now, but only if you read it.

Known and deliberate, and reported every run: `.mastery-group`,
`.mastery-sub-rows`, `.profile-category-group` and `.profile-subcategory-rows`
are grouping wrappers the JS queries by (`closest`, `querySelector`) and shows
or hides inline — there is nothing for CSS to say about them.
`.feedback-btn--flag` has no rule (the flag button falls
back to the shared `.feedback-btn` look), `.admin-qh__controls` has none
either (its layout is inline on the element), and `watermark-all` is excluded
— it is a glyph-calibration state whose cards differ by design.

**COVERED is reported, never failed on.** It asks the browser, via
`elementFromPoint`, whether tapping the middle of a control would actually hit
it — the one fault class every other check is blind to, because they all
measure one element at a time. It exists because a Privacy link added to the
home screen landed exactly on the dock's three buttons and passed everything:
no overflow, no low contrast, no sideways scroll. A screenshot showed it in a
second. Three versions were needed to get the noise down (rectangle
intersection: 123 findings, nearly all legitimate; hit-testing: 48, mostly
controls behind an open sheet; hit-testing ignoring covering elements larger
than half the viewport: 8, all explicable). At 8 it needs a human to judge, so
it is informational — a check that fails the build on legitimate layout is one
people stop reading.

**`admin.html`, `profile.html` and `privacy.html` had no mocks until
2026-08-19**, so the sweep had never rendered them. Adding the first one
immediately found `.page-header__back` with no CSS rule anywhere: the back
arrow on Profile and Leaderboard had shipped as a bare browser button, no
colour, no padding, no minimum tap target. **A page with no mock is a page
nobody is checking.**

- **Always screenshot before pushing UI changes**, then read the screenshot and
  assess it honestly.
- **Zoom in.** Overview thumbnails hide clipping and misalignment.
- **Test at real dimensions** — same grid, same padding, no `min-height`
  overrides to "see more detail". Testing at fake dimensions and declaring
  success is the single most costly recurring mistake in this project.
- Check light, dark and OLED themes for any visual change.

### Gameplay
- Never show internal state markers (e.g. `__WAGER_LOCKED__`) to players.
- Fully reset game state when returning to the lobby via Play Again.
- Scores must never go negative on regular rounds — only the final wager.
- Clear all previous round data before rendering a new question.
- When fixing a bug, check whether the same pattern exists elsewhere.

### Content
- Date questions should ask for the **year** only, unless the exact date is
  famous (1776, 9/11).
- Number questions should accept ranges or rounded values — never demand exact
  figures for obscure stats.
- Flag any imported question that expects an exact date or a very specific
  number.

### Known cul-de-sacs
- **Do not attempt to make a hieroglyph precisely encircle the emoji bubble.**
  This failed after 20+ iterations; Chromium and Safari render the font at
  different proportions. Keep hieroglyphs as simple centred watermarks.
- `cqi` units are relative to the **content box**, excluding padding. Account
  for padding, or use `transform: translateY(-N%)` which scales universally.
- Use the live glyph tuner (`host.html?tune=𓂀`) for cross-browser calibration
  when Chromium screenshots can't be trusted.
- Do not change working glyphs to fix one broken glyph.
