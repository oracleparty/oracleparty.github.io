-- Migration: Add question_started_at column to rooms table
-- This column stores the server timestamp when the question timer starts,
-- enabling server-authoritative timing that survives page refreshes.
--
-- Run this in the Supabase SQL Editor (Dashboard → SQL Editor → New Query)

ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS question_started_at timestamptz;
