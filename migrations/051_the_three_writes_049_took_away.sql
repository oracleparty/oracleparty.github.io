-- ============================================
-- 051 — THE THREE WRITES SLICE 6 TOOK AWAY
--
-- Needs 045–050.
--
-- Migration 049 (and 050, which finished the job) dropped every UPDATE and
-- DELETE policy on `answers`, so that a stranger could no longer mark any
-- answer in any live game right or wrong. That was the right hole to close.
--
-- But `answers` carried THREE legitimate writes that were neither a judgement
-- nor an attack, and all three went through UPDATE or DELETE. Every one of them
-- now fails the way an RLS refusal always fails: **no error, zero rows, and the
-- app carries on as though it worked.** Exactly the shape CLAUDE.md #4 and #5
-- are about, and I introduced it.
--
-- | Broken by 049/050        | What a player sees                              |
-- |--------------------------|-------------------------------------------------|
-- | deleteAnswersByRoom      | Play Again keeps the LAST game's answers         |
-- | reassignPlayerAnswers    | rejoin loses your score and your used wagers     |
-- | upsertAnswers (bots)     | a bot never answers the final question           |
--
-- Play Again is the worst of them: the room resets, the next game starts, and
-- every scoreboard is computed over answers from a game that already finished.
--
-- The fix is not to reopen the door. Each of these reduces to a rule the server
-- can check for itself, which is the whole premise of the rebuild:
--
--   * clearing a room's answers is something only that room's HOST may do;
--   * reassigning answers is only for a seat that IS GONE — you can never take
--     answers off a player who is still in the room;
--   * writing an answer on somebody's behalf is only ever allowed for a BOT,
--     which is the only player that cannot write its own.
-- ============================================


