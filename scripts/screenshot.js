#!/usr/bin/env node
// ============================================
// Oracle Party — Screenshot Helper
// Takes a screenshot of any page at mobile viewport (375px).
// Usage: node scripts/screenshot.js [page] [--width=N] [--height=N] [--full]
//   page:    HTML file name without extension (default: "index")
//   --width: viewport width in px (default: 375)
//   --height: viewport height in px (default: 812)
//   --full:  capture full page scroll (not just viewport)
// Output: /tmp/screenshot-<page>.png
// ============================================

import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.ico': 'image/x-icon',
};

// Parse args
const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of args) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v ?? true;
  } else {
    positional.push(a);
  }
}

const page = positional[0] || 'index';
const width = parseInt(flags.width) || 375;
const height = parseInt(flags.height) || 812;
const fullPage = flags.full === true;
const ROOT = join(import.meta.dirname, '..');

// Simple static file server
function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = new URL(req.url, 'http://localhost').pathname;
      let filePath = join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      try {
        const data = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function main() {
  const { server, port } = await startServer();
  const url = `http://127.0.0.1:${port}/${page}.html`;
  const outPath = `/tmp/screenshot-${page}.png`;

  // Use pre-installed Chromium binary
  const executablePath = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2, // Retina-quality for detail
  });
  const p = await context.newPage();

  // Suppress external resource errors (Supabase, Google Fonts, etc.)
  p.on('pageerror', () => {});
  p.on('requestfailed', () => {});

  // Block external requests (Supabase, Google Fonts, analytics) — they hang in sandboxed envs
  await p.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(`http://127.0.0.1:${port}`)) {
      route.continue();
    } else {
      route.abort();
    }
  });

  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 });

  // Force body visible and show target screen (pages use opacity:0 + display:none by default)
  const screen = flags.screen || null;
  await p.evaluate((screenId) => {
    document.body.style.opacity = '1';
    if (screenId) {
      // Hide all screens, show target
      document.querySelectorAll('.screen').forEach(s => {
        s.style.display = 'none';
        s.classList.remove('active');
      });
      const target = document.getElementById(screenId);
      if (target) {
        target.style.display = 'flex';
        target.classList.add('active');
      }
    } else {
      // Show first screen with .active class, or first .screen
      const active = document.querySelector('.screen.active') || document.querySelector('.screen');
      if (active) active.style.display = 'flex';
    }
  }, screen);

  // Brief pause for CSS transitions to settle
  await p.waitForTimeout(300);

  await p.screenshot({ path: outPath, fullPage });
  console.log(outPath);

  await browser.close();
  server.close();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
