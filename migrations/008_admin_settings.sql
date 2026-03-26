-- Migration 008: Admin infrastructure
-- Adds is_admin flag to profiles + site_settings table for feature flags/announcements.
-- Run in Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)

-- 1. Admin flag on profiles
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

-- 2. Site settings (key-value store for feature flags, announcements, etc.)
CREATE TABLE IF NOT EXISTS site_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- After running this migration, set yourself as admin:
-- UPDATE profiles SET is_admin = true WHERE display_name = 'YourName';
