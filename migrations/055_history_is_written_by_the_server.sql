-- ============================================
-- 055 — QUESTION HISTORY IS WRITTEN BY THE SERVER, NOT BY THE PLAYER
--
-- Needs 041 and 043 (both applied — verified 2026-08-28).
--
-- THE HOLE. Every number this app shows about a player — proficiency, mastery,
-- the tier badge in every lobby, every title unlock, and now the whole
-- leaderboard — is derived from `question_history`. Migration 011 gave clients
-- these two policies:
--
--     INSERT WITH CHECK (user_id = auth.uid())
--     UPDATE USING      (user_id = auth.uid())
--
-- Every browser carries the publishable key by necessity, because guests play
-- without signing in. So any signed-in person could set their own
-- `times_correct`, `last_correct` and `times_seen` to anything they liked, for
-- every question in the bank, in ONE request. Not by playing, not by cheating
-- at a game — by writing the number down.
--
-- The owner rebuilt the leaderboard as friends-only on the argument that
-- removing the prize removes most of the reason to fake anything, and that is
-- right about INCENTIVE. It does not close the door, and CLAUDE.md records that
-- counter-argument as the strongest one against the redesign. This closes it.
--
-- WHAT THIS DOES NOT DO, and must not be claimed to. A host may override the
-- machine's verdict — that is a feature, and it is how a real answer the fuzzy
-- matcher rejected gets counted. So somebody hosting a solo game can still mark
-- themselves right every round and their history is honestly recorded. This
-- turns "one request sets any number" into "you have to sit through the game",
-- which is a real cost and not an impossibility. The owner already named that
-- ceiling and accepted it.
--
-- WHAT WAS WALKING THROUGH THE DOOR. Migration 049 shut one of these and broke
-- Play Again, rejoining and practice bots — silently, with every test passing —
-- because it was written about the writes that were dangerous rather than about
-- ALL the writes. So this was written the other way round: `js/` was grepped
-- first, and every writer of `question_history` enumerated.
--
--   | Writer                    | Route                        | After this |
--   |---------------------------|------------------------------|------------|
--   | recordRoundHistory        | record_round_history (043)   | unaffected |
--   | amendQuestionHistory      | amend_question_history (041) | unaffected |
--   | revokeQuestionHistory     | revoke_question_history (041)| unaffected |
--   | upsertQuestionHistory     | DIRECT INSERT/UPDATE         | REFUSED    |
--
-- All three survivors are SECURITY DEFINER, so they run with the table owner's
-- rights and are unaffected by policies — the same arrangement `question_health`
-- and `host_reputation` already use. That is asserted below rather than assumed.
--
-- The single direct writer is the fallback in `doReveal` for the case where
-- `record_round_history` is unreachable, and it was already close to worthless:
-- EVERY device in the room calls the function and the first one does the work,
-- so one phone's failure loses nothing, while the fallback only ever wrote that
-- one phone's own row. It stays in the client, because a fallback that reports
-- a refusal loudly is better than no attempt at all — but its log message now
-- names this migration, so the next session does not chase a phantom.
--
-- SELECT STAYS PUBLIC. The host's browser reads every player's history to shape
-- question selection (`fetchQuestionHistoryForUsers`), so a restrictive read
-- policy would silently revert every player to a plain shuffle.
-- ============================================


-- --------------------------------------------
-- 1. Shut the write door
--
-- BY LOOKING, NEVER BY NAME. The live policy names are not always the ones the
-- migrations declare — 049's drops named policies that did not exist, the
-- `IF EXISTS` made that a NOTICE rather than an error, and the door stayed wide
-- open for days while the migration reported success.
--
-- A policy written FOR ALL has cmd = 'ALL' and grants INSERT as a side effect,
-- so it has to go too — which means the SELECT the app depends on is recreated
-- FIRST, in case dropping an ALL policy takes reading with it.
-- --------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public'
                    AND tablename = 'question_history'
                    AND cmd = 'SELECT') THEN
    EXECUTE 'CREATE POLICY "Question history: public read" '
            'ON question_history FOR SELECT USING (true)';
  END IF;

  FOR pol IN SELECT policyname FROM pg_policies
              WHERE schemaname = 'public'
                AND tablename = 'question_history'
                AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY %I ON question_history', pol.policyname);
  END LOOP;
END $$;


-- --------------------------------------------
-- 2. Verify — by looking, and printing what was seen
--
-- 048's verification could not have caught 049's bug happening to it: it
-- checked `cmd = 'DELETE'`, and a FOR ALL policy reads as 'ALL'. So every check
-- here tests the set of commands that actually grant the right, and the policy
-- list is printed on every run whether it passes or not — settling the last one
-- of these cost a round trip to the owner that looking would have saved.
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord,
    'players cannot write their own history' AS thing,
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'question_history'
         AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL'))
    THEN 'FAIL a policy still lets clients write it' ELSE 'ok' END AS verdict

  UNION ALL SELECT 2,
    'the app can still READ history (question selection)',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'question_history'
         AND cmd IN ('SELECT', 'ALL'))
    THEN 'ok' ELSE 'FAIL selection will fall back to a plain shuffle' END

  UNION ALL SELECT 3,
    'row level security is actually on',
    CASE WHEN (SELECT relrowsecurity FROM pg_class
                WHERE oid = 'public.question_history'::regclass)
    THEN 'ok' ELSE 'FAIL policies are not being enforced at all' END

  UNION ALL SELECT 4,
    'the three server writers survive (SECURITY DEFINER)',
    COALESCE((
      SELECT CASE WHEN count(*) = 3 THEN 'ok'
                  ELSE 'FAIL only ' || count(*) || ' of 3 are definer-rights' END
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
        AND p.prosecdef
        AND p.proname IN ('record_round_history',
                          'amend_question_history',
                          'revoke_question_history')), 'FAIL none found')

  UNION ALL SELECT 5,
    'those three are not owned by a role RLS still applies to',
    COALESCE((
      SELECT CASE WHEN bool_and(NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
                  THEN 'ok' ELSE 'FAIL the owner is forced through RLS too' END
      FROM pg_class c WHERE c.oid = 'public.question_history'::regclass), 'ok')
) report ORDER BY ord;

SELECT schemaname, tablename, policyname, cmd, roles, qual
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'question_history'
ORDER BY policyname;
