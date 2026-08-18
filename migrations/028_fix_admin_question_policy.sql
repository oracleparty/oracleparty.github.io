-- Migration 028: repair the admin write policy on questions
--
-- Run this in the Supabase SQL Editor (Dashboard > SQL Editor > New query).
--
-- WHAT IS WRONG
--
-- Migration 024 added a policy meant to let a signed-in admin edit questions.
-- Its predicate is:
--
--     EXISTS (SELECT 1 FROM profiles p WHERE p.id = auth.uid() AND p.is_admin)
--
-- The profiles table has BOTH an `id` and a `user_id` column, and it is
-- `user_id` that holds the authenticated user's id. Every other policy in this
-- project -- migrations 003, 007, 009, 011, 018 and 019 -- matches on
-- profiles.user_id, and js/admin.js reads the signed-in profile by user_id as
-- well. Comparing auth.uid() to profiles.id therefore matches no row, for
-- anybody, including the owner.
--
-- So the exact bug migration 024 was written to fix is still in place: an
-- admin edits a question or removes a flagged one, RLS discards the write with
-- zero rows affected and NO error, and nothing is saved. The admin page now
-- catches that and says "Permission denied" instead of the old false "Saved!",
-- which is honest but still not a working feature.
--
-- Nothing here loosens access for players. Visitors remain unable to write to
-- questions at all, which the database probe confirms independently.

DROP POLICY IF EXISTS "Questions: admins can update" ON questions;

CREATE POLICY "Questions: admins can update"
  ON questions FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.user_id = auth.uid() AND p.is_admin = true
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.user_id = auth.uid() AND p.is_admin = true
    )
  );


-- --------------------------------------------
-- VERIFY
--
-- This should return one row reading "PASS". If it says FAIL, or returns no
-- rows at all, the policy did not take and admin edits will still save
-- nothing -- send the output back rather than assuming it worked.
-- --------------------------------------------

SELECT
  policyname,
  CASE
    WHEN qual::text LIKE '%user_id%' AND qual::text NOT LIKE '%p.id =%'
      THEN 'PASS - the policy matches profiles.user_id'
    ELSE 'FAIL - still matching the wrong column'
  END AS verdict,
  qual::text AS using_clause
FROM pg_policies
WHERE tablename = 'questions' AND cmd = 'UPDATE';
