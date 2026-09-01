# Bots — design, agreed 2026-08-19

Most of this is still the plan. **One slice of it is built** — see immediately
below — and the rest is written down so it can be argued with before any more
code exists.

---

## What is actually built (2026-08-19)

**One bot. No character. A coin flip.** The owner asked for the plumbing first
and the personality afterwards, so this slice deliberately contains no invented
numbers at all.

| | |
|---|---|
| **Who** | A single "Practice Bot", grey robot avatar. Not a character, and not meant to become one — the cast replaces it |
| **How many** | One per room (`MAX_BOTS_PER_ROOM`) |
| **Accuracy** | `BOT_ACCURACY = 0.5`, flat, every category, every difficulty. A coin flip is the one number that needs no justification |
| **Speed** | Instant. It answers the moment the question goes live |
| **Wrong answers** | One of the question's own stored `incorrect_answers`. **Blank** if the question has none — the owner chose blank over borrowing another question's answer, so nothing is ever invented |
| **Wager** | Random among the values it has not spent. It has no read on the questions, so any rule would be a strategy it does not have |
| **Final wager** | Always 20, on the owner's instruction. It was 10 — the middle option, on the reasoning that a bot with one flat accuracy has no read on the question or the standings and so should not pick an extreme. The owner's call overrides that: a permanent middle stake makes the last round of a practice game never swing, and swinging is the point of it. `BOT_FINAL_WAGER` in constants.js is the source of truth |
| **Recorded** | Nothing. Not `question_stats`, not `answer_tally`, and not counted in the human's placement or player count in `game_history` |
| **Leaderboard** | Not there at all yet. The yardstick band below is unbuilt |

Where it lives: `js/game/bots.js` (the database side, host only) and
`js/game/bot-logic.js` (the decisions, pure and unit tested — bots.js reaches
Supabase, which the test runner cannot load).

The four host-only rules are enforced where they have to be, not where they
read best:

- **Added and removed only by the host, only in the lobby** —
  `renderAddBotButton` / `handleAddBot` / `handleRemoveBot` in `js/lobby.js`.
- **Never host or co-host** — `determineNextHost` excludes bots, the lobby's
  own promotion path excludes them, and the Make Host / Co-Host buttons are not
  rendered on a bot's row at all.
- **Never swept, never shown as away** — a bot sends no heartbeat and joins no
  presence channel, so both checks in `js/lobby.js` and `js/game/` skip it. Left
  in, the sweep removes the bot partway through the game it was added for.
- **A bot does not hold a room open** — `humanPlayers()` in `js/lobby.js` is
  what "is anybody still here" means, so the last person out still takes the
  room with them.

`tests/harness/scenario-bots.mjs` plays a full solo game and checks every one
of those, including that the bot spent each wager exactly once and that nothing
it typed reached either data table. The "never recorded" check was verified by
breaking it: moving the bot guard one line later makes `question_stats` read
`asked=2` and the scenario names the failure.

Everything below this line is still design.

---

## What a bot is

A hand-written character defined in a file, not a generated one. Each has:

| | |
|---|---|
| **Name and look** | Fixed name, avatar emoji and colour, so they are recognisable game to game |
| **Category skills** | A percentage per category. **Numbers not yet chosen — see below** |
| **Speed** | How long they take to answer, with variation so it never looks mechanical |
| **Wager habit** | Reckless (spends the big numbers early), cautious (hoards them), or erratic |
| **Typing style** | Clean, all-lowercase, or prone to a typo |
| **Voice** | An occasional honk. No chat in the first version — see below |

Nothing here is generated at runtime. A bot is a table of numbers somebody
chose, and its answers come out of the question bank.

## Where the wrong answers come from

**They already exist.** Every question was imported carrying its original
multiple-choice distractors, and when the game moved to typed answers nothing
read that column again. It is still there, untouched.

Measured against the live database on 2026-08-19: **801 of 1,000 questions
(80%) carry stored wrong answers, three each on average.** For the black-hole
question they are "Messier 87", "Alpha Centauri", "Andromeda".

So a bot that gets a question wrong gives a real, human-written wrong answer
for *that specific question*. Nothing is invented, and nothing can hallucinate
— which is the whole reason the question bank is worth something.

For the remaining 20%, an earlier draft had the bot borrow another question's
correct answer from the same category. **The owner chose blank instead**, and
that is what is built: a question with no stored wrong answers gets an empty
submission, which the reveal already renders as "No answer". Borrowing produces
text that was never a wrong answer to *this* question, and the whole point of
using the stored distractors is that nobody made them up. Blank is honest —
the bot did not know it.

The gap closes on its own. `answer_tally` (migration 029) records what real
people type, so the questions with no stored distractors accumulate real wrong
answers just by being played.

## How likely a bot is to be right

**Category skill only, for now.**

An earlier draft of this document had skill adjusted by each question's
difficulty, using fixed amounts (+12 for an easy question, -15 for a hard one).
**Those numbers were invented with no basis and have been removed.** They were
a guess dressed up as a design, and a guess in place of a number that can
actually be measured is the worst kind.

The adjustment itself is a sound idea — a hard question SHOULD trouble even a
strong bot. But the size of it has to come from somewhere real. Once questions
have been played, one is answered correctly 31% of the time and another 78%,
and the gap between them is measured rather than imagined. That is the only
honest source for it.

So: no difficulty adjustment until there is data to derive one from.

### The category skills have to be chosen by a person

