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
  -- A random code, not a fixed one: rooms.code is UNIQUE, so a hardcoded value
  -- made this script runnable exactly once per database. verify-sql.mjs always
  -- starts a fresh one and so never saw it, but running it by hand against an
  -- existing scratch database failed on the second go — and the failure looked
  -- like a broken rule rather than a broken fixture.
  VALUES (rid, lpad((random() * 999999)::int::text, 6, '0'), q, 0, 3, 30, now(), 'question');

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

  -- ---- the clock is the DATABASE's, not a phone's --------------------------
  -- 046 compares the stamp against now(). If a phone's estimate of the server
  -- clock is slow, every answer in the room is refused as late; if it is fast,
  -- the timer never expires. Stamping from now() removes the disagreement by
  -- construction rather than tolerating it.
  UPDATE rooms SET game_phase = 'question', current_question = 1,
                   question_started_at = now() - interval '10 min' WHERE id = rid;
  DECLARE stamped timestamptz; after timestamptz;
          ancient timestamptz := timestamptz '2020-01-01 00:00:00Z';
  BEGIN
    -- BEWARE: now() IS TRANSACTION TIME in Postgres, frozen for the whole of
    -- this DO block. Two earlier versions of this check compared stamps taken
    -- before and after a call and could not tell a refusal from a restamp,
    -- because both produced the identical value — deleting the guard changed
    -- nothing either could see. An ancient marker is unambiguous: either it is
    -- still there or it is not.
    UPDATE rooms SET game_phase = 'question', current_question = 1,
                     question_started_at = ancient WHERE id = rid;
    stamped := op_start_clock(rid, 'question', 1);
    INSERT INTO result (check_name, got, want) VALUES
      ('starting a round stamps it with the database clock',
       (abs(extract(epoch FROM (now() - stamped))) < 5)::text, 'true');

    -- A host whose screen is behind must not reset a timer everybody else is
    -- already partway through.
    UPDATE rooms SET question_started_at = ancient WHERE id = rid;
    stamped := op_start_clock(rid, 'question', 0);       -- the room is on 1
    SELECT question_started_at INTO after FROM rooms WHERE id = rid;
    INSERT INTO result (check_name, got, want) VALUES
      ('a stale caller cannot restart the round everyone is in',
       (after = ancient)::text, 'true'),
      -- AND IS TOLD NOTHING HAPPENED. Handing back the stamp already on the
      -- room let the caller mistake the LAST round's clock for this round's —
      -- a twenty-second final wager opened already expired and locked the host
      -- at 0 before they could choose. Found in a live game.
      ('and is told nothing was stamped, not handed a stale clock',
       (stamped IS NULL)::text, 'true');

    -- Same for a caller that has the question right but the phase wrong.
    stamped := op_start_clock(rid, 'reveal', 1);
    SELECT question_started_at INTO after FROM rooms WHERE id = rid;
    INSERT INTO result (check_name, got, want) VALUES
      ('nor one that has the phase wrong', (after = ancient)::text, 'true');

    -- THE FINAL ROUND'S PHASE IS 'final_question'. The caller that asks for
    -- 'question' on it is a stale caller and is refused — correctly — so the
    -- client has to ask for the right one. It did not, and the last question of
    -- every game would have opened with the previous round's clock already
    -- most of the way through it.
    UPDATE rooms SET game_phase = 'final_question', current_question = 3,
                     question_started_at = ancient WHERE id = rid;
    stamped := op_start_clock(rid, 'question', 3);
    SELECT question_started_at INTO after FROM rooms WHERE id = rid;
    INSERT INTO result (check_name, got, want) VALUES
      ('asking for the wrong phase on the final round is refused', (after = ancient)::text, 'true'),
      ('and that refusal is NULL too', (stamped IS NULL)::text, 'true');
    stamped := op_start_clock(rid, 'final_question', 3);
    INSERT INTO result (check_name, got, want) VALUES
      ('asking for the right one starts its clock',
       (abs(extract(epoch FROM (now() - stamped))) < 5)::text, 'true');
  END;

  -- ---- a blank final answer keeps the wager it locked -----------------------
  --
  -- "I bet 20 on the final question and it wagered 0." The blank fill converted
  -- the locked placeholder AND zeroed the wager, so an answer arriving a moment
  -- later inherited that 0 — the rule that a locked final wager cannot be
  -- revised read the number the fill had just written. What a blank COSTS is
  -- the score; the wager the player chose is theirs.
  DELETE FROM answers WHERE room_id = rid AND question_number = 3;
  INSERT INTO answers (room_id, player_id, question_number, submitted_answer, wager)
  VALUES (rid, alice, 3, '__WAGER_LOCKED__', 20);
  n := op_fill_blank_answers(rid, 3);
  INSERT INTO result (check_name, got, want)
  SELECT 'a blank final answer keeps the wager the player locked', wager::text, '20'
  FROM answers WHERE room_id = rid AND player_id = alice AND question_number = 3;
  INSERT INTO result (check_name, got, want)
  SELECT 'and still costs them nothing', score_earned::text, '0'
  FROM answers WHERE room_id = rid AND player_id = alice AND question_number = 3;

  -- ...and an answer that lands just after the fill is judged on 20, not 0.
  UPDATE rooms SET current_question = 3, question_started_at = now() WHERE id = rid;
  SELECT * INTO res FROM op_submit_answer(rid, alice, 3, 'Marie Antoinette', 20);
  INSERT INTO result (check_name, got, want) VALUES
    ('an answer arriving after the fill still wagers what was locked', res.wager::text, '20'),
    ('and is paid on it', res.score_earned::text, '20');

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

