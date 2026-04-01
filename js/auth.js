// ============================================
// Oracle Party — Display Name / Auth
// ============================================

import { $, calculateTitle } from './utils.js';
import { supabase, createProfile, fetchProfile, updateProfile, generateDiscriminator, fetchPlayerStats, fetchTitleUnlocks, upsertTitleUnlock, subscribeToFriendRequests, acceptFriendRequest, declineFriendRequest } from './supabase.js';
import { initGlobalPresence } from './presence.js';
import { evaluateUnlocks, hasReachedApprentice, buildDisplayTitle } from './titles.js';

const STORAGE_KEY = 'oracle_party_display_name';
const PROFILE_CACHE_KEY = 'oracle_party_auth_profile';

// ============================================
// DISPLAY NAME (unchanged public API)
// ============================================

/** Get stored display name, or null if not set. */
export function getDisplayName() {
  return localStorage.getItem(STORAGE_KEY);
}

/** Save display name to localStorage. */
export function setDisplayName(name) {
  localStorage.setItem(STORAGE_KEY, name.trim());
}

/**
 * Show the display-name modal overlay.
 * Returns a Promise that resolves with the entered name.
 */
export function showDisplayNameModal() {
  return new Promise((resolve) => {
    const overlay = $('#display-name-modal');
    const input = $('#display-name-input');
    const btn = $('#display-name-submit');
    const error = $('#display-name-error');

    // Reset state
    input.value = '';
    if (error) error.textContent = '';
    overlay.classList.add('active');
    input.focus();

    function submit() {
      const name = input.value.trim();
      if (name.length < 1 || name.length > 20) {
        if (error) error.textContent = 'Enter a name (1–20 characters)';
        input.focus();
        return;
      }
      setDisplayName(name);
      overlay.classList.remove('active');
      resolve(name);
    }

    // Click submit
    btn.onclick = submit;

    // Enter key submits
    input.onkeydown = (e) => {
      if (e.key === 'Enter') submit();
    };
  });
}

/**
 * Ensure the user has a display name.
 * If one is stored, returns it immediately.
 * Otherwise shows the modal and waits for input.
 */
export async function ensureDisplayName() {
  const existing = getDisplayName();
  if (existing) return existing;
  return showDisplayNameModal();
}

// ============================================
// AUTH STATE
// ============================================

let _currentUser = null;   // Supabase auth.user object
let _currentProfile = null; // profiles table row

/**
 * Get current auth user + profile, or null if guest.
 */
export function getCurrentUser() {
  if (!_currentUser) return null;
  return { user: _currentUser, profile: _currentProfile };
}

/**
 * Initialize auth state from Supabase session.
 * Call on every page load. Non-blocking for guests.
 */
