// ============================================
// Oracle Party — Host Settings Module
// In-game host settings panel, gear icon, return to lobby.
// ============================================

import { state, getCategoryLabel, _isLeaving, setIsLeaving, _hostSettingsConfirmTimer, setHostSettingsConfirmTimer } from './state.js';
import { $, navigateWithFadeReplace } from '../utils.js';
import { logger } from '../logger.js';
import { RETURN_HOME_DELAY_MS } from '../constants.js';
import { updateGameState, updateRoomStatus, deleteAnswersByRoom, setPhaseOnServer, chaosAvailable } from '../supabase.js';
import { setHonkChaos } from '../honk.js';

// Cleanup callback — registered by init.js to avoid circular imports
let _cleanup = null;
export function registerCleanup(fn) { _cleanup = fn; }

// ============================================
// HOST SETTINGS PANEL
// ============================================

export function initHostSettingsPanel() {
  const sheet = $('#host-settings-sheet');
  const backdrop = $('#host-settings-backdrop');
  const returnBtn = $('#btn-return-to-lobby');

  if (!sheet) return;

  // Attach click handler to all gear buttons (one per screen header)
  document.querySelectorAll('.host-settings-gear').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); openHostSettingsSheet(); };
  });
  backdrop.onclick = () => closeHostSettingsSheet();

  // Toggle handlers for in-game settings
  sheet.querySelectorAll('.toggle-group[data-game-setting]').forEach(group => {
    group.querySelectorAll('.toggle-option').forEach(opt => {
      opt.onclick = () => {
        const key = group.dataset.gameSetting;
        const value = opt.dataset.value;
        // Update active state visually
        group.querySelectorAll('.toggle-option').forEach(o => o.classList.toggle('active', o === opt));
        handleGameSettingChange(key, value);
      };
    });
  });

  // Return to Lobby — double-tap confirmation
  returnBtn.onclick = () => handleReturnToLobby();

  // Chaos mode needs migration 075; until then the switch is not offered.
  chaosAvailable().then(ok => {
    if (ok) sheet.querySelectorAll('[data-chaos-setting]').forEach(el => el.classList.remove('hidden'));
  });
}

// ============================================
// CHAOS MODE — visible to everybody
// ============================================

/**
 * Apply the room's Chaos setting on this phone: lift the no-honks-while-
 * answering rule. Every phone calls this, not only the host.
 *
 * NOTHING ON THE GEAR (owner, 2026-10-28). A dot for Chaos was tried and the
 * owner turned it down: "This is unsustainable if i add other game options
 * later" — one marker per mode does not scale, and a dot that means "some
 * rule is on" says nothing. The room's rules are in the settings sheet every
 * player can open, and on the lobby's room card.
 */
export function syncChaosDisplay() {
  const on = !!state.room?.settings?.chaos;
  setHonkChaos(on);
  // A pill from an older build of this page, if one was drawn, goes.
  document.querySelectorAll('.game-progress .chaos-pill').forEach(p => p.remove());
  document.querySelectorAll('.host-settings-gear').forEach(gear => {
    gear.classList.remove('has-mode');
    gear.setAttribute('aria-label', 'Room settings');
  });
}

/** Is this phone allowed to change the room's settings? The host only. */
function canEditRoomSettings() {
  return !!state.room?.isHost;
}

/**
 * Fill the sheet's read-only half: the settings fixed for the game (category,
 * question count — fixed for the host too once the game has started), and
 * each changeable setting written as words for anybody who cannot change it.
 */
function fillRoomSettingsSheet(sheet) {
  const readonly = !canEditRoomSettings();
  sheet.classList.toggle('is-readonly', readonly);

  const by = sheet.querySelector('#room-settings-by');
  if (by) {
    const host = (state.players || []).find(p => p.is_host);
    by.textContent = host ? `Set by the host · ${host.display_name}` : 'Set by the host';
    by.classList.toggle('hidden', !readonly);
  }
  const cat = sheet.querySelector('#room-settings-category');
  if (cat) cat.textContent = getCategoryLabel();
  const qs = sheet.querySelector('#room-settings-questions');
  if (qs) qs.textContent = String(state.totalQuestions || '');
  // LOCKED ONCE THE GAME STARTS, for the host too (owner, 2026-10-28): the
  // timer and Chaos change the rules of a round, so they are set in the lobby
  // and shown here as facts. Auto-Proceed is pacing, not a rule, and stays.
  const timer = sheet.querySelector('#room-settings-timer');
  if (timer) timer.textContent = `${state.timerSeconds || 30}s`;
  const chaos = sheet.querySelector('#room-settings-chaos');
  if (chaos) chaos.textContent = state.room?.settings?.chaos ? 'On 🔥' : 'Off';

  const words = {
    autoProceed: ({ 0: 'Off', 8: 'Slow', 4: 'Fast' })[state.autoProceedSeconds || 0] || 'Off',
  };
  sheet.querySelectorAll('.room-settings__value[data-value-for]').forEach(el => {
    el.textContent = words[el.dataset.valueFor] ?? '';
  });
}

