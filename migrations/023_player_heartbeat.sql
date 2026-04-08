-- Migration 023: Player heartbeat columns for reconnection resilience
-- Run this in your Supabase SQL Editor (Dashboard > SQL Editor > New query)
--
-- Adds last_seen_at and disconnected_at to the players table.
-- last_seen_at is updated by client heartbeat every 15s.
-- disconnected_at is set by the pagehide/beforeunload beacon (soft signal).
-- Stale cleanup uses these instead of deleting players on page unload,
-- which fixes refresh killing your session.

ALTER TABLE players ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE players ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;

-- Index for stale player queries (find players not seen recently)
CREATE INDEX IF NOT EXISTS idx_players_last_seen ON players(last_seen_at);
