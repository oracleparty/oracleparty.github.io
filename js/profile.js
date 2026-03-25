// ============================================
// Oracle Party — Profile System
// Avatar picker, profile page logic, bottom sheet profile card
// ============================================

import { $, $$, escapeHtml, renderAvatar, calculateTitle, CATEGORY_TITLES } from './utils.js';
import {
  supabase,
  fetchProfile,
  updateProfile,
  fetchPlayerStats,
  fetchGameHistory
} from './supabase.js';
import { getCurrentUser, getDisplayName, showSignUpModal } from './auth.js';

// ============================================
// CONSTANTS
// ============================================

export const AVATAR_COLORS = [
  '#C68A2E', '#5B6ABF', '#3A8A4F', '#C44B4B',
  '#8B5CF6', '#D97706', '#0891B2', '#BE185D',
  '#4B5563', '#78716C'
];

export const CURATED_EMOJIS = [
  '\u{1F3FA}', '\u{1F3DB}\uFE0F', '\u{1F5FF}', '\u{1F4DC}', '\u{26B1}\uFE0F', '\u{1F52E}', '\u{1F9ED}', '\u{1F5FA}\uFE0F',
  '\u26A1', '\u{1F33F}', '\u{1F3AD}', '\u{1F3C6}', '\u{1F3B2}', '\u{1F9E9}', '\u{1F52C}', '\u{1F30D}',
  '\u{1F4DA}', '\u{1F3B5}', '\u{1F377}', '\u231B', '\u{1F989}', '\u{1F48E}', '\u{1F5E1}\uFE0F', '\u{1F6E1}\uFE0F',
  '\u{1F9EA}', '\u{1F3AA}', '\u{1F3F0}', '\u{1F30B}', '\u{1F409}', '\u{1F441}\uFE0F'
];

const CATEGORY_META = {
  'history':          { icon: '\u23F3', label: 'History' },
  'science':          { icon: '\u2697\uFE0F', label: 'Science' },
  'nature':           { icon: '\u{1F33F}', label: 'Nature' },
  'arts-literature':  { icon: '\u{1F4DC}', label: 'Arts & Lit' },
  'culture-society':  { icon: '\u{1F3DB}\uFE0F', label: 'Culture' },
  'pop-culture':      { icon: '\u{1F3AC}', label: 'Pop Culture' },
  'world-geography':  { icon: '\u{1F5FA}\uFE0F', label: 'Geography' },
  'technology':       { icon: '\u26A1', label: 'Technology' },
  'sports':           { icon: '\u{1F3C6}', label: 'Sports' },
  'food':             { icon: '\u{1F37D}\uFE0F', label: 'Food & Drink' },
  'logic':            { icon: '\u{1F9E9}', label: 'Logic' },
  'wild-card':        { icon: '\u{1F3B2}', label: 'Wild Card' }
};

// ============================================
// AVATAR PICKER
// ============================================

let _pickerInjected = false;

/**
 * Show the avatar picker modal.
 * Returns Promise<{ color, emoji } | null> (null if cancelled).
 */
