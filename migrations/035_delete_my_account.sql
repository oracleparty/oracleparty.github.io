-- ============================================
-- Migration 035 — let a player delete their own account and data
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- WHY A DATABASE FUNCTION AND NOT CLIENT CODE
--
-- Two reasons, and the second is the important one.
--
--   1. A browser cannot delete its own row from auth.users. That table is not
--      exposed to the client at all, so without this the account itself would
--      survive every "deletion" and the player could still sign in.
--
--   2. Deleting across seven tables from the client means seven separate
--      writes that can each fail on their own. A player who taps delete and
--      loses signal halfway is left half-deleted, with no way to tell and no
--      way to finish. Inside one function it is one transaction: all of it, or
--      none of it.
--
-- THE SECURITY PROPERTY THAT MATTERS
--
-- This takes NO ARGUMENTS. It reads auth.uid() and nothing else, so the only
-- account it can ever delete is the one making the call. A p_user_id parameter
-- on a SECURITY DEFINER function would have been a button for deleting anyone
-- else's account, and that mistake is invisible in testing because it works
-- perfectly for the person testing it.
--
-- It is SECURITY DEFINER because it has to reach auth.users, which is exactly
-- why the no-arguments rule is not negotiable.
--
-- WHAT IS DELETED
--
--   profiles, player_stats, question_history, game_history, title_unlocks,
--   friend_requests (sent AND received), friendships (either side), and the
--   auth.users row itself.
--
--   question_feedback rows are keyed on voter_id, which is 'user:<uuid>' for a
--   signed-in player, so those go too.
--
-- WHAT SURVIVES, DELIBERATELY, AND THE PRIVACY POLICY MUST SAY SO
--
--   game_plays keeps the display name used at the time, because it is the
--   sitewide play counter and has no account link to delete by. Once the
--   account is gone that name points at nobody: no email, no profile, no
--   history. Scrubbing it by matching display names would delete other
--   people's records, since names are not unique — that is what the
--   discriminator exists for.
--
--   answer_tally and question_stats hold no identity at all, by design
--   (migrations 025 and 029). Nothing to delete.
--
--   chat_archive stores messages under a display name, not a user id.
-- ============================================

CREATE OR REPLACE FUNCTION delete_my_account()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  -- A guest has no account to delete. Refuse loudly rather than quietly
  -- deleting nothing and reporting success, which is the failure mode this
  -- whole codebase keeps running into.
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'delete_my_account: not signed in';
  END IF;

  DELETE FROM question_feedback WHERE voter_id = 'user:' || v_uid::text;
  DELETE FROM title_unlocks     WHERE user_id = v_uid;
  DELETE FROM question_history  WHERE user_id = v_uid;
  DELETE FROM game_history      WHERE user_id = v_uid;
  DELETE FROM player_stats      WHERE user_id = v_uid;
  DELETE FROM friend_requests   WHERE sender_id = v_uid OR receiver_id = v_uid;
  DELETE FROM friendships       WHERE user_a = v_uid OR user_b = v_uid;
  DELETE FROM profiles          WHERE user_id = v_uid;

  -- Last, because everything above is keyed on it. Signing in again is
  -- impossible after this: the account no longer exists.
  DELETE FROM auth.users WHERE id = v_uid;
END;
$$;

-- authenticated only. `anon` has no auth.uid(), so granting it would only ever
-- produce the exception above — an execute grant that can do nothing is still
-- one more thing pointed at auth.users than needs to be.
REVOKE ALL ON FUNCTION delete_my_account() FROM public, anon;
GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;


-- --------------------------------------------
-- VERIFY — should print the function name and 'DEFINER', and 0 arguments.
-- The argument count is the one that matters: any number above zero means the
-- function can be pointed at somebody else's account.
-- --------------------------------------------

SELECT p.proname,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS runs_as,
       p.pronargs AS argument_count
  FROM pg_proc p
 WHERE p.proname = 'delete_my_account';
