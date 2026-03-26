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
  fetchGameHistory,
  sendFriendRequest,
  fetchPendingRequests,
  fetchSentRequests,
  acceptFriendRequest,
  declineFriendRequest,
  createFriendship,
  removeFriend,
  fetchFriends,
  isFriend,
  searchProfiles
} from './supabase.js';
import { getCurrentUser, getDisplayName, showSignUpModal, signOut } from './auth.js';
import { getPresenceForUser, initGlobalPresence, destroyGlobalPresence } from './presence.js';
import { applyTheme } from './theme.js';

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
      const val = customInput.value.trim();
      if (val) {
        let firstChar = val;
        // Use Intl.Segmenter for proper grapheme cluster splitting (multi-codepoint emoji)
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
          const segments = [...new Intl.Segmenter().segment(val)];
          if (segments.length > 0) firstChar = segments[0].segment;
        } else {
          // Fallback: spread into array (handles most surrogate pairs)
          firstChar = [...val][0] || val.slice(0, 2);
        }
        selectedEmoji = firstChar;
        customInput.value = selectedEmoji;
        updatePreview();
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
 * @param {string|null} opts.roomId - If viewing from a shared room (enables instant-add)
 */
export async function showProfileCard({ userId, displayName, avatarColor, avatarEmoji, title, roomId }) {
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

    // Friend actions
    const viewer = getCurrentUser();
    if (viewer && viewer.user.id !== userId) {
      const alreadyFriends = await isFriend(viewer.user.id, userId);
      if (alreadyFriends) {
        actionsHtml = `<button class="btn btn-secondary btn-block" id="profile-card-remove-friend">Remove Friend</button>`;
      } else if (roomId) {
        // In shared room → instant add
        actionsHtml = `<button class="btn btn-primary btn-block" id="profile-card-add-friend" data-instant="true">Add Friend</button>`;
      } else {
        // Not in room → send request
        actionsHtml = `<button class="btn btn-secondary btn-block" id="profile-card-add-friend">Add Friend</button>`;
      }
    } else if (!viewer) {
      actionsHtml = `
        <button class="btn btn-secondary btn-block profile-card__btn--guest" id="profile-card-add-friend" data-guest="true">Add Friend</button>
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

  // Wire friend action buttons
  const addFriendBtn = $('#profile-card-add-friend');
  const removeFriendBtn = $('#profile-card-remove-friend');

  if (addFriendBtn && addFriendBtn.dataset.guest) {
    addFriendBtn.onclick = async () => {
      sheet.classList.remove('active');
      await showSignUpModal();
    };
  } else if (addFriendBtn && addFriendBtn.dataset.instant) {
    // Instant add from shared room
    addFriendBtn.onclick = async () => {
      const viewer = getCurrentUser();
      if (!viewer) return;
      addFriendBtn.disabled = true;
      addFriendBtn.textContent = 'Adding...';
      await createFriendship(viewer.user.id, userId, 'lobby');
      addFriendBtn.textContent = 'Friends \u2713';
    };
  } else if (addFriendBtn) {
    // Send friend request
    addFriendBtn.onclick = async () => {
      const viewer = getCurrentUser();
      if (!viewer) return;
      addFriendBtn.disabled = true;
      addFriendBtn.textContent = 'Sending...';
      const { error } = await sendFriendRequest(viewer.user.id, userId);
      addFriendBtn.textContent = error ? 'Already Sent' : 'Request Sent';
    };
  }

  if (removeFriendBtn) {
    removeFriendBtn.onclick = async () => {
      const viewer = getCurrentUser();
      if (!viewer) return;
      removeFriendBtn.disabled = true;
      removeFriendBtn.textContent = 'Removing...';
      await removeFriend(viewer.user.id, userId);
      removeFriendBtn.textContent = 'Removed';
      setTimeout(() => sheet.classList.remove('active'), 600);
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
    const onlineChecked = profile.show_online_status !== false ? 'checked' : '';
    const oledPref = localStorage.getItem('oracle_party_oled_pref') === '1';
    const oledChecked = oledPref ? 'checked' : '';
    accountEl.innerHTML = `
      <div class="profile-toggle">
        <span>Show Online Status</span>
        <label class="profile-switch">
          <input type="checkbox" id="profile-online-toggle" ${onlineChecked}>
          <span class="profile-switch__slider"></span>
        </label>
      </div>
      <div class="profile-toggle">
        <span>OLED Black Mode</span>
        <label class="profile-switch">
          <input type="checkbox" id="profile-oled-toggle" ${oledChecked}>
          <span class="profile-switch__slider"></span>
        </label>
      </div>
      <p style="color: var(--color-text-dim); font-size: var(--text-sm); margin: var(--space-md) 0 var(--space-sm);">${escapeHtml(authUser.user.email)}</p>
      <button class="btn btn-secondary btn-block" id="profile-sign-out">Sign Out</button>
    `;

    // Online status toggle
    const onlineToggle = $('#profile-online-toggle');
    if (onlineToggle) {
      onlineToggle.onchange = async () => {
        const showOnline = onlineToggle.checked;
        await updateProfile(userId, { show_online_status: showOnline });
        profile.show_online_status = showOnline;
        if (!showOnline) {
          destroyGlobalPresence();
        } else {
          await initGlobalPresence(userId);
        }
      };
    }

    // OLED Black Mode toggle — sets preference for the sun/moon toggle behavior.
    // When ON: sun/moon swaps light ↔ OLED black (skips regular dark).
    // When OFF: sun/moon swaps light ↔ regular dark.
    const oledToggle = $('#profile-oled-toggle');
    if (oledToggle) {
      oledToggle.onchange = () => {
        localStorage.setItem('oracle_party_oled_pref', oledToggle.checked ? '1' : '0');
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
        if (oledToggle.checked && currentTheme === 'dark') {
          // Currently on dark — switch to OLED immediately
          applyTheme('oled');
        } else if (!oledToggle.checked && currentTheme === 'oled') {
          // Currently on OLED — switch to regular dark
          applyTheme('dark');
        }
        // Update the sun/moon icon
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        document.querySelectorAll('.theme-toggle').forEach(b => {
          b.textContent = isLight ? '\uD83C\uDF19' : '\u2600\uFE0F';
        });
      };
    }

    const signOutBtn = $('#profile-sign-out');
    if (signOutBtn) {
      signOutBtn.onclick = async () => {
        await signOut();
        window.location.href = 'index.html';
      };
    }
  }

  // ============================================
  // TAB SWITCHING
  // ============================================

  const tabs = $$('.profile-tab');
  const profileContent = $('#profile-tab-content');
  const friendsContent = $('#friends-tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === target));
      if (target === 'profile') {
        profileContent.style.display = '';
        friendsContent.style.display = 'none';
      } else {
        profileContent.style.display = 'none';
        friendsContent.style.display = '';
        loadFriendsTab(userId);
      }
    });
  });

  // Check for pending requests to show badge on friends tab
  const pendingRequests = await fetchPendingRequests(userId);
  if (pendingRequests.length > 0) {
    const badge = $('#friends-tab-badge');
    if (badge) {
      badge.textContent = pendingRequests.length;
      badge.classList.remove('hidden');
    }
  }

  // If URL has ?tab=friends, switch to friends tab
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('tab') === 'friends') {
    const friendsTab = tabs.find(t => t.dataset.tab === 'friends');
    if (friendsTab) friendsTab.click();
  }
}

// ============================================
// FRIENDS TAB
// ============================================

let _searchTimeout = null;

async function loadFriendsTab(userId) {
  const pendingListEl = $('#friends-pending-list');
  const pendingSection = $('#friends-pending');
  const friendsListEl = $('#friends-list');
  const searchInput = $('#friends-search-input');
  const searchResults = $('#friends-search-results');

  // Load pending requests
  const pending = await fetchPendingRequests(userId);
  if (pending.length > 0) {
    pendingSection.style.display = '';
    const senderIds = pending.map(r => r.sender_id);
    // Batch-fetch sender profiles
    const profiles = await _batchFetchProfiles(senderIds);

    pendingListEl.innerHTML = pending.map(req => {
      const p = profiles[req.sender_id] || {};
      const avatar = renderAvatar({ displayName: p.display_name || '?', avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji });
      const tag = p.discriminator ? `<span class="request-row__tag">#${escapeHtml(p.discriminator)}</span>` : '';
      return `<div class="request-row" data-request-id="${req.id}">
        ${avatar}
        <div class="request-row__info">
          <div class="request-row__name">${escapeHtml(p.display_name || 'Unknown')}${tag}</div>
        </div>
        <div class="request-row__actions">
          <button class="btn btn-primary" data-accept="${req.id}">Accept</button>
          <button class="btn btn-secondary" data-decline="${req.id}">Decline</button>
        </div>
      </div>`;
    }).join('');

    // Wire accept/decline
    pendingListEl.onclick = async (e) => {
      const acceptBtn = e.target.closest('[data-accept]');
      const declineBtn = e.target.closest('[data-decline]');
      if (acceptBtn) {
        acceptBtn.disabled = true;
        acceptBtn.textContent = '...';
        await acceptFriendRequest(parseInt(acceptBtn.dataset.accept));
        loadFriendsTab(userId); // Refresh
      } else if (declineBtn) {
        declineBtn.disabled = true;
        declineBtn.textContent = '...';
        await declineFriendRequest(parseInt(declineBtn.dataset.decline));
        loadFriendsTab(userId);
      }
    };
  } else {
    pendingSection.style.display = 'none';
  }

  // Load friends list
  const friends = await fetchFriends(userId);
  if (friends.length > 0) {
    // Sort: online first, then alphabetical
    friends.sort((a, b) => {
      const aOnline = getPresenceForUser(a.user_id) ? 1 : 0;
      const bOnline = getPresenceForUser(b.user_id) ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;
      return (a.display_name || '').localeCompare(b.display_name || '');
    });

    friendsListEl.innerHTML = friends.map(f => {
      const avatar = renderAvatar({ displayName: f.display_name, avatarColor: f.avatar_color, avatarEmoji: f.avatar_emoji });
      const tag = f.discriminator ? `<span class="friend-row__tag">#${escapeHtml(f.discriminator)}</span>` : '';
      const presence = getPresenceForUser(f.user_id);
      const isOnline = !!presence;
      const statusDot = `<span class="friend-row__status friend-row__status--${isOnline ? 'online' : 'offline'}"></span>`;

      let activityText = 'Offline';
      if (presence) {
        if (presence.activity === 'lobby') {
          activityText = `In Lobby \u2014 ${escapeHtml(presence.category || '')}`;
        } else if (presence.activity === 'game') {
          activityText = `In Game \u2014 ${escapeHtml(presence.category || '')}`;
        } else {
          activityText = 'Online';
        }
      }

      let actionHtml = '';
      if (presence && presence.activity === 'lobby' && presence.roomCode) {
        actionHtml = `<div class="friend-row__action"><button class="btn btn-primary" data-join-code="${escapeHtml(presence.roomCode)}">Join</button></div>`;
      }

      return `<div class="friend-row">
        ${avatar}
        <div class="friend-row__info">
          <div class="friend-row__name">${escapeHtml(f.display_name)}${tag}</div>
          <div class="friend-row__activity">${statusDot} ${activityText}</div>
        </div>
        ${actionHtml}
      </div>`;
    }).join('');

    // Join friend's lobby on button click
    friendsListEl.onclick = (e) => {
      const joinBtn = e.target.closest('[data-join-code]');
      if (!joinBtn) return;
      window.location.href = `join.html?code=${joinBtn.dataset.joinCode}`;
    };
  } else {
    friendsListEl.innerHTML = '<p class="profile-empty">No friends yet. Search to add some!</p>';
  }

  // Search
  searchInput.oninput = () => {
    clearTimeout(_searchTimeout);
    const query = searchInput.value.trim();
    if (query.length < 2) {
      searchResults.innerHTML = '';
      return;
    }
    _searchTimeout = setTimeout(() => _runFriendSearch(query, userId, searchResults), 300);
  };
}

