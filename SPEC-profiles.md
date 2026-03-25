# Oracle Party — Profiles & Friends Spec

## Overview

This spec adds persistent user accounts, player profiles, and a friends system to Oracle Party. Currently all players are ephemeral guests (display name only, stored in localStorage). This feature introduces optional Supabase Auth accounts that unlock social features: profiles with stats, customizable avatars, auto-generated titles, a friends list, presence/activity tracking, and direct lobby joining.

---

## 1. Account System

### Current State
- Players enter a display name (1-20 chars) stored in `localStorage`
- No Supabase Auth, no persistent identity, no user IDs beyond ephemeral `players` table rows

### New Account Model

**Guest (unchanged):**
- Enter display name to play immediately
- Full gameplay access — can host, join, play, chat, honk
- No access to social features (profiles, friends, stats)
- Stats from current session are tracked in-memory but not persisted

**Registered Account:**
- Email + password via Supabase Auth
- Unlocks: persistent profile, friends list, stats tracking, search visibility
- Display name + auto-generated 4-digit discriminator (e.g. "Roman#4821")

### Guest → Account Upgrade Flow
- Triggered inline when a guest taps a social feature (Add Friend, view profile, etc.)
- Bottom sheet modal appears with email + password fields + "Create Account" button
- On success: current session stats (games played, scores from active session) carry over to new account
- Player's existing display name becomes their account display name
- 4-digit discriminator auto-generated (random, unique per display name)
- After account creation, the social action that triggered signup continues automatically

### Display Name Rules
- 1-20 characters
- Can be changed freely at any time, unlimited changes, no cooldown
- Discriminator tag (4 digits) is permanent and auto-generated on account creation
- In-game: only display name shown (no tag)
- On profiles and friend search: full "Name#1234" format

### Account Deletion
- Soft delete: mark account as inactive, set `deleted_at` timestamp
- Anonymize display name to "Deleted User" across all surfaces
- Keep anonymized stats in other players' game histories (so game records stay intact)
- Remove from all friends lists
- Profile no longer accessible

---

## 2. Profile

### Avatar
- **Replaces** the current auto-generated HSL circles (`getAvatarHue()`) everywhere in the app
- Player picks: background color (8-10 preset palette colors) + any emoji
- Displayed as colored circle with emoji centered inside
- Shows everywhere: lobby player list, gameplay, answer reveal, scores, results, chat, friends list
- **Guests** keep the current auto-generated initial-letter circle (no customization)
- Default for new accounts: random palette color + 🏺 emoji (on-theme default)

### Auto-Generated Title
- Based on per-category performance using weighted score:
  ```
  category_score = accuracy × log(questions_answered)
  ```
- **Minimum 20 questions answered** in a category before it qualifies for title calculation
- Title comes from the player's **best category** (highest `category_score`)

**Title Tiers (per category):**

| Tier | Label Example | Threshold |
|------|--------------|-----------|
| Novice | — | Default (< 20 questions) |
| Apprentice | History Apprentice | Low threshold |
| Scholar | History Scholar | Medium |
| Master | History Master | High |
| Oracle | History Oracle | Very high (meant to feel rare) |

**Category → Title Name Mapping:**

| Category | Title Name |
|----------|-----------|
| history | The Historian |
| science | The Scientist |
| nature | The Naturalist |
| arts-literature | The Literati |
| culture-society | The Anthropologist |
| pop-culture | The Culturist |
| world-geography | The Cartographer |
| technology | The Technologist |
| sports | The Athlete |
| food | The Connoisseur |
| logic | The Logician |
| wild-card | The Polymath |

**Display format:** "{Category Title} — {Tier}" (e.g. "The Historian — Oracle")

Title shows everywhere the player's name appears: lobby, gameplay, profile, chat.

### Profile Fields

