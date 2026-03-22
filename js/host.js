// ============================================
// Oracle Party — Host Flow
// Category selection, settings, room creation
// ============================================

import { $, $$, transitionScreens } from './utils.js';
import { fetchCategories, createRoom, addPlayer } from './supabase.js';
import { getDisplayName, ensureDisplayName } from './auth.js';

// --- Category display config ---
const CATEGORY_META = {
  'history':          { icon: '\u23F3', label: 'History' },
  'science':          { icon: '\u2697\uFE0F', label: 'Science' },
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
let selectedCategory = null;
let settings = {
  whoCanJoin: 'anyone',
  questionsPerGame: 10,
  questionTimer: 30
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
    await ensureDisplayName();
    categories = await fetchCategories();
    renderCategories(categories);
  } catch (err) {
    console.error('[Host] Init error:', err);
  }
  // Always attach listeners even if data fetch fails
  attachListeners();

  // Trap browser back button — always go to index.html
  history.pushState({ page: 'host' }, '');
  window.addEventListener('popstate', () => { window.location.href = 'index.html'; });
}

// --- Render category cards ---
function renderCategories(cats) {
  categoryGrid.innerHTML = cats.map(cat => {
    const meta = CATEGORY_META[cat.name] || { icon: '?', label: cat.name };
    return `
      <button class="category-card" data-category="${cat.name}">
        <div class="category-card__icon">${meta.icon}</div>
        <div class="category-card__name">${meta.label}</div>
        <div class="category-card__count">${cat.count} questions</div>
      </button>
    `;
  }).join('');
}

// --- Attach all event listeners ---
function attachListeners() {
  // Back to home
  $('#btn-back-home').addEventListener('click', () => {
    window.location.href = 'index.html';
  });

  // Back to category screen
  $('#btn-back-category').addEventListener('click', () => {
    transitionScreens(settingsScreen, categoryScreen);
  });

  // Category search
  searchInput.addEventListener('input', () => {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      renderCategories(categories);
      return;
    }
    const filtered = categories.filter(cat => {
      const meta = CATEGORY_META[cat.name] || { label: cat.name };
      return meta.label.toLowerCase().includes(query) || cat.name.toLowerCase().includes(query);
    });
    renderCategories(filtered);
  });

  // Category card selection (event delegation)
  categoryGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.category-card');
    if (!card) return;

    const catName = card.dataset.category;
    const cat = categories.find(c => c.name === catName);
    if (!cat) return;

    selectedCategory = cat;
    showSettings(cat);
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
      if (settingKey === 'questionsPerGame' || settingKey === 'questionTimer') {
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
function showSettings(cat) {
  const meta = CATEGORY_META[cat.name] || { icon: '?', label: cat.name };
  $('.selected-category__icon').textContent = meta.icon;
  $('.selected-category__name').textContent = meta.label;
  $('.selected-category__count').textContent = `${cat.count} questions`;
  hostError.textContent = '';

  transitionScreens(categoryScreen, settingsScreen);
}

// --- Create room and navigate to lobby ---
async function handleHostGame() {
  btnHostGame.classList.add('is-loading');
  btnHostGame.textContent = 'Creating...';
  hostError.textContent = '';

  try {
    const hostName = getDisplayName();
    const { data, error } = await createRoom({
      hostName,
      category: selectedCategory.name,
      whoCanJoin: settings.whoCanJoin,
      questionsPerGame: settings.questionsPerGame,
      questionTimer: settings.questionTimer
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
    const { data: player, error: playerErr } = await addPlayer(data.id, hostName, true);
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
      isHost: true,
      playerId: player.id,
      settings: {
        whoCanJoin: data.who_can_join,
        questionsPerGame: data.questions_per_game,
        questionTimer: data.question_timer
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
