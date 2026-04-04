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