-- --------------------------------------------
-- 1. Play Again clears the room's answers
--
-- Host-only, because this deletes a whole game's scores and there is no way to
-- get them back. Both call sites (handlePlayAgain, executeReturnToLobby) are
-- already host-gated in the client; this is the same rule stated where it
-- cannot be edited out of a request.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_reset_answers(
  p_room_id uuid,
  p_caller_id uuid
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  gone int;
BEGIN
  IF NOT op_is_room_host(p_room_id, p_caller_id) THEN
    RETURN -1;                      -- refused, and distinguishable from "none"
  END IF;

  DELETE FROM answers WHERE room_id = p_room_id;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END;
$$;

GRANT EXECUTE ON FUNCTION op_reset_answers(uuid, uuid) TO anon, authenticated;


-- --------------------------------------------
-- 2. A returning player gets their own answers back
--
-- The guard is NOT "are you the host" — a player rejoining is doing this for
-- themselves and is nobody special. It is that the seat being emptied MUST NO
-- LONGER EXIST. Answers are only ever left behind by a row that was deleted;
-- if a `players` row still holds that id, somebody is sitting in that seat and
-- their answers are not up for grabs.
--
-- The destination must be a real player in the same room, so answers cannot be
-- moved out of the game they were played in.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_reassign_answers(
  p_room_id uuid,
  p_old_player_id uuid,
  p_new_player_id uuid
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  moved int;
BEGIN
  IF p_old_player_id IS NULL OR p_new_player_id IS NULL
     OR p_old_player_id = p_new_player_id THEN
    RETURN 0;
  END IF;

  -- The old seat is still occupied — this is not a rejoin, it is a theft.
  IF EXISTS (SELECT 1 FROM players WHERE id = p_old_player_id) THEN
    RETURN -1;
  END IF;

  -- The new seat has to be a real one, in this room.
  IF NOT EXISTS (SELECT 1 FROM players
                  WHERE id = p_new_player_id AND room_id = p_room_id) THEN
    RETURN -1;
  END IF;

  -- A rejoining player may already have written an answer for a round their old
  -- seat also holds (they came back mid-round and typed something). The unique
  -- key is (room_id, player_id, question_number), so moving the old row onto
  -- theirs would raise 23505 and lose the whole reassignment. The row they
  -- wrote as themselves is the newer one and wins; the stale duplicate goes.
  DELETE FROM answers old
   WHERE old.room_id = p_room_id
     AND old.player_id = p_old_player_id
     AND EXISTS (SELECT 1 FROM answers cur
                  WHERE cur.room_id = p_room_id
                    AND cur.player_id = p_new_player_id
                    AND cur.question_number = old.question_number);

  UPDATE answers SET player_id = p_new_player_id
   WHERE room_id = p_room_id AND player_id = p_old_player_id;
  GET DIAGNOSTICS moved = ROW_COUNT;
  RETURN moved;
END;
$$;

GRANT EXECUTE ON FUNCTION op_reassign_answers(uuid, uuid, uuid) TO anon, authenticated;


-- --------------------------------------------
-- 3. The host answers the final question for a bot
--
-- A bot is the one player that cannot write its own answer — the host's browser
-- does it (CLAUDE.md, Practice Bots). On the final round the bot already holds a
-- __WAGER_LOCKED__ placeholder, so this has to MERGE over an existing row, which
-- is an UPDATE, which 049 closed.
--
-- The guard is the tightest one available and it is not "host": the target must
-- be `is_bot`. Nothing a person plays can be written through here at all, so
-- reopening this reopens nothing about a real player's score.
--
-- The SCORE is computed here rather than accepted from the caller, for the same
-- reason op_set_judgement recomputes it: a number that arrives in a request is
-- a number anybody can choose. The verdict itself is the bot's coin flip and
-- does come from the caller — a bot's accuracy is a setting, not a fact about
-- the answer, and nothing a bot does is ever recorded anyway.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_bot_answer(
  p_room_id uuid,
  p_player_id uuid,
  p_question_number int,
  p_question_id uuid,
  p_wager int,
  p_answer text,
  p_is_correct boolean
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  total int;
  is_final boolean;
  r rooms;
  points int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM players
                  WHERE id = p_player_id AND room_id = p_room_id
                    AND coalesce(is_bot, false) = true) THEN
    RETURN false;
  END IF;

  SELECT * INTO r FROM rooms WHERE id = p_room_id;
  IF NOT FOUND THEN RETURN false; END IF;

  total    := op_room_total_questions(r);
  is_final := p_question_number >= total;

  -- The final round is the only one that subtracts. Everywhere else a miss is
  -- worth nothing and never less than nothing.
  IF p_is_correct THEN
    points := coalesce(p_wager, 0);
  ELSIF is_final THEN
    points := -coalesce(p_wager, 0);
  ELSE
    points := 0;
  END IF;

  INSERT INTO answers (room_id, player_id, question_number, question_id,
                       wager, submitted_answer, is_correct, auto_correct, score_earned)
  VALUES (p_room_id, p_player_id, p_question_number, p_question_id,
          coalesce(p_wager, 0), coalesce(p_answer, ''),
          p_is_correct, p_is_correct, points)
  ON CONFLICT (room_id, player_id, question_number) DO UPDATE
    SET submitted_answer = EXCLUDED.submitted_answer,
        question_id      = EXCLUDED.question_id,
        is_correct       = EXCLUDED.is_correct,
        auto_correct     = EXCLUDED.auto_correct,
        score_earned     = EXCLUDED.score_earned
    -- Never overwrite an answer the bot already gave for real. The only row this
    -- may replace is the wager placeholder it wrote for itself.
    WHERE btrim(coalesce(answers.submitted_answer, '')) IN ('', '__WAGER_LOCKED__');

  RETURN true;
END;
$$;

GRANT EXECUTE ON FUNCTION op_bot_answer(uuid, uuid, int, uuid, int, text, boolean) TO anon, authenticated;


-- --------------------------------------------
-- 4. An admin ends a stuck room
--
-- A FOURTH thing migration 048 took down, and it is not on the list above
-- because it is `rooms`, not `answers`. The admin dashboard's "End" button was
-- a plain DELETE on rooms, which 048 revoked — so it reported success, redrew
-- the dashboard, and the room was still there. `op_leave_room` cannot stand in
-- for it: that one deletes a room only when nobody is left, and the entire
-- point of this button is a room that still has players in it.
--
-- This is the ONE place in the rebuild where the caller's identity can actually
-- be checked, and so it is. Hosts are very often guests with no auth.uid() at
-- all, which is why op_set_judgement has to reason about the CLAIM instead —
-- but an admin is by definition signed in.
--
-- Checked on profiles.user_id, never profiles.id. Migration 024 got that wrong,
-- created a policy that matched no row for anybody, and looked installed the
-- whole time (CLAUDE.md #5).
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_admin_end_room(p_room_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM profiles
     WHERE profiles.user_id = auth.uid()
       AND coalesce(profiles.is_admin, false) = true
  ) THEN
    RETURN false;
  END IF;

  DELETE FROM rooms WHERE id = p_room_id;
  RETURN FOUND;
END;
$$;

-- authenticated only. An admin is signed in by definition, and granting this to
-- anon would hand every visitor a button that ends any game in progress.
GRANT EXECUTE ON FUNCTION op_admin_end_room(uuid) TO authenticated;


-- --------------------------------------------
-- 5. Make sure the ROOMS door is actually shut
--
-- Migration 048 closed it with `DROP POLICY IF EXISTS "Rooms: anyone can
-- delete"` — BY NAME — and verified with `cmd = 'DELETE'`. Both are the exact
-- weaknesses that made 049 fail silently on the live database:
--
--   * the live policy names are not the ones migration 022 declares, so a
--     by-name drop can match nothing and say nothing (IF EXISTS makes it a
--     NOTICE, not an error);
--   * a policy written FOR ALL has cmd = 'ALL' and grants DELETE as a side
--     effect, so the check reads "ok" with the door wide open.
--
-- 049 was caught because its verification happened to be run and reported FAIL.
-- 048's could not catch either case. This redoes it the way 036 and 050 do it:
-- by looking at what is there.
--
-- rooms UPDATE deliberately STAYS OPEN. The phase machine still runs in the
-- browser (CLAUDE.md #1), so every client must be able to write game_phase.
-- That closes with a later slice, not this one.
-- --------------------------------------------
DO $$
DECLARE
  pol record;
BEGIN
  -- Recreate what the app legitimately needs BEFORE removing anything, so
  -- dropping a FOR ALL policy cannot lock players out of their own rooms.
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'rooms' AND cmd = 'SELECT') THEN
    EXECUTE 'CREATE POLICY "Rooms: anyone can read" ON rooms FOR SELECT USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'rooms' AND cmd = 'INSERT') THEN
    EXECUTE 'CREATE POLICY "Rooms: anyone can insert" ON rooms FOR INSERT WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'rooms' AND cmd = 'UPDATE') THEN
    EXECUTE 'CREATE POLICY "Rooms: anyone can update" ON rooms FOR UPDATE USING (true) WITH CHECK (true)';
  END IF;

  FOR pol IN SELECT policyname FROM pg_policies
              WHERE schemaname = 'public' AND tablename = 'rooms'
                AND cmd IN ('DELETE', 'ALL')
  LOOP
    EXECUTE format('DROP POLICY %I ON rooms', pol.policyname);
  END LOOP;
END $$;


-- --------------------------------------------
-- VERIFY — every cell must read "ok"
--
-- EVERY CHECK IS SCHEMA-QUALIFIED, and the first version of this was not.
-- `pg_policies` spans the whole database, so `WHERE tablename = 'answers'`
-- also matches a table of that name in any other schema — and the DROP loops
-- above are correctly confined to `public`. An unqualified check can therefore
-- report FAIL for a policy this migration was never going to touch, sending
-- the next session hunting a hole that is not in the app's schema at all.
--
-- That is the same family of mistake as 048 verifying a single `cmd` value:
-- the check must ask exactly the question the fix answers.
-- --------------------------------------------
-- ONE RESULT SET, AND A FAILURE CARRIES ITS OWN EVIDENCE.
--
-- The first version returned a row of ok/FAIL cells and nothing else. When
-- door_still_shut came back FAIL on the live database there was no way to tell
-- WHICH policy was still there, or even which schema it was in, and settling it
-- cost a separate round trip to the owner. A check that can fail should print
-- what it saw. The policy listing is appended below the verdicts, so every run
-- shows the real state of both tables whether it passes or not.
SELECT * FROM (
  SELECT 1 AS ord, 'play_again' AS check_name,
         CASE WHEN to_regprocedure('op_reset_answers(uuid,uuid)') IS NOT NULL
              THEN 'ok' ELSE 'FAIL Play Again cannot clear the last game' END AS result
  UNION ALL
  SELECT 2, 'rejoin',
         CASE WHEN to_regprocedure('op_reassign_answers(uuid,uuid,uuid)') IS NOT NULL
              THEN 'ok' ELSE 'FAIL rejoining loses your score' END
  UNION ALL
  SELECT 3, 'bots',
         CASE WHEN to_regprocedure('op_bot_answer(uuid,uuid,int,uuid,int,text,boolean)') IS NOT NULL
              THEN 'ok' ELSE 'FAIL a bot cannot answer the final question' END
  UNION ALL
  SELECT 4, 'end_room',
         CASE WHEN to_regprocedure('op_admin_end_room(uuid)') IS NOT NULL
              THEN 'ok' ELSE 'FAIL the admin cannot end a stuck room' END
  UNION ALL
  SELECT 5, 'answers_door_shut',
         CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies
                                WHERE schemaname = 'public' AND tablename = 'answers'
                                  AND cmd IN ('UPDATE','DELETE','ALL'))
              THEN 'ok' ELSE 'FAIL a stranger can still edit a score' END
  UNION ALL
  SELECT 6, 'rooms_door_shut',
         CASE WHEN NOT EXISTS (SELECT 1 FROM pg_policies
                                WHERE schemaname = 'public' AND tablename = 'rooms'
                                  AND cmd IN ('DELETE','ALL'))
              THEN 'ok' ELSE 'FAIL a stranger can still delete a live room' END
  UNION ALL
  SELECT 7, 'rooms_still_playable',
         CASE WHEN EXISTS (SELECT 1 FROM pg_policies
                            WHERE schemaname = 'public' AND tablename = 'rooms'
                              AND cmd IN ('UPDATE','ALL'))
              THEN 'ok' ELSE 'FAIL nobody can advance a game' END
  UNION ALL
  SELECT 8, 'answers may still be', 'read and written, never edited or deleted'
  UNION ALL
  -- Every policy on either table, in EVERY schema. A row here naming a schema
  -- other than public is not the game's table and is not a hole in the game.
  SELECT 9, schemaname || '.' || tablename, cmd || '  <- ' || policyname
    FROM pg_policies WHERE tablename IN ('answers', 'rooms')
) report ORDER BY ord, check_name, result;
