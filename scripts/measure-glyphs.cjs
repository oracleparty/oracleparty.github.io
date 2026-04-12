// ============================================
// Hieroglyph Ink Bounds Measurement Tool
// Uses canvas to measure actual rendered ink bounds for each glyph
// at the exact font-size and card dimensions used in production.
//
// Key measurements:
//  - Ink top / bottom / left / right (actual rendered pixels)
//  - Element box top / bottom (based on CSS line-height: 1)
//  - Overflow above/below card boundaries at various card heights
//
// Card geometry (375px viewport, 2-col grid):
//   viewport:     375px
//   page padding: 2 * var(--space-lg) = 2 * 24px = 48px  (left+right)
//   grid gap:     var(--space-md) = 16px
//   card border:  1.5px each side = 3px per card
//   card count:   2 columns
//
//   available width = 375 - 48 = 327px
//   total gap = 16px (one gap between 2 cols)
//   card border-box width = (327 - 16) / 2 = 155.5px
//   card padding: 16px left + 16px right (--space-md)
//   card border: 1.5px each side
//   card padding-box width = 155.5 - 3 = 152.5px
//   card content-box width = 152.5 - 32 = 120.5px   ← cqi reference
//
// NOTE: The CSS comment says 123.5px but actual math gives 120.5px
// We'll test both and see which matches the calibration.
// ============================================

const { createCanvas, registerFont } = require('canvas');
const path = require('path');
const fs = require('fs');

const FONT_PATH = path.join(__dirname, '../fonts/hieroglyphs.woff2');
registerFont(FONT_PATH, { family: 'Hieroglyphs' });

// ---------- CARD GEOMETRY ----------
// Two possible content-box widths based on different interpretations
const CARD_BORDER_BOX_WIDTH = 155.5;  // calibrated
const CARD_PADDING_H = 32;            // 16px each side (--space-md = 1rem = 16px)
const CARD_BORDER = 3;                // 1.5px each side
const CARD_PADDING_BOX_WIDTH = CARD_BORDER_BOX_WIDTH - CARD_BORDER;  // 152.5px
const CARD_CONTENT_BOX_WIDTH = CARD_PADDING_BOX_WIDTH - CARD_PADDING_H;  // 120.5px

// The CSS comment says 123.5px, suggesting border might not be subtracted or padding is different
const CARD_CONTENT_BOX_ALT = 123.5;  // per CSS comment

// Typical card heights (padding-box) - we'll measure at several
const CARD_HEIGHT_MIN = 115;
const CARD_HEIGHT_MED = 130;
const CARD_HEIGHT_MAX = 150;

// ---------- GLYPH DATA ----------
// [char, cqi_size, bottom_cqi, left_pct, right_pct, transform_x_pct, category]
// bottom_cqi: 0 means bottom:0, positive means offset up in cqi
// left_pct: null means use 50% (centered), or specific % value
// right_pct: null means use left_pct, or specific % value (overrides left)
// transform_x_pct: -50 means translateX(-50%), 0 means no transform

const GLYPHS = [
  { char: '𓋹', cqi: 109, bottom: 0,    left: 50,   right: null, tx: -50, label: 'Ankh (History)' },
  { char: '𓂀', cqi: 103, bottom: 0,    left: 50,   right: null, tx: -50, label: 'Eye (Science)' },
  { char: '𓅃', cqi: 103, bottom: 0,    left: 50,   right: null, tx: -50, label: 'Falcon (Nature)' },
  { char: '𓅝', cqi: 126, bottom: 0,    left: -2,   right: null, tx:   0, label: 'Ibis (Arts&Lit)' },
  { char: '𓀭', cqi: 126, bottom: 0,    left: null, right: -4,   tx:   0, label: 'Pharaoh (Culture)' },
  { char: '𓇼', cqi: 106, bottom: 24.3, left: 50,   right: null, tx: -50, label: 'Star (PopCulture)' },
  { char: '𓈉', cqi:  93, bottom:  8.9, left: 50,   right: null, tx: -50, label: 'Land (Geography)' },
  { char: '𓊝', cqi: 108, bottom:  3.2, left: 50,   right: null, tx: -50, label: 'Tool (Technology)' },
  { char: '𓃗', cqi: 101, bottom:  2.4, left: 50,   right: null, tx: -50, label: 'Bull (Sports)' },
  { char: '𓎿', cqi: 113, bottom:  0,   left: 50,   right: null, tx: -50, label: 'Vase (Food)' },
  { char: '𓃻', cqi:  92, bottom: 20.2, left: null, right: -3,   tx:   0, label: 'Man (Logic)' },
  { char: '𓆣', cqi:  93, bottom: 20.2, left: 50,   right: null, tx: -50, label: 'Scarab (WildCard)' },
];

