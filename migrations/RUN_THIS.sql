-- ============================================
-- RUN THIS ENTIRE BLOCK IN SUPABASE SQL EDITOR
-- ============================================

-- PART 1: Question Feedback table

CREATE TABLE IF NOT EXISTS question_feedback (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  question_id   UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  room_id       TEXT NOT NULL,
  player_name   TEXT NOT NULL,
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('thumbs_up', 'thumbs_down', 'flag')),
  flag_reason   TEXT CHECK (flag_reason IN ('wrong_answer', 'ambiguous', 'offensive', 'alternate_answer', 'other') OR flag_reason IS NULL),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (question_id, room_id, player_name)
);

CREATE INDEX IF NOT EXISTS idx_qf_room_player ON question_feedback(room_id, player_name);
CREATE INDEX IF NOT EXISTS idx_qf_flagged ON question_feedback(feedback_type, flag_reason) WHERE feedback_type = 'flag';
CREATE INDEX IF NOT EXISTS idx_qf_question ON question_feedback(question_id);

CREATE OR REPLACE FUNCTION update_qf_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_qf_updated_at ON question_feedback;
CREATE TRIGGER trg_qf_updated_at
  BEFORE UPDATE ON question_feedback
  FOR EACH ROW EXECUTE FUNCTION update_qf_updated_at();

-- PART 2: Admin views for assessing feedback

CREATE OR REPLACE VIEW question_feedback_summary AS
SELECT
  q.id AS question_id,
  q.question_text,
  q.correct_answer,
  q.category,
  q.subcategory,
  q.difficulty,
  COUNT(*) FILTER (WHERE qf.feedback_type = 'thumbs_up') AS thumbs_up_count,
  COUNT(*) FILTER (WHERE qf.feedback_type = 'thumbs_down') AS thumbs_down_count,
  COUNT(*) FILTER (WHERE qf.feedback_type = 'flag') AS flag_count,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'wrong_answer') AS flags_wrong_answer,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'ambiguous') AS flags_ambiguous,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'offensive') AS flags_offensive,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'alternate_answer') AS flags_alternate_answer,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'other') AS flags_other,
  COUNT(DISTINCT qf.player_name) FILTER (WHERE qf.room_id != '__account__') AS unique_raters,
  MAX(qf.updated_at) AS last_feedback_at
FROM questions q
LEFT JOIN question_feedback qf ON qf.question_id = q.id
GROUP BY q.id, q.question_text, q.correct_answer, q.category, q.subcategory, q.difficulty;

CREATE OR REPLACE VIEW flagged_questions AS
SELECT *
FROM question_feedback_summary
WHERE flag_count > 0
ORDER BY flag_count DESC, last_feedback_at DESC;

CREATE OR REPLACE VIEW flag_detail_log AS
SELECT
  qf.question_id,
  q.question_text,
  q.correct_answer,
  q.category,
  qf.player_name,
  qf.flag_reason,
  qf.room_id,
  qf.created_at,
  qf.updated_at
FROM question_feedback qf
JOIN questions q ON q.id = qf.question_id
WHERE qf.feedback_type = 'flag'
ORDER BY qf.updated_at DESC;

-- PART 3: RLS policies for feedback

ALTER TABLE question_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Players can insert own feedback"
  ON question_feedback FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Players can update own feedback"
  ON question_feedback FOR UPDATE
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Players can delete own feedback"
  ON question_feedback FOR DELETE
  USING (true);

CREATE POLICY "Anyone can read feedback"
  ON question_feedback FOR SELECT
  USING (true);

-- PART 4: Add subcategory to game_plays

ALTER TABLE game_plays ADD COLUMN IF NOT EXISTS subcategory TEXT;

CREATE INDEX IF NOT EXISTS idx_game_plays_category ON game_plays(category, subcategory) WHERE completed = true;

-- PART 5: Play count function (sitewide, never resets)

CREATE OR REPLACE FUNCTION get_category_play_counts()
RETURNS TABLE(category TEXT, subcategory TEXT, play_count BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT gp.category, NULL::TEXT AS subcategory, COUNT(*) AS play_count
  FROM game_plays gp WHERE gp.completed = true
  GROUP BY gp.category
  UNION ALL
  SELECT gp.category, gp.subcategory, COUNT(*) AS play_count
  FROM game_plays gp WHERE gp.completed = true AND gp.subcategory IS NOT NULL
  GROUP BY gp.category, gp.subcategory;
$$;

GRANT EXECUTE ON FUNCTION get_category_play_counts() TO anon, authenticated;

-- PART 6: Let guests write game plays

CREATE POLICY "Anyone can insert game plays"
  ON game_plays FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Players can update own game plays"
  ON game_plays FOR UPDATE
  USING (true)
  WITH CHECK (true);
