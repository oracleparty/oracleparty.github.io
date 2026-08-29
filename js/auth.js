// ============================================
// Oracle Party — Display Name / Auth
// ============================================

import { $, calculateTitle, escapeHtml } from './utils.js';
import { FRIEND_REQUEST_TOAST_MS, CHAT_HISTORY_GRACE_MS, AUTH_TIMEOUT_MS, AUTH_BOOT_TIMEOUT_MS } from './constants.js';
import { supabase, createProfile, fetchProfile, updateProfile, generateDiscriminator, fetchPlayerStats, fetchTitleUnlocks, upsertTitleUnlock, subscribeToFriendRequests, acceptFriendRequest, declineFriendRequest, unsubscribe } from './supabase.js';
import { initGlobalPresence } from './presence.js';
import { evaluateUnlocks, hasReachedApprentice, buildDisplayTitle, planCelebration } from './titles.js';
import { showCelebration } from './celebration.js';
import { logger } from './logger.js';

const STORAGE_KEY = 'oracle_party_display_name';
const PROFILE_CACHE_KEY = 'oracle_party_auth_profile';
const DEVICE_ID_KEY = 'oracle_party_device_id';

// ============================================
// DISPLAY NAME (unchanged public API)
// ============================================

// In-memory fallback when localStorage is blocked (Safari Private Browsing
// in some configurations, locked-down enterprise browsers, quota exceeded).
// Without this guard, setDisplayName throws on write and leaves the user
// stuck on the display-name modal forever.
let _displayNameMemoryFallback = null;

/** Get stored display name, or null if not set. */
export function getDisplayName() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v) return v;
  } catch (_) { /* fall through to memory */ }
  return _displayNameMemoryFallback;
}

