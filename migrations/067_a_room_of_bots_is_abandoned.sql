-- ============================================================
-- 067 — A ROOM WITH NOBODY HUMAN IN IT IS ABANDONED
--
-- Reported after a live game on 2026-09-07: "the bugged game from the refresh
-- host issue I left after it started but keeps showing in active game
-- lobbies???"
--
-- op_sweep_rooms (048) has three rules, and there is a room shape none of them
-- can reach — so it is listed as an active game FOR EVER, and no amount of
-- sweeping removes it:
--
--   rule 1  deletes a room with NO PLAYER ROWS AT ALL.
--           A leftover bot row is a player row, so this misses.
--   rule 2  deletes a lobby older than two hours.
--           Deliberately not 'playing', so a started room is out of reach.
--   rule 3  deletes a room where every HUMAN has been silent for 20 minutes —
--           and it opens with EXISTS(a human in this room). With only bots
--           left that is false, so the rule never even considers the room.
--
-- 048's own comment says "a room of only bots is abandoned by definition", and
-- the JavaScript fallback in cleanupAbandonedRooms really does treat it that
-- way. The SQL never did. That is this project's most repeated shape — a rule
-- stated in two places and implemented in one — and the half that is wrong is
-- the half that is load-bearing, because 048 revoked DELETE on `rooms` and
-- made the function the only way a room can go.
--
-- HOW IT HAPPENS, and it is ordinary. Solo practice is a human plus a bot. The
-- human's phone dies without firing its unload beacon, so op_leave_room never
-- runs (that one DOES ignore bots, which is why the normal path is fine). Some
-- minutes later another client's stale sweep removes the human's seat through
-- op_remove_player, and what is left is a room containing one bot: invisible
-- to every rule above, and offered to real players from the public list for
-- the next two hours and then for ever.
--
-- THE FIX IS TO RULE 1, not a fourth rule. "No player rows at all" was always
-- a proxy for "nobody is in here", and a bot is not somebody: it sends no
-- heartbeat, joins no presence channel, and cannot start, advance or judge a
-- game. A room holding only bots has nobody who could ever play in it.
--
-- WHAT THIS DOES NOT WIDEN. Rule 1 already deletes a room with zero player
-- rows at ANY age, so the window between creating a room and inserting the
-- host's seat was already exposed; asking about humans rather than rows cannot
-- make that window longer, because a room cannot hold a bot before it holds
-- its host. Rules 2 and 3 are untouched, including "a missing last_seen_at
-- means cannot tell, and cannot-tell protects the room".
-- ============================================================

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
  -- 1. Nobody HUMAN is in it, at any age. Nothing to protect.
  --
  -- Was `NOT EXISTS (any player row)`. A bot is a row in `players` like any
  -- other, so a room whose last person left behind a practice bot satisfied
  -- the old test and survived every rule below it as well.
  DELETE FROM rooms r
   WHERE NOT EXISTS (SELECT 1 FROM players p
                      WHERE p.room_id = r.id
                        AND NOT coalesce(p.is_bot, false));
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
  --     they joined. (Since 2026-09-07 addPlayer stamps last_seen_at at INSERT,
  --     so a client cannot produce a row that is protected for ever — but the
  --     rule stays, because it is right about rows this app did not write.)
  --   * BOTS ARE IGNORED when asking whether anyone is alive, because a bot
  --     never heartbeats. Rule 1 above is what actually removes a bots-only
  --     room; this one can no longer be reached by it.
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
GRANT EXECUTE ON FUNCTION op_sweep_rooms() TO anon, authenticated;


-- ============================================================
-- VERIFY — every cell must read "ok"
--
-- It reads the INSTALLED function's own source rather than asserting a
-- behaviour, so a paste that stopped halfway reports FAIL instead of passing
-- quietly. That is the shape migration 066's verification used.
-- ============================================================
SELECT
  CASE WHEN to_regprocedure('op_sweep_rooms()') IS NOT NULL
       THEN 'ok' ELSE 'FAIL op_sweep_rooms missing' END          AS installed,
  CASE WHEN (SELECT prosrc FROM pg_proc
              WHERE oid = 'op_sweep_rooms()'::regprocedure)
            LIKE '%1. Nobody HUMAN is in it%'
       THEN 'ok' ELSE 'FAIL rule 1 was not replaced' END         AS bots_only_rule,
  CASE WHEN (SELECT prosrc FROM pg_proc
              WHERE oid = 'op_sweep_rooms()'::regprocedure)
            LIKE '%interval ''20 minutes''%'
       THEN 'ok' ELSE 'FAIL the silence rule went missing' END   AS silence_rule,
  CASE WHEN (SELECT prosrc FROM pg_proc
              WHERE oid = 'op_sweep_rooms()'::regprocedure)
            LIKE '%status = ''lobby''%'
       THEN 'ok' ELSE 'FAIL the stale-lobby rule went missing' END AS lobby_rule;
