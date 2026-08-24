-- ============================================
-- 048 — ONLY THE RULES DELETE A ROOM
--
-- Needs 045–047.
--
-- THE HOLE THIS CLOSES. Every browser carries the publishable key, by
-- necessity, because guests play without signing in. `rooms` has
-- `FOR DELETE USING (true)`, so anyone who can reach the site can delete any
-- room — including one with a game in progress. Everybody in it is thrown out
-- mid-round and the scores go with it. That is the single most destructive
-- thing a stranger can do to this game, and it takes one request.
--
-- WHY IT CAN BE CLOSED NOW, when the rest of the lockdown cannot.
--
-- Every legitimate room deletion in js/ reduces to ONE rule: nobody is left in
-- the room. `handleLeave`, `handleQuit`, `handleBackButton` and both Realtime
-- DELETE handlers all check "am I the last one" and then delete. The sweeps add
-- two more rules — a lobby nobody ever started, and a room everybody has gone
-- silent in. Not one of them depends on WHO is asking.
--
-- That is what makes this different from the rest of the table. Locking
-- `players` cannot work the same way: "remove me" and "remove them" are the
-- same request from a guest, who has no identity to check. Locking `rooms`
-- UPDATE cannot work yet either — the phase machine still runs in the browser.
-- Those wait. This one does not have to.
--
-- ORDER MATTERS: deploy the JavaScript first, then run this. The client calls
-- these functions and falls back to a direct DELETE when they are missing, so
-- JS-then-SQL is safe in both states. SQL first would leave older tabs unable
-- to delete anything — and an RLS refusal returns no error, so the rooms would
-- simply pile up in silence.
-- ============================================


-- --------------------------------------------
-- op_room_has_humans — is anybody actually in there
--
-- Bots do not count. A bot never sends a heartbeat and never leaves, so a room
-- holding nothing but bots is empty in every sense that matters — and treating
-- one as alive would keep dead rooms listed forever.
--
-- `p_excluding` is the player on their way out. Their row may not be gone yet:
-- the beacon that removes it and this call race on page unload, and asking
-- "will anyone be left" is the only version of the question that is stable.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_room_has_humans(p_room_id uuid, p_excluding uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM players
     WHERE room_id = p_room_id
       AND NOT coalesce(is_bot, false)
       AND (p_excluding IS NULL OR id <> p_excluding)
  );
$$;


-- --------------------------------------------
-- op_leave_room — take yourself out, and take the room if you were the last
--
-- One call instead of the client's read-then-decide-then-delete, which is a
-- race in a room where two people quit at once: both read two players, both
-- conclude somebody else is staying, and the room survives with nobody in it.
-- That is one of the ways "two active games nobody was in" happened.
--
-- Returns what it did, so the caller can log something true rather than assume.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_leave_room(p_room_id uuid, p_player_id uuid DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  still_occupied boolean;
BEGIN
  IF p_player_id IS NOT NULL THEN
    DELETE FROM players WHERE id = p_player_id AND room_id = p_room_id;
  END IF;

  still_occupied := op_room_has_humans(p_room_id, p_player_id);

  IF still_occupied THEN
    RETURN 'left';
  END IF;

  DELETE FROM rooms WHERE id = p_room_id;
  RETURN 'room deleted';
END;
$$;


-- --------------------------------------------
-- op_sweep_rooms — the three cleanup rules, applied by the database
--
-- A port of cleanupOrphanedRooms and cleanupAbandonedRooms. Each guard below
-- is load-bearing and was learned expensively; see CLAUDE.md.
--
-- Returns how many rooms went, which is what makes it testable.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_sweep_rooms()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  gone int := 0;
  n int;
BEGIN
  -- 1. No player rows at all, at any age. Nothing to protect.
  DELETE FROM rooms r
   WHERE NOT EXISTS (SELECT 1 FROM players p WHERE p.room_id = r.id);
  GET DIAGNOSTICS n = ROW_COUNT; gone := gone + n;

  -- 2. A lobby nobody ever started, older than two hours.
  --
  -- DELIBERATELY NOT 'playing'. A casual game with friends can easily run past
  -- two hours — a long category, plenty of pauses — and an age sweep that fires
  -- whenever anybody opens the home page would delete the room out from under
  -- them mid-game.
  DELETE FROM rooms
   WHERE status = 'lobby' AND created_at < now() - interval '2 hours';
  GET DIAGNOSTICS n = ROW_COUNT; gone := gone + n;

  -- 3. Everybody human has been silent for twenty minutes.
  --
  -- Three guards, none optional:
  --   * TWENTY MINUTES, not the two-minute in-game stale timeout. This deletes
  --     a whole room rather than one seat, and deleting a live room out from
  --     under a game is far worse than leaving a dead one listed.
  --   * NO last_seen_at AT ALL MEANS "CANNOT TELL", and protects the room.
  --     Ignoring that rule once had hosts kicking every player seconds after
  --     they joined.
  --   * BOTS ARE IGNORED when asking whether anyone is alive, because a bot
  --     never heartbeats. A room of only bots is abandoned by definition.
  DELETE FROM rooms r
   WHERE EXISTS (SELECT 1 FROM players p
                  WHERE p.room_id = r.id AND NOT coalesce(p.is_bot, false))
     AND NOT EXISTS (
       SELECT 1 FROM players p
        WHERE p.room_id = r.id
          AND NOT coalesce(p.is_bot, false)
          AND (p.last_seen_at IS NULL
               OR p.last_seen_at > now() - interval '20 minutes')
     );
  GET DIAGNOSTICS n = ROW_COUNT; gone := gone + n;

  RETURN gone;
END;
$$;


GRANT EXECUTE ON FUNCTION op_room_has_humans(uuid, uuid) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_leave_room(uuid, uuid)      TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_sweep_rooms()               TO anon, authenticated;


-- --------------------------------------------
-- AND SHUT THE DOOR
--
-- After this, a room can only be deleted by the functions above, which run as
-- the table owner and check the rules first. Nothing in js/ needs the raw
-- right any more.
--
-- The name is the one migration 022 created. Dropping it IF EXISTS means this
-- migration is safe to run twice and safe on a project where it was already
-- renamed by hand.
-- --------------------------------------------
DROP POLICY IF EXISTS "Rooms: anyone can delete" ON rooms;


-- --------------------------------------------
-- VERIFY — every cell must read "ok"
-- --------------------------------------------
SELECT
  CASE WHEN to_regprocedure('op_leave_room(uuid,uuid)') IS NOT NULL
       THEN 'ok' ELSE 'FAIL op_leave_room missing' END AS leave_fn,
  CASE WHEN to_regprocedure('op_sweep_rooms()') IS NOT NULL
       THEN 'ok' ELSE 'FAIL op_sweep_rooms missing' END AS sweep_fn,
  CASE WHEN NOT EXISTS (
         SELECT 1 FROM pg_policies
          WHERE tablename = 'rooms' AND cmd = 'DELETE')
       THEN 'ok' ELSE 'FAIL a stranger can still delete a room' END AS door_shut,
  CASE WHEN has_function_privilege('anon', 'op_leave_room(uuid,uuid)', 'EXECUTE')
       THEN 'ok' ELSE 'FAIL players cannot leave' END AS guests_may_leave;