export async function initAuth() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      _currentUser = session.user;
      // Try cached profile first
      const cached = localStorage.getItem(PROFILE_CACHE_KEY);
      if (cached) {
        try { _currentProfile = JSON.parse(cached); } catch { /* ignore */ }
      }
      // Fetch fresh profile + stats in parallel
      const [{ data: profile }, stats] = await Promise.all([
        fetchProfile(session.user.id),
        fetchPlayerStats(session.user.id)
      ]);
      if (profile) {
        // Repair broken profiles: missing display_name or discriminator
        if (!profile.display_name || !profile.discriminator) {
          const dn = profile.display_name || getDisplayName() || session.user.user_metadata?.display_name || 'Player';
          const disc = profile.discriminator || await generateDiscriminator(dn);
          if (disc) {
            const updates = {};
            if (!profile.display_name) updates.display_name = dn;
            if (!profile.discriminator) updates.discriminator = disc;
            const { data: repaired, error: repairErr } = await updateProfile(session.user.id, updates);
            if (repaired) {
              profile.display_name = repaired.display_name;
              profile.discriminator = repaired.discriminator;
            } else {
              console.warn('[Auth] Profile repair failed:', repairErr?.message);
              // Apply local fallbacks so the UI doesn't show null
              if (!profile.display_name) profile.display_name = dn;
              if (!profile.discriminator) profile.discriminator = '0000';
            }
          } else {
            console.warn('[Auth] Could not generate discriminator for profile repair');
            if (!profile.display_name) profile.display_name = dn;
            if (!profile.discriminator) profile.discriminator = '0000';
          }
        }
        // Compute title — prefer custom wheel title, fall back to auto-computed
        const titleInfo = calculateTitle(stats);
        const customTitle = buildDisplayTitle(profile);
        profile._cachedTitle = customTitle || titleInfo.title;
        profile._cachedTitleTier = titleInfo.tier;
        profile._cachedTitleCategory = titleInfo.category;
        profile._cachedStats = stats;
        _currentProfile = profile;
        localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
        setDisplayName(profile.display_name);
        // Title system: evaluate unlocks on login (catches time-based, social triggers)
        fetchTitleUnlocks(session.user.id).then(async unlocks => {
          const ctx = { hour: new Date().getHours() };
          const newUnlocks = evaluateUnlocks(stats, profile, unlocks, ctx);
          for (const u of newUnlocks) {
            await upsertTitleUnlock(session.user.id, u.wordId, u.level);
          }
          if (!profile.title_builder_unlocked && hasReachedApprentice(stats)) {
            await supabase.from('profiles').update({ title_builder_unlocked: true }).eq('user_id', session.user.id);
          }
        }).catch(() => {});
        // Init global presence (non-blocking, only if user has friends)
        initGlobalPresence(session.user.id, profile.show_online_status !== false).catch(() => {});
        // Subscribe to incoming friend requests for popup notifications
        _initFriendRequestNotifications(session.user.id);
      } else if (!_currentProfile) {
        // Session exists but no profile — retry creation (handles partial signup)
        const displayName = getDisplayName() || session.user.user_metadata?.display_name;
        if (displayName) {
          const disc = await generateDiscriminator(displayName);
          if (disc) {
            const { data: newProfile } = await createProfile(session.user.id, displayName, disc);
            if (newProfile) {
              _currentProfile = newProfile;
              localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(newProfile));
            }
          }
        }
      }
    }
  } catch (err) {
    console.warn('[Auth] initAuth failed:', err);
  }
}

/**
 * Sign up with email + password.
 * Returns { user, profile, error }.
 */
export async function signUp(email, password, displayName) {
  // Validate display name
  if (!displayName || !displayName.trim()) {
    return { user: null, profile: null, error: { message: 'Display name is required.' } };
  }
  displayName = displayName.trim();

  const discriminator = await generateDiscriminator(displayName);
  if (!discriminator) {
    return { user: null, profile: null, error: { message: 'This name is too popular. Try a different name.' } };
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName, discriminator }
    }
  });
  if (error) {
    console.error('[Auth] signUp failed:', error.message);
    return { user: null, profile: null, error };
  }

  let { data: profile, error: profileErr } = await createProfile(data.user.id, displayName, discriminator);
  // Retry once on unique constraint violation (private profile had same discriminator)
  if (profileErr?.code === '23505') {
    const retryDisc = await generateDiscriminator(displayName);
    if (retryDisc) {
      ({ data: profile, error: profileErr } = await createProfile(data.user.id, displayName, retryDisc));
    }
  }
  if (profileErr) {
    console.error('[Auth] createProfile failed:', profileErr.message);
    return { user: data.user, profile: null, error: profileErr };
  }

  _currentUser = data.user;
  _currentProfile = profile;
  localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
  setDisplayName(displayName);

  return { user: data.user, profile, error: null };
}

/**
 * Sign in with email + password.
 * Returns { user, profile, error }.
 */
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    console.error('[Auth] signIn failed:', error.message);
    return { user: null, profile: null, error };
  }

  _currentUser = data.user;
  const { data: profile } = await fetchProfile(data.user.id);
  _currentProfile = profile;
  if (profile) {
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
    setDisplayName(profile.display_name);
  }

  return { user: data.user, profile, error: null };
}

/**
 * Sign out. Clears auth state but preserves display name (reverts to guest).
 */
export async function signOut() {
  await supabase.auth.signOut();
  _currentUser = null;
  _currentProfile = null;
  localStorage.removeItem(PROFILE_CACHE_KEY);
}

/**
 * Listen for auth state changes.
 */
export function onAuthChange(callback) {
  return supabase.auth.onAuthStateChange(callback);
}

// ============================================
// SIGN-UP MODAL (programmatically injected)
// ============================================

let _signUpModalInjected = false;

/**
 * Show the sign-up modal. Creates the DOM on first call.
 * Returns a Promise that resolves with { user, profile } on success,
 * or null if dismissed.
 */
