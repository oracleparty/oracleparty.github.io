// ============================================
// Oracle Party — Admin Dashboard
// Unlisted page, gated by is_admin on profiles.
// ============================================

import { $, escapeHtml } from './utils.js';
import { logger } from './logger.js';
import { supabase, fetchSiteSettings, upsertSiteSetting, deleteSiteSetting, fetchAnswerTally } from './supabase.js';
import { ensureDisplayName, initAuth, getCurrentUser } from './auth.js';
import { ADMIN_PAGE_SIZE, ADMIN_STATUS_FADE_MS, STALE_TIMEOUT_MS } from './constants.js';

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


// Show a status message that clears itself, cancelling any pending clear first.
//
// Both callers used a bare setTimeout, so the timer from an EARLIER save wiped
// the message from a LATER one: save something successfully, edit again within
// two seconds, and "Not saved — permission denied" vanished half a second after
// appearing. The one message an admin most needs to see was the one most likely
// to be erased, because it only appears on a second attempt.
const _statusTimers = new WeakMap();
function setStatus(el, text, { sticky = false } = {}) {
  if (!el) return;
  clearTimeout(_statusTimers.get(el));
  _statusTimers.delete(el);
  el.textContent = text;
  if (!sticky && text) {
    _statusTimers.set(el, setTimeout(() => {
      el.textContent = '';
      _statusTimers.delete(el);
    }, ADMIN_STATUS_FADE_MS));
  }
}

// ============================================
// DASHBOARD STATS
// ============================================

