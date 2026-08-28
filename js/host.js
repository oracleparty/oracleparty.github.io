// ============================================
// Oracle Party — Host Flow
// Category selection, settings, room creation
// ============================================

import { $, $$, transitionScreens, showToast, navigateWithFade } from './utils.js';
import { fetchCategories, createRoom, addPlayer, fetchCategoryPlayCounts, fetchQuestionCount, fetchMasteryCounts, fetchAllOpenQuestionCount, fetchExclusiveWildCardCount } from './supabase.js';
import { getDisplayName, ensureDisplayName, initAuth, getCurrentUser, getAuthUserId } from './auth.js';
import { initThemeToggle } from './theme.js';
import { logger } from './logger.js';
import { CATEGORY_META, resolveCategoryLabel, resolveSubcategoryIcon, findSubcategoryNode } from './categories.js';
import { CATEGORY_CACHE_TTL, MASTERY_HIGH_THRESHOLD, MASTERY_COMPLETE_THRESHOLD } from './constants.js';

// --- State ---
let categories = [];
let categoryPlayCounts = {};
let selectedCategory = null;
let selectedSubcategory = null;
let _masteryCounts = {}; // { categoryName: masteredCount }
let navStack = [];      // Navigation stack for multi-level subcategory drill-down
let sheetNavStack = []; // Navigation stack for category bottom sheet
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

// --- Category cache (localStorage) ---
const CACHE_KEY = 'op_categories';
const CACHE_TTL = CATEGORY_CACHE_TTL; // from constants.js

function getCachedCategories() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL) return null;
    return data;
  } catch { return null; }
}

function setCachedCategories(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data })); }
  catch { /* quota exceeded — ignore */ }
}

