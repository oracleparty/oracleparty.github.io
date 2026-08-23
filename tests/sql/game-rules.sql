-- ============================================
-- Oracle Party — the server's game rules, run against a real Postgres
--
-- Driven by scripts/verify-sql.mjs against a throwaway database. Every row it
-- emits is `check | got | want`, and the script fails on any row where the two
-- differ. Written as data rather than as assertions so a failure names the rule
-- that broke rather than a line number.
--
-- Everything here is about op_submit_answer and op_fill_blank_answers in
-- migration 046. The rules being pinned are the ones that would silently cost
-- somebody points if they moved.
-- ============================================

CREATE TEMP TABLE result (ord serial, check_name text, got text, want text);

DO $$
DECLARE
  rid uuid := gen_random_uuid();
  alice uuid := gen_random_uuid();
  bob uuid := gen_random_uuid();
  q uuid[] := ARRAY[]::uuid[];
  qid uuid;
  res record;
  n int;
BEGIN
  -- Four questions: three regular rounds (0,1,2) and the final wager at 3.
  FOR i IN 1..4 LOOP
    qid := gen_random_uuid();
    INSERT INTO questions (id, question, correct_answer, acceptable_answers, format)
    VALUES (qid, 'Q' || i, CASE i WHEN 1 THEN 'Napoleon' WHEN 2 THEN 'Tokyo'
                                  WHEN 3 THEN '1969'     ELSE 'Marie Antoinette' END,
            CASE i WHEN 2 THEN ARRAY['Edo'] ELSE ARRAY[]::text[] END, 'open');
    q := q || qid;
  END LOOP;

  INSERT INTO rooms (id, code, question_ids, current_question, questions_per_game,
                     question_timer, question_started_at, game_phase)
  VALUES (rid, '123456', q, 0, 3, 30, now(), 'question');

  INSERT INTO players (id, room_id, display_name, is_host, joined_at)
  VALUES (alice, rid, 'Alice', true, now() - interval '2 min'),
         (bob,   rid, 'Bob',   false, now() - interval '1 min');

  -- ---- the verdict, and that it is the SERVER's ----------------------------
  SELECT * INTO res FROM op_submit_answer(rid, alice, 0, 'napolean', 3);
  INSERT INTO result (check_name, got, want) VALUES
    ('a typo is still correct', res.is_correct::text, 'true'),
    ('a correct answer earns its wager', res.score_earned::text, '3'),
    ('nothing is rejected', coalesce(res.rejected, '-'), '-');

  SELECT * INTO res FROM op_submit_answer(rid, bob, 0, 'Wellington', 1);
  INSERT INTO result (check_name, got, want) VALUES
    ('a wrong answer is wrong', res.is_correct::text, 'false'),
    ('a wrong REGULAR answer never subtracts', res.score_earned::text, '0');

  -- ---- editing your answer before the timer ends ---------------------------
  SELECT * INTO res FROM op_submit_answer(rid, bob, 0, 'Napoleon', 1);
  INSERT INTO result (check_name, got, want) VALUES
    ('changing your mind in time is allowed', res.is_correct::text, 'true');
  INSERT INTO result (check_name, got, want)
  SELECT 'editing does not add a second row', count(*)::text, '1'
  FROM answers WHERE room_id = rid AND player_id = bob AND question_number = 0;

  -- ...but the WAGER cannot be re-chosen, which is how one value got spent twice
  SELECT * INTO res FROM op_submit_answer(rid, bob, 0, 'Napoleon', 3);
  INSERT INTO result (check_name, got, want) VALUES
    ('the wager cannot be changed by re-editing', res.wager::text, '1');

  -- ---- guards that did not exist before ------------------------------------
  SELECT * INTO res FROM op_submit_answer(rid, alice, 2, 'anything', 2);
  INSERT INTO result (check_name, got, want) VALUES
    ('cannot answer a round that is not on screen', coalesce(res.rejected, '-'), 'not the current question');

  SELECT * INTO res FROM op_submit_answer(rid, gen_random_uuid(), 0, 'Napoleon', 1);
  INSERT INTO result (check_name, got, want) VALUES
    ('cannot answer as somebody not in the room', coalesce(res.rejected, '-'), 'not in this room');

  -- ---- a spent wager is not offered twice ----------------------------------
  UPDATE rooms SET current_question = 1, question_started_at = now() WHERE id = rid;
  SELECT * INTO res FROM op_submit_answer(rid, alice, 1, 'Tokyo', 3);
  INSERT INTO result (check_name, got, want) VALUES
    ('asking for a spent wager gets the lowest unspent one', res.wager::text, '1'),
    ('an accepted alternate still counts', res.is_correct::text, 'true');

  -- ---- blanks ---------------------------------------------------------------
  n := op_fill_blank_answers(rid, 1);
  INSERT INTO result (check_name, got, want) VALUES
    ('the blank fill writes a row for whoever is missing', n::text, '1');
  -- 2, not 1: Bob spent wager 1 on round 0, and this is the rule that makes
  -- missing a round cost exactly what being present and wrong costs. A shared
  -- hardcoded 1 is what let one player spend the same value twice.
  INSERT INTO result (check_name, got, want)
  SELECT 'a missed round burns the player''s own lowest UNSPENT wager', wager::text, '2'
  FROM answers WHERE room_id = rid AND player_id = bob AND question_number = 1;

  n := op_fill_blank_answers(rid, 1);
  INSERT INTO result (check_name, got, want) VALUES
    ('calling it again writes nothing, so any phone may call it', n::text, '0');

  INSERT INTO result (check_name, got, want)
  SELECT 'a blank never overwrites a real answer', submitted_answer, 'Tokyo'
  FROM answers WHERE room_id = rid AND player_id = alice AND question_number = 1;

  -- ---- the timer -----------------------------------------------------------
  UPDATE rooms SET current_question = 2, question_started_at = now() - interval '5 min'
   WHERE id = rid;
  SELECT * INTO res FROM op_submit_answer(rid, alice, 2, '1969', 2);
  INSERT INTO result (check_name, got, want) VALUES
    ('an answer after the timer is refused', coalesce(res.rejected, '-'), 'time is up');

  UPDATE rooms SET question_started_at = now() WHERE id = rid;
  SELECT * INTO res FROM op_submit_answer(rid, alice, 2, '1969', 2);
  INSERT INTO result (check_name, got, want) VALUES
    ('and accepted inside it', res.is_correct::text, 'true');

  -- The digit guard, which is the difference between a near miss and a wrong
  -- year. This is the rule most likely to be quietly lost in a rewrite.
  SELECT * INTO res FROM op_submit_answer(rid, bob, 2, '1968', 1);
  INSERT INTO result (check_name, got, want) VALUES
    ('a wrong year is not a typo', res.is_correct::text, 'false');

  -- ---- the final round is the only one that subtracts -----------------------
  UPDATE rooms SET current_question = 3, question_started_at = now() WHERE id = rid;

  SELECT * INTO res FROM op_submit_answer(rid, alice, 3, 'Antoinette', 20);
  INSERT INTO result (check_name, got, want) VALUES
    ('the final round pays the wager', res.score_earned::text, '20');

  SELECT * INTO res FROM op_submit_answer(rid, bob, 3, 'Napoleon', 20);
  INSERT INTO result (check_name, got, want) VALUES
    ('and the final round TAKES it', res.score_earned::text, '-20');

  -- A wager nobody was offered. The three buttons are 0, 10 and 20.
  UPDATE answers SET wager = NULL WHERE room_id = rid AND question_number = 3;
  SELECT * INTO res FROM op_submit_answer(rid, bob, 3, 'Napoleon', 500);
  INSERT INTO result (check_name, got, want) VALUES
    ('a final wager off the menu becomes 0', res.wager::text, '0');

  -- Somebody who never touched the screen must wager NOTHING, not the 20 the
  -- interface defaults to. That default is there to punish indecision;
  -- committing it on a timeout would punish absence instead.
  DELETE FROM answers WHERE room_id = rid AND question_number = 3;
  n := op_fill_blank_answers(rid, 3);
  INSERT INTO result (check_name, got, want)
  SELECT 'a blank final wager is 0, not the 20 the screen defaults to',
         coalesce(sum(abs(coalesce(score_earned, 0))), 0)::text, '0'
  FROM answers WHERE room_id = rid AND question_number = 3;

  -- ---- __WAGER_LOCKED__ is not an answer ------------------------------------
  -- Locking a final wager writes a placeholder row. If the blank fill treated
  -- it as an answer, somebody who locked a wager and then said nothing would
  -- never be given their zero.
  DELETE FROM answers WHERE room_id = rid AND question_number = 3;
  INSERT INTO answers (room_id, player_id, question_number, submitted_answer, wager)
  VALUES (rid, alice, 3, '__WAGER_LOCKED__', 10);
  n := op_fill_blank_answers(rid, 3);
  INSERT INTO result (check_name, got, want) VALUES
    ('a locked wager still needs a blank answer', n::text, '2');
END $$;

SELECT check_name, got, want FROM result ORDER BY ord;
