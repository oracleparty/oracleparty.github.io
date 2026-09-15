-- ============================================
-- 071 — A FAVOURITE ANSWER
--
-- Asked for by the owner, discussed first at their insistence: "was wondering
-- if there should be an optional Favorite answer vote? But this would have to
-- be thought thru well with discussion first." The design below is the result
-- of that conversation and every decision in it is theirs.
--
-- On the reveal, each player may clap ONE answer per round. At the end of the
-- game the results screen leads with a FAVOURITE ANSWERS card naming the most
-- clapped answer (or answers — see TIES). Nothing about scoring changes.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS IS, AND THE ONE THING THAT MAKES IT DIFFERENT FROM EVERY OTHER
-- TALLY IN THIS GAME
--
-- `question_stats`, `answer_tally` and `host_ratings` are all deliberately
-- about the MATERIAL or the ROLE. This is the first tally in Oracle Party that
-- is about a PERSON. That was raised with the owner before anything was built
-- and they chose it knowingly, so it is written down here rather than left to
-- be rediscovered as a surprise.
--
-- Two decisions follow from it:
--
--   * THE AWARD NAMES THE ANSWER, NOT THE PLAYER. "Favourite Answers", quoting
--     the line, not "most loved player, 9 votes". Same votes, completely
--     different thing: one is a joke everyone remembers, the other is a ranking
--     of who brought the most friends. The lifetime counters below still let a
--     per-person number exist on a profile, which is a different surface with
--     different expectations.
--   * CLAPPING IS PUBLIC. Every other vote in this app that can be traced to a
--     person is hidden — `host_ratings` admits admins only, because a host who
--     can see who thumbs-downed them can retaliate, and a rating that is unsafe
--     to give is worse than none. A CLAP IS PRAISE. Nobody needs protecting
--     from being seen praising somebody, and "Alice and Bob clapped this" is
--     worth more than a bare number. That asymmetry is deliberate: do not
--     "tidy" it by hiding clappers to match host_ratings.
--
-- ---------------------------------------------------------------------------
-- WHY THE GAME KEY IS ON THE ROW, AND WHY NOTHING NEEDS CLEARING
--
-- A ROOM SURVIVES PLAY AGAIN. `question_number` therefore repeats: round 3 of
-- game one and round 3 of game two are the same number in the same room. A
-- unique key of (room, question_number, voter) would collide between games.
-- MEASURED by breaking it: the second game's clap does not fail quietly, it
-- raises 23505 at the player — or, with the race backstop below, silently
-- overwrites the first game's clap, which is worse because nothing says so.
--
-- This project has been bitten by exactly that shape before — a leftover answer
-- keyed on (room, player, round) occupying the key the next game needed, which
-- cost somebody their whole round and took migration 066 to unpick. So the key
-- carries `game_key`: the room's `countdown_started_at`, rewritten at the start
-- of every game and identical on every phone. Migration 034 established that as
-- this project's per-game identity and it is reused rather than reinvented.
--
-- The alternative was to clear claps when answers are cleared. That would mean
-- editing op_reset_answers (051) and the client's start-of-game clear, and
-- getting BOTH right for ever. A key that cannot collide needs neither.
--
-- ---------------------------------------------------------------------------
-- TIES, WHICH ARE THE NORMAL CASE AND NOT AN EDGE CASE
--
-- The owner found this and it is the sharpest thing in the design: WITH TWO
-- PLAYERS IT CANNOT PRODUCE A WINNER. Each can only clap the other, so every
-- clapped answer sits at exactly one clap and everything ties. Three players
-- caps it at two. Only at four or more does a single winner emerge normally.
--
-- So the award is PLURAL by design — "Favourite Answers", listing what tied at
-- the top, capped at three by the client. In a big game that is one line; in a
-- two-player game it is "the answers your friend liked", which is still worth
-- reading. The SQL side of that is simply that this file never picks a winner:
-- it returns counts and lets the screen decide. A tie-break here would have to
-- be arbitrary (earliest? shortest?) and arbitrary is how a card starts lying.
--
-- ---------------------------------------------------------------------------
-- THE LIFETIME COUNTERS, AND THE ONE WEIGHT
--
-- The owner asked for a total AND a fair version, and was right that it should
-- be one weight rather than two: claps received ÷ CLAPS AVAILABLE TO YOU.
--
-- Claps available is counted PER ROUND, not per game, and that is what makes it
-- exact rather than approximate. At round N it is (people seated at round N,
-- minus you). Sum across the rounds you were actually in. A player who joined
-- at round 8 contributes only rounds 8 onward; a swept seat stops contributing.
-- No special case for hot-joining, and nothing has to be waved off as
-- negligible.
--
-- The fact it counts is one this game already writes down: every round ends
-- with `op_fill_blank_answers` giving EVERY player in the room a row, which is
-- the same evidence `op_played_whole_game` (059) reads. So the denominator is
-- derived from data that already exists, with no new bookkeeping anywhere.
--
-- `clap_history` is durable because `answer_claps` is not: claps cascade with
-- the room, and a room lasts an evening. One row per player per finished game,
-- the same shape as `game_history`.
--
-- IT IS NOT `game_history`, and that is deliberate. That table is written only
-- for REAL accounts (`getCurrentUser()`), and the owner's decision is that a
-- guest's claps accumulate quietly and appear the day they sign up. A guest has
-- an invisible account with a real auth id (slice 8a), so keying on `user_id`
-- covers everybody; keying on game_history would have silently dropped every
-- guest's claps with nothing on screen saying so.
--
-- ---------------------------------------------------------------------------
-- WHY op_record_claps IS IDEMPOTENT AND EVERY DEVICE CALLS IT
--
-- CLAUDE.md states the rule this has to answer: "Whether a write may be
-- repeated is the thing to establish before choosing." `room_scores` is
-- host-gated because a per-device call would multiply the tally by the room
-- size. `record_round_history` (043) is called by every device because
-- host-gating it would mean a host whose phone died took the whole room's
-- record with them.
--
-- This is the second shape. The rollup is per-player and exact, so a second
-- caller must change nothing — and it must not depend on the host being alive,
-- because the claps are already on the table and losing them to a dead phone
-- would be silent. ON CONFLICT DO NOTHING on (user_id, room_id, game_key) is
-- the whole of it: the first call writes, every later one matches the key and
-- does nothing.
-- ============================================