/** Save display name (localStorage with in-memory fallback). */
export function setDisplayName(name) {
  const trimmed = name.trim();
  _displayNameMemoryFallback = trimmed;
  try { localStorage.setItem(STORAGE_KEY, trimmed); } catch (_) { /* keep in memory only */ }
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
      // 'System' is reserved as the sender name for in-game system chat
      // messages (host transfer, disqualify, etc.). Allowing a player to
      // claim it would let them spoof those messages.
      if (name.toLowerCase() === 'system') {
        if (error) error.textContent = 'That name is reserved — pick another';
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

// A REAL ACCOUNT ONLY. Never holds an invisible (anonymous) session — see
// getAuthUserId below for why those are kept strictly apart.
let _currentUser = null;   // Supabase auth.user object
let _currentProfile = null; // profiles table row
// An INVISIBLE ACCOUNT: a real auth user id issued to somebody who never signed
// up. Deliberately a separate variable rather than a flag on _currentUser.
let _anonUserId = null;

/**
 * Get current auth user + profile, or null if guest.
 *
 * "Guest" here still means SOMEBODY WITHOUT AN ACCOUNT, exactly as it always
 * has, and that is the whole point of keeping _anonUserId separate. Roughly
 * thirty call sites across the app read this as "is this a real member" to
 * decide whether to record stats, shape question selection, offer friends, show
 * a tier badge or list somebody as an account. Letting an invisible account
 * through here would switch every one of those on for guests silently, with
 * every test still passing — the exact shape of the damage migration 049 did.
 *
 * So this answers "do they have an ACCOUNT". getAuthUserId answers "does the
 * database know who is asking". They are different questions and were only ever
 * the same question because a guest had no answer to the second one.
 */
export function getCurrentUser() {
  if (!_currentUser) return null;
  return { user: _currentUser, profile: _currentProfile };
}

/**
 * The auth user id behind this browser, real account or invisible one.
 *
 * This exists so the DATABASE can tell one guest from another. Until now a
 * guest had no identity at all — every guest was the same anonymous key — which
 * is why `players` and `rooms` could never be locked down: "remove me" and
 * "remove them" are the same request from somebody who cannot prove who they
 * are. An invisible account costs the player nothing (no email, no password, no
 * sign-up screen) and, when they later make a real account, Supabase KEEPS THE
 * SAME ID, so everything built as a guest carries over untouched.
 *
 * → null when there is no session at all, which is also what happens if
 *   anonymous sign-ins are switched off in the Supabase dashboard or the call
 *   fails. Everything then behaves exactly as it did before this existed.
 */
export function getAuthUserId() {
  return _currentUser?.id || _anonUserId || null;
}

/** Is this browser holding an invisible account rather than a real one? */
export function isAnonymousSession() {
  return !_currentUser && !!_anonUserId;
}

/**
 * Get an invisible account for somebody who has not signed up.
 *
 * NEVER FATAL. If anonymous sign-ins are not enabled on the project, or the
 * request fails, or the network is down, this returns null and the app carries
 * on exactly as it did before — a guest with no identity. A hiccup at
 * Supabase's end must not stop somebody playing, which is the one thing that
 * would make this change worse than the problem it solves.
 */
async function ensureAnonymousSession() {
  try {
    const { data, error } = await withAuthTimeout(
      supabase.auth.signInAnonymously(), 'invisible account', AUTH_BOOT_TIMEOUT_MS);
    if (error) {
      // Not an error the player can act on, and not one worth a toast: they can
      // still play. Logged at debug so a future session reading a console does
      // not mistake a switched-off dashboard setting for a bug in this code.
      logger.debug('Auth', 'no invisible account (anonymous sign-ins may be off)', error);
      return null;
    }
    return data?.session || null;
  } catch (err) {
    logger.debug('Auth', 'invisible account request threw', err);
    return null;
  }
}

/**
 * Initialize auth state from Supabase session.
 * Call on every page load. Non-blocking for guests.
 */
export async function initAuth() {
  // Step 1: Get session.
  //
  // THIS MUST NEVER HANG, AND IT DID. Every page awaits initAuth() before it
  // renders — game.html does `await Promise.all([ensureDisplayName(), initAuth()])`
  // — so an auth call that never answers leaves a player on "Loading game..."
  // for ever. Reported from a real game: one player stuck on that screen while
  // the room started without them, and because init never finished, their
  // heartbeat never started either, so to everybody else they were simply AFK.
  //
  // A try/catch was not enough and never could be: a promise that never settles
  // does not throw. It times out now, and the timeout is SHORTER than the one on
  // a deliberate button press — somebody waiting to be let into a game should not
  // watch a spinner for twenty seconds, and carrying on as a guest is a
  // recoverable degradation where a frozen page is not.
  const { data: sessionData, error: sessionErr } = await withAuthTimeout(
    supabase.auth.getSession(), 'session lookup', AUTH_BOOT_TIMEOUT_MS);
  if (sessionErr) {
    // Deliberately does NOT fall through to an invisible sign-in: auth has just
    // failed to answer, so asking it a second question only doubles the wait.
    logger.warn('Auth', 'could not read the session — carrying on as a guest', sessionErr);
    return;
  }
  let session = sessionData?.session;

  // No session at all? Ask for an invisible one. This is what gives a guest an
  // identity the database can check, without anything changing on screen.
  if (!session?.user) {
    session = await ensureAnonymousSession();
  }
  if (!session?.user) return;

  // AN INVISIBLE ACCOUNT STOPS HERE, and that is deliberate. It sets no
  // _currentUser, loads no profile, computes no title, and caches nothing — so
  // getCurrentUser() still answers null and every "is this a real member" branch
  // in the app behaves exactly as it did before. Acquiring the identity and
  // changing what a guest can DO are two separate changes, and doing both at
  // once is how a lockdown silently breaks three features nobody was watching.
  if (session.user.is_anonymous) {
    _anonUserId = session.user.id;
    return;
  }
  _currentUser = session.user;

  // Step 2: Load cached profile immediately so getCurrentUser() works even if fetch fails
  const cached = localStorage.getItem(PROFILE_CACHE_KEY);
  if (cached) {
    try { _currentProfile = JSON.parse(cached); } catch { /* ignore */ }
  }

  // Step 3: Fetch fresh profile + stats (non-fatal — falls back to cache)
  let profile = null;
  let stats = [];
  try {
    const [profileResult, statsResult] = await Promise.all([
      fetchProfile(session.user.id),
      fetchPlayerStats(session.user.id)
    ]);
    profile = profileResult.data;
    stats = statsResult || [];
  } catch (err) {
    logger.warn('Auth', 'Failed to fetch profile/stats', err);
  }

  if (profile) {
    // Repair broken profiles: missing display_name or discriminator
    if (!profile.display_name || !profile.discriminator) {
      try {
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
            logger.warn('Auth', 'Profile repair failed', repairErr);
            if (!profile.display_name) profile.display_name = dn;
            if (!profile.discriminator) profile.discriminator = '0000';
          }
        } else {
          if (!profile.display_name) profile.display_name = getDisplayName() || 'Player';
          if (!profile.discriminator) profile.discriminator = '0000';
        }
      } catch (err) {
        logger.warn('Auth', 'Profile repair threw', err);
        if (!profile.display_name) profile.display_name = getDisplayName() || 'Player';
        if (!profile.discriminator) profile.discriminator = '0000';
      }
    }

    // Compute title (non-fatal)
    try {
      const titleInfo = calculateTitle(stats);
      const customTitle = buildDisplayTitle(profile);
      profile._cachedTitle = customTitle || titleInfo.title;
      profile._cachedTitleTier = titleInfo.tier;
      profile._cachedTitleCategory = titleInfo.category;
    } catch (err) {
      logger.warn('Auth', 'Title computation failed', err);
      profile._cachedTitle = 'Novice';
      profile._cachedTitleTier = 'Novice';
      profile._cachedTitleCategory = null;
    }
    profile._cachedStats = stats;
    _currentProfile = profile;
    localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
    if (profile.display_name) setDisplayName(profile.display_name);

    // Non-blocking background tasks — failures are fine
    fetchTitleUnlocks(session.user.id).then(async unlocks => {
      const ctx = { hour: new Date().getHours() };
      const newUnlocks = evaluateUnlocks(stats, profile, unlocks, ctx);
      for (const u of newUnlocks) {
        await upsertTitleUnlock(session.user.id, u.wordId, u.level);
      }
      // Anything earned since last time, shown on arrival. The other path fires
      // at the end of a game; this one catches what was unlocked while the
      // player was away — a loyalty streak crossing a day boundary earns
      // something with nobody playing.
      if (newUnlocks.length > 0) showCelebration(planCelebration(newUnlocks));
      if (!profile.title_builder_unlocked && hasReachedApprentice(stats)) {
        await supabase.from('profiles').update({ title_builder_unlocked: true }).eq('user_id', session.user.id);
      }
    }).catch(() => {});
    initGlobalPresence(session.user.id, profile.show_online_status !== false).catch(() => {});
    _initFriendRequestNotifications(session.user.id);
  } else if (!_currentProfile && !consumeAccountDeletedFlag()) {
    // Session exists but no profile — retry creation (handles partial signup).
    //
    // NOT after a deliberate deletion. signOut() clears the stored session, so
    // normally there is no session left to trigger this — but signOut swallows
    // its own errors, and if it fails (offline at exactly the wrong moment)
    // the session survives, this branch sees "signed in, no profile", and
    // faithfully recreates the profile the player just asked to erase.
    // Recreating deleted data is the one failure this path must not have.
    try {
      // A player who signed in with Google may never have typed a name here,
      // so fall back to the one Google supplies before giving up. Without this
      // a brand-new Google account gets no profile row at all, and every
      // account-only feature silently does nothing for them.
      const meta = session.user.user_metadata || {};
      const displayName = getDisplayName()
        || meta.display_name
        || meta.full_name
        || meta.name
        || (session.user.email ? session.user.email.split('@')[0] : null);
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
    } catch (err) {
      logger.warn('Auth', 'Profile creation retry failed', err);
    }
  }
}

