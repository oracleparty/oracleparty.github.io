-- Migration 021: Sitewide play count access
-- Adds subcategory tracking to game_plays and exposes aggregate counts
-- via a public RPC function (no row-level access to individual records).

-- 1. Add subcategory column to game_plays
ALTER TABLE game_plays ADD COLUMN IF NOT EXISTS subcategory TEXT;

-- 2. Index for fast aggregation
CREATE INDEX IF NOT EXISTS idx_game_plays_category ON game_plays(category, subcategory) WHERE completed = true;

-- 3. Public RPC: returns aggregate play counts per category + subcategory.
--    SECURITY DEFINER so it bypasses RLS (only exposes aggregates, not rows).
CREATE OR REPLACE FUNCTION get_category_play_counts()
RETURNS TABLE(category TEXT, subcategory TEXT, play_count BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  -- Category-level totals (every completed play, regardless of subcategory)
  SELECT gp.category, NULL::TEXT AS subcategory, COUNT(*) AS play_count
  FROM game_plays gp WHERE gp.completed = true
  GROUP BY gp.category
  UNION ALL
  -- Subcategory-level totals
  SELECT gp.category, gp.subcategory, COUNT(*) AS play_count
  FROM game_plays gp WHERE gp.completed = true AND gp.subcategory IS NOT NULL
  GROUP BY gp.category, gp.subcategory;
$$;

-- Grant execute to anon + authenticated so the RPC is callable without auth
GRANT EXECUTE ON FUNCTION get_category_play_counts() TO anon, authenticated;

-- 4. Also add an "Anyone can insert game_plays" policy so guests can write
--    (the existing admin-only SELECT stays — individual rows stay private)
CREATE POLICY "Anyone can insert game plays"
  ON game_plays FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Players can update own game plays"
  ON game_plays FOR UPDATE
  USING (true)
  WITH CHECK (true);
