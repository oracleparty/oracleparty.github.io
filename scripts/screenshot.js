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
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'http';
import { readFile, writeFile } from 'fs/promises';
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
const runA11y = flags.a11y === true;
const theme = flags.theme || null; // 'dark' or 'oled'
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

  // Apply theme override if requested
  if (theme) {
    await p.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  }

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

  // Run accessibility scan if requested
  let a11yResults = null;
  if (runA11y) {
    try {
      const results = await new AxeBuilder({ page: p }).analyze();
      a11yResults = results.violations;
    } catch { /* axe may fail on some pages */ }
  }

  await context.close();
  return { path: outPath, a11y: a11yResults };
}

async function main() {
  const { server, port } = await startServer();
  const executablePath = process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
  const browser = await chromium.launch({ executablePath });

  try {
    const allA11y = [];

    if (flags.all) {
      const names = Object.keys(STATES);
      console.log(`Screenshotting ${names.length} states${runA11y ? ' + a11y scan' : ''}...`);
      for (const name of names) {
        const state = STATES[name];
        const { path, a11y } = await screenshotPage(browser, port, { ...state, outName: name });
        console.log(path);
        if (a11y?.length) allA11y.push({ state: name, violations: a11y });
      }
    } else if (flags.state) {
      const state = STATES[flags.state];
      if (!state) {
        console.error(`Unknown state: ${flags.state}\nAvailable: ${Object.keys(STATES).join(', ')}`);
        process.exit(1);
      }
      const { path, a11y } = await screenshotPage(browser, port, { ...state, outName: flags.state });
      console.log(path);
      if (a11y?.length) allA11y.push({ state: flags.state, violations: a11y });
    } else {
      const page = positional[0] || 'index';
      const { path, a11y } = await screenshotPage(browser, port, {
        page,
        screen: flags.screen || null,
        inject: null,
        outName: flags.screen || page,
      });
      console.log(path);
      if (a11y?.length) allA11y.push({ state: page, violations: a11y });
    }

    // Print accessibility summary
    if (runA11y) {
      const outFile = '/tmp/a11y-report.json';
      await writeFile(outFile, JSON.stringify(allA11y, null, 2));
      const total = allA11y.reduce((n, s) => n + s.violations.length, 0);
      console.log(`\nAccessibility: ${total} violation${total !== 1 ? 's' : ''} across ${allA11y.length} state${allA11y.length !== 1 ? 's' : ''}`);
      for (const { state, violations } of allA11y) {
        for (const v of violations) {
          console.log(`  [${state}] ${v.impact}: ${v.id} — ${v.help} (${v.nodes.length} instance${v.nodes.length !== 1 ? 's' : ''})`);
        }
      }
      if (total > 0) console.log(`Full report: ${outFile}`);
      else console.log('No accessibility violations found!');
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
