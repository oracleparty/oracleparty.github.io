// ============================================
// Oracle Party — Question Database Operations
// ============================================

import { supabase } from './client.js';
import { logger } from '../logger.js';
import { CATEGORY_PAGE_SIZE, QUESTION_POOL_SIZE, WILDCARD_LIMIT, DIFFICULTY_QUESTION_LIMIT, TITLE_BATCH_SIZE } from '../constants.js';

/**
 * Fetch distinct categories from the questions table with counts.
 * Questions have a `categories` text[] array column.
 * Paginates through all rows to ensure accurate counts.
 * Returns [{ name: 'history', count: 142 }, ...] sorted alphabetically.
 */
export async function fetchCategories() {
  const PAGE_SIZE = CATEGORY_PAGE_SIZE;
  const counts = {};
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const { data, error } = await supabase
      .from('questions')
      .select('categories')
      .eq('format', 'open')
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      logger.error('Supabase', 'Failed to fetch categories', error);
      // Re-throw so callers can surface the specific reason in the UI
      // instead of silently rendering an empty grid.
      const e = new Error(error.message || 'Supabase query failed');
      e.code = error.code;
      e.details = error.details;
      e.hint = error.hint;
      throw e;
    }

    for (const row of (data || [])) {
      // Supabase returns text[] as a JS array
      const cats = Array.isArray(row.categories) ? row.categories : [];
      for (const cat of cats) {
        counts[cat] = (counts[cat] || 0) + 1;
      }
    }

    hasMore = data && data.length === PAGE_SIZE;
    offset += PAGE_SIZE;
  }

  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Count questions matching a category + optional subcategory.
 */
export async function fetchQuestionCount(category, subcategory = null) {
  let query = supabase
    .from('questions')
    .select('id', { count: 'exact', head: true })
    .contains('categories', [category])
    .eq('format', 'open');
  if (subcategory) query = query.like('subcategory', subcategory + '%');
  const { count, error } = await query;
  if (error) { logger.error('Supabase', 'fetchQuestionCount failed', error); return 0; }
  return count || 0;
}

/**
 * Fetch questions for a category.
 * Fetches extra and shuffles client-side since PostgREST has no random order.
 * Tries common column names for question text/answer fields.
 *
 * Smart selection (when playerUserIds provided):
 *   1. Room dedup: excludeIds filters out all questions used in this room session
 *   2. Fresh first: questions no player has seen are prioritized
 *   3. Redemption: 5% chance per player per slot of drawing a question they got wrong
 *   4. Back of line: questions ALL players got correct are used last
 *   5. Graceful degradation: falls back to least-recently-seen, never errors
 */