// ---------- MEASUREMENT ----------
function measureGlyph(g, contentBoxWidth, cardHeight) {
  const cqiPx = contentBoxWidth / 100;
  const fontSize = g.cqi * cqiPx;

  // Canvas must be large enough to render glyph without clipping
  const canvasSize = Math.ceil(fontSize * 3);
  const canvas = createCanvas(canvasSize, canvasSize);
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, canvasSize, canvasSize);
  ctx.font = `${fontSize}px Hieroglyphs`;
  ctx.fillStyle = 'black';

  // Draw glyph centered in canvas for measurement
  const cx = canvasSize / 2;
  const cy = canvasSize / 2;
  ctx.fillText(g.char, cx, cy);

  // Scan pixels to find ink bounds
  const imgData = ctx.getImageData(0, 0, canvasSize, canvasSize);
  const data = imgData.data;

  let inkTop = canvasSize, inkBottom = 0, inkLeft = canvasSize, inkRight = 0;
  for (let y = 0; y < canvasSize; y++) {
    for (let x = 0; x < canvasSize; x++) {
      const a = data[(y * canvasSize + x) * 4 + 3];
      if (a > 8) {  // threshold to avoid antialiasing noise
        if (y < inkTop) inkTop = y;
        if (y > inkBottom) inkBottom = y;
        if (x < inkLeft) inkLeft = x;
        if (x > inkRight) inkRight = x;
      }
    }
  }

  if (inkTop > inkBottom) {
    // No ink found
    return null;
  }

  // Ink dimensions relative to draw point (cx, cy = baseline)
  // Canvas fillText draws at (x, y) where y is the baseline
  const inkAboveBaseline = cy - inkTop;   // positive = above baseline
  const inkBelowBaseline = inkBottom - cy; // positive = below baseline
  const inkWidth = inkRight - inkLeft + 1;
  const inkHeight = inkBottom - inkTop + 1;

  // Also get text metrics for comparison
  const metrics = ctx.measureText(g.char);

  return {
    fontSize,
    inkAboveBaseline,
    inkBelowBaseline,
    inkWidth,
    inkHeight,
    inkWidthVsEm: (inkWidth / fontSize * 100).toFixed(1),
    inkHeightVsEm: (inkHeight / fontSize * 100).toFixed(1),
    // Canvas built-in metrics (if available)
    metricsActualBoundingBoxAscent: metrics.actualBoundingBoxAscent,
    metricsActualBoundingBoxDescent: metrics.actualBoundingBoxDescent,
    metricsActualBoundingBoxLeft: metrics.actualBoundingBoxLeft,
    metricsActualBoundingBoxRight: metrics.actualBoundingBoxRight,
  };
}