There is no data that can tell you how good a fictional character should be at
History. It is a design decision, not a measurement, and it belongs to whoever
is designing the characters.

An earlier draft of this file proposed six bots with full skill tables. Those
numbers were invented too, and are gone. What each bot knows and does not know
is still to be decided.

## Rules that are not up for negotiation

These come from the owner and are load-bearing:

- **A bot is never host or co-host.** Those roles are for people.
- **Only a human adds or removes a bot.** No bot may invite another.
- **No bot-only rooms.** A game always has at least one person in it.
- **Bots are obvious.** Distinct look and a marker beside the name, everywhere
  they appear. Nobody should ever be unsure whether they just lost to a person.
- **Nothing a bot does is ever recorded.** Not to `question_stats`, not to
  `question_history`, not to anyone's stats. A bot's answers are decided by a
  percentage somebody typed, so counting them would mean a question's measured
  difficulty is partly made of that invented number — corrupting the one
  source of real data this design depends on.

## The leaderboard

Bots appear as a **yardstick, set apart from the human rankings**, with their
skill stated: "Professor Wick — History 90%".

The reason for not mixing them in: a bot's accuracy is a number somebody typed,
not something it achieved. Drop Wick into the rankings and he sits at exactly
his design figure forever, above most real people, and beating a human stops
meaning anything. Shown separately, the same number becomes useful — you can
see you are ahead of the Scholar-level bots but not the Oracle-level one.

## Where bots actually run

**In the host's browser.** There is no server, so something has to drive them,
and the host's phone is the only candidate — it is already the referee for
judging, scoring and timing (see CLAUDE.md #1).

Consequences to accept going in:

- If the host's phone sleeps or drops out, the bots freeze with it. Same
  fragility everything else has, no worse and no better.
- Bots must be excluded from the stale-player sweep, or the host will
  "disconnect" its own bots for never sending a heartbeat.
- Bots must not be counted when deciding whether everyone has answered, except
  as themselves — a bot that has answered counts, one still "thinking" holds
  the round exactly like a person would.
- When scoring moves to the server, bots move with it. Building them now means
  some rework later; it does not mean building the wrong thing.

## Solo play comes free

A bot is a player in a room. One person plus three bots is a normal game with a
normal room code — no separate mode, no new machinery.

This is worth more than it looks: today the game cannot be tested at all
without finding a second human, which has blocked every playtest. Bots end
that.

## The wheel malfunction

The owner's idea, and the best thing to come out of designing this.

The final-wager difficulty vote already lets the wheel land on a level nobody
picked — the vote is a floor, and unvoted harder levels keep a small weight.
This pushes the same joke one step further.

When **Hard** wins the vote, there is a small chance (roughly one game in
eight) that the wheel settles on Hard, then visibly *stutters* and drops one
notch further to **VERY HARD** — its own colour, its own sound, and a line
making clear the wheel did that on purpose. It must never read as a bug: the
glitch is choreographed, and the reveal says so.

This only becomes possible once difficulty is measured, because "very hard"
has to mean something real — the bottom band by actual correct-rate, not a
fourth label invented for the occasion.

The vote itself stays at **three** options. It is a fast group choice on a
dramatic screen; five would turn a moment of tension into a menu. How
questions are classified internally and how many buttons a player sees are
separate decisions and do not have to match.

## Chat: deliberately not in the first version

The obvious version — a few written lines per bot for winning, losing and
getting one wrong — fails on repetition. Six lines are all seen within two
games, and at that point they read as cheap. A bot repeating itself is worse
than a bot saying nothing.

**Bots honk instead.** It is already in the game, needs nothing written, and a
bot that honks when it nails a hard one has more character than one typing
"Nice!". How readily each bot honks, and at what, is part of its character and
is still to be decided — an earlier draft put invented probabilities here and
they have been removed.

One trigger worth keeping from that draft, because it is a design idea rather
than a number: a bot honking when a **human** gets a hard question right reads
as applause. A bot that honks mainly at its own successes reads as smug.

Written lines come after the first play session, driven by what is actually
missing rather than what seems likely to be.

## Adding bots: lobby only

Decided. A bot joins before the game starts, like any player.

The reason is the wager rule: values 1..N are each spent exactly once, so a bot
arriving at question 6 has no sensible history of what it already spent.
Rescuing an abandoned game by handing a bot someone's vacated seat — inheriting
their spent wagers — is a coherent idea, but it is a separate feature and not
part of this.

## Still open

Everything about the characters themselves:

- Who the bots are, how many, and what each is good and bad at. **No numbers
  should be invented here.** Either the owner sets them, or he asks for a
  proposal knowing it is a proposal.
- How readily each honks, and at what.
- How fast each answers.
- How the difficulty adjustment is sized — after there is play data, not before.

Decided already: bots show **BOT** where a player shows their tier, and what
they are good at where a player shows their title.

## Rough build order

Reordered once it was clear the plumbing could be finished before a single
character existed. Building the machinery first means the cast can be argued
about while the thing already works.

1. ~~Adding and removing them in the lobby, with the host-only rules
   enforced.~~ **Done.**
2. ~~Answering at all: one flat accuracy, distractor lookup, instant.~~
   **Done.**
3. The bot definitions — names, per-category skills, habits. **Not started,
   and no numbers to be invented for it.**
4. Speed and typing style, so a bot does not read as a machine.
5. Wagering by habit.
6. Honks.
7. Leaderboard yardstick band.
8. Difficulty adjustment — only once there is play data to size it from.

Each step is playable before the next one starts.
