import { describe, it, expect } from 'vitest';
import {
  radarPoints, polygonPoints, buildRadarAxes, radarExtremes, RADAR_VIEWBOX,
} from '../js/radar.js';

const C = RADAR_VIEWBOX / 2;
const near = (a, b, tol = 0.01) => Math.abs(a - b) < tol;

describe('radarPoints', () => {
  it('starts at the top and goes clockwise', () => {
    const p = radarPoints(4, 1, 40);
    expect(near(p[0].x, C)).toBe(true);
    expect(near(p[0].y, C - 40)).toBe(true);   // up
    expect(near(p[1].x, C + 40)).toBe(true);   // right
    expect(near(p[2].y, C + 40)).toBe(true);   // down
    expect(near(p[3].x, C - 40)).toBe(true);   // left
  });

  it('puts everything at the centre for a value of zero', () => {
    for (const p of radarPoints(12, 0, 40)) {
      expect(near(p.x, C)).toBe(true);
      expect(near(p.y, C)).toBe(true);
    }
  });

  it('takes a value per axis', () => {
    const p = radarPoints(4, [1, 0, 1, 0], 40);
    expect(near(p[0].y, C - 40)).toBe(true);
    expect(near(p[1].x, C)).toBe(true);
  });

  // A stray value over 1 would draw outside the chart and past the emoji
  // labels; a negative one would draw through the opposite axis.
  it('clamps values outside 0..1', () => {
    const over = radarPoints(4, 5, 40);
    expect(near(over[0].y, C - 40)).toBe(true);
    const under = radarPoints(4, -3, 40);
    expect(near(under[0].y, C)).toBe(true);
  });

  it('copes with nonsense rather than drawing something wrong', () => {
    expect(radarPoints(0, 1, 40)).toEqual([]);
    expect(radarPoints(-2, 1, 40)).toEqual([]);
    expect(radarPoints(NaN, 1, 40)).toEqual([]);
  });

  it('gives one point per axis', () => {
    expect(radarPoints(12, 0.5, 40)).toHaveLength(12);
  });
});

describe('polygonPoints', () => {
  it('formats for an SVG points attribute', () => {
    expect(polygonPoints([{ x: 1, y: 2 }, { x: 3.456, y: 4 }])).toBe('1,2 3.46,4');
  });
  it('copes with nothing', () => {
    expect(polygonPoints([])).toBe('');
    expect(polygonPoints(null)).toBe('');
  });
});

describe('buildRadarAxes', () => {
  const axes = [
    { key: 'history', label: 'History', emoji: '⏳' },
    { key: 'science', label: 'Science', emoji: '⚗️' },
    { key: 'sports', label: 'Sports', emoji: '⚽' },
  ];

  it('turns met and mastered into a proficiency value', () => {
    const { axes: built } = buildRadarAxes(axes, {
      history: { met: 20, mastered: 15 },
    });
    expect(built[0].value).toBeCloseTo(0.75);
    expect(built[0].hasData).toBe(true);
  });

  // THE POINT OF THE WHOLE MODULE. "Never tried" and "bad at" are different
  // facts, and drawing both at the origin says the second about somebody who
  // has done the first.
  it('marks a category never played as having no data, not as a zero', () => {
    const { axes: built } = buildRadarAxes(axes, { history: { met: 10, mastered: 5 } });
    expect(built[0].hasData).toBe(true);
    expect(built[2].hasData).toBe(false);
    expect(built[2].met).toBe(0);
  });

  it('says when there is nothing to draw at all', () => {
    expect(buildRadarAxes(axes, {}).anyData).toBe(false);
    expect(buildRadarAxes(axes, null).anyData).toBe(false);
    expect(buildRadarAxes(axes, { history: { met: 1, mastered: 0 } }).anyData).toBe(true);
  });

  it('keeps the order it was given, so the axes do not move between visits', () => {
    const { axes: built } = buildRadarAxes(axes, {});
    expect(built.map(a => a.key)).toEqual(['history', 'science', 'sports']);
  });

  it('copes with nothing', () => {
    expect(buildRadarAxes(null, null).axes).toEqual([]);
    expect(buildRadarAxes([], {}).anyData).toBe(false);
  });
});

describe('radarExtremes', () => {
  const build = rows => buildRadarAxes(
    rows.map(r => ({ key: r.key, label: r.key, emoji: '?' })),
    Object.fromEntries(rows.map(r => [r.key, { met: r.met, mastered: r.mastered }])),
  ).axes;

  it('names the best and worst', () => {
    const { strongest, weakest } = radarExtremes(build([
      { key: 'a', met: 20, mastered: 18 },
      { key: 'b', met: 20, mastered: 4 },
      { key: 'c', met: 20, mastered: 11 },
    ]));
    expect(strongest.key).toBe('a');
    expect(weakest.key).toBe('b');
  });

  // One lucky answer is not a strength, and calling it one sends somebody to
  // the leaderboard to be disappointed.
  it('ignores categories with too small a sample', () => {
    const { strongest } = radarExtremes(build([
      { key: 'fluke', met: 1, mastered: 1 },
      { key: 'real', met: 40, mastered: 30 },
    ]));
    expect(strongest.key).toBe('real');
  });

  it('names nothing when nothing qualifies', () => {
    expect(radarExtremes(build([{ key: 'a', met: 2, mastered: 2 }])))
      .toEqual({ strongest: null, weakest: null });
    expect(radarExtremes([])).toEqual({ strongest: null, weakest: null });
  });

  // With one qualifying category, calling it both the best and the worst is
  // true and reads as an insult.
  it('does not name the same category as both', () => {
    const { strongest, weakest } = radarExtremes(build([{ key: 'only', met: 30, mastered: 20 }]));
    expect(strongest.key).toBe('only');
    expect(weakest).toBe(null);
  });
});
