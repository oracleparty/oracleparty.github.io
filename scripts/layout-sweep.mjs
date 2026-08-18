// ============================================
// Oracle Party — layout sweep
//
// Renders every mock state at both phone widths and reports layout faults that
// nothing else in this project can see.
//
// WHY THIS EXISTS
//
// A signed-in player promoted to co-host overflowed their lobby row by up to
// 71px, and the whole page became draggable sideways on a phone. It reached a
// live game because:
//
//   - unit tests never render anything;
//   - the robot playtests sign in as nobody, so they have no tier badge, no
//     title and no stats, and the row that broke needs a tier badge to break;
//   - screenshot.js renders these same states but only produces images, and an
//     overflow of 30px does not look wrong in a thumbnail.
//
// So the fault was invisible to every check while being obvious in the hand.
// This script measures instead of looking:
//
//   OVERFLOW  an element extends past the viewport, or a container is
//             horizontally scrollable. Either one lets a phone drag the page
//             sideways, which always reads as broken.
//   RAGGED    rows in one list disagree about their height. The owner asked
//             for uniformity explicitly; a list that shifts by 6px between
//             rows looks unfinished.
//   CLIPPED   text is truncated by its container. Sometimes intended (a long
//             title with an ellipsis), so it is reported separately and
//             judged, never failed on automatically.
//   UNREADABLE text whose colour has less than 3:1 contrast against what it
//             actually sits on. Every state runs in all three themes, because
//             a colour can survive on white and vanish on black — CLAUDE.md
//             has always required checking light, dark and OLED, and nothing
//             enforced it. The bar is deliberately below WCAG's 4.5: this is
//             looking for text that has effectively disappeared, not auditing
//             accessibility, and a stricter bar would flag every muted caption
//             until nobody read the report.
//
// STRESS MODE (--stress) lengthens visible text in place before measuring, on
// the theory that a layout which only fits its mock data is one real display
// name away from breaking. This is how the co-host bug SHOULD have been caught.
//
// Usage:
//   node scripts/layout-sweep.mjs                 # all states, both widths
//   node scripts/layout-sweep.mjs --stress        # with lengthened text
//   node scripts/layout-sweep.mjs --state=lobby-waiting
//   node scripts/layout-sweep.mjs --widths=375,430,320
//   node scripts/layout-sweep.mjs --themes=dark
// ============================================

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATES } from './mock-states.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const flags = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) flags[m[1]] = m[2] ?? true;
}
const WIDTHS = (flags.widths || '375,430').split(',').map(Number);
const STRESS = !!flags.stress;
// CLAUDE.md requires checking light, dark and OLED for any visual change, and
// nothing enforced it. Unreadable text is the failure these themes actually
// produce — a colour that survives on white and vanishes on black.
const THEMES = (flags.themes || 'light,dark,oled').split(',');

// Long but genuinely plausible. A display name is capped at what the app
// allows, so this is not an unfair test — it is the worst real input.
const STRESS_TEXT = {
  name: 'Bartholomew Kensington',
  title: 'Keeper of Forgotten Secrets',
  answer: 'the second battle of ypres in belgium',
};

