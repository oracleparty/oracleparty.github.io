-- ============================================
-- 057 — SLICE 9: ONLY THE RULES REMOVE A PLAYER
--
-- Needs 048 (op_is_room_host) and invisible accounts switched on, though this
-- does not depend on identity: every rule below is about the ROOM, not about
-- who is asking.
--
-- THE HOLE. `players` has `FOR DELETE USING (true)`, and every browser carries
-- the publishable key by necessity because guests play. So anyone who can reach
-- the site can remove any player from any live game — mid-round, with their
-- score, in one request. Room codes are six digits and public games are listed,
-- so finding a room to do it to is not a barrier.
--
-- WHY THIS ONE CAN BE CLOSED NOW, when CLAUDE.md #2 says `players` cannot be.
-- That entry is about "remove me" and "remove them" being the same request from
-- somebody with no identity. It is still true that the server cannot always
-- tell WHO is asking. What it can do is check whether the removal is one the
-- rules allow AT ALL — and every legitimate delete in `js/` turns out to reduce
-- to a rule about the room's own state:
--
--   * you are leaving          target IS the caller
--   * the host removes a bot   target is_bot, caller is the host
--   * the stale sweep          the target has genuinely gone quiet, which the
--                              server checks against ITS OWN clock rather than
--                              believing the caller
--   * a duplicate seat         target carries the caller's own user_id
--
-- Nothing legitimate needs "remove an arbitrary live stranger", which is
-- exactly what the open policy allowed.
--
-- WHAT THIS DOES NOT DO, and must not be claimed to. `players` UPDATE stays
-- open — the ready flag, the heartbeat and host promotion are all still browser
-- writes. So somebody determined can still backdate another player's
-- `last_seen_at` and then have them swept. That is two deliberate steps instead
-- of one request, and it is a real reduction rather than a closed door. Say it
-- that way. The UPDATE lockdown is its own slice and needs the same enumeration
-- this one got.
--
-- EVERY DELETE IN `js/` WAS ENUMERATED FIRST, because migration 049 was written
-- about the writes that were dangerous and silently broke three that were not:
--
--   js/game/phases.js:907,911   stale sweep, game page
--   js/lobby.js:1692,1700       stale sweep, lobby
--   js/lobby.js:681             host removes a practice bot
--   js/lobby.js:1736            leaving
--   js/game/scores.js:1411      leaving
--   js/game/init.js:628         leaving, on unload (beacon)
--   js/db/players.js:111        claimSeat clearing a duplicate of your own seat
--   op_leave_room (048)         already server-side, unaffected
--
-- There is no kick feature, so "the host removes a live human" is deliberately
-- NOT a rule. Adding one later means adding it here, on purpose.
-- ============================================