export async function fetchQuestionsByCategory(category, limit, excludeIds = [], playerUserIds = [], subcategory = null) {
  // Fetch a large pool — we need enough to be selective
  const fetchCount = Math.min(QUESTION_POOL_SIZE, Math.max((limit + excludeIds.length) * 5, 100));
  let query = supabase
    .from('questions')
    .select('*')
    .contains('categories', [category])
    .eq('format', 'open');

  if (subcategory) {
    query = query.like('subcategory', subcategory + '%');
  }

  const { data, error } = await query.limit(fetchCount);

  if (error) {
    logger.error('Supabase', 'fetchQuestionsByCategory failed', error);
    return [];
  }

  // Filter out room-used questions
  const excludeSet = new Set(excludeIds);
  const available = excludeSet.size > 0 ? data.filter(q => !excludeSet.has(q.id)) : [...data];

  if (available.length === 0) {
    // Graceful degradation: if ALL questions are excluded, use any from the category
    logger.warn('Supabase', 'All questions excluded, falling back to unfiltered pool');
    return _shuffle(data).slice(0, limit);
  }

  // If no logged-in players, just shuffle and return (guest-only game)
  if (playerUserIds.length === 0) {
    return _shuffle(available).slice(0, limit);
  }

  // Fetch question history for all logged-in players in the room
  const history = await fetchQuestionHistoryForUsers(playerUserIds);

  // Build lookup: questionId → { seenBy, correctBy, wrongBy }
  const histMap = {};
  for (const h of history) {
    const qid = h.question_id;
    if (!histMap[qid]) histMap[qid] = { seenBy: new Set(), correctBy: new Set(), wrongBy: new Set(), lastSeen: 0 };
    histMap[qid].seenBy.add(h.user_id);
    if (h.times_correct > 0 && h.times_correct >= h.times_seen) {
      histMap[qid].correctBy.add(h.user_id);
    }
    if (h.times_seen > h.times_correct) {
      histMap[qid].wrongBy.add(h.user_id);
    }
    const ts = new Date(h.last_seen_at).getTime();
    if (ts > histMap[qid].lastSeen) histMap[qid].lastSeen = ts;
  }

  const loggedInCount = playerUserIds.length;

  // Bucket questions
  const fresh = [];       // No player has seen it
  const redemption = [];  // At least one player got it wrong
  const seenMixed = [];   // Some seen, not all mastered
  const mastered = [];    // ALL logged-in players got it correct

  for (const q of available) {
    const h = histMap[q.id];
    if (!h || h.seenBy.size === 0) {
      fresh.push(q);
    } else if (h.seenBy.size >= loggedInCount && h.correctBy.size >= loggedInCount) {
      mastered.push(q);
    } else if (h.wrongBy.size > 0) {
      redemption.push(q);
    } else {
      seenMixed.push(q);
    }
  }

  // Sort fallback pools by least-recently-seen
  seenMixed.sort((a, b) => (histMap[a.id]?.lastSeen || 0) - (histMap[b.id]?.lastSeen || 0));
  mastered.sort((a, b) => (histMap[a.id]?.lastSeen || 0) - (histMap[b.id]?.lastSeen || 0));

  // Shuffle fresh and redemption pools
  _shuffle(fresh);
  _shuffle(redemption);

  // Build the final selection (track IDs to prevent duplicates in fallback)
  const selected = [];
  const selectedIds = new Set();
  let freshIdx = 0;
  let redemptionIdx = 0;
  let seenIdx = 0;
  let masteredIdx = 0;

  for (let i = 0; i < limit; i++) {
    // 5% chance per logged-in player of a redemption question
    const redemptionChance = 1 - Math.pow(0.95, loggedInCount); // ~5% for 1 player, ~10% for 2, etc.
    if (redemptionIdx < redemption.length && Math.random() < redemptionChance) {
      const q = redemption[redemptionIdx++];
      selected.push(q); selectedIds.add(q.id);
      continue;
    }

    // Fresh questions first
    if (freshIdx < fresh.length) {
      const q = fresh[freshIdx++];
      selected.push(q); selectedIds.add(q.id);
      continue;
    }

    // Seen but not mastered (least recently seen first)
    if (seenIdx < seenMixed.length) {
      const q = seenMixed[seenIdx++];
      selected.push(q); selectedIds.add(q.id);
      continue;
    }

    // Redemption leftovers
    if (redemptionIdx < redemption.length) {
      const q = redemption[redemptionIdx++];
      selected.push(q); selectedIds.add(q.id);
      continue;
    }

    // Mastered (last resort, least recently seen first)
    if (masteredIdx < mastered.length) {
      const q = mastered[masteredIdx++];
      selected.push(q); selectedIds.add(q.id);
      continue;
    }

    // Absolute fallback: allow room repeats, but skip duplicates
    const unused = data.filter(q => !selectedIds.has(q.id));
    if (unused.length > 0) {
      const q = unused[Math.floor(Math.random() * unused.length)];
      selected.push(q); selectedIds.add(q.id);
    }
  }

  return selected;
}

/** Fisher-Yates shuffle (in-place, returns same array). */
function _shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Fetch all open-format questions regardless of category (for "All Questions" wild-card mode).
 */