function startServer() {
  return new Promise(resolve => {
    const server = createServer(async (req, res) => {
      const urlPath = new URL(req.url, 'http://localhost').pathname;
      const filePath = join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      try {
        const data = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// Runs in the page. Returns every measurable layout fault on the current screen.
function measure(stressText) {
  const vw = document.documentElement.clientWidth;
  const out = { vw, overflow: [], scrollers: [], ragged: [], clipped: [], unstyled: [], contrast: [] };

  // Every class name the stylesheet actually defines. Used to catch a mock
  // that has drifted away from the app it claims to preview.
  //
  // scripts/mock-states.js rendered `.player-row` for the lobby while the app
  // renders `.player-item`, and `.player-row` has no CSS whatsoever. So
  // screenshot.js — the tool this project tells every session to trust before
  // pushing a UI change — was reviewing unstyled markup that has never shipped.
  // The co-host row that overflowed in a real game looked perfect in review,
  // because review was not looking at the lobby.
  const styled = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }  // cross-origin
    const walk = list => {
      for (const rule of list) {
        if (rule.selectorText) {
          for (const c of rule.selectorText.match(/\.[-_a-zA-Z0-9]+/g) || []) styled.add(c.slice(1));
        }
        if (rule.cssRules) walk(rule.cssRules);
      }
    };
    walk(rules);
  }

  const describe = el => {
    const cls = (el.className || '').toString().trim().split(/\s+/).slice(0, 3).join('.');
    const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 26);
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}${txt ? ` "${txt}"` : ''}`;
  };
  const visible = el => {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
    const b = el.getBoundingClientRect();
    return b.width > 0 || b.height > 0;
  };

  // Only look inside the screen that is actually showing. Hidden screens are
  // laid out too, and reporting them buries the real finding in noise.
  const root = document.querySelector('.screen.active')
    || document.querySelector('.modal-overlay:not([style*="display: none"])')
    || document.body;

  const seenUnstyled = new Set();
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el)) continue;

    // A class with no rule anywhere in the stylesheet is markup nothing styles.
    // In a mock that means the preview has drifted from the app.
    for (const c of el.classList) {
      if (!styled.has(c) && !seenUnstyled.has(c)) {
        seenUnstyled.add(c);
        out.unstyled.push(`.${c} on <${el.tagName.toLowerCase()}> has no CSS rule anywhere`);
      }
    }

    const b = el.getBoundingClientRect();
    if (b.right > vw + 0.5 || b.left < -0.5) {
      // Only report it if nothing above it clips. The home screen scatters
      // decorative glyphs at up to left:96%, and some of them naturally hang
      // past the right edge — but .home__glyphs is overflow:hidden, so they are
      // trimmed rather than dragged. Reporting them made the sweep fail at
      // random, since the positions are random, and a check that fails by
      // coin-flip is one people learn to re-run rather than read.
      let clippedByAncestor = false;
      for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox === 'hidden' || ox === 'clip' || ox === 'auto' || ox === 'scroll') { clippedByAncestor = true; break; }
      }
      if (!clippedByAncestor) {
        out.overflow.push(`${describe(el)} L=${b.left.toFixed(0)} R=${b.right.toFixed(0)} (viewport ${vw})`);
      }
    }
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      const st = getComputedStyle(el);
      // Only overflow-x auto/scroll can actually be dragged. `hidden` clips,
      // and `visible` simply lets the child stick out — and if that child
      // reaches past the viewport it is already caught by the check above.
      //
      // Reporting every visible-overflow box flagged each hieroglyph watermark
      // (deliberately drawn larger than its box) as a fault. A sweep that
      // reports known-good decoration alongside real bugs is one nobody reads.
      if (st.overflowX === 'auto' || st.overflowX === 'scroll') {
        out.scrollers.push(`${describe(el)} scrollW=${el.scrollWidth} clientW=${el.clientWidth} overflow-x=${st.overflowX}`);
      } else if (st.overflowX === 'hidden') {
        out.clipped.push(`${describe(el)} scrollW=${el.scrollWidth} clientW=${el.clientWidth}`);
      }
    }
  }

  // ---- CONTRAST ----
  //
  // Text the theme has made unreadable. Three palettes means a colour can look
  // right on one background and disappear on another, and nothing checked it.
  //
  // The threshold is 3.0, well below WCAG's 4.5 for body text. That is
  // deliberate: this is looking for text that is effectively invisible, not
  // auditing accessibility. A stricter bar would flag every deliberately muted
  // caption and the report would stop being read.
  const parseRgb = str => {
    const m = (str || '').match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map(x => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const effectiveBg = el => {
    for (let a = el; a; a = a.parentElement) {
      const c = parseRgb(getComputedStyle(a).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const seenContrast = new Set();
  for (const el of root.querySelectorAll('*')) {
    if (!visible(el)) continue;
    // Leaf text only — a wrapper's textContent is its children's.
    if ([...el.children].some(c => (c.textContent || '').trim())) continue;
    const text = (el.textContent || '').trim();
    if (!text) continue;
    // Emoji carry their own colours; the CSS `color` does not apply to them, so
    // measuring it is meaningless. Avatars are an emoji on a coloured circle and
    // were reported as unreadable on that basis alone.
    if (/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D\s]+$/u.test(text)) continue;

    const st = getComputedStyle(el);
    // Decoration is deliberately faint: the home screen's drifting glyphs sit
    // at opacity 0.12 by design. Judging them as unreadable text is wrong.
    if (parseFloat(st.opacity) < 0.5) continue;
    let faded = false;
    for (let a = el; a; a = a.parentElement) {
      if (parseFloat(getComputedStyle(a).opacity) < 0.5) { faded = true; break; }
    }
    if (faded) continue;

    const fg = parseRgb(st.color);
    if (!fg || fg.a < 0.5) continue;
    const bg = effectiveBg(el);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    if (ratio < 3.0) {
      const key = `${el.className}|${st.color}`;
      if (seenContrast.has(key)) continue;
      seenContrast.add(key);
      out.contrast.push(`${describe(el)} ratio=${ratio.toFixed(2)} color=${st.color} on ${st.backgroundColor === 'rgba(0, 0, 0, 0)' ? 'inherited' : st.backgroundColor}`);
    }
  }

  // Ragged rows: sibling rows of the same class that disagree on height.
  // The element that DIRECTLY contains the rows. Pointing these at the section
  // wrappers (.lobby-players rather than #player-list) compared a section title
  // against a list container and reported a 221px "fault" that meant nothing.
  const ROW_GROUPS = [
    '#player-list', '#host-list', '#reveal-answers',
    '#scores-animated-list', '#results-list', '#fw-player-list', '.category-grid',
  ];
  for (const sel of ROW_GROUPS) {
    for (const list of document.querySelectorAll(sel)) {
      if (!visible(list)) continue;
      const kids = [...list.children].filter(visible);
      if (kids.length < 2) continue;

      // Compare only items on the SAME visual row. A category grid puts three
      // cards per row and each row sizes to its own tallest card, so comparing
      // every card to every other reported a 5px "fault" that is just two rows
      // of different heights sitting one above the other.
      // Bucket by top with a tolerance. Rounding to the exact pixel split two
      // grid cards sitting side by side into separate "rows" whenever their
      // tops differed by a fraction, which then made a 2-column grid look like
      // a 1-column list and reported the difference between two rows as
      // raggedness within one.
      const byRow = new Map();
      for (const k of kids) {
        const b = k.getBoundingClientRect();
        let key = [...byRow.keys()].find(t => Math.abs(t - b.top) <= 4);
        if (key === undefined) { key = b.top; byRow.set(key, []); }
        byRow.get(key).push(Math.round(b.height));
      }
      for (const [, heights] of byRow) {
        if (heights.length < 2) continue;
        const min = Math.min(...heights), max = Math.max(...heights);
        // 1px is sub-pixel rounding, not raggedness.
        if (max - min > 1) {
          out.ragged.push(`${sel} items side by side differ by ${max - min}px: [${heights.join(', ')}]`);
        }
      }

      // A stacked list (one item per row) should still be uniform top to
      // bottom — that is what the owner means by the list looking even.
      const stacked = [...byRow.values()].every(h => h.length === 1);
      if (stacked && byRow.size > 1) {
        const heights = [...byRow.values()].map(h => h[0]);
        const min = Math.min(...heights), max = Math.max(...heights);
        if (max - min > 1) {
          out.ragged.push(`${sel} stacked rows differ by ${max - min}px: [${heights.join(', ')}]`);
        }
      }
    }
  }
  return out;
}

// Lengthen visible text in place. Deliberately targets the fields a real
// account fills in and a mock does not.
function applyStress(stressText) {
  const setText = (sel, value) => {
    for (const el of document.querySelectorAll(sel)) {
      if (el.children.length === 0) el.textContent = value;
    }
  };
  setText('.player-item__name', stressText.name);
  setText('.player-title', stressText.title);
  setText('.answer-row__name', stressText.name);
  setText('.score-anim-row__name', stressText.name);
  setText('.results-row__name', stressText.name);
  setText('.fw-player-row__name', stressText.name);
  setText('.answer-row__answer', stressText.answer);
}

const { server, port } = await startServer();
const browser = await chromium.launch({
  executablePath: existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
});

// watermark-all exists to calibrate hieroglyph watermarks, not to be played.
// Its cards differ by a few pixels because different glyphs have different ink
// bounds, which is the whole point of the state — and glyph metrics are a
// documented cul-de-sac in CLAUDE.md. Excluded deliberately, not hidden:
// run it explicitly with --state=watermark-all to see the numbers.
const SKIP = new Set(['watermark-all']);

const names = flags.state ? [flags.state] : Object.keys(STATES).filter(n => !SKIP.has(n));
if (flags.state && !STATES[flags.state]) {
  console.error(`Unknown state: ${flags.state}\nAvailable: ${Object.keys(STATES).join(', ')}`);
  process.exit(2);
}

console.log('='.repeat(72));
console.log(`LAYOUT SWEEP — ${names.length} state(s) x ${WIDTHS.join('/')}px x ${THEMES.join('/')}${STRESS ? '  [STRESS]' : ''}`);
console.log('='.repeat(72));

let faults = 0;
let clippedCount = 0;
const drift = new Set();

for (const name of names) {
  const state = STATES[name];
  for (const width of WIDTHS) {
   for (const theme of THEMES) {
    const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
    const p = await context.newPage();
    p.on('pageerror', () => {});
    p.on('requestfailed', () => {});
    await p.route('**/*', route =>
      route.request().url().startsWith(`http://127.0.0.1:${port}`) ? route.continue() : route.abort());

    try {
      await p.goto(`http://127.0.0.1:${port}/${state.page}.html`, { waitUntil: 'domcontentloaded', timeout: 8000 });
      await p.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme);
      await p.evaluate((screenId) => {
        document.body.style.opacity = '1';
        document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display = 'none'; });
        if (screenId) {
          document.querySelectorAll('.screen').forEach(s => { s.style.display = 'none'; s.classList.remove('active'); });
          const t = document.getElementById(screenId);
          if (t) { t.style.display = 'flex'; t.classList.add('active'); }
        } else {
          const a = document.querySelector('.screen.active') || document.querySelector('.screen');
          if (a) { a.style.display = 'flex'; a.classList.add('active'); }
        }
      }, state.screen);

      if (state.inherits && STATES[state.inherits]) {
        const base = STATES[state.inherits];
        await p.evaluate(base.inject, base.injectArgs ? base.injectArgs() : undefined);
      }
      if (state.inject) {
        await p.evaluate(state.inject, state.injectArgs ? state.injectArgs() : undefined);
      }
      // Measure only once fonts have settled. A card measured while a font is
      // still swapping is 2px shorter than its neighbour, which showed up as an
      // intermittent "ragged grid" that did not reproduce on a re-run — and a
      // check that fails every third time is one people stop believing.
      await p.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
      await p.waitForTimeout(350);
      if (STRESS) {
        await p.evaluate(applyStress, STRESS_TEXT);
        await p.waitForTimeout(200);
      }

      const r = await p.evaluate(measure, STRESS_TEXT);
      // Unstyled classes are DRIFT, not a layout fault: they say the markup
      // and the stylesheet disagree, which is how the lobby preview came to be
      // fiction, but a leftover modifier is not a broken screen. Counting them
      // as failures would leave this permanently red and therefore ignored.
      const bad = r.overflow.length + r.scrollers.length + r.ragged.length + r.contrast.length;
      clippedCount += r.clipped.length;
      for (const u of r.unstyled) drift.add(`${u}   (first seen: ${name})`);

      if (bad) {
        faults += bad;
        console.log(`\n✗ ${name} @ ${width}px [${theme}]`);
        for (const o of r.overflow.slice(0, 5))  console.log(`    OVERFLOW  ${o}`);
        for (const s of r.scrollers.slice(0, 5)) console.log(`    SCROLLS-X ${s}`);
        for (const g of r.ragged.slice(0, 5))    console.log(`    RAGGED    ${g}`);
        for (const c of r.contrast.slice(0, 5))  console.log(`    UNREADABLE ${c}`);
        if (r.overflow.length > 5) console.log(`    ... and ${r.overflow.length - 5} more overflowing elements`);
        if (r.contrast.length > 5) console.log(`    ... and ${r.contrast.length - 5} more low-contrast elements`);
      }
    } catch (e) {
      faults++;
      console.log(`\n✗ ${name} @ ${width}px [${theme}] — threw: ${e.message.split('\n')[0]}`);
    } finally {
      await context.close();
    }
   }
  }
}

console.log('\n' + '='.repeat(72));
console.log(faults === 0
  ? `No layout faults across ${names.length} state(s).`
  : `${faults} layout fault(s) found.`);
if (drift.size) {
  console.log(`\n${drift.size} class(es) rendered with no CSS rule anywhere —`);
  console.log('either the stylesheet lost them or the markup invented them:');
  for (const d of drift) console.log(`  · ${d}`);
}
if (clippedCount) {
  console.log(`${clippedCount} element(s) clip their content (overflow-x: hidden) — usually deliberate; run with --state to inspect.`);
}
console.log('='.repeat(72));

await browser.close();
server.close();
process.exit(faults ? 1 : 0);