-- ============================================
-- 048 — only the rules delete a room
-- ============================================
DO $$
DECLARE
  rid uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  alice uuid := gen_random_uuid();
  bob uuid := gen_random_uuid();
  botid uuid := gen_random_uuid();
  res text;
  n int;
BEGIN
  INSERT INTO rooms (id, code, status, created_at)
  VALUES (rid, lpad((random()*999999)::int::text, 6, '0'), 'playing', now());
  INSERT INTO players (id, room_id, display_name, last_seen_at, is_bot)
  VALUES (alice, rid, 'Alice', now(), false),
         (bob,   rid, 'Bob',   now(), false),
         (botid, rid, 'Bot',   NULL,  true);

  -- One person leaving a room with somebody still in it must not take the room.
  res := op_leave_room(rid, alice);
  INSERT INTO result (check_name, got, want) VALUES
    ('leaving a room somebody else is in just removes you', res, 'left');
  INSERT INTO result (check_name, got, want)
  SELECT 'and the room survives', count(*)::text, '1' FROM rooms WHERE id = rid;

  -- A BOT DOES NOT KEEP A ROOM ALIVE. Bob is the last human; the bot is still
  -- sitting there, and treating it as somebody would leave the room listed
  -- forever with nobody in it.
  res := op_leave_room(rid, bob);
  INSERT INTO result (check_name, got, want) VALUES
    ('the last human out takes the room, and a bot does not count', res, 'room deleted');
  INSERT INTO result (check_name, got, want)
  SELECT 'the room is really gone', count(*)::text, '0' FROM rooms WHERE id = rid;

  -- ---- the sweep --------------------------------------------------------
  -- A live game: everybody present, seconds ago. It must survive every rule.
  INSERT INTO rooms (id, code, status, created_at)
  VALUES (other, lpad((random()*999999)::int::text, 6, '0'), 'playing', now() - interval '5 hours');
  INSERT INTO players (id, room_id, display_name, last_seen_at, is_bot)
  VALUES (gen_random_uuid(), other, 'Playing', now(), false);
  n := op_sweep_rooms();
  INSERT INTO result (check_name, got, want)
  SELECT 'a game in progress survives the sweep however old it is', count(*)::text, '1'
  FROM rooms WHERE id = other;

  -- ...but a room whose people have all gone quiet for twenty minutes goes.
  UPDATE players SET last_seen_at = now() - interval '30 minutes' WHERE room_id = other;
  n := op_sweep_rooms();
  INSERT INTO result (check_name, got, want)
  SELECT 'a room everyone went silent in is swept', count(*)::text, '0'
  FROM rooms WHERE id = other;

  -- CANNOT TELL MEANS LEAVE IT ALONE. A player with no last_seen_at at all is
  -- not evidence of absence, and treating it as such once had hosts kicking
  -- every player seconds after they joined.
  INSERT INTO rooms (id, code, status, created_at)
  VALUES (other, lpad((random()*999999)::int::text, 6, '0'), 'playing', now() - interval '5 hours');
  INSERT INTO players (id, room_id, display_name, last_seen_at, is_bot)
  VALUES (gen_random_uuid(), other, 'Unknown', NULL, false);
  n := op_sweep_rooms();
  INSERT INTO result (check_name, got, want)
  SELECT 'a player we cannot place protects the room', count(*)::text, '1'
  FROM rooms WHERE id = other;

  DELETE FROM rooms WHERE id = other;
