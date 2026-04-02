// ============================================
// Oracle Party — Admin Dashboard
// Unlisted page, gated by is_admin on profiles.
// ============================================

import { $ } from './utils.js';
import { supabase, fetchSiteSettings, upsertSiteSetting, deleteSiteSetting } from './supabase.js';
import { ensureDisplayName, initAuth, getCurrentUser } from './auth.js';

// ============================================
// INIT
// ============================================

async function init() {
  await Promise.all([ensureDisplayName(), initAuth()]);

  const user = getCurrentUser();
  if (!user?.profile?.is_admin) {
    window.location.href = 'index.html';
    return;
  }

  $('#admin-loading').style.display = 'none';
  $('#admin-content').style.display = '';

  // Load all sections in parallel
  await Promise.all([
    loadDashboardStats(),
    loadAnnouncement(),
    loadFeatureFlags(),
    loadFlaggedQueue()
  ]);

  attachListeners();
}

// ============================================
// DASHBOARD STATS
// ============================================

async function loadDashboardStats() {
  // Players online: count players in active rooms
  const { count: onlineCount } = await supabase
    .from('players')
    .select('id', { count: 'exact', head: true });
  $('#stat-online').textContent = onlineCount ?? '-';

  // Games in progress
  const { count: gamesCount } = await supabase
    .from('rooms')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'playing');
  $('#stat-games').textContent = gamesCount ?? '-';

  // Total accounts
  const { count: accountCount } = await supabase
    .from('profiles')
    .select('user_id', { count: 'exact', head: true });
  $('#stat-accounts').textContent = accountCount ?? '-';

  // Games played today
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { count: todayCount } = await supabase
    .from('game_history')
    .select('id', { count: 'exact', head: true })
    .gte('played_at', todayStart.toISOString());
  $('#stat-today').textContent = todayCount ?? '-';
}

// ============================================
// ANNOUNCEMENTS
// ============================================

async function loadAnnouncement() {
  const settings = await fetchSiteSettings();
  const ann = settings.find(s => s.key === 'announcement');
  const input = $('#announcement-input');
  const status = $('#announcement-status');
  if (ann?.value?.text) {
    input.value = ann.value.text;
    status.textContent = `Active since ${new Date(ann.value.created_at || ann.updated_at).toLocaleDateString()}`;
  } else {
    input.value = '';
    status.textContent = 'No active announcement';
  }
}

// ============================================
// FEATURE FLAGS
// ============================================

const FLAG_DEFS = [
  { key: 'maintenance_mode', label: 'Maintenance Mode', default: false },
  { key: 'disable_signups', label: 'Disable Account Creation', default: false },
  { key: 'disable_nudges', label: 'Disable Sign-up Nudges', default: false },
];

async function loadFeatureFlags() {
  const settings = await fetchSiteSettings();
  const container = $('#feature-flags');
  container.innerHTML = '';

  for (const flag of FLAG_DEFS) {
    const setting = settings.find(s => s.key === flag.key);
    const value = setting?.value?.enabled ?? flag.default;

    const row = document.createElement('div');
    row.className = 'profile-toggle';
    row.innerHTML = `
      <span>${flag.label}</span>
      <label class="profile-switch">
        <input type="checkbox" data-flag="${flag.key}" ${value ? 'checked' : ''}>
        <span class="profile-switch__slider"></span>
      </label>
    `;
    container.appendChild(row);
  }

  // Wire toggle handlers
  container.querySelectorAll('input[data-flag]').forEach(input => {
    input.onchange = () => {
      upsertSiteSetting(input.dataset.flag, { enabled: input.checked });
    };
  });
}

// ============================================
// FLAGGED QUEUE
// ============================================

