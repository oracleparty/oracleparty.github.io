-- ============================================
-- 059 — YOU MAY RATE A HOST ONLY IF YOU PLAYED THE WHOLE GAME
--
-- Needs 054 (op_rate_host) and 046 (op_room_total_questions).
--
-- THE OWNER'S DECISION, taken after I argued against it twice and they answered
-- both objections. Recorded that way round because CLAUDE.md currently states
-- the opposite rule and the reasoning that produced it.
--
-- MY OBJECTIONS AND WHY THEY DID NOT SURVIVE:
--
--  1. "A bad host is the commonest reason somebody leaves early, so this
--     silences the people with the strongest complaint." — Answered: the FLAG
--     is a separate tool and keeps the old rule. Somebody who leaves in disgust
--     reports the host; they just do not get to cast a satisfaction score for a
--     game they did not see. Thumbs mean "would you play with them again", flag
--     means "this was improper", and those want different evidence.
--
--  2. "It locks out anyone who joins a game in progress." — Answered: they can
--     play the next game. Hot-joining is a way IN, not a way to be owed a vote.
--
--  3. "An away phone and a leaver look identical." — This one was simply WRONG
--     and I said so. Being away costs you nothing: you stay seated, and the
--     blank fill writes you an entry every round while you are gone. Only after
--     about two minutes of silence is the seat actually released. So "kept your
--     seat throughout" is exactly the line the owner drew, and it is precisely
--     measurable.
--
-- HOW IT IS MEASURED, and this is the part that makes the rule honest rather
-- than approximate. Every round ends with op_fill_blank_answers writing a row
-- for EVERY player in the room, so a seated player accumulates one row per
-- round whether they answered or not. Someone who joined late never gets rows
-- for the earlier rounds; someone whose seat was swept stops getting them. So
-- "has a row for every round so far" IS "kept their seat from the start", with
-- no inference in between.
--
-- AND IT IS ONLY TRUE AT THE END. The buttons live on the reveal, which happens
-- every round, so a rule about the WHOLE game can only be enforced once the
-- game has reached its last round — otherwise somebody rates at round one,
-- leaves, and has technically been present for everything so far. The rating
-- therefore requires the room to be ON the final round.
-- ============================================


-- --------------------------------------------
-- 1. Did this player sit through every round of this game?
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_played_whole_game(p_room_id uuid, p_player_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
DECLARE
  r rooms;
  final_round int;
  rounds_present int;
BEGIN
  SELECT * INTO r FROM rooms WHERE id = p_room_id;
  IF r.id IS NULL THEN RETURN false; END IF;

  -- The room holds N+1 questions and the final wager round is number N, so the
  -- rounds are 0..N and there are N+1 of them. Getting this off by one silently
  -- turns "played it all" into "played all but the last", which is exactly the
  -- round the whole rule is about.
  final_round := op_room_total_questions(r);
  IF final_round IS NULL OR final_round < 0 THEN RETURN false; END IF;

  -- MUST BE ON THE LAST ROUND. Before that, "present for every round so far" is
  -- not the same claim as "played the whole game".
  IF coalesce(r.current_question, -1) < final_round THEN RETURN false; END IF;

  SELECT count(DISTINCT a.question_number) INTO rounds_present
    FROM answers a
   WHERE a.room_id = p_room_id
     AND a.player_id = p_player_id
     AND a.question_number BETWEEN 0 AND final_round;

  RETURN rounds_present >= final_round + 1;
END;
$$;

GRANT EXECUTE ON FUNCTION op_played_whole_game(uuid, uuid) TO anon, authenticated;


-- --------------------------------------------
-- 2. Apply it to the RATING only, never to the flag
--
-- Replaces op_rate_host from 054. Everything else about it is unchanged and is
-- restated here rather than patched, because a function is replaced whole.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_rate_host(
  p_room_id     uuid,
  p_player_id   uuid,
  p_voter_id    text,
  p_rating      smallint DEFAULT NULL,
  p_flag_reason text     DEFAULT NULL,
  p_flag_note   text     DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_host_user uuid;
  v_voter_name text;
BEGIN
  IF p_rating IS NULL AND p_flag_reason IS NULL THEN
    RETURN 'nothing to record';
  END IF;
  IF p_rating IS NOT NULL AND p_rating NOT IN (-1, 1) THEN
    RETURN 'not a rating';
  END IF;

  SELECT display_name INTO v_voter_name
  FROM players WHERE room_id = p_room_id AND id = p_player_id;
  IF v_voter_name IS NULL THEN RETURN 'not in this room'; END IF;

  SELECT p.user_id INTO v_host_user
  FROM players p
  WHERE p.room_id = p_room_id AND p.is_host AND p.user_id IS NOT NULL
  LIMIT 1;
  IF v_host_user IS NULL THEN RETURN 'host has no account'; END IF;

  IF EXISTS (
    SELECT 1 FROM players
     WHERE room_id = p_room_id AND id = p_player_id AND user_id = v_host_user
  ) THEN RETURN 'cannot rate yourself'; END IF;

  -- THE FLAG KEEPS THE OLD RULE: one round played. This is what makes the
  -- stricter rating rule defensible at all — somebody who leaves a game because
  -- the host was improper is not silenced, they report it. Gating the flag on
  -- full attendance would silence exactly the complaint worth hearing.
  IF NOT EXISTS (
    SELECT 1 FROM answers WHERE room_id = p_room_id AND player_id = p_player_id
  ) THEN
    RETURN 'you have not played a round yet';
  END IF;

  -- THE RATING NEEDS THE WHOLE GAME. Checked only when a rating is actually
  -- being cast, so a flag from a leaver still gets through the same call.
  IF p_rating IS NOT NULL AND NOT op_played_whole_game(p_room_id, p_player_id) THEN
    -- A flag riding along with a refused rating must still land, or the one
    -- thing a leaver CAN do would be lost to the rule that stops the other.
    IF p_flag_reason IS NULL THEN
      RETURN 'you did not play the whole game';
    END IF;
    p_rating := NULL;
  END IF;

  INSERT INTO host_ratings (host_user_id, room_id, voter_id, voter_name,
                            rating, flag_reason, flag_note)
  VALUES (v_host_user, p_room_id, p_voter_id, v_voter_name,
          p_rating, p_flag_reason, p_flag_note)
  ON CONFLICT (host_user_id, room_id, voter_id) DO UPDATE
    SET rating      = COALESCE(EXCLUDED.rating,      host_ratings.rating),
        flag_reason = COALESCE(EXCLUDED.flag_reason, host_ratings.flag_reason),
        flag_note   = COALESCE(EXCLUDED.flag_note,   host_ratings.flag_note),
        updated_at  = now();

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION op_rate_host(uuid, uuid, text, smallint, text, text)
  TO anon, authenticated;


-- --------------------------------------------
-- 3. Verify
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'op_played_whole_game installed' AS thing,
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'op_played_whole_game')
    THEN 'ok' ELSE 'MISSING' END AS verdict
  UNION ALL SELECT 2, 'op_rate_host still callable',
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'NOT CALLABLE — nobody could rate or flag' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_rate_host'), 'MISSING')
  UNION ALL SELECT 3, 'the blank fill this rule depends on is present',
    CASE WHEN EXISTS (SELECT 1 FROM pg_proc p
                      JOIN pg_namespace n ON n.oid = p.pronamespace
                      WHERE n.nspname = 'public' AND p.proname = 'op_fill_blank_answers')
    THEN 'ok' ELSE 'MISSING — nobody would ever qualify' END
) report ORDER BY ord;
