-- ============================================
-- 072 — A BOT KEEPS ITS OWN RECORD
--
-- The owner's decision, stated three times and reaffirmed against my pushing
-- back on it twice: "How many times do i have to say i want the bot's results
-- recorded???? Forget/wipe out any bit of not recording it."
--
-- They were also right about WHY it is worth recording, and I was arguing the
-- wrong thing. I kept saying a bot is a coin, so its recorded results could only
-- ever be a flat circle. Their answer: "It should be actual results. It answers
-- no answer to plenty. The host may override some. There is chance on others."
-- All three are real and the code agrees:
--
--   * BLANKS. chooseBotAnswer returns an empty string when a question has no
--     stored wrong option — about 20% of the bank. Those are real "no answer"
--     rows, not guesses.
--   * HOST OVERRIDES. A host flipping a bot's verdict writes to the answer row
--     like anyone's, and the coin flip knows nothing about it.
--   * AND THE CODE RECORDS THE FLIP RATHER THAN RE-JUDGING THE TEXT, with a
--     comment saying so — which makes an override the only thing that can make
--     the recorded result differ from the setting. Exactly their point.
--
-- So a recorded chart will not be flat, and what it shows is the QUESTION BANK
-- and the HOSTS: where wrong options are missing, where hosts keep overriding.
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT question_history, AND IT IS NOT A PREFERENCE
--
-- MEASURED, in migration 011:
--
--     user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
--
-- A bot has no auth user and cannot be given one from a browser. Writing a
-- synthetic id into that table raises 23503 — and record_round_history does
-- every player in the room IN ONE STATEMENT, so the violation would roll back
-- the whole thing and NOBODY's round would be recorded. Every round, for every
-- human, reaching nothing but a console log.
--
-- That is this project's signature failure wearing a new hat: a change made for
-- one player silently destroying a feature for all of them. The bot needs a
-- table with no foreign key, and this is it.
--
-- ---------------------------------------------------------------------------
-- THE KEY IS THE BOT'S NAME, AND THAT IS DELIBERATE
--
-- `addBot` writes a display name and no user id. Keying on the name means one
-- bot's play accumulates across every room and every game it has ever been in,
-- which is what "recorded" has to mean — and the day the owner adds a second
-- bot with a different name, it starts its own record with nothing rewired.
--
-- The alternative was a new column on `players`, and CLAUDE.md #3 is a list of
-- features silently killed by exactly that: Postgres rejects an entire INSERT
-- for one unknown column, so a client writing `bot_key` before the column
-- existed would stop bots being added at all.
--
-- ---------------------------------------------------------------------------
-- ONE STATEMENT, ONE MARKER — WHY THIS EDITS record_round_history
--
-- 043 claims `answers.history_recorded` in the UPDATE that opens its statement,
-- and that marker is what makes recording exactly-once even when a host and a
-- deputy both advance. It marks EVERY answer in the round, bots included, and
-- then filters bots out of the human write.
--
-- So a separate bot function could never work: by the time it ran the marker
-- would already be spent. The options were a second marker column on `answers`
-- or one statement that does both. One statement wins — it inherits
-- exactly-once for free, and `revoke_question_history` already clears
-- `history_recorded` when a round is disqualified, so a thrown-out round
-- revokes the bot's attempt too, by construction rather than by remembering.
--
-- THE HUMAN PATH BELOW IS UNCHANGED, CTE for CTE. The 264 rules in
-- tests/sql/game-rules.sql are what prove that rather than my say-so.
--
-- ---------------------------------------------------------------------------
-- WHAT IS NOT RECORDED, AND THE OWNER CHOSE THIS TOO
--
-- `question_stats` and `answer_tally` stay HUMAN-ONLY, on their answer to the
-- one question worth asking: the reveal tells players "18% get this right", and
-- a bot answering at a flat coin flip drags every question it touches toward
-- 50%, so a genuinely hard question starts reading as medium to real people.
-- They chose "humans only for that one band".
--
-- That is not a contradiction of recording the bot — it is the line between the
-- bot's OWN record and EVIDENCE ABOUT A QUESTION. answer_tally is the same
-- call for the same reason: a bot's wrong answer is a canned distractor read
-- out of the question bank, so recording it would feed the bank its own text
-- back as if a person had typed it.
-- ============================================

CREATE TABLE IF NOT EXISTS bot_history (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The bot's display name. See THE KEY IS THE BOT'S NAME.
  bot_key text NOT NULL,
  question_id uuid NOT NULL,
  times_seen int NOT NULL DEFAULT 1,
  times_correct int NOT NULL DEFAULT 0,
  -- The MOST RECENT verdict, which is what proficiency means here since
  -- migration 040 — get it wrong then right and the miss is gone. Same
  -- definition as a human's, so the bot's chart and a player's mean the same
  -- thing rather than two numbers that merely look alike.
  last_correct boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bot_history_one_per_question UNIQUE (bot_key, question_id)
);

