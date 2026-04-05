# Oracle Party

## What This Is
A mobile-only browser trivia game hosted on GitHub Pages with a Supabase backend. Players are time-traveling archaeologists fighting "The Algorithm" (a rogue AI flooding the world with misinformation). Think Sporcle Party, but better.

## Tech Stack
- **Frontend:** Vanilla HTML / CSS / JavaScript (no frameworks)
- **Backend:** Supabase (Postgres + Realtime + Auth)
- **Hosting:** GitHub Pages
- **Mobile only:** All screens viewport-locked (100dvh, no scrolling on fixed screens). Design for 375px-430px width.

## Supabase Details
- **Project URL:** zzpqymehapwbjupphxec.supabase.co
- Database has 1,732+ curated trivia questions across 12 categories: history, science, nature, arts-literature, culture-society, pop-culture, world-geography, technology, sports, food, logic, wild-card
- Each question has: question text, correct answer, acceptable alternate answers, category, difficulty
- Supabase Realtime used for all multiplayer sync (lobby, gameplay, chat)

## Design Philosophy
- Use the frontend-design skill for all UI work
- **Aesthetic direction:** Ancient archaeologist meets sci-fi tech. Warm, explorable, feels like a place to hang out. Fusion of parchment/stone/ancient textures with subtle digital/circuit elements.
- Mobile-first, clean, crisp. No AI slop. No generic purple gradients.
- Viewport-locked screens (no scroll) except where content requires it (category browsing, lobby player list, chat)
- Clean typography as primary visual element until real assets are added later

## Game Flow (Complete)

### Host Path
Splash → Home → Choose Category → Host Settings → Lobby → Gameplay → Final Wager → Results → Back to Lobby

### Join Path
Splash → Home → Join Game (code/friends/public) → Lobby → Gameplay → Final Wager → Results → Back to Lobby

## Screen-by-Screen Spec

### Screen 1 — Splash
- Full mobile viewport, centered "Oracle Party" typography
- Auto-transitions to Home once app initializes
- Load Supabase connection during this screen

### Screen 2 — Home
- Viewport-locked, two primary buttons: "Host Game" and "Join Game"
- Clean, minimal, no bottom nav for v1

### Screen 3 — Choose Category (Host)
- Display 12 database categories as selectable options
- Community packs section (create/share custom packs — placeholder for v1)
- Search functionality
- Back button to Home

### Screen 4 — Host Settings
- Selected category info displayed
- "Host Game" button (creates room)
- Who Can Join: Invite Only / Friends / Anyone (toggle selector)
- Questions Per Game: 5 / 10 / 15 / 20 (toggle selector)
- Question Timer: 15s / 30s / 45s / 60s (toggle selector)

### Screen 5 — Join Game
- 6-digit room code entry at top
- Friends Playing section (expandable, shows active friend lobbies)
- Public Games section (browsable list: host name, category, room code, player count, game status)
- Back button to Home

### Screen 6 — Lobby (persistent hub)
- Share code displayed prominently with copy button
- Live chat (Supabase Realtime)
- Player list with display names and ready status
- Host has "Start Game" button
- After game ends, everyone returns here. Host can swap category or keep it.
- No bottom nav — dedicated game flow screen

### Screen 7 — Wager Select
- Before each question, players assign a point value
- With N questions, values are 1 through N, each used exactly once
- Players strategically bet high on confident categories, low on weak ones

### Screen 8 — Gameplay Question
- Timer counting down (based on host setting)
- Category name + question number ("15 of 20")
- Question text in a card
- Text input for typed answer + Submit button
- Host can skip timer / advance early

### Screen 9 — Answer Reveal
- Correct answer displayed with difficulty level
- Each player's submitted answer shown with auto-judged green (correct) / red (incorrect)
- Auto-judging: fuzzy match against correct answer + all acceptable alternates, with typo tolerance
- Host can override any judgment live (flip red↔green), everyone sees it update in real time
- Host advances to next question manually (controls pace)
- Chat available
- Player scores visible

### Screen 10 — Final Wager
- Special last round: players bet up to 20 points
- This is the ONLY round where incorrect = lose wagered points
- Shows all players with their wager and current score

### Screen 11 — Results
- Winner celebration at top (placement badge, display name)
- Scoreboard: all players ranked with placement (1st/2nd/3rd), points earned, total scores
- Chat available
- "Play Again" → returns to Lobby (host can swap category)
- "Quit" → returns to Home

## Auth & Accounts
- Display name required to play (instant access, no sign-up needed)
- Optional account creation (Supabase Auth) unlocks: friends list, persistent stats, profile
- Guests can do everything except friends list and persistent stats

