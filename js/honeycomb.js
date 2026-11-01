// ============================================
// Oracle Party — laying out a honeycomb
//
// NO IMPORTS, so the geometry is unit-testable in Node. Everything around it
// pulls the Supabase client from esm.sh, which the test runner cannot load.
//
// Pointy-top hexes in offset rows. Pointy-top because the rows then stack
// vertically with a half-width stagger, which is the shape that packs a
// portrait phone; flat-top wants to grow sideways, which is the one direction
// there is none to grow in.
// ============================================

const SQRT3 = Math.sqrt(3);

/**
 * Where each cell goes, in a coordinate space this function also sizes.
 *
 * @param count    how many cells
 * @param columns  cells per full row
 * @param size     circumradius — centre to a corner
 * → { cells: [{ i, row, col, cx, cy }], width, height, size }
 *
 * Odd rows are offset by half a cell, which is what makes it a honeycomb
 * rather than a grid of hexagons.
 *
 * A SHORT LAST ROW IS CENTRED ONLY AS FAR AS THE LATTICE ALLOWS. The first
 * version centred it exactly, and that is the wrong shape: a row of two under a
 * row of three landed a quarter of a cell off the half-step, so the hexes
 * overlapped their neighbours instead of tessellating and the comb read as a
 * pile of blobs. It was obvious the moment it was rendered and invisible in
 * every number. So the row is shifted by WHOLE cells from its own stagger,
 * which keeps the packing exact and leaves it within half a cell of centred —
 * that is the closest a honeycomb can get, and it looks deliberate.
 */
export function hexLayout(count, columns = 4, size = 44) {
  const n = Math.max(0, Math.floor(count) || 0);
  const cols = Math.max(1, Math.floor(columns) || 1);
  if (n === 0) return { cells: [], width: 0, height: 0, size };

  const w = SQRT3 * size;          // cell width
  const vStep = 1.5 * size;        // row pitch — rows interlock, so not full height
  const rows = Math.ceil(n / cols);
  const usable = cols * w + (rows > 1 ? w / 2 : 0);

  const cells = [];
  let width = 0;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const col = i % cols;
    const inThisRow = Math.min(cols, n - row * cols);
    const stagger = (rows > 1 && row % 2 === 1) ? w / 2 : 0;

    let left = stagger;
    if (inThisRow < cols && rows > 1) {
      // Nearest whole-cell shift to centred. Whole cells, so the row stays on
      // the same lattice as the ones above it.
      const ideal = (usable - inThisRow * w) / 2;
      left = stagger + Math.max(0, Math.round((ideal - stagger) / w)) * w;
    }

    cells.push({
      i, row, col,
      cx: left + col * w + w / 2,
      cy: row * vStep + size,
    });
    width = Math.max(width, left + inThisRow * w);
  }
  // Measured from where the cells actually ended up, not from the column
  // count: a single short row would otherwise sit inside a box wider than
  // itself and render off-centre for no reason.
  return { cells, width, height: (rows - 1) * vStep + 2 * size, size };
}

/**
 * The six corners of a pointy-top hexagon, as an SVG points attribute.
 */
export function hexPoints(cx, cy, size) {
  const pts = [];
  for (let k = 0; k < 6; k++) {
    // -90° puts a vertex at the top, which is what "pointy-top" means.
    const a = (Math.PI / 180) * (60 * k - 90);
    pts.push(`${round(cx + size * Math.cos(a))},${round(cy + size * Math.sin(a))}`);
  }
  return pts.join(' ');
}

const round = n => Math.round(n * 100) / 100;

/**
 * How full a cell should look, 0..1.
 *
 * Anything above zero gets a visible floor, because the honest number for a
 * category with 4,859 questions behind it is often 0.4% — which rounds to
 * nothing on screen and makes "I have started this" and "I have never touched
 * this" look identical. The FRACTION printed on the cell stays exact; only the
 * bar is floored, and only once there is something real to show.
 */
export function hexFill(mastered, total, floor = 0.06) {
  const m = Math.max(0, Number(mastered) || 0);
  const t = Math.max(0, Number(total) || 0);
  if (t === 0 || m === 0) return 0;
  return Math.max(floor, Math.min(1, m / t));
}

/**
 * The rectangle to clip against a cell so it looks like liquid filling it.
 *
 * Rises from the BOTTOM. A cell that fills downward from the top reads as
 * draining, which is the opposite of what this is showing.
 *
 * → { x, y, width, height } — height 0 when there is nothing to show, so the
 *   caller can skip drawing rather than emit a zero-height rect.
 */
export function hexFillRect(cell, fill, size) {
  const s = Number(size) || 0;
  const f = Math.max(0, Math.min(1, Number(fill) || 0));
  const w = SQRT3 * s;
  const full = 2 * s;                       // corner to corner, vertically
  const h = full * f;
  return {
    x: round(cell.cx - w / 2),
    y: round(cell.cy + s - h),
    width: round(w),
    height: round(h),
  };
}

// ============================================
// Colour and glow (owner, 2026-11-01)
//
// Fill HEIGHT is still how much is mastered. The fill's COLOUR is the rank held
// there, and the GLOW is hard-earned: nothing below half of a topic, then it
// brightens to full at the whole topic. A subject glows like its best topic,
// the same rule ranks use, because a whole subject's share stays tiny for a
// long time and would leave everybody dark.
// ============================================

/** The tier names in ladder order, so a cell can carry a CSS-readable rank. */
export const HEX_RANK_TIERS = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic'];

/** Below this share of a topic there is no glow at all. */
export const GLOW_START = 0.5;

/** 0..1 — how strongly a cell glows for a share of its topic mastered. */
export function hexGlow(fraction) {
  const f = Number(fraction);
  if (!Number.isFinite(f) || f < GLOW_START) return 0;
  return Math.min(1, (f - GLOW_START) / (1 - GLOW_START));
}

/**
 * The step a share of ONE topic stands at, as an index into HEX_RANK_TIERS:
 * -1 untouched, 0 started, then a quarter / half / three quarters / all.
 * The same shares the topic words are earned at.
 */
export function topicStepIndex(fraction) {
  const f = Number(fraction) || 0;
  if (f <= 0) return -1;
  if (f >= 1) return 4;
  if (f >= 0.75) return 3;
  if (f >= 0.5) return 2;
  if (f >= 0.25) return 1;
  return 0;
}

/**
 * The fill as a path with a WAVY top edge, so it reads as liquid rather than a
 * ruled line (owner, 2026-11-01). A full cell has no surface to wave, and an
 * almost-empty one gets a shallower wave so it never dips below the bottom.
 *
 * @param rect   from hexFillRect
 * @param waves  how many crests across the cell
 * → an SVG path `d` string, or '' when there is nothing to draw
 */
export function hexFillWavePath(rect, waves = 2) {
  const { x, y, width: w, height: h } = rect || {};
  if (!(h > 0) || !(w > 0)) return '';
  const bottom = round(y + h);
  const amp = round(Math.min(3, h / 3));
  if (h >= w * 1.2 || amp <= 0) {
    return `M${x},${y}H${round(x + w)}V${bottom}H${x}Z`;
  }
  const seg = w / (waves * 2);
  let d = `M${x},${y}`;
  for (let k = 0; k < waves * 2; k++) {
    const cx = round(x + seg * k + seg / 2);
    const cy = round(y + (k % 2 === 0 ? -amp : amp));
    d += `Q${cx},${cy} ${round(x + seg * (k + 1))},${y}`;
  }
  return `${d}V${bottom}H${x}Z`;
}
