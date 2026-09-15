import { describe, it, expect } from 'vitest';
import {
  clapsForAnswer, iClapped, myClapInRound, clappersOf,
  applyClapEvent, favouriteAnswers, clapTotals,
} from '../js/game/clap-logic.js';

const clap = (id, answerId, voter, round = 0, owner = 'p-owner') => ({
  id, answer_id: answerId, voter_player_id: voter,
  clapped_player_id: owner, question_number: round,
});

describe('counting claps', () => {
  it('counts the claps on one answer', () => {
    const claps = [clap('c1', 'a1', 'v1'), clap('c2', 'a1', 'v2'), clap('c3', 'a2', 'v1', 1)];
    expect(clapsForAnswer(claps, 'a1')).toBe(2);
    expect(clapsForAnswer(claps, 'a2')).toBe(1);
    expect(clapsForAnswer(claps, 'a3')).toBe(0);
  });

  // Ids arrive as uuids from Postgres and as whatever a mock hands over. A
  // strict === between a number and its string is the silent kind of wrong.
  it('does not care whether an id is a string or a number', () => {
    expect(clapsForAnswer([clap('c1', 7, 3)], '7')).toBe(1);
    expect(iClapped([clap('c1', 7, 3)], 7, '3')).toBe(true);
  });

  it('knows whether this player clapped an answer', () => {
    const claps = [clap('c1', 'a1', 'v1')];
    expect(iClapped(claps, 'a1', 'v1')).toBe(true);
    expect(iClapped(claps, 'a1', 'v2')).toBe(false);
  });

  it('lists who clapped, in order', () => {
    const claps = [clap('c1', 'a1', 'v2'), clap('c2', 'a1', 'v1')];
    expect(clappersOf(claps, 'a1')).toEqual(['v2', 'v1']);
  });
});

describe('one clap per round', () => {
  it('finds the answer this player clapped in a round', () => {
    const claps = [clap('c1', 'a1', 'v1', 0), clap('c2', 'a9', 'v1', 1)];
    expect(myClapInRound(claps, 0, 'v1')).toBe('a1');
    expect(myClapInRound(claps, 1, 'v1')).toBe('a9');
  });

  it('is null in a round they have not clapped in', () => {
    expect(myClapInRound([clap('c1', 'a1', 'v1', 0)], 2, 'v1')).toBe(null);
  });

  it('does not confuse one player\'s clap for another\'s', () => {
    expect(myClapInRound([clap('c1', 'a1', 'v1', 0)], 0, 'v2')).toBe(null);
  });
});

describe('applying a realtime event', () => {
  it('adds an inserted clap', () => {
    const next = applyClapEvent([], { eventType: 'INSERT', new: clap('c1', 'a1', 'v1') });
    expect(next).toHaveLength(1);
  });

  it('ignores an insert it already has, so an echo of our own write is free', () => {
    const start = [clap('c1', 'a1', 'v1')];
    const next = applyClapEvent(start, { eventType: 'INSERT', new: clap('c1', 'a1', 'v1') });
    expect(next).toHaveLength(1);
  });

  // A clap MOVING is an update, not a delete and an insert.
  it('moves a clap in place on an update, keeping its position', () => {
    const start = [clap('c1', 'a1', 'v1'), clap('c2', 'a2', 'v2')];
    const next = applyClapEvent(start, { eventType: 'UPDATE', new: clap('c1', 'a3', 'v1') });
    expect(next.map(c => c.answer_id)).toEqual(['a3', 'a2']);
  });

  // THE ONE THAT WOULD HAVE SHIPPED BROKEN. A Postgres DELETE payload carries
  // only the primary key — no answer_id, no voter — so anything matching on
  // those removes nothing and the clap stays on screen for ever.
  it('removes a withdrawn clap using only the primary key', () => {
    const start = [clap('c1', 'a1', 'v1'), clap('c2', 'a2', 'v2')];
    const next = applyClapEvent(start, { eventType: 'DELETE', old: { id: 'c1' } });
    expect(next.map(c => c.id)).toEqual(['c2']);
  });

  it('returns the same array when nothing changed, so no repaint is needed', () => {
    const start = [clap('c1', 'a1', 'v1')];
    expect(applyClapEvent(start, { eventType: 'DELETE', old: { id: 'nope' } })).toBe(start);
    expect(applyClapEvent(start, { eventType: 'INSERT', new: {} })).toBe(start);
  });
});

