// ============================================
// Robot playtest harness.
//
// Serves the real site over HTTP, launches one browser page per robot, and
// swaps the Supabase library for the fake client shim. The robots then play
// the actual game through the actual UI.
//
// Nothing here ever contacts the real Supabase project, so no test data can
// reach the production database.
// ============================================

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FakeStore } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SHIM = fs.readFileSync(path.join(HERE, 'client-shim.js'), 'utf8');

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2',
  '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

export class Robot {
  constructor(name, page, table) {
    this.name = name;
    this.page = page;
    this.table = table;
    this.consoleErrors = [];
    this.failedRequests = [];
  }

  async goto(pagePath) {
    await this.page.goto(`${this.table.baseUrl}/${pagePath}`, { waitUntil: 'domcontentloaded' });
  }

  /** Live count of Realtime channels this robot still holds open. */
  async openChannelCount() {
    return this.page.evaluate(() => (window.__fakeChannels || []).length);
  }

  async setDisplayName(name) {
    await this.page.evaluate(n => {
      localStorage.setItem('oracle_party_display_name', n);
    }, name);
  }

  async click(selector) {
    await this.page.click(selector, { timeout: 10000 });
  }

  async type(selector, text) {
    await this.page.fill(selector, text);
  }

  async textOf(selector) {
    return (await this.page.textContent(selector))?.trim() ?? null;
  }

  async isVisible(selector) {
    return this.page.isVisible(selector).catch(() => false);
  }

  /** Simulate the phone dying: no beacon, no cleanup — the nastiest real case. */
  async killAbruptly() {
    await this.page.context().close();
    this.dead = true;
  }
}

export class PlaytestTable {
  constructor() {
    this.store = new FakeStore();
    this.robots = [];
  }

  static async open({ headless = true } = {}) {
    const table = new PlaytestTable();
    const { server, port } = await startServer();
    table.server = server;
    table.baseUrl = `http://127.0.0.1:${port}`;
    table.browser = await chromium.launch({
      headless,
      executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined,
    });
    return table;
  }