async function _runFriendSearch(query, userId, resultsEl) {
  const results = await searchProfiles(query, userId);
  if (results.length === 0) {
    resultsEl.innerHTML = '<p class="profile-empty" style="padding: var(--space-sm) 0;">No results found</p>';
    return;
  }

  // Check which results are already friends or have pending requests
  const sentRequests = await fetchSentRequests(userId);
  const sentSet = new Set(sentRequests.map(r => r.receiver_id));

  resultsEl.innerHTML = (await Promise.all(results.map(async (p) => {
    const avatar = renderAvatar({ displayName: p.display_name, avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji });
    const tag = p.discriminator ? `<span class="search-result-row__tag">#${escapeHtml(p.discriminator)}</span>` : '';
    const titleInfo = calculateTitle([]); // We don't have stats here, show default
    const already = await isFriend(userId, p.user_id);
    const pending = sentSet.has(p.user_id);

    let actionHtml;
    if (already) {
      actionHtml = '<span class="btn btn-secondary" disabled>Friends</span>';
    } else if (pending) {
      actionHtml = '<span class="btn btn-secondary" disabled>Pending</span>';
    } else {
      actionHtml = `<button class="btn btn-primary" data-send-request="${p.user_id}">Add Friend</button>`;
    }

    return `<div class="search-result-row">
      ${avatar}
      <div class="search-result-row__info">
        <div class="search-result-row__name">${escapeHtml(p.display_name)}${tag}</div>
      </div>
      ${actionHtml}
    </div>`;
  }))).join('');

  // Wire send request buttons
  resultsEl.onclick = async (e) => {
    const btn = e.target.closest('[data-send-request]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Sending...';
    const { error } = await sendFriendRequest(userId, btn.dataset.sendRequest);
    btn.textContent = error ? 'Error' : 'Sent';
  };
}

/**
 * Batch-fetch profiles for an array of user IDs.
 * Returns a map { userId: profile }.
 */
async function _batchFetchProfiles(userIds) {
  if (!userIds.length) return {};
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .in('user_id', userIds);

  if (error) {
    console.error('[Profile] _batchFetchProfiles failed:', error.message);
    return {};
  }
  const map = {};
  for (const p of (data || [])) map[p.user_id] = p;
  return map;
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
export function attachProfileCardHandler(container, getPlayers, roomId = null) {
  container.addEventListener('click', async (e) => {
    // Don't trigger on honk/toggle button clicks
    if (e.target.closest('.honk-btn') || e.target.closest('.answer-toggle')) return;

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
      title: player?.title || null,
      roomId
    });
  });
}