async function loadDashboardStats() {
  // Players online.
  //
  // This counted EVERY row in `players`, with no filter at all, despite the
  // comment claiming it counted active rooms. Player rows outlive their games —
  // a tab closed without a clean exit leaves one behind, and cleanup only runs
  // when somebody happens to open the home page — so the number drifted upward
  // forever and bore no relation to who was actually playing.
  //
  // Online now means: in a room that still exists, and seen within the same
  // window the game itself uses to decide someone has gone.
  const seenSince = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();
  const { data: liveRooms, error: roomsErr } = await supabase
    .from('rooms')
    .select('id, status')
    .in('status', ['lobby', 'playing']);

  if (roomsErr) {
    logger.error('Admin', 'loadDashboardStats rooms query failed', roomsErr);
    $('#stat-online').textContent = '?';
    $('#stat-games').textContent = '?';
  } else {
    const roomIds = (liveRooms || []).map(r => r.id);
    if (roomIds.length === 0) {
      $('#stat-online').textContent = '0';
    } else {
      const { count: onlineCount, error: onlineErr } = await supabase
        .from('players')
        .select('id', { count: 'exact', head: true })
        .in('room_id', roomIds)
        .gt('last_seen_at', seenSince);
      if (onlineErr) logger.error('Admin', 'loadDashboardStats players query failed', onlineErr);
      $('#stat-online').textContent = onlineErr ? '?' : (onlineCount ?? 0);
    }
    // Counted from the same snapshot, so the two numbers always agree.
    $('#stat-games').textContent = (liveRooms || []).filter(r => r.status === 'playing').length;
  }

  // Total accounts, excluding ones that were deleted.
  const { count: accountCount, error: accErr } = await supabase
    .from('profiles')
    .select('user_id', { count: 'exact', head: true })
    .is('deleted_at', null);
  if (accErr) logger.error('Admin', 'loadDashboardStats profiles query failed', accErr);
  $('#stat-accounts').textContent = accErr ? '?' : (accountCount ?? '-');

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
// STAT DRILL-DOWNS
//
// Each of the four numbers at the top opens the list it was counted from.
// Before this they were the only figures on the page that could not be
// checked — and this project has learned repeatedly that an unverifiable
// number is one you end up believing when it is wrong.
//
// Every loader reports its own failure into the panel rather than rendering
// an empty list. An empty list and a refused query look identical, and
// treating the second as the first is the failure mode in CLAUDE.md #4.
// ============================================

const DRILL_TITLES = {
  online: 'Players Online',
  games: 'Games Active',
  accounts: 'Accounts',
  today: 'Games Today',
};

let _openDrill = null;

function drillError(err, what) {
  return `<p class="stat-drill__error">Couldn't load ${escapeHtml(what)}: ${escapeHtml(err.message || String(err))}</p>`;
}

function drillEmpty(text) {
  return `<p class="stat-drill__empty">${escapeHtml(text)}</p>`;
}

const when = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

async function drillOnline() {
  const seenSince = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();
  const { data: rooms, error: roomsErr } = await supabase
    .from('rooms').select('id, code, category').in('status', ['lobby', 'playing']);
  if (roomsErr) return drillError(roomsErr, 'rooms');
  if (!rooms || rooms.length === 0) return drillEmpty('No live rooms.');

  const { data: players, error } = await supabase
    .from('players')
    .select('id, display_name, room_id, last_seen_at, is_bot')
    .in('room_id', rooms.map(r => r.id))
    .gt('last_seen_at', seenSince);
  if (error) return drillError(error, 'players');
  if (!players || players.length === 0) return drillEmpty('Nobody online right now.');

  const byRoom = new Map(rooms.map(r => [String(r.id), r]));
  return players.map(p => {
    const room = byRoom.get(String(p.room_id));
    return `<div class="stat-drill__row">
      <span class="stat-drill__name">${escapeHtml(p.display_name || '(no name)')}${p.is_bot ? ' <span class="badge badge--bot">Bot</span>' : ''}</span>
      <span class="stat-drill__meta">${escapeHtml(room?.code || '?')} · ${escapeHtml(room?.category || '?')}</span>
    </div>`;
  }).join('');
}

async function drillGames() {
  const { data: rooms, error } = await supabase
    .from('rooms')
    .select('id, code, category, subcategory, host_name, status, created_at')
    .eq('status', 'playing')
    .order('created_at', { ascending: false });
  if (error) return drillError(error, 'rooms');
  if (!rooms || rooms.length === 0) return drillEmpty('No games in progress.');

  return rooms.map(r => `<div class="stat-drill__row">
      <span class="stat-drill__name">${escapeHtml(r.code || '?')}</span>
      <span class="stat-drill__meta">${escapeHtml(r.category || '?')}${r.subcategory ? ' · ' + escapeHtml(r.subcategory) : ''} · host ${escapeHtml(r.host_name || '?')} · ${escapeHtml(when(r.created_at))}</span>
      <button class="btn-danger stat-drill__action" data-end-room="${escapeHtml(String(r.id))}" data-room-code="${escapeHtml(r.code || '')}">End</button>
    </div>`).join('');
}

async function drillAccounts() {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, display_name, discriminator, is_admin, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return drillError(error, 'accounts');
  if (!data || data.length === 0) return drillEmpty('No accounts yet.');

  const me = getCurrentUser()?.user?.id;
  return data.map(p => {
    const isMe = String(p.user_id) === String(me);
    // No delete button on yourself or on another admin. The database refuses
    // both anyway (migration 037) — this stops the tap rather than explaining
    // the refusal afterwards.
    const action = (isMe || p.is_admin)
      ? `<span class="stat-drill__meta">${isMe ? 'you' : 'admin'}</span>`
      : `<button class="btn-danger stat-drill__action" data-del-account="${escapeHtml(String(p.user_id))}" data-del-name="${escapeHtml(p.display_name || '')}">Delete</button>`;
    return `<div class="stat-drill__row">
      <span class="stat-drill__name">${escapeHtml(p.display_name || '(no name)')}<span class="stat-drill__tag">#${escapeHtml(p.discriminator || '----')}</span></span>
      <span class="stat-drill__meta">${escapeHtml(when(p.created_at))}</span>
      ${action}
    </div>`;
  }).join('');
}

async function drillToday() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from('game_history')
    .select('id, user_id, category, subcategory, score, placement, total_players, played_at')
    .gte('played_at', todayStart.toISOString())
    .order('played_at', { ascending: false });
  if (error) return drillError(error, "today's games");
  if (!data || data.length === 0) return drillEmpty('No games played today.');

  // game_history stores a user id, not a name. Resolve them in one query
  // rather than one per row.
  const ids = [...new Set(data.map(g => g.user_id).filter(Boolean))];
  const names = new Map();
  if (ids.length) {
    const { data: profs } = await supabase
      .from('profiles').select('user_id, display_name').in('user_id', ids);
    for (const p of profs || []) names.set(String(p.user_id), p.display_name);
  }

  return data.map(g => `<div class="stat-drill__row">
      <span class="stat-drill__name">${escapeHtml(names.get(String(g.user_id)) || '(deleted account)')}</span>
      <span class="stat-drill__meta">${escapeHtml(g.category || '?')} · ${g.score ?? 0} pts · ${g.placement ?? '?'}/${g.total_players ?? '?'} · ${escapeHtml(when(g.played_at))}</span>
    </div>`).join('');
}

