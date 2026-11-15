---
name: playtest-triage
description: Work through the owner's feedback after a real game of Oracle Party: sort it, interview for the missing facts, reproduce, fix, prove and record. Use when the owner reports bugs, oddities or polish notes from a playtest.
---

# Triage a playtest report

The owner plays real games with friends on phones and reports afterwards,
often as a list, sometimes with photos. Reports are accurate about what was
seen and usually silent on the detail that identifies the cause.

## 1. Sort the list first

Restate every item in one line and put it in one bucket. Show the owner the
sorted list before working.

| Bucket | Meaning | Action |
|---|---|---|
| Game-breaking | a game could not continue or a score was wrong | first, one at a time |
| Wrong | something showed or did the wrong thing | after those |
| Design question | "should it…?" | answer or interview; never build from a question |
| Polish | looks, spacing, smoothness | list it; do only if asked |
| Already as designed | | say so, with the reason |

Several items are often one fault. Say so when you see it.

## 2. Interview before guessing

Ask only what changes the diagnosis, with the interview tool:

- **What did the control itself do?** (no press animation = the tap never
  reached it; greyed and silent = waiting on the network)
- **Which phone, and what did the other phones show at that moment?**
- **Is it new?** "It started recently" outranks any old cause: read the diff
  since the last good game.
- Host or player, round number, final round or not, bot in the room, anyone
  backgrounded or rejoined, Wi-Fi or mobile data.

## 3. Look before reasoning

- Search `docs/HISTORY.md` for the symptom's words. Most shapes have happened.
- Ask the owner to open admin → Error Logs and read out rows from the game's
  time. The recorders: `AnswerNotMine`, `BotAnswer`, `SeatSwept`,
  `ResultsMissing`, `SlowRequest`, `SlowSubmit`, and "Script error." context.
- Check the `db-probe` run nearest the game for a slow or changed database.

## 4. Reproduce by setting the state

Use `tests/harness/`. Pick the knob that matches the report:

- one person saw it, another did not → `robot.slowConnection(ms)`
- a phone missed a message → `robot.deafTables`, `store.dropEvents`
- a phone slept → `robot.goToBackground()` / `comeBack()` (seat `pocketable`)
- a request hung or failed → `store.slowFunction`, `slowReads`,
  `slowReadReplies`, `failFunction`
- SQL not applied → `store.hideFunction`, `--old-server`
- it grew over an evening → `scenario-sitting --games=4`

Set the exact state rather than racing for it. A robot that never waits
cannot find a bug that needs a person's patience. If it will not reproduce,
say so, ship a recorder instead of a guess, and write "not reproduced".

## 5. Fix one thing

- Only what was reported. No redesign on the way.
- Then grep for every other place with the same shape and fix those too.
- Never read shared state after an `await` and act on it; fix the round at
  the tap, re-check before drawing.
- If rendering changed, change `scripts/mock-states.js` in the same commit
  and read the screenshot at 320, 375 and 430 in all three themes.

## 6. Prove it

Add a check, then break the fix on a copy (`cp file /tmp/…`, never
`git checkout`) and watch the check fail by name. A check that passes on the
old code is deleted or rewritten. Run `npm test`, the sweep, and the
scenarios near the change.

## 7. Record and report

Add a dated entry at the top of `docs/HISTORY.md`: the owner's words, the
cause, how it was established (measured / reproduced / read / inferred), the
check that now fails on the old code, and what is still unexplained.

Tell the owner, per item and in plain language: fixed and how it was proven,
not reproduced and what will catch it next time, or a question for them.
Deploy only if they ask (`/deploy`).