CREATE INDEX IF NOT EXISTS bot_history_key_idx ON bot_history (bot_key);

-- REVOKE BEFORE GRANT. Supabase grants every new public table to anon and
-- authenticated through ALTER DEFAULT PRIVILEGES, and a GRANT adds where only a
-- REVOKE subtracts — migration 063 shipped without this and its own
-- verification block is what caught it.
REVOKE ALL ON bot_history FROM anon, authenticated;
GRANT SELECT ON bot_history TO anon, authenticated;

ALTER TABLE bot_history ENABLE ROW LEVEL SECURITY;

-- Readable, because the bot's profile card draws its chart from this. There is
-- nothing private in it: a bot is not a person.
DROP POLICY IF EXISTS "Bot history: anyone can read" ON bot_history;
CREATE POLICY "Bot history: anyone can read" ON bot_history FOR SELECT USING (true);

-- No write policy. record_round_history below is SECURITY DEFINER and is the
-- only way a row gets here — so nobody can hand a bot a reputation it did not
-- play for, which matters because this is the only table in the app a client
-- could otherwise write freely about a player who cannot object.

-- ---------------------------------------------------------------------------
-- HOW GOOD IS THIS BOT AT THIS SUBJECT
--
-- The same shape as player_stats_computed's per-category rollup, and the same
-- measure: distinct questions currently got right, over distinct questions met.
-- A question filed under two categories counts under both, which is correct for
-- a per-topic number and is why this is not summed anywhere.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW bot_proficiency AS
SELECT h.bot_key,
       c.category,
       count(*)::int AS questions_met,
       count(*) FILTER (WHERE h.last_correct)::int AS questions_mastered
  FROM bot_history h
  JOIN questions q ON q.id = h.question_id
  CROSS JOIN LATERAL unnest(COALESCE(q.categories, ARRAY[]::text[])) AS c(category)
 GROUP BY h.bot_key, c.category;

