-- Add subcategory tracking to stats and game history tables.
-- Each game writes TWO stats rows: one for the overall category (subcategory=NULL)
-- and one for the specific subcategory (if set). This preserves category-level
-- leaderboards while enabling subcategory breakdowns.

-- player_stats: add subcategory column
ALTER TABLE player_stats ADD COLUMN IF NOT EXISTS subcategory TEXT;

-- Update unique constraint to include subcategory (NULL = overall category)
ALTER TABLE player_stats DROP CONSTRAINT IF EXISTS player_stats_user_id_category_key;
ALTER TABLE player_stats ADD CONSTRAINT player_stats_user_id_category_subcategory_key
  UNIQUE NULLS NOT DISTINCT (user_id, category, subcategory);

-- game_history: add subcategory column
ALTER TABLE game_history ADD COLUMN IF NOT EXISTS subcategory TEXT;
