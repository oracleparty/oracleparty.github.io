// ============================================
// Oracle Party — Host Settings Module
// In-game host settings panel, gear icon, return to lobby.
// ============================================

import { state, _isLeaving, setIsLeaving, _hostSettingsConfirmTimer, setHostSettingsConfirmTimer } from './state.js';
import { $, navigateWithFadeReplace } from '../utils.js';
import { logger } from '../logger.js';
import { RETURN_HOME_DELAY_MS } from '../constants.js';
import { updateGameState, updateRoomStatus, deleteAnswersByRoom } from '../supabase.js';

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
}

function openHostSettingsSheet() {
  const sheet = $('#host-settings-sheet');
  if (!sheet) return;

  // Sync toggle states from current settings
  syncHostSettingsToggles();

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
    } else if (key === 'questionTimer') {
      currentValue = String(state.timerSeconds || 30);
    }
    group.querySelectorAll('.toggle-option').forEach(opt => {
      opt.classList.toggle('active', opt.dataset.value === currentValue);
    });
  });
}

async function handleGameSettingChange(key, value) {
  const numVal = Number(value);
  const columnMap = {
    autoProceed: 'auto_proceed',
    questionTimer: 'question_timer'
  };

  // Update local state
  if (key === 'autoProceed') {
    state.autoProceedSeconds = numVal;
  } else if (key === 'questionTimer') {
    state.timerSeconds = numVal;
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
    await deleteAnswersByRoom(state.room.id);
    await updateGameState(state.room.id, {
      game_phase: 'lobby',
      current_question: 0,
      question_ids: [],
      question_started_at: null,
      countdown_started_at: null
    });
    await updateRoomStatus(state.room.id, 'lobby');
  } catch (err) {
    logger.error('Game', 'executeReturnToLobby cleanup failed', err);
  }

  sessionStorage.setItem('oracle_party_returning_from_game', '1');
  navigateWithFadeReplace('lobby.html');
}

export function showHostSettingsGear() {
  if (!state.room?.isHost) return;
  document.querySelectorAll('.host-settings-gear').forEach(btn => btn.classList.remove('hidden'));
}

export function hideHostSettingsGear() {
  document.querySelectorAll('.host-settings-gear').forEach(btn => btn.classList.add('hidden'));
}
