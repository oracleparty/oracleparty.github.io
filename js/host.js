// ============================================
// Oracle Party — Host Flow
// Category selection, settings, room creation
// ============================================

import { $, $$, transitionScreens } from './utils.js';
import { fetchCategories, createRoom, addPlayer, fetchCategoryPlayCounts, fetchQuestionCount, fetchMasteryCounts } from './supabase.js';
import { getDisplayName, ensureDisplayName, initAuth, getCurrentUser } from './auth.js';
import { initThemeToggle } from './theme.js';

// --- Category display config ---
const CATEGORY_META = {
  'history':          { icon: '\u23F3', label: 'History', subcategories: [
    { key: 'ancient', icon: '\uD83C\uDFDB\uFE0F', label: 'Ancient' },
    { key: 'medieval', icon: '\uD83D\uDEE1\uFE0F', label: 'Medieval' },
    { key: 'early-modern', icon: '\uD83D\uDD2D', label: 'Early Modern' },
    { key: 'modern', icon: '\uD83D\uDE80', label: 'Modern' },
  ]},
  'science':          { icon: '\u2697\uFE0F', label: 'Science', subcategories: [
    { key: 'human-body', icon: '🧬', label: 'Human Body' },
    { key: 'elements', icon: '🧪', label: 'Elements' },
    { key: 'space', icon: '🪐', label: 'Space' },
    { key: 'misc', icon: '🔬', label: 'Misc' },
  ]},
  'nature':           { icon: '\uD83C\uDF3F', label: 'Nature' },
  'arts-literature':  { icon: '\uD83D\uDCDC', label: 'Arts & Literature' },
  'culture-society':  { icon: '\uD83C\uDFDB\uFE0F', label: 'Culture & Society' },
  'pop-culture':      { icon: '\uD83C\uDFAC', label: 'Pop Culture' },
  'world-geography':  { icon: '\uD83D\uDDFA\uFE0F', label: 'World Geography' },
  'technology':       { icon: '\u26A1', label: 'Technology' },
  'sports':           { icon: '\uD83C\uDFC6', label: 'Sports' },
  'food':             { icon: '\uD83C\uDF7D\uFE0F', label: 'Food & Drink' },
  'logic':            { icon: '\uD83E\uDDE9', label: 'Logic' },
  'wild-card':        { icon: '\uD83C\uDFB2', label: 'Wild Card' }
};

// --- State ---
let categories = [];
let categoryPlayCounts = {};
let selectedCategory = null;
let selectedSubcategory = null;
let _masteryCounts = {}; // { categoryName: masteredCount }
let _isLoggedIn = false;
let settings = {
  whoCanJoin: 'anyone',
  questionsPerGame: 10,
  questionTimer: 30,
  autoProceed: 0
};

// --- DOM refs ---
const categoryScreen = $('#category-screen');
const settingsScreen = $('#settings-screen');
const categoryGrid = $('#category-grid');
const searchInput = $('#category-search');
const btnHostGame = $('#btn-host-game');
const hostError = $('#host-error');

// --- Init ---
async function init() {
  try {
    await Promise.all([ensureDisplayName(), initAuth()]);
    categories = await fetchCategories();
    // Play counts are non-critical — don't let failure break category loading
    try {
      categoryPlayCounts = await fetchCategoryPlayCounts();
    } catch (e) {
      console.warn('[Host] Could not load play counts:', e);
      categoryPlayCounts = {};
    }
    // Load mastery for logged-in users (non-critical)
    const authUser = getCurrentUser();
    if (authUser?.user?.id) {
      _isLoggedIn = true;
      try {
        const masteryData = await fetchMasteryCounts(authUser.user.id);
        for (const m of masteryData) {
          _masteryCounts[m.category] = (_masteryCounts[m.category] || 0) + m.mastered;
        }
      } catch (e) { console.warn('[Host] Could not load mastery:', e); }
    }
    renderCategories(categories, categoryPlayCounts);
  } catch (err) {
    console.error('[Host] Init error:', err);
  }
  // Always attach listeners even if data fetch fails
  attachListeners();
  initThemeToggle();

  // Trap browser back button — always go to index.html
  history.pushState({ page: 'host' }, '');
  window.addEventListener('popstate', () => { window.location.href = 'index.html'; });
}

