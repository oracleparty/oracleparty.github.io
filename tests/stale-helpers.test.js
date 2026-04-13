import { describe, it, expect } from 'vitest';
import { isPlayerStale, getStaleKickDecisions } from '../js/stale-helpers.js';

// Fixed thresholds for tests so they don't depend on constants.js values
const DISCONNECTED = 45_000;  // 45s
const STALE = 180_000;        // 3 min

const NOW = 1_000_000_000_000; // arbitrary fixed "now" (ms)

function player(overrides) {
  return {
    id: '1',
    display_name: 'Alice',
    is_host: false,
    joined_at: new Date(NOW - 60_000).toISOString(), // joined 1 min ago
    last_seen_at: new Date(NOW - 5_000).toISOString(), // seen 5s ago (fresh)
    disconnected_at: null,
    ...overrides,
  };
}

// ============================================
// isPlayerStale
// ============================================
describe('isPlayerStale', () => {
  it('fresh player is not stale', () => {
    const p = player({ last_seen_at: new Date(NOW - 5_000).toISOString() });
    expect(isPlayerStale(p, NOW, DISCONNECTED, STALE)).toBe(false);
  });

  it('player silent for just under stale threshold is not stale', () => {
    const p = player({ last_seen_at: new Date(NOW - (STALE - 1)).toISOString() });
    expect(isPlayerStale(p, NOW, DISCONNECTED, STALE)).toBe(false);
  });

  it('player silent for exactly stale threshold is stale', () => {
    const p = player({ last_seen_at: new Date(NOW - STALE).toISOString() });
    expect(isPlayerStale(p, NOW, DISCONNECTED, STALE)).toBe(true);
  });

  // --- THE BUG THIS TEST WOULD HAVE CAUGHT ---
  // addPlayer() was not setting last_seen_at on insert.
  // null is treated as epoch 0 → ~56 years of silence → immediately stale.
  it('null last_seen_at is treated as stale (epoch 0 → huge silence)', () => {
    const p = player({ last_seen_at: null });
    expect(isPlayerStale(p, NOW, DISCONNECTED, STALE)).toBe(true);
  });

  it('disconnected player uses shorter threshold', () => {
    // Silent for 30s: stale under DISCONNECTED (45s)? No — 30s < 45s.
    const p = player({
      last_seen_at: new Date(NOW - 30_000).toISOString(),
      disconnected_at: new Date(NOW - 30_000).toISOString(),
    });
    expect(isPlayerStale(p, NOW, DISCONNECTED, STALE)).toBe(false);
  });

  it('disconnected player silent for DISCONNECTED_TIMEOUT is stale', () => {
    const p = player({
      last_seen_at: new Date(NOW - DISCONNECTED).toISOString(),
      disconnected_at: new Date(NOW - DISCONNECTED).toISOString(),
    });
    expect(isPlayerStale(p, NOW, DISCONNECTED, STALE)).toBe(true);
  });

  it('non-disconnected player silent for < STALE_TIMEOUT is not stale even if > DISCONNECTED_TIMEOUT', () => {
    // 60s silence, no disconnected_at → uses STALE threshold (3min) → not stale
    const p = player({
      last_seen_at: new Date(NOW - 60_000).toISOString(),
      disconnected_at: null,
    });
    expect(isPlayerStale(p, NOW, DISCONNECTED, STALE)).toBe(false);
  });
});

// ============================================
// getStaleKickDecisions
// ============================================
describe('getStaleKickDecisions', () => {
  it('returns empty array when all players are fresh', () => {
    const ps = [
      player({ id: '1', last_seen_at: new Date(NOW - 5_000).toISOString() }),
      player({ id: '2', last_seen_at: new Date(NOW - 5_000).toISOString() }),
    ];
    expect(getStaleKickDecisions(ps, '1', true, NOW, DISCONNECTED, STALE)).toEqual([]);
  });

  it('never includes self (myPlayerId)', () => {
    // My own player has null last_seen_at — should NEVER be removed by ourselves
    const ps = [
      player({ id: 'me', last_seen_at: null }),
      player({ id: 'other', last_seen_at: new Date(NOW - 5_000).toISOString() }),
    ];
    const decisions = getStaleKickDecisions(ps, 'me', true, NOW, DISCONNECTED, STALE);
    expect(decisions).not.toContain('me');
  });

  it('host removes stale non-host player', () => {
    const ps = [
      player({ id: 'host', is_host: true, last_seen_at: new Date(NOW - 5_000).toISOString() }),
      player({ id: 'stale', is_host: false, last_seen_at: new Date(NOW - STALE).toISOString() }),
    ];
    const decisions = getStaleKickDecisions(ps, 'host', true, NOW, DISCONNECTED, STALE);
    expect(decisions).toContain('stale');
  });

  it('non-host does NOT remove stale non-host player', () => {
    const ps = [
      player({ id: 'me', is_host: false, last_seen_at: new Date(NOW - 5_000).toISOString() }),
      player({ id: 'stale', is_host: false, last_seen_at: new Date(NOW - STALE).toISOString() }),
    ];
    const decisions = getStaleKickDecisions(ps, 'me', false, NOW, DISCONNECTED, STALE);
    expect(decisions).not.toContain('stale');
  });

  it('earliest connected player removes a stale host', () => {
    const ps = [
      // stale host
      player({ id: 'host', is_host: true, last_seen_at: new Date(NOW - STALE).toISOString(), joined_at: new Date(NOW - 120_000).toISOString() }),
      // earliest connected non-host
      player({ id: 'first', is_host: false, last_seen_at: new Date(NOW - 5_000).toISOString(), joined_at: new Date(NOW - 90_000).toISOString() }),
      // later connected non-host
      player({ id: 'second', is_host: false, last_seen_at: new Date(NOW - 5_000).toISOString(), joined_at: new Date(NOW - 30_000).toISOString() }),
    ];
    // 'first' is earliest connected → should trigger the kick
    expect(getStaleKickDecisions(ps, 'first', false, NOW, DISCONNECTED, STALE)).toContain('host');
    // 'second' is NOT the earliest → should NOT trigger the kick (prevents duplicate removes)
    expect(getStaleKickDecisions(ps, 'second', false, NOW, DISCONNECTED, STALE)).not.toContain('host');
  });

  it('new player with null last_seen_at is kicked by host — demonstrates why addPlayer must set it', () => {
    const ps = [
      player({ id: 'host', is_host: true, last_seen_at: new Date(NOW - 5_000).toISOString() }),
      // Simulates a new player whose addPlayer() insert didn't set last_seen_at
      player({ id: 'newbie', is_host: false, last_seen_at: null }),
    ];
    const decisions = getStaleKickDecisions(ps, 'host', true, NOW, DISCONNECTED, STALE);
    // This MUST include 'newbie' — the test documents the failure mode.
    // The fix is in addPlayer() setting last_seen_at on insert.
    expect(decisions).toContain('newbie');
  });
});

// ============================================
// addPlayer payload contract
// ============================================
// Static guard: if someone removes last_seen_at from addPlayer, this breaks.
describe('addPlayer payload contract', () => {
  it('addPlayer sets last_seen_at so new players are not immediately stale', () => {
    const { readFileSync } = require('fs');
    const { resolve } = require('path');
    const src = readFileSync(resolve(__dirname, '../js/db/players.js'), 'utf8');
    const payloadLine = src.split('\n').find(l => l.includes('const payload') && l.includes('room_id'));
    expect(payloadLine).toBeDefined();
    expect(payloadLine).toContain('last_seen_at');
  });
});
