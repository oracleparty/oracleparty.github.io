-- ============================================
-- Migration 038 — keep Room Scores on the room
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- WHAT WAS WRONG
--
-- The lobby's "Room Scores" tally — cumulative points across every game played
-- in one room — lived in sessionStorage on each player's phone. Two
-- consequences, both reported from a playtest:
--
--   1. It died with the tab. Somebody who left and came back saw nothing, even
--      though everyone still in the room could see their own copy.
--   2. Every device kept its OWN tally, computed from what that device happened
--      to witness. A phone that joined for game three had a tally starting at
--      game three, and nothing reconciled the difference. Two people could look
--      at the same lobby and read different numbers with no way to tell which
--      was right.
--
-- One column on the room fixes both: there is one tally, it belongs to the
-- room, and it outlives any particular device. It is deleted with the room,
-- which is correct — a room's scores are not a fact about anything else.
--
-- KEYED ON DISPLAY NAME, not player id, and that is deliberate. A player row is
-- deleted when someone leaves and recreated when they return, so the id is not
-- stable across the very event this is meant to survive. Guests have no account
-- to key on either. Two people sharing a display name in one room will share a
-- line; the lobby already treats that as one person elsewhere.
--
-- WHO WRITES IT: the host only, once per game, from showResultsScreen. Every
-- device computes the same scores from the same answers, so letting all of them
-- add to a shared total would multiply it by the number of phones in the room.
-- This is the same reason recordCurrentQuestionOutcomes is host-gated.
-- ============================================

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS room_scores jsonb NOT NULL DEFAULT '{}'::jsonb;


-- --------------------------------------------
-- VERIFY — should print one row: room_scores | jsonb | '{}'::jsonb
-- --------------------------------------------

SELECT column_name, data_type, column_default
  FROM information_schema.columns
 WHERE table_name = 'rooms'
   AND column_name = 'room_scores';
