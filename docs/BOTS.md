# Bots — design, agreed 2026-08-19

Not built yet. This is the plan, written down so it can be argued with before
any code exists.

---

## What a bot is

A hand-written character defined in a file, not a generated one. Each has:

| | |
|---|---|
| **Name and look** | Fixed name, avatar emoji and colour, so they are recognisable game to game |
| **Category skills** | A percentage per category — History 90%, Science 45%, Pop Culture 15% |
| **Speed** | How long they take to answer, with variation so it never looks mechanical |
| **Wager habit** | Reckless (spends the big numbers early), cautious (hoards them), or erratic |
| **Typing style** | Clean, all-lowercase, or prone to a typo |
| **Voice** | A handful of written chat lines for getting one right, getting one wrong, and losing |

Nothing here is generated at runtime. A bot is a table of numbers and a list of
sentences somebody wrote.

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

For the remaining 20%, the bot borrows another question's correct answer from
the same category. That is still real text, and confusing two things from the
same subject is exactly the mistake a person makes.

## How likely a bot is to be right

**Category skill, then adjusted by the question's difficulty.**

A bot with History 90% does not get nine in ten History questions right
regardless — an easy one nudges the odds up, a hard one drags them down. The
stored easy/medium/hard rating on each question does the adjusting.

This costs a little predictability: you cannot say exactly how strong a bot is
without watching it play. In exchange, hard questions feel hard even for the
good bots, and a bot's bad category is properly humbling rather than just
statistically worse.

The exact weighting is a number to tune once it can be felt in play.

## Rules that are not up for negotiation

These come from the owner and are load-bearing:

- **A bot is never host or co-host.** Those roles are for people.
- **Only a human adds or removes a bot.** No bot may invite another.
- **No bot-only rooms.** A game always has at least one person in it.
- **Bots are obvious.** Distinct look and a marker beside the name, everywhere
  they appear. Nobody should ever be unsure whether they just lost to a person.

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

## Still open

- How many bots ship at first, and who they are. Six or so, spread across
  skill levels, feels right.
- Whether a bot should ever use the chat unprompted, or only react.
- Whether bots get titles and tiers, or whether those stay human.
- Whether a bot can be added mid-game or only in the lobby.

## Rough build order

1. The bot definitions — names, skills, habits, lines. No behaviour yet.
2. Adding and removing them in the lobby, with the host-only rules enforced.
3. Answering: skill × difficulty, distractor lookup, timing, typing style.
4. Wagering by habit.
5. Chat lines.
6. Leaderboard yardstick band.

Each step is playable before the next one starts.