-- ---------------------------------------------------------------------------
-- THE LIVE CLAPS
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS answer_claps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  -- The room's countdown timestamp. See WHY THE GAME KEY IS ON THE ROW.
  game_key text NOT NULL,
  question_number int NOT NULL,
  -- The answer clapped. NO FOREIGN KEY to `answers`, for the same reason 052
  -- dropped answers -> players: a clap records that somebody liked a line at a
  -- moment, and the answer row is how that line was reached at the time. The
  -- cascade from `rooms` is what stops orphans accumulating, exactly as it is
  -- for `answers` themselves.
  answer_id uuid NOT NULL,
  -- Seats, not user ids, because a seat always exists and a user id does not:
  -- anonymous sign-in can fail, and keying on it would make a guest in that
  -- state silently unable to clap. This is the same call `data-profile-player-id`
  -- already makes on every screen in the game.
  voter_player_id uuid NOT NULL,
  clapped_player_id uuid NOT NULL,
  -- ...and the durable ids alongside them, nullable, purely so the end-of-game
  -- rollup does not have to re-join seats that may since have been swept.
  voter_user_id uuid,
  clapped_user_id uuid,
  created_at timestamptz DEFAULT now(),
  -- ONE CLAP PER PERSON PER ROUND. The owner's rule. Moving it is an update of
  -- this row and withdrawing it is a delete, so the constraint is the feature
  -- rather than a guard against it.
  CONSTRAINT answer_claps_one_per_round
    UNIQUE (room_id, game_key, question_number, voter_player_id)
);

