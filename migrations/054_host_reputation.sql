-- ============================================
-- Migration 054: would you play with this host again?
--
-- WHY, in the owner's words: "before joining a random lobby someone would know
-- if the host is reliable or not, as opposed to after being negatively
-- affected." Public games are listed on the join page, so joining a stranger's
-- room is a real thing people do, and the host still holds one real power over
-- everybody in it — overriding the server's verdict, which amends the permanent
-- question_history of every player it touches (migration 041).
--
-- WHAT IT IS NOT. It is not "was this host CORRECT". Nobody can answer that
-- about a ruling on their own answer, and a board that tried would reward
-- lenient hosts and punish accurate ones — mark everything right, get 100%.
-- The owner's framing is the one this implements and it is the defensible one:
-- WOULD YOU PLAY WITH THEM AGAIN. Players know a low score means somebody was
-- dissatisfied, and can decide for themselves whether a strict host is a good
-- one.
--
-- ONE VOTE PER PLAYER PER GAME, not per round. Per round was the original idea
-- and the owner spotted its flaw first: it skews toward short games. It has a
-- worse one — one person in a ten-round game would outweigh four people in a
-- five-round one. The vote is cast FROM the reveal screen, where the judging is
-- visible and the feedback buttons already live, and re-tapping changes it.
--
-- A HOST WITHOUT AN ACCOUNT CANNOT HAVE A REPUTATION. host_user_id references
-- auth.users, and a guest has none — that is what guest play means. A guest's
-- room simply shows no rating, which is honest and is itself a signal.
--
-- ============================================
-- Table
-- ============================================

