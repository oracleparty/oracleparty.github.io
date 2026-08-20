-- ============================================
-- Migration 037 — let an admin delete somebody else's account
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- WHY A SECOND FUNCTION
--
-- delete_my_account() (migration 035) takes no arguments on purpose: it reads
-- auth.uid() and can therefore only ever delete the caller. That is exactly
-- what makes it safe, and exactly why it cannot be reused here. Deleting
-- somebody else needs a user id passed in, which is a far more dangerous
-- shape, so it gets its own function with its own guards rather than loosening
-- the safe one.
--
-- THE THREE GUARDS, AND WHY EACH EXISTS
--
--   1. The caller must be signed in and an admin. Checked against
--      profiles.user_id = auth.uid(), NOT profiles.id. The profiles table has
--      both columns and user_id is the one holding the auth id; migration 024
--      compared the wrong one, matched no row for anybody, and granted nothing
--      while looking perfectly installed in the dashboard. See CLAUDE.md #5.
--      tests/migration-policies.test.js fails on that mistake now.
--
--   2. It refuses to delete the caller. An admin tapping their own row in a
--      list of accounts would otherwise erase themselves — including their own
--      admin rights — with the same tap they use on anyone else. Their own
--      Delete Account button on the profile page is the deliberate route.
--
--   3. It refuses to delete another admin. This is a safety rail, not a
--      permission model: it means no admin can remove another in one tap, and
--      it makes locking yourself out of the dashboard take two deliberate
--      steps. Lift it by clearing that person's is_admin flag first.
--
-- Deletes exactly what delete_my_account() does. Keeping the two lists
-- identical matters — if one grows a table the other does not, "delete my
-- account" and "admin deleted my account" quietly stop meaning the same thing.
-- ============================================

CREATE OR REPLACE FUNCTION admin_delete_account(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'admin_delete_account: not signed in';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.user_id = v_caller      -- user_id, never id. See CLAUDE.md #5.
       AND p.is_admin IS TRUE
  ) THEN
    RAISE EXCEPTION 'admin_delete_account: not an admin';
  END IF;

  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'admin_delete_account: no account given';
  END IF;

  IF p_user_id = v_caller THEN
    RAISE EXCEPTION 'admin_delete_account: use Delete Account on your own profile';
  END IF;

  IF EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.user_id = p_user_id
       AND p.is_admin IS TRUE
  ) THEN
    RAISE EXCEPTION 'admin_delete_account: remove their admin rights first';
  END IF;

  DELETE FROM question_feedback WHERE voter_id = 'user:' || p_user_id::text;
  DELETE FROM title_unlocks     WHERE user_id = p_user_id;
  DELETE FROM question_history  WHERE user_id = p_user_id;
  DELETE FROM game_history      WHERE user_id = p_user_id;
  DELETE FROM player_stats      WHERE user_id = p_user_id;
  DELETE FROM friend_requests   WHERE sender_id = p_user_id OR receiver_id = p_user_id;
  DELETE FROM friendships       WHERE user_a = p_user_id OR user_b = p_user_id;
  DELETE FROM profiles          WHERE user_id = p_user_id;
  DELETE FROM auth.users        WHERE id = p_user_id;
END;
$$;

-- authenticated only. anon has no auth.uid() and would hit the first guard,
-- but a grant that can only ever fail is still one more thing pointed at
-- auth.users than needs to be.
REVOKE ALL ON FUNCTION admin_delete_account(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION admin_delete_account(uuid) TO authenticated;


-- --------------------------------------------
-- VERIFY — should print the function, 'DEFINER', and 1 argument.
--
-- One argument is correct HERE, unlike delete_my_account which must have
-- zero. The difference is the guards above: this function is only safe
-- because it checks who is asking before it uses that argument.
-- --------------------------------------------

SELECT p.proname,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS runs_as,
       p.pronargs AS argument_count
  FROM pg_proc p
 WHERE p.proname IN ('admin_delete_account', 'delete_my_account')
 ORDER BY p.proname;
