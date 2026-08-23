-- ============================================
-- 045 — THE SERVER JUDGES THE ANSWER
--
-- First slice of moving the game off the host's phone (CLAUDE.md #1).
--
-- Today every browser judges every answer for itself, so two phones can and do
-- disagree about a score, and any client can write any score it likes. This
-- puts the verdict in one place. Nothing here changes what counts as a correct
-- answer: op_answer_matches is a line-by-line port of fuzzyMatch in
-- js/utils.js, and scripts/verify-sql.mjs runs thousands of cases through BOTH
-- and fails on any disagreement. That parity check is the whole reason this is
-- safe to switch on — a server that judges differently from the screen the
-- player is looking at would be far worse than no server at all.
--
-- AUTHORITY IS NOT INITIATIVE. Postgres cannot wake itself up, so a client
-- still has to ask. What changes is that the answer no longer comes from the
-- asker. Anyone may call these; the database decides.
--
-- What this does NOT do, and must not be claimed to: it does not know WHO is
-- calling. Guests have no auth identity — that is the whole point of guest
-- play — so a person with the room code can still act as another player in
-- that room. This stops a score being forged out of nothing; it does not stop
-- somebody already in your game meddling. Closing that needs sign-in, which
-- ends guest play, and the owner has not asked for it.
--
-- Deliberately NO EXTENSIONS. unaccent and fuzzystrmatch would both be
-- tidier, and both are a bet on what is installed on the live project — the
-- single commonest source of "worked in the harness, dead in production" in
-- this repo. Everything below is plain SQL and plpgsql.
-- ============================================


-- --------------------------------------------
-- op_unaccent — base letters for accented ones
--
-- js/utils.js does this with NFD decomposition, which handles every accent
-- there is. translate() handles the ones listed. Any Latin letter missing from
-- this map is STRIPPED by the punctuation pass below rather than folded, which
-- is a real difference in behaviour — so the list is deliberately generous and
-- verify-sql.mjs feeds accented answers through both implementations.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_unaccent(s text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT
SET search_path = public
AS $$
  SELECT translate(
    s,
    'àáâãäåāăąèéêëēĕėęěìíîïĩīĭįıòóôõöøōŏőùúûüũūŭůűųýÿŷñńņňçćĉċčšśŝşžźż�żđďģğĥħĵķĺļľłŕřßţťŧŵÿ',
    'aaaaaaaaaeeeeeeeeeiiiiiiiiiooooooooouuuuuuuuuuyyynnnncccccsssssszzzzzddggghhjklllrrstttwy'
  );
$$;


-- --------------------------------------------
-- op_normalize_answer — the exact steps normalizeAnswer takes, in order
--
-- The ORDER is load-bearing and was learned the hard way: accents are folded
-- BEFORE punctuation is stripped, because "São Paulo" would otherwise become
-- "S Paulo" and nobody typing "Sao Paulo" could ever match it.
--
-- \y, not \b. In Postgres \b is a BACKSPACE character, so the word-boundary
-- anchors in the numeric-abbreviation rules below have to be written \y or
-- they silently match nothing.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_normalize_answer(s text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE WHEN s IS NULL OR btrim(s) = '' THEN '' ELSE
    regexp_replace(
    regexp_replace(
    regexp_replace(
    regexp_replace(
      btrim(regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(lower(btrim(s)), '^(the|a|an)\s+', '', 'i'),
          '[^a-z0-9\s]', '', 'g'),
        '\s+', ' ', 'g'),
      '\s+', ' ', 'g')),
      '(\d)\s*bil\y',  '\1 billion',  'g'),
      '(\d)\s*mil\y',  '\1 million',  'g'),
      '(\d)\s*tril\y', '\1 trillion', 'g'),
      '(\d)\s*k\y',    '\1 thousand', 'g')
  END;
$$;