// --- Init ---
async function init() {
  // Tell the boot-guard timer (in host.html <head>) that the JS module chain
  // loaded. If we never reach this line, the guard renders a connection-error
  // page instead of an empty grid.
  window.__appReady = true;
  if (window.__appBootGuard) clearTimeout(window.__appBootGuard);
  document.body.style.opacity = '1';

  // 1) Instant render from cache OR show skeletons
  const cached = getCachedCategories();
  const hadCache = cached && cached.length > 0;
  if (hadCache) {
    categories = cached;
    renderCategories(categories, categoryPlayCounts);
  } else {
    categoryGrid.innerHTML = Array(6).fill('<div class="skeleton skeleton-card"></div>').join('');
  }

  // 2) Auth (required before fetching user-specific data)
  try {
    await Promise.all([ensureDisplayName(), initAuth()]);
  } catch (err) {
    logger.error('Host', 'Auth error', err);
  }

  // 3) Fetch categories + play counts + mastery all in parallel
  const authUser = getCurrentUser();
  if (authUser?.user?.id) _isLoggedIn = true;

  let categoriesError = null;
  const [freshCategories, playCounts, masteryData] = await Promise.all([
    fetchCategories().catch(err => {
      // Capture the actual error so we can show it in the empty state below
      // — "Failed to load categories" alone is unactionable for the user.
      logger.error('Host', 'fetchCategories', err);
      console.error('[Host] fetchCategories failed:', err);
      categoriesError = err;
      return null;
    }),
    fetchCategoryPlayCounts().catch(e => { logger.warn('Host', 'Could not load play counts', e); return {}; }),
    _isLoggedIn
      ? fetchMasteryCounts(authUser.user.id).catch(e => { logger.warn('Host', 'Could not load mastery', e); return []; })
      : Promise.resolve([])
  ]);

  // 4) Apply results
  if (playCounts && typeof playCounts === 'object') categoryPlayCounts = playCounts;
  if (masteryData && masteryData.length) {
    for (const m of masteryData) _masteryCounts[m.category] = (_masteryCounts[m.category] || 0) + m.mastered;
  }
  if (freshCategories && freshCategories.length) {
    categories = freshCategories;
    setCachedCategories(freshCategories);
  }

  // 5) Render or patch
  if (!hadCache) {
    // First visit — replace skeletons with full render
    if (categories.length) {
      renderCategories(categories, categoryPlayCounts);
    } else {
      const reason = categoriesError
        ? `${categoriesError.message || 'Unknown error'}${categoriesError.code ? ' (' + categoriesError.code + ')' : ''}`
        : 'Empty result from server';
      // Escape user-facing error text — Supabase error.message is server-controlled
      const safe = String(reason).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      categoryGrid.innerHTML =
        '<div class="empty-state">' +
          '<p class="empty-state__text">Failed to load categories</p>' +
          '<p class="empty-state__subtext">Check your connection and refresh</p>' +
          '<details style="margin-top:12px;font-size:12px;color:var(--color-text-muted, #888);text-align:left;max-width:320px;margin-inline:auto;">' +
            '<summary style="cursor:pointer;text-align:center;">Show details</summary>' +
            '<code style="display:block;white-space:pre-wrap;word-break:break-word;margin-top:8px;font-family:ui-monospace,monospace;">' + safe + '</code>' +
          '</details>' +
          '<button class="btn" style="margin-top:16px;" onclick="location.reload()">Retry</button>' +
        '</div>';
      showToast('Failed to load categories', 'error');
    }
  } else {
    // Return visit — cards already visible from cache. Patch in-place to avoid blink.
    patchCategoryCards(categoryPlayCounts);
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
    // Mastery tier for card border glow
    const tier = pct >= MASTERY_COMPLETE_THRESHOLD ? 'complete' : pct >= MASTERY_HIGH_THRESHOLD ? 'high' : '';
    const tierAttr = tier ? ` data-mastery-tier="${tier}"` : '';
    // Ring markup — only for logged-in users
    const ringHtml = _isLoggedIn ? `<div class="category-card__ring" style="--mastery-pct: ${pct}"></div>` : '';
    // Wild-card card shows a placeholder count — replaced with total DB count async
    const countId = cat.name === 'wild-card' ? 'id="wc-card-count"' : '';
    const displayCount = cat.count;
    return `
      <div class="category-card" data-category="${cat.name}" data-hiero="${meta.icon}"${tierAttr}>
        <div class="category-card__icon-wrap">
          ${ringHtml}
          <div class="category-card__icon">${meta.emoji || meta.icon}</div>
        </div>
        <div class="category-card__name">${meta.label}</div>
        <div class="category-card__count" ${countId}>${displayCount} questions</div>
        <div class="category-card__plays">${plays.toLocaleString()} plays</div>
      </div>
    `;
  }).join('');

  // Replace wild-card card count with total open question count
  const wcCountEl = document.getElementById('wc-card-count');
  if (wcCountEl) {
    fetchAllOpenQuestionCount().then(total => {
      wcCountEl.textContent = `${total} questions`;
    });
  }

  // Collapse subcategory view when categories re-render (e.g. search)
  const subView = $('#subcategory-view');
  if (subView) subView.style.display = 'none';
  const catList = $('#category-list');
  if (catList) catList.style.display = '';
}

/**
 * Patch existing category cards in-place (no DOM rebuild, no blink).
 * Updates play counts, mastery rings, and tier glow on cards already in the grid.
 */
function patchCategoryCards(playCounts = {}) {
  const cards = $$('.category-card', categoryGrid);
  for (const card of cards) {
    const catName = card.dataset.category;
    if (!catName) continue;
    // Update play count text
    const playsEl = card.querySelector('.category-card__plays');
    if (playsEl) playsEl.textContent = `${(playCounts[catName] || 0).toLocaleString()} plays`;
    // Update mastery ring
    if (_isLoggedIn) {
      const cat = categories.find(c => c.name === catName);
      const total = cat?.count || 1;
      const mastered = _masteryCounts[catName] || 0;
      const pct = Math.round((mastered / total) * 100);
      let ring = card.querySelector('.category-card__ring');
      if (!ring) {
        // Add ring if it didn't exist in the cached render
        const wrap = card.querySelector('.category-card__icon-wrap');
        if (wrap) {
          ring = document.createElement('div');
          ring.className = 'category-card__ring';
          wrap.insertBefore(ring, wrap.firstChild);
        }
      }
      if (ring) ring.style.setProperty('--mastery-pct', pct);
      // Update tier glow
      const tier = pct >= MASTERY_COMPLETE_THRESHOLD ? 'complete' : pct >= MASTERY_HIGH_THRESHOLD ? 'high' : '';
      if (tier) card.dataset.masteryTier = tier;
      else delete card.dataset.masteryTier;
    }
  }
}