describe('favourite answers', () => {
  it('names the clear winner', () => {
    const claps = [
      clap('c1', 'a1', 'v1', 0), clap('c2', 'a1', 'v2', 0),
      clap('c3', 'a2', 'v3', 1),
    ];
    const { entries, more } = favouriteAnswers(claps);
    expect(entries[0].answerId).toBe('a1');
    expect(entries[0].claps).toBe(2);
    expect(more).toBe(0);
  });

  // THE TWO-PLAYER CASE, which is not an edge case but the normal one in a
  // small room: nobody can exceed one clap, so everything ties.
  it('lists everything when a two-player game ties at one clap each', () => {
    const claps = [
      clap('c1', 'a1', 'v1', 0), clap('c2', 'a2', 'v2', 1), clap('c3', 'a3', 'v1', 2),
    ];
    const { entries, more } = favouriteAnswers(claps);
    expect(entries).toHaveLength(3);
    expect(entries.every(e => e.claps === 1)).toBe(true);
    expect(more).toBe(0);
  });

  it('caps the list and says how many did not fit', () => {
    const claps = [0, 1, 2, 3, 4].map((r, i) => clap(`c${i}`, `a${i}`, 'v1', r));
    const { entries, more } = favouriteAnswers(claps);
    expect(entries).toHaveLength(3);
    expect(more).toBe(2);
  });

  // Chronological within a tier is the only tie-break that is not arbitrary.
  it('orders a tie by the round it happened in', () => {
    const claps = [clap('c1', 'a-late', 'v1', 7), clap('c2', 'a-early', 'v2', 2)];
    expect(favouriteAnswers(claps).entries.map(e => e.answerId))
      .toEqual(['a-early', 'a-late']);
  });

  it('puts more claps above an earlier round', () => {
    const claps = [
      clap('c1', 'a-early', 'v1', 0),
      clap('c2', 'a-late', 'v2', 9), clap('c3', 'a-late', 'v3', 9),
    ];
    expect(favouriteAnswers(claps).entries[0].answerId).toBe('a-late');
  });

  it('is empty when nobody clapped anything', () => {
    expect(favouriteAnswers([])).toEqual({ entries: [], more: 0 });
  });
});

describe('lifetime totals', () => {
  it('sums received and available across games', () => {
    const rows = [
      { claps_received: 3, claps_available: 12 },
      { claps_received: 5, claps_available: 20 },
    ];
    const t = clapTotals(rows);
    expect(t.received).toBe(8);
    expect(t.available).toBe(32);
    expect(t.rate).toBeCloseTo(0.25);
  });

  // NULL, NEVER ZERO. "Not enough play yet" and "nobody has ever clapped you"
  // are different facts and must not render the same way — the same call the
  // admin count chips make by showing `?` rather than `0`.
  it('withholds the rate under the floor instead of reporting a fake one', () => {
    const t = clapTotals([{ claps_received: 1, claps_available: 1 }]);
    expect(t.received).toBe(1);
    expect(t.rate).toBe(null);
  });

  it('reports a rate of zero for somebody who played plenty and got none', () => {
    const t = clapTotals([{ claps_received: 0, claps_available: 40 }]);
    expect(t.rate).toBe(0);
  });

  it('survives no history at all', () => {
    expect(clapTotals([])).toEqual({ received: 0, available: 0, rate: null });
  });
});

describe('an optimistic tap and its own echo', () => {
  const clap2 = (id, answerId, voter, round) => ({
    id, answer_id: answerId, voter_player_id: voter,
    clapped_player_id: 'p-owner', question_number: round,
  });

  // THE TAP MUST SHOW BEFORE THE ROUND TRIP, or a clap on a real phone is a
  // button that does nothing for a second — the fault this project has recorded
  // more than any other. So the screen adds a clap under a temporary id, and
  // the server's real row arrives moments later. Without the dedupe below they
  // both stand and one tap reads as two claps.
  it('collapses the optimistic row when the real one arrives', () => {
    const optimistic = [clap2('tmp-1', 'a1', 'me', 0)];
    const next = applyClapEvent(optimistic, {
      eventType: 'INSERT', new: clap2('real-1', 'a1', 'me', 0),
    });
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('real-1');
  });

  it('collapses it even when the clap landed on a different answer', () => {
    const optimistic = [clap2('tmp-1', 'a2', 'me', 0)];
    const next = applyClapEvent(optimistic, {
      eventType: 'UPDATE', new: clap2('real-1', 'a2', 'me', 0),
    });
    expect(next).toHaveLength(1);
  });

  it('leaves other people\'s claps in that round alone', () => {
    const start = [clap2('tmp-1', 'a1', 'me', 0), clap2('c9', 'a1', 'someone-else', 0)];
    const next = applyClapEvent(start, {
      eventType: 'INSERT', new: clap2('real-1', 'a1', 'me', 0),
    });
    expect(next).toHaveLength(2);
    expect(next.some(c => c.voter_player_id === 'someone-else')).toBe(true);
  });

  it('leaves my own claps in other rounds alone', () => {
    const start = [clap2('c1', 'a1', 'me', 0)];
    const next = applyClapEvent(start, {
      eventType: 'INSERT', new: clap2('c2', 'a5', 'me', 1),
    });
    expect(next).toHaveLength(2);
  });
});