/**
 * Sign in with Google.
 *
 * This leaves the page: Supabase redirects to Google, Google redirects back,
 * and supabase-js reads the session out of the returned URL on load — which is
 * why initAuth() picks it up with no extra work here. Nothing after the call
 * runs on success, so the only thing to handle is the failure to leave at all.
 *
 * redirectTo is the current page minus any hash, so a player signing in from
 * their profile comes back to their profile rather than the home screen. The
 * Supabase dashboard has to allow these URLs; a wildcard on the site covers
 * every page at once.
 */
/**
 * Never let an auth call hang or throw — turn both into an ordinary { error }.
 *
 * REPORTED FROM A REAL SIGN-IN: the button said "Signing in..." and stayed
 * there. Every caller of these functions checks `result.error` and restores the
 * button, so an error is handled everywhere — but a promise that NEVER SETTLES
 * reaches none of that code, and neither does one that rejects, because nothing
 * here was inside a try. The screen then says the one thing that is certainly
 * false: that it is still working on it.
 *
 * That is CLAUDE.md #4 in the loudest possible place. A player cannot retry, and
 * whoever is debugging it has no error to go on — which is exactly why the
 * cause could not be established from the outside. Converting both failures into
 * the shape every call site already handles fixes all of them at once, without
 * touching a single caller.
 *
 * The message says what to do rather than what broke, because a timeout does not
 * know which of a dozen things went wrong.
 */