export async function fetchAllOpenQuestions(limit, excludeIds = [], playerUserIds = []) {
  const fetchCount = Math.min(QUESTION_POOL_SIZE, Math.max((limit + excludeIds.length) * 5, 100));
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('format', 'open')
    .limit(fetchCount);

  if (error) {
    logger.error('Supabase', 'fetchAllOpenQuestions failed', error);
    return [];
  }

  const excludeSet = new Set(excludeIds);
  const available = excludeSet.size > 0 ? data.filter(q => !excludeSet.has(q.id)) : [...data];

  if (available.length === 0) {
    logger.warn('Supabase', 'All questions excluded, falling back to unfiltered pool');
    return _shuffle(data).slice(0, limit);
  }

  if (playerUserIds.length === 0) {
    return _shuffle(available).slice(0, limit);
  }

  // Smart selection (same logic as fetchQuestionsByCategory)
  const history = await fetchQuestionHistoryForUsers(playerUserIds);
  const histMap = {};
  for (const h of history) {
    if (!histMap[h.question_id]) histMap[h.question_id] = { seenBy: new Set(), correctBy: new Set(), wrongBy: new Set(), lastSeen: 0 };
    const e = histMap[h.question_id];
    e.seenBy.add(h.user_id);
    if (h.times_correct > 0) e.correctBy.add(h.user_id); else e.wrongBy.add(h.user_id);
    e.lastSeen = Math.max(e.lastSeen, new Date(h.last_seen_at).getTime());
  }

  const loggedInCount = playerUserIds.length;
  const fresh = [], redemption = [], seenMixed = [], mastered = [];
  for (const q of available) {
    const h = histMap[q.id];
    if (!h || h.seenBy.size === 0) fresh.push(q);
    else if (h.seenBy.size >= loggedInCount && h.correctBy.size >= loggedInCount) mastered.push(q);
    else if (h.wrongBy.size > 0) redemption.push(q);
    else seenMixed.push(q);
  }

  seenMixed.sort((a, b) => (histMap[a.id]?.lastSeen || 0) - (histMap[b.id]?.lastSeen || 0));
  mastered.sort((a, b) => (histMap[a.id]?.lastSeen || 0) - (histMap[b.id]?.lastSeen || 0));
  _shuffle(fresh);
  _shuffle(redemption);

  const selected = [];
  const selectedIds = new Set();
  let freshIdx = 0, redemptionIdx = 0, seenIdx = 0, masteredIdx = 0;
  for (let i = 0; i < limit; i++) {
    const redemptionChance = 1 - Math.pow(0.95, loggedInCount);
    if (redemptionIdx < redemption.length && Math.random() < redemptionChance) {
      selected.push(redemption[redemptionIdx]); selectedIds.add(redemption[redemptionIdx].id); redemptionIdx++; continue;
    }
    if (freshIdx < fresh.length) { selected.push(fresh[freshIdx]); selectedIds.add(fresh[freshIdx].id); freshIdx++; continue; }
    if (seenIdx < seenMixed.length) { selected.push(seenMixed[seenIdx]); selectedIds.add(seenMixed[seenIdx].id); seenIdx++; continue; }
    if (masteredIdx < mastered.length) { selected.push(mastered[masteredIdx]); selectedIds.add(mastered[masteredIdx].id); masteredIdx++; continue; }
    const unused = data.filter(q => !selectedIds.has(q.id));
    if (unused.length > 0) { const q = unused[Math.floor(Math.random() * unused.length)]; selected.push(q); selectedIds.add(q.id); }
  }
  return selected;
}

/**
 * Fetch questions that are EXCLUSIVELY in wild-card (no other categories).
 * These are the ~19 weird, uncategorizable questions.
 */
export async function fetchExclusiveWildCardQuestions(limit, excludeIds = []) {
  // Fetch questions that contain wild-card, then filter client-side
  // to only those where wild-card is the ONLY category (array length 1)
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('format', 'open')
    .contains('categories', ['wild-card'])
    .limit(WILDCARD_LIMIT);

  if (error) {
    logger.error('Supabase', 'fetchExclusiveWildCardQuestions failed', error);
    return [];
  }

  // Keep only questions exclusively in wild-card (no other categories)
  const exclusive = data.filter(q => Array.isArray(q.categories) && q.categories.length === 1);

  const excludeSet = new Set(excludeIds);
  const available = excludeSet.size > 0 ? exclusive.filter(q => !excludeSet.has(q.id)) : [...exclusive];
  return _shuffle(available.length > 0 ? available : exclusive).slice(0, limit);
}

/**
 * Fetch question count for "All Questions" wild-card mode (all open-format questions).
 */
export async function fetchAllOpenQuestionCount() {
  const { count, error } = await supabase
    .from('questions')
    .select('id', { count: 'exact', head: true })
    .eq('format', 'open');
  if (error) { logger.error('Supabase', 'fetchAllOpenQuestionCount failed', error); return 0; }
  return count || 0;
}

/**
 * Fetch question count for "True Wild Card" mode (exclusively wild-card questions).
 */
export async function fetchExclusiveWildCardCount() {
  // Can't filter by array length server-side — fetch all wild-card questions and count client-side
  const { data, error } = await supabase
    .from('questions')
    .select('id, categories')
    .eq('format', 'open')
    .contains('categories', ['wild-card']);
  if (error) { logger.error('Supabase', 'fetchExclusiveWildCardCount failed', error); return 0; }
  return (data || []).filter(q => Array.isArray(q.categories) && q.categories.length === 1).length;
}

/**
 * Fetch question history for multiple users.
 * Returns array of { user_id, question_id, times_seen, times_correct, last_seen_at }.
 */