  /** Seat a new robot: its own browser context, its own session, shared store. */
  /**
   * Seat a robot that is SIGNED IN, with a real profile row behind it.
   *
   * Every robot before this played as a guest, and that blind spot cost a live
   * game: a signed-in player carries a tier badge, and the lobby row overflowed
   * by 71px only when one was present. No scenario could see it, because no
   * scenario could sign in.
   *
   * The app decides who you are from supabase.auth.getSession(), which the
   * shim reads off window.__fakeSession, so a session set before navigation is
   * indistinguishable from a real one. The profile and stats rows go into the
   * same fake store the page talks to.
   *
   * Guests remain the default — plenty of real players never sign in, and both
   * kinds share a lobby.
   */
  async seatSignedIn(name, { tier = 'Scholar', title = null, isAdmin = false, storageState } = {}) {
    const userId = `user-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    this.store.table('profiles').push({
      id: `profile-${userId}`,
      user_id: userId,
      display_name: name,
      discriminator: String(1000 + this.store.table('profiles').length),
      avatar_color: '#7C5CC2',
      avatar_emoji: '🦊',
      bio: null,
      favorite_category: null,
      visibility: 'public',
      show_online_status: true,
      honks_received: 0,
      honks_given: 0,
      questions_flagged: 0,
      created_at: new Date().toISOString(),
      deleted_at: null,
      title_slot1: title, title_slot2: null, title_slot3: null,
      title_builder_unlocked: false,
      is_admin: isAdmin,
    });

    const robot = await this.seat(name, { storageState, session: { userId, name } });

    // Without this the display-name modal opens and ensureDisplayName() never
    // resolves, so init() stops before it fetches anything — the host page sat
    // on an empty category grid with no error, which reads exactly like "a
    // signed-in player cannot host a game". The modal is correct behaviour on a
    // device that has not been used before; the robot simply never answered it.
    await robot.page.addInitScript(n => {
      localStorage.setItem('oracle_party_display_name', n);
    }, name);

    robot.userId = userId;
    robot.tier = tier;
    return robot;
  }

  async seat(name, { storageState, session } = {}) {
    // storageState lets a robot come back as the SAME browser rather than a
    // fresh one. Without it, "rejoining" silently tests a different device,
    // because localStorage — where a player's seat is remembered — starts empty.
    const context = await this.browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      ...(storageState ? { storageState } : {}),
    });
    const page = await context.newPage();
    const robot = new Robot(name, page, this);

    page.on('console', msg => {
      if (msg.type() === 'error') robot.consoleErrors.push(msg.text());
    });
    // A bare "Failed to load resource" says nothing about what failed, so
    // record the URL separately and make it attributable.
    page.on('response', res => {
      if (res.status() >= 400) robot.failedRequests.push(`${res.status()} ${res.url()}`);
    });
    page.on('pageerror', err => robot.consoleErrors.push(String(err)));

    // Bridge: page -> shared store
    await context.exposeFunction('__dbOp', op => this.store.execute(op));
    await context.exposeFunction('__dbSubscribe', cfg => {
      let subId;
      subId = this.store.subscribe({
        table: cfg.table,
        filter: cfg.filter,
        events: cfg.events,
        deliver: payload => {
          // subId is assigned before any event can fire. Page may have
          // navigated or closed, in which case dropping the event is correct.
          page.evaluate(
            ([id, p]) => window.__rtDispatch && window.__rtDispatch(id, p),
            [subId, payload]
          ).catch(() => {});
        },
      });
      return subId;
    });
    await context.exposeFunction('__dbUnsubscribe', id => { this.store.unsubscribe(id); });
    await context.exposeFunction('__presenceTrack', (topic, id, st) => {
      this.store.presenceTrack(topic, id, st);
    });
    await context.exposeFunction('__presenceLeave', (topic, id) => {
      this.store.presenceLeave(topic, id);
    });
    await context.exposeFunction('__presenceWatch', topic => {
      this.store.watchPresence(topic, snapshot => {
        page.evaluate(
          ([t, s]) => window.__presenceSync && window.__presenceSync(t, s),
          [topic, snapshot]
        ).catch(() => {});
      });
    });
    await context.exposeFunction('__dbBroadcast', async (topic, event, payload) => {
      for (const r of this.robots) {
        await r.page.evaluate(
          ([t, e, p]) => window.__fakeBroadcast && window.__fakeBroadcast(t, e, p),
          [topic, event, payload]
        ).catch(() => {});
      }
    });

    // HARD BLOCK on the real Supabase project.
    //
    // Three beacons (removePlayerBeacon, markDisconnectedBeacon,
    // deleteRoomBeacon) call fetch() against SUPABASE_URL directly rather than
    // going through the client, so swapping the library is not enough to keep
    // robots away from production. This sandbox happens to be firewalled, but
    // the robot workflow runs on GitHub runners where Supabase is reachable —
    // a robot leaving a room would have issued a real DELETE.
    //
    // Anything addressed to the live project is answered locally instead.
    await context.route('**://*.supabase.co/**', route => {
      const method = route.request().method();
      if (method !== 'GET') {
        return route.fulfill({ status: 204, contentType: 'application/json', body: '' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    // Serve the fake Supabase library in place of the real one.
    await context.route('**/esm.sh/**', route =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: SHIM }));

    // Keep the service worker out of the way; it caches aggressively.
    await context.route('**/sw.js', route =>
      route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));

    // Browsers request /favicon.ico unprompted; the static server has none, and
    // the resulting 404 shows up as a console error unrelated to the app.
    await context.route('**/favicon.ico', route =>
      route.fulfill({ status: 200, contentType: 'image/x-icon', body: '' }));

    // Stub webfonts. Offline they fail, which trips the boot guard in <head>
    // and replaces the page with "Connection issue" — nothing to do with the
    // app logic under test.
    await context.route('**/fonts.googleapis.com/**', route =>
      route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
    await context.route('**/fonts.gstatic.com/**', route =>
      route.fulfill({ status: 200, contentType: 'font/woff2', body: '' }));

    await page.addInitScript(n => { window.__robotId = n; }, name);

    // Set before any navigation, so initAuth() sees a session on first load.
    // The shape matches what supabase-js hands back: the app only reads
    // session.user.id and session.user.email.
    if (session) {
      await page.addInitScript(s => {
        window.__fakeSession = {
          access_token: 'fake-token',
          user: { id: s.userId, email: `${s.name.toLowerCase()}@example.test`, user_metadata: {} },
        };
      }, session);
    }

    this.robots.push(robot);
    return robot;
  }

  async close() {
    await this.browser?.close().catch(() => {});
    await new Promise(r => this.server ? this.server.close(r) : r());
  }
}
