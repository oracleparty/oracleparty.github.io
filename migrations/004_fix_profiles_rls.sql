-- Migration 004: Remove redundant profiles RLS policy
-- The "Profiles: public read" policy already covers anon users for public profiles.
-- Run in Supabase SQL Editor (Dashboard -> SQL Editor -> New Query)

DROP POLICY IF EXISTS "Profiles: anon read public" ON profiles;