// --- Render category cards ---
function renderCategories(cats, playCounts = {}) {
  categoryGrid.innerHTML = cats.map(cat => {
    const meta = CATEGORY_META[cat.name] || { icon: '?', label: cat.name };
    const plays = playCounts[cat.name] || 0;
    const mastered = _masteryCounts[cat.name] || 0;
    const total = cat.count || 1;
    const pct = Math.round((mastered / total) * 100);
    const masteryHtml = _isLoggedIn && mastered > 0 ? `
      <div class="category-card__mastery">
        <span class="category-card__mastery-text">${mastered}/${total} mastered</span>
        <div class="category-card__mastery-bar">
          <div class="category-card__mastery-fill" style="width: ${pct}%"></div>
        </div>
      </div>
    ` : '';
    return `
      <div class="category-card" data-category="${cat.name}">
        <div class="category-card__icon">${meta.icon}</div>
        <div class="category-card__name">${meta.label}</div>
        <div class="category-card__count">${cat.count} questions</div>
        <div class="category-card__plays">${plays.toLocaleString()} plays</div>
        ${masteryHtml}
      </div>
    `;
  }).join('');

  // Collapse subcategory view when categories re-render (e.g. search)
  const subView = $('#subcategory-view');
  if (subView) subView.style.display = 'none';
  const catList = $('#category-list');
  if (catList) catList.style.display = '';
}

// --- Subcategory drill-in ---
function drillIntoSubcategories(cat, meta) {
  const catList = $('#category-list');
  const subView = $('#subcategory-view');
  const title = $('#subcategory-view__title');
  const options = $('#subcategory-view__options');

  title.textContent = `${meta.icon} ${meta.label}`;
  options.innerHTML = `
    <div class="subcategory-row subcategory-row--all" data-category="${cat.name}" data-subcategory="">
      <span class="subcategory-row__icon">${meta.icon}</span>
      <span class="subcategory-row__label">All ${meta.label}</span>
      <span class="subcategory-row__count">${cat.count} Qs</span>
    </div>
    ${meta.subcategories.map(s => `
      <div class="subcategory-row" data-category="${cat.name}" data-subcategory="${s.key}">
        <span class="subcategory-row__icon">${s.icon}</span>
        <span class="subcategory-row__label">${s.label}</span>
        <span class="subcategory-row__count" data-sub-count="${s.key}"></span>
      </div>
    `).join('')}
  `;

  catList.style.display = 'none';
  subView.style.display = '';
  // Scroll to top of the screen
  document.querySelector('#category-screen')?.scrollTo(0, 0);

  // Async-load subcategory question counts
  meta.subcategories.forEach(async (s) => {
    const count = await fetchQuestionCount(cat.name, s.key);
    const el = options.querySelector(`[data-sub-count="${s.key}"]`);
    if (el) el.textContent = `${count} Qs`;
  });
}

function drillBack() {
  const catList = $('#category-list');
  const subView = $('#subcategory-view');
  subView.style.display = 'none';
  catList.style.display = '';
}

// --- Category bottom sheet (for settings screen) ---
function openCategorySheet() {
  const sheet = $('#category-sheet');
  const list = $('#category-sheet-list');

  list.innerHTML = categories.map(cat => {
    const meta = CATEGORY_META[cat.name] || { icon: '?', label: cat.name };
    const hasSubs = meta.subcategories?.length > 0;
    const isSelected = selectedCategory?.name === cat.name;
    return `
      <div class="category-sheet-row${isSelected ? ' selected' : ''}" data-category="${cat.name}">
        <span class="category-sheet-row__icon">${meta.icon}</span>
        <span class="category-sheet-row__label">${meta.label}</span>
        ${hasSubs ? '<span class="category-sheet-row__chevron">›</span>' : ''}
      </div>
    `;
  }).join('');

  sheet.classList.add('active');

  // Dismiss on backdrop
  sheet.querySelector('.bottom-sheet__backdrop').onclick = () => sheet.classList.remove('active');
}