export function showAvatarPicker(currentColor, currentEmoji) {
  return new Promise((resolve) => {
    if (!_pickerInjected) {
      _injectAvatarPicker();
      _pickerInjected = true;
    }

    let selectedColor = currentColor || AVATAR_COLORS[0];
    let selectedEmoji = currentEmoji || CURATED_EMOJIS[0];
    let customMode = false;

    const overlay = $('#avatar-picker-modal');
    const preview = $('#avatar-picker-preview');
    const colorsWrap = $('#avatar-picker-colors');
    const emojisWrap = $('#avatar-picker-emojis');
    const moreBtn = $('#avatar-picker-more');
    const customWrap = $('#avatar-picker-custom-wrap');
    const customInput = $('#avatar-picker-custom-input');
    const saveBtn = $('#avatar-picker-save');
    const cancelBtn = $('#avatar-picker-cancel');

    function updatePreview() {
      preview.innerHTML = renderAvatar({ displayName: 'X', avatarColor: selectedColor, avatarEmoji: selectedEmoji, size: '72px' });
    }

    // Render color options
    colorsWrap.innerHTML = AVATAR_COLORS.map(c =>
      `<button class="avatar-picker__color${c === selectedColor ? ' selected' : ''}" style="background:${c}" data-color="${c}"></button>`
    ).join('');

    // Render emoji grid
    emojisWrap.innerHTML = CURATED_EMOJIS.map(e =>
      `<button class="avatar-picker__emoji${e === selectedEmoji ? ' selected' : ''}" data-emoji="${e}">${e}</button>`
    ).join('');

    customWrap.style.display = 'none';
    customInput.value = '';
    updatePreview();
    overlay.classList.add('active');

    // Color selection
    colorsWrap.onclick = (e) => {
      const btn = e.target.closest('[data-color]');
      if (!btn) return;
      selectedColor = btn.dataset.color;
      $$('.avatar-picker__color', colorsWrap).forEach(b => b.classList.toggle('selected', b.dataset.color === selectedColor));
      updatePreview();
    };

    // Emoji selection
    emojisWrap.onclick = (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      selectedEmoji = btn.dataset.emoji;
      customMode = false;
      customWrap.style.display = 'none';
      $$('.avatar-picker__emoji', emojisWrap).forEach(b => b.classList.toggle('selected', b.dataset.emoji === selectedEmoji));
      updatePreview();
    };

    // More emojis
    moreBtn.onclick = () => {
      customMode = true;
      customWrap.style.display = 'flex';
      $$('.avatar-picker__emoji', emojisWrap).forEach(b => b.classList.remove('selected'));
      customInput.value = '';
      customInput.focus();
    };

    customInput.oninput = () => {
      // Extract first emoji-like character(s)
      const val = customInput.value.trim();
      if (val) {
        // Take first grapheme cluster (emoji can be multi-codepoint)
        const segments = [...new Intl.Segmenter().segment(val)];
        if (segments.length > 0) {
          selectedEmoji = segments[0].segment;
          customInput.value = selectedEmoji;
          updatePreview();
        }
      }
    };

    // Save
    saveBtn.onclick = () => {
      overlay.classList.remove('active');
      resolve({ color: selectedColor, emoji: selectedEmoji });
    };

    // Cancel
    cancelBtn.onclick = () => {
      overlay.classList.remove('active');
      resolve(null);
    };
  });
}