function checkClipping(g, contentBoxWidth, paddingBoxWidth, cardHeight) {
  const cqiPx = contentBoxWidth / 100;
  const fontSize = g.cqi * cqiPx;
  const bottomOffset = g.bottom * cqiPx; // in px

  // Element (CSS line box) dimensions
  // line-height: 1 → element height = fontSize
  const elementHeight = fontSize;

  // Positioning: element bottom edge is at (cardHeight - bottomOffset) from card top
  // (since bottom: Xpx means the element's bottom is X from the containing block's bottom)
  const elementBottom = cardHeight - bottomOffset;  // from top of card (padding box)
  const elementTop = elementBottom - elementHeight;

  // Clip boundaries are the card's padding box: 0 to cardHeight (top to bottom)
  const clipTop = 0;
  const clipBottom = cardHeight;

  // Horizontal positioning
  let elementLeft;
  if (g.right !== null) {
    // right: X% — position from right edge
    const rightOffset = (g.right / 100) * paddingBoxWidth;
    elementLeft = paddingBoxWidth - rightOffset - fontSize; // approximate (assumes advance width ≈ fontSize)
  } else {
    // left: X% with transform
    const leftPct = (g.left / 100) * paddingBoxWidth;
    elementLeft = leftPct + (g.tx / 100) * fontSize;
  }

  const clipLeft = 0;
  const clipRight = paddingBoxWidth;

  // Vertical clip analysis
  const topClip = Math.max(0, clipTop - elementTop);      // how much clips at top
  const bottomClip = Math.max(0, elementBottom - clipBottom); // how much clips at bottom

  // Horizontal clip analysis
  const leftClip = Math.max(0, clipLeft - elementLeft);
  const rightClip = Math.max(0, (elementLeft + fontSize) - clipRight);

  return {
    fontSize: fontSize.toFixed(1),
    elementTop: elementTop.toFixed(1),
    elementBottom: elementBottom.toFixed(1),
    topClip: topClip.toFixed(1),
    bottomClip: bottomClip.toFixed(1),
    leftClip: leftClip.toFixed(1),
    rightClip: rightClip.toFixed(1),
    // Does actual INK clip? (need measurement data for this)
  };
}

// ---------- MAIN ----------
console.log('='.repeat(80));
console.log('ORACLE PARTY — HIEROGLYPH INK BOUNDS ANALYSIS');
console.log('='.repeat(80));
console.log();
console.log(`Card geometry at 375px viewport:`);
console.log(`  Border-box width:  ${CARD_BORDER_BOX_WIDTH}px`);
console.log(`  Padding-box width: ${CARD_PADDING_BOX_WIDTH}px`);
console.log(`  Content-box width: ${CARD_CONTENT_BOX_WIDTH}px  (actual math: 120.5px)`);
console.log(`  CSS comment says:  ${CARD_CONTENT_BOX_ALT}px`);
console.log(`  cqi 1% =           ${(CARD_CONTENT_BOX_WIDTH/100).toFixed(3)}px (actual) or ${(CARD_CONTENT_BOX_ALT/100).toFixed(3)}px (comment)`);
console.log();

// Test at BOTH content box widths
for (const [label, cw] of [['ACTUAL (120.5px)', CARD_CONTENT_BOX_WIDTH], ['CSS COMMENT (123.5px)', CARD_CONTENT_BOX_ALT]]) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`USING CONTENT BOX: ${label}`);
  console.log(`${'='.repeat(60)}\n`);

  console.log(`${'Glyph'.padEnd(26)} ${'FS(px)'.padStart(7)} ${'InkH(px)'.padStart(9)} ${'InkH%em'.padStart(8)} ${'InkW%em'.padStart(8)} ${'AboveBase'.padStart(10)} ${'BelowBase'.padStart(10)}`);
  console.log('-'.repeat(82));

  for (const g of GLYPHS) {
    const m = measureGlyph(g, cw, CARD_HEIGHT_MED);
    if (!m) {
      console.log(`${g.label.padEnd(26)} MEASUREMENT FAILED`);
      continue;
    }

    const line = [
      g.label.padEnd(26),
      m.fontSize.toFixed(1).padStart(7),
      m.inkHeight.toFixed(0).padStart(9),
      (m.inkHeightVsEm + '%').padStart(8),
      (m.inkWidthVsEm + '%').padStart(8),
      m.inkAboveBaseline.toFixed(1).padStart(10),
      m.inkBelowBaseline.toFixed(1).padStart(10),
    ].join(' ');
    console.log(line);
  }

  // Canvas text metrics comparison
  console.log();
  console.log(`${'Glyph'.padEnd(26)} ${'Ascent(px)'.padStart(11)} ${'Descent(px)'.padStart(12)} ${'Width(px)'.padStart(10)}`);
  console.log('-'.repeat(62));

  for (const g of GLYPHS) {
    const m = measureGlyph(g, cw, CARD_HEIGHT_MED);
    if (!m) continue;
    console.log([
      g.label.padEnd(26),
      m.metricsActualBoundingBoxAscent.toFixed(1).padStart(11),
      m.metricsActualBoundingBoxDescent.toFixed(1).padStart(12),
      m.metricsActualBoundingBoxRight.toFixed(1).padStart(10),
    ].join(' '));
  }
}

