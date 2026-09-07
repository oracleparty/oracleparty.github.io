-- ============================================================
-- 068 — A THROWN-OUT ROUND SAYS SO, INSTEAD OF BEING GUESSED AT
--
-- Reported after a live game on 2026-09-07: "my friend said it didn't enter
-- the right bet, it only said he bet 1??? which he had already used."
--
-- THE WAGER RULE IS THE ONE RULE THIS GAME CANNOT BEND. With N questions the
-- values 1..N are each used exactly once, and a value handed back is a value
-- somebody spends twice — so somebody else's ranking is wrong for the rest of
-- the game and nothing on any screen says why.
--
-- WHERE IT CAME FROM. A disqualified round refunds its wager, which is right:
-- the host has declared the round did not happen. But nothing anywhere RECORDS
-- that a round was disqualified. op_disqualify_round (049) sets every answer in
-- it to is_correct = false, score_earned = 0 — and then both readers INFER the
-- disqualification back out of those values:
--
--   op_next_wager (046)          `NOT EXISTS (... HAVING bool_and(NOT is_correct
--                                AND score_earned = 0))`
--   buildDisqualifiedSet (js)    `answers.every(a => !a.is_correct && !score)`
--
-- A ROUND EVERYBODY SIMPLY GOT WRONG IS INDISTINGUISHABLE FROM ONE THAT WAS
-- THROWN OUT. Both are "nobody right, nobody scored". 046's own comment admits
-- the flaw and ports it deliberately so the two implementations agree — which
-- was the correct call at the time, because a server that disagreed with the
-- screen would be worse. It is still a heuristic that is wrong far more often
-- than it is right: in a TWO-PLAYER GAME both players missing a question is
-- ordinary, and every time it happens that round's wager is silently refunded
-- and handed out again by the next blank fill.
--
-- That is the report, exactly: wager 1 was spent on a round both players got
-- wrong, the refund gave it back, and op_next_wager offered it again as the
-- lowest unspent value.
--
-- THE FIX IS A FACT, NOT A BETTER GUESS. There is no signal in the data that
-- can separate the two cases, so this records the one that matters at the
-- moment it happens.
-- ============================================================

-- --------------------------------------------
-- 1. The marker
--
-- On `answers` rather than a table of its own: the round is already keyed
-- there, the rows already die with the room, and nothing has to be joined to
-- read it. DEFAULT false and NOT NULL, so every existing row means "this was a
-- real round" — which is true of every row written before today.
--
-- NOTHING IN js/ INSERTS THIS COLUMN, deliberately. CLAUDE.md's oldest rule is
-- that Postgres rejects an entire INSERT for one unknown column, so a client
-- that names it would stop every answer in the game from being written on any
-- database where this migration has not been applied. The default does the
-- work, and the two functions below are the only writers.
-- --------------------------------------------
ALTER TABLE answers
  ADD COLUMN IF NOT EXISTS disqualified boolean NOT NULL DEFAULT false;

-- The column must be READABLE by clients — buildDisqualifiedSet reads it off
-- the same select('*') the reveal already does — and must NOT be writable, or
-- anybody could refund themselves a wager by declaring a round thrown out.
-- 049 revoked UPDATE on `answers` wholesale and granted nothing back, so there
-- is no column grant to add here; SELECT is already granted on the table.

-- --------------------------------------------
-- 2. Disqualifying says so
--
-- Unchanged except for the flag: same host guard, same zeroing of the scores.
-- The zeroing stays because it is what makes the SCOREBOARD right; the flag is
-- what makes the WAGER right. Two different questions, and the old code had
-- one answer for both.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_disqualify_round(
  p_room_id uuid,
  p_question_number int,
  p_caller_id uuid
)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n int;
BEGIN
  IF NOT op_is_room_host(p_room_id, p_caller_id) THEN RETURN -1; END IF;

  UPDATE answers
     SET is_correct = false, score_earned = 0, disqualified = true
   WHERE room_id = p_room_id AND question_number = p_question_number;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
