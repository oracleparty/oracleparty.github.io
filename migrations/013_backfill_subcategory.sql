-- Re-run subcategory backfill for history questions.
-- Needed if migration 012 was run before migration 010 (questions didn't exist yet).

UPDATE questions SET subcategory = 'ancient' WHERE fun_fact = 'Era: Ancient' AND subcategory IS NULL;
UPDATE questions SET subcategory = 'medieval' WHERE fun_fact = 'Era: Medieval' AND subcategory IS NULL;
UPDATE questions SET subcategory = 'early-modern' WHERE fun_fact = 'Era: Early Modern' AND subcategory IS NULL;
UPDATE questions SET subcategory = 'modern' WHERE fun_fact = 'Era: Modern' AND subcategory IS NULL;
