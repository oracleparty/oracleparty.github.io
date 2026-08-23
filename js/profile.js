// ============================================
// Oracle Party — Profile System
// Avatar picker, profile page logic, bottom sheet profile card
// ============================================

import { $, $$, escapeHtml, renderAvatar, calculateTitle, CATEGORY_TITLES, navigateWithFade, showToast } from './utils.js';
import { MIN_QUESTIONS_FOR_ACCURACY, MIN_QUESTIONS_FOR_CATEGORY, MASTERY_TREE_BASE_INDENT, MASTERY_TREE_DEPTH_INDENT } from './constants.js';
import {
  supabase,
  fetchProfile,
  updateProfile,
  deleteMyAccount,
  fetchPlayerStats,
  fetchGameHistory,
  sendFriendRequest,
  fetchPendingRequests,
  fetchSentRequests,
  acceptFriendRequest,
  declineFriendRequest,
  cancelFriendRequest,
  createFriendship,
  removeFriend,
  fetchFriends,
  isFriend,
  searchProfiles,
  fetchTitleUnlocks,
  fetchMasteryCounts,
  fetchCategories,
  fetchQuestionCount,
  fetchProfileByTag
} from './supabase.js';
import { getCurrentUser, getDisplayName, setDisplayName, showSignUpModal, showSignInModal, signOut, markAccountDeleted } from './auth.js';
import { getPresenceForUser, initGlobalPresence, destroyGlobalPresence } from './presence.js';
import { applyTheme } from './theme.js';
import { logger, reportWriteFailure } from './logger.js';
import { TITLE_WORDS, buildDisplayTitle, categoryRollupRows, rowProficiency, mergedCategoryRows, tierProgress } from './titles.js';
import { CATEGORY_META, resolveCategoryLabel, findSubcategoryNode, resolveSubcategoryIcon } from './categories.js';
import { RADAR_VIEWBOX, radarPoints, polygonPoints, buildRadarAxes, radarExtremes } from './radar.js';

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

// CATEGORY_META imported from categories.js

// ============================================
// AVATAR PICKER
// ============================================

/**
 * Show the avatar picker as a full-screen scrollable page.
 * Returns Promise<{ color, emoji } | null> (null if cancelled).
 */
