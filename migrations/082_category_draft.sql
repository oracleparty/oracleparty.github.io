-- 082 — Draft and Random: a move on each seat, the spin's pick on the room.
--
-- The host can choose "Draft" or "Random" instead of a subject. Both end in
-- one spin at Start that picks the subject for the whole game
-- (js/draft-logic.js holds the rules):
--   * Draft: in the lobby every person makes ONE move, "want:<category>" or
--     "ban:<category>". A want is a block on the wheel; a ban removes one.
--   * Random: no moves; every subject is equally likely.
-- The host's phone spins and writes the result to rooms.draft_pick, so every
-- phone animates towards the same subject and asks the same questions.
--
-- A Draft or Random room itself is stored as category 'wild-card' with
-- subcategory '__draft__' / '__random__', the shape Wild Card's options use.
--
-- WHY COLUMNS AND NOT A TABLE: a move is a fact about a seat and should vanish
-- with it; a pick is a fact about a room's current game. `players` and `rooms`
-- are both already in the Realtime publication, so every phone hears both
-- without a new subscription.
--
-- WHY THE GRANTS: 058 and 061 revoked table-wide UPDATE on players and rooms
-- and re-granted columns by name. Without these two lines a move, and the
-- write that starts a spin game, are refused with 42501. Like is_ready and
-- chaos, somebody already in the room could change either; that is the same
-- accepted nuisance as the other room settings, not a takeover.
--
-- SAFE BEFORE IT IS RUN: draftAvailable() in js/db/players.js reads both
-- columns once per page and hides Draft and Random from the host when either
-- is missing.

ALTER TABLE public.players ADD COLUMN IF NOT EXISTS draft_move text;
ALTER TABLE public.rooms   ADD COLUMN IF NOT EXISTS draft_pick text;

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
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'rooms_draft_pick_shape'
       AND conrelid = 'public.rooms'::regclass
  ) THEN
    ALTER TABLE public.rooms ADD CONSTRAINT rooms_draft_pick_shape
      CHECK (draft_pick IS NULL OR draft_pick ~ '^[a-z-]{1,40}$');
  END IF;
END $$;

GRANT UPDATE (draft_move) ON public.players TO anon, authenticated;
GRANT UPDATE (draft_pick) ON public.rooms   TO anon, authenticated;

-- Verification: one row per rule, in the results grid.
SELECT 1 AS ord, 'players.draft_move exists' AS "check",
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'players'
                            AND column_name = 'draft_move')
            THEN 'ok' ELSE 'FAIL' END AS result
UNION ALL
SELECT 2, 'rooms.draft_pick exists',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'rooms'
                            AND column_name = 'draft_pick')
            THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 3, 'a player may save a move',
       CASE WHEN has_column_privilege('authenticated', 'public.players', 'draft_move', 'UPDATE')
             AND has_column_privilege('anon', 'public.players', 'draft_move', 'UPDATE')
            THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 4, 'the host may save the spin',
       CASE WHEN has_column_privilege('authenticated', 'public.rooms', 'draft_pick', 'UPDATE')
             AND has_column_privilege('anon', 'public.rooms', 'draft_pick', 'UPDATE')
            THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 5, 'only a real move or pick can be stored',
       CASE WHEN (SELECT count(*) FROM pg_constraint
                   WHERE conname IN ('players_draft_move_shape', 'rooms_draft_pick_shape')) = 2
            THEN 'ok' ELSE 'FAIL' END
UNION ALL
SELECT 6, 'the host role and the phase are still not writable',
       CASE WHEN NOT has_column_privilege('authenticated', 'public.players', 'is_host', 'UPDATE')
             AND NOT has_column_privilege('authenticated', 'public.rooms', 'game_phase', 'UPDATE')
            THEN 'ok' ELSE 'FAIL' END
ORDER BY 1;