async function loadFlaggedQueue() {
  const container = $('#flagged-queue');

  // Fetch all flags
  const { data: flags, error } = await supabase
    .from('question_feedback')
    .select('question_id, feedback_type, flag_reason, player_name')
    .eq('feedback_type', 'flag');

  if (error || !flags || flags.length === 0) {
    container.innerHTML = '<p style="color:var(--color-text-muted); font-size:var(--text-sm);">No flagged questions.</p>';
    return;
  }

  // Group by question_id
  const grouped = {};
  for (const f of flags) {
    if (!grouped[f.question_id]) grouped[f.question_id] = { count: 0, reasons: [], players: [] };
    grouped[f.question_id].count++;
    if (f.flag_reason) grouped[f.question_id].reasons.push(f.flag_reason);
    grouped[f.question_id].players.push(f.player_name);
  }

  // Fetch question details for flagged IDs
  const qIds = Object.keys(grouped);
  const { data: questions } = await supabase
    .from('questions')
    .select('*')
    .in('id', qIds);

  const qMap = {};
  for (const q of (questions || [])) qMap[q.id] = q;

  // Sort by flag count descending
  const sorted = Object.entries(grouped).sort((a, b) => b[1].count - a[1].count);

  container.innerHTML = sorted.map(([qId, info]) => {
    const q = qMap[qId];
    const qText = q?.question_text || q?.question || 'Unknown question';
    const answer = q?.correct_answer || q?.answer || '?';
    const reasons = [...new Set(info.reasons)].join(', ') || 'No reason';
    return `
      <div class="admin-flag-row" data-qid="${qId}">
        <div class="admin-flag-row__text">${escapeText(qText)}</div>
        <div class="admin-flag-row__meta">
          <span class="admin-flag-row__answer">A: ${escapeText(answer)}</span>
          <span class="admin-flag-row__count">${info.count} flag${info.count > 1 ? 's' : ''}</span>
          <span class="admin-flag-row__reasons">${escapeText(reasons)}</span>
        </div>
        <div class="admin-flag-row__actions">
          <button class="btn btn-secondary" data-dismiss="${qId}">Unflag</button>
          <button class="btn btn-secondary btn-danger-text" data-remove="${qId}">Remove Q</button>
        </div>
      </div>
    `;
  }).join('');

  // Wire actions
  container.onclick = async (e) => {
    const dismissBtn = e.target.closest('[data-dismiss]');
    const removeBtn = e.target.closest('[data-remove]');

    if (dismissBtn) {
      const qId = dismissBtn.dataset.dismiss;
      await supabase.from('question_feedback').delete().eq('question_id', qId).eq('feedback_type', 'flag');
      dismissBtn.closest('.admin-flag-row').remove();
    }
    if (removeBtn) {
      const qId = removeBtn.dataset.remove;
      await supabase.from('questions').update({ format: 'removed' }).eq('id', qId);
      await supabase.from('question_feedback').delete().eq('question_id', qId).eq('feedback_type', 'flag');
      removeBtn.closest('.admin-flag-row').remove();
    }
  };
}

// ============================================
// QUESTION MANAGEMENT
// ============================================

let _questionOffset = 0;
const PAGE_SIZE = 25;

async function loadQuestions() {
  const search = $('#q-search').value.trim();
  const category = $('#q-category').value;
  const format = $('#q-format').value;

  _questionOffset = 0;
  const questions = await fetchQuestions(search, category, format, 0);
  renderQuestions(questions);
  $('#btn-load-more').style.display = questions.length >= PAGE_SIZE ? '' : 'none';
}

async function loadMoreQuestions() {
  const search = $('#q-search').value.trim();
  const category = $('#q-category').value;
  const format = $('#q-format').value;

  _questionOffset += PAGE_SIZE;
  const questions = await fetchQuestions(search, category, format, _questionOffset);
  appendQuestions(questions);
  $('#btn-load-more').style.display = questions.length >= PAGE_SIZE ? '' : 'none';
}

async function fetchQuestions(search, category, format, offset) {
  let query = supabase.from('questions').select('*');

  if (search) query = query.ilike('question_text', `%${search}%`);
  if (category) query = query.contains('categories', [category]);
  if (format) query = query.eq('format', format);

  query = query.order('id', { ascending: false }).range(offset, offset + PAGE_SIZE - 1);

  const { data, error } = await query;
  if (error) { console.error('[Admin] fetchQuestions failed:', error.message); return []; }
  return data || [];
}

function renderQuestions(questions) {
  const container = $('#question-results');
  container.innerHTML = '';
  appendQuestions(questions);
}

function appendQuestions(questions) {
  const container = $('#question-results');
  for (const q of questions) {
    container.appendChild(createQuestionRow(q));
  }
}