const DRILL_LOADERS = {
  online: drillOnline, games: drillGames, accounts: drillAccounts, today: drillToday,
};

async function openDrill(which) {
  const panel = $('#stat-drill');
  const body = $('#stat-drill-body');
  const title = $('#stat-drill-title');
  if (!panel || !body || !title) return;

  // Tapping the open one closes it.
  if (_openDrill === which) return closeDrill();

  _openDrill = which;
  title.textContent = DRILL_TITLES[which] || '';
  body.innerHTML = '<p class="stat-drill__empty">Loading...</p>';
  panel.classList.remove('hidden');
  document.querySelectorAll('[data-drill]').forEach(b => {
    b.setAttribute('aria-expanded', b.dataset.drill === which ? 'true' : 'false');
    b.classList.toggle('admin-stat-card--open', b.dataset.drill === which);
  });

  try {
    const html = await DRILL_LOADERS[which]();
    // A second tap may have changed which panel is open while this was
    // loading. Dropping a stale result is the difference between a slow
    // panel and one showing the wrong list.
    if (_openDrill !== which) return;
    body.innerHTML = html;
  } catch (err) {
    if (_openDrill !== which) return;
    body.innerHTML = drillError(err, DRILL_TITLES[which] || 'that');
  }
}

function closeDrill() {
  _openDrill = null;
  const panel = $('#stat-drill');
  if (panel) panel.classList.add('hidden');
  document.querySelectorAll('[data-drill]').forEach(b => {
    b.setAttribute('aria-expanded', 'false');
    b.classList.remove('admin-stat-card--open');
  });
}

// Tap-again-to-confirm for the two destructive actions. Both are recoverable
// in the sense that nothing is lost by NOT doing them, so the lighter
// confirmation used elsewhere in this app is proportionate — unlike deleting
// your own account, which types the word out.
let _armed = null;
let _armedTimer = null;

function arm(btn, label) {
  clearTimeout(_armedTimer);
  if (_armed && _armed !== btn) _armed.textContent = _armed.dataset.idle;
  btn.dataset.idle = btn.dataset.idle || btn.textContent;
  btn.textContent = label;
  _armed = btn;
  _armedTimer = setTimeout(() => {
    if (_armed === btn) { btn.textContent = btn.dataset.idle; _armed = null; }
  }, 4000);
}

function disarm() {
  clearTimeout(_armedTimer);
  if (_armed) _armed.textContent = _armed.dataset.idle;
  _armed = null;
}

