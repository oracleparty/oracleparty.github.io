-- ============================================================
-- 065 — THE HOST CAN REMOVE A PLAYER, AND OPTIONALLY KEEP THEM OUT
--
-- Asked for by the owner on 2026-09-05: "if someone is bad they need to be
-- removed right and not rejoin".
--
-- THE DATABASE REFUSED THIS UNTIL NOW, DELIBERATELY. Migration 057 allows
-- exactly four removals — you are leaving, the host removes a bot, a duplicate
-- of your own seat, and the stale sweep — and its own comment says why the
-- fifth was missing: "there is no kick feature in this game, and a host being
-- able to remove a live human is a product decision nobody has made." It has
-- been made now, so this adds the rule where a request cannot edit it out.
--
-- TWO ACTIONS, ONE FUNCTION, and the difference is the whole point:
--
--   EJECT  remove them from the room. They can come back with the code.
--   KICK   remove them AND refuse them the room for as long as it exists.
--
-- WHAT KICK HONESTLY IS. The ban is keyed on `auth.uid()` — the identity
-- Supabase issues, which every player has since invisible accounts (slice 8a)
-- — and it is scoped to ONE ROOM. A room survives Play Again, so a kick lasts
-- the whole sitting rather than one game, which is the unit people actually
-- mean. It is NOT a ban from the game: somebody who clears their browser data
-- becomes a new person, and room codes are four letters. It raises the cost of
-- coming back; it does not close the door, and nothing in the app should say
-- otherwise.
--
-- AND A PLAYER WITH NO AUTH IDENTITY CANNOT BE BANNED AT ALL — a guest whose
-- anonymous sign-in failed has no id to key on. That case is REPORTED
-- ('removed_no_ban') rather than silently succeeding, because "we kicked them"
-- and "we removed them and could not keep them out" are different facts and
-- the host is entitled to know which happened. Collapsing those is CLAUDE.md #6
-- exactly.
-- ============================================================