function createQuestionRow(q) {
  const text = q.question_text || q.question || '';
  const answer = q.correct_answer || q.answer || '';
  const alternates = q.acceptable_answers || q.acceptable_alternates || q.alternates || [];
  const cats = (q.categories || []).join(', ');
  const truncated = text.length > 80 ? text.slice(0, 80) + '\u2026' : text;

  const row = document.createElement('div');
  row.className = 'admin-q-row';
  row.dataset.qid = q.id;

  row.innerHTML = `
    <div class="admin-q-row__summary">
      <div class="admin-q-row__text">${escapeText(truncated)}</div>
      <div class="admin-q-row__meta">
        <span>${escapeText(cats)}</span>
        <span>${q.format || '?'}</span>
        <span>${q.difficulty || '?'}</span>
      </div>
    </div>
    <div class="admin-q-row__edit" style="display:none;">
      <label>Question<textarea class="input admin-q-edit__text" rows="3">${escapeText(text)}</textarea></label>
      <label>Answer<input class="input admin-q-edit__answer" value="${escapeText(answer)}"></label>
      <label>Alternates (comma-separated)<input class="input admin-q-edit__alts" value="${escapeText(Array.isArray(alternates) ? alternates.join(', ') : '')}"></label>
      <label>Format
        <select class="input admin-q-edit__format">
          <option value="open" ${q.format === 'open' ? 'selected' : ''}>Open</option>
          <option value="removed" ${q.format === 'removed' ? 'selected' : ''}>Removed</option>
        </select>
      </label>
      <label>Difficulty
        <select class="input admin-q-edit__difficulty">
          <option value="easy" ${q.difficulty === 'easy' ? 'selected' : ''}>Easy</option>
          <option value="medium" ${q.difficulty === 'medium' ? 'selected' : ''}>Medium</option>
          <option value="hard" ${q.difficulty === 'hard' ? 'selected' : ''}>Hard</option>
        </select>
      </label>
      <button class="btn btn-primary admin-q-edit__save">Save</button>
      <span class="admin-q-edit__status"></span>
    </div>
  `;

  // Toggle edit on click summary
  row.querySelector('.admin-q-row__summary').onclick = () => {
    const edit = row.querySelector('.admin-q-row__edit');
    edit.style.display = edit.style.display === 'none' ? '' : 'none';
  };

  // Save handler
  row.querySelector('.admin-q-edit__save').onclick = async () => {
    const statusEl = row.querySelector('.admin-q-edit__status');
    statusEl.textContent = 'Saving...';

    const newText = row.querySelector('.admin-q-edit__text').value.trim();
    const newAnswer = row.querySelector('.admin-q-edit__answer').value.trim();
    const newAlts = row.querySelector('.admin-q-edit__alts').value.split(',').map(s => s.trim()).filter(Boolean);
    const newFormat = row.querySelector('.admin-q-edit__format').value;
    const newDifficulty = row.querySelector('.admin-q-edit__difficulty').value;

    // Determine which column names to use
    const textCol = q.question_text !== undefined ? 'question_text' : 'question';
    const answerCol = q.correct_answer !== undefined ? 'correct_answer' : 'answer';
    const altsCol = q.acceptable_answers !== undefined ? 'acceptable_answers'
      : q.acceptable_alternates !== undefined ? 'acceptable_alternates' : 'alternates';

    const updates = {
      [textCol]: newText,
      [answerCol]: newAnswer,
      [altsCol]: newAlts,
      format: newFormat,
      difficulty: newDifficulty
    };

    const { error } = await supabase.from('questions').update(updates).eq('id', q.id);
    statusEl.textContent = error ? `Error: ${error.message}` : 'Saved!';
    if (!error) {
      // Update the summary text
      row.querySelector('.admin-q-row__text').textContent = newText.length > 80 ? newText.slice(0, 80) + '\u2026' : newText;
      setTimeout(() => { statusEl.textContent = ''; }, 2000);
    }
  };

  return row;
}

// ============================================
// EVENT LISTENERS
// ============================================

function attachListeners() {
  // Announcements
  $('#btn-set-announcement').onclick = async () => {
    const text = $('#announcement-input').value.trim();
    if (!text) return;
    await upsertSiteSetting('announcement', { text, created_at: new Date().toISOString() });
    $('#announcement-status').textContent = 'Banner set!';
  };
  $('#btn-clear-announcement').onclick = async () => {
    await deleteSiteSetting('announcement');
    $('#announcement-input').value = '';
    $('#announcement-status').textContent = 'Banner cleared.';
  };

  // Question search
  $('#btn-search-questions').onclick = loadQuestions;
  $('#q-search').onkeydown = (e) => { if (e.key === 'Enter') loadQuestions(); };
  $('#btn-load-more').onclick = loadMoreQuestions;
}

// ============================================
// HELPERS
// ============================================

function escapeText(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Start ---
init();