-- The accent fold has to happen before the article strip, exactly as in JS.
-- Written as a wrapper rather than nested another level deep, because the
-- expression above is already at the limit of what anybody can check by eye.
CREATE OR REPLACE FUNCTION op_normalize(s text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT op_normalize_answer(op_unaccent(lower(btrim(coalesce(s, '')))));
$$;


-- --------------------------------------------
-- op_levenshtein — plain edit distance, two rows at a time
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_levenshtein(a text, b text)
RETURNS int
LANGUAGE plpgsql IMMUTABLE STRICT
SET search_path = public
AS $$
DECLARE
  la int := length(a);
  lb int := length(b);
  prev int[];
  cur  int[];
  i int; j int; cost int;
BEGIN
  IF la = 0 THEN RETURN lb; END IF;
  IF lb = 0 THEN RETURN la; END IF;

  prev := ARRAY(SELECT generate_series(0, la));
  FOR i IN 1..lb LOOP
    cur := ARRAY[i];
    FOR j IN 1..la LOOP
      cost := CASE WHEN substr(b, i, 1) = substr(a, j, 1) THEN 0 ELSE 1 END;
      cur := cur || LEAST(prev[j + 1] + 1, cur[j] + 1, prev[j] + cost);
    END LOOP;
    prev := cur;
  END LOOP;
  RETURN prev[la + 1];
END;
$$;


-- --------------------------------------------
-- op_digits_match — the numeric guard
--
-- If either side contains a digit, the digit RUNS must be identical and in the
-- same order. This is what stops "1994" being accepted for "1996" while still
-- letting "Appollo 13" through for "Apollo 13".
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_digits_match(a text, b text)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT
SET search_path = public
AS $$
  SELECT coalesce(
    (SELECT array_agg(m[1] ORDER BY ord) FROM regexp_matches(a, '\d+', 'g') WITH ORDINALITY AS t(m, ord)),
    ARRAY[]::text[]
  ) = coalesce(
    (SELECT array_agg(m[1] ORDER BY ord) FROM regexp_matches(b, '\d+', 'g') WITH ORDINALITY AS t(m, ord)),
    ARRAY[]::text[]
  );
$$;


-- --------------------------------------------
-- op_answer_matches — the verdict
--
-- A port of fuzzyMatch, including the thing that was fixed in the 2026-08-20
-- playtest: there is NO floor under the Levenshtein threshold. The rule is one
-- typo per four characters, and a three-letter word does not have four
-- characters, so under four it is exact-after-normalisation. A floor of 1 let
-- any single letter stand in for any other, and a question asking which letter
-- something begins with could not be got wrong.
-- --------------------------------------------
CREATE OR REPLACE FUNCTION op_answer_matches(
  p_submitted text,
  p_correct text,
  p_alternates text[] DEFAULT ARRAY[]::text[]
)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = public
AS $$
DECLARE
  sub text := op_normalize(p_submitted);
  cand text;
  norm text;
  word text;
BEGIN
  IF sub = '' THEN RETURN false; END IF;

  FOREACH cand IN ARRAY (ARRAY[p_correct] || coalesce(p_alternates, ARRAY[]::text[])) LOOP
    CONTINUE WHEN cand IS NULL OR cand = '';
    norm := op_normalize(cand);
    CONTINUE WHEN norm = '';

    IF sub = norm THEN RETURN true; END IF;

    -- Numeric guard, only when at least one side has a digit in it.
    IF sub ~ '\d' OR norm ~ '\d' THEN
      CONTINUE WHEN NOT op_digits_match(sub, norm);
    END IF;

    IF op_levenshtein(sub, norm) <= floor(length(norm) * 0.25) THEN
      RETURN true;
    END IF;

    -- Surname matching: a space in the answer means it is probably a name, so
    -- any single word over three characters stands for the whole of it —
    -- "Antoinette" for "Marie Antoinette".
    IF position(' ' IN norm) > 0 THEN
      FOREACH word IN ARRAY regexp_split_to_array(norm, '\s+') LOOP
        IF length(word) > 3
           AND op_levenshtein(sub, word) <= floor(length(word) * 0.25) THEN
          RETURN true;
        END IF;
      END LOOP;
    END IF;
  END LOOP;

  RETURN false;
END;
$$;


GRANT EXECUTE ON FUNCTION op_unaccent(text)                     TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_normalize_answer(text)             TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_normalize(text)                    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_levenshtein(text, text)            TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_digits_match(text, text)           TO anon, authenticated;
GRANT EXECUTE ON FUNCTION op_answer_matches(text, text, text[]) TO anon, authenticated;


-- --------------------------------------------
-- VERIFY — every row must read "ok".
--
-- These are the cases from tests/utils.test.js that describe the RULES rather
-- than an implementation detail. scripts/verify-sql.mjs runs a far larger set
-- against the JavaScript itself; this block is here so that pasting the
-- migration tells you immediately whether it took.
-- --------------------------------------------
SELECT
  CASE WHEN op_answer_matches('  Napoleon  ', 'Napoleon')            THEN 'ok' ELSE 'FAIL exact'          END AS exact,
  CASE WHEN op_answer_matches('napolean', 'Napoleon')                THEN 'ok' ELSE 'FAIL one typo'       END AS typo,
  CASE WHEN NOT op_answer_matches('bat', 'cat')                      THEN 'ok' ELSE 'FAIL short word'     END AS short_word,
  CASE WHEN NOT op_answer_matches('up', 'US')                        THEN 'ok' ELSE 'FAIL two letters'    END AS two_letters,
  CASE WHEN NOT op_answer_matches('1994', '1996')                    THEN 'ok' ELSE 'FAIL digit guard'    END AS digits,
  CASE WHEN op_answer_matches('Appollo 13', 'Apollo 13')             THEN 'ok' ELSE 'FAIL typo w/ digit'  END AS digit_typo,
  CASE WHEN op_answer_matches('Antoinette', 'Marie Antoinette')      THEN 'ok' ELSE 'FAIL surname'        END AS surname,
  CASE WHEN op_answer_matches('Sao Paulo', 'São Paulo')              THEN 'ok' ELSE 'FAIL accents'        END AS accents,
  CASE WHEN op_answer_matches('beatles', 'The Beatles')              THEN 'ok' ELSE 'FAIL leading the'    END AS article,
  CASE WHEN op_answer_matches('nyc', 'New York', ARRAY['NYC'])       THEN 'ok' ELSE 'FAIL alternate'      END AS alternate,
  CASE WHEN NOT op_answer_matches('', 'Napoleon')                    THEN 'ok' ELSE 'FAIL blank'          END AS blank;