function showCategorySheetSubcategories(cat, meta) {
  const list = $('#category-sheet-list');
  list.innerHTML = `
    <div class="category-sheet-back" data-action="back">← ${meta.label}</div>
    <div class="category-sheet-row subcategory-row--all" data-category="${cat.name}" data-subcategory="">
      <span class="category-sheet-row__icon">${meta.icon}</span>
      <span class="category-sheet-row__label">All ${meta.label}</span>
    </div>
    ${meta.subcategories.map(s => `
      <div class="category-sheet-row" data-category="${cat.name}" data-subcategory="${s.key}">
        <span class="category-sheet-row__icon">${s.icon}</span>
        <span class="category-sheet-row__label">${s.label}</span>
      </div>
    `).join('')}
  `;
}

// --- Attach all event listeners ---
function attachListeners() {
  // Back to home
  $('#btn-back-home').addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  // Back to category screen — reset drill-in state
  $('#btn-back-category').addEventListener('click', () => {
    drillBack(); // Ensure category grid is visible, subcategory view hidden
    transitionScreens(settingsScreen, categoryScreen);
  });

  // Category search
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      renderCategories(categories, categoryPlayCounts);
      return;
    }
    const filtered = categories.filter(cat => {
      const meta = CATEGORY_META[cat.name] || { label: cat.name };
      return meta.label.toLowerCase().includes(query) || cat.name.toLowerCase().includes(query);
    });
    renderCategories(filtered, categoryPlayCounts);
  });

  // Category card selection (event delegation)
  categoryGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.category-card');
    if (!card) return;
    const catName = card.dataset.category;
    const cat = categories.find(c => c.name === catName);
    if (!cat) return;
    const meta = CATEGORY_META[catName];

    if (meta?.subcategories?.length) {
      drillIntoSubcategories(cat, meta);
      return;
    }

    selectedCategory = cat;
    selectedSubcategory = null;
    showSettings(cat);
  });

  // Subcategory view — option tap + back arrow
  $('#subcategory-view__options').addEventListener('click', (e) => {
    const row = e.target.closest('.subcategory-row');
    if (!row) return;
    const catName = row.dataset.category;
    const cat = categories.find(c => c.name === catName);
    if (!cat) return;
    selectedCategory = cat;
    selectedSubcategory = row.dataset.subcategory || null;
    showSettings(cat);
  });
  $('#subcategory-back').addEventListener('click', drillBack);

  // Settings badge — tap to open category sheet
  $('#selected-category').addEventListener('click', openCategorySheet);

  // Category sheet — row taps
  $('#category-sheet-list').addEventListener('click', (e) => {
    const back = e.target.closest('[data-action="back"]');
    if (back) { openCategorySheet(); return; } // Go back to full list

    const row = e.target.closest('.category-sheet-row');
    if (!row) return;
    const catName = row.dataset.category;
    const cat = categories.find(c => c.name === catName);
    if (!cat) return;
    const meta = CATEGORY_META[catName];

    // If row has subcategory attribute, it's a subcategory selection
    if (row.dataset.subcategory !== undefined) {
      selectedCategory = cat;
      selectedSubcategory = row.dataset.subcategory || null;
      $('#category-sheet').classList.remove('active');
      showSettingsUpdate();
      return;
    }

    // If category has subs, drill into subcategory list
    if (meta?.subcategories?.length) {
      showCategorySheetSubcategories(cat, meta);
      return;
    }

    // No subs — select directly
    selectedCategory = cat;
    selectedSubcategory = null;
    $('#category-sheet').classList.remove('active');
    showSettingsUpdate();
  });

  // Toggle selectors (event delegation)
  $$('.toggle-group').forEach(group => {
    group.addEventListener('click', (e) => {
      const option = e.target.closest('.toggle-option');
      if (!option) return;

      // Update active state
      $$('.toggle-option', group).forEach(o => o.classList.remove('active'));
      option.classList.add('active');

      // Update settings
      const settingKey = group.dataset.setting;
      const value = option.dataset.value;
      if (settingKey === 'questionsPerGame' || settingKey === 'questionTimer' || settingKey === 'autoProceed') {
        settings[settingKey] = parseInt(value, 10);
      } else {
        settings[settingKey] = value;
      }
    });
  });

  // Host Game button
  btnHostGame.addEventListener('click', handleHostGame);
}