CREATE INDEX IF NOT EXISTS answer_claps_game_idx
  ON answer_claps (room_id, game_key);
CREATE INDEX IF NOT EXISTS answer_claps_answer_idx
  ON answer_claps (answer_id);

-- SUPABASE GRANTS EVERY NEW PUBLIC TABLE TO anon AND authenticated through
-- ALTER DEFAULT PRIVILEGES, and a GRANT adds where only a REVOKE subtracts.
-- Migration 063 shipped without this and its own verification block caught it.
-- Revoke first, then grant back exactly what is needed.
REVOKE ALL ON answer_claps FROM anon, authenticated;
GRANT SELECT ON answer_claps TO anon, authenticated;

ALTER TABLE answer_claps ENABLE ROW LEVEL SECURITY;

-- Reading is open, and it has to be: the reveal shows a clap the moment it
-- lands, with whose it was, on every phone in the room. See CLAPPING IS PUBLIC
-- above for why that is safe here and is not safe for host_ratings.
DROP POLICY IF EXISTS "Claps: anyone can read" ON answer_claps;
CREATE POLICY "Claps: anyone can read" ON answer_claps FOR SELECT USING (true);

-- No INSERT, UPDATE or DELETE policy anywhere. op_clap_answer is the only way
-- a row is written, and it is SECURITY DEFINER.

-- ---------------------------------------------------------------------------
-- THE DURABLE ROLLUP
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS clap_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  room_id uuid NOT NULL,
  game_key text NOT NULL,
  claps_received int NOT NULL DEFAULT 0,
  -- The denominator. See THE LIFETIME COUNTERS above — counted per round, so a
  -- latecomer and a swept seat are both exact rather than approximated.
  claps_available int NOT NULL DEFAULT 0,
  recorded_at timestamptz DEFAULT now(),
  -- What makes op_record_claps idempotent, so every device may call it.
  CONSTRAINT clap_history_one_per_game UNIQUE (user_id, room_id, game_key)
);

CREATE INDEX IF NOT EXISTS clap_history_user_idx ON clap_history (user_id);

-- NO FOREIGN KEY TO `rooms`, and that is the entire point of this table. A
-- room is deleted the moment the last player leaves, and 033 and 052 both
-- record what a cascade does to a historical record: `game_plays` held ZERO
-- rows for months because every play was destroyed seconds after being earned.
-- A clap someone gave you is not scratch data for one room.

REVOKE ALL ON clap_history FROM anon, authenticated;
GRANT SELECT ON clap_history TO anon, authenticated;

ALTER TABLE clap_history ENABLE ROW LEVEL SECURITY;

-- Readable, because the leaderboard ranks friends on it and the profile shows
-- your own total. It holds two counts and a room id — nothing about WHO
-- clapped, which stays in answer_claps and dies with the room.
DROP POLICY IF EXISTS "Clap history: anyone can read" ON clap_history;
CREATE POLICY "Clap history: anyone can read" ON clap_history FOR SELECT USING (true);

-- ---------------------------------------------------------------------------
-- op_clap_answer — set, move, or withdraw this player's clap for one round
-- ---------------------------------------------------------------------------
--
-- Returns the resulting state so the caller never has to guess: 'clapped',
-- 'moved', 'withdrawn', or a refusal. #4 in CLAUDE.md is that failures reach a
-- log and stop there; a control that lights up and records nothing is the exact
-- fault this project keeps finding, so every refusal here is a value the screen
-- can act on rather than silence.
--
-- Passing the SAME answer twice withdraws it. That is the owner's choice: tap
-- another to move it, tap the same one again to take it back.

