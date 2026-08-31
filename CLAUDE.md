# Oracle Party

> ## STATE OF PLAY — 2026-08-30, written as a handover
>
> **Read this section first, and read it sceptically.** The owner asked for it
> after a run of game-breaking faults, and asked specifically that it NOT be
> written with false confidence. So each claim below says how it was
> established. Where the answer is "I reasoned it out", treat it as a lead, not
> a fact — several confident statements in this file have turned out wrong, and
> the sections below catalogue them.
>
> ### What is MEASURED (someone ran something and read the answer)
>
> | | Evidence |
> |---|---|
> | Migrations 048–064 are applied | the owner ran each one's verification block and pasted the result; every rule read `ok`. 063 needed a follow-up REVOKE, and 064 is the newest. |
> | The live database has every function and table the app needs | the CI probe on commit `18d199f`. **That tick only started meaning something on 2026-08-30** — before that the probe printed its alarm and still exited 0. |
> | All 12 subjects have title slots (36 subject-level, 45 topics, 26 clearing the size floor) | computed from `title-tiers.js` and `CATEGORY_META` |
> | 664 unit tests and 12 robot scenarios pass | run locally, and in CI on every push |
> | The two round-ending faults were real | reproduced in the harness with an injected slow request, and each re-broken to watch the check fail |
>
> ### What is NOT verified
>
> - **No real playtest since the fixes.** Everything about the game engine below
>   is proven against a *simulated* bad connection in an in-memory database.
>   Nobody has played a real game on a real phone since. **That is the single
>   biggest gap.**
> - **"Friend couldn't submit at times" was never reproduced.** A mechanism was
>   found that follows from a stalled round, and it is plausible, but it was
>   inferred rather than measured. If it recurs, do not assume it is fixed.
> - **The countdown backstop and the clock-stamp timeout are new** (2026-08-30)
>   and have never run in a real game.
> - **No placeholder title words exist live.** Migration 064 is applied and the
>   admin button exists; the owner had not pressed it as of this writing.
>
> ### What is the OWNER'S to do, and cannot be done for them
>
> 1. **Write the title words.** ~86 slots are empty. The admin page's Title
>    Words panel lists every one with its target. **Do not generate these** —
>    model-written title text has been deleted twice at their instruction. The
>    only exception is the mechanical placeholder (`placeholderWord`), which is
>    tier + subject and never invented.
> 2. **Add ~a dozen questions each to History's Ancient (58) and Medieval (52)**
>    so they clear the 60-question floor and can carry words of their own.
> 3. **Play a real game** and report what breaks.
>
> ### The three faults reported in the last playtest, and their status
>
> | Reported | Cause found | Fixed | Proven how |
> |---|---|---|---|
> | timer ran out, nothing auto-submitted, "Reveal early" stuck | the round-ending backstop skipped the host, and in a solo game the host is the only human | yes | harness: `round ended after never` → `after 39s` |
> | bot slow to show its answer | the host's whole question screen, and the bot, sat behind one un-timed network call | yes | harness: card and answer box visible while the stamp hangs |
> | a player could not submit at times | *inferred* — a stalled round means later answers are refused as late | probably | **not reproduced** |
>
> ### Habits this session kept proving right, and kept violating
>
> - **A check that cannot fail is worse than none.** Three checks written today
>   passed with the fix reverted and had to be rewritten. Always break the fix
>   and watch it go red.
> - **Only change what was asked.** The Title Builder slot machine was rebuilt
>   without being asked and had to be reverted in full. A question from the
>   owner is not an instruction.
> - **The harness lies in the direction of permissiveness.** It could not see
>   column grants until today, and it still cannot see real latency except
>   through `store.slowFunction` / `slowReads`.
>

> **This file describes the code as it actually is, including what's broken.**
> The previous version described a smaller, abandoned game and misled every
> session that read it. If you change the architecture, update this file **in
> the same commit** — a change that leaves this file stale is not finished.
>
> Last verified against the code: 2026-08-30.

> ## 2026-08-31 — a playtest list, worked one at a time
>
> Nine things the owner reported after a real game. Written the way the section
> above asks for: each says how it was established, and the ones that are
> inference say so.
>
> ### The game-breaker: a co-host revealing the final question
>
> **REPRODUCED in the harness, fixed, and the fix break-tested.** The owner's
> words: *"gamebreakingly glitched after difficulty selection. I couldnt see the
> clue, it kept rerolling the difficulty, the question appeared phased on the
> wager selection screen, i couldnt even type, my friend saw a different
> question."*
>
> "Reveal Question" is gated on `canControlGame()`, so a **co-host or a deputy**
> can press it — and `handleRevealFinalQuestion` swaps the final question and
> writes a new `question_ids`. Two guards were written as *"am I the host"* when
> they meant *"am I the one who did this"*, and both broke:
>
> | | |
> |---|---|
> | `handleRoomChange` | `questionIdsChanged` was gated on `!state.room.isHost` — correct when only the host could change the list, and since co-hosts can, **the host was the one client structurally unable to hear about it**. Measured: room and co-host on q15, host still showing q21. Migration 046 judges against the ROOM's question, so the host answers one nobody asked. |
> | the `reveal` broadcast | skipped the animation on `state.room.isHost`, so the host got **no slot machine at all** when a co-host revealed. The channel is `broadcast:{self:true}`, so the presser also hears itself — reading the code, it runs the animation twice, two six-second chains of uncancellable `setTimeout`s over a `position:fixed; z-index:10000` overlay. |
>
> **The double-run is READ, not measured** — say it that way. Both chains
> overlap so tightly that neither a `hidden` observer nor a `--show` observer
> sees two transitions. What WAS measured is the host getting zero animations
> and the two phones being asked different questions.
>
> A third fault sat underneath: `syncToCurrentState`'s repair called
> `handlePhaseTransition`, which **refuses a phase it is already on** — the
> `question` branch bails on `_lastProcessedQuestion === currentQuestion` and
> everything else on `phase === state.gamePhase`, and both are true by
> construction in the only case this repair exists for. So the list was
> corrected in state and the screen kept the old question. It calls
> `showQuestionScreen()` directly now.
>
> `scenario-cohost` covers it: the co-host drives to the final wager and
> reveals, and every phone must be asked the room's question AND must have run
> the reveal. Verified by reverting all three — it names *"Alice is being asked
> 'Test question 30?' while the room asks 'Test question 9?'"*. **Its bank had
> to be re-seeded with mixed difficulties first**, or `fetchQuestionByDifficulty`
> finds nothing, the swap never happens, and the check agrees with itself
> whatever the code does — the same trap that cost `scenario-fullgame` its
> coverage.
>
> ### The rest of the list
>
> | Reported | Cause | How established |
> |---|---|---|
> | collapsible panels do nothing | `.title-rows { display: flex }` is an AUTHOR rule and beats the UA's `[hidden] { display: none }` whatever the specificity. Three other places in the stylesheet already carry the `[hidden]` line; the newest forgot | screenshot, break-tested |
> | admin Title Words slow / broken | `measureTopicSizes()` awaited `fetchQuestionCount` **64 times sequentially** — 12 subjects + 52 topics — before drawing anything. 15-30s on a phone. Batched 8 at a time | counted from `CATEGORY_META` |
> | players cannot see placeholders | the **Fill placeholders button lives inside that panel**, so it was unreachable. One slow loop, three complaints | inference, and it follows |
> | friend cannot accept a request | `parseInt(dataset.accept, 10)` on `friend_requests.id`. Migration 003 declares BIGINT, but #10 measured the live `friendships.id` as a **uuid** and the live `friend_requests` as missing 003's UNIQUE — so those tables were not made by 003. `parseInt("3f25…")` is `3`; `parseInt("a3f2…")` is `NaN` | strong inference, NOT measured — the fix is type-agnostic so it does not depend on which |
> | "it said I sent one as well?" | the profile card ignored `autoAccepted` and flattened every error to "Already Sent". You became friends and it said "Request Sent" | read |
> | the bot says "Waiting..." | an empty answer before the reveal reads as WAITING because a human's real answer may be in flight. **A bot has nothing in flight, and a blank IS its answer** for the ~20% of the bank with no stored distractor | read |
> | shown away too eagerly | presence flips the instant a phone backgrounds. `awayTimestamps` has always recorded WHEN, for exactly this, and nothing read it. `AWAY_GRACE_MS` (10s), display only | break-tested both ways |
>
> **`AWAY_GRACE_MS` IS DISPLAY ONLY.** Deputising (`HOST_HANDOVER_MS`) and
> releasing a seat (`STALE_TIMEOUT_MS`) read `last_seen_at` and are untouched:
> the game still stops waiting for an absent player at once. Only the label
> waits. It has four readers, so it is one exported `isPlayerAway` in
> `js/game/state.js` plus the lobby's own — not the grace written out five
> times. Both scenarios check BOTH halves (quiet early, labelled late); either
> alone is a check that cannot fail.
>
> ### The `picker.onclick` crash was already gone
>
> The reported `null is not an object (evaluating 'picker.onclick …')` exists in
> **exactly one commit** — `7a9f9f6`, 16:06 UTC — and was removed by `fd769bb`
> at 17:45 the same day, the Title Builder revert. `git log -S"picker.onclick"`
> is the whole investigation. **Do not go looking for it in HEAD.**
>
> ### A hard dependency the app should not have had
>
> `fetchTitleWords` named `is_placeholder` in its `select`. That column arrives
> in **migration 064**, migrations here are applied by hand, and PostgREST
> answers `42703` for the WHOLE select — so if 064 is not applied, **every
> owner-written word disappears from every screen**, with nothing but a console
> warning. It retries without the column now and reads every row as written,
> which is the harmless direction. This project's own rule is that the
> JavaScript must be safe to deploy before the SQL is run; that select broke it.
>
> ### Two things deliberately NOT done
>
> - **The Title Builder wheel is not coloured by rarity.** Only the gallery
>   rows are. The owner asked for "each title word" in a conversation about the
>   gallery, and this file records the wheel being rebuilt unasked once and
>   reverted in full. Ask before touching it.
> - **Four dead locals remain** — `fromPhase` (reveal.js), `fromPhaseFW` /
>   `fromPhaseFQ` (scores.js), `questionAtExpiry` (question.js). Each is
>   assigned once, read never, and carries a paragraph explaining machinery that
>   is switched off (`expectedPhase` is `null` at every call site). They are
>   debris from the compare-and-set retreat, they change nothing, and removing
>   them was not asked for. **The comments lie about what is running** — that is
>   the reason to delete them, when somebody decides to.
>
> ### Also corrected in this pass
>
> - **The room code is FOUR LETTERS, not six digits.** `generateRoomCode()` in
>   `js/db/rooms.js` picks 4 from A-Z. This file said "6-digit" in four places,
>   including two security arguments about how easily a room is found.
> - `cleanup()` cleared the countdown backstop **inside `if (state._advancePollId)`**,
>   and `_advancePollId` is only set during a QUESTION while that timer only runs
>   during a COUNTDOWN — so the clear was unreachable exactly when it applied.
>   (`state._advancePollId = null` also appeared twice: an edit that landed in
>   the wrong place, in `60f40d8`.) The leak lint reads `cleanup()` for the
>   CLEAR and cannot see that it sits behind an unrelated condition.
> - `docs/BOTS.md` still says the bot's final wager is 10; `constants.js` says
>   20, on the owner's instruction. The doc is stale, not the code.
>
> ### What this pass did NOT establish
>
> Nothing here explains a stall or a refusal on the **live database**. The CI
> probe on `18d199f` (2026-08-30 15:48) reports every `op_*` function and every
> watched column installed, and `answers -> players: no relationship`, so 052 is
> applied. But **the probe runs as `anon`, and since anonymous sign-in every
> real player is `authenticated`** — the exact blind spot that broke room
> creation in slice 8c. That repair was run by hand and **is in no migration
> file**, so this repo cannot say what the live policies are. One query settles
> it, and it is the owner's to run:
>
> ```sql
> SELECT schemaname, tablename, policyname, cmd, roles
>   FROM pg_policies WHERE schemaname = 'public' AND roles <> '{public}';
> ```
>
> **THE LOCKDOWN IS APPLIED. Migrations 048 through 064 are all live —
> measured on the live database from the owner's SQL Editor, each by its own
> verification report, between 2026-08-28 and 2026-08-30.** 062 (the deputy
> window), 063 (title words as content, plus a follow-up REVOKE the first
> version needed) and 064 (the placeholder flag) are the newest. 061's eight rules came
> back ok: nobody can write `rooms.game_phase` or `current_question` directly,
> and every other room write a client legitimately makes still works. See
> fact #2 for the table of what is closed and the two nuisances left open
> deliberately.
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
>
> **Migrations 053, 054 and 055 are APPLIED — measured on the live database on
> 2026-08-28**, from the owner's SQL Editor, by a report that looks at
> `pg_proc`, `pg_policies` and `to_regclass` rather than asserting a count.
> Every one of its eight rules came back ok: `get_leaderboard` and
> `op_rate_host` installed, `host_ratings` and `host_reputation` present, no
> policy exposing who voted, no policy letting a client forge a rating, no
> policy letting a player write their own `question_history`, reading still
> open so question selection does not revert to a plain shuffle, and all three
> SECURITY DEFINER writers of history intact. **`friendships` holds 2 rows** —
> so the friends leaderboard has something to show, which was the open question
> when it shipped.

## What This Is

A mobile-only browser trivia party game. Players join a room with a 4-letter
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

**Partly false since migration 056 — see "Slice 7" below.** The TIME-BASED
transitions (`countdown -> question`, `question -> reveal`, and repairing a
question whose clock never started) are decided by the database now, and any
player in the room can ask for them. Everything a person decides — the host
pressing "Reveal Results", "Next Question", Play Again — is still a write from
one phone, and that is what the rest of this section describes.

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

### 2. Database permissions WERE effectively wide open

**Substantially closed as of 2026-08-29.** This section's history is kept below
because the reasoning still applies to what is left, but the headline has
changed. Seven doors were shut, each measured against a real Postgres, each
verified by breaking it, **and every one of them applied to the live database
and confirmed there by its own report**:

| Was open to anyone | Closed by |
|---|---|
| delete any room mid-game | 048 |
| mark any answer right or wrong, or delete them | 049 / 051 |
| write your own stats for the whole question bank | 055 |
| forge or read a host rating | 054 |
| remove any player from any live game | 057 |
| make yourself host of any live game | 058 |
| end, rewind or skip a live game | **061** |

