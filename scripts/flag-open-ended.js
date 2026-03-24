#!/usr/bin/env node
// ============================================
// Oracle Party — Flag Open-Ended Questions
// ============================================
//
// Scans all questions with format='open' and flags those whose phrasing
// suggests they are too open-ended for typed answers (e.g., "Name a use for...").
//
// Usage:
//   node scripts/flag-open-ended.js           # dry run — prints flagged questions
//   node scripts/flag-open-ended.js --apply   # updates flagged questions in DB

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://zzpqymehapwbjupphxec.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_UJtIRllW5SWhMbqynb-3QQ_HWIV2OSd';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const applyMode = process.argv.includes('--apply');

// Patterns that indicate open-ended questions
const OPEN_ENDED_PATTERNS = [
  /^name\s+(a|an|one|two|three|some)\b/i,
  /^(give|provide)\s+(a|an|one)\s+example/i,
  /^list\s+(a|an|one|some)\b/i,
  /^what\s+(is|are)\s+(a|an|one)\s+(use|example|reason|way)\b/i,
  /^what\s+(could|can|might)\b/i,
  /^(describe|suggest)\s+(a|an|one)\b/i,
];

// The question_text field might be named differently — try common names
function getQuestionText(q) {
  return q.question_text || q.question || q.text || '';
}

async function fetchAllOpenQuestions() {
  const all = [];
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from('questions')
      .select('*')
      .eq('format', 'open')
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      console.error('Fetch error:', error.message);
      break;
    }

    all.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return all;
}

function matchesOpenEndedPattern(text) {
  for (const pattern of OPEN_ENDED_PATTERNS) {
    if (pattern.test(text)) return pattern.source;
  }
  return null;
}

async function updateBatch(ids) {
  // Supabase .in() supports up to ~100 IDs
  const BATCH_SIZE = 100;
  let updated = 0;

  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const { error, count } = await supabase
      .from('questions')
      .update({ format: 'multiple_choice' })
      .in('id', batch);

    if (error) {
      console.error(`Batch update error (offset ${i}):`, error.message);
    } else {
      updated += batch.length;
    }
  }

  return updated;
}

async function main() {
  console.log(`Mode: ${applyMode ? 'APPLY (will update DB)' : 'DRY RUN (preview only)'}\n`);

  console.log('Fetching all open-format questions...');
  const questions = await fetchAllOpenQuestions();
  console.log(`Found ${questions.length} questions with format='open'\n`);

  const flagged = [];

  for (const q of questions) {
    const text = getQuestionText(q);
    const matched = matchesOpenEndedPattern(text);
    if (matched) {
      flagged.push({ id: q.id, text, pattern: matched });
    }
  }

  if (flagged.length === 0) {
    console.log('No open-ended questions found matching the patterns.');
    return;
  }

  console.log(`Flagged ${flagged.length} questions:\n`);
  for (const f of flagged) {
    console.log(`  [${f.id}] "${f.text}"`);
    console.log(`    Matched: ${f.pattern}\n`);
  }

  if (applyMode) {
    console.log('Updating flagged questions to format=\'multiple_choice\'...');
    const ids = flagged.map(f => f.id);
    const updated = await updateBatch(ids);
    console.log(`Done. Updated ${updated} questions.`);
  } else {
    console.log('---');
    console.log(`Run with --apply to update these ${flagged.length} questions in the database.`);
  }
}

main().catch(console.error);