-- --------------------------------------------
-- 1. Where a kick is recorded
--
-- CASCADE to rooms is right here, unlike game_plays (033): a ban is a fact
-- ABOUT one room and means nothing once that room is gone. There is nothing
-- left to point at, and leaving the rows would accumulate debris nobody reads.
-- --------------------------------------------
CREATE TABLE IF NOT EXISTS room_bans (
  room_id   uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL,
  banned_by uuid,
  banned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

-- A NEW TABLE ARRIVES ALREADY GRANTED TO EVERYBODY. Supabase carries
-- ALTER DEFAULT PRIVILEGES handing new tables in `public` to anon and
-- authenticated, and a GRANT adds where only a REVOKE subtracts — migration
-- 063 came back FAIL on exactly this. Nothing but the functions below ever
-- touches this table, so nobody gets anything.
REVOKE ALL ON room_bans FROM anon, authenticated;
ALTER TABLE room_bans ENABLE ROW LEVEL SECURITY;
-- No policies at all, deliberately: with RLS on and nothing permitted, a
-- client reading this table gets nothing and writing it is refused. The two
-- SECURITY DEFINER functions below are the only way in or out.

-- --------------------------------------------
-- 2. Is this person kept out of this room?
--
-- SECURITY DEFINER because it is called FROM A POLICY ON `players`, and a
-- policy runs with the caller's rights — which are none, by the block above.
-- Same arrangement as op_room_has_live_host in 058.
--
-- NULL IS NOT BANNED. A guest whose anonymous sign-in did not land has no
-- auth.uid(), and treating "cannot tell" as "banned" would lock them out of
-- every room in the game — the reverse of this project's standing rule and far
-- worse than the hole it would close.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_is_banned(p_room_id uuid, p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_user_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM room_bans
                  WHERE room_id = p_room_id AND user_id = p_user_id);
$$;

-- --------------------------------------------
-- 3. Removing somebody
--
-- Returns text rather than a boolean, for the reason 057 gives: "not allowed"
-- and "already gone" must not collapse into one answer, or a working guard and
-- a broken one look identical.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_kick_player(
  p_room_id   uuid,
  p_caller_id uuid,
  p_target_id uuid,
  p_ban       boolean DEFAULT false
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target players;
  banned boolean := false;
BEGIN
  SELECT * INTO target FROM players WHERE id = p_target_id AND room_id = p_room_id;
  IF target.id IS NULL THEN
    RETURN 'already gone';
  END IF;

  -- ONLY THE HOST, and never on themselves. A host removing themselves is
  -- leaving, which op_leave_room already does properly (it takes the room with
  -- them when they are the last one); routing it through here would delete the
  -- seat and strand the room.
  IF NOT op_is_room_host(p_room_id, p_caller_id) THEN
    RETURN 'not allowed';
  END IF;
  IF p_caller_id = p_target_id THEN
    RETURN 'not allowed';
  END IF;

  -- A BOT GOES THROUGH op_remove_player, which has allowed it since 057. Two
  -- functions doing one job is how a guard gets fixed in one of them; and
  -- banning a bot is meaningless, since the host adds it themselves.
  IF target.is_bot THEN
    RETURN 'not allowed';
  END IF;

  IF p_ban AND target.user_id IS NOT NULL THEN
    INSERT INTO room_bans (room_id, user_id, banned_by)
    VALUES (p_room_id, target.user_id, (SELECT user_id FROM players WHERE id = p_caller_id))
    ON CONFLICT (room_id, user_id) DO NOTHING;
    banned := true;
  END IF;

  DELETE FROM players WHERE id = p_target_id AND room_id = p_room_id;

  IF p_ban AND NOT banned THEN
    -- Removed, but there was no identity to keep out. Said out loud.
    RETURN 'removed_no_ban';
  END IF;
  RETURN 'removed';
END;
$$;

REVOKE ALL ON FUNCTION op_kick_player(uuid, uuid, uuid, boolean) FROM public;
GRANT EXECUTE ON FUNCTION op_kick_player(uuid, uuid, uuid, boolean) TO anon, authenticated;
REVOKE ALL ON FUNCTION op_is_banned(uuid, uuid) FROM public;
GRANT EXECUTE ON FUNCTION op_is_banned(uuid, uuid) TO anon, authenticated;

-- --------------------------------------------
-- 4. A banned player cannot come back
--
-- RESTRICTIVE, which is the load-bearing word. Permissive policies are ORed
-- together, so a second permissive INSERT policy would ADD a way in rather
-- than take one away — and 058's policy (about claiming the host flag) has to
-- keep working exactly as it does. A restrictive policy is ANDed with all of
-- them, so this narrows without touching 058.
--
-- auth.uid(), never the row's own user_id: the row is written by the client
-- and a banned person would simply omit it.
-- --------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'players'
                    AND policyname = 'Players: a kicked player cannot rejoin') THEN
    EXECUTE 'CREATE POLICY "Players: a kicked player cannot rejoin" ON players'
         || ' AS RESTRICTIVE FOR INSERT TO public'
         || ' WITH CHECK (NOT op_is_banned(room_id, auth.uid()))';
  END IF;
END $$;


-- --------------------------------------------
-- 5. Verify — and PRINT what was seen, pass or fail
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'room_bans exists' AS thing,
    CASE WHEN to_regclass('public.room_bans') IS NULL THEN 'FAIL missing' ELSE 'ok' END AS verdict

  UNION ALL SELECT 2, 'a visitor cannot read who was kicked',
    CASE WHEN has_table_privilege('anon', 'room_bans', 'SELECT')
      THEN 'FAIL anon can read the ban list' ELSE 'ok' END

  UNION ALL SELECT 3, 'a visitor cannot write the ban list',
    CASE WHEN has_table_privilege('anon', 'room_bans', 'INSERT')
      OR has_table_privilege('anon', 'room_bans', 'DELETE')
      THEN 'FAIL anon can ban or unban anybody' ELSE 'ok' END

  UNION ALL SELECT 4, 'op_kick_player installed and callable',
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'NOT CALLABLE — the host cannot remove anybody' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_kick_player'), 'MISSING')

  UNION ALL SELECT 5, 'the rejoin block is RESTRICTIVE',
    COALESCE((SELECT CASE WHEN permissive = 'RESTRICTIVE' THEN 'ok'
                          ELSE 'FAIL it is permissive, so it ADDS a way in instead of removing one' END
              FROM pg_policies WHERE schemaname = 'public' AND tablename = 'players'
                AND policyname = 'Players: a kicked player cannot rejoin'), 'MISSING')

  UNION ALL SELECT 6, 'joining still works for everybody else',
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = 'players'
                        AND cmd IN ('INSERT', 'ALL') AND permissive = 'PERMISSIVE')
    THEN 'ok' ELSE 'FAIL nobody can join a game' END
) report ORDER BY ord;

SELECT schemaname, tablename, policyname, permissive, cmd, roles
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'players'
ORDER BY policyname;