## Scoring System
- Wager-based: players assign point values (1-N) to each question, each value used once
- Correct answer = earn wagered points. Incorrect = earn nothing (no loss).
- Final wager exception: incorrect = LOSE wagered points
- Speed does NOT affect scoring

## Answer Judging
- Database stores correct answer + array of acceptable alternates per question
- Auto-match with fuzzy tolerance for typos, abbreviations, spacing
- Host can override any auto-judgment in real time

## File Structure
```
Oracle-Party/
├── index.html          # Splash + Home
├── host.html           # Choose Category + Host Settings
├── join.html           # Join Game screen
├── lobby.html          # Lobby (persistent hub)
├── game.html           # Gameplay (wager, question, reveal, final wager, results)
├── css/
│   └── style.css       # Global styles + CSS variables
├── js/
│   ├── supabase.js     # Supabase client init + helpers
│   ├── auth.js         # Display name / optional account
│   ├── host.js         # Host flow logic
│   ├── join.js         # Join flow logic
│   ├── lobby.js        # Lobby + Realtime chat + player sync
│   ├── game.js         # Gameplay loop + wager + judging + results
│   └── utils.js        # Fuzzy matching, shared helpers
└── CLAUDE.md
```

## Build Phases
1. **Foundation + Splash + Home** (project structure, Supabase connection, first two screens)
2. **Host flow** (category selection, settings, room creation)
3. **Join flow + Lobby** (code entry, friends, public games, chat, Realtime)
4. **Gameplay loop** (wagers, questions, answers, timer, host judging, reveal)
5. **Final wager + Results** (final round, scoreboard, play again → lobby)

## Rules for Claude Code
- **STOP and ASK** before making architectural decisions not covered in this spec
- Do NOT modify files outside the current phase unless necessary
- Test each screen on mobile viewport (375px) before moving on
- Commit after each working milestone
- Use semantic, readable variable/function names
- Keep CSS variables for all colors, fonts, spacing — theming comes later
- No external JS frameworks. Supabase JS client is the only dependency.
- When in doubt, keep it simple. We can add complexity later.

## Visual Review & Playtesting (MANDATORY)

### Screenshot Tool
```bash
# Single page/screen
node scripts/screenshot.js [page] --screen=[id] --theme=[dark|oled]
# Specific mock state (realistic data)
node scripts/screenshot.js --state=<name>
# All mock states at once
node scripts/screenshot.js --all
# With accessibility scan
node scripts/screenshot.js --state=<name> --a11y
```
- Output: `/tmp/screenshot-<name>.png` — read with the Read tool to visually inspect
- Mock states defined in `scripts/mock-states.js` — covers splash, home, category grid, lobby, gameplay, reveal, results, etc.
- Default viewport: 375×812 (iPhone), 2x device scale. Override with `--width=N --height=N`

### The Process (NON-NEGOTIABLE)
1. **ALWAYS screenshot before pushing.** Never push UI changes blind.
2. **Read the screenshot with the Read tool** and critically assess — does it actually look good? Be honest.
3. **Look closely at every detail.** Check alignment, centering, spacing, overlap, color consistency, icon rendering, text readability. Don't gloss over obvious issues like off-center elements, overlapping content, or broken layouts. If something looks even slightly off, fix it before moving on.
4. **Fix issues, re-screenshot, repeat** until genuinely confident. Not "good enough" — actually good.
5. **Check all three themes** (light, dark, OLED) for any visual change.
6. **Compare against the vision** — does every element earn its place? Does anything look cheap, generic, or like a developer placeholder?
7. **Playtest gameplay changes** — use mock states or manual browser testing to verify the actual game flow works, not just static visuals.
8. **Never claim something looks good when it doesn't.** Be the harshest critic before the user has to be.

## Gotchas — Common Mistakes to Avoid
- NEVER show internal state markers (like `__WAGER_LOCKED__`) to players
- Always fully reset game state when returning to lobby via Play Again
- Score should never go negative on regular rounds — only final wager
- Always verify changes didn't break existing functionality before committing
- When fixing a bug, check if the same pattern exists elsewhere in the codebase
- Test at 375px mobile viewport before committing any UI changes
- Clear all previous round data before rendering a new question
- Use `/clear` between unrelated tasks to prevent context pollution
- Date questions should ask for the YEAR only, not exact dates, unless the date is very famous (e.g. 1776, 9/11)
- Number questions should accept reasonable ranges or rounded values — don't expect exact figures for obscure stats
- When importing new questions, flag any that expect exact dates or very specific numbers
