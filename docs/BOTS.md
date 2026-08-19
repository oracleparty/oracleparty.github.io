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

**The difficulty labels are real and varied.** Measured on 2026-08-19 across a
1,000-question sample: **medium 523, hard 257, easy 220**. Worth checking
before building on them — a column reading 'medium' for everything would have
collapsed skill-times-difficulty quietly back into plain skill.

### Difficulty should eventually be measured, not imported

The labels came from opentdb, where every question was **multiple choice** and
a pure guess is right one time in four. This game makes people *type* the
answer. So an imported "easy" is materially harder here than the label claims,
and the labels are not merely coarse — they are calibrated for a different
game.

`question_stats` already counts `times_asked` and `times_correct` per question,
written by `record_question_outcome` once per question per game. That is the
real difficulty: how often people actually get it right.

The plan, when it is built:

1. **Blend, do not switch.** A threshold ("override after 20 plays") has a
   cliff, and with 4,859 questions and few players most questions would never
   reach it — the override would apply to almost nothing for a very long time.
   Instead weight the imported label as if it were a handful of prior
   observations and let real plays pull the value toward reality. At zero plays
   it is exactly today's behaviour; by fifty it is essentially measured.
2. **Never overwrite the original.** Keep the imported label; add the measured
   one alongside. If the measurement ever goes wrong it can be seen and reset,
   and nothing touches question text or answers.
3. **Write it where it already happens.** `record_question_outcome` runs once
   per question per game and is SECURITY DEFINER, so it can maintain the
   effective difficulty in the same call. No new machinery, no extra fetch
   during a game, and bots read it off the question they are already holding.
4. **Show both on the admin page first.** Imported "easy", playing at 31%. The
   labels are likely wrong more often than expected, and that is worth seeing
   before anything depends on it.

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

## Chat: deliberately not in the first version

The obvious version — a few written lines per bot for winning, losing and
getting one wrong — fails on repetition. Six lines are all seen within two
games, and at that point they read as cheap. A bot repeating itself is worse
than a bot saying nothing.

Doing it properly means templates filled from real facts rather than fixed
sentences: the wager they actually spent, the streak they are actually on, the
name of whoever actually beat them. The facts vary each round, so few lines
still sound fresh. It also needs a no-repeat rule within a game and a cooldown
so two bots never talk over each other.

None of that is hard, but it is guesswork until someone has played against
these bots and knows what they should sound like. **The personality is already
visible every round without a word** — answer speed, wager habits, typing
style. Chat is the least necessary channel and the most likely to grate.

**Bots do honk.** It is already in the game, needs nothing written, and a bot
that honks when it nails a hard one has more character than one typing "Nice!".

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

- How many bots ship at first, and who they are. Six or so, spread across
  skill levels, feels right. To be proposed and reacted to, not guessed.
- Whether bots get titles and tiers, or whether those stay human.

## Rough build order

1. The bot definitions — names, skills, habits. No behaviour yet.
2. Adding and removing them in the lobby, with the host-only rules enforced.
3. Answering: skill × difficulty, distractor lookup, timing, typing style.
4. Wagering by habit.
5. Honks.
6. Leaderboard yardstick band.

Each step is playable before the next one starts.