function openHostSettingsSheet() {
  const sheet = $('#host-settings-sheet');
  if (!sheet) return;

  // Sync toggle states from current settings, and the read-only view
  syncHostSettingsToggles();
  fillRoomSettingsSheet(sheet);

  sheet.classList.add('active');
}

function closeHostSettingsSheet() {
  const sheet = $('#host-settings-sheet');
  if (sheet) sheet.classList.remove('active');

  // Reset return-to-lobby confirmation
  resetReturnConfirm();
}

function syncHostSettingsToggles() {
  const sheet = $('#host-settings-sheet');
  if (!sheet) return;

  sheet.querySelectorAll('.toggle-group[data-game-setting]').forEach(group => {
    const key = group.dataset.gameSetting;
    let currentValue;
    if (key === 'autoProceed') {
      currentValue = String(state.autoProceedSeconds || 0);
    }
    group.querySelectorAll('.toggle-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.value === currentValue);
    });
  });
}

async function handleGameSettingChange(key, value) {
  // The toggles are hidden for anybody else; this is the guard behind that.
  if (!canEditRoomSettings()) return;
  const numVal = Number(value);
  // Auto-Proceed is the only setting that changes mid-game; the timer and
  // Chaos are locked once the game has started (see fillRoomSettingsSheet).
  const columnMap = { autoProceed: 'auto_proceed' };
  if (!columnMap[key]) return;

  // Update local state
  if (key === 'autoProceed') {
    state.autoProceedSeconds = numVal;
  }

  // Update room settings
  if (state.room?.settings) {
    state.room.settings[key] = numVal;
  }

  // Persist to sessionStorage
  sessionStorage.setItem('oracle_party_room', JSON.stringify(state.room));

  // Push to Supabase (triggers Realtime for other players)
  const column = columnMap[key];
  if (column) {
    await updateGameState(state.room.id, { [column]: numVal });
  }
}

function handleReturnToLobby() {
  if (!canEditRoomSettings()) return;   // the button is hidden for everyone else
  const btn = $('#btn-return-to-lobby');
  if (!btn) return;

  if (_hostSettingsConfirmTimer) {
    // Second tap — confirmed
    clearTimeout(_hostSettingsConfirmTimer);
    setHostSettingsConfirmTimer(null);
    executeReturnToLobby();
  } else {
    // First tap — show confirmation
    btn.textContent = 'Tap again to confirm';
    btn.classList.add('btn-return-lobby--confirm');
    setHostSettingsConfirmTimer(setTimeout(() => {
      resetReturnConfirm();
    }, RETURN_HOME_DELAY_MS));
  }
}

export function resetReturnConfirm() {
  const btn = $('#btn-return-to-lobby');
  if (btn) {
    btn.textContent = 'Return to Lobby';
    btn.classList.remove('btn-return-lobby--confirm');
  }
  if (_hostSettingsConfirmTimer) {
    clearTimeout(_hostSettingsConfirmTimer);
    setHostSettingsConfirmTimer(null);
  }
}

async function executeReturnToLobby() {
  closeHostSettingsSheet();
  hideHostSettingsGear();

  setIsLeaving(true);
  try { if (_cleanup) _cleanup(); } catch (_) {}

  try {
    await deleteAnswersByRoom(state.room.id, state.room.playerId);
    // The room is cleared out first and the PHASE said last: the phase is what
    // sends every phone back to the lobby, so it must not arrive before the
    // clear-out it announces.
    // current_question is carried by the op_set_phase call below, and since
    // migration 061 it is not a column a client may write.
    await updateGameState(state.room.id, {
      question_ids: [],
      question_started_at: null,
      countdown_started_at: null
    });
    await updateRoomStatus(state.room.id, 'lobby');
    if (!await setPhaseOnServer(state.room.id, state.room.playerId, null, 'lobby', 0)) {
      await updateGameState(state.room.id, { game_phase: 'lobby' });
    }
  } catch (err) {
    logger.error('Game', 'executeReturnToLobby cleanup failed', err);
  }

  sessionStorage.setItem('oracle_party_returning_from_game', '1');
  navigateWithFadeReplace('lobby.html');
}

// EVERY PLAYER HAS THE GEAR (owner, 2026-10-28): the host's opens the controls,
// everybody else's opens the same settings read-only. Hidden only where the
// game itself hides it — the countdown, leaving, a lost seat.
export function showHostSettingsGear() {
  if (!state.room) return;
  syncChaosDisplay();
  document.querySelectorAll('.host-settings-gear').forEach(btn => btn.classList.remove('hidden'));
}

export function hideHostSettingsGear() {
  document.querySelectorAll('.host-settings-gear').forEach(btn => btn.classList.add('hidden'));
}
