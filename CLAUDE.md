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
- **READ THIS ENTIRE FILE BEFORE DOING ANYTHING.** Every section. Every gotcha. No exceptions. If you skip this and repeat a documented mistake, you are wasting the user's time and money.
- **MAXIMUM EFFORT ALWAYS.** Never guess when you can investigate. Never deploy without verifying. Never assume cross-browser behavior without testing. Never touch code you haven't read. Never change things that aren't broken.
- **NEVER GIVE UP OR SUGGEST REVERTING.** When something doesn't work, DIAGNOSE WHY. Read the code, add logging, reproduce the failure, trace the logic. Giving up and suggesting "just revert" is not acceptable. The user is paying for solutions, not surrender. If something is broken, fix it. If you can't fix it in one attempt, try a different approach. Keep going until it works.
- **ONLY change what was asked.** If asked to fix one glyph, fix ONLY that glyph. Do not "improve" 11 others based on Chromium screenshots. Working code that was calibrated on the actual device must not be touched.
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
4. **ZOOM IN to verify.** Overview screenshots are NOT sufficient. For any element that could have clipping, overflow, alignment, or sizing issues, create a zoomed-in test (e.g. 2 cards at 250px height, not 12 cards at 900px) and inspect at close range. Do NOT eyeball small thumbnails and claim they look fine — that is self-deception and wastes everyone's time. If you can't clearly see whether something is clipped or misaligned, you haven't zoomed in enough.
5. **TEST AT REAL DIMENSIONS.** When creating isolated test pages to verify individual components, use the EXACT same dimensions as the real page (same grid settings, same padding, NO min-height overrides, NO artificially tall containers). Testing at fake dimensions and then claiming things look fine is the single biggest recurring mistake — it has wasted literal hours. If the real cards are ~120px tall in a 2-column grid, test at that height. Never add `min-height: 140px` or similar to "see more detail" — you're seeing a lie.
6. **Fix issues, re-screenshot, repeat** until genuinely confident. Not "good enough" — actually good.
7. **Check all three themes** (light, dark, OLED) for any visual change.
8. **Compare against the vision** — does every element earn its place? Does anything look cheap, generic, or like a developer placeholder?
9. **Playtest gameplay changes** — use mock states or manual browser testing to verify the actual game flow works, not just static visuals.
10. **Never claim something looks good when it doesn't.** Be the harshest critic before the user has to be. Fuzzy eyeballing is not review — it is self-deception that wastes hours of the user's time.

## Gotchas — Common Mistakes to Avoid
- **STOP EYEBALLING. MEASURE.** When something keeps breaking despite repeated attempts, you are guessing instead of diagnosing. Stop tweaking numbers blindly. Write code to measure the actual values (pixel bounds, element dimensions, font metrics). You can solve ANY recurring issue if you actually investigate the root cause instead of cargo-culting CSS values. Hieroglyph descent clipping was solved in 5 minutes once we measured ink bounds via canvas — after wasting hours of the user's time on blind guesses.
- **NEVER GUESS CSS VALUES. NEVER.** Write Playwright scripts to measure actual rendered dimensions at multiple viewport widths (375px AND 430px minimum) before setting any position/size value. Verify the result matches at both widths BEFORE deploying. If you can't measure it, you can't fix it. Guessing and deploying wastes the user's time and money. This is a zero-tolerance rule.
- **USE RED OVERLAY DEBUGGING.** When positioning glyphs or aligning elements, render them at high opacity (0.7) in a contrasting color (red) and screenshot at multiple viewport widths. This is the ONLY way to see what's actually happening. Do this BEFORE deploying, not after the user reports it's broken.
- **Test at REAL card dimensions.** Mock states must include all 12 categories with real names (including multi-line names like "Arts & Literature") so grid-auto-rows: 1fr produces the correct card height. Never test with reduced content or overridden padding — you'll get fake dimensions that don't match the live site. **TEST AT REAL DIMENSIONS.** When creating isolated test pages to verify individual components, use the EXACT same dimensions as the real page (same grid settings, same padding, NO min-height overrides, NO artificially tall containers). Testing at fake dimensions and then claiming things look fine is the single biggest recurring mistake — it has wasted literal hours. If the real cards are ~120px tall in a 2-column grid, test at that height. Never add `min-height: 140px` or similar to "see more detail" — you're seeing a lie.
- **Responsive glyphs: cqi is relative to the CONTENT BOX** (excluding padding), not the total element width. Always account for padding when calculating cqi values. For elements that must align with fixed-position content (like emoji bubbles positioned by fixed padding), use transform: translateY(-N%) where N% references the element's own size — this scales universally.
- **Never ignore a recurring mystery.** If something keeps going wrong, it means you don't understand the system. Stop and figure out WHY before trying another fix. The answer is always findable.
- **The ankh-encircling-emoji attempt failed after 20+ iterations.** Do NOT attempt to make a hieroglyph glyph precisely encircle the emoji bubble — Chromium and Safari render the font at different proportions and there is no universal solution for pixel-perfect glyph-to-element alignment. Keep hieroglyphs as simple centered watermarks.
- **Use the live glyph tuner for cross-browser calibration.** When Chromium screenshots can't be trusted (e.g. hieroglyph positioning), use `host.html?tune=𓂀` (pass any hiero character) to get live sliders on the REAL page. The user adjusts size, bottom, left, and opacity on their actual device, screenshots the values, done. This is the precision tool — no separate test pages, no dimension mismatches. Works for ANY glyph, not just the eye.
- **Deployment branch is `claude/setup-oracle-party-PHRgj`.** Always push to this branch to deploy to GitHub Pages. The live site URL is `riskyquiznesshq.github.io/Oracle-Party/`. Do NOT guess deployment branches — this has been confirmed.
- **Do NOT change working glyphs to fix one broken glyph.** If one hieroglyph needs adjustment, change ONLY that one. The others were calibrated on the actual target device and should not be touched based on Chromium-only testing.
- **Always use maximum effort.** Never guess when you can investigate. Never deploy without verifying. Never assume cross-browser behavior without testing.
- **NEVER deploy without checking with red overlay first.** Every single CSS change must be screenshotted and visually verified before committing. No exceptions.
- **Measure ALL dimensions, not just the one you're focused on.** When told to fix vertical clipping, also check horizontal. When told to flush to the right, also verify the left isn't clipped. A fix to one axis can reveal or cause issues on the other axis. Always measure both width AND height ink bounds, and verify the glyph fits the card in BOTH dimensions simultaneously. Include border-radius safe zones in calculations.
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