REVOKE ALL ON bot_proficiency FROM anon, authenticated;
GRANT SELECT ON bot_proficiency TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- record_round_history, now recording the bots too
--
-- The human half is CTE for CTE what 043 shipped. The only additions are the
-- `bots` CTE and the two writes under it, and `marked` is shared so both halves
-- inherit the exactly-once marker.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION record_round_history(
  p_room_id     uuid,
  p_question_id uuid
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_recorded integer := 0;
BEGIN
  IF p_room_id IS NULL OR p_question_id IS NULL THEN
    RETURN 0;
  END IF;

  WITH marked AS (
    UPDATE answers a
       SET history_recorded = true
     WHERE a.room_id          = p_room_id
       AND a.question_id      = p_question_id
       AND a.history_recorded = false
    RETURNING a.id AS answer_id, a.player_id, a.is_correct
  ),
  pending AS (
    SELECT DISTINCT ON (p.user_id)
           p.user_id,
           COALESCE(m.is_correct, false) AS is_correct
      FROM marked m
      JOIN players p ON p.id = m.player_id
     WHERE p.user_id IS NOT NULL
       -- STILL EXCLUDED HERE, and the reason is narrower than it looks.
       --
       -- TODAY THIS LINE IS REDUNDANT: `addBot` writes no user_id, so the
       -- IS NOT NULL above already keeps every bot out. I wrote a comment here
       -- claiming a bot in this CTE raises 23503, break-tested it by deleting
       -- the line, and watched all 276 rules still pass — because the mechanism
       -- I described does not fire.
       --
       -- It is kept as the LAST guard rather than the first. The moment anything
       -- writes a user_id onto a bot row — the obvious way to make a bot
       -- "recorded", and my own first instinct — this line is all that stands
       -- between that and a 23503 that rolls back the single statement
       -- recording EVERY player's round. The rule table pins exactly that case,
       -- with a bot that carries an id, so the guard now fails loudly when
       -- removed instead of looking like dead code somebody tidies away.
       AND COALESCE(p.is_bot, false) = false
     ORDER BY p.user_id, m.answer_id DESC
  ),
  -- THE BOTS, keyed on the name they play under.
  bots AS (
    SELECT DISTINCT ON (p.display_name)
           p.display_name AS bot_key,
           COALESCE(m.is_correct, false) AS is_correct
      FROM marked m
      JOIN players p ON p.id = m.player_id
     WHERE COALESCE(p.is_bot, false) = true
       AND COALESCE(btrim(p.display_name), '') <> ''
     ORDER BY p.display_name, m.answer_id DESC
  ),
  updated AS (
    UPDATE question_history h
       SET times_seen    = h.times_seen + 1,
           times_correct = h.times_correct + CASE WHEN pd.is_correct THEN 1 ELSE 0 END,
           last_correct  = pd.is_correct,
           last_seen_at  = now()
      FROM pending pd
     WHERE h.user_id     = pd.user_id
       AND h.question_id = p_question_id
    RETURNING h.user_id
  ),
  inserted AS (
    INSERT INTO question_history (user_id, question_id, times_seen, times_correct, last_correct, last_seen_at)
    SELECT pd.user_id, p_question_id, 1,
           CASE WHEN pd.is_correct THEN 1 ELSE 0 END,
           pd.is_correct,
           now()
      FROM pending pd
     WHERE NOT EXISTS (
       SELECT 1 FROM question_history h2
        WHERE h2.user_id = pd.user_id AND h2.question_id = p_question_id)
    RETURNING user_id
  ),
  -- ON CONFLICT is safe here where it is not for question_history: this table
  -- declares its own unique constraint two hundred lines up, in the same
  -- migration, so there is no chance of the 42P10 that update-then-insert
  -- exists to avoid above.
  bot_written AS (
    INSERT INTO bot_history (bot_key, question_id, times_seen, times_correct, last_correct, last_seen_at)
    SELECT b.bot_key, p_question_id, 1,
           CASE WHEN b.is_correct THEN 1 ELSE 0 END,
           b.is_correct,
           now()
      FROM bots b
    ON CONFLICT ON CONSTRAINT bot_history_one_per_question DO UPDATE
      SET times_seen    = bot_history.times_seen + 1,
          times_correct = bot_history.times_correct + EXCLUDED.times_correct,
          last_correct  = EXCLUDED.last_correct,
          last_seen_at  = now()
    RETURNING bot_key
  )
  -- The return value counts HUMANS, unchanged, because callers and the existing
  -- rules read it as "how many people's rounds were recorded".
  SELECT ((SELECT count(*) FROM updated)
        + (SELECT count(*) FROM inserted)
        + (SELECT 0 FROM (SELECT count(*) FROM bot_written) z))::integer
    INTO v_recorded;

  RETURN v_recorded;
END;
$$;

GRANT EXECUTE ON FUNCTION record_round_history(uuid, uuid) TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICATION — run this and paste back what it prints.
-- ---------------------------------------------------------------------------

DO $verify$
DECLARE v_ok text;
BEGIN
  RAISE NOTICE '--- 072 verification ---';

  SELECT CASE WHEN to_regclass('public.bot_history') IS NOT NULL THEN 'ok' ELSE 'FAIL' END INTO v_ok;
  RAISE NOTICE 'bot_history exists: %', v_ok;

  SELECT CASE WHEN to_regclass('public.bot_proficiency') IS NOT NULL THEN 'ok' ELSE 'FAIL' END INTO v_ok;
  RAISE NOTICE 'bot_proficiency view exists: %', v_ok;

  -- THE ONE THAT MATTERS MOST. A foreign key here would mean every bot round
  -- raises 23503 and rolls back the whole statement, taking every human's round
  -- with it — which is the entire reason this table exists.
  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM pg_constraint
       WHERE conrelid = 'public.bot_history'::regclass AND contype = 'f')
    THEN 'FAIL — a foreign key here would roll back every human''s round too'
    ELSE 'ok' END INTO v_ok;
  RAISE NOTICE 'bot_history has no foreign key: %', v_ok;

  SELECT CASE WHEN has_table_privilege('anon', 'bot_history', 'INSERT')
               OR has_table_privilege('anon', 'bot_history', 'UPDATE')
               OR has_table_privilege('authenticated', 'bot_history', 'INSERT')
               OR has_table_privilege('authenticated', 'bot_history', 'UPDATE')
              THEN 'FAIL — a client can write a bot''s record directly'
              ELSE 'ok' END INTO v_ok;
  RAISE NOTICE 'only the server writes a bot''s record: %', v_ok;

  SELECT CASE WHEN has_table_privilege('anon', 'bot_proficiency', 'SELECT')
              THEN 'ok' ELSE 'FAIL — the bot''s chart cannot be read' END INTO v_ok;
  RAISE NOTICE 'the bot''s chart is readable: %', v_ok;

  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM pg_proc WHERE proname = 'record_round_history' AND prosecdef)
    THEN 'ok' ELSE 'FAIL' END INTO v_ok;
  RAISE NOTICE 'record_round_history still installed as DEFINER: %', v_ok;
END
$verify$;
