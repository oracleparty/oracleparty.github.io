# Oracle Party — Title System Spec

## Overview

A Toontown-style custom title system where players build personalized titles by combining words from 3 slots using a scrollable wheel UI. Words are unlocked through gameplay achievements, skill progression, loyalty, social actions, hidden milestones, and contributions. Each word has micro-levels (I, II, III) that change its visual treatment. The system replaces the current auto-title (`calculateTitle()`) — the existing tier progression (Novice → Apprentice → Scholar → Master → Oracle) becomes the primary unlock trigger for the wheel.

**Account-only feature.** Guests see no titles. Seeing titled players while being titleless is a sign-up motivator.

---

## Title Structure

### 3 Independent Slots

| Slot | Position | Word Type | Primary Unlock Source |
|------|----------|-----------|----------------------|
| **Slot 1: Prefix** | First word | Personality/trait words | Game milestones, loyalty, social |
| **Slot 2: Category** | Middle word | Category identity words | Category mastery (accuracy + volume) |
| **Slot 3: Tier** | Last word | Rank/achievement words | Tier progression (Apprentice → Oracle) |

### Display Format
The 3 words combine into a natural-flowing phrase with no separators:
- "Fearless History Oracle"
- "Relentless Science Master"
- "Phantom Wild Card Scholar"

Any combination of any Slot 1 + Slot 2 + Slot 3 word should read like a real title.

---

## Player Journey

### Phase 1: Before First Unlock
- All players with accounts start with **"Novice"** displayed under their name
- No wheel, no slots, no title builder visible
- Clean and simple — just the word "Novice" in muted italic text
- Guests (no account) see nothing — no title at all

### Phase 2: Title Builder Unlock
- Triggered when the player reaches **Apprentice** in their first category
- **Full-screen celebration moment**: "🔓 You've unlocked the Title Builder!"
- The wheel appears for the first time with:
  - Newly unlocked words from reaching Apprentice
  - All other slots showing "???" with vague poetic hints
  - First time seeing the wheel is a moment of wonder
- Player builds their first custom title and it replaces "Novice"

### Phase 3: Ongoing Progression
- Players unlock new words through gameplay
- Words appear in the wheel as they're earned
- Micro-levels upgrade visual treatment over time
- ??? entries create ongoing mystery and discovery

---

## Word Pool (Launch)

**~10 words per slot at launch.** Start small, grow with content updates (themed drops, seasonal additions).

### Slot 1: Prefix Words (~10)
Personality/trait words. Unlocked via milestones, loyalty, social, hidden.

| Word | Unlock Type | Condition | Hint |
|------|------------|-----------|------|
| Brave | Milestone | Win 5 games | "Victory favors the bold" |
| Relentless | Milestone | 10-game win streak | "Those who never stop, never lose" |
| Fearless | Milestone | Play 50 games | "Earned through sheer persistence" |
| Loyal | Loyalty | Account age 30 days | "Time reveals the faithful" |
| Steadfast | Loyalty | Play on 7 consecutive days | "Rain or shine, they return" |
| Popular | Social | Receive 100 honks lifetime | "The crowd knows your name" |
| Mighty | Social | Host 20 games | "A leader of many expeditions" |
| Phantom | Hidden | Play between 2-5am | "Only seen in the darkest hours" |
| Lucky | Hidden | Win a game with 100% accuracy | "Fortune smiles on the prepared" |
| Ancient | Loyalty | Account age 365 days | "They were here before the legends" |

### Slot 2: Category Words (~12)
Category identity words. Unlocked via category mastery tiers.

