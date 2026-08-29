-- ============================================
-- 062 — A DEPUTY CAN ACTUALLY ADVANCE THE GAME
--
-- Needs 058 (op_room_has_live_host) and 060 (op_may_advance).
--
-- THE BUG. This app has two different questions about an absent host, with two
-- deliberately different answers, and migration 060 collapsed them into one:
--
--   May I take the crown?    STALE_TIMEOUT_MS   120s   hard to undo
--   May I move the game on?  HOST_HANDOVER_MS    30s   the game must not stall
--
-- CLAUDE.md has stated that distinction for months, under "Deputising, not
-- replacement": at HOST_HANDOVER_MS the host KEEPS the crown and the next in
-- line is granted advance rights, because taking the role from somebody who
-- glanced at a notification means they come back to find they no longer run
-- their own game. `op_may_advance` reached for the only liveness function that
-- existed — op_room_has_live_host, written for the crown — and inherited 120s.
--
-- WHAT A PLAYER SAW, and it is the silent-failure shape CLAUDE.md #4 is about:
--
--   0s     the host's screen locks
--   30s    every phone deputises the next in line, ACTIVATES THEIR BUTTONS,
--          and posts "<name> can advance while the host is away" into the chat
--   30-120s they press Reveal Results. op_may_advance says no. op_set_phase
--          returns 'not allowed', which the client counts as "the server was
--          reached", so it does not fall back and nothing is shown. The button
--          does nothing, ninety seconds, no error anywhere.
--   120s   the seat is swept, promotion runs properly, and it starts working
--
-- So the game unstalls itself eventually and the deputy mechanism — the thing
-- built to stop the stall — was dead for its entire window. It was also
-- INVISIBLE before slice 12: until 061 the client's fallback direct write to
-- `rooms` still worked, so the refusal cost nothing. Revoking the column is
-- what turned a redundant guard into a dead button.
--
-- THE FIX IS TO SPLIT THE QUESTION, NOT TO PICK A WINNING NUMBER. Lowering
-- op_room_has_live_host to 30s would let somebody take the crown from a host
-- whose phone blipped, which is worse than the bug. Raising the client to 120s
-- would delete deputising. They are two rules and they get two windows.
--
-- op_room_host_seen_within(room, interval) is the one implementation, and both
-- callers name their own window AT THE CALL SITE. That is the point of the
-- shape: the next person to read either one cannot mistake it for the other,
-- which is exactly what went wrong here.
-- ============================================


-- --------------------------------------------
-- 1. One liveness test, asked with an explicit window
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_room_host_seen_within(p_room_id uuid, p_within interval)
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
       -- A MISSING TIMESTAMP MEANS "CANNOT TELL", AND CANNOT-TELL COUNTS AS
       -- HERE. The same rule as every other absence check in this project:
       -- treating no evidence as evidence of absence once had hosts kicking
       -- every player seconds after they joined.
       AND (
         (p.last_seen_at IS NULL AND p.joined_at IS NULL)
         OR now() - coalesce(p.last_seen_at, p.joined_at) < p_within
       )
  );
$$;

GRANT EXECUTE ON FUNCTION op_room_host_seen_within(uuid, interval) TO anon, authenticated;


-- --------------------------------------------
-- 2. The crown keeps 120 seconds — unchanged behaviour, one implementation
--
-- Used by op_set_host_role and by the INSERT policy on `players` (058). Neither
-- changes: this is the same test it always ran, now expressed once.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_room_has_live_host(p_room_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT op_room_host_seen_within(p_room_id, interval '120 seconds');
$$;

GRANT EXECUTE ON FUNCTION op_room_has_live_host(uuid) TO anon, authenticated;


-- --------------------------------------------
-- 3. Advancing gets the deputy's window
--
-- 25 SECONDS, NOT 30, AND THE FIVE SECONDS ARE THE WHOLE POINT. The invariant
-- is "the server must never refuse a deputy the client has already deputised",
-- so the server's window has to be strictly SHORTER than HOST_HANDOVER_MS —
-- equal would put the two on a boundary that clock skew decides. Erring this
-- way costs nothing: nobody can ask earlier, because the button is not enabled
-- until the client has deputised, and a hand-crafted request at 26 seconds does
-- the same harmless thing the deputy does at 30.
--
-- IF HOST_HANDOVER_MS IN js/constants.js CHANGES, CHANGE THIS. Nothing can
-- enforce that across two languages, which is why the rule table below asserts
-- the BEHAVIOUR — a deputy at 45 seconds may advance — rather than the number.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_may_advance(p_room_id uuid, p_caller_id uuid)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM players p
     WHERE p.id = p_caller_id
       AND p.room_id = p_room_id
       AND NOT coalesce(p.is_bot, false)
       AND (
         p.is_host
         OR coalesce(p.is_cohost, false)
         -- Nobody is driving: anybody still here may. Deliberately not "the
         -- longest-present player" — that is the client's tie-break for WHO
         -- should, and duplicating it here would be a second implementation of
         -- a rule that only has to pick somebody. Compare-and-set means two
         -- people pressing at once still advance the room exactly one step.
         OR NOT op_room_host_seen_within(p_room_id, interval '25 seconds')
       )
  );
$$;

GRANT EXECUTE ON FUNCTION op_may_advance(uuid, uuid) TO anon, authenticated;


-- --------------------------------------------
-- 4. Verify
-- --------------------------------------------
DO $$
DECLARE
  rid uuid;
  hostP uuid;
  deputyP uuid;
BEGIN
  INSERT INTO rooms (code, host_name, category, status, game_phase)
    VALUES ('062VER', 'Host', 'history', 'playing', 'reveal') RETURNING id INTO rid;
  INSERT INTO players (room_id, display_name, is_host, last_seen_at)
    VALUES (rid, 'Host', true, now() - interval '45 seconds') RETURNING id INTO hostP;
  INSERT INTO players (room_id, display_name, last_seen_at)
    VALUES (rid, 'Deputy', now()) RETURNING id INTO deputyP;

  CREATE TEMP TABLE _062 (ord int, thing text, verdict text);

  INSERT INTO _062 VALUES (1, 'a deputy may advance 45s after the host went quiet',
    CASE WHEN op_may_advance(rid, deputyP)
    THEN 'ok' ELSE 'FAIL the deputy button still does nothing' END);

  UPDATE players SET last_seen_at = now() WHERE id = hostP;
  INSERT INTO _062 VALUES (2, 'but not while the host is actually here',
    CASE WHEN op_may_advance(rid, deputyP)
    THEN 'FAIL anybody can seize a live game' ELSE 'ok' END);

  INSERT INTO _062 VALUES (3, 'the crown still needs the full 120 seconds',
    CASE WHEN op_room_has_live_host(rid) THEN 'ok' ELSE 'FAIL' END);

  UPDATE players SET last_seen_at = now() - interval '45 seconds' WHERE id = hostP;
  INSERT INTO _062 VALUES (4, 'a host quiet 45s still holds the crown',
    CASE WHEN op_room_has_live_host(rid)
    THEN 'ok' ELSE 'FAIL a glance at a notification loses you your game' END);

  DELETE FROM rooms WHERE id = rid;
END $$;

SELECT ord, thing, verdict FROM _062 ORDER BY ord;
DROP TABLE _062;
