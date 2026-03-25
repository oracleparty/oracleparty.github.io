-- Migration 005: Denormalize avatar + title on players table
-- Copies avatar_color, avatar_emoji, title from profiles when a user joins a room.
-- Guests have these as NULL (rendering falls back to initial-letter circle).
-- Run in Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)

ALTER TABLE players
  ADD COLUMN IF NOT EXISTS avatar_color TEXT,
  ADD COLUMN IF NOT EXISTS avatar_emoji TEXT,
  ADD COLUMN IF NOT EXISTS title TEXT;