// --- Show settings screen with selected category ---
async function _updateSettingsBadge(cat) {
  if (!cat) return;
  const meta = CATEGORY_META[cat.name] || { icon: '?', label: cat.name };
  let icon = meta.icon;
  let label = meta.label;
  if (selectedSubcategory && meta.subcategories) {
    const sub = meta.subcategories.find(s => s.key === selectedSubcategory);
    if (sub) {
      icon = sub.icon;
      label = `${meta.label} \u2014 ${sub.label}`;
    }
  }
  $('.selected-category__icon').textContent = icon;
  $('.selected-category__name').textContent = label;

  // Show subcategory count if selected, otherwise parent count
  const countEl = $('.selected-category__count');
  if (selectedSubcategory) {
    countEl.textContent = ''; // Clear while loading
    const subCount = await fetchQuestionCount(cat.name, selectedSubcategory);
    countEl.textContent = `${subCount} questions`;
  } else {
    countEl.textContent = cat.count ? `${cat.count} questions` : '';
  }
}

function showSettings(cat) {
  _updateSettingsBadge(cat);
  hostError.textContent = '';
  transitionScreens(categoryScreen, settingsScreen);
}

/** Update settings badge without screen transition (used by category sheet). */
function showSettingsUpdate() {
  if (!selectedCategory) return;
  _updateSettingsBadge(selectedCategory);
}

// --- Create room and navigate to lobby ---


async function handleHostGame() {
  if (!selectedCategory) {
    hostError.textContent = 'Please select a category first.';
    return;
  }

  btnHostGame.classList.add('is-loading');
  btnHostGame.textContent = 'Creating...';
  hostError.textContent = '';

  try {
    const hostName = getDisplayName();
    const { data, error } = await createRoom({
      hostName,
      category: selectedCategory.name,
      subcategory: selectedSubcategory || null,
      whoCanJoin: settings.whoCanJoin,
      questionsPerGame: settings.questionsPerGame,
      questionTimer: settings.questionTimer,
      autoProceed: settings.autoProceed
    });

    if (error) {
      const msg = error.message || 'Unknown error';
      hostError.textContent = `Failed to create room: ${msg}`;
      console.error('[Host] Room creation error:', error);
      resetHostButton();
      return;
    }

    if (!data) {
      hostError.textContent = 'Room was not created. Check Supabase RLS policies on the rooms table.';
      console.error('[Host] createRoom returned null data with no error — likely an RLS policy issue.');
      resetHostButton();
      return;
    }

    // Add host as a player in the room
    const authUser = getCurrentUser();
    const userId = authUser?.user?.id || null;
    const extras = {};
    if (authUser?.profile) {
      extras.avatarColor = authUser.profile.avatar_color;
      extras.avatarEmoji = authUser.profile.avatar_emoji;
      extras.title = authUser.profile._cachedTitle || null;
    }
    const { data: player, error: playerErr } = await addPlayer(data.id, hostName, true, userId, extras);
    if (playerErr || !player) {
      hostError.textContent = 'Room created but failed to join. Try again.';
      console.error('[Host] addPlayer failed:', playerErr);
      resetHostButton();
      return;
    }

    // Store room + player data for lobby
    sessionStorage.setItem('oracle_party_room', JSON.stringify({
      id: data.id,
      code: data.code,
      hostName: data.host_name,
      category: data.category,
      subcategory: data.subcategory || null,
      isHost: true,
      playerId: player.id,
      settings: {
        whoCanJoin: data.who_can_join,
        questionsPerGame: data.questions_per_game,
        questionTimer: data.question_timer,
        autoProceed: data.auto_proceed || 0
      }
    }));

    window.location.href = 'lobby.html';
  } catch (err) {
    console.error('[Host] Unexpected error in handleHostGame:', err);
    hostError.textContent = `Unexpected error: ${err.message}`;
    resetHostButton();
  }
}

function resetHostButton() {
  btnHostGame.classList.remove('is-loading');
  btnHostGame.textContent = 'Host Game';
}

// --- Start ---
init();
