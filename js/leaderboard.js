// ============================================
// Oracle Party — Leaderboards
// Global, Weekly, Per-Category, Friends
// ============================================

import { $, $$, escapeHtml, renderAvatar, navigateWithFade } from './utils.js';
import { LEADERBOARD_LIMIT } from './constants.js';
import {
  fetchPlayerTotalsForLeaderboard,
  fetchCategoryLeaderboard,
  fetchGameHistorySince,
  fetchProfilesBatch,
  fetchFriends
} from './supabase.js';
import { ensureDisplayName, initAuth, getCurrentUser } from './auth.js';
import { initThemeToggle } from './theme.js';
import { TITLE_WORDS, buildDisplayTitle } from './titles.js';
import { CATEGORY_META } from './categories.js';

// ============================================
// INIT
// ============================================

async function init() {
  // Cancel the boot-guard timer in <head> — JS module chain is alive.
  window.__appReady = true;
  if (window.__appBootGuard) clearTimeout(window.__appBootGuard);
  document.body.style.opacity = '1';
  await initAuth();
  initThemeToggle();

  // Tab switching
  const tabs = $$('.profile-tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => {
        const isActive = t.dataset.tab === tab.dataset.tab;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      $$('.leaderboard-tab').forEach(el => { el.style.display = 'none'; });
      $(`#tab-${tab.dataset.tab}`).style.display = '';
      loadTab(tab.dataset.tab);
    });
  });

  // Category selector
  $('#lb-category-select').onchange = () => {
    updateSubcategorySelect();
    _loadedTabs.delete('category');
    loadTab('category');
  };
  $('#lb-subcategory-select').onchange = () => {
    _loadedTabs.delete('category');
    loadTab('category');
  };

  // Initialize subcategory select for default category
  updateSubcategorySelect();

  // Back button
  $('#btn-back').addEventListener('click', () => { navigateWithFade('index.html'); });
  history.pushState({ page: 'leaderboard' }, '');
  window.addEventListener('popstate', () => { window.location.href = 'index.html'; });

  // Weekly reset note
  const monday = getLastMonday();
  $('#weekly-reset-note').textContent = `Resets every Monday. Current week: ${monday.toLocaleDateString()}`;

  // Load default tab
  loadTab('global');
}

const _loadedTabs = new Set();

async function loadTab(tab) {
  if (tab === 'global' && !_loadedTabs.has('global')) {
    _loadedTabs.add('global');
    await loadGlobalLeaderboard();
  } else if (tab === 'weekly' && !_loadedTabs.has('weekly')) {
    _loadedTabs.add('weekly');
    await loadWeeklyLeaderboard();
  } else if (tab === 'category') {
    // Always reload on category change
    await loadCategoryLeaderboard();
  } else if (tab === 'friends' && !_loadedTabs.has('friends')) {
    _loadedTabs.add('friends');
    await loadFriendsLeaderboard();
  }
}

// ============================================
// GLOBAL LEADERBOARD
// ============================================

async function loadGlobalLeaderboard() {
  const container = $('#lb-global-list');
  const allStats = await fetchPlayerTotalsForLeaderboard();

  // Aggregate per user.
  //
  // "Points" is CORRECT ANSWERS, deliberately not the score from the game.
  // A game score depends on which wagers a player happened to hold and on
  // which host was judging — including any judgement they overrode — so it is
  // not comparable between two people who never played together. Correct
  // answers is the same measurement for everybody.
  //
  // The rows come from player_totals_computed, which counts each answered
  // question once. Summing the per-category rows here instead would count a
  // question filed under two topics twice — see fetchPlayerTotalsForLeaderboard.
  // The loop survives either source: the fallback returns one row per
  // category, and games are per-category in both, so adding up is correct.
  const userMap = {};
  for (const s of allStats) {
    if (!userMap[s.user_id]) userMap[s.user_id] = { totalScore: 0, gamesPlayed: 0, wins: 0 };
    userMap[s.user_id].gamesPlayed += s.games_played || 0;
    userMap[s.user_id].wins += s.wins || 0;
    userMap[s.user_id].totalScore += s.correct_answers || 0;
  }

  // Sort by total score desc, take top 50
  const sorted = Object.entries(userMap)
    .sort((a, b) => b[1].totalScore - a[1].totalScore)
    .slice(0, LEADERBOARD_LIMIT);

  if (sorted.length === 0) {
    container.innerHTML = '<p class="leaderboard-empty">No players yet. Be the first!</p>';
    return;
  }

  // Fetch profiles for display
  const profiles = await fetchProfilesBatch(sorted.map(([uid]) => uid));
  const profileMap = {};
  for (const p of profiles) profileMap[p.user_id] = p;

  const currentUser = getCurrentUser();
  const myId = currentUser?.user?.id;

  container.innerHTML = sorted.map(([uid, data], i) => {
    const p = profileMap[uid] || {};
    const winRate = data.gamesPlayed > 0 ? Math.round((data.wins / data.gamesPlayed) * 100) : 0;
    const title = buildProfileTitle(p);
    const isMe = uid === myId;
    return renderRow(i + 1, p, title, `${data.totalScore} pts`, `${data.gamesPlayed} games · ${winRate}% wins`, isMe);
  }).join('');
}

