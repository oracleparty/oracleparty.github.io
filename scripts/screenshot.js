#!/usr/bin/env node
// ============================================
// Oracle Party — Screenshot Helper
// Takes a screenshot of any page at mobile viewport (375px).
//
// Usage:
//   node scripts/screenshot.js [page] [--screen=id] [--width=N] [--height=N] [--full]
//   node scripts/screenshot.js --state=<name>        # Render mock state
//   node scripts/screenshot.js --all                 # Screenshot all mock states
//
// Output: /tmp/screenshot-<name>.png
// ============================================

import { chromium } from 'playwright-core';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname } from 'path';
import { STATES } from './mock-states.js';

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

// Take a single screenshot
async function screenshotPage(browser, port, { page, screen, inject, injectArgs, inherits, outName }) {
  const url = `http://127.0.0.1:${port}/${page}.html`;
  const outPath = `/tmp/screenshot-${outName}.png`;

  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 2,
  });
  const p = await context.newPage();

  p.on('pageerror', () => {});
  p.on('requestfailed', () => {});

  await p.route('**/*', (route) => {
    const reqUrl = route.request().url();
    if (reqUrl.startsWith(`http://127.0.0.1:${port}`)) {
      route.continue();
    } else {
      route.abort();
    }
  });

  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 5000 });

  // Force body visible and show target screen
  await p.evaluate((screenId) => {
    document.body.style.opacity = '1';
    // Hide all modals by default
    document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    if (screenId) {
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
      const active = document.querySelector('.screen.active') || document.querySelector('.screen');
      if (active) active.style.display = 'flex';
    }
  }, screen);

  // Run inherited inject first (for states like reveal-with-fun-fact)
  if (inherits && STATES[inherits]) {
    const base = STATES[inherits];
    const baseArgs = base.injectArgs ? base.injectArgs() : undefined;
    await p.evaluate(base.inject, baseArgs);
  }

  // Run the state's inject function
  if (inject) {
    const injectData = injectArgs ? injectArgs() : undefined;
    await p.evaluate(inject, injectData);
  }

  await p.waitForTimeout(300);
  await p.screenshot({ path: outPath, fullPage });
  await context.close();
  return outPath;
}

async function main() {
  const { server, port } = await startServer();
  const executablePath = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath });

  try {
    if (flags.all) {
      // Screenshot all mock states
      const names = Object.keys(STATES);
      console.log(`Screenshotting ${names.length} states...`);
      for (const name of names) {
        const state = STATES[name];
        const path = await screenshotPage(browser, port, { ...state, outName: name });
        console.log(path);
      }
    } else if (flags.state) {
      // Screenshot a specific mock state
      const state = STATES[flags.state];
      if (!state) {
        console.error(`Unknown state: ${flags.state}\nAvailable: ${Object.keys(STATES).join(', ')}`);
        process.exit(1);
      }
      const path = await screenshotPage(browser, port, { ...state, outName: flags.state });
      console.log(path);
    } else {
      // Legacy mode: screenshot a page directly
      const page = positional[0] || 'index';
      const path = await screenshotPage(browser, port, {
        page,
        screen: flags.screen || null,
        inject: null,
        outName: flags.screen || page,
      });
      console.log(path);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
