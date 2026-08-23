// ============================================
// Oracle Party — the shape of what you know
//
// NO IMPORTS, so the geometry is unit-testable in Node. Everything around it
// pulls the Supabase client from esm.sh, which the test runner cannot load.
//
// Twelve categories is close to ideal for a radar, and every one already has an
// emoji — so the axes label themselves and no text has to fit around a circle
// on a 375px phone.
//
// AN UNPLAYED CATEGORY IS NOT A ZERO. "You have never tried Sports" and "you
// are bad at Sports" are different facts, and a radar that draws both at the
// origin says the second about somebody who has done the first. Axes carry
// `hasData`, the polygon spans only the ones that do, and the rest are drawn as
// dim marks — the same rule as every other number in this app.
// ============================================

/** Where the SVG's own coordinate space runs. Rendered size is set in CSS. */
export const RADAR_VIEWBOX = 100;

/**
 * One point per axis, evenly spaced, starting at the top and going clockwise.
 *
 * @param {number} count  how many axes
 * @param {number} value  0..1 along each spoke, or an array of them
 * @param {number} radius distance from the centre at value 1
 * → [{ x, y, angle }]
 */
export function radarPoints(count, value, radius) {
  if (!Number.isFinite(count) || count < 1) return [];
  const c = RADAR_VIEWBOX / 2;
  const values = Array.isArray(value) ? value : null;
  const out = [];
  for (let i = 0; i < count; i++) {
    // -90° so the first axis points straight up rather than right, which is
    // what anybody reading a radar expects.
    const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
    const v = values ? (Number(values[i]) || 0) : (Number(value) || 0);
    const r = Math.max(0, Math.min(1, v)) * radius;
    out.push({ x: c + Math.cos(angle) * r, y: c + Math.sin(angle) * r, angle });
  }
  return out;
}

/** An SVG points attribute from a list of {x, y}. */
export function polygonPoints(points) {
  return (points || []).map(p => `${round(p.x)},${round(p.y)}`).join(' ');
}

const round = n => Math.round(n * 100) / 100;

/**
 * Turn per-category stats into everything the chart needs to draw itself.
 *
 * @param axes  [{ key, label, emoji }] in the order they should appear
 * @param statsByCategory  { [key]: { met, mastered } }
 * → { axes: [{ key, emoji, label, value, met, hasData }], anyData }
 *
 * `value` is proficiency — questions currently got right over questions met.
 * Mastery would be near zero for everybody, because the bank holds 4,859
 * questions, and a chart that is a dot for every player is not a chart.
 */
export function buildRadarAxes(axes, statsByCategory) {
  const built = (axes || []).map(a => {
    const s = (statsByCategory || {})[a.key];
    const met = Number(s?.met) || 0;
    const mastered = Number(s?.mastered) || 0;
    const hasData = met > 0;
    return {
      key: a.key,
      label: a.label,
      emoji: a.emoji,
      met,
      mastered,
      hasData,
      value: hasData ? Math.max(0, Math.min(1, mastered / met)) : 0,
    };
  });
  return { axes: built, anyData: built.some(a => a.hasData) };
}

/**
 * The strongest and weakest categories worth naming.
 *
 * Only categories with at least `minMet` questions met are eligible: one
 * question answered right is not a strength, and calling it one would send
 * somebody to the leaderboard to be disappointed.
 *
 * → { strongest, weakest } — either may be null, and they are never the same
 *   axis unless only one qualifies.
 */
export function radarExtremes(builtAxes, minMet = 5) {
  const eligible = (builtAxes || []).filter(a => a.hasData && a.met >= minMet);
  if (eligible.length === 0) return { strongest: null, weakest: null };
  const sorted = [...eligible].sort((a, b) => b.value - a.value || b.met - a.met);
  return {
    strongest: sorted[0],
    weakest: sorted.length > 1 ? sorted[sorted.length - 1] : null,
  };
}