CREATE TABLE IF NOT EXISTS host_ratings (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  host_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- NO FOREIGN KEY TO rooms, deliberately, and this is the third time this
  -- project has had to learn it. game_plays lost every row it ever wrote to a
  -- cascade from rooms (migration 033) and answers lost a rejoining player's
  -- whole score the same way (052). A room is deleted the moment the last
  -- person leaves, which is seconds after the game this rating is ABOUT. The
  -- room is how the vote is scoped at the time; it is not what the record is of.
  room_id      uuid NOT NULL,

  -- 'user:<uuid>' signed in, 'device:<uuid>' otherwise — the same identity
  -- question_feedback uses. Guests vote too: gating this behind sign-up would
  -- mean most games are never rated, which defeats the point.
  voter_id     text NOT NULL,
  voter_name   text,

  -- NULL is allowed: you may flag without rating, or rate without flagging.
  rating       smallint CHECK (rating IN (-1, 1)),
  flag_reason  text,
  flag_note    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT host_ratings_says_something
    CHECK (rating IS NOT NULL OR flag_reason IS NOT NULL),
  CONSTRAINT host_ratings_one_per_voter_per_game
    UNIQUE (host_user_id, room_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_host_ratings_host ON host_ratings (host_user_id);

ALTER TABLE host_ratings ENABLE ROW LEVEL SECURITY;

-- Readable by anyone: the whole point is that you can see it before you join.
DROP POLICY IF EXISTS "Host ratings: public read" ON host_ratings;
CREATE POLICY "Host ratings: public read" ON host_ratings FOR SELECT USING (true);

-- NO insert, update or delete policy. Every write goes through op_rate_host
-- below, which runs as the table owner and checks that the voter was actually
-- in that room. Without that, anybody holding the publishable key — which every
-- browser carries, because guests play — could bury a stranger they have never
-- met, and a reputation nobody can trust is worse than none.
GRANT SELECT ON host_ratings TO anon, authenticated;


-- ============================================
-- op_rate_host — the only way a rating is written
--
-- The guard cannot be "the caller is signed in": a voter is very often a guest
-- with no auth.uid(). So it is about the CLAIM, exactly as
-- amend_question_history's is: the vote is accepted only if that voter really
-- has a player row in that room, and the person being rated really is its host.
-- You cannot reach into a stranger's game from nowhere.
--
-- Somebody already in the room could still vote dishonestly. They can also
-- already edit the scoreboard (CLAUDE.md #2), so this opens nothing that was
-- closed — and being in the room is the qualification the rating is about.
-- ============================================

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

  -- The voter must be sitting in this room right now.
  SELECT display_name INTO v_voter_name
  FROM players
  WHERE room_id = p_room_id AND id = p_player_id;
  IF v_voter_name IS NULL THEN
    RETURN 'not in this room';
  END IF;

  -- And the room must have a signed-in host to attach the rating to. A guest
  -- host is not an error and must not read as one — it is the ordinary case for
  -- a game among friends.
  SELECT p.user_id INTO v_host_user
  FROM players p
  WHERE p.room_id = p_room_id AND p.is_host AND p.user_id IS NOT NULL
  LIMIT 1;
  IF v_host_user IS NULL THEN
    RETURN 'host has no account';
  END IF;

  -- Rating yourself is not a rating.
  IF EXISTS (
    SELECT 1 FROM players
     WHERE room_id = p_room_id AND id = p_player_id AND user_id = v_host_user
  ) THEN
    RETURN 'cannot rate yourself';
  END IF;

  INSERT INTO host_ratings (host_user_id, room_id, voter_id, voter_name,
                            rating, flag_reason, flag_note)
  VALUES (v_host_user, p_room_id, p_voter_id, v_voter_name,
          p_rating, p_flag_reason, p_flag_note)
  ON CONFLICT (host_user_id, room_id, voter_id) DO UPDATE
    SET rating      = COALESCE(EXCLUDED.rating,      host_ratings.rating),
        -- A flag is never cleared by a later thumbs-up. Changing your mind
        -- about the rating is ordinary; withdrawing a report of misconduct is
        -- not something a tap should do by accident.
        flag_reason = COALESCE(EXCLUDED.flag_reason, host_ratings.flag_reason),
        flag_note   = COALESCE(EXCLUDED.flag_note,   host_ratings.flag_note),
        updated_at  = now();

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION op_rate_host(uuid, uuid, text, smallint, text, text)
  TO anon, authenticated;


-- ============================================
-- host_reputation — what a player sees before they join
--
-- THE SAMPLE IS PART OF THE MEASURE, not a footnote. "100%" from two games and
-- "100%" from two hundred are different claims and the app must never let them
-- look alike — the same rule the difficulty band on the reveal follows, and the
-- owner asked for the sample explicitly.
-- ============================================

CREATE OR REPLACE VIEW host_reputation AS
SELECT
  host_user_id,
  COUNT(*) FILTER (WHERE rating IS NOT NULL)::integer  AS ratings,
  COUNT(*) FILTER (WHERE rating = 1)::integer          AS thumbs_up,
  COUNT(*) FILTER (WHERE rating = -1)::integer         AS thumbs_down,
  CASE WHEN COUNT(*) FILTER (WHERE rating IS NOT NULL) = 0 THEN NULL
       ELSE round(100.0 * COUNT(*) FILTER (WHERE rating = 1)
                        / COUNT(*) FILTER (WHERE rating IS NOT NULL))
  END                                                  AS pct_positive,
  COUNT(*) FILTER (WHERE flag_reason IS NOT NULL)::integer AS flags
FROM host_ratings
GROUP BY host_user_id;

GRANT SELECT ON host_reputation TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — one result set, printed whether it passes or not.
--
-- A check that can fail must show what it saw: migration 051's verification
-- came back FAIL with two possible explanations and no way to tell them apart,
-- which cost a round trip to the owner that looking would have saved.
-- --------------------------------------------
SELECT * FROM (
  SELECT 1 AS ord, 'host_ratings table' AS thing,
    CASE WHEN to_regclass('public.host_ratings') IS NULL
         THEN 'MISSING' ELSE 'ok' END AS verdict
  UNION ALL SELECT 2, 'host_reputation view',
    CASE WHEN to_regclass('public.host_reputation') IS NULL
         THEN 'MISSING' ELSE 'ok' END
  UNION ALL SELECT 3, 'op_rate_host callable by anon',
    COALESCE((SELECT CASE WHEN has_function_privilege('anon', p.oid, 'EXECUTE')
                          THEN 'ok' ELSE 'NOT CALLABLE' END
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public' AND p.proname = 'op_rate_host'), 'MISSING')
  UNION ALL SELECT 4, 'nobody can write host_ratings directly',
    CASE WHEN EXISTS (
      SELECT 1 FROM pg_policies
       WHERE schemaname = 'public' AND tablename = 'host_ratings'
         AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL'))
    THEN 'FAIL a policy lets clients write it' ELSE 'ok' END
) report ORDER BY ord;

-- And every policy on the table, listed, so a FAIL above can be read rather
-- than reasoned about.
SELECT schemaname, tablename, policyname, cmd, roles
FROM pg_policies
WHERE tablename = 'host_ratings'
ORDER BY schemaname, policyname;
