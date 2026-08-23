import { describe, it, expect } from 'vitest';
import { hexLayout, hexPoints, hexFill, hexFillRect } from '../js/honeycomb.js';

const SQRT3 = Math.sqrt(3);
const near = (a, b, tol = 0.02) => Math.abs(a - b) < tol;

describe('hexLayout', () => {
  it('places one cell per item', () => {
    expect(hexLayout(12, 4, 40).cells).toHaveLength(12);
    expect(hexLayout(1, 4, 40).cells).toHaveLength(1);
  });

  it('reports a box that actually contains every cell', () => {
    // The SVG viewBox comes from width/height. If a cell sticks out of it the
    // hex is clipped on the phone and nothing in the code would say so.
    for (const [n, cols] of [[12, 4], [7, 4], [3, 3], [1, 1], [20, 5]]) {
      const { cells, width, height, size } = hexLayout(n, cols, 40);
      const w = SQRT3 * size;
      for (const c of cells) {
        expect(c.cx - w / 2).toBeGreaterThanOrEqual(-0.01);
        expect(c.cx + w / 2).toBeLessThanOrEqual(width + 0.01);
        expect(c.cy - size).toBeGreaterThanOrEqual(-0.01);
        expect(c.cy + size).toBeLessThanOrEqual(height + 0.01);
      }
    }
  });

  it('interlocks the rows instead of stacking them', () => {
    // A honeycomb's rows overlap vertically — 1.5 x size, not 2 x size. Get
    // this wrong and it is a grid of hexagons with gaps, not a honeycomb.
    const { cells, size } = hexLayout(8, 4, 40);
    expect(near(cells[4].cy - cells[0].cy, 1.5 * size)).toBe(true);
  });

  it('staggers odd rows by half a cell', () => {
    const { cells, size } = hexLayout(8, 4, 40);
    expect(near(cells[4].cx - cells[0].cx, (SQRT3 * size) / 2)).toBe(true);
  });

  // THE ONE THAT WAS WRONG. A short row centred exactly lands off the
  // half-step, and then its hexes overlap their neighbours instead of
  // tessellating — the comb renders as a pile of blobs. Every number was fine;
  // only looking at it showed anything.
  it('keeps every row on the same lattice, including a short one', () => {
    for (const [n, cols] of [[12, 4], [6, 4], [5, 3], [7, 4], [11, 4], [2, 3]]) {
      const { cells, size } = hexLayout(n, cols, 40);
      const w = SQRT3 * size;
      const half = cells[0].cx;                       // lattice origin
      for (const c of cells) {
        const steps = (c.cx - half) / (w / 2);
        expect(near(steps, Math.round(steps))).toBe(true);
        // Cells in one row are a whole cell apart; the rows themselves are the
        // half-steps, so a cell's parity must match its row's.
        expect(Math.abs(Math.round(steps)) % 2).toBe(c.row % 2);
      }
    }
  });

  it('centres a short last row as far as the lattice allows', () => {
    const { cells, width, size } = hexLayout(6, 4, 40);   // rows of 4 and 2
    const last = cells.slice(4);
    const mid = (last[0].cx + last[1].cx) / 2;
    // Exactly centred is not available on a lattice; within half a cell is.
    expect(Math.abs(mid - width / 2)).toBeLessThanOrEqual((SQRT3 * size) / 2 + 0.01);
  });

  it('sizes the box from where the cells actually are', () => {
    // A single short row must not sit inside a box built from the column
    // count, or it renders off-centre for no reason.
    const { width, size } = hexLayout(2, 4, 40);
    expect(near(width, 2 * SQRT3 * size)).toBe(true);
  });

  it('copes with nothing', () => {
    expect(hexLayout(0, 4, 40)).toEqual({ cells: [], width: 0, height: 0, size: 40 });
    expect(hexLayout(-3, 4, 40).cells).toEqual([]);
    expect(hexLayout(NaN, 4, 40).cells).toEqual([]);
  });

  it('does not divide by a zero column count', () => {
    expect(hexLayout(3, 0, 40).cells).toHaveLength(3);
  });
});

describe('hexPoints', () => {
  it('gives six corners', () => {
    expect(hexPoints(50, 50, 40).split(' ')).toHaveLength(6);
  });

  it('puts a vertex at the top, which is what pointy-top means', () => {
    const [first] = hexPoints(50, 50, 40).split(' ');
    const [x, y] = first.split(',').map(Number);
    expect(near(x, 50)).toBe(true);
    expect(near(y, 10)).toBe(true);
  });

  it('is as wide as the layout assumes', () => {
    // hexLayout spaces cells by SQRT3 * size. If the drawn shape were wider
    // than that the cells would overlap; narrower and the comb has gaps.
    const xs = hexPoints(50, 50, 40).split(' ').map(p => Number(p.split(',')[0]));
    expect(near(Math.max(...xs) - Math.min(...xs), SQRT3 * 40, 0.1)).toBe(true);
  });
});

describe('hexFill', () => {
  it('is the plain fraction when there is enough to see', () => {
    expect(hexFill(50, 100)).toBeCloseTo(0.5);
    expect(hexFill(200, 100)).toBe(1);
  });

  // THE POINT. The bank holds 4,859 questions, so a real category fraction is
  // often 0.4% — which draws as nothing, and makes "I have started this" and
  // "I have never touched this" look identical on the one screen meant to show
  // the difference.
  it('gives anything above zero a visible floor', () => {
    expect(hexFill(1, 900)).toBe(0.06);
    expect(hexFill(1, 900, 0.2)).toBe(0.2);
  });

  it('leaves a genuinely empty cell empty', () => {
    expect(hexFill(0, 900)).toBe(0);
    expect(hexFill(0, 0)).toBe(0);
    expect(hexFill(5, 0)).toBe(0);
  });

  it('copes with nonsense', () => {
    expect(hexFill(null, null)).toBe(0);
    expect(hexFill(-4, 100)).toBe(0);
    expect(hexFill('x', 'y')).toBe(0);
  });
});

describe('hexFillRect', () => {
  const cell = { cx: 100, cy: 100 };

  it('rises from the bottom, because a cell that fills downward reads as draining', () => {
    const half = hexFillRect(cell, 0.5, 40);
    expect(near(half.y + half.height, cell.cy + 40)).toBe(true);   // bottom pinned
    expect(near(half.height, 40)).toBe(true);                      // half of 2 x size
  });

  it('covers the whole cell at 1 and none of it at 0', () => {
    const full = hexFillRect(cell, 1, 40);
    expect(near(full.y, cell.cy - 40)).toBe(true);
    expect(near(full.height, 80)).toBe(true);
    expect(hexFillRect(cell, 0, 40).height).toBe(0);
  });

  it('is as wide as the cell', () => {
    expect(near(hexFillRect(cell, 1, 40).width, SQRT3 * 40, 0.05)).toBe(true);
  });

  it('clamps rather than drawing outside the cell', () => {
    expect(hexFillRect(cell, 5, 40).height).toBe(80);
    expect(hexFillRect(cell, -2, 40).height).toBe(0);
  });
});