END $$;

-- ============================================
-- 049 — only a host changes a verdict
-- ============================================
DO $$
DECLARE
  rid uuid := gen_random_uuid();
  host uuid := gen_random_uuid();
  guest uuid := gen_random_uuid();
  stranger uuid := gen_random_uuid();
  q uuid[] := ARRAY[]::uuid[];
  qid uuid;
  aid uuid;
  res text;
  n int;
BEGIN
  FOR i IN 1..3 LOOP
    qid := gen_random_uuid();
    INSERT INTO questions (id, question, correct_answer, format)
    VALUES (qid, 'Q' || i, 'Napoleon', 'open');
    q := q || qid;
  END LOOP;

  INSERT INTO rooms (id, code, question_ids, current_question, questions_per_game,
                     question_timer, question_started_at, game_phase)
  VALUES (rid, lpad((random()*999999)::int::text, 6, '0'), q, 0, 2, 30, now(), 'question');
  INSERT INTO players (id, room_id, display_name, is_host, joined_at)
  VALUES (host,  rid, 'Host',  true,  now()),
         (guest, rid, 'Guest', false, now());

  PERFORM op_submit_answer(rid, guest, 0, 'Wellington', 1);
  SELECT id INTO aid FROM answers
   WHERE room_id = rid AND player_id = guest AND question_number = 0;

  -- A stranger with the room's ids but no seat in it cannot touch a verdict.
  res := op_set_judgement(aid, true, stranger);
  INSERT INTO result (check_name, got, want) VALUES
    ('somebody who is not in the room cannot change a verdict', res, 'not the host');
  INSERT INTO result (check_name, got, want)
  SELECT 'and the score is untouched', score_earned::text, '0' FROM answers WHERE id = aid;

  -- Nor can an ordinary player in the room.
  res := op_set_judgement(aid, true, guest);
  INSERT INTO result (check_name, got, want) VALUES
    ('nor can a player who is not the host', res, 'not the host');

  -- The host can, and the points come from the ANSWER'S OWN wager rather than
  -- from anything the caller sends.
  res := op_set_judgement(aid, true, host);
  INSERT INTO result (check_name, got, want) VALUES ('the host can', res, 'changed');
  INSERT INTO result (check_name, got, want)
  SELECT 'and the points come from the answer''s own wager', score_earned::text, '1'
  FROM answers WHERE id = aid;
  INSERT INTO result (check_name, got, want)
  SELECT 'the machine''s original verdict is kept for spotting bad answer keys',
         auto_correct::text, 'false' FROM answers WHERE id = aid;

  -- ---- disqualifying ------------------------------------------------------
  n := op_disqualify_round(rid, 0, stranger);
  INSERT INTO result (check_name, got, want) VALUES
    ('a stranger cannot disqualify a round', n::text, '-1');

  n := op_disqualify_round(rid, 0, host);
  INSERT INTO result (check_name, got, want) VALUES
    ('the host can disqualify a round', (n > 0)::text, 'true');
  INSERT INTO result (check_name, got, want)
  SELECT 'and it scores nothing for anybody', coalesce(sum(score_earned), 0)::text, '0'
  FROM answers WHERE room_id = rid AND question_number = 0;

  -- DELIBERATELY NOT GUARDED HERE. The first version refused to mark an answer
  -- correct inside a round that "looked" disqualified — every answer scoring
  -- nothing and nobody right — and that is also what a round everybody simply
  -- got wrong looks like. In a two-player game it would have refused the
  -- commonest override there is. The client keeps that guard, where it knows
  -- the difference; this function does permission and arithmetic.
  res := op_set_judgement(aid, true, host);
  INSERT INTO result (check_name, got, want) VALUES
    ('a round that merely went badly is not mistaken for a thrown-out one', res, 'changed');
END $$;



-- ============================================
-- Migration 051 — the three writes slice 6 took away
--
-- 049/050 shut the `answers` door on UPDATE and DELETE, which was right, and
-- took three legitimate writes with it. An RLS refusal returns no error, so all
-- three failed in total silence. These rules pin the replacements, and — just
-- as important — pin that each one REFUSES the thing the door was shut against.
-- ============================================
DO $$
DECLARE
  rid uuid := gen_random_uuid();
  other uuid := gen_random_uuid();
  host uuid := gen_random_uuid();
  guest uuid := gen_random_uuid();
  bot uuid := gen_random_uuid();
  ghost uuid := gen_random_uuid();
  returner uuid := gen_random_uuid();
  q uuid[] := ARRAY[]::uuid[];
  qid uuid;
  n int;
  ok boolean;