async function handleDrillClick(e) {
  const endBtn = e.target.closest('[data-end-room]');
  if (endBtn) {
    if (_armed !== endBtn) return arm(endBtn, 'Really end?');
    disarm();
    endBtn.disabled = true;
    const { error } = await supabase.from('rooms').delete().eq('id', endBtn.dataset.endRoom);
    if (error) {
      endBtn.disabled = false;
      endBtn.textContent = 'Failed';
      logger.error('Admin', 'end room failed', error);
      return;
    }
    await loadDashboardStats();
    openDrill('games');
    return;
  }

  const delBtn = e.target.closest('[data-del-account]');
  if (delBtn) {
    if (_armed !== delBtn) return arm(delBtn, 'Really delete?');
    disarm();
    delBtn.disabled = true;
    const { error } = await supabase.rpc('admin_delete_account', { p_user_id: delBtn.dataset.delAccount });
    if (error) {
      // The function raises a named exception for every refusal — not an
      // admin, deleting yourself, deleting another admin — so show what it
      // said rather than a generic failure.
      delBtn.disabled = false;
      delBtn.textContent = 'Failed';
      const body = $('#stat-drill-body');
      if (body) body.insertAdjacentHTML('afterbegin', drillError(error, 'the delete'));
      logger.error('Admin', 'admin_delete_account failed', error);
      return;
    }
    await loadDashboardStats();
    openDrill('accounts');
  }
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

  // A failed query and an empty queue used to render the same reassuring
  // sentence, so "No flagged questions." could mean the flags were unreachable.
  // On a page whose whole job is surfacing player reports, that is the worst
  // possible thing to be vague about.
  if (error) {
    logger.error('Admin', 'loadFlaggedQueue failed', error);
    container.innerHTML = `<p style="color:var(--color-danger); font-size:var(--text-sm);">Couldn't load flags: ${escapeHtml(error.message || String(error))}</p>`;
    return;
  }
  if (!flags || flags.length === 0) {
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
    setStatus(statusEl, 'Saving...', { sticky: true });

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

    // Failures stay on screen; only success fades.
    if (error) {
      setStatus(statusEl, `Error: ${error.message}`, { sticky: true });
      return;
    }
    if (!saved || saved.length === 0) {
      setStatus(statusEl, 'Not saved — permission denied. Are you signed in as an admin?', { sticky: true });
      logger.error('Admin', 'question update affected zero rows (RLS)', { id: q.id });
      return;
    }
    // Update the summary text
    row.querySelector('.admin-q-row__text').textContent = newText.length > 80 ? newText.slice(0, 80) + '\u2026' : newText;
    setStatus(statusEl, 'Saved!');
  };

  return row;
}

// ============================================
// EVENT LISTENERS
// ============================================