export function showSignUpModal() {
  return new Promise((resolve) => {
    if (!_signUpModalInjected) {
      _injectSignUpModal();
      _signUpModalInjected = true;
    }

    const overlay = $('#signup-modal');
    const emailInput = $('#signup-email');
    const passwordInput = $('#signup-password');
    const confirmInput = $('#signup-confirm');
    const submitBtn = $('#signup-submit');
    const errorEl = $('#signup-error');
    const successEl = $('#signup-success');
    const dismissBtn = $('#signup-dismiss');

    // Reset state
    emailInput.value = '';
    passwordInput.value = '';
    confirmInput.value = '';
    errorEl.textContent = '';
    successEl.textContent = '';
    successEl.style.display = 'none';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Create Account';
    overlay.classList.add('active');
    // Refresh the displayed name (may have changed since modal was first injected)
    const nameDisplay = $('#signup-name-display');
    if (nameDisplay) nameDisplay.innerHTML = `Playing as: <strong>${getDisplayName() || 'Guest'}</strong>`;
    emailInput.focus();

    dismissBtn.onclick = () => {
      overlay.classList.remove('active');
      resolve(null);
    };

    submitBtn.onclick = async () => {
      errorEl.textContent = '';
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      const confirm = confirmInput.value;

      if (!email || !email.includes('@')) {
        errorEl.textContent = 'Enter a valid email';
        return;
      }
      if (password.length < 6) {
        errorEl.textContent = 'Password must be at least 6 characters';
        return;
      }
      if (password !== confirm) {
        errorEl.textContent = 'Passwords do not match';
        return;
      }

      const displayName = getDisplayName();
      if (!displayName || !displayName.trim()) {
        errorEl.textContent = 'Set a display name before creating an account';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Creating...';

      const result = await signUp(email, password, displayName);

      if (result.error) {
        errorEl.textContent = result.error.message;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Account';
        return;
      }

      successEl.textContent = `Account created! You are now ${result.profile?.display_name || displayName}#${result.profile?.discriminator || '????'}`;
      successEl.style.display = 'block';
      submitBtn.textContent = 'Done';
      submitBtn.disabled = false;
      submitBtn.onclick = () => {
        overlay.classList.remove('active');
        resolve({ user: result.user, profile: result.profile });
      };
    };
  });
}

function _injectSignUpModal() {
  const html = `
    <div id="signup-modal" class="modal-overlay">
      <div class="modal">
        <h2 class="modal__title">Create Account</h2>
        <p id="signup-name-display" style="color: var(--color-text-dim); font-size: var(--text-sm); margin-bottom: var(--space-lg);">
          Playing as: <strong>${getDisplayName() || 'Guest'}</strong>
        </p>
        <input type="email" id="signup-email" class="input" placeholder="Email" autocomplete="email" style="margin-bottom: var(--space-md);">
        <input type="password" id="signup-password" class="input" placeholder="Password" autocomplete="new-password" style="margin-bottom: var(--space-md);">
        <input type="password" id="signup-confirm" class="input" placeholder="Confirm password" autocomplete="new-password">
        <p id="signup-error" style="color: var(--color-danger); font-size: var(--text-sm); margin-top: var(--space-sm); min-height: 1.2em;"></p>
        <p id="signup-success" style="color: var(--color-success); font-size: var(--text-sm); margin-top: var(--space-sm); display: none;"></p>
        <button class="btn btn-primary btn-block" id="signup-submit" style="margin-top: var(--space-lg);">Create Account</button>
        <button class="btn btn-secondary btn-block" id="signup-dismiss" style="margin-top: var(--space-sm);">Not Now</button>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ============================================
// SIGN-IN MODAL (programmatically injected)
// ============================================

let _signInModalInjected = false;

/**
 * Show the sign-in modal.
 * Returns a Promise that resolves with { user, profile } on success,
 * or null if dismissed.
 */
export function showSignInModal() {
  return new Promise((resolve) => {
    if (!_signInModalInjected) {
      _injectSignInModal();
      _signInModalInjected = true;
    }

    const overlay = $('#signin-modal');
    const emailInput = $('#signin-email');
    const passwordInput = $('#signin-password');
    const submitBtn = $('#signin-submit');
    const errorEl = $('#signin-error');
    const dismissBtn = $('#signin-dismiss');
    const createLink = $('#signin-create-link');

    // Reset state
    emailInput.value = '';
    passwordInput.value = '';
    errorEl.textContent = '';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign In';
    overlay.classList.add('active');
    emailInput.focus();

    dismissBtn.onclick = () => {
      overlay.classList.remove('active');
      resolve(null);
    };

    createLink.onclick = async (e) => {
      e.preventDefault();
      overlay.classList.remove('active');
      const result = await showSignUpModal();
      resolve(result);
    };

    submitBtn.onclick = async () => {
      errorEl.textContent = '';
      const email = emailInput.value.trim();
      const password = passwordInput.value;

      if (!email || !email.includes('@')) {
        errorEl.textContent = 'Enter a valid email';
        return;
      }
      if (!password) {
        errorEl.textContent = 'Enter your password';
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = 'Signing in...';

      const result = await signIn(email, password);

      if (result.error) {
        errorEl.textContent = result.error.message;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Sign In';
        return;
      }

      overlay.classList.remove('active');
      resolve({ user: result.user, profile: result.profile });
    };

    // Enter key submits
    passwordInput.onkeydown = (e) => {
      if (e.key === 'Enter') submitBtn.onclick();
    };
    emailInput.onkeydown = (e) => {
      if (e.key === 'Enter') passwordInput.focus();
    };
  });
}

function _injectSignInModal() {
  const html = `
    <div id="signin-modal" class="modal-overlay">
      <div class="modal">
        <h2 class="modal__title">Sign In</h2>
        <input type="email" id="signin-email" class="input" placeholder="Email" autocomplete="email" style="margin-bottom: var(--space-md);">
        <input type="password" id="signin-password" class="input" placeholder="Password" autocomplete="current-password">
        <p id="signin-error" style="color: var(--color-danger); font-size: var(--text-sm); margin-top: var(--space-sm); min-height: 1.2em;"></p>
        <button class="btn btn-primary btn-block" id="signin-submit" style="margin-top: var(--space-lg);">Sign In</button>
        <button class="btn btn-secondary btn-block" id="signin-dismiss" style="margin-top: var(--space-sm);">Cancel</button>
        <p style="text-align: center; margin-top: var(--space-md); font-size: var(--text-sm); color: var(--color-text-dim);">
          Don't have an account? <a href="#" id="signin-create-link" style="color: var(--color-primary); text-decoration: underline;">Create one</a>
        </p>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ============================================
// FRIEND REQUEST NOTIFICATIONS
// ============================================

let _friendReqChannel = null;

function _initFriendRequestNotifications(userId) {
  if (_friendReqChannel) return;
  _friendReqChannel = subscribeToFriendRequests(userId, async (payload) => {
    if (payload.eventType !== 'INSERT' || payload.new?.status !== 'pending') return;
    const { data: sender } = await fetchProfile(payload.new.sender_id);
    const senderName = sender?.display_name || 'Someone';
    _showFriendRequestToast(senderName, payload.new.id);
  });
}

function _showFriendRequestToast(senderName, requestId) {
  const existing = document.getElementById('friend-request-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'friend-request-toast';
  toast.style.cssText = `
    position: fixed; top: var(--space-lg); left: var(--space-lg); right: var(--space-lg);
    background: var(--color-surface); border: 1px solid var(--color-surface-light);
    border-radius: var(--radius-md); padding: var(--space-md);
    z-index: 9999; box-shadow: 0 4px 16px rgba(0,0,0,0.15);
    display: flex; align-items: center; gap: var(--space-sm); flex-wrap: wrap;
  `;
  toast.innerHTML = `
    <span style="flex:1; font-size: var(--text-sm); font-weight: 500;">${senderName} sent a friend request</span>
    <button data-fr-accept="${requestId}" class="btn btn-primary" style="padding: var(--space-xs) var(--space-md); font-size: var(--text-xs);">Accept</button>
    <button data-fr-decline="${requestId}" class="btn btn-secondary" style="padding: var(--space-xs) var(--space-md); font-size: var(--text-xs);">Decline</button>
  `;
  document.body.appendChild(toast);

  toast.onclick = async (e) => {
    const accept = e.target.closest('[data-fr-accept]');
    const decline = e.target.closest('[data-fr-decline]');
    if (accept) {
      accept.disabled = true;
      await acceptFriendRequest(parseInt(accept.dataset.frAccept));
      toast.remove();
    } else if (decline) {
      decline.disabled = true;
      await declineFriendRequest(parseInt(decline.dataset.frDecline));
      toast.remove();
    }
  };

  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 10000);
}