// ============================================
// WEEKLY LEADERBOARD
// ============================================

function getLastMonday() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

async function loadWeeklyLeaderboard() {
  const container = $('#lb-weekly-list');
  const monday = getLastMonday();
  const games = await fetchGameHistorySince(monday.toISOString());

  if (games.length === 0) {
    container.innerHTML = '<p class="leaderboard-empty">No games played this week yet.</p>';
    return;
  }

  // Aggregate per user
  const userMap = {};
  for (const g of games) {
    if (!userMap[g.user_id]) userMap[g.user_id] = { totalScore: 0, gamesPlayed: 0, wins: 0 };
    userMap[g.user_id].totalScore += g.score || 0;
    userMap[g.user_id].gamesPlayed++;
    if (g.placement === 1) userMap[g.user_id].wins++;
  }

  const sorted = Object.entries(userMap)
    .sort((a, b) => b[1].totalScore - a[1].totalScore)
    .slice(0, LEADERBOARD_LIMIT);

  const profiles = await fetchProfilesBatch(sorted.map(([uid]) => uid));
  const profileMap = {};
  for (const p of profiles) profileMap[p.user_id] = p;

  const currentUser = getCurrentUser();
  const myId = currentUser?.user?.id;

  container.innerHTML = sorted.map(([uid, data], i) => {
    const p = profileMap[uid] || {};
    const title = buildProfileTitle(p);
    const isMe = uid === myId;
    return renderRow(i + 1, p, title, `${data.totalScore} pts`, `${data.gamesPlayed} games · ${data.wins} wins`, isMe);
  }).join('');
}

// ============================================
// CATEGORY LEADERBOARD
// ============================================

function updateSubcategorySelect() {
  const category = $('#lb-category-select').value;
  const subSelect = $('#lb-subcategory-select');
  const meta = CATEGORY_META[category];
  const subs = meta?.subcategories;
  if (subs?.length) {
    // Build hierarchical options with indentation
    function buildOptions(items, depth) {
      let html = '';
      for (const item of items) {
        const indent = '\u00A0\u00A0'.repeat(depth);
        html += `<option value="${item.key}">${indent}${item.label}</option>`;
        if (item.children) html += buildOptions(item.children, depth + 1);
      }
      return html;
    }
    subSelect.innerHTML = `<option value="">All</option>` + buildOptions(subs, 0);
    subSelect.style.display = '';
  } else {
    subSelect.innerHTML = '';
    subSelect.style.display = 'none';
  }
}

