-- Migration 006: Track used question IDs across games in the same room.
-- Prevents repeats when players use "Play Again" in the same lobby.
-- Run in Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS used_question_ids UUID[] DEFAULT '{}';
