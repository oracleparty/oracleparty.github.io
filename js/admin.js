// ============================================
// Oracle Party — Admin Dashboard
// Unlisted page, gated by is_admin on profiles.
// ============================================

import { $ } from './utils.js';
import { logger } from './logger.js';
import { supabase, fetchSiteSettings, upsertSiteSetting, deleteSiteSetting } from './supabase.js';
import { ensureDisplayName, initAuth, getCurrentUser } from './auth.js';
import { ADMIN_PAGE_SIZE, ADMIN_STATUS_FADE_MS } from './constants.js';

// ============================================
// INIT
// ============================================

async function init() {
  // Cancel the boot-guard timer in <head> — JS module chain is alive.
  window.__appReady = true;
  if (window.__appBootGuard) clearTimeout(window.__appBootGuard);
  document.body.style.opacity = '1';
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
    loadFlaggedQueue(),
    loadQuestionHealth(),
    loadRecentGames(),
    loadChatArchive(),
    loadErrorLogs()
  ]);

  attachListeners();
  attachQuestionHealthListeners();
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
      // Previously this ignored the result entirely and removed the row from
      // the screen regardless, so an RLS refusal looked like success and the
      // question came back next game.
      const { data: removed, error } = await supabase
        .from('questions').update({ format: 'removed' }).eq('id', qId).select();

      if (error || !removed || removed.length === 0) {
        removeBtn.textContent = error ? 'Failed' : 'Permission denied';
        removeBtn.disabled = true;
        logger.error('Admin', 'question remove affected zero rows', { id: qId, error });
        return;
      }
      await supabase.from('question_feedback').delete().eq('question_id', qId).eq('feedback_type', 'flag');
      removeBtn.closest('.admin-flag-row').remove();
    }
  };
}

// ============================================
// RECENT GAMES
// ============================================

let _gamesOffset = 0;

async function loadRecentGames() {
  _gamesOffset = 0;
  const games = await fetchRecentGames(0);
  renderGames(games);
}