// --- Multi-level subcategory drill-in (nav stack) ---
function drillIntoLevel(catName, items, title, parentKey, icon) {
  navStack.push({ catName, items, title, parentKey, icon });
  renderSubcategoryLevel(catName, items, title, parentKey, icon);
}

function renderSubcategoryLevel(catName, items, title, parentKey, icon) {
  const catList = $('#category-list');
  const subView = $('#subcategory-view');
  const titleEl = $('#subcategory-view__title');
  const options = $('#subcategory-view__options');

  titleEl.textContent = `${icon || ''} ${title}`;

  // "All X" row — selects parentKey (null at top level = all in category)
  const allSubcategory = parentKey || '';
  const allPlays = parentKey
    ? (categoryPlayCounts[`${catName}/${parentKey}`] || 0)
    : (categoryPlayCounts[catName] || 0);
  const allPlaysHtml = allPlays > 0 ? `<span class="subcategory-row__plays">${allPlays.toLocaleString()} plays</span>` : '';
  options.innerHTML = `
    <div class="subcategory-row subcategory-row--all" data-category="${catName}" data-subcategory="${allSubcategory}">
      <span class="subcategory-row__icon">${icon || ''}</span>
      <span class="subcategory-row__label">All ${title}</span>
      <span class="subcategory-row__count" ${parentKey ? `data-sub-count="${parentKey}"` : ''}></span>
      ${allPlaysHtml}
    </div>
    ${items.map(s => {
      const subPlays = categoryPlayCounts[`${catName}/${s.key}`] || 0;
      const playsHtml = subPlays > 0 ? `<span class="subcategory-row__plays">${subPlays.toLocaleString()} plays</span>` : '';
      return `
      <div class="subcategory-row" data-category="${catName}" data-subcategory="${s.key}" ${s.children ? 'data-has-children="1"' : ''}>
        <span class="subcategory-row__icon">${s.emoji || s.icon}</span>
        <span class="subcategory-row__label">${s.label}</span>
        <span class="subcategory-row__count" data-sub-count="${s.key}"></span>
        ${playsHtml}
        ${s.children ? '<span class="subcategory-row__chevron">\u203A</span>' : ''}
      </div>
    `;
    }).join('')}
  `;

  catList.style.display = 'none';
  subView.style.display = '';
  document.querySelector('#category-screen')?.scrollTo(0, 0);

  // Async-load question counts (prefix matching handles parent counts)
  if (parentKey) {
    fetchQuestionCount(catName, parentKey).then(count => {
      const el = options.querySelector(`.subcategory-row--all [data-sub-count="${parentKey}"]`);
      if (el) el.textContent = `${count} Qs`;
    });
  } else {
    // Top level "All" — use the category's total count
    const cat = categories.find(c => c.name === catName);
    const allEl = options.querySelector('.subcategory-row--all .subcategory-row__count');
    if (allEl && cat?.count) allEl.textContent = `${cat.count} Qs`;
  }
  items.forEach(async (s) => {
    const count = await fetchQuestionCount(catName, s.key);
    const el = options.querySelector(`[data-sub-count="${s.key}"]`);
    if (el) el.textContent = `${count} Qs`;
  });
}

function drillBack() {
  navStack.pop(); // Remove current level
  if (navStack.length === 0) {
    // Back to category grid
    const subView = $('#subcategory-view');
    const catList = $('#category-list');
    subView.style.display = 'none';
    catList.style.display = '';
  } else {
    // Re-render previous level
    const prev = navStack[navStack.length - 1];
    renderSubcategoryLevel(prev.catName, prev.items, prev.title, prev.parentKey, prev.icon);
  }
}