async function loadCategoryLeaderboard() {
  const container = $('#lb-category-list');
  const category = $('#lb-category-select').value;
  const subcategory = $('#lb-subcategory-select').value || null;
  container.innerHTML = '<p class="leaderboard-loading">Loading...</p>';

  const stats = await fetchCategoryLeaderboard(category, subcategory);

  if (stats.length === 0) {
    container.innerHTML = '<p class="leaderboard-empty">No qualified players yet (min 20 questions).</p>';
    return;
  }

  // Sort by accuracy desc
  const sorted = stats
    .map(s => ({ ...s, accuracy: Math.round((s.correct_answers / s.questions_answered) * 100) }))
    .sort((a, b) => b.accuracy - a.accuracy || b.questions_answered - a.questions_answered)
    .slice(0, LEADERBOARD_LIMIT);

  const profiles = await fetchProfilesBatch(sorted.map(s => s.user_id));
  const profileMap = {};
  for (const p of profiles) profileMap[p.user_id] = p;

  const currentUser = getCurrentUser();
  const myId = currentUser?.user?.id;

  container.innerHTML = sorted.map((s, i) => {
    const p = profileMap[s.user_id] || {};
    const title = buildProfileTitle(p);
    const isMe = s.user_id === myId;
    return renderRow(i + 1, p, title, `${s.accuracy}%`, `${s.questions_answered} Qs · ${s.correct_answers} correct`, isMe);
  }).join('');
}

// ============================================
// FRIENDS LEADERBOARD
// ============================================

async function loadFriendsLeaderboard() {
  const container = $('#lb-friends-list');
  const currentUser = getCurrentUser();

  if (!currentUser) {
    container.innerHTML = '<p class="leaderboard-empty">Create an account to see your friends leaderboard.</p>';
    return;
  }

  const friends = await fetchFriends(currentUser.user.id);
  if (friends.length === 0) {
    container.innerHTML = '<p class="leaderboard-empty">Add friends to compete on this leaderboard!</p>';
    return;
  }

  // Include self + friends
  const friendIds = friends.map(f => f.user_id);
  friendIds.push(currentUser.user.id);

  const allStats = await fetchPlayerTotalsForLeaderboard();
  const friendStats = allStats.filter(s => friendIds.includes(s.user_id));

  // Aggregate per user
  const userMap = {};
  for (const s of friendStats) {
    if (!userMap[s.user_id]) userMap[s.user_id] = { totalScore: 0, gamesPlayed: 0, wins: 0 };
    userMap[s.user_id].gamesPlayed += s.games_played || 0;
    userMap[s.user_id].wins += s.wins || 0;
    userMap[s.user_id].totalScore += s.correct_answers || 0;
  }

  const sorted = Object.entries(userMap)
    .sort((a, b) => b[1].totalScore - a[1].totalScore);

  const profiles = await fetchProfilesBatch(sorted.map(([uid]) => uid));
  const profileMap = {};
  for (const p of profiles) profileMap[p.user_id] = p;

  const myId = currentUser.user.id;

  container.innerHTML = sorted.map(([uid, data], i) => {
    const p = profileMap[uid] || {};
    const winRate = data.gamesPlayed > 0 ? Math.round((data.wins / data.gamesPlayed) * 100) : 0;
    const title = buildProfileTitle(p);
    const isMe = uid === myId;
    return renderRow(i + 1, p, title, `${data.totalScore} pts`, `${data.gamesPlayed} games · ${winRate}% wins`, isMe);
  }).join('');
}

// ============================================
// RENDERING HELPERS
// ============================================

function buildProfileTitle(profile) {
  if (!profile || !profile.title_builder_unlocked) return 'Novice';
  const parts = [profile.title_slot1, profile.title_slot2, profile.title_slot3].filter(Boolean);
  if (parts.length === 0) return 'Novice';
  return parts.map(id => TITLE_WORDS[id]?.word || id).join(' ');
}

function renderRow(rank, profile, title, primaryStat, secondaryStat, isMe) {
  const avatar = renderAvatar({
    displayName: profile.display_name || '?',
    avatarColor: profile.avatar_color || null,
    avatarEmoji: profile.avatar_emoji || null,
    size: '28px'
  });
  const name = escapeHtml(profile.display_name || 'Unknown');
  const meClass = isMe ? ' leaderboard-row--me' : '';

  return `
    <div class="leaderboard-row${meClass}">
      <span class="leaderboard-rank">${rank}</span>
      ${avatar}
      <div class="leaderboard-row__info">
        <div class="leaderboard-row__name">${name}</div>
        <div class="leaderboard-row__title">${escapeHtml(title)}</div>
      </div>
      <div class="leaderboard-row__stats">
        <div class="leaderboard-row__primary">${primaryStat}</div>
        <div class="leaderboard-row__secondary">${secondaryStat}</div>
      </div>
    </div>
  `;
}

// --- Start ---
init();