function withAuthTimeout(promise, what, ms = AUTH_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      logger.error('Auth', `${what} never came back`, { afterMs: ms });
      done({ data: null, error: {
        message: "Couldn't reach the sign-in server — check your connection and try again",
        code: 'AUTH_TIMEOUT',
      } });
    }, ms);

    promise.then(done, (err) => {
      // A REJECTION IS NOT A RESULT. supabase-js normally returns errors rather
      // than throwing, so anything that lands here is unusual — a network layer
      // failure, or a bug — and is worth logging loudly even though the player
      // gets the same calm sentence.
      logger.error('Auth', `${what} threw instead of answering`, err);
      done({ data: null, error: {
        message: err?.message || 'Something went wrong signing in. Try again.',
        code: 'AUTH_THREW',
      } });
    });
  });
}

export async function signInWithGoogle() {
  const redirectTo = window.location.href.split('#')[0];
  const { error } = await withAuthTimeout(supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo },
  }), 'Google sign-in');
  if (error) {
    logger.error('Auth', 'signInWithGoogle failed', error);
    return { error, notConfigured: isProviderNotEnabled(error) };
  }
  return { error: null, notConfigured: false };
}

/**
 * Google is switched off in the Supabase dashboard, as opposed to anything
 * having gone wrong.
 *
 * Worth telling apart. Supabase answers HTTP 400 "Unsupported provider:
 * provider is not enabled" until the credentials from
 * docs/GOOGLE_SIGNIN_SETUP.md are pasted in, and the button reported that as
 * "Couldn't reach Google" — which sends whoever is debugging it to look at the
 * network, their connection and this code, none of which is the problem. The
 * one thing that needed doing was a dashboard setting.
 */
function isProviderNotEnabled(error) {
  const msg = (error?.message || '').toLowerCase();
  return msg.includes('provider is not enabled') || msg.includes('unsupported provider');
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

  const { data, error } = await withAuthTimeout(supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName, discriminator }
    }
  }), 'sign-up');
  if (error) {
    logger.error('Auth', 'signUp failed', error);
    return { user: null, profile: null, error };
  }

  // If email already exists (and confirmation is enabled), Supabase returns
  // a user with empty identities instead of an error
  if (!data.user || (data.user.identities && data.user.identities.length === 0)) {
    return { user: null, profile: null, error: { message: 'An account with this email already exists.' } };
  }

  let { data: profile, error: profileErr } = await createProfile(data.user.id, displayName, discriminator);
  if (profileErr?.code === '23505') {
    // Profile already exists for this user_id — fetch and repair it
    const { data: existingProfile } = await fetchProfile(data.user.id);
    if (existingProfile) {
      profile = existingProfile;
      profileErr = null;
      // Repair stale/missing fields from the previous incomplete signup
      const needsUpdate = {};
      if (!profile.display_name || profile.display_name !== displayName) needsUpdate.display_name = displayName;
      if (!profile.discriminator) needsUpdate.discriminator = discriminator;
      if (Object.keys(needsUpdate).length > 0) {
        const { data: updated } = await updateProfile(data.user.id, needsUpdate);
        if (updated) profile = updated;
      }
    } else {
      // Might be a discriminator collision — retry with a new one
      const retryDisc = await generateDiscriminator(displayName);
      if (retryDisc) {
        ({ data: profile, error: profileErr } = await createProfile(data.user.id, displayName, retryDisc));
      }
    }
  }
  if (profileErr) {
    logger.error('Auth', 'createProfile failed', profileErr);
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
  const { data, error } = await withAuthTimeout(
    supabase.auth.signInWithPassword({ email, password }), 'sign-in');
  if (error) {
    logger.error('Auth', 'signIn failed', error);
    return { user: null, profile: null, error };
  }
  if (!data?.user) {
    // Neither an error nor a user. Nothing downstream can proceed, and saying
    // so beats returning a success that leaves every caller reading null.
    logger.error('Auth', 'signIn returned no user and no error', data);
    return { user: null, profile: null, error: { message: 'Sign-in did not complete. Try again.' } };
  }

  _currentUser = data.user;

  // THE SIGN-IN ITSELF HAS ALREADY WORKED BY HERE. Everything below is
  // decoration — the profile, the cached copy, the display name — so a failure
  // in it must not turn a successful sign-in into a failed one, and must
  // certainly not throw out of a function whose caller has no try around it.
  let profile = null;
  try {
    ({ data: profile } = await fetchProfile(data.user.id));
    _currentProfile = profile;
    if (profile) {
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
      setDisplayName(profile.display_name);
    }
  } catch (err) {
    logger.error('Auth', 'signed in but could not load the profile', err);
  }

  return { user: data.user, profile, error: null };
}