// --- Wild-card special options (browse view) ---
function renderWildCardOptions(catName, cat, meta) {
  const catList = $('#category-list');
  const subView = $('#subcategory-view');
  const titleEl = $('#subcategory-view__title');
  const options = $('#subcategory-view__options');

  navStack.push({ catName, items: null, title: meta.label, parentKey: null, icon: meta.emoji || meta.icon, isWildCard: true });
  titleEl.textContent = `${meta.emoji || meta.icon} ${meta.label}`;

  options.innerHTML = meta.wildCardOptions.map(opt => `
    <div class="subcategory-row" data-category="${catName}" data-subcategory="${opt.key}">
      <span class="subcategory-row__icon">${opt.emoji || opt.icon}</span>
      <span class="subcategory-row__label">${opt.label}</span>
      <span class="subcategory-row__count" data-wc-count="${opt.key}"></span>
    </div>
    <p class="subcategory-row__hint">${opt.hint}</p>
  `).join('');

  catList.style.display = 'none';
  subView.style.display = '';
  document.querySelector('#category-screen')?.scrollTo(0, 0);

  // Async-load counts
  fetchAllOpenQuestionCount().then(count => {
    const el = options.querySelector('[data-wc-count="__all_questions__"]');
    if (el) el.textContent = `${count} Qs`;
  });
  fetchExclusiveWildCardCount().then(count => {
    const el = options.querySelector('[data-wc-count="__true_wild_card__"]');
    if (el) el.textContent = `${count} Qs`;
  });
}

// --- Category bottom sheet (for settings screen) ---
function openCategorySheet() {
  sheetNavStack = []; // Reset sheet navigation
  const sheet = $('#category-sheet');
  const list = $('#category-sheet-list');

  list.innerHTML = categories.map(cat => {
    const meta = CATEGORY_META[cat.name] || { icon: '?', label: cat.name };
    const hasDrill = meta.subcategories?.length > 0 || meta.wildCardOptions?.length > 0;
    const isSelected = selectedCategory?.name === cat.name;
    return `
      <div class="category-sheet-row${isSelected ? ' selected' : ''}" data-category="${cat.name}">
        <span class="category-sheet-row__icon">${meta.emoji || meta.icon}</span>
        <span class="category-sheet-row__label">${meta.label}</span>
        ${hasDrill ? '<span class="category-sheet-row__chevron">\u203A</span>' : ''}
      </div>
    `;
  }).join('');

  sheet.classList.add('active');
  sheet.querySelector('.bottom-sheet__backdrop').onclick = () => sheet.classList.remove('active');
}

function sheetDrillIn(catName, items, title, parentKey) {
  sheetNavStack.push({ catName, items, title, parentKey });
  renderSheetLevel(catName, items, title, parentKey);
}

function renderSheetLevel(catName, items, title, parentKey) {
  const list = $('#category-sheet-list');
  const allSubcategory = parentKey || '';
  list.innerHTML = `
    <div class="category-sheet-back" data-action="back">\u2190 ${title}</div>
    <div class="category-sheet-row subcategory-row--all" data-category="${catName}" data-subcategory="${allSubcategory}">
      <span class="category-sheet-row__icon">${CATEGORY_META[catName]?.icon || '?'}</span>
      <span class="category-sheet-row__label">All ${title}</span>
    </div>
    ${items.map(s => `
      <div class="category-sheet-row" data-category="${catName}" data-subcategory="${s.key}" ${s.children ? 'data-has-children="1"' : ''}>
        <span class="category-sheet-row__icon">${s.emoji || s.icon}</span>
        <span class="category-sheet-row__label">${s.label}</span>
        ${s.children ? '<span class="category-sheet-row__chevron">\u203A</span>' : ''}
      </div>
    `).join('')}
  `;
}