export async function fetchQuestionHistoryForUsers(userIds) {
  if (!userIds || userIds.length === 0) return [];
  const { data, error } = await supabase
    .from('question_history')
    .select('user_id, question_id, times_seen, times_correct, last_seen_at')
    .in('user_id', userIds);
  if (error) {
    logger.error('Supabase', 'fetchQuestionHistoryForUsers failed', error);
    return [];
  }
  return data || [];
}

/**
 * Fetch a single random question by category and difficulty.
 * Used for the final question after difficulty vote.
 * Excludes any questionIds already used in this game.
 */
export async function fetchQuestionByDifficulty(category, difficulty, excludeIds = [], subcategory = null) {
  let query;

  if (subcategory === '__all_questions__') {
    // All Questions wild-card: any category, just match difficulty
    query = supabase.from('questions').select('*')
      .eq('format', 'open')
      .eq('difficulty', difficulty);
  } else if (subcategory === '__true_wild_card__') {
    // True Wild Card: only wild-card-exclusive questions
    query = supabase.from('questions').select('*')
      .eq('format', 'open')
      .contains('categories', ['wild-card'])
      .eq('difficulty', difficulty);
  } else {
    query = supabase.from('questions').select('*')
      .contains('categories', [category])
      .eq('format', 'open')
      .eq('difficulty', difficulty);
    if (subcategory) {
      query = query.like('subcategory', subcategory + '%');
    }
  }

  query = query.limit(DIFFICULTY_QUESTION_LIMIT);

  let { data, error } = await query;
  if (error || !data || data.length === 0) {
    logger.warn('Supabase', 'fetchQuestionByDifficulty: no questions found for ' + difficulty);
    return null;
  }

  // True Wild Card: filter client-side to exclusively wild-card
  if (subcategory === '__true_wild_card__') {
    data = data.filter(q => Array.isArray(q.categories) && q.categories.length === 1);
    if (data.length === 0) return null;
  }

  // Filter out already-used questions
  const available = excludeIds.length > 0
    ? data.filter(q => !excludeIds.includes(q.id))
    : data;

  if (available.length === 0) return data[Math.floor(Math.random() * data.length)]; // Fallback: allow repeats
  return available[Math.floor(Math.random() * available.length)];
}

/**
 * Fetch questions by their IDs (preserves order via client-side sort).
 */
export async function fetchQuestionsByIds(questionIds) {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .in('id', questionIds);

  if (error) {
    logger.error('Supabase', 'fetchQuestionsByIds failed', error);
    return [];
  }

  // Preserve order of questionIds
  const idMap = {};
  for (const q of (data || [])) idMap[q.id] = q;
  return questionIds.map(id => idMap[id]).filter(Boolean);
}

/**
 * Upsert a question_history row for a user+question.
 * Increments times_seen (always) and times_correct (if correct).
 * Foundation for future spaced repetition / adaptive question selection.
 */
export async function upsertQuestionHistory(userId, questionId, isCorrect) {
  const { data: existing } = await supabase
    .from('question_history')
    .select('id, times_seen, times_correct')
    .eq('user_id', userId)
    .eq('question_id', questionId)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase.from('question_history').update({
      times_seen: existing.times_seen + 1,
      times_correct: existing.times_correct + (isCorrect ? 1 : 0),
      last_correct: isCorrect,
      last_seen_at: new Date().toISOString()
    }).eq('id', existing.id);
    if (error) logger.error('Supabase', 'upsertQuestionHistory update failed', error);
  } else {
    const { error } = await supabase.from('question_history').insert({
      user_id: userId,
      question_id: questionId,
      times_seen: 1,
      times_correct: isCorrect ? 1 : 0,
      last_correct: isCorrect,
      last_seen_at: new Date().toISOString()
    });
    if (error) logger.error('Supabase', 'upsertQuestionHistory insert failed', error);
  }
}

/**
 * Fetch mastery counts per category for a user.
 * "Mastered" = last_correct is true in question_history.
 * Returns array of { category, subcategory, mastered }.
 */
export async function fetchMasteryCounts(userId) {
  const { data, error } = await supabase
    .rpc('get_mastery_counts', { p_user_id: userId });
  if (error) {
    // RPC may not exist — fall back to client-side query
    logger.warn('Supabase', 'fetchMasteryCounts RPC failed, using fallback', error);
    return _fetchMasteryCountsFallback(userId);
  }
  return data || [];
}

