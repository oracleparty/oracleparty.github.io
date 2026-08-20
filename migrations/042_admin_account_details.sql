-- ============================================
-- Migration 042 — let an admin see who an account actually is
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- WHY A FUNCTION
--
-- The admin dashboard lists accounts from `profiles`, which holds a display
-- name and nothing that identifies a person. Email, sign-up method and whether
-- anyone ever confirmed the address all live in `auth.users`, which PostgREST
-- does not expose and must not — every player's browser carries the same
-- publishable key, so a readable auth.users would be a public mailing list.
--
-- This is the question it exists to answer: a dashboard reading eleven
-- accounts, most of them called "New Player", cannot tell whether those are
-- real people or abandoned sign-ups. last_sign_in_at and email_confirmed_at
-- answer that immediately, and neither is guessable from anything the app
-- already stores.
--
-- ONE ACCOUNT AT A TIME, ON PURPOSE
--
-- A function returning every email at once would put the whole list on screen
-- for anybody who opened the page, including over a shoulder. This returns one
-- account, so an email appears only after a deliberate tap on that person.
--
-- THE GUARD is migration 037's, exactly: the caller must be signed in and hold
-- is_admin, checked against profiles.user_id — NEVER profiles.id. The profiles
-- table has both, user_id is the one holding the auth id, and comparing the
-- wrong one produced a policy that matched no row for anybody while looking
-- perfectly installed (CLAUDE.md #5). tests/migration-policies.test.js fails on
-- that mistake now.
--
-- GRANTED TO `authenticated` ONLY. anon has no auth.uid() and would hit the
-- first guard anyway, but a grant that can only ever fail is still one more
-- thing pointed at auth.users than needs to be.
-- ============================================

CREATE OR REPLACE FUNCTION admin_account_details(p_user_id uuid)
RETURNS TABLE (
  email             text,
  provider          text,
  email_confirmed   boolean,
  last_sign_in_at   timestamptz,
  signed_up_at      timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller uuid := auth.uid();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'admin_account_details: not signed in';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM profiles p
     WHERE p.user_id = v_caller      -- user_id, never id. See CLAUDE.md #5.
       AND p.is_admin IS TRUE
  ) THEN
    RAISE EXCEPTION 'admin_account_details: not an admin';
  END IF;

  RETURN QUERY
  SELECT
    u.email::text,
    -- Google or email-and-password. Stored under app_metadata by GoTrue.
    COALESCE(u.raw_app_meta_data ->> 'provider', 'email')::text,
    (u.email_confirmed_at IS NOT NULL),
    u.last_sign_in_at,
    u.created_at
  FROM auth.users u
  WHERE u.id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION admin_account_details(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION admin_account_details(uuid) TO authenticated;


-- --------------------------------------------
-- VERIFY — should print the function, 'DEFINER', and 1 argument.
-- --------------------------------------------

SELECT p.proname,
       CASE WHEN p.prosecdef THEN 'DEFINER' ELSE 'INVOKER' END AS runs_as,
       p.pronargs AS argument_count
  FROM pg_proc p
 WHERE p.proname = 'admin_account_details';
