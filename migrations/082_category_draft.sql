-- 082 — Category draft: each player's one move lives on their own seat.
--
-- The host can pick "Draft" instead of a subject. In the lobby every person
-- then makes ONE move, "want:<category>" or "ban:<category>", shown to the
-- whole room and changeable until the host starts. The game is built from the
-- moves when it starts (js/draft-logic.js holds the rules).
--
-- A Draft room itself needs nothing new: it is stored as category 'wild-card'
-- with subcategory '__draft__', the same shape as the two Wild Card options.
--
-- WHY A COLUMN ON players AND NOT A TABLE: the move is a fact about a seat,
-- it should vanish with the seat, and `players` is already in the Realtime
-- publication, so every phone hears a move without a new subscription.
--
-- WHY THE GRANT: migration 058 revoked table-wide UPDATE on players and
-- re-granted three columns by name. Without this line a move is refused with
-- 42501. Like is_ready, a player in the room could change another player's
-- move; that is the same accepted nuisance, not a takeover: a move decides
-- nothing by itself and is visible to everybody.
--
-- SAFE BEFORE IT IS RUN: draftAvailable() in js/db/players.js reads this
-- column once per page and hides Draft from the host when it is missing.

ALTER TABLE public.players ADD COLUMN IF NOT EXISTS draft_move text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'players_draft_move_shape'
       AND conrelid = 'public.players'::regclass
  ) THEN
    ALTER TABLE public.players ADD CONSTRAINT players_draft_move_shape
      CHECK (draft_move IS NULL OR draft_move ~ '^(want|ban):[a-z-]{1,40}$');
  END IF;
END $$;

GRANT UPDATE (draft_move) ON public.players TO anon, authenticated;

-- Verification: one row per rule, in the results grid.
SELECT 1 AS ord, 'players.draft_move exists' AS "check",
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'players'
                            AND column_name = 'draft_move')
            THEN 'ok' ELSE 'FAIL — column missing' END AS result
UNION ALL
SELECT 2, 'a player may save a move',
       CASE WHEN has_column_privilege('authenticated', 'public.players', 'draft_move', 'UPDATE')
             AND has_column_privilege('anon', 'public.players', 'draft_move', 'UPDATE')
            THEN 'ok' ELSE 'FAIL — not granted' END
UNION ALL
SELECT 3, 'only a real move can be stored',
       CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
                          WHERE conname = 'players_draft_move_shape'
                            AND conrelid = 'public.players'::regclass)
            THEN 'ok' ELSE 'FAIL — shape check missing' END
UNION ALL
SELECT 4, 'the host role is still not writable',
       CASE WHEN NOT has_column_privilege('authenticated', 'public.players', 'is_host', 'UPDATE')
            THEN 'ok' ELSE 'FAIL — is_host became writable' END
ORDER BY 1;