function sheetDrillBack() {
  sheetNavStack.pop();
  if (sheetNavStack.length === 0) {
    openCategorySheet();
  } else {
    const prev = sheetNavStack[sheetNavStack.length - 1];
    renderSheetLevel(prev.catName, prev.items, prev.title, prev.parentKey);
  }
}

function renderSheetWildCardOptions(catName, meta) {
  const list = $('#category-sheet-list');
  sheetNavStack.push({ catName, items: null, title: meta.label, parentKey: null, isWildCard: true });
  list.innerHTML = `
    <div class="category-sheet-back" data-action="back">\u2190 ${meta.label}</div>
    ${meta.wildCardOptions.map(opt => `
      <div class="category-sheet-row" data-category="${catName}" data-subcategory="${opt.key}">
        <span class="category-sheet-row__icon">${opt.emoji || opt.icon}</span>
        <span class="category-sheet-row__label">${opt.label}</span>
        <span class="category-sheet-row__count" data-wc-count="${opt.key}"></span>
      </div>
    `).join('')}
  `;

  // Async-load counts
  fetchAllOpenQuestionCount().then(count => {
    const el = list.querySelector('[data-wc-count="__all_questions__"]');
    if (el) el.textContent = `${count} Qs`;
  });
  fetchExclusiveWildCardCount().then(count => {
    const el = list.querySelector('[data-wc-count="__true_wild_card__"]');
    if (el) el.textContent = `${count} Qs`;
  });
}

