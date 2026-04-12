/**
 * Runtime Eye of Horus iris alignment.
 *
 * Renders the glyph to a canvas (browser-native rendering), finds the
 * iris center via ink-bounds + fixed proportions, then positions a
 * canvas-generated image so the iris lands exactly on the emoji center.
 *
 * Works on every browser because each browser renders its own bitmap.
 */

const IRIS_REL_X = 0.476;  // Calibrated on-device via iris-calibrator.html
const IRIS_REL_Y = 0.356;
const FONT_SIZE_CQI = 1.13;

export function calibrateEye() {
  document.fonts.ready.then(() => {
    if (!document.fonts.check('16px Hieroglyphs')) {
      const f = new FontFace('Hieroglyphs', 'url(fonts/hieroglyphs.woff2)');
      f.load().then(loaded => { document.fonts.add(loaded); run(); }).catch(e => {
        if (isDebug()) showDebug({ error: 'Font load failed: ' + e.message });
      });
    } else {
      run();
    }
  });
}

function isDebug() {
  return new URLSearchParams(location.search).has('eye-debug');
}

function showDebug(data) {
  let panel = document.getElementById('eye-debug-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'eye-debug-panel';
    panel.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,0.95);color:#0f0;font:11px/1.4 monospace;padding:8px;max-height:40vh;overflow-y:auto;';
    document.body.appendChild(panel);
  }
  panel.textContent = typeof data === 'string' ? data : JSON.stringify(data, null, 1);
}

function run() {
  const card = document.querySelector('.category-card[data-category="science"]');
  if (!card) {
    if (isDebug()) showDebug('No science card found');
    return;
  }
  const iconWrap = card.querySelector('.category-card__icon-wrap');
  if (!iconWrap) {
    if (isDebug()) showDebug('No icon-wrap found');
    return;
  }

  const cardRect = card.getBoundingClientRect();
  const iconRect = iconWrap.getBoundingClientRect();
  const emojiCX = iconRect.left + iconRect.width / 2 - cardRect.left;
  const emojiCY = iconRect.top + iconRect.height / 2 - cardRect.top;

  const cs = getComputedStyle(card);
  const contentW = cardRect.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const fontSize = contentW * FONT_SIZE_CQI;

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
  if (inkW < 5 || inkH < 5) {
    if (isDebug()) showDebug('Ink bounds too small: ' + inkW + 'x' + inkH + ' (font not rendered?)');
    return;
  }

  // Allow URL overrides for iris proportions: ?rx=0.47&ry=0.25
  const params = new URLSearchParams(location.search);
  const relX = parseFloat(params.get('rx')) || IRIS_REL_X;
  const relY = parseFloat(params.get('ry')) || IRIS_REL_Y;

  // Iris center in LOGICAL pixels
  const irisCX = (minX + inkW * relX) / dpr;
  const irisCY = (minY + inkH * relY) / dpr;

  const imgLeft = emojiCX - irisCX;
  const imgTop = emojiCY - irisCY;

  // Debug mode: draw marker and show values
  if (isDebug()) {
    // Draw iris crosshair on canvas (logical coords since ctx is scaled)
    ctx.globalAlpha = 1;
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(irisCX, irisCY, 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(irisCX - 15, irisCY);
    ctx.lineTo(irisCX + 15, irisCY);
    ctx.moveTo(irisCX, irisCY - 15);
    ctx.lineTo(irisCX, irisCY + 15);
    ctx.stroke();

    showDebug({
      dpr,
      relX, relY,
      emojiCenter: [emojiCX.toFixed(1), emojiCY.toFixed(1)],
      irisCenter: [irisCX.toFixed(1), irisCY.toFixed(1)],
      imgOffset: [imgLeft.toFixed(1), imgTop.toFixed(1)],
      hint: 'Adjust: ?eye-debug&rx=0.50&ry=0.25',
    });
  }

  // Theme opacity
  const theme = document.documentElement.dataset.theme;
  const opacity = theme === 'oled' ? 0.22 : theme === 'dark' ? 0.20 : 0.15;

  // Remove any existing
  const existing = card.querySelector('.eye-glyph');
  if (existing) existing.remove();

  // Inject positioned image
  const el = document.createElement('div');
  el.className = 'eye-glyph';
  const debugBorder = isDebug() ? 'border: 2px solid red;' : '';
  el.style.cssText = `
    position: absolute;
    left: ${imgLeft}px;
    top: ${imgTop}px;
    width: ${canvasLogicalW}px;
    height: ${canvasLogicalH}px;
    background-image: url(${canvas.toDataURL()});
    background-size: 100% 100%;
    opacity: ${isDebug() ? 0.5 : opacity};
    pointer-events: none;
    z-index: 0;
    ${debugBorder}
  `;
  card.appendChild(el);

  // Debug: also show a dot at where we think the emoji center is
  if (isDebug()) {
    const dot = document.createElement('div');
    dot.style.cssText = `position:absolute;left:${emojiCX - 5}px;top:${emojiCY - 5}px;width:10px;height:10px;background:#0f0;border-radius:50%;z-index:99;pointer-events:none;`;
    card.appendChild(dot);
  }
}