function _injectAvatarPicker() {
  const html = `
    <div id="avatar-picker-modal" class="modal-overlay">
      <div class="modal">
        <h2 class="modal__title">Choose Avatar</h2>
        <div class="avatar-picker">
          <div id="avatar-picker-preview" class="avatar-picker__preview"></div>
          <div class="avatar-picker__label">Color</div>
          <div id="avatar-picker-colors" class="avatar-picker__colors"></div>
          <div class="avatar-picker__label">Emoji</div>
          <div id="avatar-picker-emojis" class="avatar-picker__emojis"></div>
          <button id="avatar-picker-more" class="avatar-picker__more">More emojis...</button>
          <div id="avatar-picker-custom-wrap" class="avatar-picker__custom-wrap" style="display:none">
            <input id="avatar-picker-custom-input" class="avatar-picker__custom-input" type="text" maxlength="4" placeholder="\u{1F60A}">
          </div>
        </div>
        <button class="btn btn-primary btn-block" id="avatar-picker-save" style="margin-top: var(--space-lg);">Save</button>
        <button class="btn btn-secondary btn-block" id="avatar-picker-cancel" style="margin-top: var(--space-sm);">Cancel</button>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ============================================
// BOTTOM SHEET PROFILE CARD
// ============================================

let _profileCardInjected = false;

/**
 * Show a bottom-sheet profile card for a player.
 * @param {Object} opts
 * @param {string} opts.userId - The player's auth user_id (null for guests)
 * @param {string} opts.displayName - Player's display name
 * @param {string|null} opts.avatarColor
 * @param {string|null} opts.avatarEmoji
 * @param {string|null} opts.title
 */
export async function showProfileCard({ userId, displayName, avatarColor, avatarEmoji, title }) {
  if (!_profileCardInjected) {
    _injectProfileCard();
    _profileCardInjected = true;
  }

  const sheet = $('#profile-card-sheet');
  const content = $('#profile-card-content');

  // Build header
  const avatarHtml = renderAvatar({ displayName, avatarColor, avatarEmoji, size: '56px' });

  let nameTag = escapeHtml(displayName);
  let profileTitle = title || 'Novice';
  let statsHtml = '';
  let actionsHtml = '';

  if (userId) {
    // Fetch profile + stats
    const [{ data: profile }, stats] = await Promise.all([
      fetchProfile(userId),
      fetchPlayerStats(userId)
    ]);

    if (profile) {
      nameTag = `${escapeHtml(profile.display_name)}<span class="profile-card__tag">#${escapeHtml(profile.discriminator)}</span>`;
      const titleInfo = calculateTitle(stats);
      profileTitle = titleInfo.title;
    }

    // Compute aggregate stats
    let totalGames = 0, totalWins = 0, totalAnswered = 0, totalCorrect = 0;
    let bestCat = null, bestAcc = 0;
    for (const s of stats) {
      totalGames += s.games_played || 0;
      totalWins += s.wins || 0;
      totalAnswered += s.questions_answered || 0;
      totalCorrect += s.correct_answers || 0;
      if (s.questions_answered >= 20) {
        const acc = s.correct_answers / s.questions_answered;
        if (acc > bestAcc) { bestAcc = acc; bestCat = s.category; }
      }
    }
    const winRate = totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0;
    const bestCatLabel = bestCat ? (CATEGORY_META[bestCat]?.label || bestCat) : '--';

    statsHtml = `
      <div class="profile-card__stats">
        <div><div class="profile-card__stat-value">${totalGames}</div><div class="profile-card__stat-label">Games</div></div>
        <div><div class="profile-card__stat-value">${totalWins}</div><div class="profile-card__stat-label">Wins</div></div>
        <div><div class="profile-card__stat-value">${winRate}%</div><div class="profile-card__stat-label">Win Rate</div></div>
        <div><div class="profile-card__stat-value">${bestCatLabel}</div><div class="profile-card__stat-label">Best</div></div>
      </div>
    `;

    // Add Friend button
    const viewer = getCurrentUser();
    if (viewer && viewer.user.id !== userId) {
      actionsHtml = `<button class="btn btn-secondary btn-block" id="profile-card-add-friend">Add Friend</button>`;
    } else if (!viewer) {
      actionsHtml = `
        <button class="btn btn-secondary btn-block" id="profile-card-add-friend" disabled>Add Friend</button>
        <p class="profile-card__guest-hint">Create an account to add friends</p>
      `;
    }
  } else {
    // Guest player
    statsHtml = `<p class="profile-card__guest-hint">Guest player</p>`;
  }

  content.innerHTML = `
    <div class="profile-card__header">
      <div class="profile-card__avatar">${avatarHtml}</div>
      <div class="profile-card__name">${nameTag}</div>
      <div class="profile-card__title">${escapeHtml(profileTitle)}</div>
    </div>
    ${statsHtml}
    <div class="profile-card__actions">${actionsHtml}</div>
  `;

  sheet.classList.add('active');

  // Add friend click
  const addFriendBtn = $('#profile-card-add-friend');
  if (addFriendBtn && !addFriendBtn.disabled) {
    addFriendBtn.onclick = () => {
      addFriendBtn.textContent = 'Request Sent';
      addFriendBtn.disabled = true;
      // Friend request logic will be wired in a later phase
    };
  } else if (addFriendBtn && addFriendBtn.disabled) {
    addFriendBtn.onclick = async () => {
      sheet.classList.remove('active');
      await showSignUpModal();
    };
  }

  // Dismiss
  const backdrop = $('#profile-card-backdrop');
  const handle = $('#profile-card-handle');
  const dismiss = () => sheet.classList.remove('active');
  backdrop.onclick = dismiss;
  handle.onclick = dismiss;

  // Swipe down to dismiss
  let startY = 0;
  const panel = $('#profile-card-panel');
  panel.ontouchstart = (e) => { startY = e.touches[0].clientY; };
  panel.ontouchend = (e) => {
    const dy = e.changedTouches[0].clientY - startY;
    if (dy > 60) dismiss();
  };
}