| Word | Unlock Condition | Hint |
|------|-----------------|------|
| History | Reach Apprentice in History | "The past whispers to those who listen" |
| Science | Reach Apprentice in Science | "Truth found through careful observation" |
| Nature | Reach Apprentice in Nature | "The wild reveals its secrets slowly" |
| Arts | Reach Apprentice in Arts & Literature | "Beauty recognized by a trained eye" |
| Culture | Reach Apprentice in Culture & Society | "Understanding begins with curiosity" |
| Pop | Reach Apprentice in Pop Culture | "The pulse of the modern world" |
| World | Reach Apprentice in World Geography | "Every map tells a story" |
| Tech | Reach Apprentice in Technology | "The future belongs to the curious" |
| Sport | Reach Apprentice in Sports | "Strength measured beyond the field" |
| Food | Reach Apprentice in Food & Drink | "Taste is a form of knowledge" |
| Logic | Reach Apprentice in Logic | "Patterns hide in plain sight" |
| Chaos | Reach Apprentice in Wild Card | "Order emerges from the unpredictable" |

### Slot 3: Tier Words (~8)
Rank/achievement words. Unlocked via tier progression and special achievements.

| Word | Unlock Condition | Hint |
|------|-----------------|------|
| Apprentice | Reach Apprentice in any category | "The first step on a long road" |
| Scholar | Reach Scholar in any category | "Knowledge earned through dedication" |
| Master | Reach Master in any category | "Few reach this summit" |
| Oracle | Reach Oracle in any category | "The rarest of minds" |
| Champion | Win 25 games total | "Victories carved in stone" |
| Guardian | Flag 10 questions that get reviewed | "Protector of truth" |
| Eternal | Reach Oracle in 3+ categories | "Transcended a single domain" |
| Untouchable | Hidden: Win 5 games in a row without a single wrong answer | "Perfection isn't a goal, it's a standard" |

---

## Unlock Categories

### 1. Category Mastery
- Accuracy × log2(questions_answered) — uses existing `calculateTitle()` thresholds
- Apprentice (≥3.0), Scholar (≥4.5), Master (≥5.5), Oracle (≥6.5)
- Minimum 20 questions per category
- Unlocks **Slot 2** (category words) and **Slot 3** (tier words)

### 2. Game Milestones
- Wins, streaks, total games played
- Tracked from `player_stats` and `game_history` tables
- Unlocks primarily **Slot 1** (prefix words)

### 3. Social Actions
- Honks received/given, friends added, games hosted
- Tracked from `profiles` (honks_received, honks_given) and `game_plays`
- Unlocks words across all slots

### 4. Hidden/Secret Achievements
- Completely invisible until triggered
- No hints shown for ??? entries from hidden achievements
- Examples: time-of-day play, perfect games, specific answer patterns
- Unlocks special words across all slots

### 5. Loyalty/Time
- Account age, consecutive days played, returning after absence
- Tracked from `profiles.created_at` and login patterns
- Unlocks **Slot 1** prefix words

### 6. Contribution
- Flagging questions that get reviewed/fixed
- Future: submitting custom questions
- Tracked from `question_feedback` table
- Unlocks **Slot 3** tier words (e.g., "Guardian")

---

## Micro-Levels (Visual Progression)

Each word has 3 levels. The word appears in the wheel at Level I. Levels II and III change visual treatment only — no new words added.

| Level | Visual | Unlock |
|-------|--------|--------|
| **I** | Default text color | First achievement of the condition |
| **II** | Subtle shimmer/glow effect | 2× the base condition |
| **III** | Gold tint + persistent glow | 3× the base condition |

Example: "Fearless" (play 50 games)
- Level I: Play 50 games → word appears in wheel, default color
- Level II: Play 100 games → word gains subtle shimmer
- Level III: Play 150 games → word turns gold with persistent glow

Players see the visual difference on others' titles but don't know the exact conditions until they level up their own.

---

## Wheel UI

### Interaction Model: Vertical Scroll Wheel (Slot Machine Style)

Each of the 3 slots is a vertical column. Players swipe up/down to scroll through available words. The selection snaps to the center position.

```
┌─────────────────────────────┐
│     [Slot 1]  [Slot 2]  [Slot 3]    │
│                                       │
│     Brave     ???       Apprentice   │
│   > Fearless  History   Scholar <    │  ← Selected
│     ???       Science   ???          │
│                                       │
│          "Fearless History Scholar"   │
│                                       │
│            [ Save Title ]             │
└─────────────────────────────┘
```

