---
name: word-ladder
description: Run a title-word session with the owner of Oracle Party: agree a topic's four reel-2 words and its reel-3 noun, then hand over the SQL. Use when the owner wants to choose, review or add title words for a topic or subject.
---

# Choose a topic's title words with the owner

The owner chooses every word. Your job is to propose well, listen exactly,
and keep the record. About 45 batches were rejected learning the rules below;
the rejected words and the reasons are in `docs/HISTORY.md` (search the topic
name, "LOCKED", "Rejected"). Read the relevant entries before proposing.

## What is being chosen

For one topic (for example History → Medieval):

| Reel | Step | Earned at |
|---|---|---|
| 2, describing word | Uncommon | ¼ of the topic |
| 2 | Rare | ½ |
| 2 | Epic | ¾ |
| 2 | Legendary | all of it |
| 3, noun | (shown in Rare's colour) | the topic's Rare word |

A title reads reel 1 + reel 2 + reel 3, such as "Brave Gassy Hermit". Run
`node scripts/probe-db.mjs` output or the admin Title Words panel to see which
topics exist, their sizes and which slots are empty. A topic under a step's
floor (60 / 70 / 80 / 100 questions) keeps that step locked, so a word may be
written early.

## The rules (the owner's)

- **Plain textbook vocabulary of the topic that becomes a joke or a roast
  when said about a person.** Organelle, Unstable, Gassy, Diseased, Mummified.
- Instantly recognisable as that topic to a normal person. No clever
  references, no trivia, no myths in History, no obscure words, no slang.
- **One word.** A hyphen only if it is one dictionary word (Single-Celled).
- Reel 2 must read as a describing word in a full title. Job titles and nouns
  fail there.
- Funny with an edge at the bottom, earned at the top. Polite compliments are
  "not funny". A Legendary may be a roast if the owner chooses it knowingly.
- **A ladder is one kind of thing, climbing one notch per step, without
  echoing.** State what climbs (cheekiness, grimness, zoom level) in a
  sentence and get that agreed before any word.
- **The noun** is an oddly specific character you can picture, tied to the
  topic (Alien, Bigfoot, Jester, Pharaoh, Gold-Digger). Judge it only by its
  combos with reel-2 words ("Mooning Caveman", "Gassy Hermit"), never alone.
  Not a plain role, not a mystic, not the same root as a reel-2 word on the
  same topic.
- Words from one topic must not drift into a neighbouring topic.

## How to run the session

1. **Agree the stages first.** Offer two or three ladder ideas as one
   sentence each ("grim and getting grander", "a zoom from small to whole").
   Use the interview tool.
2. **Show whole ladders in one table**, at most three candidates, each row a
   full ladder with two sample titles using real rank words (Caveman, Hermit,
   Hippie, Pilgrim, Guru, Oracle). Never single slots, never long lists.
3. When the owner questions a word, **answer the question about the agreed
   ladder**. Do not swap in new words unless asked.
4. When the owner rejects a batch, name the rule you broke before offering
   more. Do not spray guesses.
5. **Confirm each chosen word by name**, one line per slot, and wait for a
   yes that covers every line. "Okay fine" to a table is not that.
6. Never tell the owner to stop or move on.

## After every word is confirmed

- Hand over **one** SQL paste (see `/sql-handover` for the format): an upsert
  into `title_words` for each reel-2 word (`slot` 2, `category`,
  `subcategory`, `tier`, `word`, `target_right`, `is_placeholder` false), and
  deletes of any retired words and their unlocks if the owner said to replace
  them. Check the table's real columns and unique index in
  `migrations/063_*.sql` and `064_*.sql` first.
- The noun is code: add it to `TITLE_WORDS` in `js/titles.js` beside
  `nounJester`, with `followsWord: 'w:<category>:<subcategory>:rare'`, and
  extend `tests/topic-nouns.test.js`.
- Record in `CLAUDE.md`'s locked-words table and add the rejected words and
  reasons to a dated entry in `docs/HISTORY.md`.
