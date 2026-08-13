-- ============================================
-- Migration 027 — columns the app writes that the live database never had
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
-- Adds only; nothing is dropped or overwritten.
--
-- Confirmed missing on the live project by scripts/probe-db.mjs:
--     players  ->  is_cohost, last_seen_at, disconnected_at
--     rooms    ->  auto_proceed
--
-- WHY THIS WAS THE "PLAYER VANISHES FROM THE LOBBY" BUG
--
-- checkStalePresence() reads players.last_seen_at to decide who has gone
-- silent. The column does not exist, so the value came back undefined, the
-- code treated that as timestamp 0, and silence computed as the entire Unix
-- epoch — far past any threshold. The host therefore removed every other
-- player on the first presence sync after they joined, seconds later.
--
-- It matched the reported symptoms exactly: the removed player still saw
-- themselves in the lobby (nobody kicks themselves), their chat still arrived
-- (chat does not depend on the player row), refreshing brought them back for
-- a few seconds, and the game could never start.
--
-- The client no longer depends on this column to avoid kicking people — it
-- falls back to joined_at and refuses to judge staleness without a timestamp.
-- These columns still need to exist for the features that use them.
-- ============================================

-- Heartbeat and disconnect tracking (migration 023 was written but never run).
ALTER TABLE players ADD COLUMN IF NOT EXISTS last_seen_at    timestamptz DEFAULT now();
ALTER TABLE players ADD COLUMN IF NOT EXISTS disconnected_at timestamptz;

-- Co-host. promoteToCohost() writes this, so the whole feature was inert:
-- the UPDATE failed and only ever reached the error log.
ALTER TABLE players ADD COLUMN IF NOT EXISTS is_cohost boolean DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen_at);

-- Existing rows predate the column and would otherwise look silent forever.
UPDATE players SET last_seen_at = COALESCE(last_seen_at, joined_at, now());

-- Auto-proceed between rounds, written by the host settings panel.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS auto_proceed integer DEFAULT 0;


-- --------------------------------------------
-- VERIFY — every column should report 1.
-- --------------------------------------------
SELECT
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name='players' AND column_name='last_seen_at')    AS players_last_seen_at,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name='players' AND column_name='disconnected_at') AS players_disconnected_at,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name='players' AND column_name='is_cohost')       AS players_is_cohost,
  (SELECT count(*) FROM information_schema.columns
    WHERE table_name='rooms'   AND column_name='auto_proceed')    AS rooms_auto_proceed;