| Field | Editable | Visibility |
|-------|----------|-----------|
| Display name | Yes (freely) | Everywhere |
| Discriminator (#1234) | No | Profile, search |
| Avatar (color + emoji) | Yes | Everywhere |
| Auto-title | No (computed) | Everywhere |
| Bio/tagline | Yes (50 chars max) | Profile only |
| Favorite category badge | Yes (pick from 12) | Profile only |
| Visibility setting | Yes | N/A (controls profile access) |

### Profile Stats

**Summary stats (shown on profile):**
- Total games played
- Total wins
- Win rate (percentage)
- Strongest category (highest `category_score`) — displayed as badge
- Weakest category (lowest `category_score` with ≥20 questions) — displayed as badge

**Per-category breakdown:**
- Games played
- Questions answered
- Accuracy (percentage)
- Current title tier

**Social stats:**
- Honks received (lifetime)
- Honks given (lifetime)
- Questions flagged (lifetime, shows contributor engagement)

**Game history:**
- Full history stored in database
- **Display last 5 games** on profile (category, score, placement, date)
- Full history view is future scope

### Profile Visibility
- **Public (default):** Profile appears in player search. Anyone can view it. Recommended default since this is a social party game and discoverability helps growth.
- **Friends Only:** Profile hidden from search results. Still visible to:
  - Accepted friends (anytime)
  - Players currently in the same lobby/game

---

## 3. Friends System

### Adding Friends

**Method 1 — Instant Add (In-Game)**
- When in a shared lobby or game, tap any player's name/avatar
- Profile card appears with "Add Friend" button
- Tapping "Add Friend" instantly creates a mutual friendship — no confirmation needed
- Rationale: you're already playing together, the shared context is the trust signal
- Both players see a brief toast: "You and {name} are now friends!"

**Method 2 — Search Add (Outside Game)**
- From the friends list, tap "Add Friend" / search icon
- Search by display name or full "Name#1234"
- Results show matching public profiles (Friends Only profiles excluded from search)
- Tap a result → sends a friend request
- **Request → Accept/Decline flow:**
  - Recipient sees pending request in friends list + notification (see Section 6)
  - Recipient can Accept or Decline
  - Accepted: mutual friendship created
  - Declined: request removed, sender is not notified of decline (just disappears)
  - Pending requests expire after 30 days

### Removing Friends
- From friends list or profile card: "Remove Friend" option
- Instant removal, no confirmation dialog
- Removes from both players' friends lists
- No notification sent to the other player

### Friend Limits
- **Unlimited** — no cap on friends list size. It's a social party game.

### Blocking
- **Not included in v1.** Players can unfriend. If blocking is needed later, it will be added as a separate feature.

---

## 4. Navigation & UI

### Home Screen Addition
- Small avatar circle in the **top-left corner** of the Home screen
- Shows the player's custom avatar (color + emoji) if logged in, or initial-letter circle if guest
- Tapping opens the **Profile Page** (full screen)
- A notification badge (red dot) appears on the avatar when there are pending friend requests
- Main Home screen layout unchanged: "Host Game" and "Join Game" remain the focus

### Profile Page (Full Screen)
- Accessed by tapping avatar on Home screen
- **Sections:**
  1. Header: Avatar (large), display name#tag, auto-title, bio
  2. Stats summary: games, wins, win rate, strongest/weakest category badges
  3. Per-category breakdown (expandable/collapsible)
  4. Recent games (last 5)
  5. **Friends tab:** switches to friends list view
- Edit button for: display name, avatar, bio, favorite category, visibility setting
- Back button returns to Home

### Friends List (Tab within Profile Page)
- Shows all friends sorted by online status (online first), then alphabetical
- Each friend row: avatar, display name, title, online/activity status
- **Activity indicators:**
  - 🟢 Online — "Home" / "In Lobby — {Category}" / "In Game — {Category}"
  - ⚫ Offline — "Last active {relative time}"
- "Join" button next to friends showing "In Lobby" (see Section 5)
- Pending requests section at top (if any): accept/decline buttons
- Search/Add Friend button at top

### In-Game Profile Card (Bottom Sheet)
- Triggered by tapping any player's name or avatar in: lobby, chat, answer reveal, scores, results
- **Bottom sheet modal** — slides up from bottom, dismissable by swipe down or tap outside
- **Contents:**
  - Avatar (large), display name#tag, auto-title
  - Stats summary: games, wins, win rate, best category
  - "Add Friend" button (if not already friends)
  - "Remove Friend" option (if already friends)
  - "View Full Profile" link (opens full profile page)
- For guests viewing: "Add Friend" triggers the account creation flow
- Non-disruptive: gameplay continues behind the dimmed overlay

---

## 5. Join Friend Flow

When a friend's status shows "In Lobby — {Category}", a "Join" button appears next to them in the friends list.

**Behavior depends on room privacy setting:**

| Room Setting | Button | Behavior |
|-------------|--------|----------|
| Anyone | "Join" | Instantly joins the lobby |
| Friends | "Join" | Instantly joins the lobby (you're friends — that's the point) |
| Invite Only | "Request to Join" | Sends a join request to the host |

**Invite Only — Request to Join:**
- Host receives a notification in their lobby: "{Player} wants to join"
- Host can Accept (player joins) or Ignore (request dismissed)
- If host doesn't respond, request times out after 2 minutes

**Games in progress:**
- If friend's status is "In Game", show status only — no Join button
- They'll return to lobby after the game ends
- **Future scope:** Add spectator mode. Design the DB for it now (spectator boolean on `players` table) but don't build the UI.

---

## 6. Notifications

### Friend Request Notifications
- **On app open:** Toast notification slides down from top: "You have {N} pending friend request(s)"
- Auto-dismisses after 4 seconds, tappable to go to friends list
- **Badge:** Red dot on the avatar icon (Home screen top-left) persists until all requests are handled

### Join Request Notifications (Host)
- In-lobby notification when a non-friend requests to join an invite-only room
- Appears as a dismissable card in the lobby UI: "{Player} wants to join — Accept / Ignore"

### No Push Notifications
- All notifications are in-app only — no browser push notifications for v1

---

## 7. Presence System

### Implementation
- **Supabase Realtime Presence** to track online status and current activity
- Each logged-in player with ≥1 friend broadcasts their presence state
- **Performance optimization:** Only subscribe to presence channels for players who have at least one friend. Guests and friendless accounts don't participate in presence tracking.

### Activity States

| State | Displayed As |
|-------|-------------|
| Home screen | "Online" |
| In lobby | "In Lobby — {Category}" |
| In game | "In Game — {Category}" |
| App closed / inactive | "Offline — Last active {time}" |

### Privacy Toggle
- Setting in profile: "Show Online Status" (default: ON)
- When OFF: player always appears as "Offline" to friends
- Still appears in lobby/game player lists normally — this only affects the friends list activity display

---

## 8. Honk Stats

### Current Honk System (Unchanged)
- In-game honk button (🦆) next to each player
- Supabase Realtime broadcast, no cooldown, spam is the fun
- Sound effect plays on receive, animated emoji spawns
- Honk count shown per player per game session

### New: Persistent Honk Stats
- On game completion, persist each player's honk totals to their profile stats:
  - `honks_received` (lifetime cumulative)
  - `honks_given` (lifetime cumulative)
- Displayed on profile as social stats
- **No honk button on profiles** — honking remains an in-game-only interaction

---

## 9. Database Schema

### New Tables

#### `profiles`
```sql
CREATE TABLE profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID UNIQUE NOT NULL REFERENCES auth.users(id),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 20),
  discriminator CHAR(4) NOT NULL,
  avatar_color TEXT DEFAULT '#8B7355',  -- default warm brown
  avatar_emoji TEXT DEFAULT '🏺',
  bio TEXT CHECK (char_length(bio) <= 50),
  favorite_category TEXT,
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'friends_only')),
  show_online_status BOOLEAN NOT NULL DEFAULT true,
  honks_received INTEGER NOT NULL DEFAULT 0,
  honks_given INTEGER NOT NULL DEFAULT 0,
  questions_flagged INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(display_name, discriminator)
);
```

#### `player_stats`
```sql
CREATE TABLE player_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  category TEXT NOT NULL,
  questions_answered INTEGER NOT NULL DEFAULT 0,
  correct_answers INTEGER NOT NULL DEFAULT 0,
  games_played INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, category)
);
```

#### `friend_requests`
```sql
CREATE TABLE friend_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL REFERENCES auth.users(id),
  receiver_id UUID NOT NULL REFERENCES auth.users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (sender_id != receiver_id)
);
```

#### `friendships`
```sql
CREATE TABLE friendships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_a UUID NOT NULL REFERENCES auth.users(id),
  user_b UUID NOT NULL REFERENCES auth.users(id),
  source TEXT NOT NULL CHECK (source IN ('lobby', 'search')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_a < user_b),  -- canonical ordering prevents duplicates
  UNIQUE(user_a, user_b)
);
```

#### `game_history`
```sql
CREATE TABLE game_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  room_id UUID NOT NULL,
  category TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  placement INTEGER NOT NULL,
  total_players INTEGER NOT NULL,
  played_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Modified Tables

#### `players` (existing)
```sql
ALTER TABLE players ADD COLUMN user_id UUID REFERENCES auth.users(id);
ALTER TABLE players ADD COLUMN is_spectator BOOLEAN NOT NULL DEFAULT false;
```
- `user_id`: links ephemeral game player to persistent account (NULL for guests)
- `is_spectator`: future-proofing for spectator mode (not used in v1)

### Indexes
```sql
CREATE INDEX idx_profiles_user_id ON profiles(user_id);
CREATE INDEX idx_profiles_display_name ON profiles(display_name);
CREATE INDEX idx_profiles_visibility ON profiles(visibility) WHERE deleted_at IS NULL;
CREATE INDEX idx_player_stats_user_id ON player_stats(user_id);
CREATE INDEX idx_friend_requests_receiver ON friend_requests(receiver_id) WHERE status = 'pending';
CREATE INDEX idx_friend_requests_sender ON friend_requests(sender_id);
CREATE INDEX idx_friendships_user_a ON friendships(user_a);
CREATE INDEX idx_friendships_user_b ON friendships(user_b);
CREATE INDEX idx_game_history_user_id ON game_history(user_id);
CREATE INDEX idx_players_user_id ON players(user_id) WHERE user_id IS NOT NULL;
```

### Row Level Security (RLS) Notes
- `profiles`: Anyone can read public profiles. Friends can read friends-only profiles. Only owner can update.
- `player_stats`: Anyone can read. Only system (via functions) can update.
- `friend_requests`: Sender and receiver can read their own. Only sender can create. Only receiver can update status.
- `friendships`: Both users can read. Created via server function on accept. Either user can delete (unfriend).
- `game_history`: Anyone can read. Created via server function on game completion.

---

## 10. File Changes

### New Files
- `js/profile.js` — Profile page logic, stats rendering, profile editing
- `js/friends.js` — Friends list, search, friend requests, join-friend flow
- `js/presence.js` — Supabase Realtime Presence setup, activity broadcasting
- `profile.html` — Full profile page

### Modified Files
- `js/auth.js` — Add Supabase Auth (email+password), account creation flow, guest upgrade
- `js/supabase.js` — New DB helpers for profiles, stats, friends, game history
- `js/lobby.js` — Profile card on player tap, friend add from lobby, join request handling
- `js/game.js` — Profile card on player tap, honk stats persistence on game end, stats update on game completion
- `js/utils.js` — Avatar rendering update (color+emoji instead of initial+hue)
- `js/honk.js` — Track honks given/received for persistence
- `index.html` — Avatar icon top-left, notification badge, toast system
- `css/style.css` — Profile page, profile card bottom sheet, avatar (color+emoji), friends list, notification badge/toast styles

---

## 11. Title Score Thresholds

Exact thresholds to be tuned after initial data, but starting values:

```
category_score = accuracy × log2(questions_answered)

Novice:     < 20 questions answered (no score calculated)
Apprentice: score ≥ 3.0   (e.g. 70% accuracy × log2(20) ≈ 3.03)
Scholar:    score ≥ 4.5   (e.g. 75% accuracy × log2(80) ≈ 4.75)
Master:     score ≥ 5.5   (e.g. 80% accuracy × log2(200) ≈ 6.13)
Oracle:     score ≥ 6.5   (e.g. 90% accuracy × log2(300) ≈ 7.46)
```

These ensure Oracle tier requires both high accuracy AND significant volume — it should feel rare and earned.

---

## 12. Edge Cases & Rules

1. **Guest taps social feature** → inline account creation modal → action continues after signup
2. **Duplicate display names** → allowed; discriminator makes identity unique
3. **Player in multiple lobbies** → not possible (one active session per player)
4. **Friend request to someone already friends** → no-op, show "Already friends"
5. **Friend request to yourself** → blocked by DB constraint
6. **Deleted account in game history** → shows "Deleted User" with gray default avatar
7. **Friends Only profile in shared lobby** → still visible to lobby members
8. **Honk stats for guests** → not tracked (no persistent profile to store them)
9. **Title with no qualifying categories** → show no title (need ≥20 questions in at least one category)
10. **Session stats on upgrade** → only stats from the current active game session transfer, not historical guest play across multiple sessions
11. **Multiple pending requests between same users** → DB should prevent duplicates; check before creating
12. **Invite Only join request** → auto-expires after 2 minutes if host doesn't respond
13. **Friend goes offline while viewing their status** → Presence channel updates friends list in real-time
14. **Name change** → discriminator stays, all historical references update (display name is always fetched from profile, not stored inline)
