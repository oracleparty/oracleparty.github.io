// ============================================
// Oracle Party — Admin Dashboard
// Unlisted page, gated by is_admin on profiles.
// ============================================

import { $, escapeHtml } from './utils.js';
import { logger } from './logger.js';
import { CATEGORY_META, flattenSubcategories } from './categories.js';
import { findAnswersNeedingReview } from './answer-health.js';
import { TITLE_WORDS, overlayWordId, clearWordOverlay } from './titles.js';
import { loadTitleWords, resetTitleWordCache } from './title-content.js';
import { tiersForTopic, topicTarget, subjectTargets, TOPIC_FLOOR, placeholderWord } from './title-tiers.js';

// Chip order for the question editor. CATEGORY_META's own order is the order
// the host screen shows, so the two agree.
const CATEGORY_KEYS = Object.keys(CATEGORY_META);
import { supabase, fetchQuestionCount, fetchSiteSettings, upsertSiteSetting, deleteSiteSetting, fetchAnswerTally, cleanupAbandonedRooms,
  fetchAdminAccountDetails, fetchAccountGames, fetchAccountPlayCounts, endRoomAsAdmin,
  fetchHostReputations, describeHostReputation,
  saveTitleWord, deleteTitleWord } from './supabase.js';
import { initAuth, getCurrentUser } from './auth.js';
import { ADMIN_PAGE_SIZE, ADMIN_STATUS_FADE_MS, STALE_TIMEOUT_MS, ABANDONED_ROOM_MS, MIN_HOST_RATINGS } from './constants.js';

// ============================================
// INIT
// ============================================