/**
 * Sign out. Clears auth state but preserves display name (reverts to guest).
 */
/**
 * Set when a player deletes their account, read once on the next page load.
 *
 * Exists only to stop the partial-signup heal above from resurrecting a
 * deleted profile if sign-out fails. Consumed on read, so it cannot suppress
 * the heal for a genuine partial signup later on.
 */
const ACCOUNT_DELETED_KEY = 'oracle_party_account_deleted';

export function markAccountDeleted() {
  try { localStorage.setItem(ACCOUNT_DELETED_KEY, '1'); } catch (_) {}
}

function consumeAccountDeletedFlag() {
  try {
    if (localStorage.getItem(ACCOUNT_DELETED_KEY) !== '1') return false;
    localStorage.removeItem(ACCOUNT_DELETED_KEY);
    return true;
  } catch (_) { return false; }
}

export async function signOut() {
  try { await supabase.auth.signOut(); } catch (e) { logger.warn('Auth', 'signOut error', e); }
  _currentUser = null;
  _anonUserId = null;
  _currentProfile = null;
  localStorage.removeItem(PROFILE_CACHE_KEY);
  localStorage.removeItem(STORAGE_KEY);
  // Tear down the friend-request realtime subscription. Without this, the
  // channel persists across sign-out and a subsequent sign-in (different user)
  // would skip re-subscription due to the early-return guard at the top of
  // _initFriendRequestNotifications — so the new user never gets their own
  // friend request toasts; the old user's filter is still in effect.
  if (_friendReqChannel) {
    try { unsubscribe(_friendReqChannel); } catch (_) {}
    _friendReqChannel = null;
  }
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
    if (nameDisplay) {
      nameDisplay.textContent = '';
      nameDisplay.append('Playing as: ');
      const strong = document.createElement('strong');
      strong.textContent = getDisplayName() || 'Guest';
      nameDisplay.appendChild(strong);
    }
    emailInput.focus();

    dismissBtn.onclick = () => {
      overlay.classList.remove('active');
      resolve(null);
    };

    const googleBtn = $('#signup-google');
    if (googleBtn) {
      googleBtn.onclick = async () => {
        errorEl.textContent = '';
        googleBtn.disabled = true;
        const { error, notConfigured } = await signInWithGoogle();
        // On success the browser has already left for Google, so anything
        // running here means it did not.
        if (error) {
          errorEl.textContent = notConfigured
            ? 'Google sign-in isn\u2019t switched on yet — use email for now'
            : "Couldn't reach Google — try email instead";
          googleBtn.disabled = false;
        }
      };
    }

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

      let displayName = getDisplayName();
      if (!displayName || !displayName.trim()) {
        // No display name set — prompt for one before continuing
        overlay.classList.remove('active');
        displayName = await showDisplayNameModal();
        overlay.classList.add('active');
        if (!displayName || !displayName.trim()) return;
        // Update the name display in the modal
        const nameDisplay = $('#signup-name-display');
        if (nameDisplay) {
          nameDisplay.textContent = '';
          nameDisplay.append('Playing as: ');
          const s = document.createElement('strong');
          s.textContent = displayName;
          nameDisplay.appendChild(s);
        }
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

      // Success — close modal immediately and proceed
      overlay.classList.remove('active');
      resolve({ user: result.user, profile: result.profile });
    };
  });
}

