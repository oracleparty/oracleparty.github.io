/**
 * Runtime Eye of Horus iris alignment.
 *
 * Renders the glyph to a canvas (browser-native rendering), finds the
 * iris center via ink-bounds + fixed proportions, then positions a
 * canvas-generated image so the iris lands exactly on the emoji center.
 *
 * No font metric math needed — the canvas IS the rendered glyph,
 * and we position the resulting image directly.
 */

const IRIS_REL_X = 0.41;
const IRIS_REL_Y = 0.19;
const FONT_SIZE_CQI = 1.13; // 113cqi = 113% of content box width

export function calibrateEye() {
  document.fonts.ready.then(() => {
    if (!document.fonts.check('16px Hieroglyphs')) {
      const f = new FontFace('Hieroglyphs', 'url(fonts/hieroglyphs.woff2)');
      f.load().then(loaded => { document.fonts.add(loaded); run(); }).catch(() => {});
    } else {
      run();
    }
  });
}

function run() {
  const card = document.querySelector('.category-card[data-category="science"]');
  if (!card) return;
  const iconWrap = card.querySelector('.category-card__icon-wrap');
  if (!iconWrap) return;

  // Emoji center in card coordinates
  const cardRect = card.getBoundingClientRect();
  const iconRect = iconWrap.getBoundingClientRect();
  const emojiCX = iconRect.left + iconRect.width / 2 - cardRect.left;
  const emojiCY = iconRect.top + iconRect.height / 2 - cardRect.top;

  // Card content width for sizing
  const cs = getComputedStyle(card);
  const contentW = cardRect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const fontSize = contentW * FONT_SIZE_CQI;

  // Render glyph to canvas with textBaseline='top' — simplest coordinate system
  const dpr = window.devicePixelRatio || 1;
  const canvasLogicalW = Math.ceil(fontSize * 2);
  const canvasLogicalH = Math.ceil(fontSize * 2);
  const canvas = document.createElement('canvas');
  canvas.width = canvasLogicalW * dpr;
  canvas.height = canvasLogicalH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.font = `${fontSize}px Hieroglyphs`;
  ctx.textBaseline = 'top';

  // Get theme color
  const color = getComputedStyle(document.documentElement)
    .getPropertyValue('--color-primary').trim() || '#C68A2E';
  ctx.fillStyle = color;
  ctx.fillText('\u{13080}', 0, 0);

  // Scan ink bounds in physical pixels
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const px = imgData.data;
  const pw = canvas.width, ph = canvas.height;
  let minX = pw, maxX = 0, minY = ph, maxY = 0;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if (px[(y * pw + x) * 4 + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const inkW = maxX - minX;
  const inkH = maxY - minY;
  if (inkW < 5 || inkH < 5) return;

  // Iris center in LOGICAL pixels (divide physical by dpr)
  const irisCX = (minX + inkW * IRIS_REL_X) / dpr;
  const irisCY = (minY + inkH * IRIS_REL_Y) / dpr;

  // The canvas was drawn with text at (0, 0) with textBaseline='top'.
  // So the image top-left IS the text origin.
  // The iris is at (irisCX, irisCY) logical pixels from the image top-left.
  //
  // Position the image so that point lands on the emoji center:
  //   imageLeft = emojiCX - irisCX
  //   imageTop  = emojiCY - irisCY

  const imgLeft = emojiCX - irisCX;
  const imgTop = emojiCY - irisCY;

  // Theme opacity
  const theme = document.documentElement.dataset.theme;
  const opacity = theme === 'oled' ? 0.22 : theme === 'dark' ? 0.20 : 0.15;

  // Remove any existing calibrated glyph
  const existing = card.querySelector('.eye-glyph');
  if (existing) existing.remove();

  // Inject positioned image
  const el = document.createElement('div');
  el.className = 'eye-glyph';
  el.style.cssText = `
    position: absolute;
    left: ${imgLeft}px;
    top: ${imgTop}px;
    width: ${canvasLogicalW}px;
    height: ${canvasLogicalH}px;
    background-image: url(${canvas.toDataURL()});
    background-size: 100% 100%;
    opacity: ${opacity};
    pointer-events: none;
    z-index: 0;
  `;
  card.appendChild(el);
}
