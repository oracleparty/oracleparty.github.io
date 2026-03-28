-- Fix Early Modern subcategory backfill using case-insensitive LIKE match.
-- The exact match 'Era: Early Modern' may not match if there are subtle
-- differences in whitespace or casing in the actual DB data.

UPDATE questions SET subcategory = 'early_modern'
WHERE subcategory IS NULL
  AND (
    fun_fact ILIKE '%Early Modern%'
    OR fun_fact ILIKE '%early_modern%'
    OR fun_fact ILIKE '%earlymodern%'
  );
