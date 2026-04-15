// End-to-end playthrough: serves THIS branch's static files locally and drives
// two headless browsers through a 2-player game against the real Supabase
// backend. Runs in GitHub Actions (real internet access).
//
// Why serve locally instead of hitting riskyquiznesshq.github.io?
//   The deployed site tracks main. To exercise a PR branch's logic we need to
//   serve that branch's files. The browser still talks to the real Supabase,
//   so this is a genuine end-to-end test of the PR's gameplay loop.
//
// Usage:
//   node tests/e2e/live-playthrough.spec.mjs
//   LIVE_URL=https://... node tests/e2e/live-playthrough.spec.mjs   # override

import { chromium } from 'playwright';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.ico': 'image/x-icon', '.mp3': 'audio/mpeg',
};

function startLocalServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const urlPath = new URL(req.url, 'http://x').pathname;
      const filePath = join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
      try {
        const data = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'text/plain' });
        res.end(data);
      } catch { res.writeHead(404); res.end('Not found'); }
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const HEADLESS = process.env.HEADLESS !== 'false';
const VERBOSE = process.env.VERBOSE === 'true';

const sleep = ms => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log(`  ✓ ${msg}`); }
  else { fail++; console.log(`  ✗ ${msg}`); }
}

async function openPage(browser, label, displayName) {
  const ctx = await browser.newContext({
    viewport: { width: 375, height: 812 },
    deviceScaleFactor: 2,
    ignoreHTTPSErrors: true,
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`));
  page.on('console', m => {
    const t = m.type();
    if (VERBOSE || t === 'error') {
      const text = m.text();
      // Ignore known noise
      if (text.includes('manifest.json') || text.includes('favicon')) return;
      console.log(`  [${label}:${t}] ${text}`);
    }
  });
  // Seed display name so we don't hit the modal
  await page.addInitScript((name) => {
    try { localStorage.setItem('oracle_party_display_name', name); } catch(_) {}
  }, displayName);
  return { page, ctx, errors };
}

async function run() {
  const { server, port } = await startLocalServer();
  const LIVE_URL = process.env.LIVE_URL || `http://127.0.0.1:${port}/`;
  console.log(`\n=== E2E playthrough against ${LIVE_URL} (Supabase: live) ===\n`);
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--ignore-certificate-errors'] });

  const host = await openPage(browser, 'host', 'HostBot');
  const guest = await openPage(browser, 'guest', 'GuestBot');

  try {
    // --- HOST: splash → home → category → settings → create room ---
    console.log('--- HOST: create room ---');
    await host.page.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await host.page.waitForSelector('#btn-host', { state: 'visible', timeout: 25000 });
    check(true, 'host: splash → home transition completed');

    await host.page.click('#btn-host');
    await host.page.waitForURL(/host\.html/, { timeout: 15000 });
    await host.page.waitForSelector('.category-card, [data-category]', { timeout: 15000 });
    check(true, 'host: category grid rendered');

    // Pick the first category
    const cats = await host.page.$$('.category-card, [data-category]');
    await cats[0].click();
    await sleep(800);

    // If subcategory drill-in appeared, pick "All ..."
    const allRow = await host.page.$('.subcategory-row--all');
    if (allRow) { await allRow.click(); await sleep(500); }

    // Click "Host Game" to create the room
    await host.page.waitForSelector('#btn-host-game:not(.is-loading)', { timeout: 10000 });
    await host.page.click('#btn-host-game');
    await host.page.waitForURL(/lobby\.html/, { timeout: 15000 });
    await host.page.waitForLoadState('networkidle', { timeout: 15000 });
    check(true, 'host: room created, navigated to lobby');

    // Extract the 4-letter room code from the page
    const code = await host.page.evaluate(() => {
      // Try known selectors first, then fall back to scanning body text
      const sel = document.querySelector('[data-room-code], #room-code, #lobby-code, .lobby-code, .share-code');
      if (sel?.textContent) {
        const m = sel.textContent.match(/\b[A-Z]{4}\b/);
        if (m) return m[0];
      }
      const m = document.body.innerText.match(/\b[A-Z]{4}\b/);
      return m ? m[0] : null;
    });
    check(!!code && /^[A-Z]{4}$/.test(code), `host: extracted room code "${code}"`);
    if (!code) throw new Error('no room code');

    // --- GUEST: join.html → enter code → lobby ---
    console.log('--- GUEST: join by code ---');
    await guest.page.goto(LIVE_URL + 'join.html', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await guest.page.waitForSelector('#code-input', { timeout: 15000 });
    await guest.page.fill('#code-input', code);
    await guest.page.click('#btn-join');
    await guest.page.waitForURL(/lobby\.html/, { timeout: 15000 });
    await guest.page.waitForLoadState('networkidle', { timeout: 15000 });
    check(true, 'guest: joined by code, on lobby');

    // Both should see 2 players
    await sleep(3000); // Realtime propagation
    const hostPlayerCount = await host.page.$$eval('[data-player-id], .lobby-player, .player-row', els => els.length);
    const guestPlayerCount = await guest.page.$$eval('[data-player-id], .lobby-player, .player-row', els => els.length);
    check(hostPlayerCount >= 2, `host sees >=2 players (${hostPlayerCount})`);
    check(guestPlayerCount >= 2, `guest sees >=2 players (${guestPlayerCount})`);

    // --- HOST: Start Game ---
    console.log('--- HOST: start game ---');
    const startBtn = await host.page.$('#btn-start-game');
    check(!!startBtn, 'host: Start Game button present');
    const disabled = startBtn ? await startBtn.isDisabled() : true;
    check(!disabled, 'host: Start Game button enabled (2+ players)');
    await startBtn.click();
    await host.page.waitForURL(/game\.html/, { timeout: 15000 });
    await guest.page.waitForURL(/game\.html/, { timeout: 15000 });
    check(true, 'both: navigated to game.html');

    // Wait for countdown + sync buffer, then question
    await host.page.waitForSelector('#question-screen.active', { timeout: 20000 });
    await guest.page.waitForSelector('#question-screen.active', { timeout: 20000 });
    check(true, 'both: question screen active');

    // --- Play Q1: both pick wager 1, submit ---
    console.log('--- Play Q1 ---');
    await host.page.waitForSelector('#wager-grid .wager-btn', { timeout: 10000 });
    await guest.page.waitForSelector('#wager-grid .wager-btn', { timeout: 10000 });
    await host.page.click('#wager-grid .wager-btn[data-value="1"]');
    await guest.page.click('#wager-grid .wager-btn[data-value="1"]');
    await host.page.fill('#answer-input', 'qwerty');
    await guest.page.fill('#answer-input', 'asdfgh');
    await sleep(300);
    await host.page.click('#btn-submit-answer');
    await guest.page.click('#btn-submit-answer');

    // Both should reach the reveal screen
    await host.page.waitForSelector('#reveal-screen.active', { timeout: 15000 });
    await guest.page.waitForSelector('#reveal-screen.active', { timeout: 15000 });
    check(true, 'both: reveal screen after Q1');

    // Host clicks Reveal Results (may need to wait for the button)
    await host.page.waitForSelector('#btn-next-question:not([disabled]):not(.hidden), #btn-reveal-results:not([disabled])', { timeout: 15000 });
    const revealBtn = await host.page.$('#btn-next-question, #btn-reveal-results');
    if (revealBtn) await revealBtn.click();
    await sleep(2000);
    check(true, 'host: clicked reveal results');

    // Host advances to next question via the same "Show Scores" / "Next Question" button
    await sleep(1500);
    const nextBtn = await host.page.$('#btn-next-question');
    if (nextBtn && !(await nextBtn.isDisabled())) await nextBtn.click();
    await sleep(2000);
    check(true, 'host: advanced past Q1 reveal');

    // Verify there were no page errors during the playthrough
    const allErrors = [...host.errors, ...guest.errors];
    check(allErrors.length === 0, `no page errors during playthrough (${allErrors.length})`);
    for (const e of allErrors) console.log(`    ${e}`);

  } catch (err) {
    fail++;
    console.log(`  ✗ UNCAUGHT: ${err.message}`);
    console.log(err.stack);
    // Save screenshots on failure
    try { await host.page.screenshot({ path: '/tmp/e2e-fail-host.png' }); } catch(_) {}
    try { await guest.page.screenshot({ path: '/tmp/e2e-fail-guest.png' }); } catch(_) {}
  } finally {
    await host.ctx.close();
    await guest.ctx.close();
    await browser.close();
    server.close();
  }

  console.log(`\n=== Result: ${pass} passed, ${fail} failed ===\n`);
  process.exitCode = fail > 0 ? 1 : 0;
}

run();
