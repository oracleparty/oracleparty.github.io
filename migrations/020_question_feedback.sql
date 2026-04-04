-- ============================================
-- Question Feedback table + admin assessment view
-- ============================================

-- Core table: stores every thumbs-up, thumbs-down, and flag per player per question
CREATE TABLE IF NOT EXISTS question_feedback (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  question_id   UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  room_id       TEXT NOT NULL,                     -- room UUID or '__account__' for persistent
  player_name   TEXT NOT NULL,                     -- display name or user UUID
  feedback_type TEXT NOT NULL CHECK (feedback_type IN ('thumbs_up', 'thumbs_down', 'flag')),
  flag_reason   TEXT CHECK (flag_reason IN ('wrong_answer', 'ambiguous', 'offensive', 'alternate_answer', 'other') OR flag_reason IS NULL),
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE (question_id, room_id, player_name)
);

-- Index for fast lookups by room + player (game-start prefetch)
CREATE INDEX IF NOT EXISTS idx_qf_room_player ON question_feedback(room_id, player_name);

-- Index for admin queries: find flagged questions quickly
CREATE INDEX IF NOT EXISTS idx_qf_flagged ON question_feedback(feedback_type, flag_reason) WHERE feedback_type = 'flag';

-- Index for per-question aggregate lookups
CREATE INDEX IF NOT EXISTS idx_qf_question ON question_feedback(question_id);

-- Auto-update updated_at on changes
CREATE OR REPLACE FUNCTION update_qf_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_qf_updated_at
  BEFORE UPDATE ON question_feedback
  FOR EACH ROW EXECUTE FUNCTION update_qf_updated_at();

-- ============================================
-- Admin assessment view: easy-to-read summary
-- ============================================
-- Shows each question with aggregated feedback counts so you can
-- quickly see which questions need attention.

CREATE OR REPLACE VIEW question_feedback_summary AS
SELECT
  q.id                          AS question_id,
  q.question_text,
  q.correct_answer,
  q.category,
  q.subcategory,
  q.difficulty,
  COUNT(*) FILTER (WHERE qf.feedback_type = 'thumbs_up')    AS thumbs_up_count,
  COUNT(*) FILTER (WHERE qf.feedback_type = 'thumbs_down')  AS thumbs_down_count,
  COUNT(*) FILTER (WHERE qf.feedback_type = 'flag')          AS flag_count,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'wrong_answer')    AS flags_wrong_answer,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'ambiguous')       AS flags_ambiguous,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'offensive')       AS flags_offensive,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'alternate_answer') AS flags_alternate_answer,
  COUNT(*) FILTER (WHERE qf.flag_reason = 'other')           AS flags_other,
  COUNT(DISTINCT qf.player_name) FILTER (WHERE qf.room_id != '__account__') AS unique_raters,
  MAX(qf.updated_at)                                         AS last_feedback_at
FROM questions q
LEFT JOIN question_feedback qf ON qf.question_id = q.id
GROUP BY q.id, q.question_text, q.correct_answer, q.category, q.subcategory, q.difficulty;

-- Focused view: only questions with at least one flag, sorted by urgency
CREATE OR REPLACE VIEW flagged_questions AS
SELECT *
FROM question_feedback_summary
WHERE flag_count > 0
ORDER BY flag_count DESC, last_feedback_at DESC;

-- Detailed flag log: every individual flag with player + reason + timestamp
-- Useful for drilling into a specific question
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

-- RLS policies
ALTER TABLE question_feedback ENABLE ROW LEVEL SECURITY;

-- Anyone can insert/update their own feedback
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

-- Anyone can read feedback (needed for prefetch)
CREATE POLICY "Anyone can read feedback"
  ON question_feedback FOR SELECT
  USING (true);