export function showAvatarPicker(currentColor, currentEmoji) {
  return new Promise((resolve) => {
    // Remove any existing picker
    const existing = document.getElementById('avatar-picker-page');
    if (existing) existing.remove();

    let selectedColor = currentColor || AVATAR_COLORS[0];
    let selectedEmoji = currentEmoji || CURATED_EMOJIS[0];

    // Build the full-screen page as a real DOM element
    const page = document.createElement('div');
    page.id = 'avatar-picker-page';
    // Full-screen, scrollable, on top of everything — NO modal, NO overlay tricks
    page.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:var(--color-bg);overflow-y:scroll;-webkit-overflow-scrolling:touch;';

    page.innerHTML = `
      <div style="padding:16px 20px 40px;max-width:375px;margin:0 auto;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">
          <button id="avatar-picker-back" style="background:none;border:none;font-size:24px;color:var(--color-text);cursor:pointer;padding:8px;">&larr;</button>
          <h2 style="font-family:var(--font-heading);font-size:var(--text-xl);font-weight:700;color:var(--color-text);margin:0;">Choose Avatar</h2>
          <div style="width:40px;"></div>
        </div>
        <div style="text-align:center;margin-bottom:24px;">
          <div id="avatar-picker-preview"></div>
        </div>
        <div style="margin-bottom:16px;">
          <div class="avatar-picker__label">Color</div>
          <div id="avatar-picker-colors" class="avatar-picker__colors"></div>
        </div>
        <div style="margin-bottom:16px;">
          <div class="avatar-picker__label">Emoji</div>
          <div id="avatar-picker-emojis" class="avatar-picker__emojis"></div>
        </div>
        <button id="avatar-picker-more" class="avatar-picker__more">More emojis...</button>
        <div id="avatar-picker-custom-wrap" class="avatar-picker__custom-wrap" style="display:none;">
          <input id="avatar-picker-custom-input" class="avatar-picker__custom-input" type="text" maxlength="4" placeholder="\u{1F60A}">
        </div>
        <div style="margin-top:24px;">
          <button class="btn btn-primary btn-block" id="avatar-picker-save">Save</button>
          <button class="btn btn-secondary btn-block" id="avatar-picker-cancel" style="margin-top:8px;">Cancel</button>
        </div>
      </div>
    `;

    document.body.appendChild(page);

    const preview = page.querySelector('#avatar-picker-preview');
    const colorsWrap = page.querySelector('#avatar-picker-colors');
    const emojisWrap = page.querySelector('#avatar-picker-emojis');
    const moreBtn = page.querySelector('#avatar-picker-more');
    const customWrap = page.querySelector('#avatar-picker-custom-wrap');
    const customInput = page.querySelector('#avatar-picker-custom-input');
    const saveBtn = page.querySelector('#avatar-picker-save');
    const cancelBtn = page.querySelector('#avatar-picker-cancel');
    const backBtn = page.querySelector('#avatar-picker-back');

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

    updatePreview();

    // Color selection
    colorsWrap.onclick = (e) => {
      const btn = e.target.closest('[data-color]');
      if (!btn) return;
      selectedColor = btn.dataset.color;
      colorsWrap.querySelectorAll('[data-color]').forEach(b => b.classList.toggle('selected', b.dataset.color === selectedColor));
      updatePreview();
    };

    // Emoji selection
    emojisWrap.onclick = (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      selectedEmoji = btn.dataset.emoji;
      customWrap.style.display = 'none';
      emojisWrap.querySelectorAll('[data-emoji]').forEach(b => b.classList.toggle('selected', b.dataset.emoji === selectedEmoji));
      updatePreview();
    };

    // More emojis
    moreBtn.onclick = () => {
      customWrap.style.display = 'flex';
      emojisWrap.querySelectorAll('[data-emoji]').forEach(b => b.classList.remove('selected'));
      customInput.value = '';
      customInput.focus();
    };

    customInput.oninput = () => {
      const val = customInput.value.trim();
      if (val) {
        let firstChar = val;
        if (typeof Intl !== 'undefined' && Intl.Segmenter) {
          const segments = [...new Intl.Segmenter().segment(val)];
          if (segments.length > 0) firstChar = segments[0].segment;
        } else {
          firstChar = [...val][0] || val.slice(0, 2);
        }
        selectedEmoji = firstChar;
        customInput.value = selectedEmoji;
        updatePreview();
      }
    };

    function close(result) {
      page.remove();
      resolve(result);
    }

    saveBtn.onclick = () => close({ color: selectedColor, emoji: selectedEmoji });
    cancelBtn.onclick = () => close(null);
    backBtn.onclick = () => close(null);
  });
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
    // Rollups only. The view also returns a row per subcategory, and the
    // rollup already contains them — see categoryRollupRows.
    for (const s of categoryRollupRows(stats)) {
      totalGames += s.games_played || 0;
      totalWins += s.wins || 0;
      const prof = rowProficiency(s);
      totalAnswered += prof ? prof.met : 0;
      totalCorrect += prof ? prof.mastered : 0;
      if (prof && prof.met >= MIN_QUESTIONS_FOR_ACCURACY) {
        const acc = prof.accuracy;
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
      } else {
        // Send friend request (always requires acceptance)
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
      const r = await showSignUpModal();
      if (r) window.location.reload();
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
    let _confirmTimer = null;
    removeFriendBtn.onclick = async () => {
      const viewer = getCurrentUser();
      if (!viewer) return;
      // Tap-again-to-confirm: first tap shows "Tap to confirm" for 3s.
      // Without this, a stray tap silently destroys the friendship.
      if (!removeFriendBtn.classList.contains('btn--confirming')) {
        removeFriendBtn.textContent = 'Tap to confirm';
        removeFriendBtn.classList.add('btn--confirming');
        _confirmTimer = setTimeout(() => {
          removeFriendBtn.textContent = 'Remove Friend';
          removeFriendBtn.classList.remove('btn--confirming');
          _confirmTimer = null;
        }, 3000);
        return;
      }
      if (_confirmTimer) { clearTimeout(_confirmTimer); _confirmTimer = null; }
      removeFriendBtn.classList.remove('btn--confirming');
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
  const masteryEl = $('#profile-mastery');
  const gamesEl = $('#profile-games');
  const favCatEl = $('#profile-fav-categories');
  const accountEl = $('#profile-account');

  if (!authUser) {
    // Guest view — clean locked state
    const guestGames = parseInt(localStorage.getItem('oracle_party_guest_games') || '0');

    headerAvatar.innerHTML = renderAvatar({ displayName, avatarColor: null, avatarEmoji: null, size: '72px' });
    headerName.textContent = displayName;
    headerTitle.textContent = 'Novice';

    // Hide all profile tab sections and replace with guest CTA
    const profileTabContent = $('#profile-tab-content');
    profileTabContent.innerHTML = `
      <!-- Stats — partial real data -->
      <div class="profile-section">
        <div class="profile-section__label">Stats</div>
        <div class="profile-stats">
          <div class="profile-stat"><div class="profile-stat__value">${guestGames}</div><div class="profile-stat__label">Games</div></div>
          <div class="profile-stat profile-stat--locked"><div class="profile-stat__value">\u2014</div><div class="profile-stat__label">Wins</div></div>
          <div class="profile-stat profile-stat--locked"><div class="profile-stat__value">\u2014</div><div class="profile-stat__label">Win Rate</div></div>
          <div class="profile-stat profile-stat--locked"><div class="profile-stat__value">\u2014</div><div class="profile-stat__label">Accuracy</div></div>
          <div class="profile-stat profile-stat--locked"><div class="profile-stat__value">\u2014</div><div class="profile-stat__label">Strongest</div></div>
          <div class="profile-stat profile-stat--locked"><div class="profile-stat__value">\u2014</div><div class="profile-stat__label">Weakest</div></div>
        </div>
      </div>

      <!-- Single unlock CTA -->
      <div class="profile-section" style="padding-bottom: var(--space-2xl);">
        <div class="guest-unlock-card">
          <div class="guest-unlock-card__icon">\uD83D\uDD2E</div>
          <h3 class="guest-unlock-card__title">Consult the Oracle</h3>
          <ul class="guest-unlock-card__perks">
            <li>\uD83C\uDFAF Track mastery across ${Object.keys(CATEGORY_META).length} categories</li>
            <li>\uD83D\uDCDC Save your game history and stats</li>
            <li>\uD83D\uDC65 Add friends and see who\u2019s online</li>
            <li>\uD83C\uDFC6 Compete on leaderboards</li>
            <li>\u2728 Customize your avatar and title</li>
          </ul>
          <button class="btn btn-primary btn-block" id="profile-create-account">Create Account</button>
          <button class="btn btn-secondary btn-block" id="profile-sign-in" style="margin-top: var(--space-sm);">Sign In</button>
        </div>
      </div>
    `;

    const openSignup = async () => { const r = await showSignUpModal(); if (r) window.location.reload(); };
    const createBtn = $('#profile-create-account');
    if (createBtn) createBtn.onclick = openSignup;

    const signInBtn = $('#profile-sign-in');
    if (signInBtn) signInBtn.onclick = async () => { const r = await showSignInModal(); if (r) window.location.reload(); };

    headerAvatar.onclick = openSignup;
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
  function renderHeaderName() {
    headerName.innerHTML = `${escapeHtml(profile.display_name)}<span class="profile-header__tag">#${escapeHtml(profile.discriminator)}</span><span class="profile-header__edit-pencil">\u270E</span>`;
  }
  renderHeaderName();

  // Display name edit — triggered by tapping name
  const startNameEdit = () => {
    const currentName = profile.display_name || '';
    headerName.innerHTML = `<input type="text" id="edit-display-name" class="input profile-name-input" value="${escapeHtml(currentName)}" maxlength="20" autocomplete="off"><span class="profile-header__tag">#${escapeHtml(profile.discriminator)}</span>`;
    const input = $('#edit-display-name');
    input.focus();
    input.select();
    let _saving = false;

    const saveName = async () => {
      if (_saving) return; // Prevent double-save from Enter + blur firing together
      _saving = true;
      const newName = input.value.trim();
      if (!newName || newName.length < 1 || newName === currentName) {
        renderHeaderName();
        return;
      }
      input.disabled = true;
      const { error } = await updateProfile(userId, { display_name: newName });
      if (error) {
        input.disabled = false;
        _saving = false;
        // Show user-friendly error for duplicate name+discriminator
        const msg = (error.code === '23505') ? 'Name taken with your #tag' : 'Could not update name';
        input.value = msg;
        input.style.borderColor = 'var(--color-danger)';
        input.style.color = 'var(--color-danger)';
        input.style.fontSize = '12px';
        setTimeout(() => { input.value = currentName; input.style.cssText = ''; _saving = false; }, 2000);
        return;
      }
      profile.display_name = newName;
      setDisplayName(newName);
      // Update profile cache in localStorage
      const cached = localStorage.getItem('oracle_party_auth_profile');
      if (cached) {
        try {
          const p = JSON.parse(cached);
          p.display_name = newName;
          localStorage.setItem('oracle_party_auth_profile', JSON.stringify(p));
        } catch {}
      }
      renderHeaderName();
    };

    input.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); saveName(); }
      if (e.key === 'Escape') renderHeaderName();
    };
    input.onblur = saveName;
  };
  headerName.style.cursor = 'pointer';
  headerName.onclick = startNameEdit;

  // Avatar edit
  headerAvatar.onclick = async () => {
    const result = await showAvatarPicker(profile.avatar_color, profile.avatar_emoji);
    if (result) {
      // Every profile save below used to discard the result and update the
      // screen anyway, so a refused write left the player looking at a change
      // that did not exist until they reloaded. updateProfile() uses
      // .single(), which turns the zero-row RLS refusal into a real error, so
      // there is something to check.
      const { error: avatarErr } = await updateProfile(userId, { avatar_color: result.color, avatar_emoji: result.emoji });
      if (reportWriteFailure('Save avatar', avatarErr, "Couldn't save your avatar")) return;
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
  const [stats, games, masteryData] = await Promise.all([
    fetchPlayerStats(userId).catch(() => []),
    fetchGameHistory(userId, 5).catch(() => []),
    fetchMasteryCounts(userId).catch(() => [])
  ]);

  // Build mastery lookup: { "history": N, "history|ancient": N, ... }
  const _mastery = {};
  for (const m of masteryData) {
    const catKey = m.category;
    const subKey = m.subcategory ? `${m.category}|${m.subcategory}` : null;
    _mastery[catKey] = (_mastery[catKey] || 0) + m.mastered;
    if (subKey) _mastery[subKey] = (_mastery[subKey] || 0) + m.mastered;
  }

  // Render mastery section
  if (masteryEl) {
    const totalMastered = Object.entries(_mastery)
      .filter(([k]) => !k.includes('|')) // Only category-level keys (not subcategory)
      .reduce((sum, [, v]) => sum + v, 0);

    if (totalMastered > 0) {
      // Fetch total question counts per category for the progress bars
      const allCats = await fetchCategories().catch(() => []);
      const catTotals = {};
      for (const c of allCats) catTotals[c.name] = c.count;

      // Fetch subcategory counts for categories that have them
      const subTotals = {}; // "category|subcategory" → count
      const subFetches = [];
      for (const [cat] of Object.entries(_mastery).filter(([k]) => k.includes('|'))) {
        const [catName, subKey] = cat.split('|');
        subFetches.push(
          fetchQuestionCount(catName, subKey).then(count => { subTotals[cat] = count; }).catch(() => {})
        );
      }
      await Promise.all(subFetches);

      const totalQuestions = allCats.reduce((s, c) => s + c.count, 0);
      const overallPct = totalQuestions > 0 ? Math.round((totalMastered / totalQuestions) * 100) : 0;

      let masteryHtml = `
        <div class="mastery-summary">
          <div class="mastery-summary__text">${totalMastered} / ${totalQuestions} questions mastered</div>
          <div class="mastery-bar"><div class="mastery-bar__fill" style="width: ${overallPct}%"></div></div>
        </div>
      `;

      // Per-category rows (only categories the player has mastered at least 1 question)
      // Most mastered first, at the owner's request. Object key order is
      // insertion order, which is whatever the query happened to return —
      // meaningless to a reader, and it put the category somebody has barely
      // touched above the one they have nearly finished.
      const catKeys = Object.entries(_mastery)
        .filter(([k]) => !k.includes('|'))
        .sort((a, b) => b[1] - a[1]);
      if (catKeys.length > 0) {
        masteryHtml += catKeys.map(([cat, mastered]) => {
          const meta = CATEGORY_META[cat] || { icon: '?', label: cat };
          const total = catTotals[cat] || 0;
          const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;
          const hasSubs = meta.subcategories?.length > 0;

          // Subcategory rows (walk full tree for nested subcategories)
          let subHtml = '';
          if (hasSubs) {
            // Siblings sorted by how much of them is mastered, at each level,
            // so a child still sits under its own parent — sorting the flat
            // list would tear the tree apart. Counting a node's whole branch,
            // not just itself: a parent whose own count is 0 but whose
            // children hold 40 belongs at the top, not the bottom.
            function branchTotal(node) {
              let total = _mastery[`${cat}|${node.key}`] || 0;
              for (const child of node.children || []) total += branchTotal(child);
              return total;
            }
            function collectSubRows(nodes, depth) {
              let html = '';
              const ordered = [...nodes].sort((a, b) => branchTotal(b) - branchTotal(a));
              for (const s of ordered) {
                const subKey = `${cat}|${s.key}`;
                const subMastered = _mastery[subKey] || 0;
                if (subMastered > 0) {
                  const subTotal = subTotals[subKey] || 0;
                  const indent = depth > 0 ? ' style="padding-left:' + (MASTERY_TREE_BASE_INDENT + depth * MASTERY_TREE_DEPTH_INDENT) + 'px"' : '';
                  // emoji first, like the category row above — this read the
                  // hieroglyph, so the two halves of one list disagreed about
                  // what an icon is.
                  html += `<div class="mastery-row mastery-row--sub"${indent}>
                    <span class="mastery-row__icon">${s.emoji || s.icon}</span>
                    <span class="mastery-row__name">${s.label}</span>
                    <span class="mastery-row__fraction">${subMastered}${subTotal ? '/' + subTotal : ''}</span>
                  </div>`;
                }
                if (s.children) html += collectSubRows(s.children, depth + 1);
              }
              return html;
            }
            const subs = collectSubRows(meta.subcategories, 0);
            if (subs) subHtml = `<div class="mastery-sub-rows" style="display:none;">${subs}</div>`;
          }

          return `<div class="mastery-group" data-cat="${cat}">
            <div class="mastery-row${hasSubs && subHtml ? ' mastery-row--expandable' : ''}">
              <span class="mastery-row__icon">${meta.emoji || meta.icon}</span>
              <span class="mastery-row__name">${meta.label}</span>
              <span class="mastery-row__fraction">${mastered}/${total}</span>
              <div class="mastery-bar mastery-bar--inline"><div class="mastery-bar__fill" style="width: ${pct}%"></div></div>
              ${hasSubs && subHtml ? '<span class="mastery-row__chevron">›</span>' : ''}
            </div>
            ${subHtml}
          </div>`;
        }).join('');
      }

      masteryEl.innerHTML = masteryHtml;

      // Wire expand/collapse
      masteryEl.querySelectorAll('.mastery-row--expandable').forEach(row => {
        row.style.cursor = 'pointer';
        row.onclick = () => {
          const group = row.closest('.mastery-group');
          const subs = group?.querySelector('.mastery-sub-rows');
          const chevron = row.querySelector('.mastery-row__chevron');
          if (subs) {
            const showing = subs.style.display !== 'none';
            subs.style.display = showing ? 'none' : '';
            if (chevron) chevron.textContent = showing ? '›' : '⌄';
          }
        };
      });
    } else {
      masteryEl.innerHTML = '<p class="profile-empty">Play games to start mastering questions</p>';
    }
  }

  // Title — use custom title if builder is unlocked, otherwise auto-title
  const customTitle = buildDisplayTitle(profile);
  headerTitle.textContent = customTitle || calculateTitle(stats).title;

  // Title Builder
  const builderSection = $('#title-builder-section');
  if (builderSection) {
    builderSection.style.display = '';
    if (profile.title_builder_unlocked) {
      $('#title-builder-locked').style.display = 'none';
      $('#title-builder-wheel').style.display = '';
      renderTitleWheel(userId, profile, stats);
    } else {
      $('#title-builder-locked').style.display = '';
      $('#title-builder-wheel').style.display = 'none';

      // Say WHICH category is closest and by how much. "Reach Apprentice" is
      // true and useless: it names a rank the player has no way to locate and
      // no way to price. tierProgress already knows both.
      const peek = $('#title-builder-locked__peek');
      if (peek) {
        let best = null;
        for (const row of mergedCategoryRows(stats)) {
          const prog = tierProgress(row);
          if (!prog || prog.tier) continue;
          const cost = prog.met < prog.required
            ? (prog.required - prog.met)
            : (prog.needed ?? Infinity);
          if (!best || cost < best.cost) best = { cost, category: row.category, prog };
        }
        if (best && Number.isFinite(best.cost)) {
          const label = CATEGORY_META[best.category]?.label || best.category;
          peek.textContent = best.prog.met < best.prog.required
            ? `Closest: ${label}, ${best.cost} more questions · See what there is to earn ›`
            : `Closest: ${label}, ${best.cost} more correct · See what there is to earn ›`;
        }
      }
    }

    // The padlock opens the collection whether or not the builder is unlocked.
    const lockedBtn = $('#title-builder-locked');
    if (lockedBtn) lockedBtn.onclick = () => openTitleGallery(userId);
    const galleryBtn = $('#btn-open-gallery');
    if (galleryBtn) galleryBtn.onclick = () => openTitleGallery(userId);
    const closeBtn = $('#btn-close-gallery');
    if (closeBtn) closeBtn.onclick = closeTitleGallery;
  }

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
      bioSaveTimeout = setTimeout(async () => {
        const { error } = await updateProfile(userId, { bio: text });
        if (reportWriteFailure('Save bio', error, "Couldn't save your bio")) return;
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
  // Rollups only — see categoryRollupRows. This also fixes "Strongest" and
  // "Weakest", which could otherwise name a category while reporting the
  // accuracy of one narrow subcategory inside it.
  for (const s of mergedCategoryRows(stats)) {
    totalGames += s.games_played || 0;
    totalWins += s.wins || 0;
    const prof = rowProficiency(s);
    totalAnswered += prof ? prof.met : 0;
    totalCorrect += prof ? prof.mastered : 0;
    if (prof && prof.met >= MIN_QUESTIONS_FOR_CATEGORY) {
      const acc = prof.accuracy;
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

  // ------------------------------------------
  // STRENGTHS RADAR
  //
  // Drawn from the SAME merged rows as everything else on this page, so the
  // shape and the list below it can never disagree.
  //
  // Proficiency, not mastery: mastery would be near zero for everybody,
  // because the bank holds 4,859 questions, and a chart that is a dot for
  // every player is not a chart.
  // ------------------------------------------
  const radarSection = $('#profile-radar-section');
  const radarEl = $('#profile-radar');
  if (radarSection && radarEl) {
    const byCategory = {};
    for (const row of mergedCategoryRows(stats)) {
      const prof = rowProficiency(row);
      if (prof) byCategory[row.category] = prof;
    }
    const axesInput = Object.entries(CATEGORY_META)
      .map(([key, meta]) => ({ key, label: meta.label, emoji: meta.emoji || meta.icon }));
    const { axes, anyData } = buildRadarAxes(axesInput, byCategory);

    // Hidden entirely until there is something to draw. An empty twelve-sided
    // outline says nothing and looks broken.
    radarSection.style.display = anyData ? '' : 'none';
    if (anyData) {
      radarEl.innerHTML = renderRadarSvg(axes);
      const caption = $('#profile-radar-caption');
      if (caption) {
        const { strongest, weakest } = radarExtremes(axes);
        const bits = [];
        if (strongest) bits.push(`Strongest ${strongest.label} ${Math.round(strongest.value * 100)}%`);
        if (weakest) bits.push(`weakest ${weakest.label} ${Math.round(weakest.value * 100)}%`);
        const untried = axes.filter(a => !a.hasData).length;
        if (untried > 0) bits.push(`${untried} not tried yet`);
        caption.textContent = bits.join(' \u00b7 ');
      }
    }
  }

  // Per-category breakdown
  if (categoriesEl) {
    // ONE row per category, sorted strongest first.
    //
    // mergedCategoryRows rather than a plain filter: the profile was showing
    // WILD CARD THREE TIMES. player_stats_computed is meant to emit a single
    // rollup per category, and it emitted three the app could not tell apart —
    // null, '' and undefined all read as "no subcategory", so each became
    // another identical line under the same name. Merging their counters is
    // self-healing and cannot under-report.
    //
    // Sorted by proficiency, because that is what the section is called and
    // what every row shows. Ties go to the bigger sample: 100% from two
    // questions should not sit above 92% from sixty.
    const catStats = mergedCategoryRows(stats).sort((a, b) => {
      const pa = rowProficiency(a), pb = rowProficiency(b);
      return (pb?.accuracy ?? -1) - (pa?.accuracy ?? -1) || (pb?.met ?? 0) - (pa?.met ?? 0);
    });
    const subStats = stats.filter(s => s.subcategory);

    if (catStats.length > 0) {
      categoriesEl.innerHTML = catStats.map(s => {
        const meta = CATEGORY_META[s.category] || { icon: '?', label: s.category };
        const prof = rowProficiency(s);
        const acc = prof ? Math.round(prof.accuracy * 100) : 0;
        const hasSubs = subStats.some(sub => sub.category === s.category);

        // Build subcategory rows if any exist
        let subHtml = '';
        if (hasSubs) {
          const subs = subStats
            .filter(sub => sub.category === s.category)
            .sort((a, b) => {
              const pa = rowProficiency(a), pb = rowProficiency(b);
              return (pb?.accuracy ?? -1) - (pa?.accuracy ?? -1) || (pb?.met ?? 0) - (pa?.met ?? 0);
            });
          subHtml = `<div class="profile-subcategory-rows" style="display:none;">
            ${subs.map(sub => {
              const subNode = findSubcategoryNode(meta, sub.subcategory);
              // resolveSubcategoryIcon, not subNode.icon.
              //
              // Two faults in one line before. It read the HIEROGLYPH while the
              // category row above it reads the emoji, so the two halves of the
              // same list disagreed about what an icon is. And when the node
              // was not found it rendered NOTHING — which is every wild-card
              // subcategory, because those live under `wildCardOptions` rather
              // than `subcategories`, and every value the tree does not know.
              // resolveSubcategoryIcon handles both and falls back to the
              // category's own icon, so a row can never come out blank.
              const subIcon = resolveSubcategoryIcon(s.category, sub.subcategory);
              const subLabel = subNode?.label || sub.subcategory;
              const subProf = rowProficiency(sub);
              const subAcc = subProf ? Math.round(subProf.accuracy * 100) : 0;
              return `<div class="profile-category-row profile-category-row--sub">
                <span>${subIcon}</span>
                <span class="profile-category-row__name">${escapeHtml(subLabel)}</span>
                <span class="profile-category-row__accuracy">${subAcc}%</span>
              </div>`;
            }).join('')}
          </div>`;
        }

        // Where they stand and what would move them, UNDER the name rather
        // than beside it. A rank is accuracy x log2(questions), which nobody
        // can guess — the owner asked where their ranks were and how to
        // improve them and the app answered neither. A second line is also the
        // shape that survived the lobby row overflow: anything added alongside
        // the name competes for width that is not there at 375px.
        const prog = tierProgress(s);
        let rankLine = '';
        if (prog) {
          const parts = [];
          if (prog.tier) parts.push(prog.tier);
          if (prog.met < prog.required) {
            // Volume gate first. Below it there is no rank at any accuracy, so
            // saying anything about accuracy here would be a promise the
            // player cannot cash in.
            parts.push(`${prog.required - prog.met} more questions for a rank`);
          } else if (prog.next && prog.needed != null) {
            parts.push(`${prog.needed} more correct \u2192 ${prog.next}`);
          } else if (prog.next) {
            parts.push(`working towards ${prog.next}`);
          } else {
            parts.push('highest rank');
          }
          rankLine = `<div class="profile-category-row__rank">${escapeHtml(parts.join(' \u00b7 '))}</div>`;
        }

        return `<div class="profile-category-group" data-category="${s.category}">
          <div class="profile-category-row${hasSubs ? ' profile-category-row--expandable' : ''}">
            <span>${meta.emoji || meta.icon}</span>
            <span class="profile-category-row__name">${meta.label}${rankLine}</span>
            <span class="profile-category-row__accuracy">${acc}%</span>
            ${hasSubs ? '<span class="profile-category-row__chevron">›</span>' : ''}
          </div>
          ${subHtml}
        </div>`;
      }).join('');

      // Wire expand/collapse on category rows with subcategories
      categoriesEl.querySelectorAll('.profile-category-row--expandable').forEach(row => {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => {
          const group = row.closest('.profile-category-group');
          const subRows = group.querySelector('.profile-subcategory-rows');
          const chevron = row.querySelector('.profile-category-row__chevron');
          if (subRows) {
            const showing = subRows.style.display !== 'none';
            subRows.style.display = showing ? 'none' : '';
            if (chevron) chevron.textContent = showing ? '›' : '⌄';
          }
        });
      });
    } else {
      categoriesEl.innerHTML = '<p class="profile-empty">Play some games to see category stats</p>';
    }
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
            <span>${meta.emoji || meta.icon}</span>
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
      return `<button class="profile-fav-cat ${selected}" data-cat="${name}">${meta.emoji || meta.icon} ${meta.label}</button>`;
    }).join('');

    favCatEl.onclick = async (e) => {
      const btn = e.target.closest('[data-cat]');
      if (!btn) return;
      const cat = btn.dataset.cat;
      $$('.profile-fav-cat', favCatEl).forEach(b => b.classList.toggle('selected', b.dataset.cat === cat));
      const { error: favErr } = await updateProfile(userId, { favorite_category: cat });
      if (reportWriteFailure('Save favourite category', favErr, "Couldn't save that")) {
        // Put the selection back where it was, rather than leaving the player
        // looking at a choice the database never accepted.
        $$('.profile-fav-cat', favCatEl).forEach(b =>
          b.classList.toggle('selected', b.dataset.cat === profile.favorite_category));
        return;
      }
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

      <div class="danger-zone">
        <div class="danger-zone__title">Delete Account</div>
        <p class="danger-zone__text">
          Permanently removes your account, stats, history, titles and friends.
          This cannot be undone and you will not be able to sign in again.
        </p>
        <button class="btn btn-danger btn-block" id="profile-delete-account">Delete Account</button>
        <div id="profile-delete-confirm" class="hidden">
          <p class="danger-zone__text">Type <strong>DELETE</strong> to confirm.</p>
          <input type="text" id="profile-delete-input" class="input" autocomplete="off"
                 autocapitalize="characters" spellcheck="false" aria-label="Type DELETE to confirm">
          <button class="btn btn-danger btn-block" id="profile-delete-go" disabled
                  style="margin-top: var(--space-sm);">Permanently Delete</button>
          <button class="btn btn-secondary btn-block" id="profile-delete-cancel"
                  style="margin-top: var(--space-xs);">Cancel</button>
        </div>
      </div>
    `;

    // Online status toggle
    const onlineToggle = $('#profile-online-toggle');
    if (onlineToggle) {
      onlineToggle.onchange = async () => {
        const showOnline = onlineToggle.checked;
        const { error: onlineErr } = await updateProfile(userId, { show_online_status: showOnline });
        if (reportWriteFailure('Save visibility', onlineErr, "Couldn't change your online status")) {
          onlineToggle.checked = !showOnline;   // a switch that lies is worse than one that refuses
          return;
        }
        profile.show_online_status = showOnline;
        if (!showOnline) {
          destroyGlobalPresence();
        } else {
          await initGlobalPresence(userId);
        }
      };
    }

    // OLED Black Mode toggle — sets preference for the sun/moon toggle behavior.
    // When ON: immediately switches to OLED black + future sun/moon swaps light ↔ OLED.
    // When OFF: switches to regular dark (if on OLED) + future sun/moon swaps light ↔ dark.
    const oledToggle = $('#profile-oled-toggle');
    if (oledToggle) {
      oledToggle.onchange = () => {
        localStorage.setItem('oracle_party_oled_pref', oledToggle.checked ? '1' : '0');
        if (oledToggle.checked) {
          // Switch to OLED immediately so the user sees the effect
          applyTheme('oled');
        } else {
          // Turn off OLED — go to regular dark (not light)
          const currentTheme = document.documentElement.getAttribute('data-theme') || 'light';
          if (currentTheme === 'oled') applyTheme('dark');
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
        navigateWithFade('index.html');
      };
    }

    // --- Delete account -------------------------------------------------
    //
    // Deliberately NOT the tap-again-to-confirm used for quitting and host
    // transfer. Those are recoverable in seconds; this is not recoverable at
    // all, and a stray double-tap on a phone must not be able to destroy an
    // account. Typing the word is a deliberate act that cannot happen by
    // accident.
    const deleteBtn = $('#profile-delete-account');
    const confirmBox = $('#profile-delete-confirm');
    const deleteInput = $('#profile-delete-input');
    const deleteGo = $('#profile-delete-go');
    const deleteCancel = $('#profile-delete-cancel');

    if (deleteBtn && confirmBox && deleteInput && deleteGo && deleteCancel) {
      deleteBtn.onclick = () => {
        deleteBtn.classList.add('hidden');
        confirmBox.classList.remove('hidden');
        deleteInput.focus({ preventScroll: true });
      };
      deleteCancel.onclick = () => {
        confirmBox.classList.add('hidden');
        deleteBtn.classList.remove('hidden');
        deleteInput.value = '';
        deleteGo.disabled = true;
      };
      deleteInput.oninput = () => {
        deleteGo.disabled = deleteInput.value.trim().toUpperCase() !== 'DELETE';
      };
      deleteGo.onclick = async () => {
        deleteGo.disabled = true;
        deleteGo.textContent = 'Deleting...';
        const { error: delErr } = await deleteMyAccount();
        if (delErr) {
          // Say so. Telling somebody their data is gone when it is not is the
          // worst version of the silent-failure bug in this codebase, because
          // they will believe it and act on it.
          showToast("Couldn't delete your account — nothing was removed", 'error');
          deleteGo.textContent = 'Permanently Delete';
          deleteGo.disabled = false;
          return;
        }
        // Before signOut, because signOut swallows its own failures — if it
        // cannot reach the server the session survives, and this flag is what
        // stops the next page load recreating the profile just deleted.
        markAccountDeleted();
        await signOut();
        navigateWithFade('index.html');
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
      tabs.forEach(t => {
        const isActive = t.dataset.tab === target;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
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
  if (!userId) return; // Guests can't have friend requests
  const pendingListEl = $('#friends-pending-list');
  const pendingSection = $('#friends-pending');
  const friendsListEl = $('#friends-list');
  const searchInput = $('#friends-search-input');
  const searchResults = $('#friends-search-results');

  // Load pending requests
  let pending = [];
  try {
    pending = await fetchPendingRequests(userId);
    logger.debug('Profile', 'Pending friend requests: ' + pending.length, pending);
  } catch (err) {
    logger.error('Profile', 'fetchPendingRequests failed', err);
  }
  if (pending.length > 0) {
    pendingSection.style.display = '';
    const senderIds = pending.map(r => r.sender_id);
    // Batch-fetch sender profiles
    const profiles = await _batchFetchProfiles(senderIds);

    pendingListEl.innerHTML = pending.map(req => {
      const p = profiles[req.sender_id] || {};
      const avatar = renderAvatar({ displayName: p.display_name || '?', avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji });
      const tag = p.discriminator ? `<span class="request-row__tag">#${escapeHtml(p.discriminator)}</span>` : '';
      return `<div class="request-row" data-request-id="${req.id}" data-profile-user-id="${req.sender_id}" data-profile-name="${escapeHtml(p.display_name || 'Unknown')}" data-profile-color="${p.avatar_color || ''}" data-profile-emoji="${p.avatar_emoji || ''}">
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

    // Wire accept/decline + profile card tap
    pendingListEl.addEventListener('click', async (e) => {
      const acceptBtn = e.target.closest('[data-accept]');
      const declineBtn = e.target.closest('[data-decline]');
      if (acceptBtn) {
        e.stopPropagation();
        acceptBtn.disabled = true;
        const origText = acceptBtn.textContent;
        acceptBtn.textContent = '...';
        try {
          const { error } = await acceptFriendRequest(parseInt(acceptBtn.dataset.accept, 10));
          if (error) {
            logger.error('Profile', 'acceptFriendRequest failed', error);
            acceptBtn.textContent = 'Error';
            acceptBtn.disabled = false;
            // SAY WHY. A bare "Error" is why a playtest report about this
            // could not be acted on at all: the person accepting saw one word,
            // the reason reached a log nobody was reading, and both of us were
            // left guessing at what the database had actually said.
            showToast(error.message || "Couldn't accept that request — try again");
            setTimeout(() => { acceptBtn.textContent = origText; }, 2000);
            return;
          }
          acceptBtn.textContent = 'Accepted!';
          setTimeout(() => loadFriendsTab(userId), 600);
        } catch (err) {
          logger.error('Profile', 'acceptFriendRequest threw', err);
          acceptBtn.textContent = 'Error';
          acceptBtn.disabled = false;
          setTimeout(() => { acceptBtn.textContent = origText; }, 2000);
        }
        return;
      }
      if (declineBtn) {
        e.stopPropagation();
        declineBtn.disabled = true;
        declineBtn.textContent = '...';
        try {
          await declineFriendRequest(parseInt(declineBtn.dataset.decline, 10));
        } catch (err) {
          logger.error('Profile', 'declineFriendRequest threw', err);
        }
        loadFriendsTab(userId);
        return;
      }
      // Profile card on row tap
      const row = e.target.closest('[data-profile-user-id]');
      if (row) {
        showProfileCard({
          userId: row.dataset.profileUserId,
          displayName: row.dataset.profileName || 'Unknown',
          avatarColor: row.dataset.profileColor || null,
          avatarEmoji: row.dataset.profileEmoji || null
        });
      }
    });
  } else {
    pendingSection.style.display = 'none';
  }

  // Sent requests (outgoing) — show with cancel button
  const sentRequests = await fetchSentRequests(userId);
  if (sentRequests.length > 0) {
    const receiverIds = sentRequests.map(r => r.receiver_id);
    const sentProfiles = await _batchFetchProfiles(receiverIds);

    // Inject sent section after pending section
    let sentSection = document.getElementById('sent-requests-section');
    if (!sentSection) {
      sentSection = document.createElement('div');
      sentSection.id = 'sent-requests-section';
      pendingSection.parentNode.insertBefore(sentSection, pendingSection.nextSibling);
    }
    sentSection.style.display = '';
    sentSection.innerHTML = `
      <div class="section-title" style="margin-top: var(--space-md);">Sent Requests</div>
      <div id="sent-requests-list"></div>
    `;
    const sentListEl = sentSection.querySelector('#sent-requests-list');
    sentListEl.innerHTML = sentRequests.map(req => {
      const p = sentProfiles[req.receiver_id] || {};
      const avatar = renderAvatar({ displayName: p.display_name || '?', avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji });
      return `<div class="request-row" data-request-id="${req.id}">
        ${avatar}
        <div class="request-row__info">
          <div class="request-row__name">${escapeHtml(p.display_name || 'Unknown')}</div>
        </div>
        <div class="request-row__actions">
          <button class="btn btn-secondary" data-cancel="${req.id}">Cancel</button>
        </div>
      </div>`;
    }).join('');

    sentListEl.onclick = async (e) => {
      const cancelBtn = e.target.closest('[data-cancel]');
      if (!cancelBtn) return;
      cancelBtn.disabled = true;
      cancelBtn.textContent = '...';
      await cancelFriendRequest(parseInt(cancelBtn.dataset.cancel));
      loadFriendsTab(userId);
    };
  } else {
    const sentSection = document.getElementById('sent-requests-section');
    if (sentSection) sentSection.style.display = 'none';
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

      return `<div class="friend-row" data-profile-user-id="${f.user_id}" data-profile-name="${escapeHtml(f.display_name)}" data-profile-color="${f.avatar_color || ''}" data-profile-emoji="${f.avatar_emoji || ''}">
        ${avatar}
        <div class="friend-row__info">
          <div class="friend-row__name">${escapeHtml(f.display_name)}${tag}</div>
          <div class="friend-row__activity">${statusDot} ${activityText}</div>
        </div>
        ${actionHtml}
      </div>`;
    }).join('');

    // Join friend's lobby or open profile card
    friendsListEl.onclick = (e) => {
      const joinBtn = e.target.closest('[data-join-code]');
      if (joinBtn) {
        navigateWithFade(`join.html?code=${joinBtn.dataset.joinCode}`);
        return;
      }
      const row = e.target.closest('[data-profile-user-id]');
      if (row) {
        logger.debug('Profile', 'Friend row tapped, userId: ' + row.dataset.profileUserId);
        showProfileCard({
          userId: row.dataset.profileUserId,
          displayName: row.dataset.profileName || 'Unknown',
          avatarColor: row.dataset.profileColor || null,
          avatarEmoji: row.dataset.profileEmoji || null
        });
      }
    };
  } else {
    friendsListEl.innerHTML = '<p class="profile-empty">No friends yet. Search to add some!</p>';
  }

  // Search
  searchInput.oninput = () => {
    clearTimeout(_searchTimeout);
    const query = searchInput.value.trim();
    if (query.length < 1) {
      searchResults.innerHTML = '';
      _searchVersion++;  // invalidate any in-flight search
      return;
    }
    _searchTimeout = setTimeout(() => _runFriendSearch(query, userId, searchResults), 300);
  };
}

let _searchVersion = 0;
async function _runFriendSearch(query, userId, resultsEl) {
  const version = ++_searchVersion;
  // After every async hop below, check `version === _searchVersion`. If a newer
  // search has started, abandon this one — otherwise stale slow results would
  // overwrite the newer ones (or render after the user navigated away).
  let results;

  // Parse Name#discriminator format
  const hashIdx = query.indexOf('#');
  if (hashIdx !== -1) {
    const namePart = query.substring(0, hashIdx).trim();
    const discPart = query.substring(hashIdx + 1).trim();

    if (discPart.length === 4 && /^\d{4}$/.test(discPart) && namePart) {
      // Exact tag lookup: "Name#1234"
      const { data } = await fetchProfileByTag(namePart, discPart);
      results = data && data.user_id !== userId ? [data] : [];
    } else if (namePart) {
      // Partial: "Name#" or "Name#12" — search by name, optionally filter disc
      results = await searchProfiles(namePart, userId, discPart || null);
    } else {
      results = [];
    }
  } else {
    results = await searchProfiles(query, userId);
  }

  if (version !== _searchVersion) return; // stale
  if (results.length === 0) {
    resultsEl.innerHTML = '<p class="profile-empty" style="padding: var(--space-sm) 0;">No results found</p>';
    return;
  }

  // Check which results are already friends or have pending requests
  const sentRequests = await fetchSentRequests(userId);
  if (version !== _searchVersion) return; // stale
  const sentSet = new Set(sentRequests.map(r => r.receiver_id));

  const html = (await Promise.all(results.map(async (p) => {
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

    return `<div class="search-result-row" data-profile-user-id="${p.user_id}" data-profile-name="${escapeHtml(p.display_name)}" data-profile-color="${p.avatar_color || ''}" data-profile-emoji="${p.avatar_emoji || ''}">
      ${avatar}
      <div class="search-result-row__info">
        <div class="search-result-row__name">${escapeHtml(p.display_name)}${tag}</div>
      </div>
      ${actionHtml}
    </div>`;
  }))).join('');
  if (version !== _searchVersion) return; // stale — abandon render
  resultsEl.innerHTML = html;

  // Wire send request buttons + profile card taps
  resultsEl.onclick = async (e) => {
    const btn = e.target.closest('[data-send-request]');
    if (btn) {
      e.stopPropagation();
    } else {
      // Profile card tap (anywhere on row except buttons)
      const row = e.target.closest('[data-profile-user-id]');
      if (row) {
        showProfileCard({
          userId: row.dataset.profileUserId,
          displayName: row.dataset.profileName || 'Unknown',
          avatarColor: row.dataset.profileColor,
          avatarEmoji: row.dataset.profileEmoji
        });
      }
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Sending...';
    const { error, autoAccepted } = await sendFriendRequest(userId, btn.dataset.sendRequest);
    if (autoAccepted) {
      btn.textContent = 'Friends!';
      btn.className = 'btn btn-secondary';
    } else if (error) {
      btn.textContent = error.message || 'Error';
      btn.disabled = false; // Re-enable so user can retry
    } else {
      btn.textContent = 'Sent';
    }
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
    logger.error('Profile', '_batchFetchProfiles failed', error);
    return {};
  }
  const map = {};
  for (const p of (data || [])) map[p.user_id] = p;
  return map;
}

/**
 * The radar, as inline SVG. No library — this project has one runtime
 * dependency and it is not a charting one.
 *
 * Emoji sit OUTSIDE the outer ring at each axis, so nothing has to fit text
 * around a circle at 375px. An axis with no data is dimmed rather than drawn
 * at zero, because "never tried" and "bad at" are different facts.
 */
function renderRadarSvg(axes) {
  const V = RADAR_VIEWBOX;
  const R = 34;          // outer ring
  const LABEL_R = 44;    // where the emoji sit, outside the ring
  const n = axes.length;

  const rings = [0.25, 0.5, 0.75, 1]
    .map(f => `<polygon class="radar__ring" points="${polygonPoints(radarPoints(n, f, R))}"/>`)
    .join('');

  const spokes = radarPoints(n, 1, R)
    .map(p => `<line class="radar__spoke" x1="${V / 2}" y1="${V / 2}" x2="${p.x.toFixed(2)}" y2="${p.y.toFixed(2)}"/>`)
    .join('');

  // The shape spans ONLY the axes with data.
  //
  // Drawing an untried category at the centre and joining it up looked wrong
  // in a way the numbers did not predict: three zeroes among twelve pull three
  // vertices to the middle, and the outline crosses itself into a jagged star
  // that reads as broken rather than as a profile. Skipping those vertices
  // gives the honest shape — the outline of what is actually known — and the
  // dim emoji still says which categories are missing from it.
  const all = radarPoints(n, axes.map(a => a.value), R);
  const played = all.filter((_, i) => axes[i].hasData);
  const shape = played.length >= 3
    ? `<polygon class="radar__shape" points="${polygonPoints(played)}"/>`
    // Under three points there is no polygon to draw. The dots below carry it,
    // which is the right amount of ceremony for somebody two categories in.
    : '';

  const dots = all
    .map((p, i) => axes[i].hasData
      ? `<circle class="radar__dot" cx="${p.x.toFixed(2)}" cy="${p.y.toFixed(2)}" r="1.6"/>`
      : '')
    .join('');

  const labels = radarPoints(n, 1, LABEL_R).map((p, i) => {
    const a = axes[i];
    const title = a.hasData
      ? `${a.label}: ${Math.round(a.value * 100)}% of ${a.met}`
      : `${a.label}: not tried yet`;
    return `<text class="radar__label${a.hasData ? '' : ' radar__label--untried'}" x="${p.x.toFixed(2)}" y="${p.y.toFixed(2)}"
      text-anchor="middle" dominant-baseline="central">${escapeHtml(a.emoji)}<title>${escapeHtml(title)}</title></text>`;
  }).join('');

  return `<svg viewBox="0 0 ${V} ${V}" role="img" aria-label="Proficiency by category">
    ${rings}${spokes}${shape}${dots}${labels}
  </svg>`;
}

// ============================================
// TITLE COLLECTION
//
// Forty title words exist. Until now a player could see NONE of them before
// reaching Apprentice — the Title Builder was a padlock reading "Reach
// Apprentice to unlock", which says nothing about what is behind it, how many
// there are, or how to get there. A progression nobody can see is not a
// progression, and this is the second half of that same complaint.
//
// Every word already carries a `hint`, written long ago and never rendered
// anywhere except a three-second toast inside the builder — which only opens
// once you have already got in. Three words have `hint: null` on purpose;
// those are secrets and the gallery says so rather than showing an empty
// space that reads like a bug.
//
// Locked words show the hint and the rarity, NOT the word. That was the
// owner's call, and it is what the hints were plainly written for.
// ============================================

const RARITY_ORDER = { common: 0, rare: 1, epic: 2, legendary: 3 };
const SLOT_NAMES = {
  1: { name: 'The Adjective', blurb: 'How you play — persistence, loyalty, luck.' },
  2: { name: 'The Calling', blurb: 'What you know. Earned by mastering a category.' },
  3: { name: 'The Rank', blurb: 'How far you have come.' },
};

function galleryCard(word, level) {
  const earned = level > 0;
  const secret = !word.hint;
  const rarity = word.rarity || 'common';

  if (earned) {
    return `<div class="title-card title-card--earned" data-rarity="${rarity}">
      <div class="title-card__word">${escapeHtml(word.word)}</div>
      <div class="title-card__meta">${escapeHtml(rarity)}${level > 1 ? ` \u00b7 level ${level}` : ''}</div>
    </div>`;
  }
  if (secret) {
    return `<div class="title-card title-card--secret" data-rarity="${rarity}">
      <div class="title-card__word">&#x2753;</div>
      <div class="title-card__meta">${escapeHtml(rarity)} \u00b7 secret</div>
    </div>`;
  }
  return `<div class="title-card title-card--locked" data-rarity="${rarity}">
    <div class="title-card__word">&#x2013;&#x2013;&#x2013;</div>
    <div class="title-card__hint">${escapeHtml(word.hint)}</div>
    <div class="title-card__meta">${escapeHtml(rarity)}</div>
  </div>`;
}

async function renderTitleGallery(userId) {
  const body = $('#title-gallery-body');
  const summary = $('#title-gallery-summary');
  if (!body) return;

  // A guest has no account and therefore no unlocks, but can still browse —
  // seeing what an account is for is the whole point of letting them look.
  let unlockMap = {};
  if (userId) {
    const unlocks = await fetchTitleUnlocks(userId).catch(() => []);
    for (const u of unlocks) unlockMap[u.word_id] = u.level;
  }

  const all = Object.entries(TITLE_WORDS).map(([id, w]) => ({ id, ...w, level: unlockMap[id] || 0 }));
  const earned = all.filter(w => w.level > 0).length;

  if (summary) {
    summary.textContent = userId
      ? `${earned} of ${all.length} earned. Locked ones show a clue, not the word.`
      : `${all.length} titles to earn. Sign up to start collecting — locked ones show a clue, not the word.`;
  }

  body.innerHTML = [1, 2, 3].map(slot => {
    const words = all
      .filter(w => w.slot === slot)
      // Earned first so progress reads at a glance, then by how rare it is:
      // the interesting locked ones should not be buried under twelve commons.
      .sort((a, b) => (b.level > 0) - (a.level > 0)
        || (RARITY_ORDER[a.rarity] ?? 0) - (RARITY_ORDER[b.rarity] ?? 0)
        || a.word.localeCompare(b.word));
    const got = words.filter(w => w.level > 0).length;
    const meta = SLOT_NAMES[slot];
    return `<section class="title-gallery__slot">
      <div class="title-gallery__slot-head">
        <span class="title-gallery__slot-name">${escapeHtml(meta.name)}</span>
        <span class="title-gallery__slot-count">${got} / ${words.length}</span>
      </div>
      <p class="title-gallery__slot-blurb">${escapeHtml(meta.blurb)}</p>
      <div class="title-cards">${words.map(w => galleryCard(w, w.level)).join('')}</div>
    </section>`;
  }).join('');
}

function openTitleGallery(userId) {
  const el = $('#title-gallery');
  if (!el) return;
  el.hidden = false;
  renderTitleGallery(userId);
}

function closeTitleGallery() {
  const el = $('#title-gallery');
  if (el) el.hidden = true;
}

// ============================================
// TITLE BUILDER WHEEL
// ============================================

async function renderTitleWheel(userId, profile, stats) {
  const unlocks = await fetchTitleUnlocks(userId);
  const unlockMap = {};
  for (const u of unlocks) unlockMap[u.word_id] = u.level;

  const selectedWords = {
    1: profile.title_slot1 || null,
    2: profile.title_slot2 || null,
    3: profile.title_slot3 || null
  };

  // Render each slot column
  for (const slotNum of [1, 2, 3]) {
    const column = $(`#wheel-slot${slotNum}`);
    if (!column) continue;

    // Get words for this slot
    const words = Object.entries(TITLE_WORDS)
      .filter(([, w]) => w.slot === slotNum)
      .map(([id, w]) => ({ id, ...w, level: unlockMap[id] || 0 }));

    // Sort: unlocked first (alphabetical), then locked (by rarity order)
    const rarityOrder = { common: 0, rare: 1, legendary: 2 };
    words.sort((a, b) => {
      if (a.level > 0 && b.level === 0) return -1;
      if (a.level === 0 && b.level > 0) return 1;
      if (a.level > 0 && b.level > 0) return a.word.localeCompare(b.word);
      return (rarityOrder[a.rarity] || 0) - (rarityOrder[b.rarity] || 0);
    });

    column.innerHTML = words.map(w => {
      if (w.level === 0) {
        // Locked
        return `<div class="title-wheel-item title-wheel-item--locked" data-hint="${escapeHtml(w.hint || '')}">\u2753</div>`;
      }
      const isSelected = selectedWords[slotNum] === w.id;
      const levelClass = w.level >= 3 ? 'title-wheel-item--level3' : w.level >= 2 ? 'title-wheel-item--level2' : '';
      return `<div class="title-wheel-item ${isSelected ? 'title-wheel-item--selected' : ''} ${levelClass}" data-word-id="${w.id}" data-slot="${slotNum}">${escapeHtml(w.word)}</div>`;
    }).join('');

    // Click handler for selection
    column.onclick = (e) => {
      const item = e.target.closest('.title-wheel-item');
      if (!item) return;

      // Locked item — show hint
      if (item.classList.contains('title-wheel-item--locked')) {
        const hint = item.dataset.hint;
        if (hint) {
          const hintEl = $('#title-hint-toast');
          hintEl.textContent = hint;
          hintEl.classList.add('active');
          setTimeout(() => hintEl.classList.remove('active'), 3000);
        }
        return;
      }

      // Unlocked item — select it
      const wordId = item.dataset.wordId;
      const slot = parseInt(item.dataset.slot, 10);
      selectedWords[slot] = wordId;

      // Update visual selection
      column.querySelectorAll('.title-wheel-item').forEach(el => el.classList.remove('title-wheel-item--selected'));
      item.classList.add('title-wheel-item--selected');

      // Update preview
      updateTitlePreview(selectedWords);
      // Update uniqueness
      updateTitleUniqueness(selectedWords);
    };

    // Scroll to selected item
    const selectedEl = column.querySelector('.title-wheel-item--selected');
    if (selectedEl) {
      setTimeout(() => selectedEl.scrollIntoView({ block: 'center', behavior: 'smooth' }), 100);
    }
  }

  // Initial preview
  updateTitlePreview(selectedWords);
  updateTitleUniqueness(selectedWords);

  // Save button
  const saveBtn = $('#btn-save-title');
  if (saveBtn) {
    saveBtn.onclick = async () => {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      const { error: titleErr } = await updateProfile(userId, {
        title_slot1: selectedWords[1],
        title_slot2: selectedWords[2],
        title_slot3: selectedWords[3]
      });
      if (reportWriteFailure('Save title', titleErr, "Couldn't save your title")) {
        saveBtn.textContent = 'Not saved';
        setTimeout(() => { saveBtn.textContent = 'Save Title'; saveBtn.disabled = false; }, 2000);
        return;
      }
      profile.title_slot1 = selectedWords[1];
      profile.title_slot2 = selectedWords[2];
      profile.title_slot3 = selectedWords[3];
      // Update header title display
      const headerTitle = $('#profile-title');
      if (headerTitle) headerTitle.textContent = buildDisplayTitle(profile);
      saveBtn.textContent = 'Saved!';
      setTimeout(() => { saveBtn.textContent = 'Save Title'; saveBtn.disabled = false; }, 1500);
    };
  }
}

function updateTitlePreview(selectedWords) {
  const preview = $('#title-preview');
  if (!preview) return;
  const parts = [selectedWords[1], selectedWords[2], selectedWords[3]]
    .filter(Boolean)
    .map(id => TITLE_WORDS[id]?.word || id);
  preview.textContent = parts.length > 0 ? parts.join(' ') : 'Select words to build your title';
}

async function updateTitleUniqueness(selectedWords) {
  const el = $('#title-uniqueness');
  if (!el) return;
  const s1 = selectedWords[1], s2 = selectedWords[2], s3 = selectedWords[3];
  if (!s1 && !s2 && !s3) { el.textContent = ''; return; }

  let query = supabase.from('profiles').select('user_id', { count: 'exact', head: true });
  if (s1) query = query.eq('title_slot1', s1);
  if (s2) query = query.eq('title_slot2', s2);
  if (s3) query = query.eq('title_slot3', s3);
  const { count } = await query;

  if (count === 0) {
    el.textContent = 'You would be the only one with this title!';
  } else if (count === 1) {
    el.textContent = '1 other player uses this title';
  } else {
    el.textContent = `${count} other players use this title`;
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
export function attachProfileCardHandler(container, getPlayers, roomId = null) {
  container.addEventListener('click', async (e) => {
    // Don't trigger on honk/toggle button clicks
    if (e.target.closest('.honk-btn') || e.target.closest('.answer-toggle') || e.target.closest('.transfer-host-btn') || e.target.closest('.cohost-btn')) return;

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