CREATE OR REPLACE FUNCTION op_clap_answer(
  p_room_id         uuid,
  p_voter_player_id uuid,
  p_question_number int,
  p_answer_id       uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game_key   text;
  v_voter      players%ROWTYPE;
  v_target     answers%ROWTYPE;
  v_owner      players%ROWTYPE;
  v_existing   answer_claps%ROWTYPE;
BEGIN
  IF p_room_id IS NULL OR p_voter_player_id IS NULL OR p_answer_id IS NULL THEN
    RETURN 'bad_request';
  END IF;

  -- The game key comes from the ROOM rather than from the caller. A client
  -- passing its own would let a stale phone write into a finished game's
  -- bucket, which is the shape migration 069 closed for the round clock.
  SELECT countdown_started_at::text INTO v_game_key FROM rooms WHERE id = p_room_id;
  IF v_game_key IS NULL THEN
    RETURN 'no_game';
  END IF;

  -- The voter must actually be sitting in this room. Same guard as op_rate_host
  -- (054): without it anybody holding the publishable key — which every browser
  -- carries, because guests play — could stuff a room they were never in.
  SELECT * INTO v_voter FROM players
   WHERE id = p_voter_player_id AND room_id = p_room_id;
  IF NOT FOUND THEN
    RETURN 'not_in_room';
  END IF;

  SELECT * INTO v_target FROM answers
   WHERE id = p_answer_id
     AND room_id = p_room_id
     AND question_number = p_question_number;
  IF NOT FOUND THEN
    RETURN 'no_answer';
  END IF;

  -- You cannot clap your own answer.
  IF v_target.player_id = p_voter_player_id THEN
    RETURN 'not_your_own';
  END IF;

  -- NOTHING TO CLAP. A blank is a round somebody missed, and the placeholder is
  -- not an answer at all — showing either as clappable would offer a control
  -- that means nothing. `__WAGER_LOCKED__` must never reach a player's eyes in
  -- any form, which is a standing rule in CLAUDE.md.
  IF coalesce(btrim(v_target.submitted_answer), '') = ''
     OR v_target.submitted_answer = '__WAGER_LOCKED__' THEN
    RETURN 'nothing_to_clap';
  END IF;

  SELECT * INTO v_owner FROM players WHERE id = v_target.player_id;

  SELECT * INTO v_existing FROM answer_claps
   WHERE room_id = p_room_id
     AND game_key = v_game_key
     AND question_number = p_question_number
     AND voter_player_id = p_voter_player_id;

  IF FOUND THEN
    -- Tapping the same answer again takes the clap back.
    IF v_existing.answer_id = p_answer_id THEN
      DELETE FROM answer_claps WHERE id = v_existing.id;
      RETURN 'withdrawn';
    END IF;
    -- Tapping a different one moves it. One clap per round, so this is an
    -- update rather than a second row — the constraint and the feature are the
    -- same thing.
    UPDATE answer_claps
       SET answer_id         = p_answer_id,
           clapped_player_id = v_target.player_id,
           clapped_user_id   = v_owner.user_id,
           created_at        = now()
     WHERE id = v_existing.id;
    RETURN 'moved';
  END IF;

  -- ON CONFLICT IS A RACE BACKSTOP, NOT THE FEATURE. The withdraw and move
  -- paths above are decided by the SELECT, so this arm is only reached when two
  -- calls from the same phone land at once — which on a touchscreen is an
  -- ordinary double-tap. Without it the second one raises 23505 and the player
  -- is told their clap failed when it plainly worked.
  INSERT INTO answer_claps (
    room_id, game_key, question_number, answer_id,
    voter_player_id, clapped_player_id, voter_user_id, clapped_user_id
  ) VALUES (
    p_room_id, v_game_key, p_question_number, p_answer_id,
    p_voter_player_id, v_target.player_id, v_voter.user_id, v_owner.user_id
  )
  ON CONFLICT ON CONSTRAINT answer_claps_one_per_round DO UPDATE
    SET answer_id         = EXCLUDED.answer_id,
        clapped_player_id = EXCLUDED.clapped_player_id,
        clapped_user_id   = EXCLUDED.clapped_user_id,
        created_at        = now();
  RETURN 'clapped';
END;
$$;

REVOKE ALL ON FUNCTION op_clap_answer(uuid, uuid, int, uuid) FROM public;
GRANT EXECUTE ON FUNCTION op_clap_answer(uuid, uuid, int, uuid) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- op_record_claps — freeze this game's claps into the durable record
-- ---------------------------------------------------------------------------
--
-- Idempotent, so EVERY device calls it at the results screen. See WHY
-- op_record_claps IS IDEMPOTENT above for why that is the right shape here and
-- host-gating would be the wrong one.
--
-- It records a row for every player who HAS A USER ID, guests included — an
-- invisible account is a real auth id (slice 8a), and the owner's decision is
-- that a guest's claps accumulate quietly and appear the day they sign up. A
-- player whose anonymous sign-in genuinely failed has nothing durable to hang a
-- count on and is skipped, which is the honest outcome rather than a lost row.

CREATE OR REPLACE FUNCTION op_record_claps(p_room_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_game_key text;
  v_written  int := 0;
BEGIN
  IF p_room_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT countdown_started_at::text INTO v_game_key FROM rooms WHERE id = p_room_id;
  IF v_game_key IS NULL THEN
    RETURN 0;
  END IF;

  -- THE DENOMINATOR IS COUNTED PER ROUND. `rounds` is who held a row in each
  -- round, which every round already writes via op_fill_blank_answers — the
  -- same evidence op_played_whole_game reads. `available` then sums, for each
  -- player, the people they could have been clapped by in the rounds they were
  -- actually in.
  --
  -- A BOT IS NOT A CLAP AVAILABLE, and this is not a detail. A bot holds an
  -- answer row in every round exactly like a person, so counting seats would
  -- make a solo practice game read as one clap available per round — from a
  -- player that has no screen, no finger and no opinion. Every practice game
  -- would then drag the owner's own rate towards zero, permanently, and the one
  -- number that is supposed to say "people liked your answers" would mostly be
  -- measuring how often they played alone.
  --
  -- LEFT JOIN, and a row we cannot find COUNTS AS A PERSON. An answer outlives
  -- its seat (052), so somebody swept mid-game has no `players` row to read —
  -- and this project's oldest rule is that a missing value means "cannot tell"
  -- and takes the reading that does not destroy something. Over-counting a
  -- departed player by a clap or two is the harmless direction; the owner
  -- raised that case themselves and called it negligible.
  WITH rounds AS (
    SELECT question_number, player_id
      FROM answers
     WHERE room_id = p_room_id
     GROUP BY question_number, player_id
  ),
  clappers AS (
    SELECT r.question_number, count(*) AS humans
      FROM rounds r
      LEFT JOIN players p ON p.id = r.player_id
     WHERE coalesce(p.is_bot, false) = false
     GROUP BY r.question_number
  ),
  available AS (
    -- Subtract yourself only if you were one of the people counted above, so a
    -- bot's own denominator is not quietly one too high. Its row is discarded
    -- below anyway (a bot has no user_id), and a rule that only works because
    -- of something two lines further down is a rule waiting to be wrong.
    SELECT r.player_id,
           sum(greatest(c.humans - CASE WHEN coalesce(p.is_bot, false) THEN 0 ELSE 1 END, 0))::int
             AS claps_available
      FROM rounds r
      LEFT JOIN players p ON p.id = r.player_id
      JOIN clappers c USING (question_number)
     GROUP BY r.player_id
  ),
  received AS (
    SELECT clapped_player_id AS player_id, count(*)::int AS claps_received
      FROM answer_claps
     WHERE room_id = p_room_id AND game_key = v_game_key
     GROUP BY clapped_player_id
  )
  INSERT INTO clap_history (user_id, room_id, game_key, claps_received, claps_available)
  SELECT p.user_id,
         p_room_id,
         v_game_key,
         coalesce(rc.claps_received, 0),
         coalesce(av.claps_available, 0)
    FROM available av
    JOIN players p ON p.id = av.player_id
    LEFT JOIN received rc ON rc.player_id = av.player_id
   WHERE p.user_id IS NOT NULL
  ON CONFLICT ON CONSTRAINT clap_history_one_per_game DO NOTHING;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN v_written;
END;
$$;

REVOKE ALL ON FUNCTION op_record_claps(uuid) FROM public;
GRANT EXECUTE ON FUNCTION op_record_claps(uuid) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICATION — run this and paste back what it prints.
--
-- It LOOKS rather than asserting a count, which is the lesson migration 051
-- learned the hard way: a check that can fail must print what it saw, or a
-- FAIL and a wrong question are indistinguishable and cost a round trip.
-- ---------------------------------------------------------------------------

DO $verify$
DECLARE
  v_ok text;
BEGIN
  RAISE NOTICE '--- 071 verification ---';

  SELECT CASE WHEN to_regclass('public.answer_claps') IS NOT NULL
              THEN 'ok' ELSE 'FAIL' END INTO v_ok;
  RAISE NOTICE 'answer_claps exists: %', v_ok;

  SELECT CASE WHEN to_regclass('public.clap_history') IS NOT NULL
              THEN 'ok' ELSE 'FAIL' END INTO v_ok;
  RAISE NOTICE 'clap_history exists: %', v_ok;

  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = 'op_clap_answer')
    THEN 'ok' ELSE 'FAIL' END INTO v_ok;
  RAISE NOTICE 'op_clap_answer installed: %', v_ok;

  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = 'op_record_claps')
    THEN 'ok' ELSE 'FAIL' END INTO v_ok;
  RAISE NOTICE 'op_record_claps installed: %', v_ok;

  -- The 063 lesson: a new table arrives already granted to everybody, and the
  -- privilege is what to check, never the policy. A policy that looks right
  -- sits happily on top of a privilege that should not exist.
  SELECT CASE WHEN has_table_privilege('anon', 'answer_claps', 'INSERT')
               OR has_table_privilege('anon', 'answer_claps', 'UPDATE')
               OR has_table_privilege('anon', 'answer_claps', 'DELETE')
               OR has_table_privilege('authenticated', 'answer_claps', 'INSERT')
               OR has_table_privilege('authenticated', 'answer_claps', 'UPDATE')
               OR has_table_privilege('authenticated', 'answer_claps', 'DELETE')
              THEN 'FAIL — a client can write a clap directly'
              ELSE 'ok' END INTO v_ok;
  RAISE NOTICE 'claps are writable only through the function: %', v_ok;

  SELECT CASE WHEN has_table_privilege('anon', 'clap_history', 'INSERT')
               OR has_table_privilege('anon', 'clap_history', 'UPDATE')
               OR has_table_privilege('authenticated', 'clap_history', 'INSERT')
               OR has_table_privilege('authenticated', 'clap_history', 'UPDATE')
              THEN 'FAIL — a client can write down their own clap total'
              ELSE 'ok' END INTO v_ok;
  RAISE NOTICE 'nobody can forge a lifetime clap count: %', v_ok;

  SELECT CASE WHEN has_table_privilege('anon', 'answer_claps', 'SELECT')
              THEN 'ok' ELSE 'FAIL — claps cannot be read, so none will show' END INTO v_ok;
  RAISE NOTICE 'claps are readable: %', v_ok;

  -- The Play Again collision this key exists to prevent.
  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conname = 'answer_claps_one_per_round')
    THEN 'ok' ELSE 'FAIL' END INTO v_ok;
  RAISE NOTICE 'one clap per person per round, per game: %', v_ok;
END
$verify$;