BEGIN
  FOR i IN 1..3 LOOP
    qid := gen_random_uuid();
    INSERT INTO questions (id, question, correct_answer, format)
    VALUES (qid, 'R' || i, 'Answer' || i, 'open');
    q := q || qid;
  END LOOP;

  INSERT INTO rooms (id, code, question_ids, current_question, questions_per_game,
                     question_timer, question_started_at, game_phase)
  VALUES (rid, lpad((random()*999999)::int::text, 6, '0'), q, 0, 2, 30, now(), 'question');
  INSERT INTO rooms (id, code, question_ids, questions_per_game, question_timer)
  VALUES (other, lpad((random()*999999)::int::text, 6, '0'), q, 2, 30);

  INSERT INTO players (id, room_id, display_name, is_host, is_bot, joined_at)
  VALUES (host,  rid, 'Host',  true,  false, now()),
         (guest, rid, 'Guest', false, false, now()),
         (bot,   rid, 'Bot',   false, true,  now());

  -- ---- 1. Play Again clears the room ---------------------------------------
  PERFORM op_submit_answer(rid, host,  0, 'Answer1', 1);
  PERFORM op_submit_answer(rid, guest, 0, 'nope',    1);

  n := op_reset_answers(rid, guest);
  INSERT INTO result (check_name, got, want) VALUES
    ('a player who is not the host cannot wipe a game', n::text, '-1');
  INSERT INTO result (check_name, got, want)
  SELECT 'and the answers are all still there', count(*)::text, '2' FROM answers WHERE room_id = rid;

  n := op_reset_answers(rid, host);
  INSERT INTO result (check_name, got, want) VALUES
    ('the host clears the last game on Play Again', (n = 2)::text, 'true');
  INSERT INTO result (check_name, got, want)
  SELECT 'and nothing from it survives into the next one', count(*)::text, '0'
  FROM answers WHERE room_id = rid;

  -- ---- 2. A returning player gets their own answers back -------------------
  --
  -- WRITING THIS FOUND A REAL BUG, and it took a live measurement to settle.
  -- The first version could not be made to pass: the scratch schema gave
  -- answers.player_id an ON DELETE CASCADE, so deleting the abandoned seat took
  -- its answers with it and there was never anything to reassign.
  --
  -- That FK was inferred here, but the live database really had one — measured
  -- 2026-08-25 by asking PostgREST to embed `answers?select=id,players(id)`,
  -- which only resolves when a relationship exists. So a released seat took the
  -- score with it, and "rejoining restores your score" had never been true on
  -- the live site, long before migration 049 revoked anything.
  --
  -- Migration 052 drops the key, and the scratch schema no longer declares it,
  -- so the rules below now run in the world the app actually ships in.
  INSERT INTO players (id, room_id, display_name, joined_at)
  VALUES (ghost, rid, 'Ghost', now());
  -- op_submit_answer refuses any round that is not the room's current one — the
  -- whole point of migration 046 — so the room has to be walked forward rather
  -- than answered out of order. Getting this wrong is what made the first run
  -- of this block report the reassignment as broken when it was the FIXTURE
  -- that never wrote the second answer.
  PERFORM op_submit_answer(rid, ghost, 0, 'ghost typed this', 2);
  UPDATE rooms SET current_question = 1, question_started_at = now() WHERE id = rid;
  PERFORM op_submit_answer(rid, ghost, 1, 'Answer2', 1);

  INSERT INTO players (id, room_id, display_name, joined_at)
  VALUES (returner, rid, 'Ghost', now());

  DELETE FROM players WHERE id = ghost;

  -- The returner already wrote an answer for round 0 as themselves — they came
  -- back mid-round and typed something. Both rows now exist on the same
  -- (room, question) key, which is what would raise 23505 and lose the whole
  -- reassignment if the function moved them blindly.
  INSERT INTO answers (room_id, player_id, question_number, question_id, wager,
                       submitted_answer, is_correct, score_earned)
  VALUES (rid, returner, 0, q[1], 2, 'Answer1', true, 2);

  n := op_reassign_answers(rid, ghost, returner);
  INSERT INTO result (check_name, got, want) VALUES
    ('a returning player gets their orphaned answers back', n::text, '1');
  INSERT INTO result (check_name, got, want)
  SELECT 'and their score comes with them', coalesce(sum(score_earned),0)::text, '3'
  FROM answers WHERE room_id = rid AND player_id = returner;
  INSERT INTO result (check_name, got, want)
  SELECT 'a clash on one round does not lose the whole rejoin', count(*)::text, '2'
  FROM answers WHERE room_id = rid AND player_id = returner;
  INSERT INTO result (check_name, got, want)
  SELECT 'and the answer they gave as themselves is the one kept',
         submitted_answer, 'Answer1'
  FROM answers WHERE room_id = rid AND player_id = returner AND question_number = 0;
  INSERT INTO result (check_name, got, want)
  SELECT 'nothing is left behind on the old seat', count(*)::text, '0'
  FROM answers WHERE room_id = rid AND player_id = ghost;

  -- Answers can never be moved into a room they were not played in.
  n := op_reassign_answers(other, gen_random_uuid(), returner);
  INSERT INTO result (check_name, got, want) VALUES
    ('answers cannot be moved into another room', n::text, '-1');

  -- A LIVE player's answers are not up for grabs. Deliberately on its own
  -- victim, at a round number nothing else uses: the first version attempted
  -- this on the fixture's own rows, so removing the guard did not report a
  -- broken RULE, it collided on the unique key and killed the whole script with
  -- a duplicate-key error. A guard whose failure is a crash is a guard nobody
  -- can read the failure of.
  INSERT INTO answers (room_id, player_id, question_number, question_id, wager,
                       submitted_answer, is_correct, score_earned)
  VALUES (rid, guest, 99, q[1], 1, 'guest keeps this', true, 1);
  n := op_reassign_answers(rid, guest, returner);
  INSERT INTO result (check_name, got, want) VALUES
    ('answers cannot be taken off a player who is still in the room', n::text, '-1');
  INSERT INTO result (check_name, got, want)
  SELECT 'and the live player still has them', count(*)::text, '1'
  FROM answers WHERE room_id = rid AND player_id = guest AND question_number = 99;
  DELETE FROM answers WHERE room_id = rid AND question_number = 99;


  -- ---- 3. Only a bot can be answered for ----------------------------------
  PERFORM op_reset_answers(rid, host);

  ok := op_bot_answer(rid, guest, 0, q[1], 3, 'Answer1', true);
  INSERT INTO result (check_name, got, want) VALUES
    ('nobody can write an answer for a real player', ok::text, 'false');
  INSERT INTO result (check_name, got, want)
  SELECT 'and no row was written for them', count(*)::text, '0'
  FROM answers WHERE room_id = rid AND player_id = guest;

  ok := op_bot_answer(rid, bot, 0, q[1], 3, 'Answer1', true);
  INSERT INTO result (check_name, got, want) VALUES
    ('the host answers for a bot', ok::text, 'true');
  INSERT INTO result (check_name, got, want)
  SELECT 'and the score is computed here, not sent', score_earned::text, '3'
  FROM answers WHERE room_id = rid AND player_id = bot AND question_number = 0;

  -- The final round is number 2 here (3 questions: 0, 1, final at 2), and it is
  -- the only one that subtracts. A bot holding a locked wager gets merged over.
  INSERT INTO answers (room_id, player_id, question_number, question_id, wager, submitted_answer)
  VALUES (rid, bot, 2, q[3], 20, '__WAGER_LOCKED__');
  ok := op_bot_answer(rid, bot, 2, q[3], 20, 'wrong', false);
  INSERT INTO result (check_name, got, want) VALUES
    ('a locked wager placeholder is merged over, not skipped', ok::text, 'true');
  INSERT INTO result (check_name, got, want)
  SELECT 'a wrong FINAL answer subtracts the wager', score_earned::text, '-20'
  FROM answers WHERE room_id = rid AND player_id = bot AND question_number = 2;

  -- A real answer the bot already gave is never overwritten.
  PERFORM op_bot_answer(rid, bot, 0, q[1], 3, 'something else', false);
  INSERT INTO result (check_name, got, want)
  SELECT 'an answer already given is not overwritten', submitted_answer, 'Answer1'
  FROM answers WHERE room_id = rid AND player_id = bot AND question_number = 0;
END $$;

SELECT check_name, got, want FROM result ORDER BY ord;