// --- Attach all event listeners ---
function attachListeners() {
  // Back to home
  $('#btn-back-home').addEventListener('click', () => {
    navigateWithFade('index.html');
  });

  // Back to category screen — reset drill-in state
  $('#btn-back-category').addEventListener('click', () => {
    // Reset nav stack and ensure category grid is visible
    navStack = [];
    const subView = $('#subcategory-view');
    const catList = $('#category-list');
    subView.style.display = 'none';
    catList.style.display = '';
    transitionScreens(settingsScreen, categoryScreen);
  });

  // Category search
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase();
    // Reset drill-in state so Back doesn't navigate stale subcategory history
    navStack = [];
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
      navStack = [];
      drillIntoLevel(catName, meta.subcategories, meta.label, null, meta.emoji || meta.icon);
      return;
    }

    // Wild-card special options
    if (meta?.wildCardOptions?.length) {
      navStack = [];
      renderWildCardOptions(catName, cat, meta);
      return;
    }

    selectedCategory = cat;
    selectedSubcategory = null;
    showSettings(cat);
  });

  // Subcategory view — option tap + back arrow (multi-level)
  $('#subcategory-view__options').addEventListener('click', (e) => {
    const row = e.target.closest('.subcategory-row');
    if (!row) return;
    const catName = row.dataset.category;
    const cat = categories.find(c => c.name === catName);
    if (!cat) return;
    const meta = CATEGORY_META[catName];

    // If this item has children, drill deeper
    if (row.dataset.hasChildren === '1') {
      const subKey = row.dataset.subcategory;
      const node = findSubcategoryNode(meta, subKey);
      if (node?.children) {
        drillIntoLevel(catName, node.children, node.label, node.key, node.emoji || node.icon);
        return;
      }
    }

    // Leaf or "All" row — select and go to settings
    selectedCategory = cat;
    selectedSubcategory = row.dataset.subcategory || null;
    navStack = [];
    showSettings(cat);
  });
  $('#subcategory-back').addEventListener('click', drillBack);

  // Settings badge — tap to open category sheet
  $('#selected-category').addEventListener('click', openCategorySheet);

  // Category sheet — row taps (multi-level)
  $('#category-sheet-list').addEventListener('click', (e) => {
    const back = e.target.closest('[data-action="back"]');
    if (back) { sheetDrillBack(); return; }

    const row = e.target.closest('.category-sheet-row');
    if (!row) return;
    const catName = row.dataset.category;
    const cat = categories.find(c => c.name === catName);
    if (!cat) return;
    const meta = CATEGORY_META[catName];

    // If row has subcategory attribute, check if it has children to drill into
    if (row.dataset.subcategory !== undefined) {
      if (row.dataset.hasChildren === '1') {
        const node = findSubcategoryNode(meta, row.dataset.subcategory);
        if (node?.children) {
          sheetDrillIn(catName, node.children, node.label, node.key);
          return;
        }
      }
      // Leaf or "All" — select
      selectedCategory = cat;
      selectedSubcategory = row.dataset.subcategory || null;
      sheetNavStack = [];
      $('#category-sheet').classList.remove('active');
      showSettingsUpdate();
      return;
    }

    // Top-level category with subs — drill into subcategory list
    if (meta?.subcategories?.length) {
      sheetDrillIn(catName, meta.subcategories, meta.label, null);
      return;
    }

    // Wild-card special options in sheet
    if (meta?.wildCardOptions?.length) {
      renderSheetWildCardOptions(catName, meta);
      return;
    }

    // No subs — select directly
    selectedCategory = cat;
    selectedSubcategory = null;
    sheetNavStack = [];
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
  const icon = resolveSubcategoryIcon(cat.name, selectedSubcategory);
  const label = resolveCategoryLabel(cat.name, selectedSubcategory);
  $('.selected-category__icon').textContent = icon;
  $('.selected-category__name').textContent = label;

  // Show subcategory count if selected, otherwise parent count
  const countEl = $('.selected-category__count');
  if (selectedSubcategory === '__all_questions__') {
    countEl.textContent = '';
    const allCount = await fetchAllOpenQuestionCount();
    countEl.textContent = `${allCount} questions`;
  } else if (selectedSubcategory === '__true_wild_card__') {
    countEl.textContent = '';
    const wcCount = await fetchExclusiveWildCardCount();
    countEl.textContent = `${wcCount} questions`;
  } else if (selectedSubcategory) {
    countEl.textContent = '';
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
      showToast('Failed to create room', 'error');
      logger.error('Host', 'Room creation error', error);
      resetHostButton();
      return;
    }

    if (!data) {
      hostError.textContent = 'Room was not created. Check Supabase RLS policies on the rooms table.';
      showToast('Failed to create room', 'error');
      logger.error('Host', 'createRoom returned null data with no error — likely an RLS policy issue');
      resetHostButton();
      return;
    }

    // Add host as a player in the room
    // getAuthUserId(), NOT getCurrentUser(). Since invisible accounts (Slice
    // 8a) a guest has a real auth id too, and putting it on the seat is what
    // makes four things work:
    //
    //   * claimSeat becomes EXACT for a guest. Its guest rule is a heuristic —
    //     "a same-name row that is still alive might be somebody else" — and
    //     that guess is what let a returning guest be handed a second seat
    //     beside their own. An id is not a guess about who somebody is.
    //   * their play is remembered (record_round_history keys on user_id), so
    //     the game stops re-asking questions they already know, and all of it
    //     carries over the day they sign up because Supabase keeps the id.
    //   * a guest HOST can be rated (op_rate_host needs a host user id).
    //   * `players` becomes lockable at all, which is the whole point.
    //
    // It stays null when anonymous sign-ins are unavailable, and everything
    // then behaves exactly as it did before.
    const authUser = getCurrentUser();
    const userId = getAuthUserId();
    const extras = {};
    if (authUser?.profile) {
      extras.avatarColor = authUser.profile.avatar_color;
      extras.avatarEmoji = authUser.profile.avatar_emoji;
      extras.title = authUser.profile._cachedTitle || null;
    }
    const { data: player, error: playerErr } = await addPlayer(data.id, hostName, true, userId, extras);
    if (playerErr || !player) {
      hostError.textContent = 'Room created but failed to join. Try again.';
      logger.error('Host', 'addPlayer failed', playerErr);
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

    navigateWithFade('lobby.html');
  } catch (err) {
    logger.error('Host', 'Unexpected error in handleHostGame', err);
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