-- --------------------------------------------
-- 1. Remove a player, if and only if one of the rules allows it
--
-- Returns text rather than a boolean, so a caller can tell "removed", "not
-- allowed" and "already gone" apart. Collapsing those is how a working guard
-- and a broken one come to look identical (CLAUDE.md #6).
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_remove_player(
  p_room_id   uuid,
  p_caller_id uuid,
  p_target_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  caller players;
  target players;
  silence_ms double precision;
  threshold_ms double precision;
  gone int;
BEGIN
  SELECT * INTO target FROM players WHERE id = p_target_id AND room_id = p_room_id;
  IF target.id IS NULL THEN
    RETURN 'already gone';
  END IF;

  SELECT * INTO caller FROM players WHERE id = p_caller_id AND room_id = p_room_id;

  -- Rule 1: you are leaving. The commonest case by far, and the only one that
  -- needs no other state to be true.
  IF p_caller_id = p_target_id THEN
    NULL;   -- allowed

  -- Rule 2: the host removes a practice bot. Deliberately `is_bot` AND host,
  -- not host alone: there is no kick feature in this game, and a host being
  -- able to remove a live human is a product decision nobody has made.
  ELSIF target.is_bot AND op_is_room_host(p_room_id, p_caller_id) THEN
    NULL;   -- allowed

  -- Rule 3: a duplicate of the caller's OWN seat. claimSeat clears these, and
  -- since invisible accounts a guest has a user id too, so this covers them.
  -- Both ids must be present — two NULLs are not a match, or every guest could
  -- remove every other guest.
  ELSIF caller.user_id IS NOT NULL AND target.user_id IS NOT NULL
        AND caller.user_id = target.user_id THEN
    NULL;   -- allowed

  -- Rule 4: the stale sweep. The caller has to be IN the room — a stranger
  -- does not get to tidy somebody else's game — and the silence is measured
  -- against the DATABASE's clock, never taken on the caller's word.
  ELSIF caller.id IS NOT NULL THEN
    -- A BOT IS NEVER SWEPT. It sends no heartbeat, so by the timestamp rule it
    -- is stale from the moment it is added — which would let anybody delete the
    -- host's bot mid-game. The client already skips bots in both sweeps; this
    -- is the same rule where a request cannot edit it out.
    IF target.is_bot THEN
      RETURN 'not allowed';
    END IF;

    -- CANNOT TELL MEANS HERE. A row with no timestamp at all is protected, the
    -- same rule as everywhere else in this project — treating absence of
    -- evidence as evidence of absence once had hosts kicking every player in
    -- the room seconds after they joined.
    IF target.last_seen_at IS NULL AND target.joined_at IS NULL THEN
      RETURN 'not allowed';
    END IF;

    silence_ms := extract(epoch from (now() - coalesce(target.last_seen_at, target.joined_at))) * 1000;
    -- Mirrors js/constants.js: DISCONNECTED_TIMEOUT_MS (45s) once a beacon has
    -- said they are gone, STALE_TIMEOUT_MS (120s) otherwise. A server that were
    -- stricter than the client would refuse legitimate sweeps and leave ghost
    -- rows in every room.
    threshold_ms := CASE WHEN target.disconnected_at IS NOT NULL THEN 45000 ELSE 120000 END;
    IF silence_ms < threshold_ms THEN
      RETURN 'not allowed';
    END IF;

  ELSE
    -- Not in the room, and not removing yourself.
    RETURN 'not allowed';
  END IF;

  DELETE FROM players WHERE id = p_target_id AND room_id = p_room_id;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN CASE WHEN gone > 0 THEN 'removed' ELSE 'already gone' END;
END;
$$;

GRANT EXECUTE ON FUNCTION op_remove_player(uuid, uuid, uuid) TO anon, authenticated;


-- --------------------------------------------
-- 2. Shut the door — BY LOOKING, never by name
--
-- 049's drops named policies that do not exist on the live database, `IF
-- EXISTS` made that a NOTICE rather than an error, and the door stayed open for
-- days while the migration reported success. A policy written FOR ALL also has
-- cmd = 'ALL' and grants DELETE as a side effect, so it has to go too — which
-- means the policies the app still needs are recreated FIRST.
-- --------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'players' AND cmd = 'SELECT') THEN
    EXECUTE 'CREATE POLICY "Players: anyone can read" ON players FOR SELECT USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'players' AND cmd = 'INSERT') THEN
    EXECUTE 'CREATE POLICY "Players: anyone can insert" ON players FOR INSERT WITH CHECK (true)';
  END IF;
  -- UPDATE STAYS OPEN, DELIBERATELY. The ready flag, the heartbeat and host
  -- promotion are all still browser writes; revoking it here would stop players
  -- readying up and stop every heartbeat, which is far worse than the hole it
  -- would close. Its own slice, with its own enumeration.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'players' AND cmd = 'UPDATE') THEN
    EXECUTE 'CREATE POLICY "Players: anyone can update" ON players FOR UPDATE USING (true) WITH CHECK (true)';
  END IF;

  FOR pol IN SELECT policyname FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'players'
                AND cmd IN ('DELETE', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY %I ON players', pol.policyname);
  END LOOP;
END $$;


-- --------------------------------------------
-- 3. Verify — and PRINT what was seen, pass or fail
--
-- 051 came back FAIL on a door that two explanations fitted, and an ok/FAIL
-- cell could not tell them apart. Settling it cost a round trip to the owner
-- that looking would have saved.
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'nobody can delete a player directly' AS thing,
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'players'
         AND cmd IN ('DELETE', 'ALL'))
    THEN 'FAIL a policy still allows it' ELSE 'ok' END AS verdict

  UNION ALL SELECT 2, 'op_remove_player installed and callable',
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'NOT CALLABLE — nobody could leave a room' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_remove_player'), 'MISSING')

  UNION ALL SELECT 3, 'joining still works',
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = 'players' AND cmd IN ('INSERT', 'ALL'))
    THEN 'ok' ELSE 'FAIL nobody can join a game' END

  UNION ALL SELECT 4, 'ready / heartbeat / promotion still work',
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = 'players' AND cmd IN ('UPDATE', 'ALL'))
    THEN 'ok' ELSE 'FAIL every heartbeat and ready-up is refused' END

  UNION ALL SELECT 5, 'the lobby can still see who is in the room',
    CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                      WHERE schemaname = 'public' AND tablename = 'players' AND cmd IN ('SELECT', 'ALL'))
    THEN 'ok' ELSE 'FAIL the player list is empty everywhere' END
) report ORDER BY ord;

SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE tablename = 'players'
ORDER BY schemaname, policyname;
