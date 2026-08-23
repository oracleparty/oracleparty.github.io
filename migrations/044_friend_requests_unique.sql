-- ============================================
-- Migration 044 — the friend-request uniqueness that was never there
--
-- Paste into the Supabase SQL Editor and press Run. Safe to run twice.
--
-- READ THIS BEFORE RUNNING: THIS DELETES ROWS. Not many, and the report at the
-- top tells you exactly how many before anything changes — but it does delete.
--
-- WHAT THE LIVE DATA SHOWED
--
-- Six rows in friend_requests, and three of them were the SAME PAIR:
--
--   a51672d3... -> 52dc935d...  pending  2026-03-30 00:00:03
--   a51672d3... -> 52dc935d...  pending  2026-03-30 00:01:14
--   a51672d3... -> 52dc935d...  pending  2026-03-30 00:24:36
--
-- migrations/003 declares UNIQUE(sender_id, receiver_id) on this table. Those
-- three rows cannot exist if that constraint does. So it was never created —
-- schema drift, CLAUDE.md #7, found the same way as every other instance of it
-- here: by looking at the data rather than at the migration file.
--
-- WHAT IT BROKE
--
-- sendFriendRequest looked for an existing request with .maybeSingle(), which
-- ERRORS when more than one row matches, and the error was discarded. So once
-- two rows existed for a pair, every guard on that pair failed open:
--
--   * the duplicate check stopped working, so a third row could be written;
--   * the AUTO-ACCEPT stopped working. 52dc935d and a51672d3 each have a
--     pending request to the other — rows 4 and 5/6 in the report. The second
--     of those should have been auto-accepted into a friendship on the spot.
--     Instead the reverse lookup errored, was ignored, and a mirror-image
--     request was inserted. Two people who both said yes are still not
--     friends, five months later, and neither was ever told why.
--
-- AND THE ROOT CAUSE, found by running an earlier draft of this file:
--
-- The live `friendships` table has a CHECK constraint, friendships_source_check,
-- that appears in NO migration in this repo and REJECTS source = 'request'.
-- acceptFriendRequest is the only caller of createFriendship and it passes
-- exactly that value. So EVERY accept has died on a 23514 for as long as that
-- constraint has existed, the error surfaced as the word "Error" on the button,
-- and nobody could accept a friend request at all. That is the reported bug.
-- The constraint turned out to be:
--
--   CHECK (source = ANY (ARRAY['lobby', 'search']))
--
-- and `source` is NOT NULL with no usable default, so omitting it fails too.
-- Step 4 below widens it to include 'request'. js/db/social.js also falls back
-- to 'search' when a CHECK refuses the row, so the app works before this is
-- run as well as after.
--
-- The client no longer depends on the unique constraint either — it takes the
-- newest row rather than assuming one exists — so the app is correct with or
-- without this migration. This makes the DATA correct, and stops it happening
-- again.
-- ============================================


-- --------------------------------------------
-- 1. REPORT FIRST. Nothing is changed by this block.
--    Read it before running the rest.
-- --------------------------------------------

SELECT 'duplicate pairs' AS finding,
       sender_id, receiver_id, count(*) AS rows_held
  FROM friend_requests
 GROUP BY sender_id, receiver_id
HAVING count(*) > 1
 ORDER BY count(*) DESC;

SELECT 'mutual pending, never auto-accepted' AS finding,
       a.sender_id AS person_a, a.receiver_id AS person_b
  FROM friend_requests a
  JOIN friend_requests b
    ON b.sender_id = a.receiver_id AND b.receiver_id = a.sender_id
 WHERE a.status = 'pending' AND b.status = 'pending'
   AND a.sender_id < a.receiver_id;


