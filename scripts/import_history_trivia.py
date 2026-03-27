#!/usr/bin/env python3
"""
Oracle Party — Import History Questions from HuggingFace trivia-qa-20k
Run this on your local machine (not in the sandbox).

Usage:
  pip install datasets
  python3 scripts/import_history_trivia.py > migrations/010_history_questions.sql

What it does:
1. Downloads prajwalmani/trivia-qa-20k from HuggingFace
2. Filters for history-related questions using keyword matching
3. Tags subcategories: Ancient (~<500 AD), Medieval (~500-1400),
   Early Modern (~1400-1900), Modern (~1900-present)
4. Excludes questions where the answer appears in the question text
5. Outputs INSERT statements matching the Oracle Party questions table schema
"""

import re
import json
from datasets import load_dataset

# --- CONFIG ---
DATASET = "prajwalmani/trivia-qa-20k"
OUTPUT_CATEGORY = "history"

# Keywords that indicate a history question (applied to question text)
HISTORY_KEYWORDS = [
    r'\bwar\b', r'\bbattle\b', r'\bempire\b', r'\bking\b', r'\bqueen\b',
    r'\bpresident\b', r'\bminister\b', r'\brevolution\b', r'\bindependence\b',
    r'\bcolony\b', r'\bcolonial\b', r'\btreaty\b', r'\bassassination?\b',
    r'\bcivilization\b', r'\bdynasty\b', r'\bconquest\b', r'\binvasion\b',
    r'\bempero?r\b', r'\bpharaoh\b', r'\bcaesar\b', r'\bnapoleon\b',
    r'\bww[i12]\b', r'\bworld war\b', r'\bcivil war\b', r'\bcold war\b',
    r'\bmediev[ae]l\b', r'\bancient\b', r'\bhistor(?:y|ic|ical)\b',
    r'\bcentury\b', r'\b\d{3,4}\s*(?:ad|bc|bce|ce)\b', r'\b(?:17|18|19|20)\d{2}\b',
    r'\bfounded\b', r'\bestablished\b', r'\babolition\b', r'\bslavery\b',
    r'\bdeclaration\b', r'\bconstitution\b', r'\barmistice\b', r'\bsurrender\b',
    r'\brenaissance\b', r'\breformation\b', r'\bcrusade\b', r'\bfeudal\b',
    r'\bcolumbus\b', r'\bmagellan\b', r'\bvoyage\b', r'\bexplorer\b',
    r'\bsigned\b.*\b(?:treaty|agreement|pact)\b',
    r'\bfirst\b.*\b(?:president|king|queen|emperor)\b',
    r'\bwho\b.*\b(?:ruled|conquered|invaded|founded|discovered|led)\b',
    r'\bwhat\b.*\b(?:year|century|era|period|age)\b.*\b(?:did|was|were)\b',
]
HISTORY_PATTERN = re.compile('|'.join(HISTORY_KEYWORDS), re.IGNORECASE)

# Subcategory tagging by era
MODERN_KEYWORDS = [
    r'\b(?:19|20)\d{2}\b', r'\bww[i12]\b', r'\bworld war\b',
    r'\bcold war\b', r'\bnuclear\b', r'\bsoviet\b', r'\bnazi\b',
    r'\bholocaust\b', r'\bunited nations\b', r'\b(?:first|second) world war\b',
    r'\bvietnam\b.*war', r'\bkorean war\b', r'\b(?:moon|space)\b.*\blanding\b',
]
EARLY_MODERN_KEYWORDS = [
    r'\b(?:14|15|16|17|18)\d{2}\b', r'\brenaissance\b', r'\breformation\b',
    r'\bcolonial\b', r'\bcolony\b', r'\bamerican revolution\b',
    r'\bfrench revolution\b', r'\bnapoleon\b', r'\bindustrial revolution\b',
    r'\bcolumbus\b', r'\bmagellan\b', r'\belizabeth(?:an)?\b',
    r'\btudor\b', r'\bottoman\b', r'\bmughal\b', r'\benlightenment\b',
]
MEDIEVAL_KEYWORDS = [
    r'\bmediev[ae]l\b', r'\bcrusade\b', r'\bfeudal\b', r'\bviking\b',
    r'\bbyzantin\b', r'\bcharlemagne\b', r'\bknight\b', r'\bcastle\b',
    r'\bmonastery\b', r'\bplague\b', r'\bblack death\b',
    r'\b(?:[5-9]|1[0-3])\d{2}\b(?:\s*ad)?',  # 500-1399
    r'\bmagna carta\b', r'\bnorman\b.*\bconquest\b',
]
ANCIENT_KEYWORDS = [
    r'\bancient\b', r'\bpharaoh\b', r'\bcaesar\b', r'\broman empire\b',
    r'\bgreek\b', r'\bathens?\b', r'\bsparta\b', r'\bpersia\b',
    r'\begypt(?:ian)?\b', r'\bpyramid\b', r'\bmesopotami\b',
    r'\bbabylon\b', r'\bsumer\b', r'\bbc\b', r'\bbce\b',
    r'\b[1-4]\d{2}\s*ad\b',  # 100-499 AD
    r'\bcleopatra\b', r'\balexander\b', r'\bjulius\b',
]

