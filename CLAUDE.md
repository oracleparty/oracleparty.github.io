# Oracle Party

> **This file describes the code as it actually is, including what's broken.**
> The previous version described a smaller, abandoned game and misled every
> session that read it. If you change the architecture, update this file **in
> the same commit** — a change that leaves this file stale is not finished.
>
> Last verified against the code: 2026-08-18.
>
> The live database was verified directly on 2026-08-18 via
> `scripts/probe-db.mjs`. Do not trust `migrations/` as a record of what is
> applied — several were never run.
>
> **A probe result is only as good as the probe.** Two sections of that script
> were reporting confident nonsense; see #6. Facts below that came from it have
> been re-measured since it was fixed.

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

The lesson generalises past this script: **when a check reports that everything
is fine, or that everything is broken, suspect the check.** Both are shapes a
broken measurement makes far more readily than a real system does.

### 7. Migrations are applied by hand

`migrations/*.sql` are pasted into the Supabase SQL Editor manually. Nothing
records which ones were actually run, so **the live schema is not known with
certainty from this repo alone.** Run `scripts/inspect-db.sql` in the SQL Editor
to get the real picture before relying on any table or policy.

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
levels regardless of votes. It now cycles only voted ones, sent over the wire
with the reveal so every client spins the same wheel. The final result can
still be an unvoted level — that is the deliberate last-second switch.

## Categories

`history`, `science`, `nature`, `arts-literature`, `culture-society`,
`pop-culture`, `world-geography`, `technology`, `sports`, `food`, `logic`,
`wild-card` — each with subcategories, defined in `js/categories.js`
(`CATEGORY_META`). Each has a hieroglyph icon and an emoji.

## Other Features

- **Honks** — tap to blast a sound at everyone, throttled by `HONK_THROTTLE`
- **Chat** — in lobby and in game, with typing indicators and message hearts
- **Accounts** — optional; guests can play everything except friends and stats
- **Titles** — unlockable ranks based on accuracy, volume and quirks (`titles.js`)
- **Friends** — requests, accept/decline, see friends' active lobbies
- **Leaderboard** — global and per-category, plus a per-player mastery tree
- **Admin** — dashboard at `admin.html`, gated on `profiles.is_admin`
- **Co-host** — a second player can share host controls
- **Presence + heartbeat** — `last_seen_at` drives stale-player cleanup

### Wanted, not built

- **Sound.** The honk is the only sound in the game, which the owner finds dry
  in play. Candidates: countdown ticks, timer running out, correct/incorrect on
  reveal, the scoreboard animation, the difficulty wheel. Must be mutable, and
  must not fire on a phone whose ringer is off.
- **General UI polish.** Raised after the 2026-08-18 playtest without specific
  targets. Ask for a screen before working on this — it is not a licence to
  restyle working screens on a hunch.

## Database Tables

`rooms`, `players`, `answers`, `chat_messages`, `chat_archive`, `questions`,
`question_feedback`, `question_history`, `game_plays`, `game_history`,
`profiles`, `player_stats`, `friend_requests`, `friendships`, `title_unlocks`,
`site_settings`, `error_logs`.

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
  then longest-present. Absent players can neither hold nor inherit the role.

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

## Question Feedback and Health

**Confirmed working against the live database on 2026-08-18**: `question_feedback`
holds real rows written by real play (3 flags, 2 thumbs-down). This was the
feature most worth verifying and it is not broken. What was broken is the
admin's ability to *act* on it — see #5.

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

**Guests are not players.** Robots sign in as nobody, so they have no tier, no
title and no stats. The lobby row overflow that made the whole page draggable
sideways on a phone needed a tier badge to reproduce, so every scenario passed
while a real signed-in game broke. When a bug is reported that the robots
cannot see, ask what a real account has that a robot does not.

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

Known and deliberate: `.feedback-btn--flag` has no rule (the flag button falls
back to the shared `.feedback-btn` look), and `watermark-all` is excluded — it
is a glyph-calibration state whose cards differ by design.

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