-- --------------------------------------------
-- 2. Collapse duplicates, keeping ONE row per direction.
--
-- Which one survives is not arbitrary. An 'accepted' row is a fact about
-- something that happened and outranks a 'pending' one; a 'declined' row is a
-- decision somebody made and outranks 'pending' too. Among equals the NEWEST
-- wins, because it is the most recent thing either person did.
-- --------------------------------------------
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY sender_id, receiver_id
           ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'declined' THEN 1 ELSE 2 END,
                    created_at DESC
         ) AS rn
    FROM friend_requests
)
DELETE FROM friend_requests
 WHERE id IN (SELECT id FROM ranked WHERE rn > 1);


-- --------------------------------------------
-- 3. The constraint migration 003 said was there.
--
-- Named, so a later run can see it and so the next person can find it.
-- --------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'friend_requests_sender_receiver_key'
       AND conrelid = 'friend_requests'::regclass
  ) THEN
    ALTER TABLE friend_requests
      ADD CONSTRAINT friend_requests_sender_receiver_key UNIQUE (sender_id, receiver_id);
  END IF;
END $$;


-- --------------------------------------------
-- 4. Finish the auto-accepts the app dropped.
--
-- Two people with a pending request to each other have BOTH said yes. The app
-- is supposed to turn the second one into a friendship immediately, and it
-- failed to because of the fault above. Doing it here is completing an action
-- both people took, not inventing one.
--
-- friendships stores the pair in sorted order (least, greatest), which is what
-- createFriendship in js/ does, so the two agree.
-- --------------------------------------------
-- FIRST, widen the constraint that has been blocking this all along.
--
-- Measured on the live database, and it is in no migration in this repo:
--
--   friendships_source_check  CHECK (source = ANY (ARRAY['lobby', 'search']))
--
-- acceptFriendRequest passes 'request', so every accept died on it. `source`
-- is also NOT NULL with no usable default, so simply omitting the column fails
-- with 23502 instead — both halves measured, the second because omitting it
-- was tried here and the database said no.
--
-- 'request' is a real third source and worth recording: it says these two
-- people asked each other, rather than one adding the other from a lobby or a
-- search. So the constraint widens rather than the code lying about it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'friendships_source_check'
       AND conrelid = 'friendships'::regclass
  ) THEN
    ALTER TABLE friendships DROP CONSTRAINT friendships_source_check;
  END IF;
  ALTER TABLE friendships
    ADD CONSTRAINT friendships_source_check
    CHECK (source = ANY (ARRAY['lobby'::text, 'search'::text, 'request'::text]));
END $$;

INSERT INTO friendships (user_a, user_b, source)
SELECT DISTINCT
       LEAST(a.sender_id, a.receiver_id),
       GREATEST(a.sender_id, a.receiver_id),
       'request'
  FROM friend_requests a
  JOIN friend_requests b
    ON b.sender_id = a.receiver_id AND b.receiver_id = a.sender_id
 WHERE a.status = 'pending' AND b.status = 'pending'
ON CONFLICT DO NOTHING;

-- And mark both directions accepted, so neither person is still shown a
-- request from somebody they are already friends with.
UPDATE friend_requests r
   SET status = 'accepted'
 WHERE r.status = 'pending'
   AND EXISTS (
     SELECT 1 FROM friend_requests o
      WHERE o.sender_id = r.receiver_id
        AND o.receiver_id = r.sender_id
        AND o.status IN ('pending', 'accepted')
   );


-- --------------------------------------------
-- VERIFY
--
-- Expect: no duplicate pairs, the constraint listed, and every remaining
-- request in a sensible state.
-- --------------------------------------------

SELECT 'duplicates remaining' AS check, count(*) AS should_be_zero
  FROM (
    SELECT 1 FROM friend_requests
     GROUP BY sender_id, receiver_id HAVING count(*) > 1
  ) d;

SELECT conname AS constraint_name, contype
  FROM pg_constraint
 WHERE conrelid = 'friend_requests'::regclass AND contype = 'u';

-- Should now list 'request' alongside 'lobby' and 'search'.
SELECT conname, pg_get_constraintdef(oid)
  FROM pg_constraint
 WHERE conrelid = 'friendships'::regclass AND conname = 'friendships_source_check';

SELECT status, count(*) FROM friend_requests GROUP BY status ORDER BY status;
