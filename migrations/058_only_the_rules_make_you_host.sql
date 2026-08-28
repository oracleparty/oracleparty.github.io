-- ============================================
-- 058 — SLICE 10: ONLY THE RULES MAKE YOU HOST
--
-- Needs 057.
--
-- THE HOLE, and it is the biggest one left. `players` has
-- `FOR UPDATE USING (true)`, so anyone who can reach the site can set
-- `is_host = true` on their own row in any live game. A host is not a cosmetic
-- badge here: they override the machine's verdict on any answer, and migration
-- 041 makes that override amend the PERMANENT `question_history` of every
-- player it touches. So one request took over somebody else's game and let the
-- taker rewrite other people's records.
--
-- It also closed the door 057 left ajar in two steps: with UPDATE open, you
-- could backdate another player's `last_seen_at` and have the stale sweep
-- remove them for you.
--
-- THE MECHANISM IS COLUMN-LEVEL GRANTS, NOT A FUNCTION PER WRITE, and that is
-- worth explaining because it is unlike every other slice here. Postgres
-- enforces column privileges INDEPENDENTLY of RLS: with
-- `GRANT UPDATE (a, b)` and no table-wide grant, `UPDATE ... SET c = ...` is
-- refused outright. Measured against a real Postgres before this was written,
-- not assumed:
--
--   UPDATE players SET last_seen_at = now()   granted column     -> allowed
--   UPDATE players SET is_host = true         ungranted column   -> refused
--
-- That matters more than tidiness. Wrapping the heartbeat in an RPC would have
-- changed a write that runs every 15 seconds on every phone, and wrapping
-- `disconnected_at` was not even possible: it is written by a keepalive fetch
-- during page unload, which cannot await anything. Column grants leave both
-- exactly as they are and still make the role unwritable.
--
-- WHAT CLIENTS MAY STILL WRITE, and why each has to stay:
--
--   last_seen_at     the 15-second heartbeat — revoke it and every player in
--                    every room is swept as stale within two minutes
--   disconnected_at  the unload beacon, which cannot go through an RPC
--   is_ready         the lobby's ready toggle
--
-- WHAT THIS DOES NOT DO. `last_seen_at` is still writable by anybody FOR
-- anybody, so the two-step sweep above is not fully closed — it is narrowed to
-- one column. Restricting it to your own row needs `user_id = auth.uid()` in
-- the policy, which is only safe once invisible accounts are known reliable in
-- production; a guest whose anonymous sign-in failed would otherwise stop being
-- able to heartbeat at all, and be swept out of their own game. Its own slice,
-- deliberately.
--
-- EVERY UPDATE IN `js/` WAS ENUMERATED FIRST (049's lesson):
--
--   js/db/players.js:184,189   promoteToHost — clears the room, then sets
--   js/db/players.js:200       demote
--   js/db/players.js:208,216   co-host grant / revoke
--   js/db/players.js:317       playerHeartbeat        (column-granted)
--   js/db/players.js:345       setPlayerReady         (column-granted)
--   js/db/players.js:296       markDisconnectedBeacon (column-granted)
-- ============================================


-- --------------------------------------------
-- 1. Does this room still have a host who is actually here?
--
-- SECURITY DEFINER so it can be used inside a policy on `players` without RLS
-- recursing into itself.
--
-- CANNOT TELL MEANS HERE. A host row with no timestamp at all counts as
-- present — the same rule as everywhere else in this project. Treating absence
-- of evidence as evidence of absence once had hosts kicking every player in the
-- room seconds after they joined.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_room_has_live_host(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM players p
     WHERE p.room_id = p_room_id
       AND p.is_host
       AND NOT coalesce(p.is_bot, false)
       AND (
         (p.last_seen_at IS NULL AND p.joined_at IS NULL)
         OR now() - coalesce(p.last_seen_at, p.joined_at) < interval '120 seconds'
       )
  );
$$;

GRANT EXECUTE ON FUNCTION op_room_has_live_host(uuid) TO anon, authenticated;


-- --------------------------------------------
-- 2. Grant or take the role
--
-- Allowed when the caller IS the current host — a deliberate transfer — or when
-- the room has no live host at all, which is the promotion path after somebody
-- has gone. Never when a live host is sitting there and the caller is not them.
-- --------------------------------------------
-- p_role is 'host' or 'cohost'. Kept OUT of the parameter list as an inline
-- comment: scripts/check-rpc-args.mjs reads these declarations to compare them
-- against every .rpc() call, and a comment between two parameters made it stop
-- reading — it reported p_value as undeclared, which is exactly the shape of
-- the fault it exists to catch (PostgREST answers 404 to an unknown argument
-- name, and the client reads that as "not installed" and silently falls back).
CREATE OR REPLACE FUNCTION op_set_host_role(
  p_room_id   uuid,
  p_caller_id uuid,
  p_target_id uuid,
  p_role      text,
  p_value     boolean
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller players;
  target players;
BEGIN
  IF p_role NOT IN ('host', 'cohost') THEN
    RETURN 'not a role';
  END IF;

  SELECT * INTO target FROM players WHERE id = p_target_id AND room_id = p_room_id;
  IF target.id IS NULL THEN
    RETURN 'not in this room';
  END IF;
  SELECT * INTO caller FROM players WHERE id = p_caller_id AND room_id = p_room_id;
  IF caller.id IS NULL THEN
    RETURN 'not in this room';
  END IF;

  -- A BOT IS NEVER HOST OR CO-HOST. A room whose host is a bot is a room
  -- nobody can start, advance or judge — the owner's rule, stated here where a
  -- request cannot edit it out rather than only in the client's render.
  IF p_value AND coalesce(target.is_bot, false) THEN
    RETURN 'not allowed';
  END IF;

  IF NOT (op_is_room_host(p_room_id, p_caller_id) OR NOT op_room_has_live_host(p_room_id)) THEN
    RETURN 'not allowed';
  END IF;

  IF p_role = 'cohost' THEN
    UPDATE players SET is_cohost = p_value WHERE id = p_target_id AND room_id = p_room_id;
    RETURN 'ok';
  END IF;

  IF p_value THEN
    -- CLEAR THE ROOM FIRST, THEN SET. That order is deliberate and CLAUDE.md
    -- records why: promoteToHost used to set the flag on the new host without
    -- clearing the old one, so every promotion ADDED a host and the
    -- photographed "two abandoned copies both flagged HOST" became possible.
    -- A failure between the two leaves no host, which promotion fixes on its
    -- next pass; the other order leaves two, which nothing was looking for.
    UPDATE players SET is_host = false WHERE room_id = p_room_id;
    UPDATE players SET is_host = true  WHERE id = p_target_id AND room_id = p_room_id;
  ELSE
    UPDATE players SET is_host = false WHERE id = p_target_id AND room_id = p_room_id;
  END IF;
  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION op_set_host_role(uuid, uuid, uuid, text, boolean) TO anon, authenticated;


-- --------------------------------------------
-- 3. Narrow what a client may write, and shut the insert loophole
--
-- The UPDATE POLICY STAYS `USING (true)`. It is the GRANT that narrows this,
-- not the policy — a policy cannot say "these columns only". Revoking the
-- table-wide grant and re-granting three columns is what makes `is_host`
-- unwritable while the heartbeat carries on untouched.
--
-- INSERT is narrowed too, because leaving it open would make all of the above
-- pointless: you could simply INSERT yourself into somebody's room with
-- `is_host = true`. Refused only when the room ALREADY HAS A LIVE HOST — the
-- room's creator inserts the first row, and a returning host whose seat was
-- swept must be able to come back as host, which is exactly what the client's
-- own `someoneElseIsHost` check already decides.
-- --------------------------------------------
REVOKE UPDATE ON players FROM anon, authenticated;
GRANT UPDATE (last_seen_at, disconnected_at, is_ready) ON players TO anon, authenticated;

DO $$
DECLARE pol record;
BEGIN
  FOR pol IN SELECT policyname FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'players'
                AND cmd IN ('INSERT', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY %I ON players', pol.policyname);
  END LOOP;

  EXECUTE 'CREATE POLICY "Players: join without seizing the room" ON players '
          'FOR INSERT WITH CHECK ('
          '  NOT coalesce(is_host, false) OR NOT op_room_has_live_host(room_id)'
          ')';
END $$;


-- --------------------------------------------
-- 4. Verify — and PRINT what was seen, pass or fail
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'nobody can write is_host directly' AS thing,
    CASE WHEN has_column_privilege('anon', 'public.players', 'is_host', 'UPDATE')
    THEN 'FAIL anyone can still seize a game' ELSE 'ok' END AS verdict

  UNION ALL SELECT 2, 'nor is_cohost',
    CASE WHEN has_column_privilege('anon', 'public.players', 'is_cohost', 'UPDATE')
    THEN 'FAIL' ELSE 'ok' END

  UNION ALL SELECT 3, 'the 15-second heartbeat still works',
    CASE WHEN has_column_privilege('anon', 'public.players', 'last_seen_at', 'UPDATE')
    THEN 'ok' ELSE 'FAIL every player is swept as stale within two minutes' END

  UNION ALL SELECT 4, 'the unload beacon still works',
    CASE WHEN has_column_privilege('anon', 'public.players', 'disconnected_at', 'UPDATE')
    THEN 'ok' ELSE 'FAIL a closed tab takes two minutes to clean up instead of 45s' END

  UNION ALL SELECT 5, 'readying up still works',
    CASE WHEN has_column_privilege('anon', 'public.players', 'is_ready', 'UPDATE')
    THEN 'ok' ELSE 'FAIL nobody can ready up' END

  UNION ALL SELECT 6, 'op_set_host_role installed and callable',
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'NOT CALLABLE — no room could ever promote' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_set_host_role'), 'MISSING')

  UNION ALL SELECT 7, 'joining still works',
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = 'players'
                        AND cmd IN ('INSERT', 'ALL'))
    THEN 'ok' ELSE 'FAIL nobody can join a game' END

  UNION ALL SELECT 8, 'and joining cannot seize a room with a live host',
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = 'players'
                        AND cmd = 'INSERT' AND with_check LIKE '%op_room_has_live_host%')
    THEN 'ok' ELSE 'FAIL the insert path is still a way in' END
) report ORDER BY ord;

SELECT grantee, string_agg(privilege_type || ':' || column_name, ', ' ORDER BY column_name) AS may_write
FROM information_schema.column_privileges
WHERE table_schema = 'public' AND table_name = 'players'
  AND grantee IN ('anon', 'authenticated') AND privilege_type = 'UPDATE'
GROUP BY grantee;