async function init() {
  // Cancel the boot-guard timer in <head> — JS module chain is alive.
  window.__appReady = true;
  if (window.__appBootGuard) clearTimeout(window.__appBootGuard);
  document.body.style.opacity = '1';
  // NO ensureDisplayName HERE. The admin page never reads a display name, and
  // asking for one raced initAuth: on a fresh device the modal could open
  // before the profile loaded, so a signed-in admin was asked to invent a name
  // they already had.
  await initAuth();

  const user = getCurrentUser();
  if (!user?.profile?.is_admin) {
    window.location.href = 'index.html';
    return;
  }

  $('#admin-loading').style.display = 'none';
  $('#admin-content').style.display = '';

  attachListeners();
  attachQuestionHealthListeners();
  attachPanels();

  // Only the four numbers at the top and the count on each closed panel are
  // fetched now. Every section's contents waits until somebody opens it —
  // this page used to run eight full list queries before rendering, including
  // Question Health, which is the heaviest thing on it, for an admin who came
  // to read one flag.
  await Promise.all([
    loadDashboardStats(),
    loadPanelCounts(),
  ]);
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
// PANELS
//
// Every section of this page used to be open at once and fetched on load:
// nine stacked lists on a 375px phone, eight list queries before anything
// rendered. It was comprehensive and unreadable, which for an admin page is
// the same as being unusable — the flag you came to read was 4,000px down.
//
// Now each section is a closed row carrying its own number, and opens on a
// tap. The number is the point: three flags is visible without opening
// anything, so the page tells you where to look instead of showing you
// everything and letting you find it.
//
// One open at a time. Two open panels on a phone reintroduces the scroll.
// ============================================

const PANEL_LOADERS = {
  flagged:      loadFlaggedQueue,
  hosts:        loadFlaggedHosts,
  health:       loadQuestionHealth,
  questions:    loadQuestions,
  games:        loadRecentGames,
  errors:       loadErrorLogs,
  chat:         loadChatArchive,
  announcement: loadAnnouncement,
  flags:        loadFeatureFlags,
  titlewords:   loadTitleWordsPanel,
};

const _panelLoaded = new Set();
let _openPanel = null;

function attachPanels() {
  document.querySelectorAll('.admin-panel__head').forEach(head => {
    head.onclick = () => togglePanel(head.dataset.panel);
  });
}

const panelHead = key => document.querySelector(`.admin-panel__head[data-panel="${key}"]`);

function setPanelOpen(key, open) {
  const head = panelHead(key);
  const body = document.getElementById(`panel-${key}`);
  if (!head || !body) return;
  head.setAttribute('aria-expanded', open ? 'true' : 'false');
  body.hidden = !open;
}

function showPanelError(key, message) {
  const body = document.getElementById(`panel-${key}`);
  if (!body) return;
  // Prepended, never innerHTML — replacing the body would destroy the panel's
  // own controls (the Question Health sort menus live in there), so the retry
  // this error invites would fail on missing elements rather than on the
  // original fault.
  body.querySelector('.admin-panel__error')?.remove();
  const p = document.createElement('p');
  p.className = 'admin-panel__error';
  p.textContent = `Couldn't load this section: ${message}`;
  body.prepend(p);
}

async function togglePanel(key) {
  if (!key) return;

  if (_openPanel === key) {
    setPanelOpen(key, false);
    _openPanel = null;
    return;
  }
  if (_openPanel) setPanelOpen(_openPanel, false);
  setPanelOpen(key, true);
  _openPanel = key;

  // Scroll the HEADER into view, not the body: opening a panel low on the page
  // otherwise pushes its own title off the top and the contents arrive with
  // nothing naming them.
  panelHead(key)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  if (_panelLoaded.has(key)) return;
  _panelLoaded.add(key);

  const load = PANEL_LOADERS[key];
  if (!load) return;
  try {
    await load();
  } catch (err) {
    // A loader that throws used to leave "Loading..." on screen forever with
    // the reason only in the console — the exact shape of CLAUDE.md #4.
    // Clearing the flag lets a second tap retry.
    _panelLoaded.delete(key);
    logger.error('Admin', `panel ${key} failed to load`, err);
    showPanelError(key, err?.message || String(err));
  }
}

// ============================================
// PANEL COUNTS
//
// What each closed row says. These are head-only counts, so the page learns
// how much is behind every door without opening any of them.
// ============================================

// null means "couldn't tell", and renders as "?" — never as 0. A count that
// falls through to zero on error makes an unreachable table and an empty one
// look identical, which is the single most expensive confusion in this
// project's history (CLAUDE.md #4, #6, #8).
async function countRows(table, refine) {
  let query = supabase.from(table).select('*', { count: 'exact', head: true });
  if (refine) query = refine(query);
  const { count, error } = await query;
  if (error) {
    logger.error('Admin', `panel count for ${table} failed`, error);
    return null;
  }
  return count ?? 0;
}

function setPanelCount(key, text, tone = null) {
  const el = document.querySelector(`[data-count="${key}"]`);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('admin-panel__count--alert', tone === 'alert');
  el.classList.toggle('admin-panel__count--error', tone === 'error');
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

async function loadPanelCounts() {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [flags, ratings, played, questions, games, errors, chats, settings, hostFlags] = await Promise.all([
    countRows('question_feedback', q => q.eq('feedback_type', 'flag')),
    countRows('question_feedback'),
    countRows('question_health', q => q.gt('times_asked', 0)),
    countRows('questions', q => q.neq('format', 'removed')),
    countRows('game_history'),
    countRows('error_logs', q => q.gte('timestamp', sevenDaysAgo)),
    countRows('chat_archive'),
    fetchSiteSettings().catch(err => {
      logger.error('Admin', 'panel counts: site settings failed', err);
      return null;
    }),
    countRows('host_ratings', q => q.not('flag_reason', 'is', null)),
  ]);

  // Flags: the one number on this page somebody is meant to act on.
  setPanelCount('flagged',
    flags === null ? '?' : flags === 0 ? 'None' : plural(flags, 'flag'),
    flags ? 'alert' : null);

  // Question Health answers "is anything being recorded", which "0 played"
  // alone does not: no ratings at all is a pipeline to investigate, while
  // ratings-but-no-plays is a working one that nobody has played through.
  setPanelCount('health',
    played === null ? '?'
      : played > 0 ? `${played} played`
      : ratings ? `${plural(ratings, 'rating')}, 0 played`
      : 'No data yet');

  // Amber only when non-zero, like the question flags: colour everything and
  // it stops meaning anything. `?` and never `0` when the count fails — an
  // unreachable table and an empty one must not look alike.
  setPanelCount('hosts',
    hostFlags === null ? '?' : hostFlags === 0 ? 'None' : plural(hostFlags, 'report'),
    hostFlags ? 'alert' : null);

  setPanelCount('questions', questions === null ? '?' : questions.toLocaleString());

  // How many words are still unwritten. Cheap — it reads TITLE_WORDS, which is
  // already loaded, and does NOT count the bank (that happens when the panel is
  // opened). Amber when non-zero, like the flags: the collection stops growing
  // silently otherwise, and this is the only thing that would ever say so.
  // HOW MANY WORDS EXIST — exact, and free, because it reads TITLE_WORDS which
  // is already loaded. Deliberately NOT "N to write": that number depends on
  // which topics are big enough to offer a tier, which needs ~54 counts against
  // the bank. Guessing it from the structure alone over-counted by more than
  // half, and a chip that lies is worse than one that says less. The real gap
  // appears when the panel is opened.
  const written = countWrittenTitleWords();
  setPanelCount('titlewords', `${written} written`);
  setPanelCount('games',     games === null ? '?' : games === 0 ? 'None' : games.toLocaleString());
  setPanelCount('chat',      chats === null ? '?' : chats === 0 ? 'None' : chats.toLocaleString());

  setPanelCount('errors',
    errors === null ? '?' : errors === 0 ? 'None · 7d' : `${errors} · 7d`,
    errors ? 'error' : null);

  if (settings === null) {
    setPanelCount('announcement', '?');
    setPanelCount('flags', '?');
  } else {
    const ann = settings.find(s => s.key === 'announcement');
    setPanelCount('announcement', ann?.value?.text ? 'Live' : 'Off', ann?.value?.text ? 'alert' : null);

    const on = FLAG_DEFS.filter(f =>
      (settings.find(s => s.key === f.key)?.value?.enabled ?? f.default)).length;
    setPanelCount('flags', on === 0 ? 'Off' : `${on} on`, on ? 'alert' : null);
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
  // Sweep abandoned rooms before counting them. A room is only ever cleaned up
  // by a browser still inside it, so when everybody's phone dies at once the
  // player rows persist, the zero-player check never fires, and the room reads
  // as a live game forever — which is exactly what "two active games nobody is
  // in" was. Same sweep the Join page runs, so the number here and the list a
  // player sees agree.
  await cleanupAbandonedRooms().catch(err =>
    logger.warn('Admin', 'abandoned-room sweep failed', err));

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

  // "status = playing" is not the same as "somebody is in there". A player row
  // is removed by a beacon on unload or by another client in the room running
  // the stale sweep, so when everybody's phone dies at once nobody sweeps and
  // the room reads as a live game forever. Showing the heartbeat is what makes
  // a ghost distinguishable from a real game without having to guess.
  const { data: players } = await supabase
    .from('players')
    .select('room_id, last_seen_at, is_bot')
    .in('room_id', rooms.map(r => r.id));

  const byRoom = new Map();
  for (const p of players || []) {
    if (!byRoom.has(p.room_id)) byRoom.set(p.room_id, []);
    byRoom.get(p.room_id).push(p);
  }

  const cutoff = Date.now() - ABANDONED_ROOM_MS;
  return rooms.map(r => {
    const humans = (byRoom.get(r.id) || []).filter(p => !p.is_bot);
    const alive = humans.filter(p => !p.last_seen_at || new Date(p.last_seen_at).getTime() > cutoff);
    const ghost = humans.length > 0 && alive.length === 0;
    const who = humans.length === 0
      ? 'nobody in the room'
      : ghost
        ? `${humans.length} player${humans.length === 1 ? '' : 's'}, all silent — abandoned`
        : `${alive.length} of ${humans.length} still here`;
    return `<div class="stat-drill__row">
      <span class="stat-drill__name">${escapeHtml(r.code || '?')}</span>
      <span class="stat-drill__meta">${escapeHtml(r.category || '?')}${r.subcategory ? ' · ' + escapeHtml(r.subcategory) : ''} · host ${escapeHtml(r.host_name || '?')} · ${escapeHtml(who)} · ${escapeHtml(when(r.created_at))}</span>
      <button class="btn-danger stat-drill__action" data-end-room="${escapeHtml(String(r.id))}" data-room-code="${escapeHtml(r.code || '')}">End</button>
    </div>`;
  }).join('');
}

async function drillAccounts() {
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, display_name, discriminator, is_admin, created_at')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) return drillError(error, 'accounts');
  if (!data || data.length === 0) return drillEmpty('No accounts yet.');

  // Games and sessions for the whole list in ONE query. Six rounds with the
  // same group in one evening is six games and one session, and the pair says
  // something neither number says alone: thirty games across two sessions is a
  // different player from thirty across twenty-five.
  const counts = await fetchAccountPlayCounts(data.map(p => p.user_id));

  const me = getCurrentUser()?.user?.id;
  return data.map(p => {
    const isMe = String(p.user_id) === String(me);
    // Every row here is a REAL account: guests have no profiles row at all, so
    // nothing on this list is a guest. "New Player" means somebody signed up
    // or came in through Google and never chose a name.
    const noName = !p.display_name || p.display_name === 'New Player';
    // No delete button on yourself or on another admin. The database refuses
    // both anyway (migration 037) — this stops the tap rather than explaining
    // the refusal afterwards.
    const action = (isMe || p.is_admin)
      ? `<span class="stat-drill__meta">${isMe ? 'you' : 'admin'}</span>`
      : `<button class="btn-danger stat-drill__action" data-del-account="${escapeHtml(String(p.user_id))}" data-del-name="${escapeHtml(p.display_name || '')}">Delete</button>`;
    const c = counts[String(p.user_id)] || { games: 0, sessions: 0 };
    const played = c.games === 0
      ? 'never played'
      : `${c.games} game${c.games === 1 ? '' : 's'} · ${c.sessions} session${c.sessions === 1 ? '' : 's'}`;
    return `<div class="stat-drill__row stat-drill__row--openable" data-account="${escapeHtml(String(p.user_id))}">
      <span class="stat-drill__name">${escapeHtml(p.display_name || '(no name)')}<span class="stat-drill__tag">#${escapeHtml(p.discriminator || '----')}</span></span>
      <span class="stat-drill__meta">${escapeHtml(played)} · ${escapeHtml(when(p.created_at))}${noName ? ' · never set a name' : ''}</span>
      ${action}
    </div>
    <div class="account-detail" data-account-detail="${escapeHtml(String(p.user_id))}" style="display:none;"></div>`;
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

/**
 * The expanded view of one account: who they are, and what they have played.
 *
 * The identity half needs admin_account_details (migration 042) because email,
 * sign-up method and last sign-in all live in auth.users, which no client can
 * read. When that function is missing or refuses, the panel still shows
 * everything computable from profiles and game_history rather than an error —
 * a partial answer beats none, and the missing half says so.
 */
async function renderAccountDetail(userId, panel) {
  panel.innerHTML = '<div class="stat-drill__loading">Loading…</div>';

  const [details, games] = await Promise.all([
    fetchAdminAccountDetails(userId).catch(() => null),
    fetchAccountGames(userId).catch(() => []),
  ]);

  const rooms = new Set(games.map(g => String(g.room_id)).filter(Boolean));
  const wins = games.filter(g => g.placement === 1).length;
  const last = games[0]?.played_at;

  // Categories they actually play, commonest first.
  const byCat = {};
  for (const g of games) byCat[g.category] = (byCat[g.category] || 0) + 1;
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([c, n]) => `${CATEGORY_META[c]?.label || c} (${n})`).join(', ');

  const idRows = details
    ? [
        ['Email', details.email || '(none)'],
        ['Signed up with', details.provider === 'google' ? 'Google' : 'Email & password'],
        ['Email confirmed', details.email_confirmed ? 'Yes' : 'No — never confirmed'],
        ['Last signed in', details.last_sign_in_at ? when(details.last_sign_in_at) : 'Never'],
      ]
    : [['Identity', 'Needs migration 042, or you are not signed in as an admin']];

  const playRows = [
    ['Games played', String(games.length)],
    ['Sessions', String(rooms.size)],
    ['Wins', String(wins)],
    ['Last played', last ? when(last) : 'Never'],
  ];
  if (top) playRows.push(['Plays most', top]);

  panel.innerHTML = [...idRows, ...playRows].map(([k, v]) =>
    `<div class="account-detail__row">
       <span class="account-detail__key">${escapeHtml(k)}</span>
       <span class="account-detail__val">${escapeHtml(v)}</span>
     </div>`).join('');
}

async function handleDrillClick(e) {
  // Open one account. Checked before the buttons below so a tap on Delete does
  // not also expand the row underneath it.
  if (!e.target.closest('[data-del-account]')) {
    const row = e.target.closest('[data-account]');
    if (row) {
      const id = row.dataset.account;
      const panel = document.querySelector(`[data-account-detail="${CSS.escape(id)}"]`);
      if (panel) {
        const open = panel.style.display !== 'none';
        // One at a time: several open panels turn a scannable list into a wall.
        document.querySelectorAll('[data-account-detail]').forEach(el => { el.style.display = 'none'; });
        document.querySelectorAll('[data-account]').forEach(el => el.classList.remove('stat-drill__row--open'));
        if (!open) {
          panel.style.display = '';
          row.classList.add('stat-drill__row--open');
          await renderAccountDetail(id, panel);
        }
        return;
      }
    }
  }

  const endBtn = e.target.closest('[data-end-room]');
  if (endBtn) {
    if (_armed !== endBtn) return arm(endBtn, 'Really end?');
    disarm();
    endBtn.disabled = true;
    // Through the server (051). This was a plain DELETE on `rooms`, which
    // migration 048 revoked — so it returned no error, affected nothing, and
    // the dashboard redrew as though the room had ended. The #5 pattern
    // exactly: the screen has to tell the truth, not just avoid an error.
    const { ok, refused, unavailable } = await endRoomAsAdmin(endBtn.dataset.endRoom);
    if (!ok) {
      const legacy = unavailable
        ? await supabase.from('rooms').delete().eq('id', endBtn.dataset.endRoom).select()
        : null;
      if (!legacy || legacy.error || !legacy.data?.length) {
        endBtn.disabled = false;
        endBtn.textContent = refused ? 'Not allowed' : 'Failed';
        logger.error('Admin', 'end room failed', { refused, unavailable, error: legacy?.error });
        return;
      }
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

/**
 * Hosts somebody has reported (migration 054).
 *
 * A FLAG THAT REACHES NOWHERE IS THEATRE. The point of letting a player report
 * a host is that a person eventually reads it, so this sits next to Flagged
 * Questions — the two things on this page anybody is meant to act on.
 *
 * Same rule as the question queue: a failed query and an empty queue must not
 * render the same reassuring sentence. And a host with a poor score but no
 * flags is shown too, because a pattern of thumbs-down is a report of a kind.
 */
async function loadFlaggedHosts() {
  const container = $('#flagged-hosts');

  const { data: rows, error } = await supabase
    .from('host_ratings')
    .select('host_user_id, voter_name, rating, flag_reason, flag_note, created_at')
    .not('flag_reason', 'is', null)
    .order('created_at', { ascending: false });

  if (error) {
    // A missing relation means migration 054 has not been run, which is a
    // different problem from a query that failed, and says so.
    const notInstalled = error.code === 'PGRST205' || /could not find the table/i.test(error.message || '');
    logger.error('Admin', 'loadFlaggedHosts failed', error);
    container.innerHTML = notInstalled
      ? `<p style="color:var(--color-text-muted); font-size:var(--text-sm);">Host ratings are not installed yet — run migration 054.</p>`
      : `<p style="color:var(--color-danger); font-size:var(--text-sm);">Couldn't load host reports: ${escapeHtml(error.message || String(error))}</p>`;
    return;
  }

  if (!rows || rows.length === 0) {
    // "No reports" answers the wrong question when the worry is whether
    // ratings are being recorded at all — the same distinction the question
    // queue draws, and for the same reason.
    const { count, error: countErr } = await supabase
      .from('host_ratings')
      .select('id', { count: 'exact', head: true });
    const suffix = countErr
      ? ` (couldn't count other ratings: ${escapeHtml(countErr.message || String(countErr))})`
      : count > 0
        ? ` ${count} host rating${count === 1 ? '' : 's'} recorded, so the pipeline is working.`
        : ' No host ratings of any kind recorded yet.';
    container.innerHTML = `<p style="color:var(--color-text-muted); font-size:var(--text-sm);">No hosts reported.${suffix}</p>`;
    return;
  }

  const byHost = new Map();
  for (const r of rows) {
    const acc = byHost.get(r.host_user_id) || { reports: [], count: 0 };
    acc.count++;
    acc.reports.push(r);
    byHost.set(r.host_user_id, acc);
  }

  // Names, so an admin is not reading a list of uuids.
  const { data: profiles } = await supabase
    .from('profiles')
    .select('user_id, display_name, discriminator')
    .in('user_id', [...byHost.keys()]);
  const nameOf = new Map((profiles || []).map(p =>
    [p.user_id, `${p.display_name || 'New Player'}${p.discriminator ? '#' + p.discriminator : ''}`]));

  // And their standing, so a single report against a well-liked host reads
  // differently from three against a badly-liked one.
  const reps = await fetchHostReputations([...byHost.keys()]);

  const REASONS = {
    unfair_judging: 'unfair judging',
    abusive: 'abusive',
    ended_early: 'ended the game early',
    other: 'other',
  };

  const sorted = [...byHost.entries()].sort((a, b) => b[1].count - a[1].count);
  container.innerHTML = sorted.map(([userId, info]) => {
    const rep = describeHostReputation(reps.get(userId), MIN_HOST_RATINGS);
    const standing = rep ? escapeHtml(rep.text) : 'no rating yet';
    const reasons = info.reports.map(r => REASONS[r.flag_reason] || r.flag_reason);
    const notes = info.reports.map(r => r.flag_note).filter(Boolean);
    return `
      <div class="admin-flag-row">
        <div class="admin-flag-row__text">${escapeHtml(nameOf.get(userId) || userId)}</div>
        <div class="admin-flag-row__meta">
          <span class="admin-flag-row__answer">${standing}</span>
          <span class="admin-flag-row__count">${plural(info.count, 'report')}</span>
          <span class="admin-flag-row__reasons">${escapeHtml([...new Set(reasons)].join(', '))}</span>
        </div>
        ${notes.map(t => `<div class="admin-flag-row__note">\u201C${escapeHtml(t)}\u201D</div>`).join('')}
      </div>`;
  }).join('');
}

async function loadFlaggedQueue() {
  const container = $('#flagged-queue');

  // Fetch all flags
  const { data: flags, error } = await supabase
    .from('question_feedback')
    .select('question_id, feedback_type, flag_reason, flag_note, player_name')
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
    // "No flagged questions" answers the wrong question when the worry is
    // whether ratings are being recorded at all. A playtest reported flags not
    // reaching this page, and an empty list looks identical whether the writes
    // are being refused, the reads are being filtered, or nobody tapped the
    // flag. Counting every kind of feedback separates the first two from the
    // third: ratings present but no flags is a working pipeline; nothing at all
    // is a pipeline to investigate.
    const { count, error: countErr } = await supabase
      .from('question_feedback')
      .select('question_id', { count: 'exact', head: true });
    const suffix = countErr
      ? ` (couldn't count other ratings: ${escapeHtml(countErr.message || String(countErr))})`
      : count > 0
        ? ` ${count} other rating${count === 1 ? '' : 's'} recorded, so ratings are reaching the database.`
        : ' No ratings of any kind recorded yet — thumbs, flags or otherwise.';
    container.innerHTML = `<p style="color:var(--color-text-muted); font-size:var(--text-sm);">No flagged questions.${suffix}</p>`;
    return;
  }

  // Group by question_id
  const grouped = {};
  for (const f of flags) {
    if (!grouped[f.question_id]) grouped[f.question_id] = { count: 0, reasons: [], notes: [], players: [] };
    grouped[f.question_id].count++;
    if (f.flag_reason) grouped[f.question_id].reasons.push(f.flag_reason);
    // What somebody actually typed when they picked "Other". A flag with no
    // reason is a report that something is wrong and no way to find out what.
    if (f.flag_note) grouped[f.question_id].notes.push(f.flag_note);
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
        ${(info.notes || []).map(n => `<div class="admin-flag-row__note">“${escapeText(n)}”</div>`).join('')}
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
  // Clear the review summary — leaving it up would have it describing a list
  // that has just been replaced by search results.
  setStatus($('#q-review-summary'), '');
  const search = $('#q-search').value.trim();
  const category = $('#q-category').value;
  const format = $('#q-format').value;

  _questionOffset = 0;
  const questions = await fetchQuestions(search, category, format, 0);
  renderQuestions(questions);
  $('#btn-load-more').style.display = questions.length >= PAGE_SIZE ? '' : 'none';
}

// ============================================
// REVIEW ANSWER KEYS
//
// The same rules the CI probe runs, in the browser, so the list lands on the
// phone that can edit them instead of in a workflow log the owner would have
// to be talked through. `answer-health.js` is shared by both, so the two can
// never disagree about what counts.
//
// Deliberately behind a button. It reads four columns for the whole bank —
// about 4,900 rows — which is far too much to do on every page load, and the
// answer changes only when somebody edits a question.
// ============================================

async function reviewAnswerKeys() {
  const summary = $('#q-review-summary');
  const results = $('#question-results');
  const btn = $('#btn-review-answers');
  if (!summary || !results) return;

  btn.disabled = true;
  setStatus(summary, 'Reading the question bank...', { sticky: true });
  results.innerHTML = '';
  $('#btn-load-more').style.display = 'none';

  // Paged, because PostgREST caps a single response. Only the four columns the
  // rules read, so this is a few hundred KB rather than a few megabytes.
  const rows = [];
  try {
    for (let page = 0; page < 12; page++) {
      const from = page * 1000;
      const { data, error } = await supabase
        .from('questions')
        .select('id, question, correct_answer, acceptable_answers, categories, subcategory, format, difficulty')
        .range(from, from + 999);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < 1000) break;
    }
  } catch (err) {
    logger.error('Admin', 'reviewAnswerKeys failed', err);
    setStatus(summary, `Couldn't read the question bank: ${err.message || err}`, { sticky: true });
    btn.disabled = false;
    return;
  }

  const found = findAnswersNeedingReview(rows);
  btn.disabled = false;

  if (rows.length === 0) {
    setStatus(summary, 'No questions were readable, so nothing was checked.', { sticky: true });
    return;
  }
  if (found.length === 0) {
    setStatus(summary, `Checked ${rows.length.toLocaleString()} questions — none need a second look.`, { sticky: true });
    return;
  }

  const byKind = {};
  for (const f of found) byKind[f.finding.label] = (byKind[f.finding.label] || 0) + 1;
  setStatus(summary,
    `${found.length} of ${rows.length.toLocaleString()} worth a look — ` +
    Object.entries(byKind).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ') +
    '. Tap one to add the forms people would actually type. These are candidates, not mistakes.',
    { sticky: true });

  // Unit findings first: they are the ones that name the exact spelling to add,
  // so they are the cheapest to act on.
  const order = { unit: 0, number: 1, date: 2, long: 3 };
  found.sort((a, b) => (order[a.finding.kind] ?? 9) - (order[b.finding.kind] ?? 9));

  for (const { question, finding } of found) {
    const row = createQuestionRow(question);
    const note = document.createElement('p');
    note.className = 'admin-review__note';
    note.textContent = `${finding.label} — ${finding.why}`;
    row.querySelector('.admin-q-row__summary')?.appendChild(note);
    results.appendChild(row);
  }
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
      <div class="admin-q-edit__field">
        <span class="admin-q-edit__label">Categories</span>
        <div class="admin-cat-chips">${CATEGORY_KEYS.map(key => `
          <button type="button" class="admin-cat-chip${(q.categories || []).includes(key) ? ' admin-cat-chip--on' : ''}"
                  data-cat="${key}" aria-pressed="${(q.categories || []).includes(key)}">${escapeText(CATEGORY_META[key].label)}</button>`).join('')}
        </div>
      </div>
      <label>Subcategory<select class="input admin-q-edit__subcategory"></select></label>
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

  // ------------------------------------------
  // Categories and subcategory
  //
  // A question filed in the wrong place used to need the Supabase SQL editor
  // — a language question sitting in Food and Drink was unfixable from a
  // phone. `categories` is an array (11% of questions carry more than one and
  // that is deliberate), so it is chips rather than a menu.
  // ------------------------------------------
  const subSelect = row.querySelector('.admin-q-edit__subcategory');

  const selectedCategories = () =>
    [...row.querySelectorAll('.admin-cat-chip--on')].map(b => b.dataset.cat);

  // The subcategory list is drawn from whichever categories are ticked, so it
  // can never offer a subcategory that belongs to a category this question is
  // not in. Rebuilt on every chip tap, keeping the current value if it is
  // still reachable — untick the wrong category first and the right filing
  // would otherwise vanish under you mid-edit.
  function rebuildSubcategories() {
    const keep = subSelect.value || q.subcategory || '';
    const cats = selectedCategories();
    let html = '<option value="">— none —</option>';
    for (const cat of cats) {
      const subs = flattenSubcategories(cat);
      if (!subs.length) continue;
      html += `<optgroup label="${escapeText(CATEGORY_META[cat].label)}">` +
        subs.map(s =>
          `<option value="${escapeText(s.key)}">${'  '.repeat(s.depth)}${escapeText(s.label)}</option>`
        ).join('') + '</optgroup>';
    }
    // A value stored against a category that is no longer ticked would silently
    // disappear from the menu and then be silently cleared on save. Offer it
    // back, labelled, so removing it is a decision rather than a side effect.
    if (keep && !html.includes(`value="${keep}"`)) {
      html += `<optgroup label="Currently filed as"><option value="${escapeText(keep)}">${escapeText(keep)}</option></optgroup>`;
    }
    subSelect.innerHTML = html;
    subSelect.value = keep;
  }
  rebuildSubcategories();

  row.querySelectorAll('.admin-cat-chip').forEach(chip => {
    chip.onclick = () => {
      const on = chip.classList.toggle('admin-cat-chip--on');
      chip.setAttribute('aria-pressed', String(on));
      rebuildSubcategories();
    };
  });

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

    const newCategories = selectedCategories();
    const newSubcategory = subSelect.value || null;

    // A question in no category is drawable by nothing and unfindable by
    // category filter — it is not deleted, it is worse, because it still
    // counts in the bank. Refuse rather than save it.
    if (newCategories.length === 0) {
      setStatus(statusEl, 'Pick at least one category — a question in none can never be drawn.', { sticky: true });
      return;
    }

    const updates = {
      [textCol]: newText,
      [answerCol]: newAnswer,
      [altsCol]: newAlts,
      categories: newCategories,
      subcategory: newSubcategory,
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
    // And the summary line, or the row goes on claiming the old filing until
    // the page is searched again \u2014 the "the screen is now telling the truth"
    // rule from CLAUDE.md #5, which is about more than the error case.
    const metaSpans = row.querySelectorAll('.admin-q-row__meta span');
    if (metaSpans[0]) metaSpans[0].textContent = newCategories.join(', ');
    if (metaSpans[1]) metaSpans[1].textContent = newFormat;
    if (metaSpans[2]) metaSpans[2].textContent = newDifficulty;
    // So the next tap on this row starts from what was actually stored.
    q.categories = newCategories;
    q.subcategory = newSubcategory;
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
  $('#btn-review-answers').onclick = reviewAnswerKeys;
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
  // CLEAR 7d+ DISCARDED ITS OWN RESULT AND REDREW AS THOUGH IT HAD WORKED.
  //
  // The #5 pattern, and the same one the End button on a stuck room had: an RLS
  // refusal returns no error and affects nothing, so a delete that checks
  // neither reports success while deleting nothing. Migration 019 grants admins
  // DELETE on error_logs and its predicate is right (profiles.user_id, not
  // profiles.id — the mistake that made 024's admin policy grant nothing), but
  // migrations here are applied by hand and nothing records which were run.
  //
  // So this is a DIAGNOSTIC, not a diagnosis: nothing has established that the
  // delete is refused. What was wrong is that nobody could tell either way.
  // Press it once and the screen now says which world we are in.
  //
  // NOT writeSucceeded(), deliberately. Its rule is "zero rows means refused",
  // and here zero rows is genuinely ambiguous — a refusal and "there is nothing
  // older than seven days" are the same silence. Counting first is what
  // separates them, and without that the honest-looking version would report a
  // permission error every time the window happened to be empty.
  $('#btn-clear-old-errors').onclick = async () => {
    const btn = $('#btn-clear-old-errors');
    const statusEl = $('#error-clear-status');
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    btn.disabled = true;
    setStatus(statusEl, 'Clearing...', { sticky: true });
    try {
      const { count: oldCount, error: countErr } = await supabase
        .from('error_logs')
        .select('id', { count: 'exact', head: true })
        .lt('timestamp', cutoff);
      if (countErr) {
        logger.error('Admin', 'could not count old error logs', countErr);
        setStatus(statusEl, `Couldn't read the logs: ${countErr.message}`, { sticky: true });
        return;
      }
      if (!oldCount) { setStatus(statusEl, 'Nothing older than 7 days.'); return; }

      const { data, error } = await supabase
        .from('error_logs').delete().lt('timestamp', cutoff).select('id');
      if (error) {
        logger.error('Admin', 'clear old error logs failed', error);
        setStatus(statusEl, `Error: ${error.message}`, { sticky: true });
        return;
      }
      const removed = data?.length || 0;
      if (removed === 0) {
        // The rows are there and none moved. That is a refusal, which is the
        // one outcome the old version rendered as success.
        setStatus(statusEl,
          `Not cleared — permission denied on ${oldCount} old ${oldCount === 1 ? 'entry' : 'entries'}. Is migration 019 applied?`,
          { sticky: true });
        return;
      }
      setStatus(statusEl, `Cleared ${removed} old ${removed === 1 ? 'entry' : 'entries'}.`);
      _errorOffset = 0;
      await loadErrorLogs();
    } finally {
      btn.disabled = false;
    }
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
//
// 1 while the data is thin, at the owner's request: with two people testing,
// nothing ever reaches 3, so both percentage sorts showed an empty list and
// there was no way to tell whether ratings were being recorded at all. An
// empty list for "not enough data yet" looks exactly like an empty list for
// "the write is broken", which is the confusion this whole project keeps
// paying for.
//
// The reasoning behind 3 has not changed and still applies once real games
// have been played: one thumbs-up is 100% liked and would outrank 47 likes
// against 3 dislikes. RAISE THIS BACK TO 3 once the game has had a few real
// sessions. Until then the raw count sits next to every percentage, which is
// what makes a 100%-from-one-vote readable rather than misleading.
const QH_MIN_SAMPLE = 1;
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
  // So a check can name which question is on screen. Without it the row is
  // anonymous and any assertion about the list can only count rows, which
  // cannot tell "the thin-sample one is missing" from "there are fewer".
  row.dataset.qid = q.id;
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
      parts.push(QH_MIN_SAMPLE > 1
        ? `Showing questions played at least ${QH_MIN_SAMPLE}× (percentages below that are noise).`
        : 'Showing every question that has been played at all — a percentage from one or two plays is noise, so read the count beside it.');
    } else if (_qhSort === 'liked') {
      parts.push(QH_MIN_SAMPLE > 1
        ? `Showing questions with at least ${QH_MIN_SAMPLE} votes (percentages below that are noise).`
        : 'Showing every question with any vote at all — a percentage from one or two votes is noise, so read the count beside it.');
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


// ============================================
// TITLE WORDS
//
// The owner has ~106 words to write and no way to know WHICH. Targets are
// frozen once set, so nothing else would ever say that a growing bank has made
// a topic newly eligible for a tier — without this the collection silently
// stops growing, which is the failure this panel exists to prevent.
//
// COUNTED WITH THE GAME'S OWN FILTER. fetchQuestionCount uses format = 'open',
// which is what every question-fetch path in js/db/questions.js uses, so these
// are the questions that can actually be ASKED. Measuring against anything
// wider would set a 100% target nobody could reach — the same shape as the
// legendary that was defined twice and could never be earned.
// ============================================

function titleWordFor(slot, cat, sub, rarity) {
  return Object.entries(TITLE_WORDS).find(([, w]) =>
    w.slot === slot
    && (w.unlock?.condition?.category || null) === (cat || null)
    && (w.unlock?.condition?.subcategory || null) === (sub || null)
    && w.rarity === rarity);
}

/**
 * The whole collection, laid out so the owner can write into it.
 *
 * THE STRUCTURE COMES FROM THE BANK, not from a list anybody maintains. Every
 * subject and every topic big enough to carry words of its own appears here
 * whether or not a word has been written for it, which is the point: targets
 * are FROZEN when a word is saved, so nothing else would ever tell the owner
 * that a growing topic has become eligible for a tier it could not offer
 * before. Without this page the collection silently stops growing.
 */
// HOW BIG EVERY TOPIC IS, MEASURED ONCE.
//
// About sixty counting queries against the whole bank. The panel redraws after
// every single save — it has to, because the word, the counts at the top and
// the frozen-target note all move together — and re-measuring each time would
// have made writing the ~86 outstanding words cost roughly five thousand
// queries, each slow enough to notice.
//
// Safe to hold for the life of the page: the bank only changes if the owner
// edits it in another panel, and closing and reopening this one re-measures.
// THE SIZES ARE NOT WHAT A SAVE CHANGES — a save changes the words, and those
// are re-read from the database on every redraw.
let _topicSizes = null;

/**
 * How big every topic is, counted the way the game actually asks.
 *
 * SIXTY-FOUR REQUESTS, AND THEY USED TO GO ONE AT A TIME. Twelve subjects plus
 * their fifty-two topics, each awaited inside a nested loop, with nothing on
 * screen but "Counting the bank…" until the last one landed. On a phone at a
 * few hundred milliseconds per round trip that is fifteen to thirty seconds of
 * a panel that looks broken — reported by the owner as "title words not working
 * on admin page? Or it is taking a really long time to load?"
 *
 * It matters more than a slow panel usually would: the button that fills the
 * empty slots with placeholders lives INSIDE this panel, so nobody could reach
 * it, so no placeholder was ever written, so players saw an empty collection.
 * One slow loop, three complaints.
 *
 * They are independent counts, so they go together. Batched rather than fired
 * all at once: sixty-four simultaneous requests from one phone is how you get
 * rate-limited, and a burst that fails is slower than a batch that does not.
 */
const TOPIC_COUNT_BATCH = 8;

async function measureTopicSizes() {
  if (_topicSizes) return _topicSizes;

  // Flatten first, so the batching does not have to know about the shape.
  const jobs = [];
  for (const catKey of Object.keys(CATEGORY_META)) {
    jobs.push({ catKey, sub: null });
    for (const sub of flattenSubcategories(catKey)) jobs.push({ catKey, sub: sub.key });
  }

  const counts = new Map();
  for (let i = 0; i < jobs.length; i += TOPIC_COUNT_BATCH) {
    const batch = jobs.slice(i, i + TOPIC_COUNT_BATCH);
    await Promise.all(batch.map(async j => {
      counts.set(`${j.catKey}\u0000${j.sub ?? ''}`, await fetchQuestionCount(j.catKey, j.sub));
    }));
  }

  const out = {};
  for (const catKey of Object.keys(CATEGORY_META)) {
    const sizes = {};
    for (const sub of flattenSubcategories(catKey)) {
      sizes[sub.key] = counts.get(`${catKey}\u0000${sub.key}`) || 0;
    }
    out[catKey] = { sizes, subjectSize: counts.get(`${catKey}\u0000`) || 0 };
  }
  _topicSizes = out;
  return out;
}

async function loadTitleWordsPanel() {
  const box = $('#title-words');
  // Only on the FIRST draw. On a redraw after a save this would collapse a very
  // long panel to one line and back, throwing the reader to the top of it —
  // eighty-six times over, for somebody writing the outstanding words.
  if (!_topicSizes) box.innerHTML = '<p class="admin-empty">Counting the bank…</p>';

  const measured = await measureTopicSizes();

  // What is already written. This panel is the only screen that shows unwritten
  // slots, so it needs the same words a player would see.
  await loadTitleWords();

  const subjects = [];
  let needWriting = 0;
  let written = 0;
  let placeheld = 0;

  for (const [catKey, meta] of Object.entries(CATEGORY_META)) {
    const subs = flattenSubcategories(catKey);
    const { sizes, subjectSize } = measured[catKey];
    const st = subjectTargets(subjectSize, sizes);

    const slot = (tier, sub, target, need, label) => {
      const found = titleWordFor(2, catKey, sub, tier);
      if (!found) needWriting++;
      else if (found[1].isPlaceholder) placeheld++;
      else written++;
      return {
        tier, sub, target, need,
        // What a placeholder for this slot would be NAMED after — the subject
        // for a subject word, the topic for a topic word.
        label,
        word: found ? found[1].word : null,
        // Only a word that came from the database can be edited from here. One
        // defined in code needs a deploy, and offering a Remove button that
        // silently fails would be the "Saved!" lie this page has shipped three
        // times already.
        editable: !found || found[0] === overlayWordId(catKey, sub, tier),
        // The share this tier asks for TODAY. A written word keeps the target
        // it was frozen at, so when the bank grows the two differ — and that
        // difference is the only signal the owner gets that re-freezing is
        // available. It is never applied automatically: a goal that recedes on
        // its own is the worst thing a collection can do.
        frozen: found ? (found[1].unlock?.condition?.right ?? null) : null,
        // Scaffolding, not a written word. Counted apart at the top and marked
        // on the row, because "how much is left to do" is the only number on
        // this page the owner actually needs.
        placeholder: found ? !!found[1].isPlaceholder : false,
      };
    };

    // A SLOT WHOSE TARGET IS NOT A REAL COUNT IS NOT OFFERED. `mythic` asks for
    // the whole subject, so a subject with no askable questions yet produces a
    // target of 0 — a word that would be earned by answering nothing, which is
    // both meaningless and the one promise this system must never make. The
    // save refuses it too; this stops the box being drawn in the first place,
    // because a control that lights up and cannot work is the fault CLAUDE.md
    // #4 is about.
    const subjectSlots = [
      slot('common', null, st.common, `${st.common} right in the whole subject`, meta.label || catKey),
      slot('rare', null, st.rare.atLeast,
        `a quarter of every topic, ${st.rare.atLeast}+ overall`, meta.label || catKey),
      slot('mythic', null, st.mythic, `all ${st.mythic}`, meta.label || catKey),
    ].filter(sl => Number.isFinite(sl.target) && sl.target >= 1);

    const topics = subs.map(sub => {
      const size = sizes[sub.key] || 0;
      const tiers = tiersForTopic(size, sub.key).map(tier => {
        const target = topicTarget(size, tier);
        return slot(tier, sub.key, target, `${target} right`, sub.label);
      });
      return { key: sub.key, label: sub.label, size, tiers };
    });

    subjects.push({ key: catKey, label: meta.label || catKey, emoji: meta.emoji || '', subjectSize, subjectSlots, topics });
  }

  const totalTopics = subjects.reduce((n, r) => n + r.topics.length, 0);
  const qualifying = subjects.reduce((n, r) => n + r.topics.filter(t => t.tiers.length).length, 0);

  const slotHtml = (catKey, sl) => {
    // A written word whose frozen target no longer matches today's share. Shown,
    // never acted on — saving again is what re-freezes it.
    const drifted = sl.word && sl.frozen != null && sl.target != null && sl.frozen !== sl.target;
    return `
    <div class="tw-slot${sl.word ? '' : ' tw-slot--empty'}${sl.placeholder ? ' tw-slot--placeholder' : ''}"
         data-cat="${escapeHtml(catKey)}" data-sub="${escapeHtml(sl.sub || '')}"
         data-tier="${escapeHtml(sl.tier)}" data-target="${sl.target}"
         data-label="${escapeHtml(sl.label || '')}">
      <span class="tw-slot__tier" data-r="${sl.tier}">${sl.tier}</span>
      ${sl.editable
        ? `<input class="input tw-slot__input" type="text" maxlength="24"
                  placeholder="not written" value="${escapeHtml(sl.word || '')}"
                  aria-label="${escapeHtml(sl.tier)} word">
           <button class="btn btn-secondary tw-slot__save" type="button">Save</button>
           ${sl.word ? '<button class="btn btn-secondary btn-danger-text tw-slot__remove" type="button">Remove</button>' : ''}`
        : `<span class="tw-slot__word">${escapeHtml(sl.word)}</span>
           <span class="tw-slot__need">in code</span>`}
      <span class="tw-slot__need">${sl.placeholder ? '<b>placeholder</b> &middot; ' : ''}${escapeHtml(String(sl.need))}${
        drifted ? ` &middot; set at ${sl.frozen}` : ''}</span>
      <span class="tw-slot__status" role="status"></span>
    </div>`;
  };

  box.innerHTML = `
    <p class="admin-empty" style="margin-bottom:var(--space-md);">
      <b>${written}</b> written, <b>${placeheld}</b> placeholder,
      <b>${needWriting}</b> empty.
      ${needWriting ? '<button type="button" class="btn btn-secondary btn-block" id="tw-fill" style="margin-top:var(--space-sm);">Fill the ' + needWriting + ' empty slots with placeholders</button>' : ''}
      ${qualifying} of ${totalTopics} topics are big enough for words of their own
      (${TOPIC_FLOOR.uncommon}+ questions).
      A slot with no word does not exist for players.
    </p>
  ` + subjects.map(r => `
    <div class="tw-subject" data-subject="${escapeHtml(r.key)}">
      <div class="tw-subject__head">
        <span class="tw-subject__name">${escapeHtml(r.emoji + ' ' + r.label)}</span>
        <span class="tw-subject__size">${r.subjectSize} questions</span>
        <button type="button" class="btn btn-secondary tw-subject__save" hidden>Save</button>
      </div>
      ${r.subjectSlots.map(sl => slotHtml(r.key, sl)).join('')}
      ${r.topics.map(t => `
        <div class="tw-topic">
          <div class="tw-topic__head">
            <span class="tw-topic__name">${escapeHtml(t.label)}</span>
            <span class="tw-topic__size">${t.size}</span>
          </div>
          ${t.tiers.length === 0
            ? `<div class="tw-slot tw-slot--none">too small for its own words</div>`
            : t.tiers.map(tr => slotHtml(r.key, tr)).join('')}
        </div>`).join('')}
    </div>`).join('');

  attachTitleWordEditors(box);
}

/**
 * Wire Save and Remove on every editable slot.
 *
 * DELEGATED, so a redraw cannot leave dead buttons behind. Each write reports
 * what actually happened rather than assuming: an RLS refusal returns no error
 * and zero rows, which this page has three times rendered as "Saved!".
 */
// WHAT HAS BEEN TYPED AND NOT YET SAVED, keyed by slot.
//
// The panel redraws from the database after every write — deliberately, so the
// counts, the overlay and the frozen-target notes cannot drift apart. That is
// right for one edit at a time and ruinous for a sitting: type eight words,
// save one, and the redraw wipes the other seven with no warning at all.
//
// Drafts survive the redraw instead. Nothing here is a cache of saved state —
// an entry exists only while a box differs from what the database holds, and it
// is deleted the moment that word lands.
const _twDrafts = new Map();
const twKey = d => `${d.cat}|${d.sub || ''}|${d.tier}`;

/** Warn before losing typed words. There are ~86 of them; retyping is not a joke. */
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (_twDrafts.size === 0) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

/**
 * Put unsaved words back after a redraw, and light up the subjects holding them.
 */
function restoreTitleWordDrafts(box) {
  for (const slot of box.querySelectorAll('.tw-slot')) {
    const input = slot.querySelector('.tw-slot__input');
    if (!input) continue;
    const draft = _twDrafts.get(twKey(slot.dataset));
    if (draft === undefined) continue;
    if (draft === input.value) { _twDrafts.delete(twKey(slot.dataset)); continue; }
    input.value = draft;
    slot.classList.add('tw-slot--dirty');
  }
  refreshSubjectSaveButtons(box);
}

/** Show "Save 4 words" on any subject with unsaved boxes, and hide it otherwise. */
function refreshSubjectSaveButtons(box) {
  for (const subject of box.querySelectorAll('.tw-subject')) {
    const dirty = subject.querySelectorAll('.tw-slot--dirty').length;
    const btn = subject.querySelector('.tw-subject__save');
    if (!btn) continue;
    btn.hidden = dirty === 0;
    btn.disabled = false;
    btn.textContent = dirty === 1 ? 'Save 1 word' : `Save ${dirty} words`;
  }
}

function attachTitleWordEditors(box) {
  restoreTitleWordDrafts(box);

  // ONCE PER ELEMENT, NOT ONCE PER REDRAW.
  //
  // This function runs after every write, and `box` is the same element each
  // time — only its innerHTML is replaced. addEventListener would therefore
  // STACK: ten saves would leave ten bulk-save handlers on one button, all
  // firing together. The pre-existing handlers below use `box.onclick =`, which
  // is idempotent by assignment and hid the hazard from anyone adding a second
  // kind of listener. Everything delegated lives behind this guard now.
  if (!box.dataset.twWired) {
    box.dataset.twWired = '1';
    wireTitleWordDelegates(box);
  }
  // EVERY PASS, unlike the delegates above. The fill button is rebuilt by each
  // redraw — it only exists while something is empty — so wiring it inside the
  // once-only block left it dead from the second draw onward. scenario-admin
  // caught that immediately with "the fill button wrote no placeholders at all",
  // which is the entire reason this panel has a check pressing its buttons.
  wireTitleWordFill(box);
}

function wireTitleWordDelegates(box) {
  // TYPING ACROSS A SUBJECT, RATHER THAN TAPPING SAVE NINETY TIMES.
  //
  // Tab is useless here: between two word boxes it lands on that row's Save and
  // Remove buttons, so writing a subject meant reaching for the pointer on
  // every line. Enter goes to the next word box in the panel, which is the
  // whole flow — type, Enter, type, Enter, then one Save for the subject.
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const input = e.target.closest('.tw-slot__input');
    if (!input) return;
    e.preventDefault();
    const all = [...box.querySelectorAll('.tw-slot__input')];
    const next = all[all.indexOf(input) + 1];
    if (next) { next.focus(); next.select(); }
    else input.blur();
  });

  // A box that differs from what is stored is DIRTY, and says so. Without the
  // marker "Save 4 words" is a number nobody can check, and the owner cannot
  // tell which four.
  box.addEventListener('input', (e) => {
    const input = e.target.closest('.tw-slot__input');
    if (!input) return;
    const slot = input.closest('.tw-slot');
    const saved = input.defaultValue;          // what the redraw rendered
    if (input.value === saved) {
      _twDrafts.delete(twKey(slot.dataset));
      slot.classList.remove('tw-slot--dirty');
    } else {
      _twDrafts.set(twKey(slot.dataset), input.value);
      slot.classList.add('tw-slot--dirty');
    }
    refreshSubjectSaveButtons(box);
  });

  // FILL EVERY EMPTY SLOT AT ONCE.
  //
  // There are roughly eighty-six of them, so a per-row "add placeholder" button
  // would be eighty-six taps and nobody would use it. This is what makes the
  // framework visible to players in one action.
  //
  // The TEXT IS GENERATED BY RULE — tier plus subject, "Epic Science" — and
  // never invented. The real words are the owner's to write, and two earlier
  // attempts at model-written title text were deleted at their instruction. A
  // placeholder must read as scaffolding.
  // ONE SAVE FOR A WHOLE SUBJECT.
  //
  // The unit of work is a subject — you sit down and write History, not one
  // word. Per-row saving meant a round trip and a full redraw per word, ~86
  // times, and the redraw is what made typing ahead unsafe in the first place.
  //
  // Only DIRTY rows are written, so pressing this twice costs nothing, and the
  // panel redraws ONCE at the end rather than after every word.
  box.addEventListener('click', async (e) => {
    const subjectSave = e.target.closest('.tw-subject__save');
    if (!subjectSave) return;
    const subject = subjectSave.closest('.tw-subject');
    const dirty = [...subject.querySelectorAll('.tw-slot--dirty')];
    if (!dirty.length) return;

    subjectSave.disabled = true;
    let done = 0, failed = 0;

    // Batched rather than all at once: each word is a delete plus an insert, so
    // a subject of nine is eighteen statements, and firing them together from a
    // phone is how you get rate-limited. Four at a time keeps it quick without
    // a burst.
    for (let i = 0; i < dirty.length; i += 4) {
      const batch = dirty.slice(i, i + 4);
      subjectSave.textContent = `Saving ${Math.min(i + batch.length, dirty.length)} of ${dirty.length}…`;
      await Promise.all(batch.map(async slot => {
        const { cat, sub, tier, target } = slot.dataset;
        const input = slot.querySelector('.tw-slot__input');
        const word = (input?.value || '').trim();
        // An empty box means "take this word away", exactly as it does on the
        // per-row Save. Typing over a placeholder makes it the owner's word,
        // so the flag goes.
        const result = word
          ? await saveTitleWord({
              slot: 2, category: cat, subcategory: sub || null, tier, word,
              targetRight: Number(target), isPlaceholder: false,
            })
          : await deleteTitleWord({ slot: 2, category: cat, subcategory: sub || null, tier });
        if (result?.error) {
          failed++;
          // ON THE ROW. This panel is thousands of pixels long, so a message at
          // the top is one nobody sees — and the draft is KEPT, so a refused
          // word is still in the box to try again rather than silently lost.
          setStatus(slot.querySelector('.tw-slot__status'),
            `Not saved — ${result.error.message}`, { sticky: true });
        } else {
          done++;
          _twDrafts.delete(twKey(slot.dataset));
        }
      }));
    }

    subjectSave.textContent = failed ? `Saved ${done}, ${failed} refused` : `Saved ${done}`;

    const scroller = box.closest('.screen--scrollable, .admin-scroll') || document.scrollingElement;
    const keepAt = scroller ? scroller.scrollTop : 0;
    resetTitleWordCache();
    clearWordOverlay();
    await loadTitleWordsPanel();
    if (scroller) scroller.scrollTop = keepAt;
  });

}

/**
 * The fill button is REDRAWN on every pass — it only exists while something is
 * empty — so this one really does have to run each time. `onclick` rather than
 * addEventListener, so re-wiring a fresh button cannot stack.
 */
function wireTitleWordFill(box) {
  const fill = box.querySelector('#tw-fill');
  if (fill) fill.onclick = async () => {
    const empties = [...box.querySelectorAll('.tw-slot--empty')]
      .filter(el => el.querySelector('.tw-slot__save'));
    if (!empties.length) return;
    fill.disabled = true;
    let done = 0, failed = 0;
    for (const el of empties) {
      const { cat, sub, tier, target, label } = el.dataset;
      fill.textContent = `Filling ${done + failed + 1} of ${empties.length}\u2026`;
      const { error } = await saveTitleWord({
        slot: 2, category: cat, subcategory: sub || null, tier,
        word: placeholderWord(tier, label), targetRight: Number(target),
        isPlaceholder: true,
      });
      if (error) failed++; else done++;
    }
    fill.textContent = failed
      ? `Added ${done}, ${failed} refused`
      : `Added ${done} placeholders`;
    resetTitleWordCache();
    clearWordOverlay();
    await loadTitleWordsPanel();
  };

  box.onclick = async (e) => {
    const saveBtn = e.target.closest('.tw-slot__save');
    const removeBtn = e.target.closest('.tw-slot__remove');
    if (!saveBtn && !removeBtn) return;

    const slot = e.target.closest('.tw-slot');
    if (!slot) return;
    const { cat, sub, tier, target } = slot.dataset;
    const input = slot.querySelector('.tw-slot__input');
    const btn = saveBtn || removeBtn;
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';

    try {
      let result;
      if (removeBtn) {
        result = await deleteTitleWord({ slot: 2, category: cat, subcategory: sub || null, tier });
      } else {
        const word = (input?.value || '').trim();
        // An empty box on Save means "take this word away" rather than an error
        // — it is what somebody clearing the field expects, and refusing it
        // would leave no way to undo a word from the keyboard.
        result = word
          ? await saveTitleWord({
              slot: 2, category: cat, subcategory: sub || null, tier, word,
              targetRight: Number(target),
              // TYPING OVER A PLACEHOLDER MAKES IT THE OWNER'S WORD. Keeping the
              // flag would leave the count saying there is still work to do on a
              // slot that is finished, which is the one number this page exists
              // to get right.
              isPlaceholder: false,
            })
          : await deleteTitleWord({ slot: 2, category: cat, subcategory: sub || null, tier });
      }

      if (result?.error) {
        // ON THE ROW, not in a page-level bar. This panel is thousands of
        // pixels long, so a message at the top is one the owner never sees —
        // and a save that fails silently is the exact fault this page has
        // shipped three times.
        setStatus(slot.querySelector('.tw-slot__status'),
          `Not saved — ${result.error.message}`, { sticky: true });
        btn.disabled = false;
        btn.textContent = label;
        return;
      }
      // Redraw from the database rather than patching the row: the overlay,
      // the counts at the top and the frozen-target note all move together,
      // and keeping three of them in step by hand is how they drift apart.
      //
      // KEEP THE READER WHERE THEY WERE. This panel is thousands of pixels
      // long and the owner has ~86 words to write, so being thrown back to
      // History after every save would make the tool unusable for the one job
      // it exists for. Captured from whichever ancestor actually scrolls,
      // because that differs between this page's layout and a plain document.
      const scroller = box.closest('.screen--scrollable, .admin-scroll') || document.scrollingElement;
      const keepAt = scroller ? scroller.scrollTop : 0;

      resetTitleWordCache();
      clearWordOverlay();
      await loadTitleWordsPanel();
      if (scroller) scroller.scrollTop = keepAt;
    } catch (err) {
      logger.error('Admin', 'title word write failed', err);
      setStatus(slot.querySelector('.tw-slot__status'),
        `Not saved — ${err?.message || err}`, { sticky: true });
      btn.disabled = false;
      btn.textContent = label;
    }
  };
}


/**
 * How many "what you know" words exist, counted from TITLE_WORDS alone.
 *
 * Exact and free. The complement — how many are still to WRITE — is not
 * computable here: it depends on which topics are big enough to offer a tier,
 * and that needs a count per topic against the bank. Opening the panel does
 * that work and prints the real figure.
 */
function countWrittenTitleWords() {
  return Object.values(TITLE_WORDS).filter(w => w.slot === 2).length;
}
