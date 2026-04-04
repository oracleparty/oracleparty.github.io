import { describe, it, expect } from 'vitest';
import { determineNextHost } from '../js/game/host-promotion.js';
import { findNextAvailableWager } from '../js/game/scoring-helpers.js';

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
