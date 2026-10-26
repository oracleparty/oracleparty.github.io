-- 074 — a locked final wager names no question, and the live table refused it
--
-- Reported 2026-10-26: on the final-wager screen every player read "Waiting..."
-- for the whole game, even after they had locked.
--
-- MEASURED, by the CI probe on 0403654: inserting an answer row with
-- question_id NULL on the live database answers
--
--     null value in column "question_id" of relation "answers"
--     violates not-null constraint
--
-- `answers` predates migrations/, so that constraint is in no file here, and
-- the scratch schema and the robots' store both allow NULL — which is why every
-- check passed.
--
-- Since c803c84 (2026-09-09) lockInFinalWager writes its __WAGER_LOCKED__ row
-- with question_id NULL, deliberately: when a wager is locked nobody knows which
-- question it will be against, because the final question is swapped for one
-- matching the difficulty vote AFTER the wagers are in. Naming the old one made
-- 066's stale-row rule overwrite a locked 20 with 0. NULL is what every rule
-- here already reads as "cannot tell, keep it".
--
-- So every lock since then was refused, the refusal reached only a log, and
-- nobody's wager ever appeared on anybody's screen. The game still scored:
-- the final answer carries the wager itself, so the loss was the display and
-- the "locked is locked" rule, not points.
--
-- Nothing reads question_id as required: answersForCurrentGame keeps a NULL row,
-- 066's stale clause requires IS NOT NULL so it cannot touch one, and the
-- __WAGER_LOCKED__ clause stamps the real question when it converts the row.

ALTER TABLE public.answers ALTER COLUMN question_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- VERIFICATION — a SELECT, so the answer lands in the results grid. It should
-- read ok.
-- ---------------------------------------------------------------------------

SELECT 'a locked wager can be saved (answers.question_id allows NULL)' AS check,
       CASE WHEN is_nullable = 'YES' THEN 'ok' ELSE 'FAIL — still NOT NULL' END AS result
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'answers' AND column_name = 'question_id';