async function fetchRecentGames(offset) {
  const { data, error } = await supabase
    .from('game_plays')
    .select('*')
    .order('started_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) { logger.error('Admin', 'fetchRecentGames failed', error); return []; }
  return data || [];
}

function renderGames(games) {
  const container = $('#recent-games');
  container.innerHTML = '';
  appendGames(games);
  $('#btn-load-more-games').style.display = games.length >= PAGE_SIZE ? '' : 'none';
}

function appendGames(games) {
  const container = $('#recent-games');
  if (games.length === 0 && container.children.length === 0) {
    container.innerHTML = '<p style="color:var(--color-text-muted); font-size:var(--text-sm);">No games recorded.</p>';
    return;
  }
  for (const g of games) {
    const started = g.started_at ? new Date(g.started_at).toLocaleString() : '?';
    const duration = g.started_at && g.completed_at
      ? Math.round((new Date(g.completed_at) - new Date(g.started_at)) / 60000) + ' min'
      : g.completed ? 'done' : 'in progress';
    const status = g.completed ? 'completed' : 'active';
    const score = g.final_score != null ? `${g.final_score} pts` : '—';
    const progress = `${g.questions_answered || 0}/${g.total_questions || '?'}`;
    const row = document.createElement('div');
    row.className = 'admin-q-row';
    row.innerHTML = `
      <div class="admin-q-row__summary">
        <div class="admin-q-row__text">${escapeText(g.player_name || '?')} — ${escapeText(g.category || '?')}</div>
        <div class="admin-q-row__meta">
          <span>${progress} Qs</span>
          <span>${score}</span>
          <span>${duration}</span>
          <span class="admin-game-status--${status}">${status}</span>
          <span>${started}</span>
        </div>
      </div>
    `;
    container.appendChild(row);
  }
}

// ============================================
// CHAT ARCHIVE
// ============================================

let _chatOffset = 0;

async function loadChatArchive() {
  _chatOffset = 0;
  const chats = await fetchChatArchive(0);
  renderChatArchive(chats);
}

async function fetchChatArchive(offset) {
  const { data, error } = await supabase
    .from('chat_archive')
    .select('*')
    .order('archived_at', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);
  if (error) { logger.error('Admin', 'fetchChatArchive failed', error); return []; }
  return data || [];
}

function renderChatArchive(chats) {
  const container = $('#chat-archive');
  container.innerHTML = '';
  appendChatArchive(chats);
  $('#btn-load-more-chats').style.display = chats.length >= PAGE_SIZE ? '' : 'none';
}

function appendChatArchive(chats) {
  const container = $('#chat-archive');
  if (chats.length === 0 && container.children.length === 0) {
    container.innerHTML = '<p style="color:var(--color-text-muted); font-size:var(--text-sm);">No archived chats.</p>';
    return;
  }
  for (const c of chats) {
    const date = c.archived_at ? new Date(c.archived_at).toLocaleString() : '?';
    const messages = Array.isArray(c.messages) ? c.messages : [];
    const row = document.createElement('div');
    row.className = 'admin-q-row';
    const metaParts = [];
    if (c.host_name) metaParts.push(escapeText(c.host_name));
    if (c.player_count) metaParts.push(`${c.player_count} players`);
    metaParts.push(`${messages.length} msgs`);
    metaParts.push(date);
    row.innerHTML = `
      <div class="admin-q-row__summary admin-chat-summary">
        <div class="admin-q-row__text">${escapeText(c.room_code || '?')} — ${escapeText(c.category || '?')}</div>
        <div class="admin-q-row__meta">${metaParts.map(p => `<span>${p}</span>`).join('')}</div>
      </div>
      <div class="admin-q-row__edit admin-chat-messages" style="display:none;">
        ${messages.length === 0
          ? '<p style="color:var(--color-text-muted); font-size:var(--text-xs);">No messages.</p>'
          : messages.map(m => `<div class="admin-chat-msg">
              <span class="admin-chat-msg__name">${escapeText(m.player_name || m.sender_name || m.name || '?')}</span>
              <span class="admin-chat-msg__text">${escapeText(m.message || m.content || m.text || '')}</span>
              <span class="admin-chat-msg__time">${m.timestamp ? new Date(m.timestamp).toLocaleTimeString() : ''}</span>
            </div>`).join('')}
      </div>
    `;
    // Toggle messages on click
    row.querySelector('.admin-chat-summary').onclick = () => {
      const msgs = row.querySelector('.admin-chat-messages');
      msgs.style.display = msgs.style.display === 'none' ? '' : 'none';
    };
    container.appendChild(row);
  }
}

// ============================================
// ERROR LOGS
// ============================================

let _errorOffset = 0;

async function loadErrorLogs() {
  _errorOffset = 0;
  const logs = await fetchErrorLogs(0);
  renderErrorLogs(logs);
}

async function fetchErrorLogs(offset) {
  let query = supabase
    .from('error_logs')
    .select('*')
    .order('timestamp', { ascending: false })
    .range(offset, offset + PAGE_SIZE - 1);

  const severity = $('#error-severity')?.value;
  if (severity) query = query.eq('type', severity);

  const { data, error } = await query;
  if (error) { logger.error('Admin', 'fetchErrorLogs failed', error); return []; }
  return data || [];
}

function renderErrorLogs(logs) {
  const container = $('#error-logs');
  container.innerHTML = '';
  appendErrorLogs(logs);
  $('#btn-load-more-errors').style.display = logs.length >= PAGE_SIZE ? '' : 'none';
}

function appendErrorLogs(logs) {
  const container = $('#error-logs');
  if (logs.length === 0 && container.children.length === 0) {
    container.innerHTML = '<p style="color:var(--color-text-muted); font-size:var(--text-sm);">No error logs.</p>';
    return;
  }
  for (const log of logs) {
    const time = log.timestamp ? new Date(log.timestamp).toLocaleString() : '?';
    const msg = log.message || '';
    const truncated = msg.length > 100 ? msg.slice(0, 100) + '\u2026' : msg;
    const row = document.createElement('div');
    row.className = 'admin-q-row';
    row.innerHTML = `
      <div class="admin-q-row__summary">
        <div class="admin-q-row__text">${escapeText(truncated)}</div>
        <div class="admin-q-row__meta">
          <span class="admin-error-badge admin-error-badge--${escapeText(log.type || 'error')}">${escapeText(log.type || 'error')}</span>
          <span>${time}</span>
          <span>${escapeText(log.source || '')}</span>
          ${log.lineno ? `<span>L${log.lineno}${log.colno ? ':' + log.colno : ''}</span>` : ''}
        </div>
      </div>
      <div class="admin-q-row__edit" style="display:none;">
        <pre class="admin-error-detail">${escapeText(msg)}</pre>
        ${log.stack ? `<pre class="admin-error-detail admin-error-stack">${escapeText(log.stack)}</pre>` : ''}
        ${log.url ? `<p class="admin-error-ua">Page: ${escapeText(log.url)}</p>` : ''}
        ${log.user_agent ? `<p class="admin-error-ua">UA: ${escapeText(log.user_agent)}</p>` : ''}
      </div>
    `;
    row.querySelector('.admin-q-row__summary').onclick = () => {
      const detail = row.querySelector('.admin-q-row__edit');
      detail.style.display = detail.style.display === 'none' ? '' : 'none';
    };
    container.appendChild(row);
  }
}

// ============================================
// QUESTION MANAGEMENT
// ============================================

let _questionOffset = 0;
const PAGE_SIZE = ADMIN_PAGE_SIZE;

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

  // Live column is `question`. Searching `question_text` errored out and
  // returned nothing, so admin search never found anything.
  if (search) query = query.ilike('question', `%${search}%`);
  if (category) query = query.contains('categories', [category]);
  if (format) query = query.eq('format', format);

  query = query.order('id', { ascending: false }).range(offset, offset + PAGE_SIZE - 1);

  const { data, error } = await query;
  if (error) { logger.error('Admin', 'fetchQuestions failed', error); return []; }
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

    // .select() so we can count what was actually written. An RLS refusal
    // updates zero rows and returns NO error, so checking `error` alone
    // reported "Saved!" while saving nothing.
    const { data: saved, error } = await supabase
      .from('questions').update(updates).eq('id', q.id).select();

    if (error) {
      statusEl.textContent = `Error: ${error.message}`;
      return;
    }
    if (!saved || saved.length === 0) {
      statusEl.textContent = 'Not saved — permission denied. Are you signed in as an admin?';
      logger.error('Admin', 'question update affected zero rows (RLS)', { id: q.id });
      return;
    }
    statusEl.textContent = 'Saved!';
    {
      // Update the summary text
      row.querySelector('.admin-q-row__text').textContent = newText.length > 80 ? newText.slice(0, 80) + '\u2026' : newText;
      setTimeout(() => { statusEl.textContent = ''; }, ADMIN_STATUS_FADE_MS);
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

  // Recent games
  $('#btn-load-more-games').onclick = async () => {
    _gamesOffset += PAGE_SIZE;
    const games = await fetchRecentGames(_gamesOffset);
    appendGames(games);
    $('#btn-load-more-games').style.display = games.length >= PAGE_SIZE ? '' : 'none';
  };

  // Chat archive
  $('#btn-load-more-chats').onclick = async () => {
    _chatOffset += PAGE_SIZE;
    const chats = await fetchChatArchive(_chatOffset);
    appendChatArchive(chats);
    $('#btn-load-more-chats').style.display = chats.length >= PAGE_SIZE ? '' : 'none';
  };

  // Error logs
  $('#error-severity').onchange = loadErrorLogs;
  $('#btn-load-more-errors').onclick = async () => {
    _errorOffset += PAGE_SIZE;
    const logs = await fetchErrorLogs(_errorOffset);
    appendErrorLogs(logs);
    $('#btn-load-more-errors').style.display = logs.length >= PAGE_SIZE ? '' : 'none';
  };
  $('#btn-clear-old-errors').onclick = async () => {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await supabase.from('error_logs').delete().lt('timestamp', cutoff);
    loadErrorLogs();
  };
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

// ============================================
// QUESTION HEALTH
//
// Reads the question_health view (migration 025): per-question performance
// joined with feedback tallies.
//
// The default sort is "most overridden" on purpose. A host flipping a
// judgement is a human stating that a valid answer was rejected, which is the
// most reliable evidence that acceptable_answers is incomplete — more reliable
// than flags, because it needs no player to bother reporting anything.
// ============================================

const QH_PAGE_SIZE = 25;
let _qhOffset = 0;
let _qhSort = 'overrides';
let _qhDir = 'desc';
let _qhSearch = '';

// Neutral field names; direction is chosen separately by the user.
const QH_SORTS = {
  overrides:   'times_overridden',
  correct:     'pct_correct',
  flags:       'flags',
  thumbs_down: 'thumbs_down',
  thumbs_up:   'thumbs_up',
  asked:       'times_asked',
};

async function fetchQuestionHealth(offset) {
  const column = QH_SORTS[_qhSort] || QH_SORTS.overrides;
  const ascending = _qhDir === 'asc';
  let query = supabase.from('question_health').select('*');

  if (_qhSearch) query = query.ilike('question', `%${_qhSearch}%`);

  // Percentages and averages only mean anything once a question has been
  // played; unplayed rows are NULL and would otherwise dominate the page.
  if (_qhSort === 'correct') query = query.gt('times_asked', 0);

  query = query
    .order(column, { ascending, nullsFirst: false })
    .range(offset, offset + QH_PAGE_SIZE - 1);

  const { data, error } = await query;
  if (error) {
    logger.error('Admin', 'fetchQuestionHealth failed', error);
    const list = $('#qh-list');
    if (list) {
      const missingView = /question_health/i.test(error.message || '');
      list.innerHTML = `<p style="color:var(--color-error, #c33); font-size:var(--text-sm);">
        Couldn't load: ${escapeText(error.message)}${missingView
          ? '<br><span style="color:var(--color-text-muted);">The question_health view is missing — run the view section of migration 025.</span>'
          : ''}
      </p>`;
    }
    return null;
  }
  return data || [];
}

function qhStat(label, value, tone) {
  const color = tone === 'bad'  ? 'var(--color-error, #c33)'
              : tone === 'good' ? 'var(--color-success, #2a7)'
              : 'var(--color-text-muted)';
  return `<span style="font-size:var(--text-xs); color:${color}; margin-right:var(--space-sm);">
            ${escapeText(label)} <strong>${escapeText(String(value))}</strong>
          </span>`;
}

function createHealthRow(q) {
  const row = document.createElement('div');
  row.className = 'admin-flag-row';
  row.style.cssText = 'padding:var(--space-sm) 0; border-bottom:1px solid var(--color-border);';

  const pct = q.pct_correct == null ? '—' : `${q.pct_correct}%`;
  const pctTone = q.pct_correct == null ? null : (q.pct_correct < 25 ? 'bad' : q.pct_correct > 75 ? 'good' : null);
  const alts = Array.isArray(q.acceptable_answers) ? q.acceptable_answers : [];

  row.innerHTML = `
    <div class="admin-q-row__text" style="font-weight:500; margin-bottom:4px; cursor:pointer;">
      ${escapeText(q.question || '(no text)')}
    </div>
    <div style="margin-bottom:6px;">
      <span style="font-size:var(--text-xs); color:var(--color-text-muted);">
        Answer: <strong>${escapeText(q.correct_answer || '?')}</strong>
      </span>
    </div>
    <div>
      ${qhStat('played', q.times_asked)}
      ${qhStat('correct', pct, pctTone)}
      ${qhStat('overrides', q.times_overridden, q.times_overridden > 0 ? 'bad' : null)}
      ${qhStat('flags', q.flags, q.flags > 0 ? 'bad' : null)}
      ${qhStat('👍', q.thumbs_up, q.thumbs_up > 0 ? 'good' : null)}
      ${qhStat('👎', q.thumbs_down, q.thumbs_down > 0 ? 'bad' : null)}
    </div>
    <div class="qh-edit" style="display:none; margin-top:var(--space-sm);">
      <label style="display:block; font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:4px;">
        Also accept these answers (one per line)
      </label>
      <textarea class="input qh-alts" rows="3"
        placeholder="JFK&#10;Kennedy">${escapeText(alts.join('\n'))}</textarea>
      <div style="display:flex; gap:var(--space-xs); align-items:center; margin-top:var(--space-xs);">
        <button class="btn btn-primary qh-save">Save</button>
        <span class="qh-status" style="font-size:var(--text-xs);"></span>
      </div>
    </div>
  `;

  row.querySelector('.admin-q-row__text').onclick = () => {
    const edit = row.querySelector('.qh-edit');
    edit.style.display = edit.style.display === 'none' ? '' : 'none';
  };

  row.querySelector('.qh-save').onclick = async () => {
    const statusEl = row.querySelector('.qh-status');
    statusEl.textContent = 'Saving...';
    const newAlts = row.querySelector('.qh-alts').value
      .split('\n').map(s => s.trim()).filter(Boolean);

    // .select() so a silent RLS refusal (zero rows, no error) is caught rather
    // than reported as success.
    const { data: saved, error } = await supabase
      .from('questions')
      .update({ acceptable_answers: newAlts })
      .eq('id', q.id)
      .select();

    if (error) { statusEl.textContent = `Error: ${error.message}`; return; }
    if (!saved || saved.length === 0) {
      statusEl.textContent = 'Not saved — permission denied. Signed in as an admin?';
      logger.error('Admin', 'alternates update affected zero rows (RLS)', { id: q.id });
      return;
    }
    statusEl.textContent = `Saved — ${newAlts.length} alternate${newAlts.length === 1 ? '' : 's'}`;
    setTimeout(() => { statusEl.textContent = ''; }, ADMIN_STATUS_FADE_MS);
  };

  return row;
}

async function loadQuestionHealth() {
  _qhOffset = 0;
  const list = $('#qh-list');
  if (!list) return;
  list.innerHTML = '<p style="color:var(--color-text-muted); font-size:var(--text-sm);">Loading...</p>';

  const rows = await fetchQuestionHealth(0);
  if (rows === null) return;           // error already rendered

  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<p style="color:var(--color-text-muted); font-size:var(--text-sm);">No questions match.</p>';
  }
  for (const q of rows) list.appendChild(createHealthRow(q));

  const summary = $('#qh-summary');
  if (summary) {
    const played = rows.filter(r => r.times_asked > 0).length;
    summary.textContent = played === 0
      ? 'No play data yet — stats appear once games are played.'
      : `${played} of ${rows.length} shown have been played.`;
  }

  const more = $('#qh-load-more');
  if (more) more.style.display = rows.length >= QH_PAGE_SIZE ? '' : 'none';
}

async function loadMoreQuestionHealth() {
  _qhOffset += QH_PAGE_SIZE;
  const rows = await fetchQuestionHealth(_qhOffset);
  if (!rows) return;
  const list = $('#qh-list');
  for (const q of rows) list.appendChild(createHealthRow(q));
  const more = $('#qh-load-more');
  if (more) more.style.display = rows.length >= QH_PAGE_SIZE ? '' : 'none';
}

function attachQuestionHealthListeners() {
  const sortEl = $('#qh-sort');
  if (sortEl) sortEl.onchange = () => { _qhSort = sortEl.value; loadQuestionHealth(); };

  const dirEl = $('#qh-dir');
  if (dirEl) dirEl.onchange = () => { _qhDir = dirEl.value; loadQuestionHealth(); };

  const searchEl = $('#qh-search');
  if (searchEl) {
    let t = null;
    searchEl.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => { _qhSearch = searchEl.value.trim(); loadQuestionHealth(); }, 300);
    };
  }

  const more = $('#qh-load-more');
  if (more) more.onclick = loadMoreQuestionHealth;
}
