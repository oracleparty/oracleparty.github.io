-- 075 — Chaos mode: the host can let honks through while people answer
--
-- Asked for by the owner on 2026-10-26. Ordinarily a honk is dropped while
-- somebody is on the question screen (the game's own "non-chaos" rule, and the
-- default). Chaos mode is a room setting the host turns on, everybody can see
-- it is on, and with it on honks sound and show at every moment of the game.
--
-- One boolean on the room, written the same way as auto_proceed: by the host's
-- phone from the settings screens. 061 lists every rooms column a client may
-- UPDATE by name, deliberately, so a new column is refused until it is granted
-- here — without the GRANT the host's switch would be refused with 42501.
--
-- The JavaScript is safe before this runs: the switch is hidden whenever the
-- column cannot be read, so a missing migration reads as a missing feature.

ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS chaos boolean NOT NULL DEFAULT false;

GRANT UPDATE (chaos) ON public.rooms TO anon, authenticated;

-- ---------------------------------------------------------------------------
-- VERIFICATION — a SELECT, so the answer lands in the results grid. Both rows
-- should read ok.
-- ---------------------------------------------------------------------------

SELECT 1 AS ord, 'rooms.chaos exists' AS check,
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = 'rooms'
                            AND column_name = 'chaos')
            THEN 'ok' ELSE 'FAIL — column missing' END AS result
UNION ALL
SELECT 2, 'the host may switch it',
       CASE WHEN has_column_privilege('authenticated', 'public.rooms', 'chaos', 'UPDATE')
             AND has_column_privilege('anon', 'public.rooms', 'chaos', 'UPDATE')
            THEN 'ok' ELSE 'FAIL — not granted' END
ORDER BY 1;
