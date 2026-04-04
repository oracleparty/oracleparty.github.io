-- Migration 018: Client error logging table
-- Captures unhandled JS errors and promise rejections from the browser.
-- Run in Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)

CREATE TABLE IF NOT EXISTS error_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       TEXT NOT NULL,           -- 'onerror' or 'unhandledrejection'
  message    TEXT,
  source     TEXT,                    -- script URL (onerror only)
  lineno     INT,
  colno      INT,
  stack      TEXT,
  url        TEXT,                    -- page URL where error occurred
  user_agent TEXT,
  timestamp  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-cleanup: drop rows older than 30 days to prevent unbounded growth
-- (Run this as a Supabase cron job or periodically via SQL Editor)
-- DELETE FROM error_logs WHERE timestamp < now() - INTERVAL '30 days';

-- RLS: allow anonymous inserts (errors fire before auth), deny reads except admins
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anyone can insert error logs"
  ON error_logs FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Only admins can read error logs"
  ON error_logs FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.user_id = auth.uid()
      AND profiles.is_admin = true
    )
  );
