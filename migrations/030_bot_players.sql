-- ============================================
-- Migration 030 — practice bots
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- Adds one column. A bot is an ordinary row in `players` with this flag set,
-- so it appears in the lobby, on the scoreboard and in the reveal exactly like
-- anyone else, and nothing needed a new table.
--
-- The flag is load-bearing in four places:
--
--   1. The host's browser answers on a bot's behalf, and needs to know which
--      rows are its responsibility.
--   2. Bots send no heartbeat, so the stale-player sweep would otherwise
--      remove them mid-game, and the presence check would show them as away.
--   3. Nothing a bot does is recorded — not to question_stats, not to
--      answer_tally, not to anyone's stats. A bot's answers come from a
--      percentage somebody chose, so counting them would put that invented
--      number into the one source of real data the question bank has.
--   4. A bot is never host or co-host.
--
-- WHY A COLUMN AND NOT A NAME CHECK
--
-- Recognising bots by display name would mean a player calling themselves
-- "Practice Bot" inherits all of the above, including being skipped by the
-- stale sweep and excluded from the data. The flag is set by whoever creates
-- the row and cannot be spoofed into existence by typing a name.
-- ============================================

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS is_bot boolean NOT NULL DEFAULT false;

-- --------------------------------------------
-- VERIFY — should return one row reading is_bot / boolean.
-- --------------------------------------------

SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'players' AND column_name = 'is_bot';