// ---------- CLIPPING ANALYSIS ----------
console.log('\n' + '='.repeat(80));
console.log('CLIPPING ANALYSIS — CSS LINE BOX vs CARD BOUNDARIES');
console.log('(Does the CSS line box itself get clipped? Ink may clip even more.)');
console.log('='.repeat(80));

const CW = CARD_CONTENT_BOX_WIDTH;  // use actual
const PW = CARD_PADDING_BOX_WIDTH;

for (const cardH of [CARD_HEIGHT_MIN, CARD_HEIGHT_MED, CARD_HEIGHT_MAX]) {
  console.log(`\n--- Card padding-box height: ${cardH}px ---\n`);
  console.log(`${'Glyph'.padEnd(26)} ${'FS(px)'.padStart(7)} ${'ElemTop'.padStart(8)} ${'ElemBot'.padStart(8)} ${'TopClip'.padStart(8)} ${'BotClip'.padStart(8)} ${'LClip'.padStart(7)} ${'RClip'.padStart(7)}`);
  console.log('-'.repeat(83));

  for (const g of GLYPHS) {
    const c = checkClipping(g, CW, PW, cardH);
    const hasIssue = parseFloat(c.topClip) > 0 || parseFloat(c.bottomClip) > 0 || parseFloat(c.leftClip) > 0 || parseFloat(c.rightClip) > 0;
    const flag = hasIssue ? ' *** CLIPS ***' : '';

    const line = [
      g.label.padEnd(26),
      c.fontSize.padStart(7),
      c.elementTop.padStart(8),
      c.elementBottom.padStart(8),
      c.topClip.padStart(8),
      c.bottomClip.padStart(8),
      c.leftClip.padStart(7),
      c.rightClip.padStart(7),
    ].join(' ') + flag;
    console.log(line);
  }
}

// ---------- INK-ADJUSTED ANALYSIS ----------
console.log('\n' + '='.repeat(80));
console.log('INK-ADJUSTED CLIPPING — ACTUAL INK vs CARD BOUNDARIES');
console.log('This uses measureText actualBoundingBox which reflects real ink bounds.');
console.log('='.repeat(80));

const CARD_H = CARD_HEIGHT_MED;

console.log(`\n--- Card padding-box height: ${CARD_H}px --- Content box: ${CW}px ---\n`);
console.log(`${'Glyph'.padEnd(26)} ${'FS(px)'.padStart(7)} ${'InkAsc'.padStart(8)} ${'InkDesc'.padStart(9)} ${'ElemTop'.padStart(8)} ${'TopClip'.padStart(8)} ${'DescClip'.padStart(9)} STATUS`);
console.log('-'.repeat(92));