function _injectSignUpModal() {
  const html = `
    <div id="signup-modal" class="modal-overlay">
      <div class="modal">
        <h2 class="modal__title">Create Account</h2>
        <p id="signup-name-display" style="color: var(--color-text-dim); font-size: var(--text-sm); margin-bottom: var(--space-lg);">
          Playing as: <strong>${escapeHtml(getDisplayName() || 'Guest')}</strong>
        </p>
        <button class="btn btn-google btn-block" id="signup-google">
          <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 6.9l7.1 5.5c4.2-3.9 6.6-9.6 6.6-16.4z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-2.9-.8-4.4s.3-3 .8-4.4l-7.8-6.1C1 16.9 0 20.3 0 24s1 7.1 2.6 10.2l7.8-5.5z"/><path fill="#34A853" d="M24 48c6.2 0 11.5-2 15.3-5.5l-7.1-5.5c-2 1.4-4.6 2.2-8.2 2.2-6.3 0-11.7-3.7-13.6-9.3l-7.8 5.5C6.5 42.6 14.6 48 24 48z"/></svg>
          Continue with Google
        </button>
        <div class="auth-divider"><span>or</span></div>
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

    const googleBtn = $('#signin-google');
    if (googleBtn) {
      googleBtn.onclick = async () => {
        errorEl.textContent = '';
        googleBtn.disabled = true;
        const { error } = await signInWithGoogle();
        if (error) {
          errorEl.textContent = "Couldn't reach Google — try email instead";
          googleBtn.disabled = false;
        }
      };
    }

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

      // BELT AND BRACES ON TOP OF withAuthTimeout. That helper stops the auth
      // call itself hanging or throwing; this stops anything ELSE in here from
      // leaving the button stuck on "Signing in..." with no way to retry. The
      // rule is that this button must always end up either gone or pressable.
      let result;
      try {
        result = await signIn(email, password);
      } catch (err) {
        logger.error('Auth', 'sign-in handler threw', err);
        result = { error: { message: 'Something went wrong signing in. Try again.' } };
      }

      if (!result || result.error) {
        errorEl.textContent = result?.error?.message || 'Sign-in failed. Try again.';
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
        <button class="btn btn-google btn-block" id="signin-google">
          <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.5 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9.1h12.4c-.5 2.9-2.1 5.3-4.6 6.9l7.1 5.5c4.2-3.9 6.6-9.6 6.6-16.4z"/><path fill="#FBBC05" d="M10.4 28.7c-.5-1.4-.8-2.9-.8-4.4s.3-3 .8-4.4l-7.8-6.1C1 16.9 0 20.3 0 24s1 7.1 2.6 10.2l7.8-5.5z"/><path fill="#34A853" d="M24 48c6.2 0 11.5-2 15.3-5.5l-7.1-5.5c-2 1.4-4.6 2.2-8.2 2.2-6.3 0-11.7-3.7-13.6-9.3l-7.8 5.5C6.5 42.6 14.6 48 24 48z"/></svg>
          Continue with Google
        </button>
        <div class="auth-divider"><span>or</span></div>
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
    <span style="flex:1; font-size: var(--text-sm); font-weight: 500;">${escapeHtml(senderName)} sent a friend request</span>
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

  setTimeout(() => { if (toast.parentNode) toast.remove(); }, FRIEND_REQUEST_TOAST_MS);
}

/**
 * A stable, random, anonymous id for this browser.
 *
 * Question feedback used to be keyed on (room, display name), which meant a
 * player could re-rate the same question in every new game — each one counted
 * — and two guests both called "New Player" silently overwrote each other.
 *
 * This gives guests a durable identity so a vote sticks across games and shows
 * as already-cast on return, without requiring an account. It identifies a
 * browser, not a person, and is used only to deduplicate feedback.
 */
export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (crypto.randomUUID && crypto.randomUUID()) ||
           `dev-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch (_) {
    // Private browsing with storage blocked: fall back to a per-session id so
    // voting still works, it just will not persist past this tab.
    if (!window.__deviceIdFallback) {
      window.__deviceIdFallback = `tmp-${Math.random().toString(36).slice(2, 10)}`;
    }
    return window.__deviceIdFallback;
  }
}