- **Unlocked words**: Displayed normally, scrollable
- **Locked words**: Show as "???" with a lock icon
- **Tapping a locked ???**: Shows the poetic hint in a tooltip/toast
- **Current selection**: Highlighted row in the center, larger text
- **Preview**: The combined title shown below the wheels as you scroll
- **Save**: Button to confirm the selection

### Wheel Location
- Accessible from the **Profile page** via a "Title Builder" button/section
- Also accessible from the **unlock celebration** screen

### Word Order in Wheel
- Unlocked words first (sorted alphabetically)
- Locked ??? entries below (sorted by rarity — common locks first, legendary last)

---

## Title Display

### In-Game (Lobby, Reveal, Scores, Results, Chat)
- Below player name as a subtle second line
- Smaller text, muted color, italic
- Fits within the same width as the name, ellipsis only for extremely long combos
- Micro-level effects visible but subtle at this size (shimmer/gold barely noticeable)

### Profile Page & Profile Card
- More prominent: larger text below name
- Micro-level effects clearly visible (shimmer animation, gold color)
- Tappable to open the Title Builder

### Players Without Custom Titles
- Account holders before Apprentice: "Novice" in muted italic
- Guests: No title shown at all

---

## Celebration Tiers

### Tier 1: Common Unlock (Toast)
- Small toast at top of screen: "🔓 [Word] unlocked"
- Shows the poetic hint briefly
- Auto-dismiss after 3 seconds

### Tier 2: Rare Unlock (Results Section)
- Dedicated "Unlocks" section on the results screen
- Word shown with its poetic hint, revealed dramatically
- Appears between scoreboard and action buttons

### Tier 3: Legendary Unlock (Full-Screen)
- Full-screen celebration animation
- Word appears large with its hint and special effects
- Other players in the lobby see: "[Player] unlocked a legendary title word"
- Used for: Oracle-tier words, hidden achievement words like "Untouchable"

### Tier 4: Title Builder First Unlock (One-Time)
- Full-screen dramatic reveal when reaching Apprentice for the first time
- "🔓 You've unlocked the Title Builder!"
- Wheel appears spinning, settles on the first available words
- Only happens once per account

### Tier 5: Micro-Level Upgrade
- Brief toast: "✨ [Word] reached Level III"
- The permanent visual change on the word is the real reward
- No full-screen animation

---

## Soft Uniqueness

- Multiple players can use the same 3-word title combination
- When building a title, show: "X other players use this title"
- Social proof encourages differentiation but doesn't block

---

## Database Schema

### New Table: `title_unlocks`
```sql
CREATE TABLE title_unlocks (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  word_id    TEXT NOT NULL,        -- matches hardcoded word ID (e.g. 'fearless', 'history_oracle')
  level      INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 3),
  unlocked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, word_id)
);

CREATE INDEX idx_title_unlocks_user ON title_unlocks (user_id);
```

### Modify `profiles` Table
```sql
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS title_slot1 TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS title_slot2 TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS title_slot3 TEXT DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS title_builder_unlocked BOOLEAN NOT NULL DEFAULT false;
```

### Modify `players` Table (Denormalize for Rendering)
```sql
ALTER TABLE players
  ADD COLUMN IF NOT EXISTS custom_title TEXT DEFAULT NULL;
  -- Stores the rendered "Fearless History Scholar" string
  -- Copied from profile on join, like avatar_color/avatar_emoji
```

---

## Master Word List (Hardcoded in JS)

