-- Migration: Add subcategory support to questions and rooms tables
-- Generic system — any category can define subcategories.
-- History is the first: Ancient, Medieval, Early Modern, Modern.

-- Add subcategory column to questions (nullable — null means "general/uncategorized")
ALTER TABLE questions ADD COLUMN IF NOT EXISTS subcategory TEXT;

-- Add subcategory column to rooms (nullable — null means "all subcategories")
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS subcategory TEXT;

-- Backfill the 120 history questions from their fun_fact era tags
UPDATE questions SET subcategory = 'ancient' WHERE fun_fact = 'Era: Ancient' AND subcategory IS NULL;
UPDATE questions SET subcategory = 'medieval' WHERE fun_fact = 'Era: Medieval' AND subcategory IS NULL;
UPDATE questions SET subcategory = 'early_modern' WHERE fun_fact = 'Era: Early Modern' AND subcategory IS NULL;
UPDATE questions SET subcategory = 'modern' WHERE fun_fact = 'Era: Modern' AND subcategory IS NULL;

-- Index for efficient filtering
CREATE INDEX IF NOT EXISTS idx_questions_subcategory ON questions(subcategory);