**What is still open, deliberately:** `players.last_seen_at` (so somebody could
make you look absent and have you swept — narrowed from any column to one), and
`rooms.question_started_at` (a round's clock can be reset). Both are nuisances
rather than takeovers, and both need their own enumeration rather than being
tacked onto a slice that was about something else.

### 2b. The original entry, kept for its reasoning

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

**`question_history` was the exception, and it is closed — migration 055.** See
"Nobody can write down their own score" below. Every number the app shows about
a player derived from a table any signed-in person could write directly, so a
leaderboard position, a tier badge and every title could be set to anything in
one request, without playing. It could be shut ahead of the rest for the same
reason `chat_messages` could: the app had already stopped needing the right.

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

**The owner's idea, and it is a good one: you arrive to an empty room.** A
player now reads chat from the moment they first entered a room, not everything
said before it (`rememberChatCutoff` in `auth.js`, `fetchMessages(roomId,
since)`).

**Be precise about what this is.** It is NOT a permission and does not close
the paragraph above — anyone crafting requests by hand still reads everything.
What it closes is the realistic leak: room codes are four letters and public
games are listed, so anybody can walk in, and until now they arrived to the
whole transcript. That is how a private conversation actually escaped.

Two decisions inside it, both of which the obvious implementation gets wrong:

- **SET ONCE, never moved forward.** The literal reading of "fresh on entry" is
  per page load, which is worse than the problem — refresh your phone mid-lobby
  and the conversation you were part of vanishes. A rejoin also deletes the
  player row and writes a new one stamped later, so anything recomputing the
  cut-off from `joined_at` would hide what was said while the player was
  sitting there. `scenario-join` proves this by restamping the seat forward,
  which is the only way to make the two behaviours differ inside a test that
  runs in seconds while the rule is written in minutes.
- **Biased EARLY by `CHAT_HISTORY_GRACE_MS` (2 min).** `joined_at` is written
  by the phone; `chat_messages.created_at` is written by the database. The two
  are only as aligned as that phone's clock, which is why this project already
  keeps a `getServerTimeOffset()`. A cut-off landing too late hides messages
  meant for the player and reads as chat being broken; too early shows a couple
  of minutes of what came before, which costs nothing because this was never a
  lock. The scenario seeds one old message AND one recent one — without the
  recent one it would pass just as happily with the feature reverted to "hide
  everything".

`archiveChatMessages` deliberately passes no cut-off: the archive is the room's
record, not one player's view of it.

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
list, and as of 2026-08-23 the probe reports **nothing on the watch list
missing** — every RPC and view the app reads is installed.

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

**A THIRD ONE ON THE SAME PAGE, found 2026-08-29: the error log's "Clear 7d+".**
A bare `delete()` whose result was thrown away, followed by a redraw. Found by
listing every write in `js/admin.js` and asking of each one what the screen says
when it is refused — the same sweep that found the End button, which had shipped
broken and stayed that way because nothing had ever pressed it.

**AND `writeSucceeded()` IS THE WRONG TOOL HERE, which is worth knowing before
reaching for it.** Its rule is *zero rows means refused*, and that only holds
when the write is aimed at something known to exist. This delete is filtered
`WHERE timestamp < cutoff`, so zero rows is genuinely ambiguous: a refusal and
"there is nothing older than seven days" are the same silence. Wrapping it in
`writeSucceeded` would report a permission error every time the window happened
to be empty — a confident lie in the other direction.

Counting the old rows FIRST is what separates them, and it costs one query:
`0 old` is "nothing to do", `N old and 0 deleted` is a refusal, anything else
worked. **When a write's filter can legitimately match nothing, establish
whether there was anything to write before reading zero as failure.**

Nothing has established that the delete IS refused — migration 019 grants it and
its predicate is right (`profiles.user_id`, not the `.id` mistake above), but
migrations here are hand-applied and nothing records which ran. **This is a
diagnostic, not a diagnosis**, the same call as `upsertQuestionFeedback`: what
was wrong is that nobody could tell either way, and now one press says so.

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
and `increment_questions_answered` are installed. `get_mastery_counts` was not,
and `fetchMasteryCounts` has always fallen back to a client-side query, so the
mastery tree worked — slowly — and nobody noticed. **It is installed as of
2026-08-23** (migration 032 was run at some point without being recorded here,
which is #7 in miniature: the file was stale in the reassuring direction).

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

**A fourth and a fifth, found 2026-08-25, and both are the same shape as the
third: the probe could not tell "nothing there" from "I looked in the wrong
place".**

- **`question_health` was listed under the wrong key column.** The `PK` map said
  `question_id`; migration 025 builds the view as `SELECT q.id, ...`, so the key
  is `id`. `samplePks` asked for a column that does not exist, PostgREST answered
  42703, the sample came back empty — and the write section reported
  `no rows to probe with` **for a view holding 4,859 rows**. Fixed, and
  `samplePks` now returns WHY it could not sample, so a wrong column name reads
  as `NOT PROBED — could not sample "x" (HTTP 400 / 42703)` instead of as an
  empty table.
- **`player_totals_computed` was not on the watch list at all.** The GLOBAL
  leaderboard reads it (migration 032). Its absence is quieter than
  `player_stats_computed`'s, which is exactly why it needs watching:
  `fetchPlayerTotalsForLeaderboard` falls back to summing the per-category
  rollups, so **the board still draws — with a question filed under two
  categories counted twice.** 11% of the bank carries more than one, so the
  people who play the broadest categories rank highest and nothing anywhere
  says why. It is on the list and in WHAT THIS MEANS FOR A PLAYER now.

**A SIXTH, found 2026-08-29, and it is the mirror image of the other five.**
Those all reported an ABSENCE that was really a bad question. This one reported
**HEALTH for a thing it had never looked at.**

The probe ends with a WHAT THIS MEANS FOR A PLAYER section that maps a missing
database object to the features it takes down. `op_advance_phase` had an entry
there from the day migration 056 shipped — and was never added to the list of
functions the script actually calls. The consequence list is filtered against
the functions that came back missing, so an unprobed name **can never appear in
it**. Every run printed `Nothing on the watch list is missing` about a function
nobody had asked after.

**Nine of them, not one.** `op_leave_room`, `op_set_judgement`,
`op_disqualify_round`, `op_advance_phase`, `op_remove_player`,
`op_set_host_role`, `op_set_phase`, `op_sweep_rooms` and `delete_my_account`
were all called by `js/` and watched by nothing.

**And the lockdown made that far worse than it was when it started.** The
045-047 block in the probe says these functions "fall back" when missing, which
was true then. Since 048-061 revoked the matching client rights, a missing
function is not a slower path but a REFUSED one — and for `op_set_phase` the
refusal is a hard `permission denied for column game_phase`, so **no game
starts or advances at all**. That is the 055 lesson arriving a second time: a
dependency that was a fallback becomes load-bearing the moment you shut the
door beside it, and the monitoring has to be re-read in that light or it goes
on describing the old world confidently.

The fix that matters is not the nine entries, it is the **guard**: the script
now fails if any object named in the consequence list is not actually probed,
or is named twice. Verified by breaking both — un-probing `op_advance_phase`
reports it by name and exits 1, and the duplicate check caught a duplicate
entry **I introduced while writing it**.

**Two functions are deliberately NOT probed and say so on every run.**
`op_sweep_rooms` and `delete_my_account` take no arguments, so there is no
unparseable uuid to stop the body running — the trick every other entry
depends on — and calling them would sweep real rooms and delete a real account.
They print `NOT PROBED — takes no arguments and its body deletes …`, which is
the same honest gap this script already leaves for DELETE permissions.

`scripts/check-rpc-args.mjs` now reads the probe's argument names too, because
PostgREST resolves by name and a typo there makes an installed function answer
404 — printed as `*** NOT INSTALLED ***` and turned into a confident paragraph
about a broken game. **A measurement lying in the alarming direction is still a
lying measurement.** Verified by misspelling `p_caller_id`: it names the file,
the line and the real signature.

The lesson generalises past this script: **when a check reports that everything
is fine, or that everything is broken, suspect the check.** Both are shapes a
broken measurement makes far more readily than a real system does. And the
particular way this script keeps failing is worth naming on its own: **every
one of these five reported an ABSENCE that was really a bad question.** A probe
that cannot reach something must say so; returning the same answer as "there is
nothing here" is how a dead feature reads as a healthy one.

### 7. Migrations are applied by hand

`migrations/*.sql` are pasted into the Supabase SQL Editor manually. Nothing
records which ones were actually run, so **the live schema is not known with
certainty from this repo alone.** Run `scripts/inspect-db.sql` in the SQL Editor
to get the real picture before relying on any table or policy.

### 10. The live database enforces rules this repo has never heard of

Every earlier instance of schema drift here was the live database MISSING
something `migrations/` declared. On 2026-08-23 it went the other way, and that
direction is worse, because reading every migration in the repo cannot reveal
it.

`friendships` carries a constraint in no migration file:

```
friendships_source_check  CHECK (source = ANY (ARRAY['lobby', 'search']))
```

`acceptFriendRequest` is the only caller of `createFriendship` anywhere in
`js/`, and it passes `'request'`. **So every accept of a friend request died on
a 23514, for everybody, for as long as that constraint has existed.** The error
reached `logger` and the button said "Error". Nobody could become anybody's
friend.

The column is also **NOT NULL with no usable default**, which matters because
the obvious workaround — omit `source` and let the default apply — fails with
`23502` instead. That was tried, in a migration the owner ran, and the database
refused it. **Both halves are measured, and the second only because the first
fix was wrong and said so out loud.**

`migrations/044` widens the constraint to allow `'request'`, which is a real
third source worth recording. `createFriendship` also falls back to `'search'`
on any 23514, so the app is correct before that is run as well as after.

`friendships.id` is a **uuid** on the live table; migration 003 declares
`BIGINT GENERATED ALWAYS AS IDENTITY`. Nothing depends on it today. Do not
assume any column's type from `migrations/`.

**`friend_requests` has no unique constraint either**, though migration 003
declares `UNIQUE(sender_id, receiver_id)` — proven by three rows for one pair
in the live table. Both `sendFriendRequest` guards used `.maybeSingle()`, which
ERRORS on more than one row, and both discarded the error — so once two rows
existed for a pair every guard on it failed open, including the auto-accept.
Two people who each sent the other a request in March were never made friends
and were never told anything. The client no longer depends on the constraint;
044 adds it.

**THE SAME FAULT WAS ONE TABLE ALONG, and fixing only `friend_requests` left
it (found 2026-08-24).** `friendships` has no unique constraint either until
044, and `isFriend` used `.maybeSingle()`. Two people who each accepted the
other produce two rows for one pair, and from that moment `isFriend` returned
**false for people who really are friends**:

| Consequence | |
|---|---|
| `sendFriendRequest`'s "Already friends" guard | falls straight through |
| the profile | offers "Add Friend" to an existing friend |
| the friends list | shows that person twice, with two Remove buttons |

`isFriend` uses `.limit(1)` now, so the answer is the same for one row or five;
`fetchFriends` de-duplicates on the friend's user id; and `createFriendship`
returns success when the pair is already friends rather than relying on the
23505 that only exists once 044 has run.

**When a lookup breaks on duplicates, go and find every OTHER lookup keyed on
the same pair.** One table was fixed and the identical shape sat one join away
for weeks.

**AND THAT INSTRUCTION WAS NOT FOLLOWED FAR ENOUGH — two more, found
2026-08-25.** Both are read-then-write on a pair, both used `.maybeSingle()`,
and both **discarded the read error**, which is what turns a lookup fault into a
ratchet: `maybeSingle()` errors on more than one row, the error was thrown away,
`existing` came back undefined, and the code took the "no row yet" branch and
**inserted another one**.

| | keyed on | what one duplicate then does |
|---|---|---|
| `upsertQuestionHistory` | `(user_id, question_id)` | every reveal of that question adds another row — and accuracy is `SUM(times_correct)/SUM(times_seen)` across them, so each one is a permanent extra attempt the player never made |
| `upsertTitleUnlock` | `(user_id, word_id)` | `evaluateUnlocks` runs at the end of EVERY game, so the ratchet turns once per game — and the level check goes with it, since a fresh row is written at whatever level was passed instead of being compared to the level already held |

`title_unlocks` **declares** `UNIQUE(user_id, word_id)` in migration 007. So did
`friend_requests` in migration 003, and the live table did not have it. A
declared constraint is not a measured one, and the client should not need it.

Both now use `.limit(1)` and **stop on a read error rather than inserting**. A
FAILED READ IS NOT AN ABSENT ROW: inserting when you cannot tell is the step
that creates the duplicate. Losing one attempt or one unlock is recoverable —
Proficiency reads the most recent verdict, and the unlock check runs again after
the next game — while a duplicate cannot be undone from inside the app at all.
`upsertTitleUnlock` also orders by level so that if duplicates already exist it
compares against the HIGHEST one held, not an arbitrary row.

**Nothing has established that duplicates exist on the live database**, and this
is a hardening, not a diagnosis. Both tables are locked to visitors, so the
probe cannot count them; the owner can, from the SQL Editor:

```sql
SELECT 'question_history' AS tbl, count(*) AS duplicate_pairs FROM (
  SELECT user_id, question_id FROM question_history
   GROUP BY 1,2 HAVING count(*) > 1) d
UNION ALL
SELECT 'title_unlocks', count(*) FROM (
  SELECT user_id, word_id FROM title_unlocks
   GROUP BY 1,2 HAVING count(*) > 1) d;
```

Two zeroes means the client fix is pure insurance. Anything else needs a merge
migration written deliberately — for `question_history` the counters must be
SUMMED, never deduplicated by deletion, or real attempts are thrown away.

**When something works in the harness and fails live, ask what the real
database REFUSES that the fake one allows.** Two faithfulness gaps were found
in one evening this way — `maybeSingle` returning a row where PostgREST errors,
and the store accepting any row at all — and each had been hiding a live bug
for months. `store.addCheck()` now simulates a CHECK constraint, and
`maybeSingle` errors on multiple rows.

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
Migration 032 — `player_totals_computed` (honest global totals) and
`get_mastery_counts` — **is applied**, confirmed by the probe on 2026-08-23.

Measured earlier that day: the live database answered **`PGRST205`** for
`player_stats_computed` — "could not find the table in the schema cache". Not
`42501`, so it was absent rather than locked. Migration 017 created it and was
apparently never run (#7).

Four reads in `js/db/social.js` go to that view. While it was missing, each
logged and returned `[]`:

| Read | What the player sees |
|---|---|
| `fetchAllPlayerStatsForLeaderboard` | nothing — **DEAD CODE as of 2026-08-26**, see below |
| `fetchCategoryLeaderboard` | every category leaderboard empty (superseded by `get_leaderboard`, migration 053) |
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
section is empty: as of 2026-08-23 nothing it watches is missing.

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

**A third counting question, and the owner settled it.** A combined total sums
across *categories*, and a question filed under two topics produces a row under
each. Measured: **105 of 1000 questions carry more than one category (11%),
1.11 tags each**. For a per-topic proficiency that duplication is correct and
stays — getting a History-and-Culture question right is evidence about both.
For a single combined total it is not, so `player_totals_computed`
(migration 032) counts each answered question once.

**HISTORICAL FROM 2026-08-26.** The global board is gone and points with it —
see "The leaderboard ranks what you know, among people you know". Migration 053
does the same de-duplication with `COUNT(DISTINCT question_id)`, which cannot
double count and needs no second view. The reasoning above is kept because the
counting question outlives the board that raised it: **anything summing
per-category rows still double counts a multi-category question**, and that
applies to the profile, the titles and anything added later.

**Points were correct answers, not game score, and that was deliberate.** The
owner's reasoning, which still holds for any score-based measure: a game score
depends on which wagers a player happened to hold and on which host was judging
— including any judgement they overrode — so it is not comparable between two
people who never played together. If a points measure is ever wanted again, do
not build it on `game_history.score`.

---

## File Structure

```
├── index.html          Splash + Home + display-name entry
├── host.html           Category browser + host settings
├── join.html           Room code entry, friends' games, public games
├── lobby.html          Lobby: chat, player list, ready state, start
├── game.html           All in-game screens (see below)
├── profile.html        Player profile, stats, mastery tree
├── leaderboard.html    Friends only: mastery / proficiency, by category
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
│   ├── titles.js       Title unlock rules, the rarity ladder, the word overlay
│   ├── title-content.js  Loads the owner's written words (the ONLY fetcher)
│   ├── utils.js        Fuzzy answer matching, DOM helpers, escaping
│   ├── honk.js / typing.js / presence.js / theme.js / logger.js
│   ├── celebration.js  Unlock overlays (planCelebration lives in titles.js)
│   ├── difficulty-band.js  "How hard was that?" on the reveal
│   ├── NO-IMPORT modules — pure, unit-testable in Node, because everything
│   │   else here pulls Supabase from esm.sh and the test runner cannot load it:
│   │   ├── question-selection.js  bucketQuestionsByHistory — what to ask next
│   │   ├── honeycomb.js          the Map's geometry
│   │   ├── radar.js              the profile's twelve-axis chart
│   │   ├── answer-health.js      which answer keys need a human (admin + probe)
│   │   ├── presence-health.js    is the presence channel still joined
│   │   ├── title-tiers.js        which tiers a topic offers, and at what count
│   │   └── game/bot-logic.js     bot decisions
│   └── constants.js    All timing + threshold values
├── migrations/         Hand-applied SQL (see #7 above)
├── scripts/
│   ├── screenshot.js       Playwright screenshots of mock states
│   ├── mock-states.js      Fake data for visual review
│   ├── layout-sweep.mjs    Measured layout/contrast/overlap check, all 3 themes
│   ├── probe-db.mjs        What the LIVE database actually has (runs in CI)
│   ├── verify-sql.mjs      SQL/JS judging parity + tests/sql/ rule tables
│   ├── check-arity.mjs     Calls passing fewer arguments than required
│   ├── check-rpc-args.mjs  .rpc() argument names vs the function's real ones
│   ├── bump-version.js     Bumps ?v= on assets + sw.js cache key
│   └── inspect-db.sql      Read-only live schema report
└── tests/              Vitest unit tests + harness/ robot scenarios
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
2. **Players** join by 4-letter code, from a friend's lobby, or from public games.
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

**THAT LAST SENTENCE WAS TRUE OF ONE SCREEN AND WRITTEN AS THOUGH IT WERE TRUE
OF THE FEATURE.** The guard went into a private helper in `reveal.js` and two
other readers of the same count — `updateRevealButtonText` and the Realtime
answer handler in `phases.js` — never got it, so the countdown went on vanishing
on the last round of every game until 2026-08-25. See "Dropping the key broke
'has everybody answered'" for how it was found and what it now shares with the
departed-player guard.

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

**THE WHEEL NOW ALWAYS VISITS ALL THREE, and this has flip-flopped twice — do
not narrow it again without the owner.** It cycled all three originally, was
narrowed to only outcomes that could actually win, and the owner's answer is
that a slot machine showing symbols it will not land on is not lying, it is a
slot machine: the reels are theatre, the landing is real.
`allowedDifficulties` still governs what can HAPPEN, through
`pickWeightedDifficulty`. Only the animation changed.

The history below is kept because the reasoning at each step was sound and the
conclusion still moved:

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
- **Leaderboard** — **friends only**, ranked on mastery or proficiency, by
  category and subcategory, all-time or over a period. See "The leaderboard
  ranks what you know, among people you know". The per-player mastery tree and
  the Map live on the profile.
- **Host reputation** — "would you play with this host again?", read before you
  join a stranger's game. See "Judging the host, not the ruling".
- **Admin** — dashboard at `admin.html`, gated on `profiles.is_admin`.

  **The page is four stat cards and eight collapsed panels**, one open at a
  time, each opening on a tap. It used to be nine sections open at once, all
  fetched before anything rendered — comprehensive and unreadable, which on a
  375px phone is the same as unusable: the flag you came to read was 4,000px
  down and the heaviest query on the page ran for an admin who never scrolled
  to it. Each panel's data is now fetched the **first** time it is opened.

  **The count on a closed row is what makes the collapse work.** "3 flags"
  visible without opening anything is the whole point — a page that hides
  everything behind identical doors is worse than a long one. `loadPanelCounts`
  gets them with `head: true` counts, and a failed count renders **`?`, never
  `0`**: an unreachable table and an empty one must not look alike (#4, #6, #8).
  Only flags and errors go amber, and only when non-zero — colour everything
  and it stops meaning anything. The chips take `--color-primary` as **text on
  a surface**, not as a fill; inverting that drops the label to ~2.5:1 on the
  light theme, which is exactly how the tier badges broke.

  `scenario-admin` opens all eight and fails if two are open at once, if one
  stays blank, or if a non-zero flag count is not highlighted. Verified by
  breaking each: removing the close-the-other line reports seven panels open by
  name. Ordered by how often an admin needs it, so Flagged Questions is first —
  the question bank used to be at the bottom of the longest page in the app.

  **A question can be refiled from the page.** The Question Bank editor now
  carries category chips and a subcategory menu alongside text, answer,
  alternates, format and difficulty — a language question stuck in Food and
  Drink used to need the Supabase SQL editor. `categories` is an array (11% of
  questions carry more than one, deliberately), so it is chips rather than a
  menu; the subcategory list is rebuilt from whichever categories are ticked,
  so it can never offer a filing that belongs to a category the question is not
  in. A value stored under a category that gets unticked is offered back under
  "Currently filed as" rather than vanishing, because vanishing from the menu
  would mean silently cleared on save. **Saving with no category is refused** —
  a question in none is drawable by nothing and findable by no filter, which is
  worse than deleted because it still counts in the bank.

  `flattenSubcategories` in `categories.js` is the single source for that menu,
  and `tests/categories.test.js` pins two things about it: every key it offers
  resolves back to a real node, and no key prefixes an unrelated one. The
  second matters because selection matches with `LIKE 'key%'`, so a collision
  between branches would silently drag one subcategory's questions into
  another's — children like `human` → `human-countries` are meant to nest and
  are exempted by descent, not by name.

  The four stat cards open the list they were counted from; before that they
  were the only figures on the page that could not be checked. **An account row opens**
  to show who it actually is — email, sign-up method, whether the address was
  ever confirmed, last sign-in — plus games, sessions, wins and what they play.
  The identity half goes through `admin_account_details` (migration 042),
  because all of it lives in `auth.users`, which PostgREST does not expose and
  must not: every browser carries the same publishable key, so a readable
  `auth.users` would be a public mailing list. One account per call, so an
  email reaches the screen only after a deliberate tap. It degrades to the
  computable half when the function is missing.

  **Every row on that list is a real account.** Guests have no `profiles` row
  at all, so nothing there is a guest — "New Player" means somebody signed up,
  or arrived through Google, and never chose a name.

  **Games and sessions are both shown, and they answer different questions.**
  `game_history` holds one row per player per finished game, so counting rows
  is games and counting distinct `room_id`s is sessions: six rounds with the
  same group in one evening is six games and one session. Thirty games across
  two sessions is a different player from thirty across twenty-five, and
  neither number says that alone.

  **Games Active says why a room looks active** — "2 of 3 still here", or
  "4 players, all silent — abandoned". See the note on abandoned rooms below.

  **Games Today is the local calendar day**, midnight-to-now where the reader
  is, not UTC and not a rolling 24 hours. That matches the word "today"; the
  rolling question is what Games Active answers. Two actions live there:
  ending a stuck room, and deleting somebody's account via
  `admin_delete_account` (migration 037). That function takes a user id, which
  is a dangerous shape, so it carries three guards — the caller must be an
  admin (checked on `profiles.user_id`, never `profiles.id`, see #5), it
  refuses to delete the caller, and it refuses to delete another admin. Its
  delete list is deliberately identical to `delete_my_account`'s: if one grows
  a table the other does not, "I deleted my account" and "an admin deleted my
  account" stop meaning the same thing.
- **Bans are not built, and would not work yet.** Guests never signed in, so a
  ban could only bind to an account, and the banned person played as a guest or
  cleared their browser data. **Invisible accounts (Slice 8a) change the first
  half of that**: a guest now has a durable id per device, so a ban has
  something to bind to. Clearing browser data still mints a new one, so it
  raises the cost rather than closing the door — do not describe it as solved.
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

  One measured target existed: the question screen's content stops at 448px
  whatever the phone, leaving **47% of an iPhone 14 empty below the answer
  box** (33% on a smaller SE). The proposal was to fill it only AFTER the
  player submits — avatars lighting up as others answer, and where you stand.
  **The owner looked at it on a real phone on 2026-08-23 and does not see a
  problem**, so it is parked. A measurement said the space was empty; a person
  holding the device said the screen reads fine. **Do not reopen this on the
  strength of the number alone** — it was never evidence that the screen looks
  wrong, only that there is room in it.

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
`friendships`, `title_unlocks`, `site_settings`, `error_logs`, `host_ratings`.

---

## One person, one seat

**Reported from a live game: three copies of one player in the lobby, all
flagged host.** It needs a leave whose unload beacon never fires — a locked
phone, a dead battery, lost signal — which leaves the row behind. Two faults
then stacked into a **ratchet**:

- `join.html` called `addPlayer` unconditionally, with no check at all, so
  coming back made a SECOND row.
- `ensureCurrentPlayer` in the lobby adopted an existing row only when there was
  **exactly one** match, and otherwise added another. So at two duplicates it
  made a third, at three a fourth, **and it could never get back to the one case
  it knew how to handle.** Every return from then on added another copy, for the
  life of the room.

The guard was written for a real reason — two guests both called "Alice" would
be silently merged onto one id — but its failure mode was unbounded growth,
which is worse than the thing it avoided.

`claimSeat` in `js/db/players.js` is the single path now, used by both
join.html and the lobby. **Who you are is a user id when signed in, which is
exact, and a display name when not, which is not**, and that difference is the
whole design:

- **Signed in** — any row with your user id is yours. Take the newest, delete
  the rest. One account, one seat.
- **A guest** — a same-name row that is STILL ALIVE might genuinely be somebody
  else who picked your name, so it is left alone and you get a new seat. Only
  rows that have gone quiet are treated as yours, and those are cleaned up.
  Being wrong here costs a stranger their seat mid-game, which is worse than an
  extra row.

Liveness falls back to `joined_at`, because `addPlayer` does not write
`last_seen_at` and a row that never heartbeated would otherwise look ancient.

`scenario-nasty` returns **twice**, because once is not enough to see it: the
first duplicate is where the old code still behaved and the second is where it
ran away. Verified by restoring both call sites.

**A REMEMBERED SEAT ID BEATS EVERY GUESS ABOVE, and adding it closed the last
duplicate path (2026-08-24).** The guest rule will not touch a same-name row
that is STILL ALIVE, because it might be a stranger who picked the same name —
which left the commonest rejoin of all wide open. A guest who **closes the tab**
loses sessionStorage but keeps localStorage, comes back through the join screen
inside the stale window, and finds their own row still warm: skipped as
possibly-somebody-else, and handed a new seat beside it. Two of them, instantly,
with nothing abandoned anywhere.

`claimSeat` now takes `priorPlayerId` and adopts that row outright when it is
still in the room. That is not a heuristic about who somebody is — it is the
seat they were sitting in.

**`rememberSeat` had to start running in the LOBBY for that to help.** It only
ever ran on the game page, so anybody who sat in a lobby and closed the tab had
no record at all. The lobby is where people wait.

**And it must NOT run in `join.js`, which is where the obvious version of this
went.** Writing the new seat id at the moment of joining overwrites the OLD one
— and the old one is exactly what `game.html` needs a moment later to move a
returning player's answers onto their new row. It cost a passing test to find:
`scenario-nasty` reported "rejoin lost history: 1 answers before, 0 after". The
lobby and the game page both write it **after** any reclaim has run, which is
the only safe moment.

`scenario-nasty` covers this as its own case, deliberately NOT backdating the
row: the point is that nothing has gone quiet.

## A ghost cannot be the host

**Reported from a live game, with a photograph: two abandoned copies of one
player both flagged HOST, while the only person actually in the lobby was shown
"Ready Up" and could not start the game.** Four faults compounding, and the
combination is a room that can never recover on its own.

- **`promoteToHost` set the flag on the new host and never cleared it on the
  old one.** Every promotion ADDED a host. It clears the room first now, then
  sets — that order, because a failure between the two leaves no host, which
  promotion fixes on its next pass, while the other order leaves two, which
  nothing was looking for.
- **"Is there a host?" was `players.some(p => p.is_host)`, which a dead row
  satisfies perfectly.** So the room believed it had one and promotion never
  ran. `liveHosts()` requires the row to have been heard from.
- The promotion **race guard** used the same test, so it bailed for a ghost too.
- **The stale sweep for non-hosts only ran on the HOST's client** — and the host
  was the thing that had gone, so nobody left had the authority to tidy up.
  `iAmTheCaretaker()` — earliest joiner still present — does it when no host is
  reachable, chosen that way so every client picks the same person without
  having to agree first.

**A missing timestamp still means "cannot tell", and cannot-tell counts as
HERE.** Same rule as everywhere else: treating absence of evidence as evidence
of absence once had hosts kicking every player seconds after they joined.

Promotion also prefers candidates who are PRESENT, falling back to any human if
nobody looks it — a room with no host at all is worse than one whose host may
be about to come back.

`scenario-nasty` builds the photographed state — an abandoned host row plus a
duplicate of it — and requires exactly one host, that it is the person actually
there, and that they can start the game. Verified by reverting all four: the
room reports **four hosts, three of them ghosts.**

## A room is only ever cleaned up from inside it

A player row goes either by a beacon on unload or by another client in the room
running the stale sweep. **When everybody's phone dies at once, nobody sweeps**,
the rows persist, and `cleanupOrphanedRooms` — which asks only "are there
player rows" — never fires. The room reads as a game in progress forever. This
is what "two active games nobody was in" was.

`cleanupAbandonedRooms` uses the evidence that already exists: `last_seen_at`,
refreshed by the heartbeat every 15 seconds. A room where every HUMAN has been
silent for `ABANDONED_ROOM_MS` (20 minutes) is deleted. Three guards, and none
is optional:

- **20 minutes, not the 2-minute in-game stale timeout.** This deletes a whole
  room rather than one seat, and deleting a live room out from under a game is
  far worse than leaving a dead one listed.
- **No `last_seen_at` at all means "cannot tell"** and protects the room. This
  is the same rule as `checkStalePresence`, and ignoring it once had hosts
  kicking every player seconds after they joined.
- **Bots are ignored when asking whether anyone is alive**, because a bot never
  heartbeats. A room of only bots is abandoned by definition.

It runs from the Join page's existing sweep and from the admin dashboard before
it counts, so the number an admin sees and the list a player sees agree.

**The public games list was never showing these**, contrary to a claim made
once in this session: `fetchPublicRooms` requires `who_can_join = 'anyone'` AND
`created_at` within two hours, so an invite-only or older ghost was never
offered to anyone. Only a young public one could have been.

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
  answers to the new player row, so score and history survive. **This needs
  migration 052 run; before it, the answers died with the seat and this was
  simply untrue.** See "Rejoin keeps your history" below.
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

**AND UNTIL MIGRATION 052 THAT WHOLE PARAGRAPH WAS FALSE.** Measured on
2026-08-25, by the CI probe:

```
--- CAN A REJOINING PLAYER RECOVER THEIR ANSWERS? ---
  answers -> players: RELATED
```

PostgREST resolves an embedded `answers?select=id,players(id)` only when a
foreign key exists between the two tables, so that is a fact about the live
database rather than another inference from `migrations/`. **The probe could
not see this before and honestly said so** — the OpenAPI description carries no
foreign-key annotations, which is why #9 had to be measured by hand. Embedding
sees the relationship; it just cannot see the ON DELETE action.

**MEASURED: it was `CASCADE`.** 052 captures `confdeltype` before dropping,
because that is the only moment the answer is knowable, and the live database
reported `CASCADE — answers were DELETED with the seat`. So a released seat
really did destroy the score, and the alternative below is ruled out — which
also confirms the ghost rows this project chased were the code faults already
fixed, not a failing delete.

**The migration did not need to know, and an earlier draft of this section
pretended to.** It asserted the action had to be CASCADE or SET NULL, reasoning
that NO ACTION would make the stale sweep fail and somebody would have noticed.
That was an inference dressed as a measurement. All three are broken and all
three are fixed by dropping the key:

| ON DELETE | What it did |
|---|---|
| `CASCADE` | the answers were deleted with the seat |
| `SET NULL` | the rows survived having forgotten whose they were |
| `NO ACTION` / `RESTRICT` | removing the player RAISED 23503 instead, so `removePlayer` failed for anybody who had answered — logged, never shown, and leaving a seat that cannot be swept for **every player who actually played** |

That last one would have been an alternative explanation for the ghost rows
this project has been chasing, and it would have been invisible for the same
reason as everything else here — the failure only reaches a log. It is not what
happened, but only the measurement says so. Verified against a real Postgres in
all three shapes: each is dropped, each is named, and `rooms` keeps its cascade
every time.

**DROPPING THE KEY BROKE "has everybody answered", and that is worth reading as
a pattern rather than a detail.** `state.currentAnswers.length >=
state.players.length` was correct only by accident: while answers died with the
seat, both sides of the comparison shrank together. Now an answer outlives the
seat, so three players where Alice answers and leaves and Bob answers gives two
answers against two remaining players — the room decides everybody is done
while Carol is still typing, the host is shown "Reveal Results", and the
countdown hides itself. `countAnswersFrom` counts only answers whose player is
still in the room (and de-duplicates by player id, closing the same gap from
the other side). **A fix that changes what a row's lifetime means changes every
count taken over those rows** — so the rest of them were gone through too:

| Reads answers | Verdict |
|---|---|
| `computeScoresFromAnswers` | safe — keys by player id, and a departed player's total is rendered nowhere |
| `buildDisqualifiedSet` | safe — an extra wrong-and-worth-nothing row cannot flip a set that already contains a correct one |
| `renderRevealAnswers` | safe — iterates `state.players` and looks each answer up |
| `addRoomScores`, results placement | safe — both iterate `state.players` |
| `recordCurrentQuestionOutcomes` | **NOT safe**, below |
| `submittedCount` in `reveal.js` | **NOT safe** — missed entirely, found 2026-08-25 |
| the host's review overlay in `scores.js` | **NOT safe** — same, found 2026-08-25 |

**THAT TABLE MISSED TWO, AND ONE OF THEM ALREADY HELD THE OTHER HALF OF THE
RULE.** `reveal.js` had its own private `submittedCount`, written months earlier
for a different fault: on the final question every player holds a
`__WAGER_LOCKED__` row the moment they pick 0/10/20, so counting rows said the
round was complete before anybody had typed. So there were **two half-rules in
two files** —

| | skips a departed player | skips `__WAGER_LOCKED__` |
|---|---|---|
| `countAnswersFrom` | yes | **no** |
| `submittedCount` | **no** | yes |

— and each was blind to exactly what the other guarded. `countAnswersFrom` is
used by `updateRevealButtonText` and the Realtime answer handler, so **on the
last round of every game the reveal countdown still vanished and the host was
still told "Reveal Results" while people were answering**, which is the bug the
2026-08-20 playtest recorded as fixed. It was fixed on the reveal screen and
nowhere else.

One function holds both rules now and `submittedCount` is a thin wrapper over
it. `tests/scoring.test.js` fails by name when either guard is removed, and
keeps a case for a **deliberately blank** answer, which IS a real submission —
somebody the fill has already closed out must not hold the round open.

The review overlay is the smaller one: since 052 it grew a row labelled
"Unknown" for everybody who had left, each with a live toggle offering to
re-judge a player whose score is rendered nowhere. It filters to the room now.

**The bot guard went soft, and that is the one that mattered.** It identifies a
bot by looking the answer's player up in the room — and an orphan has no player,
so `player?.is_bot` became quietly `false` and a departed bot's answer would
have gone into `question_stats` and `answer_tally`, the two tables the rule
"nothing a bot does is recorded" exists to protect. It skips an answer it cannot
attribute now. Losing one human's answer from an aggregate over thousands of
plays costs nothing; putting an invented percentage into the evidence used to
judge a question does.

**And `state.currentAnswers` needed the same structural filter as the score
paths.** It comes from `fetchAnswersForQuestion(room, N)`, which returns every
answer in the room at round N — including the PREVIOUS game's, whenever the
clear-out did not run. `currentGameAnswers` in `state.js` wraps
`answersForCurrentGame` so all ten fetch sites are filtered identically without
each one having to remember `state.questions`.

**A player whose phone died for two minutes mid-game has always come back to
nothing**, and nothing said so: the reassignment reported success having moved
zero rows, which is indistinguishable from having had nothing to move. Every
scenario passed, because the fake store has never had this key at all — it was
asserting the world we wanted rather than the one we had.

Migration 052 drops the key, exactly as 033 did for `game_plays` and for the
same reason: an answer records that a round was played, and the seat is how
that person was reached at the time, not what the record is ABOUT. **The key to
`rooms` stays** — answers really are scratch data for one room, and that
cascade is now the only thing stopping orphans accumulating.

**The lesson is about the shape of the promise, not the key.** This one was
written down, believed, quoted into three other sections, and load-bearing for
`op_reassign_answers` in migration 051 — a function built to move rows that
were never there. Nothing failed, because the failure mode of "recover what is
gone" is silence. **When a feature's success and its total absence look
identical, go and measure the thing it depends on.**

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

**FIXED for the corrections, by migration 041, which the probe confirms is
applied as of 2026-08-23.** `amend_question_history` and
`revoke_question_history` are SECURITY DEFINER, so the table stays shut to
clients and a host's correction reaches the player it is about. The guard could
not be "the caller must be the host" — a host is very often a guest, and a
guest has no `auth.uid()` — so it is about the CLAIM instead: the correction is
applied only if that player really answered that question in that room. You
cannot reach into a stranger's history from nowhere. Somebody already in the
room could misuse it, but they can already edit the scoreboard, so it opens
nothing that was closed. **Both calls now require a `roomId`** and do nothing
without one; `scenario-accuracy` fails by name if a call site drops it.

**FIXED for the RECORDING of a round too, by migration 043.** `doReveal` used
to write the player's own row from the player's own browser, so a phone asleep
at the reveal recorded nothing and a phone awake recorded a miss — the same
event, two outcomes, decided by hardware, which meant a worse connection could
buy a better accuracy.

**The owner settled the question this waited on: A MISS IS A MISS.** It already
scores 0 and burns a wager exactly as being present and wrong does, so it
counts in accuracy the same way. It is not permanent: Proficiency reads the
most recent verdict (migration 040), so getting the question right next time
erases it.

`record_round_history(p_room_id, p_question_id)` records every signed-in
player in one statement. Three things about it are load-bearing:

- **Every device calls it, not just the host** — `recordRoundHistory` in
  `doReveal`. The first call does the work and the rest are no-ops. Host-gating
  it would have reintroduced the exact failure it fixes: a host whose phone
  died would take the whole room's record with them. **Contrast `room_scores`,
  which IS host-gated** — that write is not idempotent, so a per-device call
  there multiplies the tally by the room size. Whether a write may be repeated
  is the thing to establish before choosing.
- **The marker is `answers.history_recorded`, not anything on
  `question_history`.** `revoke_question_history` DELETES that row when it was
  the player's only sighting, which would take a marker with it and let a
  re-render re-add the attempt the host had just thrown out. `answers` is
  untouched by the corrections and dies with the room, which is exactly how
  long the marker is needed.
- **The UPDATE that claims the marker comes FIRST in the statement**, so it
  takes the row locks and a second caller blocks, wakes, re-tests
  `history_recorded = false`, matches nothing and inserts nothing. With the
  marker last, two callers would read the same unmarked rows and both count
  the round.

It is update-then-insert rather than `ON CONFLICT`, deliberately:
`upsertQuestionHistory` in `js/` is a read-then-write, so nothing guarantees a
unique index on `(user_id, question_id)` — and `ON CONFLICT` without one raises
42P10 and kills the whole statement every time, for everyone.

`scenario-accuracy` proves exactly-once and whole-room-in-one-call. Verified by
removing the marker: it reports four failures by name, including "Alice 4,
Bob 4, both should still be 1".

## Proficiency counts questions; volume counts attempts

**Migration 040.** Proficiency is `questions_mastered / questions_met` —
distinct questions you currently get right, over distinct questions you have
met — and the most recent sighting decides, in both directions. Get it wrong
then right and the miss is gone; get it right then wrong and the mastery is.

It replaced `SUM(times_correct) / SUM(times_seen)`, a lifetime hit rate over
attempts, in which **a miss was permanent**: playing more could dilute it, and
nothing could undo it, not even learning the answer. That made the number
partly a record of how often somebody's phone had been awake at the reveal.

**This is only as good as the resurfacing rule**, and that rule was reading
the wrong signal. `bucketQuestionsByHistory` in `js/question-selection.js` is
now the single definition of "this player knows this question", and it is
`last_correct` — the same verdict Proficiency uses.

Before that, the two selection paths had two different rules and neither
matched the profile:

| | knows it = |
|---|---|
| `fetchQuestionsByCategory` | got it right EVERY time |
| `fetchAllOpenQuestions` | got it right AT LEAST ONCE |
| Proficiency (040) | got it right LAST time |

The category rule is the one that bit. A question missed once and since
learned reads `times_seen=2, times_correct=1` — not right every time, so it
could never be filed as mastered, and wrong at least once, so it stayed in the
redemption pool **forever**. The pool only ever grew, and the same old
questions kept resurfacing long after they were known. **The ~5% draw rate was
never the problem; the pool it drew from could not shrink.** Now it is
self-cleaning both ways: learn one and it leaves, forget one and it returns.

`fetchQuestionHistoryForUsers` **must** select `last_correct`. It did not, and
the fallback (`times_correct > 0` when the column is null) means omitting it
does not error — it silently reverts every player to the old rule.

`question_history.next_eligible_at` still exists on the live table and is read
by nothing. A scheduled interval was considered and set aside: the owner's
judgement is that a flat ~5% per player per slot keeps repeats feeling
incidental rather than assigned, which is right for a party game. Revisit it
only with a measurement, not a hunch.

**Guests do not shape selection**, deliberately. `playerUserIds` holds
signed-in players only, so a room of guests gets a plain shuffle. Tracking what
a guest has met means keeping a durable record of somebody who did not sign up,
and smart selection is one of the things an account is for. A guest in a mixed
room still gets a well-chosen set, because the signed-in players shape it.

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

## Ranks were invisible, and Wild Card was counted three times

Four faults on the profile, all reported from one playtest.

**Wild Card appeared three times under Proficiency.** `player_stats_computed`
is meant to emit one rollup per category — the row where `subcategory` is null
— and it emitted three the app could not tell apart, because the filter is
`!s.subcategory` and `null`, `''` and `undefined` all land in that bucket while
staying separate rows. `mergedCategoryRows` in `titles.js` sums them, which
cannot under-report and is the identity when there is only one. **The profile's
totals ran over the same rows**, so games, wins and questions were inflated
too, not just the list.

**AND `computeCategoryTiers` WAS NEVER CONVERTED WITH IT (found 2026-08-25).**
`mergedCategoryRows` was written for the profile and applied to the profile.
The function that decides a TIER kept iterating raw rows, and a tier is not a
display detail — it gates every title unlock, the tier badge in every lobby, and
`hasReachedApprentice`, which is what opens the Title Builder at all.

Reading one fragment of a split category understates it twice over. The fragment
carries a slice of the questions, **and `MIN_QUESTIONS_FOR_TITLE` is applied to
that slice** — so somebody with 36 questions met, split 12/12/12, gets **no tier
whatsoever** rather than a lower one, and nothing is wrong on screen except an
absence. Where the volume gate was cleared, which of the three rollups won was
simply whichever the view returned last.

Category rollups are merged; **subcategory rows are not** — each one is its own
tier under its own key, which is the whole point of them. `tests/titles.test.js`
pins both directions and fails by name when the merge is removed.

**One bug, one fix, three call sites, two converted.** That is the same shape as
"the seat ratchet had a third copy" and as the answer-count rule below. When a
fix is written as a shared helper, grep for every reader of the thing it
replaces before calling it done.

**Subcategory rows had no icons.** One line held two mistakes: it read
`subNode.icon`, the HIEROGLYPH, while the category row above it reads the
emoji — so the two halves of one list disagreed about what an icon is — and it
rendered nothing at all when the node was not found, which is every wild-card
subcategory (they live under `wildCardOptions`) and every value the tree does
not know. `resolveSubcategoryIcon` handles both and falls back to the
category's own icon, so a row can never come out blank.

**Nothing was sorted.** Mastery and Proficiency both rendered in whatever order
the query returned. Mastery is now most-mastered first, and its subcategory
rows are sorted **per level by the whole branch's total**, so a child still
sits under its own parent and a parent whose own count is 0 but whose children
hold 40 is near the top. Proficiency sorts by accuracy, ties to the bigger
sample — 100% from two questions must not outrank 92% from sixty.

**A rank is `accuracy × log2(questions met)`** against fixed thresholds
(Apprentice 3.0, Scholar 4.5, Master 5.5, Oracle 6.5), with no rank at all
below `MIN_QUESTIONS_FOR_TITLE` distinct questions whatever the accuracy. That
is a defensible rule and completely unguessable from outside, and **the app
said nothing about it anywhere** — the owner asked where their ranks were and
how to improve them and neither question had an answer on screen.

`tierProgress(row)` returns the rank held, the one above, and how many more
questions getting them right would take. **The count is simulated, not
solved**: answering one more correctly moves both halves of the fraction, so
there is no clean closed form and an approximation would be a number the player
answers and fails to hit. `tests/titles.test.js` pins that the count actually
reaches the next rank and that one fewer does not.

It renders as a second line under the category name, never a badge beside it.
The lobby taught that expensively: anything added alongside a name takes width
that is not there at 375px. Below the volume gate it says how many more
QUESTIONS are needed rather than anything about accuracy, because accuracy
cannot buy a rank there and saying so would be a promise that cannot be cashed.

## Nobody can write down their own score

Migration 055, built 2026-08-28. **This is the counter-argument recorded in the
section below, finally acted on.** It does not change the owner's decision that
the leaderboard is friends-only; it closes the hole that made that decision an
argument about incentive rather than about data.

Every number this app shows about a player — accuracy, proficiency, mastery, the
tier badge in every lobby, every title unlock, and the whole leaderboard —
derives from `question_history`. Migration 011 gave clients:

```
INSERT WITH CHECK (user_id = auth.uid())
UPDATE USING      (user_id = auth.uid())
```

Every browser carries the publishable key by necessity, because guests play. So
any signed-in person could set their own `times_correct` and `last_correct` for
the entire bank **in one request**. Not by cheating at a game — by writing the
number down. 055 drops both policies. SELECT stays public: the host's browser
reads every player's history to shape question selection, and a restrictive read
policy would revert every room to a plain shuffle with nothing on screen saying
so.

**WHAT THIS DOES NOT DO, and must not be claimed to.** A host may override the
machine's verdict — that is a feature, and it is how a real answer the fuzzy
matcher rejected gets counted. So somebody hosting a solo game can still mark
themselves right every round, and their history is then honestly recorded. This
turns "one request sets any number" into "you have to sit through the game",
which is a real cost and not an impossibility. The owner named that ceiling
first and accepted it. **Do not write this up as making the stats
un-fakeable.**

**It was written the opposite way round from 049, deliberately.** 049 was
written about the writes that were *dangerous* and broke three that were not —
Play Again, rejoining and practice bots — silently, with every test passing. So
here `js/` was grepped for the TABLE first and every writer enumerated before a
line of SQL was written:

| Writer | Route | After 055 |
|---|---|---|
| `recordRoundHistory` | `record_round_history` (043) | unaffected |
| `amendQuestionHistory` | `amend_question_history` (041) | unaffected |
| `revokeQuestionHistory` | `revoke_question_history` (041) | unaffected |
| `upsertQuestionHistory` | **direct INSERT/UPDATE** | refused |

All three survivors are SECURITY DEFINER and run with the table owner's rights,
the same arrangement `question_health` and `host_reputation` already use — and
that is **asserted in `tests/sql/game-rules.sql`, not assumed**. Six rules pin
both halves: a signed-in player is refused an insert AND an update, the forged
count is unchanged, reading still works, and all three server writers still get
through. A check for only the refusal would go green on a change that stopped
anybody's history being recorded at all.

Verified by reverting the drop loop: **5 of 105 rules fail, including `got
"9999", want "1"`** — the forged number landing exactly as it would have live.

**`upsertQuestionHistory` stays in the client, and now says which of two things
happened.** It is the last resort for a room where `record_round_history` is
unreachable. But the two refusal shapes differ and code has to tell them apart:
an INSERT is refused by `WITH CHECK` and **raises 42501**, while an UPDATE is
filtered by `USING` and **matches nothing and reports success**. The update
branch therefore `.select()`s and checks the row count — without it, this would
go on reporting that it had recorded the round. Both log at **warn** and name
055, so the next session reading a 42501 in a console does not hunt for a bug
that is a permission working. Neither toasts: this is background stat recording,
the round is already scored on screen, and a toast per player per round is the
noise that teaches people to ignore real warnings.

**The probe's consequence line changed with it, and that mattered more than the
migration.** `record_round_history` was already watched, described as a
degradation — "a round is recorded only by the phones that were awake". Since
055 it is **total**: with that function gone, nothing records a round at all and
every number in the app silently stops moving. A dependency that was a fallback
becomes load-bearing the moment you shut the door beside it, and the monitoring
has to be re-read in that light or it will describe the old world confidently.

The fake store shuts the same door (`_shutDoors`), including the plain-INSERT
42501 shape it had never modelled. The three RPCs mutate the table array
directly rather than going through `_execute`, which is how definer rights are
modelled there — structurally, not by a flag.

## The leaderboard ranks what you know, among people you know

Rebuilt 2026-08-26, on the owner's decision, after a long argument in which they
were right and I was arguing past them. Migration 053.

**IT IS FRIENDS ONLY. Do not put a global board back without the owner.** Their
reasoning, which is better than the counter I offered:

- Anyone can play solo and mark themselves right every round, so a global
  ranking is a prize with no honest route to the top and no way to police it.
  **Removing the prize removes most of the reason to fake anything.**
- Among friends there is a remedy a global board has no equivalent of: if
  somebody's numbers look wrong, unfriend them. In a shared game it is obvious
  anyway — an Oracle who cannot answer anything is visible to everybody in the
  room, and can be kicked.
- A global board **discourages**. A top score with no visible route to it is a
  wall, not an invitation.

**My counter, recorded because it is the strongest one and it did not win.**
Cheating does not HAPPEN on the leaderboard — every number comes from
`question_history`, which any signed-in person could write directly with the key
every browser carries — so deleting the board hides fake numbers rather than
preventing them: they still show on the profile, the ranks, the titles and the
tier badge in every lobby. That is true, and it does not answer the owner's
point, which is about INCENTIVE rather than about data.

**That write hole is closed as of 2026-08-28 — migration 055, "Nobody can write
down their own score" above.** It was always independent of this decision, and
acting on it does not reopen the question: the board stays friends-only, on the
owner's reasoning, which was never about the mechanism.

**THREE EXPORTED READERS ARE NOW DEAD, and this file said otherwise until
2026-08-28.** `fetchAllPlayerStatsForLeaderboard`, `fetchPlayerTotalsForLeaderboard`
and `fetchCategoryLeaderboard` have **zero call sites** anywhere in `js/` —
measured by grep, not assumed. The live path is `fetchLeaderboard`, whose
fallback is `_leaderboardFallback`, and that one correctly uses `select('*')`.
They are left in place rather than deleted on a hunch, but **do not wire one up
without reading its comment first**: `fetchCategoryLeaderboard` carries a long
note about why it must select `*`, and the other two rank on ATTEMPT counters,
which is the measure the 2026-08-26 rebuild set out to remove.

**Points are gone.** The old global board ranked on `correct_answers`, a count
of ATTEMPTS: answer the same question ten times and it counted ten times, so the
measure rewarded re-grinding a handful of questions over learning new ones, and
it disagreed with every other number in the app. It was also unbounded, which is
what made a top score look unreachable and a faked one impossible to spot.
Mastery is capped by the size of the bank: a leader at 6% reads as an invitation
and one at 100% reads as a liar.

**Mastery AND proficiency, because they answer different questions** — how much
of the bank you have claimed, and how well you know what you have met. Neither
alone is a ranking, so it is a toggle rather than two boards.

**The time window is the owner's design and it is better than mine.** Define it
as *questions you currently get right, last seen inside the window*, and
all-time collapses to plain mastery with no special case. I proposed a
`first_correct_at` column to express the same idea and it was not needed. The
honest limitation, which will otherwise look like a bug: something learned a
year ago and not seen since does not appear in a 30-day view, so a window
measures recent ACTIVITY that stuck rather than new learning.

**The period control is hidden when the server cannot honour it.** Migrations
are hand-applied, so "the JavaScript is live and the SQL is not" is a real
state; `fetchLeaderboard` falls back to `player_stats_computed`, which is
lifetime-only, and returns `windowed: false`. Offering a period beside numbers
that ignore it is a lie the screen tells confidently, which is the fault this
codebase is made of.

**The proficiency floor counts QUESTIONS MET, and the old one did not.** The
category board required 20 `questions_answered` — ATTEMPTS — while ranking on
questions, so replaying three questions twenty times qualified you. Same word,
two meanings. It also scales with the period, because a week cannot hold as many
questions as a lifetime and a fixed floor would show an empty board for every
window.

`COUNT(DISTINCT question_id)` in 053 also fixes something for free:
`player_totals_computed` exists only because summing per-category rollups counts
a question filed under two categories twice. Counting distinct ids cannot.

**THE EMPTY STATE SAYS WHAT ACTUALLY HAPPENS.** "Tap a player to add them" was
half the story and would have read as a broken board: the button sends a
REQUEST, the other person accepts it from their own profile, and it is only
offered for players who have an account at all. Somebody who taps once, sees
"Request Sent", and comes back to an empty leaderboard would reasonably conclude
the feature does not work. `leaderboard-no-friends` is a mock state because that
screen is the first thing a new player sees and carries the longest string on
the page.

**A friends board needs friends, and this project has three players.** Accepting
a friend request was completely broken until migration 044 — a constraint in no
migration file rejected every accept, silently — so anyone who tried before that
never became friends. Worth counting before assuming the board has anything to
show: `SELECT count(*) FROM friendships;`

`scenario-account` seeds Bob with MORE mastered questions than Alice and Alice
with a HIGHER share of what she has met, so the two measures give opposite
orders — without that inversion any check on the toggle passes whatever the page
does. Verified by ignoring the toggle (it reports the ranking by name) and by
widening the id list to everybody (it reports a non-friend on the board).
`store.hideFunction('get_leaderboard')` proves the fallback, which was
unreachable from a scenario before: an unimplemented RPC used to answer null
with NO error, which is what an installed function returning nothing looks like.

## Judging the host, not the ruling

Migration 054, built 2026-08-26 at the owner's request: "before joining a random
lobby someone would know if the host is reliable or not, as opposed to after
being negatively affected." Public games are listed, so joining a stranger is a
real thing people do, and a host still holds one power over everybody in the
room — overriding the server's verdict, which amends the permanent
`question_history` of every player it touches (041).

**IT IS NOT "WAS THE HOST CORRECT", AND THE DIFFERENCE IS THE WHOLE DESIGN.**
Nobody can answer that about a ruling on their own answer. A board that asked
would reward lenient hosts and punish accurate ones — mark everything right, get
100% — which damages everyone's stats more than a bad host does. The question is
**would you play with them again**, which is a thing a player can honestly
answer and which lets somebody prefer a strict host who is fair.

The owner pushed back on my objection and was partly right: over-generosity IS
visible, since the reveal shows every answer and verdict, and other players lose
position by it. The bias is not in the LEVEL — everyone collects some
thumbs-down — it is in the comparison, because a stricter host collects more of
them. Milder than I first said. The owner's call was to build it, and their
framing is the one implemented.

**One vote per player per game, cast from the reveal screen.** Per round was the
original idea and the owner spotted its flaw first — it skews toward short
games. It has a worse one: one person in a ten-round game would outweigh four
people in a five-round one.

**THE TWO ACTIONS NOW LIVE IN DIFFERENT PLACES, and that is the real fix for a
confusion this file only ever mitigated.** They used to be one row of three
icons under the question feedback, wearing the same glyphs and meaning something
completely different — labelled and ruled off, with separate listeners, which
helped but did not remove the hazard. Migration 059 made it worse: with the
thumbs moved to the final round only, that row would have been a lone flag for
most of a game, reading as neither thing.

| | Where | When | Why |
|---|---|---|---|
| 👍👎 | the reveal, final round | once per game | routine, so make it easy — a score that is rare AND hidden is a feature nobody uses |
| 🚩 report | the profile card, behind a tap on the host | any time | rare and serious, so make it deliberate — and it sits directly under the standing you are judging them by |

The card opens from the lobby, the reveal, the scoreboard and the results, so a
report can be made at ANY point rather than during one screen. It is an outlined
button, not a red one: a control that shouts invites the tap it is trying to
make considered.

**Two bugs in one, caught by the check written for the move.** The report block
referenced `profile`, which is scoped inside `if (userId)`, so it threw
`profile is not defined` and the control never rendered at all — and the
scenario reported both the missing control and the console error. The lesson is
the one this file keeps recording: **a control that only moved OUT of somewhere
is a control that was deleted**, so the check asserts it is reachable where it
went, not merely absent from where it was.

**A GUEST HOST CANNOT HAVE A REPUTATION**, and this is a real limitation to
state rather than work around. It attaches to a user id and a guest has none.
The row hides itself entirely for a guest host, and their game shows "new host",
which is honest and is itself a signal. It also gives an account a purpose.

**THE WHOLE GAME IS REQUIRED FOR A RATING — REVERSED 2026-08-28, migration
059.** This section previously argued the opposite and the reasoning is kept
below, because the owner answered it rather than overruling it.

The rule now: **the thumbs need every round; the FLAG needs one.** A drive-by
cannot score a host on a single round, and somebody who walks out because the
host was improper still reports them.

My objections, and what happened to each:

- *"A bad host is the commonest reason somebody leaves early, so this silences
  the strongest complaint."* — **Answered.** The flag is a separate tool and
  keeps the old rule. Thumbs mean "would you play with them again"; a flag means
  "this was improper". Those want different evidence, and only the second is
  urgent enough to come from somebody who left.
- *"It locks out anyone who joins a game in progress."* — **Answered:** they can
  play the next game. Hot-joining is a way IN, not a claim on a vote.
- *"An away phone and a leaver look identical."* — **This was simply WRONG and I
  said so.** Being away costs nothing: you keep your seat, and the blank fill
  writes you a row every round while your screen is off. Only after ~2 minutes
  of silence is the seat released. So "kept your seat throughout" is exactly the
  line the owner drew, and it is precisely measurable.

**HOW IT IS MEASURED, with no inference in between.** Every round ends with
`op_fill_blank_answers` writing a row for EVERY player in the room, so a seated
player accumulates one per round whether they answered or not. A latecomer never
has the earlier ones; a swept seat stops getting them. `op_played_whole_game`
counts distinct rounds and compares against `op_room_total_questions` — which is
`GREATEST(1, length - 1)`, so **even a one-question room reports two rounds**.
Reading that as one is how the rule table was mis-seeded on the first attempt.

**AND IT IS ONLY TRUE AT THE END**, so the room must be on its final round.
Otherwise somebody rates at round one, leaves, and has technically been present
for everything so far.

**The thumbs are HIDDEN until then rather than shown and refused** — three
buttons that light up and record nothing is the shape #4 is about. The flag
stays on screen every round. A refusal that does reach a player ("you did not
play the whole game") changes the label rather than being swallowed.

One answer in the room is still the guard for the FLAG: it cannot be satisfied
by occupying a seat, so a drive-by who joins and reports on arrival is refused.
A BLANK answer counts — running out of time is still having been in the round.

**Verified by breaking both halves.** Removing the whole-game requirement fails
four rules; gating the FLAG on it too fails four, including *"but they can still
FLAG the host"* — which is the mistake that would silence the leaver and undo
the whole justification. `scenario-feedback` fails by name if the thumbs appear
mid-game.

**Three attempts at that scenario broke other sections, and the trail was
long.** Seeding rows for rounds the game had not played made three later checks
report *"record_answer_text was never called"*; then jumping the live room to its
final round did the same, because `syncToCurrentState` polls the room and the
host's client skipped the rest of the game. The vote mechanics now run against a
SEPARATE synthetic room and the live one is never touched. **When a change to
one section breaks a check three sections away, suspect what you seeded, not
what you changed.**

**Short and long games both produce one vote, and that is right.** The unit of
"would you play with them again" is a game, not a round. Length changes how fast
a host accumulates SAMPLE, not the value of the percentage, and the sample is
printed beside it.

**AND THE SAMPLE IS LABELLED "RATINGS", NOT "GAMES", because a room survives
Play Again.** The key is `(host, ROOM, voter)`, so a group playing six rounds
together in one evening produces one rating each, not six. That IS the right
unit — one considered opinion per person per sitting rather than six taps, and
it stops a host farming votes with quick rematches. But it means the number is
not a count of games, and calling it that would be the same mistake this file is
full of: **a label describing a different measurement from the one shown**. The
admin page already draws exactly this distinction — six rounds with one group is
six games and ONE session. `scenario-join` fails if the row ever says "games"
again.

**WHO VOTED WHICH WAY IS NOT PUBLIC, and that is a privacy fix rather than
tidiness.** The rows carry `voter_id` and `voter_name`. With a public SELECT a
host could look up exactly who thumbs-downed them and retaliate in the next game
they share — which makes an honest rating unsafe to give, and **a rating that is
unsafe to give is worse than none**. The policy admits admins only; the
AGGREGATE is what the app needs public, and `host_reputation` provides it.

The view keeps working for everybody because it is an ordinary (definer-rights)
view, so it reads the locked table with its owner's rights rather than the
caller's — the same arrangement `question_health` already uses over the locked
`question_stats`. That precedent is why this was safe to do rather than a guess,
and all four cases were measured against a real Postgres: a visitor and a
signed-in non-admin see nothing, the aggregate still answers, an admin sees the
reporter and their note. `tests/sql/game-rules.sql` pins all four, and reopening
the policy to `USING (true)` fails two of them by name.

**`host_ratings` therefore reads as `rows=0` in the CI probe, and that is
correct output.** An RLS filter returns zero rows rather than an error, so a
future session must not read it as a table to investigate — the probe says so
inline.

**Every write goes through `op_rate_host`, which checks the voter really has a
player row in that room.** The table has no INSERT policy at all. Without that
guard anybody holding the publishable key — which every browser carries, because
guests play — could bury a stranger whose game they were never in, and a
reputation nobody can trust is worse than none. A flag is never withdrawn by a
later thumbs-up: changing your mind about a rating is ordinary, retracting a
report of misconduct is not something a tap should do.

**A FLAG THAT REACHES NOWHERE IS THEATRE**, so the admin page has a **Flagged
Hosts** panel, second, next to Flagged Questions — the two things on that page
anybody is meant to act on. It groups by host, names them rather than printing a
uuid, shows their current standing beside the report count (one report against a
well-liked host reads differently from three against a badly-liked one), and
prints the free text somebody typed. It reuses the flagged-QUESTION row's
classes rather than inventing a parallel set: half of that row shipped unstyled
for months because nothing rendered it, and a new set of class names is how that
happens again. The count chip goes amber only when non-zero, and renders `?`
rather than `0` when the count fails.

**The join list's reputation is ACCUMULATED, not replaced.** That list refreshes
every ten seconds, and a transient failure returns an empty map — which would
flip every host on screen to "new host" and back, telling somebody deciding
whether to join that a host with fifty games has none. Merging into what is
already known means a dropped request shows the last good answer rather than a
wrong one, and a host who genuinely has no ratings was never in the map anyway.

`scenario-join` seeds three thumbs-up and one down and asserts the row reads
**75% AND "4 games"** — the sample is half the claim, so both halves are checked
and both fail when the column list is narrowed back. That surface had no
coverage at all until then, and it is the one the whole feature exists for.

`scenario-admin` opens it with the rest and then checks it actually SHOWS the
report — "it opened" is not "it works", and a loader that renders nothing opens
exactly as happily as one that renders what an admin came to read. Verified by
dropping the note line: it reports that by name.

**The sample is always printed** — `MIN_HOST_RATINGS` (3) is the point below
which the count is shown on its own instead of a percentage, the same call and
the same number as the difficulty band.

**A VOTE BELONGS TO A HOST, NOT TO A GAME.** The role can move mid-game — a
host who leaves is replaced by promotion — and without a guard the buttons would
show your verdict on the OLD host as already cast for the new one, who you have
never rated. Each vote is its own row, so nothing is lost; what was wrong was
the screen. **Inspection-verified only**, like the final-wager guards: making a
host change mid-reveal happen in the harness was not worth a check that could
not be trusted to fail, and saying so beats a check that agrees with you.

**THE ROW IS NOT DRAWN UNTIL THE FEATURE IS KNOWN TO BE INSTALLED**, and
"show it, then hide it when the failure comes back" was not good enough. In the
window where this JavaScript is live and 054 is not, an optimistic row puts
three buttons on screen that light up when tapped and record nothing — a player
believing they rated somebody when they did not. Hiding on the failure leaves
exactly that window open for however long the round trip takes.

**The first version of that check could not fail, and I nearly shipped it.**
With the async hide in place, removing the synchronous gate changed nothing the
scenario could see: by the time it looked, the failure had arrived and the row
was gone either way. The fix was to the DESIGN, not the check — hide by default,
ask once per game, draw only on a positive answer. Then the check fails by name
when the gate is removed. **A check that agrees with you whatever you do is the
thing this project keeps deleting.**

**Shown on the join list and on the profile card, NOT on the lobby row.** The
lobby row is the most fragile layout in the app: adding a badge beside a name
there is exactly what overflowed it by 71px and made the page draggable
sideways. Tapping a player in the lobby opens the profile card anyway, so it is
one tap from where it is needed.

**Adding it to the join list overflowed a 430px phone by 33px**, and the sweep
caught it. `.public-game-row__info` already had `min-width: 0` and the name was
already ellipsised — but the ROW is itself a flex item, and a flex item defaults
to `min-width: auto`. **A child can only shrink if the parent lets it.** Same
shape as the `repeat(N, minmax(0, 1fr))` fix on the profile.

**A pre-existing flaky check surfaced while doing this, and it is worth knowing
how.** `scenario-feedback` proves a bot's answer is never recorded by flagging a
real player as a bot in the HOST's `window.__state` — which a player re-fetch
replaces, and `checkStalePresence` re-fetches on every call. So whether the
check could see the guard at all depended on how long the run happened to take;
adding a section before it made it fail. It sets `is_bot` in the store now, and
only after both players have submitted, because a row with `is_bot` set is one
the host's browser answers FOR.

## The shape of what you know

A radar at the top of the profile, twelve axes, one per category. The owner
asked for it: "those spider web charts that display strengths and weaknesses".

**Labelled with emoji, because every category already has one.** Twelve text
labels around a circle at 375px is unreadable; twelve emoji are not, and they
carry a `<title>` so the exact figure is still available.

**Proficiency, not mastery.** Mastery would be near zero for everybody — the
bank holds 4,859 questions — and a chart that is a dot for every player is not
a chart.

**AN UNPLAYED CATEGORY IS NOT A ZERO,** and this is the whole reason
`buildRadarAxes` exists rather than a one-line map. "Never tried Sports" and
"bad at Sports" are different facts, and a radar that draws both at the origin
says the second about somebody who has done the first.

The first version still drew untried axes at the centre and joined them up,
distinguishing them only by dimming the emoji. **It looked broken** — three
zeroes among twelve pull three vertices to the middle and the outline crosses
itself into a jagged star. The shape now spans only the axes with data, which
is both the honest outline and the better-looking one. Under three such axes
there is no polygon at all, just dots.

`radarExtremes` needs at least 5 questions met before it will call a category
your strongest or weakest, and never names the same one as both.

**This paragraph used to say the opposite and it was wrong.** A throwaway
Playwright script rendered profile.html 571px wide with text clipped; the sweep
said clean; I concluded the script was broken, told the owner so, and wrote it
down here. The owner then sent a photograph of their phone with the page cut
off. **The overflow was real, and the sweep could not see it** — two faults, and
both had been silencing it across nearly the whole app:

- it treated an ancestor with `overflow: auto` or `scroll` as excusing an
  overflow, and **`overflow-y: auto` computes `overflow-x: auto`**, so almost
  every scrollable pane in the app was a blanket exemption;
- `.screen` sets `overflow-x: hidden`, and the sweep read "clipped" as "fine".
  Clipped is not fine. It is text nobody can reach.

Anything wider than the viewport is now reported whether it is clipped or not.
Verified by reintroducing the cause — a `white-space: nowrap` rank line inside
`grid-template-columns: repeat(2, 1fr)`, which cannot shrink below its
min-content — and the sweep names 40 elements. All eight fixed-count grids in
the stylesheet are `repeat(N, minmax(0, 1fr))` now.

**When a measurement and a person disagree about what is on the screen, the
person is looking at the screen.**

## Moving the game off the host's phone

The rebuild in #1, started 2026-08-23 at the owner's instruction. Done in
slices that can each be felt in a real game, because a rebuild nobody can test
until the end is a rebuild nobody can test.

**AUTHORITY IS NOT INITIATIVE, and that distinction is what makes this
possible at all.** There is no application server here — Supabase is Postgres,
Realtime and Auth — and Postgres cannot wake itself up on a timer. So a client
still has to ask. What changes is that the ANSWER no longer comes from the
asker: the database decides, in a SECURITY DEFINER function, and every client
gets the same decision. It also means *any* client may ask, which is the fix
for the stalled game: a host whose phone sleeps stops being the only device
that can move things along.

**What this cannot do, and must not be claimed to.** These functions do not
know who is calling. A guest has no `auth.uid()` — that is what guest play
means — so somebody with the room code can still act as another player in that
room. This stops a score being conjured from nothing; it does not stop a person
already in your game meddling. Closing that needs sign-in, which ends guest
play, and the owner has not asked for it.

### Slice 1 — the server judges (migration 045)

`op_answer_matches(submitted, correct, alternates)` is a port of `fuzzyMatch`
in `js/utils.js`, with `op_normalize`, `op_levenshtein` and `op_digits_match`
under it.

**This creates the most dangerous shape in the codebase: one rule, two
implementations.** The player watches the JavaScript decide green or red; the
score comes from the SQL. If they ever disagree, the screen and the scoreboard
say different things about the same answer — worse than the bug being fixed.

So they are not maintained as two things that ought to agree.
`scripts/verify-sql.mjs` runs **1,621 cases through both** and fails on any
disagreement, plus every normalisation and a sample of edit distances. It
stands up a throwaway Postgres (or takes `PGURL`), applies the migration, and
never has the Supabase credentials. It runs in CI on every push.

Verified by breaking the SQL three ways: restoring the `Math.max(1, …)`
Levenshtein floor reports 102 disagreements, writing the word boundary as `\b`
instead of `\y` reports 13, and removing the accent fold reports 7.

Two things that cost real time and will again:

- **`\b` is a BACKSPACE in Postgres regexes.** Word boundary is `\y`. Written
  the JavaScript way, the numeric-abbreviation rules ("2 bil" → "2 billion")
  match nothing and fail silently.
- **The generated cases are the ones that earn their keep.** Removing the
  accent fold does *not* break the hand-written `Sao Paulo` / `São Paulo`
  case — unfolded, "so paulo" and "sao paulo" are one edit apart and the fuzzy
  tolerance covers it, so it passes for the wrong reason. A mutated
  `"Se Pauo."` is what caught it. **A rule can be broken in a way that every
  case written to describe it still passes.**

**No extensions.** `unaccent` and `fuzzystrmatch` would both be tidier and both
are a bet on what is installed on the live project — the commonest source of
"worked in the harness, dead in production" in this repo (#3, #7, #10).

**The accent fold cost two more rounds of this same lesson.** It is a
`translate()`, which maps by POSITION, and the first version was typed by hand
with a corrupted byte two thirds along — after which `ž` and `ź` folded to `s`,
`đ` and `ď` to `z`, `ģ` and `ğ` to `d`, and so on for the whole tail. **Every
case in the parity check still passed**, because none used a letter past the
shift. It is generated from Unicode data now, and the two strings are asserted
equal in length with every pair matching NFD.

Then the generated version was *too good*: it folded `ł`, `æ`, `ß`, `ø`, `þ`,
`đ` — letters NFD does not decompose, which JavaScript therefore STRIPS. So
"Łódź" was `odz` on the screen and `lodz` on the server, and 34 answers were
judged differently. **Parity with what the player sees is the requirement, not
linguistic correctness**; if those should fold, change both.

The map now contains exactly what NFD decomposes, across Latin-1 Supplement
through Latin Extended Additional (Vietnamese included — `ẵ` was the last
holdout). And the check no longer relies on somebody thinking to add an
accented answer: **`verify-sql.mjs` normalises every lowercase letter in those
blocks through both implementations**, so a missing pair fails by name.
Verified by deleting one pair from the middle.

That check passes its case list through a **file, never `-c`** — argv has a
kernel limit and the list blew past it the moment the accented answers went in,
dying with `E2BIG`, which reads like a database failure rather than a command
that was too long.

**There is a local Postgres in the dev container** (`/usr/lib/postgresql/16`).
SQL in this project no longer has to be written blind and pasted hopefully —
run it, prove it, then hand it over.

**`scripts/probe-db.mjs` watches all four functions**, and they are the entries
on that list that matter most, for a reason peculiar to them: **every one fails
SILENTLY.** The app falls back to the old client-side path, a player sees a
working game, and the only symptom is the thing the rebuild exists to stop —
two phones disagreeing about a score. Everything else the probe watches
announces itself by breaking a screen. These announce themselves by working.

### Slice 2 — the server records the answer (migration 046)

`op_submit_answer` writes the row: verdict, wager and points, computed once.
`op_fill_blank_answers` gives a zero to everyone who never answered, and **any
client may call it**, which is what stops a sleeping host leaving a round
hanging. `op_next_wager` ports `findNextAvailableWager` + `buildUsedWagersMap`;
`op_room_total_questions` reads `array_length(question_ids) - 1`, because the
room holds N+1 questions and **the final wager round is number N** — off by one
there silently turns the only round that subtracts into one that does not.

Three things become impossible that were reachable by anyone willing to edit a
request: answering a question that is not on screen, answering after the timer,
and spending a wager twice.

`tests/sql/game-rules.sql` states 172 rules as `check | got | want` data and
`verify-sql.mjs` fails on any row where the two differ, naming the rule — and
on any line that is not exactly three fields, because a line the script cannot
read counted as a rule whose `got` and `want` were both `undefined` and
therefore passed. That is how the total read 26: psql echoes a command tag per
statement unless given `-q`, and two of them were being counted as rules.
`tests/sql/scratch-schema.sql` is an **approximation** of `rooms`, `players` and
`answers` — those predate the migrations folder, so their real definitions are
not in this repo (#7) and the live database enforces things no migration
declares (#10). It proves the LOGIC. Only running the migration proves it
applies.

**Writing that test found a real bug and then found a worse one in itself.**

- `ON CONFLICT DO NOTHING` was wrong for the blank fill: somebody who LOCKED a
  final wager and never typed anything already holds a row on that key, so the
  insert bounced and they never got their zero. The client had hit this and
  needed a second pass; the SQL now converts a placeholder in one statement.
- Then, breaking the guard that stops a blank overwriting a real answer changed
  **nothing any check could see**. The loop pre-filtered to players who had not
  answered, so the guard sat behind a condition that already excluded the only
  case it defends. The same rule stated twice, with the test only ever reaching
  the first statement of it. The loop now runs over every player and the
  `ON CONFLICT ... WHERE` is the sole protection — removing it fails three rules
  by name. **A guard behind a guard is not twice as safe; it is untestable.**

### Slice 3 — the client asks the server (wired 2026-08-23)

`submitAnswerViaServer` and `fillBlankAnswersViaServer` in `js/db/players.js`.
`doSubmitAnswer` takes the verdict, the points and the wager from the returned
row; the host's timer-expiry fill is one RPC instead of a loop plus a
final-round second pass.

**Both fall back to the old client-side path, and the order matters**: the
JavaScript is safe to deploy before the SQL is run, which is the direction this
project has repeatedly got wrong (#3). `functionMissing()` treats only
`PGRST202` as absent — a function that exists under different argument names
answers the same way and is just as dead (#6) — and an installed function
returning **no rows is reported as an error, not as absence**, because
conflating those is how a dead feature reads as a healthy fallback for months
(#8).

**A REJECTION ALSO FALLS BACK, deliberately and temporarily.** If the server's
idea of "the current question" ever disagreed with a client's, every submission
in every game would be refused and the game would be unplayable — far worse
than a client-judged answer. It costs nothing today: the lockdown is RLS, in a
later slice, and an attacker is not running our JavaScript anyway. Tighten it
once real games log no rejections.

**The fake store implements both** (`_rpc` in `tests/harness/store.js`),
importing `fuzzyMatch` rather than reimplementing it, so a fake judge cannot
report bugs that do not exist. It enforces the timer too — leaving that out
would let a scenario pass on an answer the live server refuses, which is the
shape of every "worked in the harness" bug in this file.

**And the full-game scenario had never scored a point.** It typed
`Answer ${roundHint + 1}`, where `roundHint` is a loop counter with no relation
to the question a given phone is showing, so Alice was wrong every round and
all three boards read 0-0-0 — in perfect agreement, which is what the scenario
checked. **Three clients showing zero agree perfectly.** It reads the question
off the screen now, the boards read 15/1/0, and it fails if nobody scores at
all. Verified by making the fake server pay nothing: it reports "nobody scored
a single point all game".

### Slice 4 — the server owns the clock (migration 047)

`question_started_at` is what every timer derives from, and the host's browser
used to compute it as `Date.now() + serverTimeOffset` — an **estimate** of
server time. Harmless while only browsers read it, since every phone reads the
same stamp and a skewed estimate skewed everybody equally.

**Migration 046 ended that, and this is a hazard 046 introduced.**
`op_submit_answer` compares the stamp against the database's own `now()`, so a
host whose estimate ran slow would have every answer in the room refused as
late, and one whose estimate ran fast would stop the timer expiring at all.
`op_start_clock` stamps from `now()` — the same clock the check uses — so the
two cannot disagree by construction. It replaces a write the client already
made, so it costs no round trip, and it stays host-gated exactly as before: who
may start a round is a different question from whose clock is used.

**The final round's phase is `final_question`, not `question`, and the first
version of the client passed `'question'` for both.** `op_start_clock` checks
the phase it is given against the room's, so it correctly refused, and the
client then took the PREVIOUS round's stamp as this one's start — **the last
question of every game would have opened with the final-wager screen's
20-second clock already run down.** It shipped, and was caught reading the code
after the owner applied the SQL, not by any test.

`scenario-fullgame` now compares the two stamps as VALUES. A first attempt
measured how OLD the stamp was on each pass of the round loop and never caught
it: the re-stamp lands a second into the round, which is inside a turn, and by
the next sample the phase had moved on. Sampling now runs on its own 100ms
timer, and **two stamps being equal is true whenever you look at them** —
unlike an age, which is only wrong during a window you have to be lucky to hit.
Verified by putting the bug back.

Four things went wrong writing this, and all of them are about measurement.

- **`now()` IS TRANSACTION TIME in Postgres**, frozen for a whole `DO` block.
  Two versions of the stale-caller check compared stamps taken before and after
  a call and could not tell a refusal from a re-stamp, because both produced the
  identical value — deleting the guard changed nothing either could see. The
  check uses an ancient marker now: either it is still there or it is not.
- Before that, the check asked whether the stamp was **recent**, which is true
  both when a stale call is refused and when it re-stamps.
- **The fake store mutated rows inside an RPC without broadcasting.** An UPDATE
  inside a Postgres function reaches Realtime like any other — it is in the WAL
  either way — so the fake left every other phone unaware. `scenario-nasty`
  reported "the room is stuck"; the app was right and the harness was wrong.
  **My first diagnosis blamed the new guard and was wrong** — removing the guard
  did not fix it, which is what forced the real cause out. `_broadcast` is now
  called by every RPC that touches `rooms` or `answers`, and any new one must do
  the same or the app will look like it has stopped listening.

### Slice 5 — only the rules delete a room (migration 048)

**The hole:** `rooms` had `FOR DELETE USING (true)`, and every browser carries
the publishable key by necessity, because guests play without signing in. So
anyone who could reach the site could delete any room — including one with a
game in progress. Everybody in it thrown out mid-round, scores gone. One
request. `DROP POLICY "Rooms: anyone can delete"` closes it; `op_leave_room`
and `op_sweep_rooms` are how the app still does the things it legitimately did.

**Why this one could be closed while the rest of #2 cannot.** Every legitimate
room deletion in `js/` reduces to a single rule — *nobody is left in the room*.
`handleLeave`, `handleQuit`, `handleBackButton` and both Realtime DELETE
handlers all ask "am I the last one" and then delete; the sweeps add "a lobby
nobody started" and "everybody went silent". **Not one depends on who is
asking**, which is exactly what a guest cannot prove.

`players` is not like that: "remove me" and "remove them" are the same request
from somebody with no identity. `rooms` UPDATE is not either — the phase
machine still runs in the browser. Both wait for later slices. **Do not lock
them on the strength of this one working.**

**It also fixes a real race, not just a permission.** Every caller counted the
players it could see, concluded it was the last, and deleted. Two people
quitting at once both see two players, both conclude somebody else is staying,
and the room survives with nobody in it — one of the ways "two active games
nobody was in" happened. `op_leave_room` removes the row and decides in one
statement.

Three guards ported and each verified by breaking it: a bot never keeps a room
alive, a player with no `last_seen_at` means *cannot tell* and PROTECTS the
room, and the two-hour age sweep touches `lobby` only — a real game can easily
run longer.

**`serverFunctionsMissing()` in `js/db/client.js`** exists because the unload
path cannot await. The ordinary awaited calls record what they learn; the
beacon reads it. **Unknown counts as PRESENT**, deliberately: guessing wrong
that way leaves a player row for the stale sweep, guessing wrong the other way
puts a phone back to deleting rooms on its own local count, which is the race
this removes. One is untidy; the other loses a game.

### Slice 6 — only a host changes a verdict (migration 049)

**The hole:** `answers` had `FOR UPDATE USING (true)` and
`FOR DELETE USING (true)`. Scores are computed from `answers.score_earned`, so
anyone who could reach the site could mark any answer in any live game right or
wrong, set any score, or delete the lot — and the scoreboard changed on every
phone in the room. `op_set_judgement` and `op_disqualify_round` replace the two
writes the app legitimately made; both UPDATE and DELETE policies are dropped.

**`op_set_judgement` takes no score.** The old call passed a verdict AND a
number, so anything could set anything. The points are recomputed from the
answer's own wager, with the final round the only one that subtracts.
`auto_correct` is deliberately untouched — it holds the machine's original
verdict, and the gap between the two is `times_overridden`, the column this
project trusts most for finding a bad answer key.

**INSERT stays open, deliberately.** The client still falls back to writing an
answer directly when `op_submit_answer` is unreachable, and an RLS refusal
returns no error — revoking INSERT would turn a bad connection into a silently
lost answer. It goes when the fallback does.

**Porting the disqualification heuristic into the permission layer was wrong,
and the rule check caught it.** The client spots a thrown-out round by asking
whether every answer scored nothing and nobody was right — which is also what a
round everybody simply got WRONG looks like (CLAUDE.md already records the
flaw). In a two-player game that is the common case, so the guard refused the
commonest override there is: the host saying "actually that was right". The
client keeps that check, where the disqualification arrives as a message every
phone has seen rather than as an inference from scores. **A rule that is only
"good enough" for refunding a wager is not good enough to refuse a host.**

Disqualifying is now ONE call rather than a loop of per-answer writes: a loop
can half-succeed and leave a round that was thrown out still paying points to
whoever's write landed.

### Slice 7 — a round ends without the host (migration 056)

Built 2026-08-28, at the owner's instruction, as the piece that actually ends
the stalls. **This is the one a player can feel.**

**The stall, precisely.** Every phase change in this game is a write from one
phone, and `handleTimerExpired` in `js/game/question.js` — which fills the
blanks and sets `game_phase = 'reveal'` — is entirely behind
`canControlGame()`. So when the host's screen locks mid-round, the timer runs
out on every phone in the room and **nothing happens at all**. The deputy
mechanism (`HOST_HANDOVER_MS`, 30s) softens it, but it needs presence to
notice, needs somebody else to be there, and needs *their* phone awake. It is a
mitigation, not a fix — and the break test below shows a deputy being granted
while the round still never ended.

`op_advance_phase(room, caller)` decides from the database's own clock, so
**any player in the room may call it** and everyone gets the same answer. The
only guard on who may ask is that you are sitting in the room: it cannot be
"you are the host", because the host is the one who has gone, and it cannot be
an identity check, because a guest has no `auth.uid()`. Somebody already in the
room gains nothing by asking early — the clock still has to have run out.

**ONLY THE TIME-BASED TRANSITIONS MOVED, and that boundary is the design.**
`countdown -> question` and `question -> reveal` need no human judgement; the
clock already decided and every phone is merely reporting it. The host pressing
"Reveal Results" or "Next Question" is a person deciding the room is ready, and
putting that on a timer would change the game rather than repair it.

**The server is a BACKSTOP, and the deadline says so.** `op_submit_answer`
accepts an answer until `started + timer + 3s`, deliberately generous because
that clock belongs to a person on a phone with a bad connection. If the advance
fired at the same instant, an answer the same database would have accepted
becomes a blank, and no screen anywhere says so. So it waits `timer + 8s`:

| | ends the round at |
|---|---|
| host present | `timer + 0.5s`, exactly as before |
| host absent | `timer + 8s`, from any phone |

The rule for that is stated **behaviourally**, not as arithmetic:
`tests/sql/game-rules.sql` picks a moment, submits an answer and requires it to
land, then requires the advance to refuse at that same moment. Asserting
`advance_deadline > started + timer + 3s` would pass just as happily if 046
changed its own allowance — a check that cannot fail.

**THE SCENARIO FOUND A WORSE STALL THAN THE ONE IT WAS WRITTEN FOR.**
Announcing the question and stamping its clock are two separate writes from the
host's phone: `handlePhaseTransition` broadcasts the phase, and the stamp is
written afterwards from inside `showQuestionScreen`. Die in the few hundred
milliseconds between — which is exactly where `scenario-nasty`'s kill landed —
and `question_started_at` stays null. `getServerTimeLeft` **returns the full
duration for a null stamp**, so the bar never moves on any phone and nothing
ever expires. The room hangs on a live question forever, and waiting cannot
help, because no clock is running to wait on.

**The repair is to START it, never to end it.** A round with no stamp has not
begun, so ending it takes a question away from people who never saw the timer
move; stamping hands everybody a full, fair round from now, which is what the
host would have done had it lived. It cannot shorten anyone's time, which is
what makes it safe for any phone to ask for. Both halves are pinned, and the
"not ended" half is the one that matters.

**The client side is a POLL, and two separate debugging rounds say why.**
The first version armed a single timer at expiry. It fired once, landed a few
milliseconds early, got a correct `not due` — and **nothing ever asked again**:
the stall, reintroduced by its own fix. And a one-shot armed at expiry can
never cover the no-clock case at all, because a timer that never starts never
fires anything. `startPhaseBackstop` in `question.js` runs every
`PHASE_BACKSTOP_POLL_MS` (3s) while a question is on screen, and is deliberately
**not** started for the controller: a second path racing the first is how a fix
for a stall becomes a fix that ends rounds early.

Verified by disabling `startPhaseBackstop`: `scenario-nasty` reports both by
name — *"a question announced without a clock never started one — every phone
shows a full timer that never moves, forever"* and *"the round never ended after
the host's phone died"*. Both checks report whether anybody had been deputised
by the time they looked, and say **INCONCLUSIVE** rather than passing if so — a
scenario that cannot tell which of two mechanisms saved it is not evidence about
either.

**Still open after this:** `rooms` UPDATE stays wide open, because the rest of
the phase machine is still browser-side. Locking it is the next slice and must
wait for that.

### Slice 8a — a guest has an identity now (invisible accounts)

Built 2026-08-28 on the owner's decision, after they pushed back — correctly —
on my claim that locking `players` was impossible.

**What was impossible, and why it no longer is.** The database can only tell
people apart if they have an account. A guest had none, so every guest was the
same anonymous key — like unsigned letters. "Remove me" and "remove them"
arrive looking identical, with no way to tell which is which, and that is why
CLAUDE.md #2 says `players` cannot be locked. Supabase's **anonymous sign-in**
issues a real auth user id with no email, no password and no sign-up screen.
The player types their name and plays exactly as before, and never knows.

**Conversion is the part that makes it worth doing.** When somebody later makes
a real account, Supabase **keeps the same user id**, so everything built as a
guest carries over untouched — nothing to migrate. Signing up stops meaning
"unlock a reputation you do not have" and starts meaning "keep what you have
already built", which is a far stronger reason.

**The downsides, measured rather than asserted.** Anonymous users count toward
Supabase's MONTHLY ACTIVE user billing — so a dormant pile costs nothing, only
people who actually played that month. Free covers 50,000/month; Pro is
100,000, then about a third of a cent each. A returning guest keeps the same id
per device, so it is one per person, not one per game. An earlier version of
this section implied the accumulated ROWS were the cost; that was wrong and is
corrected here.

**THIS SLICE ACQUIRES THE IDENTITY AND CHANGES NOTHING ELSE.** That separation
is the whole design, and it is the lesson of migration 049 applied in advance.
About thirty places in `js/` ask "do they have a user id?" and mean **"are they
a real member"** — whether to record stats, shape question selection, offer
friends, show a tier badge, list somebody as an account. Hand guests an id
through the same door and every one of those switches on silently, for people
who never signed up, with every test still passing.

So `_currentUser` and `_anonUserId` are **separate variables in `auth.js`**, and
the two questions are separated with them:

| Function | Answers |
|---|---|
| `getCurrentUser()` | do they have an ACCOUNT — unchanged meaning, every existing call site untouched |
| `getAuthUserId()` | does the database know who is asking — real or invisible |
| `isAnonymousSession()` | is this an invisible account |

An invisible session returns early from `initAuth`: no profile loaded, no title
computed, nothing cached.

**NEVER FATAL.** If anonymous sign-ins are switched off in the dashboard, or the
call fails, or the network is down, `getAuthUserId()` is null and the app
behaves exactly as it did before this existed. A hiccup at Supabase's end must
not stop somebody playing — that is the one way this change could be worse than
the problem it solves. `window.__fakeAnonDisabled` in the harness reproduces
that state, because it is real.

`scenario-lobby` checks the identity is PRESENT and everything downstream
UNCHANGED — a check for only the first would go green on the version that
quietly turns a guest into a member. Verified by letting the anonymous session
through `getCurrentUser()`: three guests instantly became **three accounts with
three profiles and three seats carrying user ids**, and it reports all four by
name.

**Needs the owner to switch anonymous sign-ins on** in the Supabase dashboard.
Until then this is inert, by design.

### Slice 8b — the id goes on the seat

**Anonymous sign-ins were switched on by the owner on 2026-08-28**, so 8a is
live and this is the behaviour change that follows it. The enumeration came
FIRST, which is 049's lesson applied rather than learned again.

**The owner's decision: a guest's play IS remembered.** It reverses their
earlier call, and the premise is what changed — that decision was made when a
guest had no durable identity, so tracking them meant "keeping a record of
somebody who did not sign up". An invisible account IS a durable identity, and
Supabase keeps the same id through conversion, so the record is theirs the day
they sign up. Their words: someone should be able to play solo and progress.

| Reader of `players.user_id` | What changes for a guest |
|---|---|
| `claimSeat` | **exact** instead of a heuristic — the big win, below |
| `record_round_history` (043) | their play is remembered; selection stops re-asking what they know |
| `op_rate_host` (054) | a guest HOST can now be rated |
| `playerUserIds` (`init.js`) | their history shapes question selection, which is the point of the above |
| tier badge (`lobby.js`) | no stats, so no badge — unchanged |
| `data-profile-user-id` | **THE ONE REGRESSION**, guarded below |

**`claimSeat` stops guessing.** Its guest rule is a heuristic — *a same-name row
that is still alive might genuinely be somebody else* — and CLAUDE.md records
the duplicate seats, ghost hosts and photographed "three copies of one player"
that came of it. An id is not a guess about who somebody is. The old heuristic
stays as the fallback for when anonymous sign-in is unavailable.

**THE REGRESSION, and it is the reason the enumeration mattered.**
`showProfileCard` branched on `if (userId)`, which meant "real member" only
because nobody else had one. A guest has an id now, so tapping them in a lobby
would have shown a stats card of zeros, "No host ratings yet", and an **ADD
FRIEND button** — a request to an account with no profile page, accepted by the
database, never seen by anybody, pending forever. It branches on the PROFILE ROW
now, which is what actually defines a real account. Verified by reverting it:
`scenario-lobby` reports both the button and the fake stats card by name.

**A FOURTH seat-creation site existed, and it is the same one that was missed
before.** `join.js`, `host.js` and `lobby.js` were the obvious three;
`js/game/init.js` also calls `claimSeat`, and CLAUDE.md already records that
page being missed when the seat ratchet was fixed — two of three call sites
converted, for months. Grepping for every caller before changing anything is
what found it this time.

**Still to come:** the `players` and `rooms` lockdowns, which are what all of
this was for. The server can tell an invisible account from a real one via
`auth.users.is_anonymous`, so that distinction survives into SQL rather than
depending on anyone remembering it.

### Slice 8c — turning it on stopped anybody creating a room

**Reported from a live game on 2026-08-29: `new row violates row-level security
policy for table "rooms"`. Nobody could start a game at all.** It had been that
way since the owner flipped the switch the day before, and was found only
because somebody finally tried to host.

**Measured, after two wrong guesses:**

```
tablename | cmd    | policyname                  | roles
rooms     | INSERT | Allow anon insert on rooms   | {anon}
rooms     | SELECT | Allow anon select on rooms   | {anon}
rooms     | UPDATE | Allow anon update on rooms   | {anon}
players   | ...    | ...                          | {public}
```

**A Postgres policy can be restricted to a ROLE, and `rooms` was — to `anon`.**
Supabase gives a signed-out visitor the `anon` role and everybody else
`authenticated`. **An anonymous sign-in issues a real session, so every guest
became `authenticated`** — and the rules admitting `anon` stopped matching
anyone at all. Nothing about `rooms` changed; the meaning of "visitor" changed
underneath it.

**THE ENUMERATION MISSED A WHOLE LANGUAGE.** Slice 8a says it changed nothing
else and lists roughly thirty places in `js/` that ask "do they have a user id".
Every one of those was checked. **Not one database policy was**, and the policies
are where the assumption actually lived. A sweep of the code cannot see a role
written in SQL.

`WHERE roles <> '{public}'` over `pg_policies` is the whole audit, and it takes
one query. **Run it before changing anything about who a user IS.** It also
found `profiles` INSERT restricted to `{authenticated}`, which is correct and
harmless, so the query distinguishes fine.

**MY FIRST FIX DID NOT FIX IT, and the reason is worth more than the bug.** It
asked whether an INSERT policy EXISTED and created one only if not. A policy
existed — it simply admitted nobody. **Existence is not applicability**, and a
guard that checks the first while meaning the second reports success and changes
nothing. That is the same shape as #6's whole catalogue, arriving in a repair
rather than in a measurement.

It did repair something real by accident: `players` SELECT and UPDATE were also
missing, and the report shows them created under this fix's own names. 058's drop
loop takes `cmd IN ('INSERT','ALL')`, and **a `FOR ALL` policy covers every
command**, so closing the host hole took reading the lobby and heartbeating with
it. 051 had guarded against exactly this for `rooms` by recreating before
dropping; 058 did not, for `players`.

### Slice 8d — an auth call that never answers freezes everything behind it

**Two game-breaking reports the same evening, one cause.** A player stuck on
"Signing in..." for ever, and another stuck on "Loading game..." while the room
started without them — appearing AFK to everybody else, because `init()` never
finished so their heartbeat never started.

`js/game/init.js` opens with `await Promise.all([ensureDisplayName(), initAuth()])`,
and `initAuth` awaits Supabase auth. Every caller of `signIn` / `signUp` /
`signInWithGoogle` checks `result.error` and restores its button, so an error is
handled everywhere — **and none of that code can be reached by a promise that
never settles.** A `try/catch` was not enough and never could be: a promise that
hangs does not throw.

The screen is then left asserting the one thing that is certainly false: that it
is still working on it. **That is #4 in the loudest place in the app**, and it is
why the cause could not be established from outside — the failure produced no
error to read, on a device nobody could inspect.

`withAuthTimeout` converts both a hang and a rejection into the ordinary
`{ error }` shape every call site already handles, so all of them are fixed
without touching one of them. **Two windows, deliberately different:**

| | | |
|---|---|---|
| a deliberate press of Sign In | `AUTH_TIMEOUT_MS`, 20s | a false timeout is the worse outcome |
| page load | `AUTH_BOOT_TIMEOUT_MS`, 8s | nobody chose to wait, and playing as a guest is recoverable where a frozen page is not |

A timed-out session lookup deliberately does NOT fall through to an invisible
sign-in — asking auth a second question when it has just failed to answer only
doubles the wait.

**WHAT FIXED IT IS NOT ESTABLISHED.** Sign-in worked afterwards; whether that was
the boot timeout, the version refresh, or something transient at Supabase is
unknown, and this file is not going to claim otherwise. What IS established is
that the freeze was real, and that it is now impossible: the button ends up
either gone or pressable, always.

**AND THE REASON IT TOOK ALL EVENING IS ITS OWN FAULT.** `logger.error(...)` only
ever reached the console. **Only `window.onerror` and `unhandledrejection` were
written to `error_logs`** — so every deliberately handled failure in the app was
invisible to the admin page, which showed a confident empty list while somebody
on another phone could not sign in. Handled failures are precisely the ones you
cannot see over somebody's shoulder. `recordFault()` in `logger.js` logs AND
persists, sharing the crash handlers' ten-per-minute limit so it cannot crowd out
a real one, and is wired to the three auth faults that name a cause — including
Supabase's own message when it refuses a sign-in.

### Slice 9 — only the rules remove a player (migration 057)

**The hole:** `players` had `FOR DELETE USING (true)`, and every browser carries
the publishable key because guests play. So anyone who could reach the site
could remove any player from any live game — mid-round, with their score, in one
request. Room codes are four letters and public games are listed, so finding a
room to do it to was not a barrier.

**Why this could be closed while CLAUDE.md #2 says `players` cannot be.** That
entry is about "remove me" and "remove them" being the same request from
somebody with no identity, and that is still true — the server cannot always
tell WHO is asking. What it CAN do is ask whether the removal is one the rules
allow at all, and every legitimate delete in `js/` reduces to a rule about the
room's own state:

| Rule | |
|---|---|
| you are leaving | target IS the caller |
| the host removes a bot | `is_bot` AND caller is host — there is no kick feature, and "the host removes a live human" is a product decision nobody has made |
| the stale sweep | the target has genuinely gone quiet, measured on the DATABASE's clock rather than taken on the caller's word |
| a duplicate seat | target carries the caller's own `user_id` |

**Two guards that look like details and are not.** A BOT IS NEVER SWEPT — it
sends no heartbeat, so by the timestamp rule it is stale the moment it is added,
and without that guard anybody in the room could delete the host's bot mid-game.
And **two null `user_id`s are not a match**: written as `IS NOT DISTINCT FROM`,
every guest would have been "the same person" as every other guest and the
migration would have closed nothing. Verified by breaking each — the second
fails three rules including *"a stranger cannot remove anybody"*.

**WHAT THIS DOES NOT DO.** `players` UPDATE stays open — the ready flag, the
heartbeat and host promotion are all still browser writes. So somebody
determined can still backdate another player's `last_seen_at` and have them
swept. That is two deliberate steps instead of one request: a real reduction,
not a closed door. Say it that way.

**Every delete was enumerated first** (`phases.js` and `lobby.js` sweeps,
`lobby.js` bot removal, two leave paths, the unload beacon, `claimSeat`'s
duplicate clear), because 049 was written about the writes that were dangerous
and broke three that were not.

**The beacons needed no change, and the reason is worth keeping.** Both unload
paths reach `removePlayerBeacon` only when `serverFunctionsMissing()` is TRUE —
and in that world 057 is not applied either, so the direct delete still works.
The fallback and the policy are tied to the same condition by construction.

`removePlayer` takes `roomId` and `callerId` as **required** parameters, not
optional ones: an optional parameter a call site forgets fails silently, which
is exactly how `amendQuestionHistory` stopped correcting anybody's history.
`scripts/check-arity.mjs` fails the build on a caller that drops either.

**MY OWN FIRST BREAK TEST PASSED, and I nearly read that as "no coverage".**
Forcing the old direct delete changed nothing in `scenario-nasty` or
`scenario-lobby` — but I had simply run the wrong scenarios. `scenario-bots`
fails by name: *"the host pressed remove on the bot and it stayed."* Then the
leave check I added to `scenario-lobby` passed even with EVERY removal refused,
because leaving goes through `op_leave_room` (048) and never reaches
`op_remove_player` at all. It is kept — it pins that shutting the door did not
break the commonest seat removal in the game, which is precisely what 049 failed
to check — but its comment now says which of the two it tests. **A check that
passes for a reason you did not intend is not coverage.**

### Slice 10 — only the rules make you host (migration 058)

**The biggest hole left, and it was not about phases.** `players` had
`FOR UPDATE USING (true)`, so anyone reaching the site could set
`is_host = true` on their own row in any live game. A host is not a badge here:
they override the machine's verdict on any answer, and **migration 041 makes
that override amend the PERMANENT `question_history` of every player it
touches**. One request took over somebody's game AND let the taker rewrite other
people's records. It also reopened 057 in two steps — with UPDATE open you could
backdate another player's `last_seen_at` and have the sweep remove them for you.

**THE MECHANISM IS COLUMN-LEVEL GRANTS, not a function per write, and this is
the only slice that works that way.** Postgres enforces column privileges
independently of RLS. Measured against a real Postgres BEFORE the migration was
written:

```
UPDATE players SET last_seen_at = now()   granted column     -> allowed
UPDATE players SET is_host = true         ungranted column   -> refused
```

That matters more than tidiness. Wrapping the heartbeat in an RPC would change a
write that runs every 15 seconds on every phone, and wrapping `disconnected_at`
is not even possible — it is a keepalive fetch during page unload, which cannot
await. Column grants leave both untouched and still make the role unwritable.
Clients keep `last_seen_at`, `disconnected_at` and `is_ready`; **the UPDATE
policy is still `USING (true)`, and asserting the policy would prove nothing** —
the rule check asserts `has_column_privilege` instead.

**INSERT had to be narrowed with it**, or the lock would be pointless: you could
simply insert yourself into somebody's room with `is_host = true`. Refused only
when the room already has a LIVE host, so the room's creator and a returning
host whose seat was swept both still work. The policy calls
`op_room_has_live_host`, which is SECURITY DEFINER so RLS does not recurse into
`players` from a policy on `players`.

**WHAT THIS DOES NOT DO.** `last_seen_at` is still writable by anybody FOR
anybody, so the two-step sweep is narrowed to one column rather than closed.
Restricting it to your own row needs `user_id = auth.uid()`, which is only safe
once invisible accounts are known reliable in production — a guest whose
anonymous sign-in failed would otherwise be unable to heartbeat and would be
swept out of their own game. Its own slice, deliberately.

**`check-rpc-args.mjs` earned its keep here.** An inline comment between two
parameters in the `CREATE FUNCTION` list made the script stop reading, and it
reported `p_value` as undeclared — which is precisely the fault it exists to
catch, because PostgREST answers 404 to an unknown argument name and
`functionMissing()` reads that as "not installed" and silently falls back. The
comment moved above the list; **the tool was right and the SQL was ambiguous.**

Verified by breaking both halves: leaving the table-wide grant in place fails
*"is_host is not a column a client may write"*, and removing the promotion guard
fails three rules including *"a player cannot make themselves host"*. And by
forcing the old direct writes, which `scenario-cohost` reports as *"promoting to
co-host did not persist"* and `scenario-nasty` as *"the only person in the lobby
was never made host, because abandoned rows still held the crown"* — the
photographed ghost-host bug, caught by the conversion's own coverage.

### Slice 11 — the server moves the game on (migration 060)

Slice 7 (056) moved the TIME-BASED transitions: a round ends on the clock, and a
countdown finishes, whether or not the host's phone is awake. **This is the
other half — the transitions a PERSON decides**, by pressing Reveal Results,
Next Question, Play Again, Return to Lobby, Start Game.

**It buys nothing on its own, and that is worth saying plainly.** `rooms` still
has `FOR UPDATE USING (true)`, so every one of these is still writable directly
by anybody. This is GROUNDWORK: the phase cannot be locked while the phase
machine is a browser write, which is exactly why 048, 051, 057 and 058 all left
`rooms` alone.

`op_set_phase(room, caller, expected, to, question)` enforces three things:

1. **`op_may_advance`** — the caller is in the room and is the host, the
   co-host, or is present in a room with no live host. That third case is
   deputising, and without it a room whose host has gone is frozen forever.
   A **bot never drives**: it cannot press anything, but it is a row in
   `players` like any other and would otherwise satisfy "present".
2. **Compare-and-set** on the phase the caller believes the room is on.
3. The destination is a phase this game actually has.

**DELIBERATELY NOT A TRANSITION WHITELIST.** The obvious design is a table of
allowed from→to pairs, and I am not confident enough in the full graph to write
one — a wrong entry does not fail loudly, it makes a game unplayable at one
specific moment. This project has been burned exactly that way twice (049's
three broken writes; the disqualification heuristic ported into a permission).
The graph can be tightened later against real games rather than guessed at now.

**EVERY CALLER PASSES `null` FOR THE EXPECTED PHASE, AND I GOT THAT WRONG THREE
TIMES BEFORE ADMITTING IT.** Compare-and-set works — the rule table proves a
stale click cannot rewind a game — but the CLIENT cannot supply the fact it
needs. Every call site applies the change locally BEFORE writing, so
`state.gamePhase` is already the DESTINATION; and at the start of a game the
client's phase is `loading` while the room's is `lobby`. Each mistake failed the
same silent way: the server answered `already moved`, the client treated that as
handled, and the room never advanced. It surfaced as **a game that would not
start** and **a final wager that never committed** — never as an error.

So the guard that does the security work is on, and the one that needs a fact
the client does not have is off until a caller can supply the ROOM's phase
rather than its own. That is no worse than before this existed: two phones could
always double-advance, and the app already tolerates Realtime re-delivery.

**DATA FIRST, PHASE SECOND**, everywhere a transition also writes other columns.
Clients act on the phase — they re-read the question list when it arrives — so
the list, the countdown stamp and the room clear-out all land before the phase
that announces them. Getting that backwards is the bug "the screen must show the
question the room is asking" records, which 046 made far worse by judging
against the ROOM's question rather than the one on screen.

Verified by breaking `op_may_advance`: 11 SQL rules fail, and `scenario-fullgame`
reports *"game never reached results (stuck on phase null, question 0)"*.
Verified by breaking compare-and-set: a stale click sends a room from the
scoreboard back to results.

**Still open, and the next slice:** locking `rooms` itself. Every phase write in
`js/` now goes through this function with a direct-write fallback, which is what
that lock needs — and the fallbacks are what it will have to remove, so
enumerate them rather than rediscovering them (049's lesson, stated in advance
for once).

### The probe printed the alarm and exited 0

Found 2026-08-30 while answering "is it fixed?" — by checking whether the CI
probe's green tick meant anything.

**It did not.** The only thing that set a non-zero exit was the script's own
self-check: the guard that fires when a consequence entry names an object the
script never probes. A live database genuinely MISSING something the app
depends on printed the whole WHAT THIS MEANS FOR A PLAYER section and **exited
0**, so the run went green and nobody had any reason to open the log.

That is this file's own catalogue committed by the tool the file says to trust:
**a check that reports health for something it asked about and then ignored.**
It is the sixth entry in #6 wearing yet another disguise — not a bad question
this time, but a good question whose answer was thrown away.

**And the lockdown made it far worse than when it was written.** Before 048-062
a missing function meant a slower fallback path, which is a degradation. Now it
means a REFUSED one — and for `op_set_phase` a hard `permission denied for
column game_phase`, so no game starts or advances at all. A green tick over
that is worse than having no check.

The consequence section sets `process.exitCode = 1` now. Verified by running the
script from the dev container, which is firewalled from Supabase: everything
reads as missing and it exits 1 by the new path. **That proves the guard, not
the database** — the live answer only ever comes from CI.

### A round that nobody was allowed to rescue (2026-08-30 playtest)

**Reported from a live game, and the owner was right that it was broken:** a
friend could not submit at times, the bot did not show its answer immediately,
and the timer ran out with nothing auto-submitted while "Reveal early" sat on
screen. **Two independent faults, both single points of failure on the HOST's
phone, and both invisible to twelve passing scenarios.**

**Neither was new code.** The game engine had not changed in either respect for
weeks. What changed was the DATABASE underneath it — the 048-062 lockdown — and
before that these were merely fragile rather than fatal. That is the pattern
this file keeps recording: *what was harmlessly redundant a moment ago is now
the only path.*

#### 1. The one phone that most needed the backstop was exempt from it

The host ends a round in `handleTimerExpired`: a chain of network calls, no
timeout, no retry, fired **once** from a `setTimeout` half a second after the
clock stops. One failed or hanging request anywhere in it and the round never
ends.

`startPhaseBackstop` exists to catch exactly that — and its first line was
`if (canControlGame()) return;`. So the host and co-host never ran it.

**In a solo game with a bot the host is the ONLY human, so there was no backstop
at all.** A bot does not run a browser. Measured, by hanging the answers read
that `handleTimerExpired` waits on: `round ended after never (phase now
question)`. With the exemption removed: `round ended after 39s` — 30s clock plus
the 8s grace.

**The exemption was guarding a race the database already prevents.**
`op_advance_phase` refuses before `started + timer + 8s`, so a second caller
cannot end a round early however eager it is, and the two paths are 7.5 seconds
apart in any case (`TIMER_GRACE_MS` 500ms against `PHASE_ADVANCE_GRACE_MS` 8s).
When the host's own path works the room is on `reveal` long before the backstop
fires and the phase check stops it.

**This also explains the other two symptoms**, because `op_advance_phase` fills
blank answers server-side before moving the phase (056). A round stuck past the
server's deadline means every later submission is refused as *time is up*, falls
back to a direct write, and — since 049 revoked UPDATE on `answers` — is refused
again if a blank already exists. **The player is told their answer did not
save.** That is "my friend couldn't submit".

#### 2. The host's whole round was hidden behind a network call

`showQuestionScreen`'s normal path stamped the clock FIRST and revealed
everything after it:

```js
if (state.room.isHost) { await startClockOnServer(...); }   // ← only the host
$('.question-card').style.visibility = '';                   // card
$('#answer-form').style.visibility = '';                     // answer box
startTimer();                                                // timer + backstop
answerForBots();                                             // the bot
```

Only the host stamps, so only the host waited. A slow request left the host
looking at a blank question screen — no card, no wager grid, no answer box, no
timer — while every other player already had theirs, **and the bot had not
answered, because `answerForBots` was last in that queue.** That is the reported
"the bot didn't show its answer immediately".

And `startPhaseBackstop` lives inside `startTimer`, so a host stuck here had no
rescue either — fault 2 disabled the fix for fault 1.

The UI and the bot now go first, and the stamp is bounded by
`CLOCK_STAMP_TIMEOUT_MS` (4s), landing on the local estimate exactly as a
missing `op_start_clock` already does: a slightly worse clock, never a stopped
game.

#### The same fault in the countdown — held back, then fixed

The COUNTDOWN's self-heal (`phases.js`) was a one-shot `setTimeout` at 3s. It is
not host-gated, so several clients each attempt it — but **in a solo game with a
bot there is exactly one browser**, and the only other way out is the host's own
fire-and-forget write. Two single attempts, and if both miss the room sits on
`countdown` and the game never starts. Same fault class as the two above, in the
screen every game passes through.

It was deliberately NOT changed in the same commit as those two — nothing had
reported it and shipping a speculative third change beside two proven ones is
how a fix commit introduces a regression. It is a poll now, asking
`op_advance_phase`, which owns that transition and refuses until the countdown
has genuinely run out, so polling cannot start a game early.

**THE FIRST VERSION OF THE CHECK COULD NOT FAIL, and it took reverting the fix to
see it.** It hung the host's phase write for 12s and watched for 30s. With the
fix reverted the countdown still escaped — at 16s — because *the hung write
itself landed at 12s* and rescued the room. Two mechanisms, one observation, and
the check called it a pass either way. The hang has to OUTLAST the window: 25s
against 18s, where the backstop's 10s rescue is the only thing that can explain
a pass. Verified in both directions.

**A late injected call is not inert, either.** The first attempt hung
`op_set_phase` for 60s; it landed mid-game, reset the room to question 0, and
broke three checks in later sections that looked like product faults. That is
CLAUDE.md's own warning arriving on schedule: *when a change to one section
breaks a check three sections away, suspect what you seeded.*

#### What let both of these through

**The fake store could not see column grants.** 058 and 061 revoked UPDATE on
`players` and `rooms` and re-granted a named column list, so a client update
touching anything else is refused outright with 42501. The harness allowed every
one of them — CLAUDE.md #10 in its usual direction. `_columnGrants` in
`tests/harness/store.js` now models it, and every scenario still passes, which is
the useful half of that result: **the client code really is routed correctly, so
the lockdown was not the cause and could be ruled out by measurement rather than
by argument.**

**`store.slowFunction(name, ms)` is new and is the knob that mattered.**
`hideFunction` models "not installed", which answers instantly and takes the
fallback — a completely different failure from the one being reported. A request
that has not come back YET is the thing no `try/catch` can rescue, and nothing
in the harness could produce it.

**A scenario that plays a healthy game proves nothing about a sick one.** Both
faults need a slow or failed request to appear at all, and every scenario ran
against an instant in-memory store. The fix for that is not more scenarios, it
is the two knobs above.

### Slice 11a — the deputy could not actually advance (migration 062)

**Found 2026-08-29, and it made the whole deputy mechanism dead for exactly the
window it exists for.** This app asks two different questions about an absent
host and gives them two deliberately different answers:

| Question | Window | Why |
|---|---|---|
| may I take the crown? | `STALE_TIMEOUT_MS`, 120s | hard to undo |
| may I move the game on? | `HOST_HANDOVER_MS`, 30s | the game must not stall |

"Presence, Away and Host Handover" has stated that for months, under
**Deputising, not replacement**. `op_may_advance` (060) reached for the only
liveness function that existed — `op_room_has_live_host`, written for the crown
— and silently inherited **120 seconds**.

What a player saw:

| | |
|---|---|
| 0s | the host's screen locks |
| 30s | every phone deputises the next in line, **activates their buttons**, and posts *"X can advance while the host is away"* into the chat |
| 30–120s | they press Reveal Results. The server refuses. `setPhaseOnServer` counts `'not allowed'` as *the server was reached*, so no fallback runs and **nothing is shown anywhere**. Ninety seconds of a live, announced, useless button |
| 120s | the seat is swept, promotion runs properly, and it starts working |

**It was invisible until slice 12 shipped.** Until 061 the client's fallback
direct write to `rooms` still worked, so the refusal cost nothing. **Revoking
the column is what turned a redundant guard into a dead button** — the same
shape as 055 making `record_round_history` load-bearing, and worth expecting
every time a door is shut: *what was harmlessly redundant a moment ago is now
the only path.*

**The fix splits the question rather than picking a winning number.** Lowering
`op_room_has_live_host` to 30s would let somebody take the crown from a host
whose phone blipped, which is worse than the bug; raising the client to 120s
would delete deputising. `op_room_host_seen_within(room, interval)` is the one
implementation and **both callers name their own window at the call site**,
which is the point — the next person to read either cannot mistake it for the
other.

**25 seconds, not 30, and the five seconds are load-bearing.** The invariant is
*the server must never refuse a deputy the client has already deputised*, so the
server's window has to be strictly SHORTER than `HOST_HANDOVER_MS`; equal puts
the two on a boundary that clock skew decides. Nobody can ask earlier anyway —
the button is not enabled until the client deputises.

**A declined advance now reaches the player.** `'not allowed'` was logged and
swallowed, which is #4 exactly. It is rare by design after 062 (a deputy whose
view of the host is stale, or a host whose seat was swept), so a toast is
appropriate rather than noise — *the fix was the window, not the wording.*

**THE SCENARIO ONLY EVER CHECKED THAT A BUTTON WAS VISIBLE.**
`scenario-nasty` confirmed the deputy had controls on screen and never pressed
one. Same lesson as `scenario-admin`'s panels: **"it opened" is not "it works"**,
and a control that renders perfectly and does nothing renders exactly as
happily. It presses one now and requires the room's phase or question number to
actually move.

**The rules state the BEHAVIOUR, never the number.** Asserting "the window is
25 seconds" would pass just as happily if `HOST_HANDOVER_MS` moved and the two
drifted apart again, which is the whole fault. `tests/sql/game-rules.sql` uses a
**45-second** host instead — every earlier rule about a leaderless room compared
"10 minutes ago" against "now", so both sides sat far outside the window and the
gap between them was never tested at all.

**Two guards found by the same sweep, both cheap and both structural:**

- `scripts/verify-sql.mjs` applies a **hand-written list** of migrations, so a
  new one is untested by default with nothing saying so. 062's rules were
  written, run, and reported a failure that was really *"the fix was never
  applied"* — indistinguishable from the bug still being there. It now refuses
  to run if any migration from 045 on is missing from the list.
- The fake store had the 120-second number **copied into both** of its
  liveness checks, so the harness agreed with the bug. One helper now, two
  windows, mirroring the migration. It also rejected a NULL destination phase
  that 061 explicitly allows, so the lobby's pre-start reset silently did
  nothing there and the harness ran a subtly different game from the live site.

**Every SQL interval in `migrations/` was compared against `js/constants.js`
before writing any of this**, and that is the reusable part: six pairs, five
matching (20 minutes, 2 hours, 8 seconds, 3 seconds deliberately generous, 10
seconds documented), one wrong. **When the same quantity is written down in two
languages, go and diff them — the mismatch will not announce itself.**

### Shutting a door shut three things nobody was watching (migration 051)

**Slice 6 broke Play Again, rejoining, and practice bots, and every check in
this repo went on passing.** Found 2026-08-24 by reading every write to
`answers`, which is a thing that should have been done before 049 was written.

`answers` carried three writes that were neither a judgement nor an attack, and
all three went through UPDATE or DELETE:

| Call | What a player saw |
|---|---|
| `deleteAnswersByRoom` | Play Again keeps the LAST game's answers — the next game's scoreboard is computed over a finished one |
| `reassignPlayerAnswers` | rejoining loses your score and your used wagers |
| `upsertAnswers` (bots) | a bot never answers the final question |

Migration 051 restores each as a SECURITY DEFINER function with the rule that
made it legitimate stated where a request cannot edit it out: `op_reset_answers`
(host only), `op_reassign_answers` (**the old seat must be GONE** — you can
never take answers off somebody still in the room), and `op_bot_answer` (the
target must be `is_bot`, which is far tighter than "the caller is the host":
nothing a person plays can be written through it at all).

**The lesson is not "be careful with RLS".** It is that closing a door is a
change like any other, and the thing to enumerate is not what the door stops —
it is everything that was walking through it. `js/` had eight writes to
`answers`; 049 was written about the two that were dangerous.

**Three refusal shapes, and they are NOT the same. Measured against a real
Postgres with the UPDATE policy removed, not assumed:**

| Statement | Result |
|---|---|
| `UPDATE` / `DELETE` | 0 rows, **no error** — silent |
| `INSERT … ON CONFLICT DO UPDATE`, **conflicting** | **hard error 42501** — loud, nothing written |
| `INSERT … ON CONFLICT DO UPDATE`, **no conflict** | **OK, the row is written** |
| `INSERT … ON CONFLICT DO NOTHING` | fine, 0 rows inserted |
| plain `INSERT` onto an existing key | 23505, as it always was |

So `insertBlankAnswers` (DO NOTHING) survived 049 untouched, `upsertAnswers`
started throwing where anyone could see it, and the two plain statements died
in silence — which is why those were the two that stayed broken.

**That table had four rows on 2026-08-25 and one of them was too broad.** It
said `ON CONFLICT DO UPDATE` was simply a hard 42501, and a session reading it
concluded the client's whole fallback submit path was dead — that a first answer
could no longer be written at all. Re-measured against a scratch Postgres in
exactly the 049 shape, that is wrong: **the UPDATE arm is only reached when
there is a conflict**, so a first answer still inserts and only an EDIT is
refused. Which is the behaviour the fallback wants.

**A measurement summarised one notch too confidently is a measurement that will
be believed and acted on.** The original was taken on a conflicting statement
and written down without the condition; nothing in the repo could tell the two
apart, and the fake store — which had it right — read as the thing that was
wrong. Re-measure before you widen a claim, and state what the case WAS.

**The fake store also cascades what the room cascades** (`_deleteRoomCascade`),
because deleting a room really does take its players, answers and chat with it
— `answers.room_id -> rooms ON DELETE CASCADE` is measured, from migration 052's
own output. `game_plays` deliberately does not, since 033 dropped its keys, and
since 052 a PLAYER deletion takes nothing at all. The store used to leave every
one of those rows behind: the #10 gap in its usual direction, the harness
allowing what the real database would already have swept away.

**The fake store now shuts the same doors** (`_shutDoors` in
`tests/harness/store.js`), with all three shapes reproduced. It is seeded from
the migrations and is not a scenario knob: it is the schema. Before this the
harness allowed everything the live database had just forbidden, which is
exactly the faithfulness gap CLAUDE.md #10 was written about — and it had
`scenario-playagain` asserting "no answers survive into the next game", passing,
while that was false on the live site.

Verified by putting each old path back:

| Reverted | What the harness now says |
|---|---|
| Play Again's direct DELETE | `12 answers from the previous game were not cleared — they will be counted again` |
| the bot's direct upsert | `answerFinalQuestionForBots failed … code: 42501` |
| the host guard on `op_reset_answers` | 3 SQL rules, incl. `a player who is not the host cannot wipe a game` |
| the theft guard on `op_reassign_answers` | `answers cannot be taken off a player who is still in the room` |
| the `is_bot` guard on `op_bot_answer` | `nobody can write an answer for a real player` |

**`scenario-admin` now presses the End button**, which nothing had ever done —
which is how it shipped broken and stayed that way. A control with no test is a
control nobody is checking, the same lesson as a page with no mock.

**SETTLED 2026-08-25, and the answer was the bad one.** `answers.player_id`
DID carry a key to `players` on the live database, so a released seat took its
answers with it and `op_reassign_answers` was moving rows that were not there.
Migration 052 drops it. The measurement, the reasoning and what it means for a
player are under "Rejoin keeps your history"; the probe now reports it on every
run, so it can never go unmeasured again.

**Slice 5 had done the same thing to `rooms`, and that was found only by going
looking for it.** 048 revoked DELETE on `rooms`, and two more things went with
it:

- **The admin's "End" button on a stuck room.** A plain delete, silently
  refused, and the dashboard redrew as though the room had ended.
  `op_admin_end_room` (051) replaces it. `op_leave_room` could not: that
  deletes a room only when nobody is left, and this button is for rooms that
  still have people in them. It is the **one function in the rebuild that
  checks who is calling** — an admin is signed in by definition, where a host
  very often is a guest with no `auth.uid()` at all.
- **The Join page's sweep.** `cleanupOrphanedRooms` is called from there and
  nowhere else, and every delete inside it was refused, so abandoned rooms
  went back to being offered to real players — the "two active games nobody
  was in" this project has already fixed once. It calls `sweepRoomsOnServer()`
  first now. `sweepRoomsOnServer` was already imported into `js/lobby.js` and
  **never called**, which is its own small lesson: an import is not a wiring.

The two Realtime "the room is empty now" handlers (`js/lobby.js`,
`js/game/phases.js`) go through the sweep too. Those were backstops rather than
the main path — the leaver's own `op_leave_room` already takes an emptied room
— so nothing visibly broke, which is exactly why they would have stayed dead.

**`handleBackButton` in the lobby was still firing `deleteRoomBeacon`.** Slice 5
converted the game page's unload path to `leaveRoomBeacon` and left the lobby's
back button on the revoked delete, so backing out as the last player left the
room behind until a sweep found it. It reads `serverFunctionsMissing()` now,
with the same rule: **unknown counts as PRESENT**, because guessing wrong that
way leaves a row for the sweep while guessing wrong the other way puts a phone
back to deleting rooms on its own local count.

**Four of these five were found by grepping every write to the two tables the
migrations had touched, and none by a failing test.** After revoking a
permission, that grep is the work — not an afterthought.

**AND THE GREP MISSED ONE — the sixth, found 2026-08-25, and it was the worst
of them.** `lockInFinalWager` in `js/game/scores.js` writes the
`__WAGER_LOCKED__` placeholder so the rest of the room can see the number, and
it did so through `submitAnswer` — an UPSERT. Measured: a conflicting
`ON CONFLICT DO UPDATE` raises 42501 under 049 and writes nothing.

So **the moment any row already existed at the final question, locking a wager
failed.** One does exist whenever the 20-second wager clock has expired, because
the blank fill writes a row for every player. The placeholder never landed,
nobody else in the room saw the number, and the player was told:

> Your answer didn't save — check your connection and try again

for a wager they had just chosen. That is the "I bet 20 and it wagered 0"
family, coming back through the door 049 shut.

It is `insertAnswersIfAbsent` now — `ON CONFLICT DO NOTHING` — and **that is the
correct rule, not a workaround**: `op_submit_answer` keeps `existing.wager` on
the final round because LOCKED IS LOCKED, and a placeholder must never overwrite
a real answer or a blank. A write that can only ever ADD is exactly what this
needs.

**Why the grep missed it, which is the part worth keeping.** The grep was for
writes to `answers`, and this one does not look like one: it is called
`submitAnswer`, in `scores.js`, on the final-wager screen, and it reads as a
player submitting. Its table is three files away. **Grep for the TABLE and you
find the writes you already think of as writes.**

**What did find it was a flaky test, and I nearly dismissed it.**
`scenario-social` failed about one run in five with a console error nobody had
put there. The temptation with a one-in-five failure is to re-run it; the run
that passes tells you nothing, and this one had been failing for as long as 049
had been live. Two wrong guesses at the cause were eliminated only by tracing
the actual call, and both were plausible enough to have been written down as
the answer. **A flaky failure is a real failure with a timing condition
attached.** `scenario-feedback` now drives it directly so it fails every time,
with a negative half that makes the same call the old way and fails if it is
NOT refused.

That scenario also prints **every** console error now, not just the first. It
was the first that was truncated to 140 characters, which is what made two
rounds of guessing necessary.

**A ROOM OUTLIVES A GAME, so the clear-out is now belt AND braces.**
`answersForCurrentGame` in `scoring-helpers.js` filters every answer fetch
against the room's current `question_ids`, using the `question_id` each row
already carries. A stale row is then recognised structurally rather than
trusted to have been deleted — which matters beyond migration 051, because the
clear-out is **host-gated**, so a room that returns to the lobby without its
host never runs it at all. Everybody would start the next game holding the
points they won in the last one, silently.

It keeps a row whenever it cannot tell — no question list loaded yet, a round
number the list does not reach, a row with no `question_id` — on the same rule
as a missing `last_seen_at` meaning "here": dropping a real answer costs
somebody their score.

**Unit tests only, and that is an admission.** A scenario check was written and
deleted: it passed just as happily with the filter stubbed out, because the
seeded stale row did not survive to the moment the scoreboard is computed and
no RPC removed it. It was measuring nothing. Same call as the final-wager
guards — a check that cannot fail looks like coverage and is worse than none.

**048's own verification could not have caught 049's bug happening to it.** It
closed the door with `DROP POLICY IF EXISTS "Rooms: anyone can delete"` — by
name — and checked `cmd = 'DELETE'`. Both are exactly the weaknesses that made
049 fail silently live:

- the live policy names are **not** the ones migration 022 declares, which is
  why 049's drops did nothing, and `IF EXISTS` makes that a NOTICE rather than
  an error;
- a policy written `FOR ALL` has `cmd = 'ALL'` and grants DELETE as a side
  effect, so the check reads **ok** with the door wide open.

049 was caught only because its verification block happened to be run and
reported FAIL. 048's would have said ok either way. Migration 051 redoes it by
LOOKING, the way 036 and 050 do, and verifies `cmd IN ('DELETE','ALL')`.
**Never drop a policy by name in this project, and never verify one by a single
`cmd` value.**

**And always qualify the schema — my own check got this wrong.** 051's first
verification asked `WHERE tablename = 'answers'` with no `schemaname`, while
every DROP loop is correctly confined to `public`. `pg_policies` spans the whole
database, so the check could report FAIL for a policy the fix was never going to
touch. **A verification must ask exactly the question its fix answers**, which
is the same lesson as 048's single `cmd` value wearing different clothes.

**050's DROP LOOP NEVER TOOK EFFECT ON THE LIVE DATABASE, and only looking
established it.** 051 came back with `door_still_shut` FAIL and everything else
ok. Two explanations fitted — a policy in `public` that 050's block never
removed, or one on an `answers` table in another schema, which would not be the
game's table at all — and the ok/FAIL cell could not tell them apart. Listing
every policy on any table named `answers`, in every schema, settled it in one
run: nothing outside `public`, so the offending policy was the app's and had
survived 050. Why is not known; the likeliest is that the paste errored partway
and the SQL editor stopped.

**So a check that can fail now prints what it saw.** 051's verification is one
result set: the verdicts, then every policy on `answers` and `rooms` with its
schema, on every run whether it passes or not. Settling this cost a round trip
to the owner that the evidence would have saved. **When a check and a fix
disagree, the thing to do is look, not reason.**

`rooms` UPDATE deliberately stays open — the phase machine still runs in the
browser — and 051 asserts that too, because a lockdown that stops a game
advancing is worse than the hole it closes.

### The seat ratchet had a third copy

`js/game/init.js` still held the `sameName.length === 1` logic that "One person,
one seat" (below) describes fixing. join.html and the lobby were routed through
`claimSeat`; the GAME page was missed, so refreshing there still ratcheted —
two duplicates made a third, three made a fourth, for the life of the room.

It also passed `state.room.isHost` straight from sessionStorage into a fresh
row, so a host whose seat had been swept — after somebody else was promoted —
came back and added a SECOND row flagged host. That is the other half of the
photographed "two hosts in the lobby": `promoteToHost` adding one, and this
adding another. It now returns as an ordinary player if a live host is already
there, and cannot-tell still counts as HERE.

**When a fix is described as "the single path now", check that it is.** Three
call sites, two converted, and the sentence in this file said the job was done.

## The screen must show the question the room is asking

**Reported from a live game: a player received a completely different final
question from everybody else.**

The host swaps the final question for one matching the difficulty vote and
broadcasts the new `question_ids` in a single room update. Lose that one event
— a real connection does, occasionally — and the player kept their own
pre-fetched question. **Nothing ever re-checked the list.** `syncToCurrentState`
is the safety net for a missed Realtime event and it caught up the phase and the
question NUMBER, never the question LIST.

It became far worse with migration 046, because the verdict now comes from the
ROOM's question, not the one on the screen. So the player answered a question
nobody else was asked and was marked wrong on one they never saw.

The poll compares `question_ids` against `state.questions` now, refetches, and
forces a re-render even when the round number has not moved — the question on
screen is the thing that is wrong.

**No scenario could see it, for two separate reasons.** Every seeded question
was `difficulty: 'medium'`, so `fetchQuestionByDifficulty` never found a
different one and the swap silently never happened. And nothing had ever
dropped a Realtime event, so the safety net had never been asked to catch
anything. `store.dropEvents(table, n)` swallows events the way a connection
does; `scenario-fullgame` seeds mixed difficulties, drops the update carrying
the swap, and fails if the players' answers name more than one question id.
Verified by removing the fix: **"players were asked 2 DIFFERENT final
questions".**

## A submit refused after the round closed is the system working

Found 2026-08-25, from an **intermittent** scenario failure —
`scenario-social` failed roughly one run in five with a console error nobody
had put there: `Submit answer failed … code: 42501`.

Once a round is closed the player already holds a row: the blank fill wrote one,
or on the final round the `__WAGER_LOCKED__` placeholder did. If they press
Submit now, `op_submit_answer` refuses with *time is up*, and the client falls
back to a direct upsert — which HITS that row, and 049 revoked UPDATE.

**Nothing is wrong with what happens.** The row already there is the one that
should stand, and it does. What was wrong was what the player was told:

> Your answer didn't save — check your connection and try again

Wrong three times in one sentence. It is not the connection, trying again cannot
help, and something IS saved. The screen was already showing the true thing —
"Time's up — your last answer stands" — directly underneath it. It also logged
at ERROR, so the system working filled the console with a fault.

`submitAnswer` takes `afterServerRefusal` now. With it, a **42501 and only a
42501** is a warn with no toast; every other error, and every error without that
context, reports exactly as before. Widening that would put #4 — the deepest
fault in this codebase — back into its loudest path.

**The check for it lives in `scenario-feedback`, driven directly rather than
waited for**, because whether a submit lands before or after expiry is a matter
of timing and a flaky check is one people learn to re-run. It has a NEGATIVE
half that makes the same call without the flag and fails if the player is told
nothing — without it, the quiet assertion passes just as happily when nothing
ever toasts. Verified by disabling the branch: it reports the lie by name.

**A related one in the same sweep: the host's final-round tidy-up used
`submitAnswer` too.** When `op_fill_blank_answers` cannot be reached, the host
converts everyone's leftover `__WAGER_LOCKED__` rows into blanks — writing on
OTHER PEOPLE'S behalf — and `submitAnswer` toasts *the host* "Your answer didn't
save", once per absent player. It is `upsertAnswers` now, which logs and does
not toast. **Deliberately still loud in the log**: if that branch is ever
reached the locked wager stays attached to a question nobody answered, and the
final round is the only one that SUBTRACTS.

## The third blank-fill site, and it had missed two fixes

Found 2026-08-26, by tracing an intermittent `scenario-social` failure to its
call site instead of guessing at it again. **A SEVENTH thing migration 049 shut,
and the one with the worst consequence.**

`handleRevealResults` — the host pressing "Reveal Results" before everybody has
answered — closed the round for the missing players with `submitAnswer` and a
hardcoded `wager: 1`. Both halves were wrong, and each is a fix that had already
been made TWICE somewhere else:

- **It is an upsert.** On the final round every player who has locked a wager
  already holds a `__WAGER_LOCKED__` row, so the statement conflicted, 049
  refused it with 42501, and **nothing was written**. Their locked wager stayed
  attached to a question they never answered — and the final round is the only
  one that SUBTRACTS, so that is the difference between scoring nothing and
  losing 20 for being away. It also toasted the HOST "your answer didn't save",
  once per absent player.
- **`wager: 1` is the exact fault the 2026-08-18 playtest fixed** in the other
  two fill paths: it hands somebody a second answer at a wager they have already
  spent, breaking the rule that 1..N are each used exactly once.

It uses `insertBlankAnswers` now — ON CONFLICT DO NOTHING, which survives 049
— with each player burning their OWN lowest unused wager.

**NOT `op_fill_blank_answers`, and reaching for it changed the feature.** The
two paths mean different things: the CLOCK running out closes everybody out,
including converting a `__WAGER_LOCKED__` placeholder into a blank; the host
revealing EARLY should only close out people with no row at all. Somebody who
has locked a final wager and is still typing HAS a row, and the server call
turned their 20 into a blank. `scenario-fullgame` caught it by name — "Bob
tapped 20 on the final wager and was committed to 0" — which is the bug the
2026-08-20 playtest is named after, reintroduced by a fix for something else.
DO NOTHING makes it safe by construction rather than by remembering.

**Three sites, and the two earlier fixes each reached two of them.** That is the
fourth time this file has recorded the same shape. The habit that finds it is
not a test: it is grepping for every OTHER caller of the thing you just changed.

**The check for this is probabilistic and that is stated rather than dressed
up.** `scenario-social` failed roughly one run in three before and passes
consistently after, which is evidence but not a named assertion. The SQL rule
table pins the SERVER path (`op_fill_blank_answers`) exactly; what has no
deterministic check is the client fallback, because reaching it requires the RPC
to be unavailable at the moment a host reveals early with somebody absent.

**And the way it was found is the reusable part.** Two earlier attempts guessed
at the call site from the symptom and were both wrong — one of them twice. What
settled it in a single run was printing the STACK from inside the failing
function. When an error names a function with several callers, make it say which
one; reasoning about which is most likely has now cost three rounds.

## You could not find a friend by their exact tag

Found 2026-08-28 by going through every `.maybeSingle()` in `js/` looking for
the read-then-write ratchet CLAUDE.md #10 records four times. These two are a
different fault in the same family — **a lookup that cannot survive more than
one match** — and they sit in the friend-adding path, which is the path the
friends-only leaderboard depends on entirely.

`fetchProfileByTag` was `.ilike('display_name', name).eq('discriminator', d)
.maybeSingle()`. **Measured against a real Postgres, not assumed:**

```
ILIKE 'Bob_1'  -> 2 rows   (Bob_1 AND Bob01)
ILIKE 'Alice'  -> 2 rows   (Alice AND alice)
ILIKE 'Bob\_1' -> 1 row
```

Two independent hazards in one call:

- **`_` and `%` are wildcards and display names have no character
  restriction.** `setDisplayName` trims and stores whatever was typed, up to 20
  characters. So looking somebody up by tag could match a DIFFERENT PERSON —
  and with `.limit(1)` instead of `maybeSingle()` it would have returned them
  silently, and the friend request would have gone to a stranger.
- **Uniqueness was checked case-SENSITIVELY and looked up
  case-INSENSITIVELY.** `generateDiscriminator` filtered
  `.eq('display_name', displayName)`, so "Alice" and "alice" could each be
  handed `#1234` without either uniqueness check seeing the other. From that
  moment **neither of them could be found by tag again, ever.**

`maybeSingle()` ERRORS on more than one row, so either collision returned null,
which `js/profile.js` renders as **"No results found"** for a person who plainly
exists. And the search box's OTHER branch — a partial "Name#" — goes through
`searchProfiles`, which uses a wildcard LIKE and finds them perfectly well. So
the full tag failed while the shorter query worked, which is an inconsistency
nobody could report usefully.

**A third fault underneath both.** `generateDiscriminator` destructured `data`
only and threw the error away, so ANY failed read — a blip, a refusal, a
multi-row error — left `data` undefined and it returned that discriminator as
free. **A failed read is not an absent row**, the same rule as
`upsertQuestionHistory`: trying another is free, handing out a duplicate is
permanent.

**The fix removes the hazard rather than escaping around it.** Both queries are
keyed on the discriminator with `.eq` — no pattern language in the query at all
— and the name is matched in JS by `pickProfileByTag` in `utils.js`, which
prefers an EXACT-case match so that when two people really do share a tag, the
one you typed is the one you get. Escaping the backslash would have worked in
Postgres (measured above) but depends on how PostgREST passes it through to
ILIKE, and betting on unverified middleware behaviour is exactly what #10 is
about.

**The exact-tag branch had NO robot coverage at all** — every scenario searched
by plain name, which takes the other branch. `scenario-account` now seeds a
case-variant impostor on the same discriminator and searches the full tag.
Verified by restoring the old query: it reports **"searching a player's exact
tag Bob#1001 reported No results found for somebody who exists"**. The fake
store was already faithful here (it translates `%` to `.*` and `_` to `.`, and
`ilike` is case-insensitive), so a check would have caught this the day it
shipped had one existed.

`tests/utils.test.js` pins `pickProfileByTag` and fails four ways when it is
reduced to "first match", which is what `.limit(1)` on the old query would have
done.

## A failed rename tried to save its own error message as your name

Found 2026-08-28, and the way it was found is the reusable part: I read
`saveName` in `js/profile.js` looking for a DIFFERENT fault (a save that updates
the screen without checking the write landed, the shape #5 is about) and was
wrong about that one — `updateProfile` uses `.single()`, which turns the
zero-row RLS refusal into a real error, so checking `error` really is enough.
**Checking before claiming is what turned up the real bug next to it.**

The name editor puts its own error text into the input's VALUE —
`"Could not update name"`, or `"Name taken with your #tag"` — and restores the
real name two seconds later. `saveName` reads `input.value` and saves it, and it
runs on blur. The error branch cleared the re-entry guard immediately and
re-enabled the field, so tapping back into it and away again inside those two
seconds sent the app's own error message as the player's display name.

**It was unreachable by a plain blur, which is why it survived.**
`input.disabled = true` runs before the write, and disabling a focused input
blurs it — so by the time the error is shown the field is not focused and no
blur event is coming. It needs a deliberate re-focus, which is an ordinary tap.

**The first version of the check could not fail, and said so.** It called
`el.blur()` on an element that was already blurred: a no-op that fires no event,
so it passed whatever the code did. Re-focusing first is what made it real —
`scenario-account` then reported `["Renamed","Could not update name"]` as the
values the app tried to save. Same rule as everywhere else here: **a check that
agrees with you whatever you do is worse than none.**

The fix keeps the guard CLOSED and the field DISABLED for the whole window the
message is on screen, so there is nothing to type over and nothing to submit
until the real name is back.

## Three timers outlived cleanup(), and one could restart a game the host had ended

Found 2026-08-28 by listing every `state.<name> = setInterval(...)` in
`js/game/` and diffing it against what `cleanup()` clears. Three were missing:
`autoProceedTimerId`, `finalWagerTimerId` and `feedbackFadeTimer`.

**Why it did not matter until it did.** Every `cleanup()` call site navigates
immediately, so a leaked timer dies with the page — which is why this survived.
**`executeReturnToLobby` is the exception**: the host ending the game from the
settings gear calls `cleanup()` and then **awaits three database round trips**
(`deleteAnswersByRoom`, `updateGameState`, `updateRoomStatus`) before
navigating. That is seconds on a phone, and a leaked timer is live for all of
it.

| Leaked | What it does in that window |
|---|---|
| `autoProceedTimerId` | fires `actionFn()` and ADVANCES THE GAME — writing `game_phase='question'` after the same function has written `'lobby'` and emptied `question_ids`. Every phone in the room lands on a question screen with no questions in it. |
| `finalWagerTimerId` | fires `lockInFinalWager()`, which WRITES AN ANSWER — into the room whose answers that same function is in the middle of deleting |
| `feedbackFadeTimer` | touches the DOM only; tidiness, not a fault |

The auto-proceed one is the reachable one: the gear is available on the scores
screen, which is exactly where the between-rounds countdown runs, and ending a
game takes two taps well inside it.

**The fix is a lint, not just three more lines.** `tests/phase-guards.test.js`
now reads every timer assignment in `js/game/` and fails naming any that
`cleanup()` does not clear — because "a rule stated twice and fixed once" is the
single most repeated failure in this file, and spotting an ABSENCE by reading a
function is exactly what people do not do. It carries a guard on itself as well:
if the pattern ever stops matching, the check would pass over an empty set and
report a clean bill of health for any amount of leakage, so it asserts it found
the timers it is meant to be checking. Verified by deleting one clear: it
reports `timers started but never cleared in cleanup(): autoProceedTimerId`.

## Chat showed the FIRST hundred messages, not the last

`fetchMessages` ordered `created_at` ASCENDING and limited to
`CHAT_MESSAGES_LIMIT` (100). That asks Postgres for the OLDEST hundred rows —
so the moment a room passed the limit, anybody reloading, returning from a game,
or opening the in-game chat pane saw the first hundred things ever said and
nothing since.

Realtime still delivered live messages, so **the hole healed itself the instant
somebody typed**, which is about as hard to report as a bug gets: by the time
you look, it is gone.

Descending-then-reversed returns the identical set under the limit and the right
one over it. `archiveChatMessages` gains by the same argument — a truncated
archive should hold the conversation, not the opening hellos.

`scenario-social` seeds **120** messages, because under 100 both orderings agree
and the check could not fail. Verified by restoring the old ordering: it reports
the newest message missing and names the cause.

## "I bet 20 and it wagered 0"

Two independent causes, both fixed.

**The blank fill ate the locked wager.** `op_fill_blank_answers` converts a
`__WAGER_LOCKED__` placeholder into a blank answer, and it was also setting the
wager to 0. That is right for the SCORE — going quiet on the final round must
cost nothing — but it destroyed the number the player chose, and an answer
landing a moment later then inherited it, because a locked final wager cannot
be revised. Migration 050 keeps the wager and expresses the cost where it
belongs, in `score_earned`. Verified by putting `EXCLUDED.wager` back: three
rules fail, `got "0", want "20"`.

**A second, DEFENSIVE change, and it is not evidence-backed — say so.**
`showFinalWagerScreen` reset `finalWagerSelected` and, worse, cleared
`state.difficultyVotes` — every vote in the room, not just this player's, and
votes are broadcast-only so nobody re-sends them. It also tore down and
recreated the vote channel. All of that runs on every call, and the phase
router calls it with no same-phase guard, so a re-render would wipe a player's
choice and the room's votes. `state._renderedFinalWager` now guards all three.

**But I could not make that re-render happen.** A hand-made room broadcast, a
real room write through the store, and a synthetic backgrounding all failed to
produce a second render — instrumented, the wager screen renders exactly ONCE
per game in the harness, so any check written around it passes whatever is
broken. Two such checks were written and then deleted: **a check that cannot
fail is worse than none, because it looks like coverage.**

So the guards stay as cheap insurance, and this paragraph is the honest record
that they fix a fault seen by inspection rather than one reproduced. The
REPORTED bug ("bet 20, wagered 0") has a different, proven cause — the blank
fill above — and that one does have a test that fails when reverted. **Do not
cite the guards as the explanation for it.**

**An empty answer before the reveal now reads as WAITING**, not "No answer".
The fill can beat a submission that is already in flight, so the row appears
empty for a moment before the real answer overwrites it — reported as an answer
"appearing as no answer for a split second". Before the reveal the two cases
are indistinguishable, and guessing WAITING is the one that never shows
somebody a verdict on an answer they did send. Same rule the
`__WAGER_LOCKED__` placeholder already followed.

## The Map

A honeycomb of the question bank, above the Mastery list on the profile. The
owner asked for it: "to have knowledge displayed in this manner… it'll make
people want to complete it".

**Twelve hexes, one per category, and every category is on it** whether or not
the player has ever touched one. That is the entire reason it exists alongside
the Mastery list, which is kept: the list only names what somebody has already
started, so it can never show them what is left. **The empty cells are the
invitation.** Tap one to open its subcategories; Wild Card has none, so it is
not tappable and is not styled as though it were.

**SETTLED 2026-08-24: the Mastery list stays.** Whether it was still earning
its place beside the Map was an open question put to the owner, and the answer
was "just leave mastery for now". Do not remove or merge it on a tidiness
argument.

`js/honeycomb.js` holds the geometry, has **no imports**, and is unit tested —
same rule as `radar.js` and `bot-logic.js`, because everything around it pulls
the Supabase client from `esm.sh` and the test runner cannot load that.

- **Pointy-top hexes in offset rows**, which stack vertically with a half-width
  stagger. Flat-top wants to grow sideways, and sideways is the one direction a
  portrait phone has none to grow in.
- **A short last row is centred** on the rows above it. Hard against the left
  edge reads as a mistake.
- **`hexFill` gives anything above zero a visible floor of 6%.** A real category
  fraction against 4,859 questions is often 0.4%, which draws as nothing — and
  then "I have started this" and "I have never touched this" look identical on
  the one screen whose whole job is that difference. The printed count stays
  exact; only the bar is floored, and only once there is something real.
- **The fill rises from the bottom.** Filling downward from the top reads as
  draining.
- `hexLayout` reports a box, and `tests/honeycomb.test.js` asserts every cell
  fits inside it. A cell outside the viewBox is silently clipped on the phone
  and nothing in the code would say so.

**A subcategory's mastered count sums its whole branch**, because
`fetchQuestionCount` counts a whole branch (`LIKE 'human%'` picks up
`human-countries`). Counting only the node itself would put a real numerator
over a branch-sized denominator and report somebody as further behind than they
are.

Per-subcategory totals are in nothing already fetched, so they are counted on
demand and cached. **The drilled view renders before they arrive as well as
after** — the emoji, the label and what you have mastered are all meaningful
without a denominator, and a blank pane while six head requests finish reads as
a broken tap. A failed count leaves the cell with no denominator rather than a
zero, which would claim the branch is empty.

**`fetchCategories()` moved out of the "has mastered something" branch** in
`js/profile.js`. The map needs bank totals for a player with no mastery at all,
who is precisely the person the empty cells are addressed to.

Two mock states, not one: `profile-stats` carries the top-level map and
`mastery-map-drilled` carries the opened view — the back button and the
category name exist only in the second, so without it nothing was checking that
that row fits itself at 375px. The mock inlines the geometry because `inject()`
is serialised into the browser and cannot import; **if `honeycomb.js` changes,
the mock changes in the same commit** or the sweep is reviewing a shape that
never ships.

**The first render found a bug no test could have.** A short row was centred
exactly, which put it a quarter of a cell off the half-step, and the hexes
overlapped instead of tessellating — the comb rendered as a pile of blobs. Every
number was correct. `tests/honeycomb.test.js` now pins the lattice (verified by
putting the exact centring back), and the outline, which had been the same
colour as the cell it outlined, is a contrasting stroke — without it a low fill
read as a stray arrow floating under the cell rather than as that cell filling.

`scenario-account` checks the property that distinguishes the map from the
list: **twelve cells for a player who has played two categories**, some of them
marked untouched. It then drills into History, checks the four subcategories and
the way back. Verified by filtering the map to categories with mastery — it
reports three failures by name.

**`scripts/screenshot.js` takes `--scroll=<selector>`.** The screens are
fixed-height flex containers that scroll internally, so `--full` cannot reach
anything below the fold — on profile.html that is most of the page, and a
section nobody can photograph is a section nobody is reviewing.

## The agreed shape of titles (designed 2026-08-29, BUILT 2026-08-30)

**This was a design the owner and I settled in conversation, and it is now in
the code.** The reasoning is kept in full because it took a long argument to
reach and because it explains numbers that would otherwise look arbitrary.

What is built: `js/title-tiers.js` holds the rules (floors, shares, targets) with
no imports and its own unit tests; `js/titles.js` carries `type: 'count'` unlocks
and the overlay that merges owner-written words in; `migrations/063` stores the
words; the admin page's Title Words panel writes them.

**Still the owner's own work, and nothing can do it for them:** roughly 86 words
to write, and about a dozen questions each to add to History's Ancient (58) and
Medieval (52) topics so they clear the 60-question floor and can carry words at
all. **Do not generate any of those words** — the owner has said the words must
be theirs or approved by them, and two earlier drafts of model-written hints
were deleted at their instruction.

### Words are content, not code (migration 063)

The rules live in code; the TEXT lives in the database and is edited from the
admin page, the same as the question bank's answers and alternates. A trickle of
two words a week must not need a deploy.

**The TARGET is stored, and that is not the same as storing the rules.**
`target_right` is frozen at the moment a word is saved. The rule ("a quarter of
this topic") stays in `title-tiers.js`; the number it produced on the day lives
in the row. That is the agreed design and not an optimisation — a share
recomputed live means adding questions to the bank moves everybody's goal
BACKWARDS, which is the worst thing a collection can do to the people filling
it. The admin panel prints today's share beside the frozen one when they differ,
so growth is visible and re-freezing is a deliberate act (saving the word again)
rather than something that happens behind the owner.

It also settles a real cost: recomputing shares in a player's browser needs a
count per topic — about fifty requests on every profile load — for a number that
is not allowed to change.

**A SLOT WITH NO WORD DOES NOT EXIST FOR PLAYERS.** That is what makes "nobody
ever sees a reward they cannot claim" true by construction rather than by care,
and it is why the table can be completely empty and nothing breaks.

**One loader, not three.** `loadTitleWords()` in `js/title-content.js` is the
only place that fetches and merges. The profile, the leaderboard and both unlock
paths (end of game, and sign-in) all call it. Three copies of "fetch and merge"
would be this project's most repeated fault in new clothes, with the failure
being a word that appears on one screen and not another. It carries its own
6-second deadline: a promise that never settles cannot be caught by `try/catch`,
and decorative content must never be able to hold a screen shut (slice 8d).

**`fetchTitleWords` returns `null` on failure and `[]` when nothing is written**,
and the two must not be conflated — the second is the ordinary state of a fresh
install, the first means we do not know, and treating them alike would empty
somebody's collection from the screen on one dropped request.

**THE COLUMN LIST ALREADY BIT ONCE.** The fetch named its columns and omitted
`target_right`, so `applyWordOverlay` skipped every row as having no target — no
error, nothing on screen, the owner's whole collection simply absent. Same shape
as the category leaderboard ranking on the wrong measure for weeks. It was
caught in seconds only because the fake store returns just the columns you ask
for; the probe now watches that column by name.

`applyWordOverlay` MUTATES the exported `TITLE_WORDS` deliberately: about a
dozen places import it synchronously, and turning all of them async to await a
fetch would be far larger a change than this earns.

### Placeholders — the owner reversed their own rule, and were right to

**"No placeholder words, ever" was the owner's rule and it is now off**, at
their request: *"there can be a placeholder right? Like 'epic science' … which I
can edit on the admin page later and easily know it is a placeholder?"*

The old rule's reasoning was sound and simply does not apply. It said a player
must never hit a requirement and receive NOTHING, so a slot with no word did not
exist for them. **A placeholder is not nothing** — "Epic Science" is a real word
really earned. What it buys is a visible framework: eleven of twelve subjects
were showing almost no slots at all, and the owner read that, reasonably, as the
framework being missing.

**THE UNLOCK SURVIVES THE RENAME, and that is what makes it safe.** A word's id
is `w:<category>:<subcategory>:<tier>` and contains no text, so editing "Epic
Science" into something better keeps it for everybody who already earned it.
`tests/titles.test.js` has pinned that since the overlay shipped.

**THE TEXT IS GENERATED BY RULE AND NEVER INVENTED** — `placeholderWord(tier,
label)` in `title-tiers.js`, tier plus subject. That distinction is the whole
reason this is allowed at all: the owner has twice had model-written title text
deleted, and scaffolding must read as scaffolding rather than as somebody's idea
of a good word. It caps at 24 characters (the table's own limit) and trims on a
word boundary, so a long topic cannot silently turn "fill every empty slot" into
"fill most of them".

**The flag is a real column (migration 064), not inferred from the text.** The
cheap alternative — call it a placeholder when the text matches what the
generator would produce — needs no column and un-flags itself on edit, which is
neat and is exactly the inference this project keeps getting burned by: change
the naming rule once and every existing placeholder silently becomes "written".

Filling is ONE button for all of them, because there are ~86 and a per-row
control would never be used. Typing over one clears the flag: it is the owner's
word now, and leaving it set would stop the count ever reaching zero. The admin
page reads **"N written, N placeholder, N empty"**, and players are never told
their title is temporary.

### The collection collapses by subject

Asked for by the owner after seeing the rows: *"under knowledge it could get
long, is there a better display format?"* It will — the collection is designed
for roughly a hundred words across twelve subjects.

Each subject is a header button now, one open at a time, all closed on arrival.
**THE COUNT ON THE CLOSED ROW IS WHAT MAKES IT WORK** — "2 / 9" visible without
opening anything — which is the same reasoning the admin page's panels are built
on: a page that hides everything behind identical doors is worse than a long one.

It also answers the owner's other complaint in the same move. Eleven of twelve
subjects hold a single word, so laid open they read as broken; closed, they are
twelve tidy rows and you open the one you want.

`scenario-account` requires twelve headers, none open on arrival, real rows after
a tap, and exactly one open after a second tap. Verified by removing the
close-the-others line: *"opening a second subject left 2 open"*.

### The framework is there for every subject — players only see written words

The owner asked twice whether the framework was actually being built or whether
only History had one. **Measured: all twelve subjects carry three subject-level
slots each (36 in total), plus 45 named topics, 26 of which clear the size
floor.** The rules in `title-tiers.js` are complete and the admin page lists
every slot, written or not.

What players see is only the slots with a WORD written, which is the deliberate
rule — a slot with no word does not exist for them, because hitting a
requirement and receiving nothing is a promise broken. So the collection looks
like History plus eleven near-empty subjects, and that is the collection, not a
display fault. **Do not "fix" it by rendering empty slots.** The fix is the ~86
words, and the admin page is where they go.

### The slot machine stays — I replaced it without being asked

**Reverted 2026-08-30, same day it shipped.** The owner asked about the "See all
titles" screen. I rebuilt the TITLE BUILDER as well — the three-column wheel —
into a "the title is the menu" picker, on my own initiative, off the back of
them asking *"Oh I guess that's the builder? Is that why I'm confused?"*, which
is a question and not an instruction.

**They liked the slot machine.** It is a deliberate aesthetic — the file has
said "Toontown-style 3-slot custom title builder" since the beginning — and it
is working code calibrated on a real device. CLAUDE.md's own rules cover this
exactly, twice over: *only change what was asked*, and *stop and ask before
making decisions not covered here*. I did neither.

Everything of mine is out: the markup, the renderer, the CSS, the mock and the
scenario check. `renderTitleWheel` and `updateTitlePreview` are byte-for-byte
what they were.

**The gallery rebuild STAYS**, because that one was asked for — the owner called
it clunky, uncompact and said only one title showed per category, and that is
what the rows fix.

**The design note under "The screen" above describes the picker I built and
reverted.** It was settled in a prototype session, so it is not wrong as a
design — but it is NOT a licence to replace the wheel. If it is ever built
again, that is the owner's call to make in words, not an inference from a
question they asked.

### The gallery was correct and it was not good

**Reported 2026-08-30, and the owner was right on every count:** clunky, not
compact, not aesthetically good, no visible framework, and *"only one title
under each category?"*

**That last one is TRUE and is not a display bug.** Counted from the code: slot
2 holds 20 words, and **History has 9 of them while every other subject has
exactly 1.** The deep layer — a word per topic at increasing depth — was only
ever written for History. The framework is real, in `title-tiers.js` and on the
admin page; there is simply almost nothing written into it yet. A screen can
only draw words that exist, so the emptiness IS the collection.

**The screen itself was genuinely bad, and that was mine.** It rendered a
~200px card per word, two across, with the tier spelled out as text inside every
one and the subject repeated in every requirement under a heading that already
named it — *"Get 82 questions right in Modern History"* beneath a heading
reading HISTORY, in a section blurbed "earned by getting questions right in a
subject". At roughly a hundred words that is a scroll nobody finishes, and the
padding hid the only thing worth seeing.

**It is rows now**, about a sixth the height, so a whole subject fits on screen
and the ladder is the picture. The tier is a colour on a left edge and the word
"Uncommon" is not repeated twenty times. `shortRequirement` trims the leading
verb and the subject the heading already states, and **always keeps the topic**,
which is the part that distinguishes one row from the next.

**The settled design said rows and I built cards.** "Slot 2 is rows, not a
honeycomb" is written above, from the prototype session, and the first
implementation ignored it. Re-read the agreed design before building, not after
the owner sees it.

**Dead `.title-card` CSS is still in the stylesheet.** Nothing renders it — the
grep is clean across `js/`, the mocks and the HTML — but the block interleaves
with rules that are still live and a first attempt at deleting it would have
taken 14KB of unrelated stylesheet with it. Its own assertion caught that. Left
deliberately; delete it precisely or not at all.

### A word appearing out of nowhere has to say what earned it

**Reported 2026-08-30: the owner opened the FRONT PAGE and was told they had
unlocked Science.** Their question was whether that is the right place for it.

**It is, and the surprise was not the placement.** The sign-in path
(`initAuth`) evaluates unlocks on arrival, deliberately — something earned while
away, like a loyalty streak crossing a day boundary, has nowhere else to appear.
And the rules had just changed underneath them: slot 2 moved from rank-based to
COUNT-based, so words genuinely became newly earned. **Every existing player
gets one retroactive batch on their next sign-in**, and `planCelebration` gives
one celebration per batch rather than one per word, so it is a single card and
not a queue.

**What was actually wrong is that the card said only the word.** That is the
complaint the owner has raised about this system more than any other — they
could not tell what any word was for — and `describeRequirement` had been built
for exactly it and wired only to the gallery. It bites hardest here, because the
sign-in path fires with no game behind it: a word arriving on the front page is
the least explicable moment in the app.

**Two things must NOT get a reason, and widening the line breaks both.** A
SECRET stays secret — `describeRequirement` returns null and spoiling it at the
moment it lands removes the point of it. An UPGRADE gets nothing either, because
that function states the LEVEL-1 condition and a level is a multiple of it, so a
Level 2 card would read "Win 10 games in a row" about something the player
passed a while ago. **Saying nothing beats saying something false**, and the
kicker already reads "Level 2". Verified by widening it: two checks fail by name.

`titleLabelFor` moved from `js/profile.js` into `categories.js` as `labelForKey`,
because the celebration needed the same rule and a third copy is this project's
signature fault. The failure would have been quiet — a raw key reads almost like
a label, so "10 right in arts-literature" looks like a wording choice rather than
a missing lookup.

**Both celebration mocks were fiction and the screenshot showed it.** One
rendered a reason line for Phantom, which is a secret and would never have one;
the other quoted "Win 15 games in a row" for a word whose real requirement is 10.
A mock that states things the code cannot produce reviews markup that never
ships.

### A new table arrives already granted to everybody

Migration 063's own verification came back FAIL on its third rule the first time
it was run live: *a visitor cannot write one* → **anyone could invent a title.**

**Supabase carries `ALTER DEFAULT PRIVILEGES` granting new tables in `public` to
`anon` and `authenticated`.** So the table was created with INSERT, UPDATE and
DELETE already granted to a signed-out visitor, and the migration's careful
`GRANT SELECT ON title_words TO anon` did nothing about it — **a GRANT adds and
never subtracts.** Only `REVOKE ALL ... FROM anon` removes what nobody asked
for.

**NOTHING WAS EVER OPEN, and that had to be measured rather than assumed.**
Against a real Postgres in exactly that state — the grant present, the policies
as written — an anonymous visitor and a signed-in non-admin were both refused
with 42501 and zero rows written. The policy was doing the work. Reporting this
as "anybody could write a title" would have been a false alarm about a live
game, and *"the privilege is there"* and *"anybody can use it"* are different
claims. The revoke ships anyway: a privilege nothing needs is one more thing
standing between a future policy mistake and a public table.

**This is slice 8c's blind spot in a new place.** That one was a policy
restricted to a ROLE; this is a privilege granted to a role by a project-wide
default. Both are facts written in SQL that no sweep of `js/` can see, and both
were found only because a verification block asked the question out loud.
**Every new table needs `REVOKE ALL FROM anon` before its grants**, and the
verification has to check the privilege rather than the policy — a policy that
looks right sits happily on top of a privilege that should not exist.

### The rarity ladder had four copies and three were stale

Found 2026-08-30 while fixing the tests for the above. The rebuild added
`uncommon`, `epic` and `mythic`; the celebration table, the gallery's sort and
the Title Builder's sort still listed the old three. **A missing key reads as
rank 0 rather than as an error**, so in the Builder a mythic word — the whole of
a subject, twelve in the game — sorted level with a common, and a mythic unlock
would have celebrated as a toast you can ignore.

One exported `RARITY_ORDER` in `titles.js` now, and all four readers take it
from there. **The test that should have caught it was asserting the bug**: it
used `'mythic'` as its example of "a rarity the table does not know", which was
true and should have been alarming. Two checks now pin every rarity a word uses
against both the ladder and the celebration table, so the next growth names the
reader left behind.

### The problem it fixes

A rank — Apprentice, Scholar, Master, Oracle — is
`(questions you get right / questions met) x log2(questions met)` against fixed
thresholds. **Measured, not estimated:** "Scholar in Ancient History" is anywhere
between 23 questions and 512 depending on accuracy.

| accuracy | Apprentice | Scholar | Master | Oracle |
|---|---|---|---|---|
| 100% | 20 | 23 | 46 | 91 |
| 80% | 20 | 50 | 118 | 280 |
| 60% | 32 | 182 | 575 | 1825 |
| 50% | 64 | 512 | 2048 | 8192 |

**No wording of that is honest**, which is why every attempt to label the Title
Builder read as vague. The owner said repeatedly they could not understand their
own system; the system was the problem, not the screen.

**And the blend punishes curiosity.** 46 right of 46 met is a Master. Meet ONE
new question, get it wrong — still 46 right — and you are demoted. Verified by
computation, not asserted.

### The rule

**One measure everywhere: questions you currently get right.** A count, never a
percentage. Proficiency unlocks nothing and stays a profile stat.

| | Requirement | Topic must hold |
|---|---|---|
| ⬜ common | 10 right in a subject | — |
| 🟩 uncommon | 25% of one topic | 60+ |
| 🟦 rare | 25% of EVERY topic in a subject, and 100+ right in it | — |
| 🟪 epic | 75% of one topic | 80+ |
| 🟨 legendary | 100% of one topic | 100+ |
| 🟥 mythic | 100% of an entire subject; plus secrets | — |

**RE-MEASURED 2026-08-30, AND THE FIRST NUMBERS WERE WRONG.** An earlier count
said 42 topics averaging 114, and it was taken two ways that both mislead:
grouped by `subcategory` alone, so a key shared by several categories summed
across all of them, and without the `format = 'open'` filter, so it counted
questions the game can never ask.

Counted the way the app actually asks — `fetchQuestionCount(category, sub)`,
which is `contains(categories, [cat])` AND `format = 'open'` — there are **48
legitimate (category, topic) pairs and 28 carry words of their own.** The spread
is far wider than either of us assumed:

| | askable |
|---|---|
| arts-literature / literature | 338 |
| pop-culture / entertainment-movies | 332 |
| history / modern | 327 |
| history / early-modern | 239 |
| …median around 80… | |
| history / ancient | **58** |
| history / medieval | **52** |
| nature / environment | 10 |
| sports / misc | 3 |

**History's own eras are mostly too small**, which matters because the four words
that already exist for Ancient and Medieval — Chronicles, Antiquity, Crusade,
Dynasty — have no qualifying topic. They are 2 and 8 questions short. The owner's
call was to leave the floors and grow those topics rather than lower the bar.

**The floors turn out to do a second job nobody designed:** they show where the
bank is thin. Sports/misc holding 3 askable questions is worth knowing whether or
not titles exist.

**MISC TOPICS CARRY NO WORDS**, on the owner's decision. Several qualify by size
— science/misc has 148 — but a word meaning "you have mastered Miscellaneous"
says nothing about what somebody knows, which is the whole job of that column.
Their questions still count towards their subject's words.

**I claimed twice that these floors "exclude almost nothing", inferring it from
the average. The owner pushed back — an average says nothing about how many clear
100 — and they were right.** 20/20/20/400 averages 115 and only one clears it.
Do not reason about a distribution from its mean; and when you do count, count
the way the app counts.

### Why each piece is the way it is

- **Counts, not proficiency.** Meeting a new question and failing it leaves a
  count untouched but drops a percentage, so a percentage-based title is taken
  away for exploring.
- **Proficiency is forced anyway at the top, without being a rule.** A topic is
  finite, so getting 75% of it right means being right about at least 75% of it;
  100% is perfect accuracy by definition. This is why no second condition is
  needed, and why adding one buys nothing.
- **Once earned, kept forever.** Otherwise a legendary evaporates when you forget
  one question.
- **Targets are frozen** — computed once from the topic's size and stored as a
  number. A percentage recomputed live means adding questions moves somebody's
  goal backwards, which is the worst feeling in a collection.
- **Fixed floors, not positional ones.** "The largest quarter of topics" was my
  proposal and it is wrong: it shifts as the bank grows, so a topic could lose
  its gold word because OTHER topics grew — breaking the freeze rule above.
- **Rare needs its 100-right floor** or a subject with two small topics gives a
  rare for 20 right, ranking it below uncommon and breaking the ladder.
- **Six tiers is right at ~106 words**, though it would be silly at 37. I argued
  against it from the wrong number.

### What must be built alongside it

- **The admin page must list every topic, its size, which tiers it qualifies for,
  and which have no word written.** Targets are frozen, so nothing tells you when
  a growing bank makes a topic newly eligible. Without this the collection
  silently stops growing.
- **No placeholder words, ever.** A player must never see a slot they cannot
  fill: hitting a requirement and receiving nothing is a promise broken. A topic
  with no word written simply offers none. The gaps are the owner's view, not the
  player's.
- **The words are the owner's to write.** All 34 existing hints were
  model-written and are being dropped; the owner has said the words themselves
  must be theirs or approved by them. **Do not generate them.**

### What is built as of 2026-08-30

The RULES and the SCREENS are in; the WORDS are not, and that is the owner's
half. Do not generate them.

| | |
|---|---|
| `js/title-tiers.js` | the floors, shares and subject rules, no imports, 18 unit tests |
| `unlock: { type: 'count' }` | a word is earned at N questions right in a subject or topic |
| `rightIn()` in `titles.js` | the one reader, and it takes the ROLLUP for a subject so nothing is counted twice |
| `describeRequirement()` | turns any unlock into a sentence a player can act on |
| admin → Title Words | every topic, its size, which tiers it offers, its target, and what is unwritten |
| the probe | prints the same table on every CI run, so a growing bank cannot silently make a topic newly eligible without anybody noticing |

**All 20 Knowledge words are converted to counts**, with targets frozen from the
sizes measured on 2026-08-30. The four for Ancient and Medieval History were
converted even though those topics are under the 60 floor: those words ALREADY
EXIST, and leaving them on a rank rule nobody can read is worse than a target
that is slightly cheap. **The floor governs which topics get NEW words**, not
whether an existing one is earnable.

**Still to do:** the remaining ~86 words, and Ancient and Medieval need about a
dozen questions each before they properly clear the floor.

### The screen

Settled by prototype rather than argument, after two failed attempts — a static
mockup the owner could not read, and a honeycomb that hid the words behind a tap.

- **The title is the menu.** Three words at the top; tap one to change that part.
- **An earned word says what you did** ("earned at 28 right in Ancient History").
  A locked one says what to do ("you get 19 right, 9 more to go") and **hides the
  word itself**. Only secrets stay mysterious.
- **Slot 2 is rows, not a honeycomb.** A hexagon holds an emoji and a number; it
  cannot hold a WORD, so the one column actually about words was the only one
  unreadable without tapping. The Map keeps the honeycomb — showing question
  progress at a glance is genuinely its job.
- **Slot 3 splits** into "how far you have come" and "things you pulled off",
  because four of its eight words are the rank ladder showing through.

## The title system is 37 words, and one of them did not exist

Counted 2026-08-29, from the code, because the owner asked what the system
actually contains and could not tell from any screen — which is itself the
finding. **Nothing in the app states the structure**, so the person who designed
it could not remember it.

| Slot | Shown as | Words | What it is |
|---|---|---|---|
| 1 | The Adjective | 10 | how you play — wins, streaks, loyalty, hosting, 2 secrets |
| 2 | The Calling | 19 | what you know |
| 3 | The Rank | 8 | 4 echoes of the profile ladder, 4 unrelated feats |

**Slot 2 has two layers and only the first is finished.** Twelve words, one per
category, earned at Apprentice — complete. Then a DEEP layer: a Scholar word and
an Oracle word for each SUBCATEGORY (ancient history at Scholar is Chronicles, at
Oracle it is Antiquity). **That layer exists for History and for nothing else.**
Seven words where the pattern implies 84, across 42 subcategories.

So "is it complete?" has a number: **37 of roughly 114**, and the missing part is
exactly the part the owner described wanting — *if they are good at science, the
title is science-related*. It was started once, for one category.

**A LEGENDARY WORD DID NOT EXIST AT ALL.** `eternal` was defined twice in
`TITLE_WORDS` — slot 2 (Oracle in modern history) and slot 3 (Oracle in three
categories). It is a plain object literal, so **the second silently replaced the
first**: no error, no warning, one fewer card in the gallery than the file
describes, and the top reward for a whole branch unearnable by anybody. Every
other era has both its Scholar and its Oracle word; modern had Atomic and then
nothing, which is only visible once they are lined up.

The key is `eternalModern` now and the word is unchanged — restoring the author's
intent rather than inventing a rename. **It does mean a title could read
"Eternal Eternal", which is the owner's call, not a decision to make quietly
inside a bug fix.**

**The check has to read the SOURCE.** By the time the module is imported the
duplicate is gone — the object holds one entry and looks perfectly healthy — so
nothing asserted against `TITLE_WORDS` could ever see it, which is why this
survived. `tests/titles.test.js` parses the file, and carries a guard on itself:
if the pattern stops matching it would pass over an empty list and report a clean
bill of health. Verified by restoring the duplicate — three checks fail, the
self-guard among them.

**Two overloaded names, both raised by the owner and neither settled:**
"The Calling" for a column that is really "what you know" (their instinct was
Style / Mastery), and **"Rank"**, which is both a word in slot 3 and the
Apprentice→Oracle ladder on the profile, measured per category. Those are the
same four words meaning two different things on two different screens.

## The forty titles nobody could see

The Title Builder was a padlock reading "Reach Apprentice to unlock", and that
was the entire surface of a 40-word collection. It named a rank the player had
no way to locate and no way to price, and said nothing about what was behind
it. The owner asked for something browsable that "conveys and piques interest".

**Every word already carried a `hint`**, written long ago and rendered nowhere
except a three-second toast inside the builder — which only opens once you are
already in. Three words have `hint: null` deliberately; those are secrets, and
the gallery says "secret" rather than leaving a blank that reads as a bug.

The collection opens from the padlock itself, so the moment somebody wonders
what is behind it they find out, and stays reachable from the builder
afterwards. **Locked cards show the hint and the rarity, not the word** — the
owner's call, and what the hints were plainly written for.

Cards are two across at 375px: one column reads as homework, three squeezes a
hint to two words a line. Rarity is a coloured LEFT EDGE, never a fill — a
tinted card would put every label on a background the three themes disagree
about, which is how the tier badges broke.

**The padlock also says which category is closest and by how much**, from
`tierProgress`. "Reach Apprentice" alone is true and useless.

**Known and deliberate:** in Slot 2, twelve of the twenty words are the
category names, so hiding those behind a riddle is thin — the player can see
their own categories on the same page. The eight era words (Antiquity, Dynasty,
Atomic…) are worth hiding. Raised with the owner; not changed without them.

## Earning something was a console.debug line

`RARITY_CELEBRATION` was written, exported, and wired to nothing. The unlock
path ended:

```js
// (Phase 4 will add celebration display here)
if (newUnlocks.length > 0) logger.debug('Titles', 'New unlocks', ...)
```

So every reward in this game was invisible at the exact moment it was earned.
The gallery makes the collection browsable; this is what makes filling it feel
like anything.

**The table had no `epic` key**, though three words carry that rarity, so those
lookups returned `undefined`. Nobody noticed because nothing read the table.

`planCelebration` gives **one** celebration per batch, not one per word.
Reaching Apprentice in a category can trip several commons at once, and six
overlays in a row is a queue to dismiss rather than a reward. The rarest word
leads, ties go to a brand-new word over an upgrade of one already held, and the
rest are counted. Tier scales to rarity at the owner's instruction: common is a
quiet card that ignores taps, legendary dims the screen for a beat.

**Everything self-clears.** This fires between rounds, and a reward that must
be dismissed before play continues stops being a reward on the second
occurrence. The quiet tiers set `pointer-events: none` — they cover the whole
viewport for three seconds, so without it a scoreboard button underneath would
be dead for that whole time.

**The scrim is a dark rgba, not a theme colour.** `--color-bg-deep` is nearly
white on the light theme, so dimming with it dimmed nothing and the card looked
like it was floating over a working screen. The card carries its own
background, so its contrast is unaffected by what is behind it.

It fires from two places: the end of a game, and sign-in — a loyalty streak
crossing a day boundary earns something with nobody playing, and that would
otherwise never be seen.

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

## How hard was that? Stored now, measured later

`#reveal-difficulty` had been in `game.html` since the beginning and the code
only ever **hid** it. The slot existed and was never once filled.

The owner asked for a difficulty band on the reveal and immediately asked the
right question back: doesn't that need a minimum sample? It does. The last
probe read `game_plays` at **9 rows** — there is essentially no play data, and
a percentage from two plays is noise wearing a number's clothes.

So `describeDifficulty` in `js/difficulty-band.js` has two sources and the
switch between them is the whole design:

- **Under `MIN_PLAYS_FOR_MEASURED_DIFFICULTY` (3)** — the question's stored
  `difficulty`, which all 4,859 carry from the original import. Honest from the
  first game, no migration, nothing to wait for.
- **At or above it** — what actually happened, in four bands (Easy ≥75%,
  Medium ≥50%, Hard ≥25%, Very Hard below), **with the sample attached**:
  "18% get this right, from 124 plays". `12%` and `12% of 20 plays` are
  different claims and must never look alike.

**It was 20, and that was wrong.** The argument for it — a high threshold
"costs nothing", because the stored value covers everything underneath —
concealed the real cost: at 20 the measured half would not appear for anybody
for months, so it could not be seen, judged, or tested by the person who has to
decide whether it is any good. **A feature nobody can reach is not cautious, it
is undeliverable**, and the owner said so. Three is the lowest number where a
percentage is not simply binary, and it is reachable in about two games.

What makes three safe is that **the sample is always printed beside the
number**. "100% get this right, from 3 plays" is self-evidently thin to
anybody reading it; "100%" alone would not be. Raise it once real games have
been played and the only thing that changes is that the bands get steadier.

**Counted over every play, repeats included.** The owner's call, and it is
already what `question_stats` records, so the measure and the store agree
without anything being reinterpreted.

Read from **`question_health`, not `question_stats`**. The table is locked to
visitors deliberately (#2) so a player cannot forge question performance; the
view over it is readable, which is what makes this possible from a player's
browser at all. A failed read falls back to the stored band — nobody loses a
reveal because a stat did not load.

**Colour only when measured.** An unmeasured band is the value the question
shipped with, and painting that as evidence would be the same overclaim as
printing a percentage from two plays.

**Still parked, deliberately:** "what everyone typed" from `answer_tally`. It
needs volume the game does not have, and the owner said so first. The data
accrues either way, so it can be switched on the day it is worth reading.

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
node tests/harness/scenario-join.mjs      # public listing, host reputation, privacy, hot join
node tests/harness/scenario-feedback.mjs  # votes, flags, host review, timer-expiry scoring
node tests/harness/scenario-cohost.mjs    # promote, demote, gated controls
node tests/harness/scenario-account.mjs  # profile, friends leaderboard, friends, signed-in lobby
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

**It also cannot catch a rule that is stated twice and fixed once.** Every fault
found on 2026-08-25 — the two half-rules in `countAnswersFrom` / `submittedCount`,
`computeCategoryTiers` never getting `mergedCategoryRows`, two more
read-then-writes still on `.maybeSingle()` — was found by READING for the shape,
not by anything failing. All twelve scenarios passed before and after, and would
have gone on passing. The unit tests they now carry each fail when reverted, but
only because somebody went looking first.

**So after any fix that introduces a shared helper, grep for every OTHER reader
of what it replaced.** That single habit would have caught four separate live
bugs in this file: the seat ratchet's third copy, the writes Slice 6 shut,
`computeCategoryTiers`, and the answer count.

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

**A SESSION SURVIVES A RELOAD IN THE HARNESS, and until 2026-08-28 it did
not.** `window.__fakeSession` was a plain window variable, destroyed on
navigation, while the real supabase-js persists its session in localStorage by
default. So every page load minted a BRAND NEW anonymous identity — the #10 gap
in its most dangerous direction, the harness behaving differently from the live
client with no scenario able to see it. It matters since invisible accounts: a
guest's id is what `claimSeat` matches on, so an id that changed on every
refresh meant the robots were silently exercising "different person, same name"
— the case the guest heuristic exists for — instead of the ordinary refresh it
looked like.

**Found while chasing a flaky `page.reload` timeout — and TWO mitigations later
that flake is still unexplained.** `scenario-join` times out at 30s on one of
its two reloads, roughly one run in five under load and three times in CI. The
session-persistence fix above and `waitUntil: 'domcontentloaded'` were each
plausible and each shipped; **the next CI run after both failed in exactly the
same place.** So neither was the cause, and the hypotheses were wrong.

What is established: it does not reproduce here — six consecutive runs alone,
plus a full replay of CI's sequence (lobby, fullgame, nasty, playagain, social,
then join) — and CI is a 2-core runner running twelve browser scenarios back to
back. Contention is the leading explanation and remains UNPROVEN.

So the scenario stopped guessing and started reporting. `reloadAndReport` retries
ONCE with a longer timeout and prints which happened: *"retry succeeded — the
page was slow, not stuck"* is the evidence that it is contention, and a page that
is genuinely stuck still fails both attempts and dumps its URL, ready state,
active screen and console errors. **A retry that announces itself is a
measurement; a silent one is a bug being hidden.** Verified by forcing the first
attempt to fail with a 1ms timeout.

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

**THE FAKE STORE NOW RETURNS ONLY THE COLUMNS YOU ASKED FOR**, and until
2026-08-25 it did not — the shim threw the column list away and handed back
whole rows. So a query that FORGOT a column behaved exactly like one that did
not, and that is not a small difference in this codebase: `rowProficiency` and
`bucketQuestionsByHistory` both FALL BACK to older columns when the newer ones
are absent, and absent is precisely what a short `select` produces live.

It had already shipped a bug. `fetchCategoryLeaderboard` named a column list
that omitted `questions_met` and `questions_mastered`, so the fallback fired on
every row and the category boards ranked by the lifetime hit rate migration 040
set out to replace — a question missed once and since learned counted against
you forever. The row label said "N Qs met" while showing attempts. It disagreed
with the profile and the global board, and nothing could say so, because falling
back is not an error. It selects `*` now: naming the new columns explicitly
would be better documentation and worse code, because if 040 were ever unapplied
PostgREST answers 42703 and the whole board goes blank instead of degrading.

`scenario-account` seeds `questions_met` / `questions_mastered` that DISAGREE
with the attempt counters (Alice: 96/120 attempts, 30/60 questions) — without
that the two readings are identical and any check on which measure a page uses
passes whatever it does. Verified by restoring the old column list: it reports
"ranking by the lifetime hit rate (80%), not Proficiency (50%)".

Only a plain comma list is honoured; `*`, embedded resources and aliases return
whole rows rather than being guessed at, because a projection that is wrong in
the other direction hides bugs just as well.

**Then the same pattern was hunted everywhere else, and found once more.**
`fetchPublicRooms` omitted `subcategory`, and `join.js` renders each row with
`resolveCategoryLabel(room.category, room.subcategory)` — so every public game
advertised itself by CATEGORY alone. A room hosting Ancient History appeared as
plain "History", and somebody browsing the list could not see what they were
about to join. `scenario-join` now hosts its public room on a real subcategory,
which is the only way the label can be exercised at all; hosting on "All" could
never have shown it. Verified by dropping the column again.

The other narrow selects were traced to their consumers and are sound: the
admin's online drill uses only the two columns it asks for, and every
`rowProficiency` caller is fed by `select('*')`. (The global board's deliberate
`correct_answers` was in this list until 2026-08-26; that board is gone and the
column list with it.)

**And the same hunt found the same thing again on 2026-08-26**, in the OTHER
direction: `fetchPublicRooms` selected only `room_id` from `players` when
counting them, so when the join list started showing the host's reputation there
was no host id to look one up with. The column list is part of what a screen can
SAY, not merely part of what a query costs. **A query is only as
right as what its one consumer reads** — check the consumer, not the query.

**`store.denyWrites(table)` simulates an RLS refusal** — zero rows, no error,
exactly as Postgres behaves when a policy denies a write. This is the most
misleading thing the database does and the direct cause of #4 and #5, so it is
now testable rather than only describable. `scenario-admin.mjs` uses it to prove
the admin page says "Not saved — permission denied" instead of "Saved!";
removing the zero-row check makes that test report the silent-failure bug by
name. Use it on any new write path whose failure the player must notice.

**An RPC the fake store does not implement answers `null` with no error**,
which is exactly what an installed function returning nothing looks like. So
`fetchMasteryCounts` never took its fallback, the mastery tree and the Map were
empty in every scenario, and nothing was wrong with either. `get_mastery_counts`
is implemented in `store.js` now — one row per (category, subcategory), no
rollups, because `profile.js` adds each row to BOTH its category total and its
subcategory and a rollup row would double every category. **Before concluding a
profile feature is broken in the harness, check whether the RPC behind it is in
`_rpc`.**

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

`scripts/check-arity.mjs` fails when a project function is CALLED with fewer
arguments than it requires. JavaScript does not complain — the missing one is
simply `undefined` — and that shipped once already: `amendQuestionHistory`
gained a required `roomId` when migration 041 moved it behind a SECURITY
DEFINER function, and a call site that forgot it silently stopped correcting
anybody's history. Nothing else could see it: the unit tests never touch that
module, and module-integrity only checks that a called name is IMPORTED.

**It reads nothing it cannot read with certainty**, and prints how many calls it
skipped for that reason (currently 144 of 571). Only exported `function`
declarations with bracket-free parameter lists, only bare `name(` calls, only
argument lists with no nested brackets, arrow functions or ternaries — and names
a file declares locally are excluded, because `question.js` wraps
`getServerTimeLeft` under an alias and every call to the wrapper otherwise reads
as passing nothing.

Two rounds of false positives were fixed before it was trusted: blanking string
literals made `f('a')` read as `f()` (six findings), and local shadowing made
the wrapper above read as two more. **Verified by reintroducing the original
bug** — dropping `state.room.id` from the `amendQuestionHistory` call in
`reveal.js` — which it names by file, line and signature.

`scripts/check-rpc-args.mjs` compares every `.rpc('name', { ... })` against the
parameter names the migrations declare. **PostgREST resolves a function by its
ARGUMENT NAMES**, so one typo answers HTTP 404 — indistinguishable from a
function that was never created — and `functionMissing()` reads that as absent
and silently takes the fallback. #6 records the probe learning this the hard
way; this says it before a deploy rather than after. It skips anything it cannot
read and prints the count. Verified both ways: misnaming `p_answer_id` and
omitting a defaultless parameter are each reported by file, line and signature.

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
back to the shared `.feedback-btn` look), the seven `.admin-q-edit__*` classes
are JS query hooks on elements already styled by `.input` and `.btn`, and
`watermark-all` is excluded
— it is a glyph-calibration state whose cards differ by design.

**`overflow-x: hidden` IS A SEATBELT, NOT A FIX, and this script accepted it as
one.** The profile page shipped 571px wide inside a 375px phone — text cut off
on both sides, nothing to scroll to — and the sweep called it clean twice. A
real phone found it.

Two faults stacked:

- The suppression treated **any** ancestor with `overflow-x` of `hidden`,
  `clip`, `auto` or `scroll` as making overflow acceptable. A container with
  `overflow-y: auto` computes `overflow-x: auto` per CSS, so **every
  `screen--scrollable` page in the app was exempt from overflow reporting
  entirely.** Only `hidden` and `clip` suppress now: being able to drag the
  page sideways is the exact fault this script was written for, so a scrollable
  ancestor is not an excuse.
- Even then, clipping is only a reasonable backstop for something NARROWER
  than the viewport that hangs over an edge — a decorative glyph. Anything
  **wider than the viewport** cannot be read in full at any scroll position, so
  it is now reported whether clipped or not.

The cause was mine and worth knowing: `grid-template-columns: repeat(2, 1fr)`.
`1fr` is `minmax(auto, 1fr)`, so a column cannot shrink below its content's
min-content width — and a `white-space: nowrap` rank line forced each column to
~250px and the whole profile column past the phone. **Every fixed-count grid in
the stylesheet is `minmax(0, 1fr)` now**, which is the structural fix; use that
form for any new one.

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

It happened again on 2026-08-21. The first mock of the admin flagged queue
(`admin-panels`) found `.admin-flag-row__answer` and `.admin-flag-row__reasons`
with no rule at all — three items in a non-wrapping flex row, one of which is
every distinct reason anybody gave, comma-joined. It fitted the two short
strings a mock would have used and nothing longer. **The section had shipped
months earlier.**

**And a third time on 2026-08-25: `leaderboard.html` had no mock either.** (Its
two mocks were replaced on 2026-08-26 when the board became friends-only —
`leaderboard-mastered` and `leaderboard-proficiency`, because the two measures
render different stats in the same slots.) Two
were added (`leaderboard-global`, `leaderboard-category`) and the first sweep
reported the first-place rank at **2.22:1 on the light theme** — the number "1"
in medal gold `#d4a017`, effectively invisible against `#F8F7F4`. It measured
7.18 on dark and 8.84 on OLED, which is why nobody looking at a phone at night
would ever have seen it.

The three medal colours are CSS variables now, with light values chosen by
measurement (`#8a6508` / `#6b6b6b` / `#8a5a33`, at 4.97 / 4.97 / 5.46) and the
originals kept under `[data-theme="dark"]` and `[data-theme="oled"]`. **Same
lesson as the tier badges: a colour cannot answer to three palettes from one
value.** The page has been live since the leaderboard existed.

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