function _injectProfileCard() {
  const html = `
    <div id="profile-card-sheet" class="bottom-sheet">
      <div id="profile-card-backdrop" class="bottom-sheet__backdrop"></div>
      <div id="profile-card-panel" class="bottom-sheet__panel">
        <div id="profile-card-handle" class="bottom-sheet__handle"></div>
        <div id="profile-card-content"></div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ============================================
// PROFILE PAGE LOGIC
// ============================================

/**
 * Initialize the profile page. Call from profile.html's inline script.
 */
export async function initProfilePage() {
  const authUser = getCurrentUser();
  const displayName = getDisplayName() || 'Guest';

  // Header avatar + name
  const headerAvatar = $('#profile-avatar');
  const headerName = $('#profile-name');
  const headerTitle = $('#profile-title');
  const bioEl = $('#profile-bio');
  const statsEl = $('#profile-stats');
  const categoriesEl = $('#profile-categories');
  const gamesEl = $('#profile-games');
  const favCatEl = $('#profile-fav-categories');
  const accountEl = $('#profile-account');

  if (!authUser) {
    // Guest view
    headerAvatar.innerHTML = renderAvatar({ displayName, avatarColor: null, avatarEmoji: null, size: '72px' });
    headerName.textContent = displayName;
    headerTitle.textContent = 'Novice';
    if (bioEl) bioEl.innerHTML = '<span class="profile-bio--placeholder">Tap to add a bio...</span>';
    if (statsEl) statsEl.innerHTML = '<p class="profile-empty">Create an account to track your stats</p>';
    if (categoriesEl) categoriesEl.innerHTML = '';
    if (gamesEl) gamesEl.innerHTML = '';
    if (favCatEl) favCatEl.innerHTML = '';
    if (accountEl) accountEl.innerHTML = '<button class="btn btn-primary btn-block" id="profile-create-account">Create Account</button>';

    const createBtn = $('#profile-create-account');
    if (createBtn) createBtn.onclick = () => showSignUpModal();

    headerAvatar.onclick = () => showSignUpModal();
    return;
  }

  const profile = authUser.profile;
  const userId = authUser.user.id;

  // Render header
  headerAvatar.innerHTML = renderAvatar({
    displayName: profile.display_name,
    avatarColor: profile.avatar_color,
    avatarEmoji: profile.avatar_emoji,
    size: '72px'
  }) + '<div class="profile-header__edit-hint">\u270F\uFE0F</div>';
  headerName.innerHTML = `${escapeHtml(profile.display_name)}<span class="profile-header__tag">#${escapeHtml(profile.discriminator)}</span>`;

  // Avatar edit
  headerAvatar.onclick = async () => {
    const result = await showAvatarPicker(profile.avatar_color, profile.avatar_emoji);
    if (result) {
      await updateProfile(userId, { avatar_color: result.color, avatar_emoji: result.emoji });
      profile.avatar_color = result.color;
      profile.avatar_emoji = result.emoji;
      headerAvatar.innerHTML = renderAvatar({
        displayName: profile.display_name,
        avatarColor: result.color,
        avatarEmoji: result.emoji,
        size: '72px'
      }) + '<div class="profile-header__edit-hint">\u270F\uFE0F</div>';
    }
  };

  // Fetch stats + games
  const [stats, games] = await Promise.all([
    fetchPlayerStats(userId),
    fetchGameHistory(userId, 5)
  ]);

  // Title
  const titleInfo = calculateTitle(stats);
  headerTitle.textContent = titleInfo.title;

  // Bio
  if (bioEl) {
    bioEl.textContent = profile.bio || '';
    if (!profile.bio) bioEl.innerHTML = '<span class="profile-bio--placeholder">Tap to add a bio...</span>';
    bioEl.contentEditable = 'true';
    bioEl.setAttribute('maxlength', '50');
    let bioSaveTimeout = null;
    bioEl.onfocus = () => {
      if (bioEl.querySelector('.profile-bio--placeholder')) {
        bioEl.innerHTML = '';
      }
    };
    bioEl.oninput = () => {
      const text = bioEl.textContent.trim().slice(0, 50);
      clearTimeout(bioSaveTimeout);
      bioSaveTimeout = setTimeout(() => {
        updateProfile(userId, { bio: text });
        profile.bio = text;
      }, 800);
    };
    bioEl.onblur = () => {
      if (!bioEl.textContent.trim()) {
        bioEl.innerHTML = '<span class="profile-bio--placeholder">Tap to add a bio...</span>';
      }
    };
  }

  // Stats summary
  let totalGames = 0, totalWins = 0, totalAnswered = 0, totalCorrect = 0;
  let strongCat = null, strongAcc = 0, weakCat = null, weakAcc = 1;
  for (const s of stats) {
    totalGames += s.games_played || 0;
    totalWins += s.wins || 0;
    totalAnswered += s.questions_answered || 0;
    totalCorrect += s.correct_answers || 0;
    if (s.questions_answered >= 10) {
      const acc = s.correct_answers / s.questions_answered;
      if (acc > strongAcc) { strongAcc = acc; strongCat = s.category; }
      if (acc < weakAcc) { weakAcc = acc; weakCat = s.category; }
    }
  }
  const winRate = totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0;
  const accuracy = totalAnswered > 0 ? Math.round((totalCorrect / totalAnswered) * 100) : 0;

  if (statsEl) {
    statsEl.innerHTML = `
      <div class="profile-stat"><div class="profile-stat__value">${totalGames}</div><div class="profile-stat__label">Games</div></div>
      <div class="profile-stat"><div class="profile-stat__value">${totalWins}</div><div class="profile-stat__label">Wins</div></div>
      <div class="profile-stat"><div class="profile-stat__value">${winRate}%</div><div class="profile-stat__label">Win Rate</div></div>
      <div class="profile-stat"><div class="profile-stat__value">${accuracy}%</div><div class="profile-stat__label">Accuracy</div></div>
      <div class="profile-stat"><div class="profile-stat__value">${strongCat ? (CATEGORY_META[strongCat]?.icon || '') : '--'}</div><div class="profile-stat__label">Strongest</div></div>
      <div class="profile-stat"><div class="profile-stat__value">${weakCat ? (CATEGORY_META[weakCat]?.icon || '') : '--'}</div><div class="profile-stat__label">Weakest</div></div>
    `;
  }

  // Per-category breakdown
  if (categoriesEl) {
    categoriesEl.innerHTML = stats.length > 0
      ? stats.map(s => {
          const meta = CATEGORY_META[s.category] || { icon: '?', label: s.category };
          const acc = s.questions_answered > 0 ? Math.round((s.correct_answers / s.questions_answered) * 100) : 0;
          return `<div class="profile-category-row">
            <span>${meta.icon}</span>
            <span class="profile-category-row__name">${meta.label}</span>
            <span class="profile-category-row__accuracy">${acc}%</span>
          </div>`;
        }).join('')
      : '<p class="profile-empty">Play some games to see category stats</p>';
  }

  // Recent games
  if (gamesEl) {
    gamesEl.innerHTML = games.length > 0
      ? games.map(g => {
          const meta = CATEGORY_META[g.category] || { icon: '?', label: g.category };
          const date = new Date(g.played_at);
          const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
          const placeSuffix = g.placement === 1 ? 'st' : g.placement === 2 ? 'nd' : g.placement === 3 ? 'rd' : 'th';
          return `<div class="profile-game-row">
            <span>${meta.icon}</span>
            <span class="profile-game-row__category">${meta.label}</span>
            <span class="profile-game-row__placement">${g.placement}${placeSuffix}/${g.total_players}</span>
            <span class="profile-game-row__score">${g.score} pts</span>
            <span class="profile-game-row__date">${dateStr}</span>
          </div>`;
        }).join('')
      : '<p class="profile-empty">No games played yet</p>';
  }

  // Favorite category
  if (favCatEl) {
    favCatEl.innerHTML = Object.entries(CATEGORY_META).map(([name, meta]) => {
      const selected = profile.favorite_category === name ? 'selected' : '';
      return `<button class="profile-fav-cat ${selected}" data-cat="${name}">${meta.icon} ${meta.label}</button>`;
    }).join('');

    favCatEl.onclick = async (e) => {
      const btn = e.target.closest('[data-cat]');
      if (!btn) return;
      const cat = btn.dataset.cat;
      $$('.profile-fav-cat', favCatEl).forEach(b => b.classList.toggle('selected', b.dataset.cat === cat));
      await updateProfile(userId, { favorite_category: cat });
      profile.favorite_category = cat;
    };
  }

  // Account section
  if (accountEl) {
    accountEl.innerHTML = `
      <p style="color: var(--color-text-dim); font-size: var(--text-sm); margin-bottom: var(--space-sm);">${escapeHtml(authUser.user.email)}</p>
      <button class="btn btn-secondary btn-block" id="profile-sign-out">Sign Out</button>
    `;
    const signOutBtn = $('#profile-sign-out');
    if (signOutBtn) {
      signOutBtn.onclick = async () => {
        const { signOut } = await import('./auth.js');
        await signOut();
        window.location.href = 'index.html';
      };
    }
  }
}

// ============================================
// PROFILE CARD TAP HANDLER (for lobby + game)
// ============================================

/**
 * Attach profile card tap handler to a container.
 * Listens for clicks on elements with data-profile-user-id.
 * Also handles clicks on player-item or answer-row elements
 * by finding the player data from the provided players array.
 */
export function attachProfileCardHandler(container, getPlayers) {
  container.addEventListener('click', async (e) => {
    const target = e.target.closest('[data-profile-user-id]');
    if (!target) return;

    const userId = target.dataset.profileUserId;
    const players = typeof getPlayers === 'function' ? getPlayers() : [];
    const player = players.find(p => p.user_id === userId);

    await showProfileCard({
      userId: userId || null,
      displayName: player?.display_name || 'Unknown',
      avatarColor: player?.avatar_color || null,
      avatarEmoji: player?.avatar_emoji || null,
      title: player?.title || null
    });
  });
}