for (const g of GLYPHS) {
  const m = measureGlyph(g, CW, CARD_H);
  if (!m) continue;

  const cqiPx = CW / 100;
  const fontSize = g.cqi * cqiPx;
  const bottomOffset = g.bottom * cqiPx;

  // Element bottom = card bottom - bottomOffset
  // baseline (where fillText y is placed) = element bottom - descent (per font metrics)
  // With position:absolute bottom:X, the element bottom edge = cardHeight - X from top
  const elementBottom = CARD_H - bottomOffset;  // px from top of card (padding box)
  const elementTop = elementBottom - fontSize;   // CSS element top (line-height:1)

  // Actual ink top = baseline - actualBoundingBoxAscent
  // baseline position = where bottom: X places it
  // For CSS, the "bottom" of an inline element aligns the element box (line box) bottom
  // The line box bottom is at the descender line = baseline + descent
  // So baseline = elementBottom - actualFontDescent
  // But for line-height:1, the line box = exactly the em square
  // The em square baseline position within the em square depends on font metrics
  //   ascender + descender = em = fontSize
  //   baseline from top of em = ascender
  //   baseline from bottom of em = descender

  // Using canvas measureText:
  const asc = m.metricsActualBoundingBoxAscent;   // ink above baseline
  const desc = m.metricsActualBoundingBoxDescent;  // ink below baseline

  // The element box (line-height:1) = fontSize px tall
  // CSS places element box with bottom at (cardHeight - bottomOffset) from top
  // So element bottom = CARD_H - bottomOffset (from top)
  // Element top = element bottom - fontSize

  // Baseline position within the element depends on font metrics:
  // For the font, the em square has some ascender ratio
  // Typical: ascender = 0.8em, descender = 0.2em (but varies wildly)
  // We can use canvas measureText for more precise estimates:
  // metrics.fontBoundingBoxAscent = ascent above baseline to top of line box
  // metrics.fontBoundingBoxDescent = descent below baseline to bottom of line box

  const canvas2 = createCanvas(10, 10);
  const ctx2 = canvas2.getContext('2d');
  ctx2.font = `${fontSize}px Hieroglyphs`;
  const m2 = ctx2.measureText(g.char);

  const lineBoxAscent = m2.fontBoundingBoxAscent;    // baseline to top of line box
  const lineBoxDescent = m2.fontBoundingBoxDescent;  // baseline to bottom of line box

  // Baseline from bottom of element = lineBoxDescent
  const baselineFromElemBottom = lineBoxDescent;
  const baselineFromCardTop = elementBottom - baselineFromElemBottom;

  // Actual ink bounds
  const inkTop = baselineFromCardTop - asc;          // ink top from card top
  const inkBottom = baselineFromCardTop + desc;      // ink bottom from card top

  const topClip = Math.max(0, -inkTop);              // clips at top if inkTop < 0
  const bottomClip = Math.max(0, inkBottom - CARD_H); // clips at bottom if inkBottom > cardH

  const hasIssue = topClip > 0.5 || bottomClip > 0.5;
  const status = hasIssue ? `CLIPS (top:${topClip.toFixed(1)} bot:${bottomClip.toFixed(1)})` : 'OK';

  const line = [
    g.label.padEnd(26),
    fontSize.toFixed(1).padStart(7),
    asc.toFixed(1).padStart(8),
    desc.toFixed(1).padStart(9),
    elementTop.toFixed(1).padStart(8),
    topClip.toFixed(1).padStart(8),
    bottomClip.toFixed(1).padStart(9),
    status,
  ].join(' ');
  console.log(line);
}

// ---------- FONT METRICS ----------
console.log('\n' + '='.repeat(80));
console.log('FONT LINE BOX METRICS (fontBoundingBox vs actualBoundingBox)');
console.log('='.repeat(80));
console.log();
console.log(`${'Glyph'.padEnd(26)} ${'FS(px)'.padStart(7)} ${'LBAsc'.padStart(7)} ${'LBDesc'.padStart(7)} ${'LBTotal'.padStart(8)} ${'ABAsc'.padStart(7)} ${'ABDesc'.padStart(7)} ${'ABTotal'.padStart(8)} ${'Ratio'.padStart(7)}`);
console.log('-'.repeat(82));

for (const g of GLYPHS) {
  const cqiPx = CW / 100;
  const fontSize = g.cqi * cqiPx;

  const canvas = createCanvas(10, 10);
  const ctx = canvas.getContext('2d');
  ctx.font = `${fontSize}px Hieroglyphs`;
  const m = ctx.measureText(g.char);

  const lbTotal = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  const abTotal = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
  const ratio = (abTotal / fontSize * 100).toFixed(1);

  console.log([
    g.label.padEnd(26),
    fontSize.toFixed(1).padStart(7),
    m.fontBoundingBoxAscent.toFixed(1).padStart(7),
    m.fontBoundingBoxDescent.toFixed(1).padStart(7),
    lbTotal.toFixed(1).padStart(8),
    m.actualBoundingBoxAscent.toFixed(1).padStart(7),
    m.actualBoundingBoxDescent.toFixed(1).padStart(7),
    abTotal.toFixed(1).padStart(8),
    (ratio + '%').padStart(7),
  ].join(' '));
}

console.log('\nLBAsc/Desc = fontBoundingBox (line box from baseline) for this font');
console.log('ABAsc/Desc = actualBoundingBox (real ink from baseline)');
console.log('Ratio = actual ink height as % of font-size (em square)');