MODERN_PATTERN = re.compile('|'.join(MODERN_KEYWORDS), re.IGNORECASE)
EARLY_MODERN_PATTERN = re.compile('|'.join(EARLY_MODERN_KEYWORDS), re.IGNORECASE)
MEDIEVAL_PATTERN = re.compile('|'.join(MEDIEVAL_KEYWORDS), re.IGNORECASE)
ANCIENT_PATTERN = re.compile('|'.join(ANCIENT_KEYWORDS), re.IGNORECASE)


def classify_era(text):
    """Classify a question into a historical era subcategory."""
    scores = {
        'modern': len(MODERN_PATTERN.findall(text)),
        'early_modern': len(EARLY_MODERN_PATTERN.findall(text)),
        'medieval': len(MEDIEVAL_PATTERN.findall(text)),
        'ancient': len(ANCIENT_PATTERN.findall(text)),
    }
    best = max(scores, key=scores.get)
    if scores[best] == 0:
        return 'general'
    return best


def answer_in_question(question, answer):
    """Check if the answer text appears verbatim in the question."""
    q = question.lower().strip()
    a = answer.lower().strip()
    if len(a) < 3:
        return False  # Very short answers (e.g., numbers) — don't filter
    return a in q


def escape_sql(s):
    """Escape a string for PostgreSQL single-quoted literal."""
    return s.replace("'", "''").replace("\\", "\\\\")


def assign_difficulty(text):
    """Simple heuristic difficulty assignment."""
    words = text.split()
    if len(words) < 10:
        return 'easy'
    elif len(words) < 20:
        return 'medium'
    else:
        return 'hard'


def main():
    print("-- Oracle Party: History questions from prajwalmani/trivia-qa-20k")
    print("-- Generated by scripts/import_history_trivia.py")
    print("-- Filter: history keywords | Exclude: answer-in-question")
    print()

    # Load dataset
    ds = load_dataset(DATASET, split='train')
    cols = ds.column_names
    print(f"-- Dataset columns: {cols}")
    print(f"-- Total rows: {len(ds)}")

    # Detect column names
    q_col = next((c for c in ['question', 'question_text', 'text'] if c in cols), cols[0])
    a_col = next((c for c in ['answer', 'correct_answer'] if c in cols), cols[1])
    print(f"-- Using columns: question={q_col}, answer={a_col}")
    print()

    history_questions = []
    skipped_answer_in_q = 0

    for row in ds:
        question = str(row[q_col]).strip()
        answer = str(row[a_col]).strip()

        if not question or not answer:
            continue

        # Filter: must match history keywords
        if not HISTORY_PATTERN.search(question):
            continue

        # Exclude: answer appears in question
        if answer_in_question(question, answer):
            skipped_answer_in_q += 1
            continue

        era = classify_era(question)
        difficulty = assign_difficulty(question)

        history_questions.append({
            'question': question,
            'answer': answer,
            'era': era,
            'difficulty': difficulty,
        })

    print(f"-- History questions found: {len(history_questions)}")
    print(f"-- Skipped (answer in question): {skipped_answer_in_q}")
    print()

    # Output SQL INSERT statements
    print("INSERT INTO questions (question_text, correct_answer, acceptable_answers, categories, format, difficulty, fun_fact)")
    print("VALUES")

    lines = []
    for q in history_questions:
        qt = escape_sql(q['question'])
        ans = escape_sql(q['answer'])
        cats = f"{{'history'}}"  # PostgreSQL array literal
        diff = q['difficulty']
        era_tag = q['era']
        fun_fact = f"Era: {era_tag.replace('_', ' ').title()}"

        lines.append(
            f"  ('{qt}', '{ans}', ARRAY[]::text[], '{cats}', 'open', '{diff}', '{escape_sql(fun_fact)}')"
        )

    print(',\n'.join(lines))
    print(";")
    print()
    print(f"-- Total inserted: {len(lines)}")


if __name__ == '__main__':
    main()