function attachListeners() {
  // Stat drill-downs
  document.querySelectorAll('[data-drill]').forEach(btn => {
    btn.onclick = () => openDrill(btn.dataset.drill);
  });
  const drillClose = $('#stat-drill-close');
  if (drillClose) drillClose.onclick = closeDrill;
  const drillBody = $('#stat-drill-body');
  if (drillBody) drillBody.addEventListener('click', handleDrillClick);

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
// Minimum plays/votes before a percentage is trustworthy enough to rank by.
const QH_MIN_SAMPLE = 3;
let _qhOffset = 0;
// Flags first. Overrides are the better long-term evidence that an answer key
// is wrong — a host flipping a judgement is a human saying so, and it costs the
// player nothing — but question_stats only started filling recently, so ordering
// by overrides meant every question tied at zero and the page showed 25
// arbitrary ones. Real flags sat invisible behind 4,859 ties. Flags are the
// signal that exists today; switch the control to overrides once it has data.
let _qhSort = 'flags';
let _qhDir = 'desc';
let _qhSearch = '';

// Neutral field names; direction is chosen separately by the user.
const QH_SORTS = {
  overrides:   'times_overridden',
  correct:     'pct_correct',
  flags:       'flags',
  liked:       'pct_liked',
  asked:       'times_asked',
};

async function fetchQuestionHealth(offset) {
  const column = QH_SORTS[_qhSort] || QH_SORTS.overrides;
  const ascending = _qhDir === 'asc';
  let query = supabase.from('question_health').select('*');

  if (_qhSearch) query = query.ilike('question', `%${_qhSearch}%`);

  // A percentage from one or two data points is noise: a single thumbs-up is
  // 100% liked and would outrank 47 likes against 3 dislikes. Ranking by a
  // percentage therefore requires a minimum sample; the raw count is always
  // displayed alongside so the number can be judged in context.
  if (_qhSort === 'correct') query = query.gte('times_asked', QH_MIN_SAMPLE);
  if (_qhSort === 'liked')   query = query.gte('total_votes', QH_MIN_SAMPLE);

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

/**
 * Show every answer people have given to this question, most common first.
 *
 * Fetched when the row is opened rather than with the list: 25 questions each
 * pulling their own tally would be 25 extra queries to render a page where
 * most rows are never expanded.
 *
 * A bar behind each row makes it scannable. A real chart would not say
 * anything the sorted list does not.
 */
async function renderAnswerTally(row, q) {
  const box = row.querySelector('.qh-tally');
  if (!box || box.dataset.loaded === q.id) return;
  box.dataset.loaded = q.id;
  box.innerHTML = '<p style="font-size:var(--text-xs); color:var(--color-text-muted);">Loading answers…</p>';

  const rows = await fetchAnswerTally(q.id);
  if (rows.length === 0) {
    box.innerHTML = '<p style="font-size:var(--text-xs); color:var(--color-text-muted);">'
      + 'Nobody has answered this yet.</p>';
    return;
  }

  // Everything already accepted, so a row can say whether adding it would
  // change anything. Compared case-insensitively, the same way the tally
  // counts.
  const accepted = new Set(
    [q.correct_answer, ...(Array.isArray(q.acceptable_answers) ? q.acceptable_answers : [])]
      .filter(Boolean).map(a => String(a).trim().toLowerCase())
  );

  const max = Math.max(...rows.map(r => r.times_given));
  const total = rows.reduce((n, r) => n + r.times_given, 0);

  box.innerHTML = `
    <div style="font-size:var(--text-xs); color:var(--color-text-muted); margin-bottom:4px;">
      What people typed — ${total} answer${total === 1 ? '' : 's'} recorded
    </div>
    ${rows.map(r => {
      const known = accepted.has(String(r.answer_shown).trim().toLowerCase());
      const pct = Math.round((r.times_given / max) * 100);
      return `
        <div style="position:relative; padding:3px 6px; margin-bottom:2px; font-size:var(--text-xs);">
          <div style="position:absolute; inset:0; width:${pct}%;
                      background:${known ? 'var(--color-success)' : 'var(--color-primary)'};
                      opacity:0.14; border-radius:3px;"></div>
          <div style="position:relative; display:flex; justify-content:space-between; gap:var(--space-sm);">
            <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">
              ${escapeHtml(r.answer_shown)}${known ? ' <span style="opacity:.6">(accepted)</span>' : ''}
            </span>
            <strong style="flex:0 0 auto;">${r.times_given}</strong>
          </div>
        </div>`;
    }).join('')}
    <p style="font-size:var(--text-xs); color:var(--color-text-muted); margin-top:4px;">
      Answers with no "(accepted)" mark are ones the game counts as wrong.
    </p>
  `;
}

function createHealthRow(q) {
  const row = document.createElement('div');
  row.className = 'admin-flag-row';
  row.style.cssText = 'padding:var(--space-sm) 0; border-bottom:1px solid var(--color-border);';

  const pct = q.pct_correct == null ? '—' : `${q.pct_correct}% (${q.times_asked})`;
  const pctTone = q.pct_correct == null ? null : (q.pct_correct < 25 ? 'bad' : q.pct_correct > 75 ? 'good' : null);
  const alts = Array.isArray(q.acceptable_answers) ? q.acceptable_answers : [];

  // Show the vote count with the percentage — 100% from one vote and 94% from
  // fifty are not the same claim, and the number alone cannot say which it is.
  const votes = (q.total_votes ?? ((q.thumbs_up || 0) + (q.thumbs_down || 0)));
  const likedLabel = votes === 0 ? '—' : `${q.pct_liked}% (${votes})`;
  const likedTone = votes === 0 ? null
                  : q.pct_liked < 50 ? 'bad'
                  : q.pct_liked >= 80 ? 'good' : null;

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
      ${qhStat('liked', likedLabel, likedTone)}
    </div>
    <div class="qh-edit" style="display:none; margin-top:var(--space-sm);">
      <!-- What people actually typed, shown right where an acceptable answer
           gets added. The whole value is seeing "JFK x11" and adding it in the
           same place, rather than reading the data somewhere else and acting
           on it here. -->
      <div class="qh-tally" style="margin-bottom:var(--space-sm);"></div>
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

  row.querySelector('.admin-q-row__text').onclick = async () => {
    const edit = row.querySelector('.qh-edit');
    const opening = edit.style.display === 'none';
    edit.style.display = opening ? '' : 'none';
    if (opening) await renderAnswerTally(row, q);
  };

  row.querySelector('.qh-save').onclick = async () => {
    const statusEl = row.querySelector('.qh-status');
    setStatus(statusEl, 'Saving...', { sticky: true });
    const newAlts = row.querySelector('.qh-alts').value
      .split('\n').map(s => s.trim()).filter(Boolean);

    // .select() so a silent RLS refusal (zero rows, no error) is caught rather
    // than reported as success.
    const { data: saved, error } = await supabase
      .from('questions')
      .update({ acceptable_answers: newAlts })
      .eq('id', q.id)
      .select();

    // Failures stay on screen. A message the admin has to catch within two
    // seconds is a message they will miss, and this one tells them their edit
    // did not happen.
    if (error) { setStatus(statusEl, `Error: ${error.message}`, { sticky: true }); return; }
    if (!saved || saved.length === 0) {
      setStatus(statusEl, 'Not saved — permission denied. Signed in as an admin?', { sticky: true });
      logger.error('Admin', 'alternates update affected zero rows (RLS)', { id: q.id });
      return;
    }
    setStatus(statusEl, `Saved — ${newAlts.length} alternate${newAlts.length === 1 ? '' : 's'}`);
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
    const parts = [];

    // State the minimum out loud. A hidden threshold silently drops rows and
    // is impossible to question later without reading the source.
    if (_qhSort === 'correct') {
      parts.push(`Showing questions played at least ${QH_MIN_SAMPLE}× (percentages below that are noise).`);
    } else if (_qhSort === 'liked') {
      parts.push(`Showing questions with at least ${QH_MIN_SAMPLE} votes (percentages below that are noise).`);
    }

    parts.push(played === 0
      ? 'No play data yet — stats appear once games are played.'
      : `${played} of ${rows.length} shown have been played.`);

    // Say when the chosen ordering has nothing to order by. question_stats
    // only started filling recently, so times_overridden — the default sort —
    // is zero for all 4,859 questions, and the page silently showed 25
    // arbitrary ones. Flagged questions were in the bank the whole time and
    // simply never rose to the top, because nothing did.
    const sortCol = QH_SORTS[_qhSort] || QH_SORTS.overrides;
    const SORT_LABEL = {
      times_overridden: 'host overrides', pct_correct: 'play data',
      flags: 'flags', pct_liked: 'votes', times_asked: 'plays',
    };
    if (rows.length && !rows.some(r => Number(r[sortCol]) > 0)) {
      parts.push(`Nothing shown has any ${SORT_LABEL[sortCol] || sortCol} yet, so this ordering is arbitrary — sort by something with data to see it.`);
    }

    summary.textContent = parts.join(' ');
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