async function _fetchMasteryCountsFallback(userId) {
  const { data, error } = await supabase
    .from('question_history')
    .select('question_id, last_correct')
    .eq('user_id', userId)
    .eq('last_correct', true);
  if (error || !data) return [];

  // Look up each question's category — batch in chunks to avoid URL length limits
  const qIds = data.map(d => d.question_id);
  if (qIds.length === 0) return [];

  const BATCH = TITLE_BATCH_SIZE;
  const questions = [];
  for (let i = 0; i < qIds.length; i += BATCH) {
    const chunk = qIds.slice(i, i + BATCH);
    const { data: batch } = await supabase
      .from('questions')
      .select('id, categories, subcategory')
      .in('id', chunk);
    if (batch) questions.push(...batch);
  }
  if (questions.length === 0) return [];

  // Count per category + subcategory
  const counts = {};
  for (const q of questions) {
    const cats = Array.isArray(q.categories) ? q.categories : [];
    for (const cat of cats) {
      const key = `${cat}|${q.subcategory || ''}`;
      if (!counts[key]) counts[key] = { category: cat, subcategory: q.subcategory || null, mastered: 0 };
      counts[key].mastered++;
    }
  }
  return Object.values(counts);
}

// ============================================
// QUESTION FEEDBACK
// ============================================

export async function upsertQuestionFeedback({ questionId, roomId, playerName, feedbackType, flagReason, voterId }) {
  if (!voterId) {
    logger.error('Supabase', 'upsertQuestionFeedback called without voterId');
    return { error: { message: 'missing voterId' } };
  }
  // Keyed on voter_id, so one person rates a question once no matter how many
  // games they play it in. Changing your mind updates the existing row rather
  // than adding another vote. room_id and player_name are kept for context.
  const { error } = await supabase
    .from('question_feedback')
    .upsert({
      question_id: questionId,
      voter_id: voterId,
      room_id: roomId,
      player_name: playerName,
      feedback_type: feedbackType,
      flag_reason: flagReason || null
    }, { onConflict: 'question_id,voter_id' });

  if (error) logger.error('Supabase', 'upsertQuestionFeedback failed', error);
  return { error };
}

export async function deleteQuestionFeedbackByVoter({ questionId, voterId }) {
  if (!voterId) return { error: { message: 'missing voterId' } };
  const { error } = await supabase
    .from('question_feedback')
    .delete()
    .eq('question_id', questionId)
    .eq('voter_id', voterId);
  if (error) logger.error('Supabase', 'deleteQuestionFeedbackByVoter failed', error);
  return { error };
}

export async function fetchQuestionFeedback(voterId) {
  if (!voterId) return [];
  // Everything this voter has ever rated, so previous choices show as already
  // selected even in a brand new game.
  const { data, error } = await supabase
    .from('question_feedback')
    .select('question_id, feedback_type, flag_reason')
    .eq('voter_id', voterId);
  if (error) { logger.error('Supabase', 'fetchQuestionFeedback failed', error); return []; }
  return data || [];
}


// ============================================
// CATEGORY PLAY COUNTS
// ============================================

export async function fetchCategoryPlayCounts() {
  // RPC returns sitewide aggregate counts from game_plays (all players, including guests).
  // Shape: { category, subcategory (null for cat-level), play_count }
  const { data, error } = await supabase.rpc('get_category_play_counts');

  if (error) {
    logger.error('Supabase', 'fetchCategoryPlayCounts failed', error);
    return {};
  }

  // Build a flat map: 'history' → count, 'history/ancient' → count
  const counts = {};
  for (const row of (data || [])) {
    if (!row.subcategory) {
      // Category-level total
      counts[row.category] = (counts[row.category] || 0) + (row.play_count || 0);
    } else {
      // Subcategory-level: key = 'category/subcategory'
      const key = `${row.category}/${row.subcategory}`;
      counts[key] = (counts[key] || 0) + (row.play_count || 0);
    }
  }
  return counts;
}

/**
 * Record how one player did on one question, for the admin Question Health
 * page. Guests included — this is the only durable, complete source of
 * per-question performance:
 *   - `answers` is deleted when a room is cleaned up
 *   - `question_history` is keyed on user_id, so guests record nothing
 *
 * `overridden` means the host disagreed with the automatic judgement, which is
 * the strongest signal that a question's acceptable_answers list is missing a
 * valid answer.
 *
 * Called by the host only, once per question, so counts are not multiplied by
 * the number of devices in the room.
 */
export async function recordQuestionOutcome(questionId, isCorrect, overridden) {
  if (!questionId) return;
  const { error } = await supabase.rpc('record_question_outcome', {
    p_question_id: questionId,
    p_is_correct: !!isCorrect,
    p_overridden: !!overridden,
  });
  if (error) logger.error('Supabase', 'recordQuestionOutcome failed', error);
}
