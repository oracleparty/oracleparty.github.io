/**
 * Centralized logging utility.
 * All modules use this instead of raw console.error/warn/log.
 * Provides level-based filtering and consistent [Module] prefixing.
 */

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let currentLevel = LOG_LEVELS.debug; // show everything in dev; call setLevel('warn') for prod

export const logger = {
  error: (module, msg, err) => {
    if (currentLevel >= LOG_LEVELS.error) console.error(`[${module}] ${msg}`, err ?? '');
  },
  warn: (module, msg, err) => {
    if (currentLevel >= LOG_LEVELS.warn) console.warn(`[${module}] ${msg}`, err ?? '');
  },
  info: (module, msg, data) => {
    if (currentLevel >= LOG_LEVELS.info) console.info(`[${module}] ${msg}`, data ?? '');
  },
  debug: (module, msg, data) => {
    if (currentLevel >= LOG_LEVELS.debug) console.log(`[${module}] ${msg}`, data ?? '');
  },
  setLevel: (level) => {
    currentLevel = LOG_LEVELS[level] ?? LOG_LEVELS.warn;
  },
};

// ============================================
// Global Error Tracking
// ============================================

let _supabaseClient = null;
const _errorTimestamps = [];
const MAX_ERRORS_PER_MINUTE = 10;

function _isRateLimited() {
  const now = Date.now();
  // Drop entries older than 60s
  while (_errorTimestamps.length && _errorTimestamps[0] < now - 60000) {
    _errorTimestamps.shift();
  }
  if (_errorTimestamps.length >= MAX_ERRORS_PER_MINUTE) return true;
  _errorTimestamps.push(now);
  return false;
}

function _logToSupabase(payload) {
  if (!_supabaseClient) return;
  try {
    _supabaseClient.from('error_logs').insert({
      ...payload,
      url: window.location.href,
      user_agent: navigator.userAgent,
      timestamp: new Date().toISOString(),
    }).then(() => {}, () => {}); // fire and forget
  } catch (_) { /* fail silently */ }
}

function _showErrorToast(message) {
  if (currentLevel < LOG_LEVELS.debug) return; // suppress in production
  import('./utils.js').then(({ showToast }) => {
    showToast(`Error: ${String(message).substring(0, 80)}`, 'error');
  }).catch(() => {});
}

function initErrorTracking(client) {
  _supabaseClient = client;

  window.onerror = (message, source, lineno, colno, error) => {
    logger.error('Global', `Unhandled: ${message}`, { source, lineno, colno });
    if (!_isRateLimited()) {
      _logToSupabase({ type: 'onerror', message: String(message), source, lineno, colno, stack: error?.stack });
      _showErrorToast(message);
    }
  };

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const msg = reason?.message || String(reason);
    logger.error('Global', `Unhandled rejection: ${msg}`, reason);
    if (!_isRateLimited()) {
      _logToSupabase({ type: 'unhandledrejection', message: msg, stack: reason?.stack });
      _showErrorToast(msg);
    }
  });
}

// Auto-initialize: dynamic import avoids circular dependency with utils.js
import('./db/client.js').then(({ supabase }) => {
  initErrorTracking(supabase);
}).catch(() => {
  initErrorTracking(null);
});