/**
 * Who is casting a vote: the account if signed in, otherwise this device.
 * Account wins so feedback follows the person across their devices.
 */
export function getVoterId() {
  const user = getCurrentUser();
  return user?.user?.id ? `user:${user.user.id}` : `device:${getDeviceId()}`;
}

/**
 * Remember which seat this browser held in a given room.
 *
 * Rejoin used to recover a player's answers from sessionStorage, which dies
 * with the tab. So history survived a refresh but not an actual return: close
 * the browser, come back, and every answer you had already given was orphaned
 * on a player row that no longer exists.
 *
 * localStorage survives the browser closing, so the returning player can
 * reclaim what they scored.
 */
export function rememberSeat(roomId, playerId) {
  if (!roomId || !playerId) return;
  try { localStorage.setItem(`oracle_party_seat_${roomId}`, String(playerId)); } catch (_) {}
}

export function recallSeat(roomId) {
  if (!roomId) return null;
  try { return localStorage.getItem(`oracle_party_seat_${roomId}`); } catch (_) { return null; }
}

export function forgetSeat(roomId) {
  if (!roomId) return;
  try { localStorage.removeItem(`oracle_party_seat_${roomId}`); } catch (_) {}
}

/**
 * The moment this person first entered a given room. Chat before it is not
 * theirs to read.
 *
 * WHAT THIS IS AND IS NOT. Room codes are six digits and public games are
 * listed, so anybody can walk into a room — and until now they arrived to the
 * entire transcript of everything said before they got there. That is the
 * realistic way a private conversation leaked, and this closes it.
 *
 * It is NOT a permission. Chat rows are still readable by anyone holding the
 * publishable key, which every browser must carry because guests play without
 * signing in (CLAUDE.md #2). Somebody crafting requests by hand still sees
 * everything. Closing THAT needs either mandatory sign-in, which ends guest
 * play, or a server between players and the database. privacy.html continues
 * to say plainly that chat is not private, because it still is not.
 *
 * SET ONCE, NEVER MOVED FORWARD. The obvious reading of "fresh on entry" is
 * per page load, and that would be worse than the problem: refresh your phone
 * mid-lobby, or come back from a game, and the whole conversation you were
 * part of would vanish. The cut-off is when you FIRST arrived, so returning
 * shows you everything that happened in a room you were already in.
 *
 * localStorage, like rememberSeat, so it survives the browser closing.
 */
export function rememberChatCutoff(roomId, iso) {
  if (!roomId) return null;
  const key = `oracle_party_chat_from_${roomId}`;
  // Biased early by CHAT_HISTORY_GRACE_MS — see the constant for why. Losing a
  // message meant for you is a bug; seeing two minutes of what came before is
  // not, because this was never a lock.
  const base = iso ? new Date(iso).getTime() : Date.now();
  const stamp = new Date((Number.isFinite(base) ? base : Date.now()) - CHAT_HISTORY_GRACE_MS).toISOString();
  try {
    const existing = localStorage.getItem(key);
    if (existing) return existing;
    localStorage.setItem(key, stamp);
    return stamp;
  } catch (_) {
    return stamp;
  }
}

export function recallChatCutoff(roomId) {
  if (!roomId) return null;
  try { return localStorage.getItem(`oracle_party_chat_from_${roomId}`); } catch (_) { return null; }
}

export function forgetChatCutoff(roomId) {
  if (!roomId) return;
  try { localStorage.removeItem(`oracle_party_chat_from_${roomId}`); } catch (_) {}
}