GRANT EXECUTE ON FUNCTION op_disqualify_round(uuid, int, uuid) TO anon, authenticated;

-- --------------------------------------------
-- 3. The lowest wager this player has not spent
--
-- The only change is the last clause: it asks whether the round was THROWN OUT
-- instead of whether it happened to go badly for everybody. Everything else —
-- the final round's separate wager space, the __WAGER_LOCKED__ placeholder,
-- the 1..total scan and the fallback — is byte-for-byte what 046 shipped.
--
-- It must stay a port of findNextAvailableWager + buildUsedWagersMap. If the
-- server hands somebody a wager their own screen thinks is spent, they are
-- shown a number they cannot use; if it hands back one the screen thinks is
-- available, they spend it twice. Both files changed in the same commit.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_next_wager(p_room_id uuid, p_player_id uuid, p_total int)
RETURNS int
LANGUAGE plpgsql STABLE
SET search_path = public
AS $$
DECLARE
  used int[];
  i int;
BEGIN
  SELECT coalesce(array_agg(a.wager), ARRAY[]::int[]) INTO used
  FROM answers a
  WHERE a.room_id = p_room_id
    AND a.player_id = p_player_id
    AND a.question_number < p_total
    AND a.wager IS NOT NULL
    AND btrim(coalesce(a.submitted_answer, '')) <> '__WAGER_LOCKED__'
    -- THE ROUND WAS THROWN OUT, and it says so. Any row in the round carrying
    -- the flag settles it: op_disqualify_round marks them all in one statement.
    AND NOT EXISTS (
      SELECT 1 FROM answers d
      WHERE d.room_id = p_room_id
        AND d.question_number = a.question_number
        AND d.disqualified
    );

  FOR i IN 1..p_total LOOP
    IF NOT (i = ANY (used)) THEN RETURN i; END IF;
  END LOOP;
  RETURN 1;   -- everything spent; the client's fallback is the same
END;
$$;
GRANT EXECUTE ON FUNCTION op_next_wager(uuid, uuid, int) TO anon, authenticated;


-- ============================================================
-- VERIFY — every cell must read "ok"
--
-- Reads the installed functions' own source, so a paste that stopped partway
-- reports FAIL rather than passing quietly.
-- ============================================================
SELECT
  CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'answers'
                       AND column_name = 'disqualified')
       THEN 'ok' ELSE 'FAIL answers.disqualified missing' END        AS marker_column,
  CASE WHEN (SELECT prosrc FROM pg_proc
              WHERE oid = 'op_disqualify_round(uuid,int,uuid)'::regprocedure)
            LIKE '%disqualified = true%'
       THEN 'ok' ELSE 'FAIL disqualifying does not record itself' END AS dq_sets_flag,
  CASE WHEN (SELECT prosrc FROM pg_proc
              WHERE oid = 'op_next_wager(uuid,uuid,int)'::regprocedure)
            LIKE '%d.disqualified%'
       THEN 'ok' ELSE 'FAIL the wager rule still guesses' END         AS wager_reads_flag,
  CASE WHEN (SELECT prosrc FROM pg_proc
              WHERE oid = 'op_next_wager(uuid,uuid,int)'::regprocedure)
            NOT LIKE '%bool_and%'
       THEN 'ok' ELSE 'FAIL the old everybody-was-wrong guess is still there' END AS guess_gone,
  -- The flag must not be writable by a client, or a wager can be refunded to
  -- order. 049 revoked UPDATE on answers; this asserts it stayed revoked.
  CASE WHEN NOT has_column_privilege('anon', 'answers', 'disqualified', 'UPDATE')
        AND NOT has_column_privilege('authenticated', 'answers', 'disqualified', 'UPDATE')
       THEN 'ok' ELSE 'FAIL a client can declare a round thrown out' END AS flag_locked;