```js
// js/titles.js
export const TITLE_WORDS = {
  // Slot 1: Prefix
  brave:      { slot: 1, word: 'Brave',      rarity: 'common',    hint: 'Victory favors the bold',                    unlock: { type: 'milestone', condition: { wins: 5 } } },
  relentless: { slot: 1, word: 'Relentless',  rarity: 'rare',      hint: 'Those who never stop, never lose',            unlock: { type: 'milestone', condition: { winStreak: 10 } } },
  fearless:   { slot: 1, word: 'Fearless',    rarity: 'rare',      hint: 'Earned through sheer persistence',            unlock: { type: 'milestone', condition: { gamesPlayed: 50 } } },
  // ... etc

  // Slot 2: Category (12 entries, one per category)
  history:    { slot: 2, word: 'History',     rarity: 'common',    hint: 'The past whispers to those who listen',       unlock: { type: 'mastery', condition: { category: 'history', tier: 'Apprentice' } } },
  // ... etc

  // Slot 3: Tier
  apprentice: { slot: 3, word: 'Apprentice',  rarity: 'common',    hint: 'The first step on a long road',              unlock: { type: 'mastery', condition: { anyCategory: 'Apprentice' } } },
  oracle:     { slot: 3, word: 'Oracle',      rarity: 'legendary', hint: 'The rarest of minds',                        unlock: { type: 'mastery', condition: { anyCategory: 'Oracle' } } },
  // ... etc
};

export const RARITY_CELEBRATION = {
  common: 'toast',        // Tier 1
  rare: 'results',        // Tier 2
  legendary: 'fullscreen' // Tier 3
};
```

---

## Unlock Evaluation

### When
1. **After every game** (in `showResultsScreen()`): Check all conditions against updated stats. Show celebration for new unlocks on the results screen.
2. **On login** (`initAuth()`): Re-check all conditions to catch:
   - Time-based unlocks (account age, consecutive days)
   - Social triggers (honks received while offline)
   - Stat corrections from host overrides

### How
```js
// js/titles.js
export function evaluateUnlocks(playerStats, gameHistory, profile, currentUnlocks) {
  const newUnlocks = [];
  for (const [id, word] of Object.entries(TITLE_WORDS)) {
    const existing = currentUnlocks.find(u => u.word_id === id);
    const currentLevel = existing?.level || 0;
    const newLevel = computeLevel(word, playerStats, gameHistory, profile);
    if (newLevel > currentLevel) {
      newUnlocks.push({ wordId: id, level: newLevel, rarity: word.rarity });
    }
  }
  return newUnlocks;
}
```

---

## Relationship to Existing Auto-Title System

The current `calculateTitle()` in `utils.js` computes Novice/Apprentice/Scholar/Master/Oracle from `player_stats`. This system is **absorbed into the wheel**:

- `calculateTitle()` thresholds power the **Slot 2** and **Slot 3** unlock conditions
- The auto-title display ("The Historian — Oracle") is **replaced** by the custom 3-word wheel title
- "Novice" remains as the pre-unlock display for accounts without the Title Builder
- The `title` column on the `players` table switches from auto-computed to user-selected custom title

---

## Build Phases

### Phase 1: Data Foundation
- Create `title_unlocks` table + profile columns migration
- Create `js/titles.js` with hardcoded word list + `evaluateUnlocks()`
- Wire evaluation into `showResultsScreen()` and `initAuth()`
- Store unlocks in DB, display "Novice" for all accounts initially

### Phase 2: Title Builder UI
- Vertical scroll wheel component on profile page
- 3-column layout with snap scrolling
- ??? entries with poetic hints on tap
- Save selection to profile → denormalize to players table on join

### Phase 3: Display Integration
- Replace auto-title with custom title in all rendering locations
- Add micro-level visual effects (CSS shimmer, gold tint)
- Show title below name everywhere (lobby, reveal, scores, results, profile card)

### Phase 4: Celebrations
- Toast system for common unlocks
- Results screen unlock section for rare words
- Full-screen celebration for legendary + first Title Builder unlock
- Lobby notification for legendary unlocks

### Phase 5: Polish
- Soft uniqueness counter ("X players use this title")
- Content drops (add new words via code updates)
- Seasonal themed words
