import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { determineNextHost } from '../js/game/host-promotion.js';
import { findNextAvailableWager } from '../js/game/scoring-helpers.js';

const GAME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'js', 'game');

// ============================================
// determineNextHost
// ============================================
describe('determineNextHost', () => {
  it('returns null for empty/null player list', () => {
    expect(determineNextHost([])).toBe(null);
    expect(determineNextHost(null)).toBe(null);
  });

  it('returns null when a host already exists', () => {
    const players = [
      { id: '1', is_host: true, joined_at: '2024-01-01T00:00:00Z' },
      { id: '2', is_host: false, joined_at: '2024-01-01T00:01:00Z' },
    ];
    expect(determineNextHost(players)).toBe(null);
  });

  it('prefers co-host over earliest player', () => {
    const players = [
      { id: '1', is_host: false, is_cohost: false, joined_at: '2024-01-01T00:00:00Z' },
      { id: '2', is_host: false, is_cohost: true, joined_at: '2024-01-01T00:05:00Z' },
    ];
    expect(determineNextHost(players).id).toBe('2');
  });

  it('falls back to earliest joined player when no co-host', () => {
    const players = [
      { id: '1', is_host: false, joined_at: '2024-01-01T00:05:00Z' },
      { id: '2', is_host: false, joined_at: '2024-01-01T00:01:00Z' },
      { id: '3', is_host: false, joined_at: '2024-01-01T00:10:00Z' },
    ];
    expect(determineNextHost(players).id).toBe('2');
  });

  it('handles single player without host', () => {
    const players = [
      { id: '1', is_host: false, joined_at: '2024-01-01T00:00:00Z' },
    ];
    expect(determineNextHost(players).id).toBe('1');
  });

  it('handles missing joined_at (sorts to end)', () => {
    const players = [
      { id: '1', is_host: false, joined_at: null },
      { id: '2', is_host: false, joined_at: '2024-01-01T00:01:00Z' },
    ];
    expect(determineNextHost(players).id).toBe('2');
  });

  it('does not mutate original array', () => {
    const players = [
      { id: '1', is_host: false, joined_at: '2024-01-01T00:05:00Z' },
      { id: '2', is_host: false, joined_at: '2024-01-01T00:01:00Z' },
    ];
    const original = [...players];
    determineNextHost(players);
    expect(players[0].id).toBe(original[0].id);
    expect(players[1].id).toBe(original[1].id);
  });

  // Host and co-host are for humans. A bot cannot start a game, advance a
  // phase or judge an answer, so a room in its hands is a frozen room.
  it('never promotes a bot, even when it joined first', () => {
    const players = [
      { id: 'bot', is_host: false, is_bot: true, joined_at: '2024-01-01T00:00:00Z' },
      { id: '2', is_host: false, joined_at: '2024-01-01T00:05:00Z' },
    ];
    expect(determineNextHost(players).id).toBe('2');
  });

  it('never promotes a bot, even one flagged as co-host', () => {
    // The UI cannot make a bot co-host, but a stray row must not be able to
    // inherit the room either.
    const players = [
      { id: 'bot', is_host: false, is_bot: true, is_cohost: true, joined_at: '2024-01-01T00:00:00Z' },
      { id: '2', is_host: false, joined_at: '2024-01-01T00:05:00Z' },
    ];
    expect(determineNextHost(players).id).toBe('2');
  });

  it('returns null when only bots are left', () => {
    const players = [
      { id: 'bot', is_host: false, is_bot: true, joined_at: '2024-01-01T00:00:00Z' },
    ];
    expect(determineNextHost(players)).toBe(null);
  });

  it('still returns null when a present human host exists alongside a bot', () => {
    const players = [
      { id: '1', is_host: true, joined_at: '2024-01-01T00:00:00Z' },
      { id: 'bot', is_host: false, is_bot: true, joined_at: '2024-01-01T00:01:00Z' },
    ];
    expect(determineNextHost(players)).toBe(null);
  });
});

// ============================================
// Wager auto-select on timer expiry
// ============================================
describe('wager auto-select on timer expiry', () => {
  it('assigns lowest available wager for regular round', () => {
    const used = new Map([[1, true], [2, false]]);
    expect(findNextAvailableWager(used, 10)).toBe(3);
  });

  it('falls back to 1 when all wagers used', () => {
    const used = new Map([[1, true], [2, true], [3, false]]);
    expect(findNextAvailableWager(used, 3)).toBe(1);
  });

  it('returns 1 for fresh game with no wagers used', () => {
    expect(findNextAvailableWager(new Map(), 10)).toBe(1);
  });
});

// ============================================
// EVERY TIMER THE GAME HOLDS MUST BE CLEARED BY cleanup()
//
// A lint, not a behaviour test, and it exists because three timers had drifted
// out of that list. Every cleanup() call site navigates immediately EXCEPT
// executeReturnToLobby — the host ending the game from the settings gear —
// which calls cleanup() and then awaits three database round trips before
// navigating. Seconds, on a phone. A leaked timer is live for all of it:
//
//   autoProceedTimerId fired actionFn() and advanced the game, writing
//   game_phase='question' AFTER the same function had written 'lobby' and
//   emptied question_ids — putting every phone in the room on a question screen
//   with no questions in it.
//
// Reading cleanup() and spotting an absence is exactly the kind of check this
// project keeps failing to make by hand (CLAUDE.md: "a rule stated twice and
// fixed once"), so it is mechanical now.
//
// Deliberately narrow enough to be provably sound: it only matches an
// assignment of the literal form `state.<name> = setInterval(` or
// `= setTimeout(`, which is how every one of them is written.
// ============================================
describe('cleanup() clears every timer the game starts', () => {
  const CREATE = /state\.([_A-Za-z0-9]+)\s*=\s*set(?:Interval|Timeout)\s*\(/g;

  function timerNamesCreated() {
    const names = new Set();
    for (const file of readdirSync(GAME_DIR).filter(f => f.endsWith('.js'))) {
      const src = readFileSync(join(GAME_DIR, file), 'utf8');
      for (const m of src.matchAll(CREATE)) names.add(m[1]);
    }
    return names;
  }

  function cleanupBody() {
    const src = readFileSync(join(GAME_DIR, 'init.js'), 'utf8');
    const at = src.indexOf('function cleanup()');
    expect(at, 'cleanup() not found in js/game/init.js').toBeGreaterThan(-1);
    // To the next top-level function declaration, which is where it ends.
    const after = src.indexOf('\nfunction ', at + 1);
    return src.slice(at, after === -1 ? src.length : after);
  }

  it('finds the timers it is meant to be checking', () => {
    // Guards the lint itself. If the regex ever stops matching, every
    // assertion below passes over an empty set and reports a clean bill of
    // health for any amount of leakage.
    const names = timerNamesCreated();
    expect(names.size).toBeGreaterThanOrEqual(8);
    expect(names.has('timerId')).toBe(true);
    expect(names.has('autoProceedTimerId')).toBe(true);
  });

  it('clears every one of them', () => {
    const body = cleanupBody();
    const missing = [...timerNamesCreated()]
      .filter(n => !body.includes(`state.${n}`))
      .sort();
    expect(missing, `timers started but never cleared in cleanup(): ${missing.join(', ')}`).toEqual([]);
  });
});
