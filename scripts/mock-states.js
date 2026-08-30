// ============================================
// Oracle Party — Mock States for Visual QA
// Defines mock DOM content for every screen state.
// Used by screenshot.js --state=<name> to render
// screens with realistic fake data.
//
// IMPORTANT: inject() runs inside the browser via page.evaluate().
// Only serializable data can be passed via injectArgs.
// Helper functions must be defined INSIDE inject().
// ============================================

const PLAYERS = [
  { id: '1', name: 'ArchaeologistAnna', color: '#C2785C', emoji: '🏛️', isHost: true },
  { id: '2', name: 'TimeTraveler42', color: '#5C8DC2', emoji: '⏳', isCohost: true },
  { id: '3', name: 'QuizMasterMax', color: '#7C5CC2', emoji: '🧠' },
  { id: '4', name: 'HistoryBuff', color: '#5CC27C', emoji: '📜' },
  { id: '5', name: 'ScienceNerd99', color: '#C25C8D', emoji: '🔬' },
  { id: '6', name: 'WildCardWilma', color: '#C2A85C', emoji: '🃏' },
];

const CATEGORIES = [
  { icon: '⏳', hiero: '𓋹', label: 'History', key: 'history', count: 287 },
  { icon: '⚗️', hiero: '𓂀', label: 'Science', key: 'science', count: 195 },
  { icon: '🌿', hiero: '𓅃', label: 'Nature', key: 'nature', count: 142 },
  { icon: '📜', hiero: '𓅝', label: 'Arts & Literature', key: 'arts-literature', count: 168 },
  { icon: '🏛️', hiero: '𓀭', label: 'Culture & Society', key: 'culture-society', count: 124 },
  { icon: '🎬', hiero: '𓇼', label: 'Pop Culture', key: 'pop-culture', count: 156 },
  { icon: '🌍', hiero: '𓈉', label: 'World Geography', key: 'world-geography', count: 132 },
  { icon: '💻', hiero: '𓊝', label: 'Technology', key: 'technology', count: 98 },
  { icon: '⚽', hiero: '𓃗', label: 'Sports', key: 'sports', count: 110 },
  { icon: '🍕', hiero: '𓎿', label: 'Food', key: 'food', count: 87 },
  { icon: '🧩', hiero: '𓃻', label: 'Logic', key: 'logic', count: 64 },
  { icon: '🃏', hiero: '𓆣', label: 'Wild Card', key: 'wild-card', count: 169 },
];

// Helper: the avatar function as a string so inject functions can include it
const AVATAR_FN = `function av(p, extra) { return '<div class="avatar' + (extra || '') + '" style="background:' + p.color + '">' + p.emoji + '</div>'; }`;
const AVATAR_WRAP_FN = `function aw(p) { return '<div class="avatar-wrap">' + av(p) + '</div>'; }`;
const HELPERS = AVATAR_FN + '\n' + AVATAR_WRAP_FN;

// Wraps an inject body string so helpers are available
function makeInject(bodyFn) {
  // We return a function that receives serializable args
  return bodyFn;
}

export const STATES = {
  // ==========================================
  // INDEX.HTML
  // ==========================================
  'splash': {
    page: 'index',
    screen: 'splash',
    inject: () => {},
  },

  'home': {
    page: 'index',
    screen: 'home',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      // Render dock contents for screenshots
      const avatar = document.getElementById('home-avatar');
      if (avatar && !avatar.textContent.trim()) {
        avatar.textContent = 'J';
        avatar.classList.add('home__dock-btn--initial');
      }
      const themeBtn = document.getElementById('theme-toggle');
      if (themeBtn && !themeBtn.textContent.trim()) {
        const isDark = document.documentElement.getAttribute('data-theme') && document.documentElement.getAttribute('data-theme') !== 'light';
        themeBtn.textContent = isDark ? '☀️' : '🌙';
      }
      // Spawn floating category glyphs for visual QA
      const emoji = ['⏳','⚗️','🌿','📜','🏛️','🎬','🌍','💻','⚽','🍕','🧩','🃏'];
      const hiero = ['𓋹','𓂀','𓅃','𓅝','𓀭','𓇼','𓈉','𓊝','𓃗','𓎿','𓃻','𓆣'];
      const allGlyphs = [...emoji, ...hiero];
      const container = document.getElementById('home-glyphs');
      if (container && !container.children.length) {
        const placed = [];
        for (let i = 0; i < 18; i++) {
          const g = document.createElement('span');
          const isHiero = i % allGlyphs.length >= emoji.length;
          g.className = 'home__glyph' + (isHiero ? ' home__glyph--hiero' : '');
          g.textContent = allGlyphs[i % allGlyphs.length];
          let left, top, attempts = 0;
          do {
            left = 2 + Math.random() * 94;
            top = 3 + Math.random() * 90;
            attempts++;
          } while (attempts < 15 && placed.some(p => Math.hypot(p[0] - left, p[1] - top) < 5));
          placed.push([left, top]);
          g.style.left = `${left}%`;
          g.style.top = `${top}%`;
          g.style.fontSize = `${22 + Math.random() * 10}px`;
          g.style.animationDelay = `${Math.random() * 8}s`;
          g.style.animationDuration = `${8 + Math.random() * 8}s`;
          container.appendChild(g);
        }
      }
    },
  },

  // ==========================================
  // HOST.HTML
  // ==========================================
  'category-grid': {
    page: 'host',
    screen: 'category-screen',
    injectArgs: () => CATEGORIES,
    inject: (cats) => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const html = cats.map(c => `
        <button class="category-card" data-category="${c.key}" data-hiero="${c.hiero}">
          <div class="category-card__icon-wrap"><span class="category-card__icon">${c.icon}</span></div>
          <div class="category-card__name">${c.label}</div>
          <div class="category-card__count">${c.count} Qs</div>
          <div class="category-card__plays">0 plays</div>
        </button>
      `).join('');
      const grid = document.getElementById('category-grid');
      if (!grid) return;
      grid.style.gap = '';
      grid.innerHTML = html;
      // MutationObserver locks content against host.js async overwrites
      const obs = new MutationObserver(() => {
        if (grid.children.length !== cats.length) grid.innerHTML = html;
      });
      obs.observe(grid, { childList: true });
    },
  },

  'watermark-all': {
    page: 'host',
    screen: 'category-screen',
    injectArgs: () => CATEGORIES,
    inject: (cats) => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      function renderAll() {
        const grid = document.getElementById('category-grid');
        if (!grid) return;
        // Use real CSS dimensions — no overrides. Cards scroll naturally.
        grid.style.gridTemplateColumns = '';
        grid.style.gap = '';
        grid.innerHTML = cats.map(c => `
          <button class="category-card" data-category="${c.key}" data-hiero="${c.hiero}">
            <div class="category-card__icon-wrap"><span class="category-card__icon">${c.icon}</span></div>
            <div class="category-card__name">${c.label}</div>
            <div class="category-card__count">${c.count} Qs</div>
            <div class="category-card__plays">0 plays</div>
          </button>
        `).join('');
      }
      renderAll();
      // Re-render after host.js overwrites (it runs async)
      setTimeout(renderAll, 100);
      setTimeout(renderAll, 200);
    },
  },

  'host-settings': {
    page: 'host',
    screen: 'settings-screen',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const cat = document.getElementById('selected-category');
      if (cat) {
        cat.querySelector('.selected-category__icon').textContent = '⏳';
        cat.querySelector('.selected-category__name').textContent = 'History';
        cat.querySelector('.selected-category__count').textContent = '287 questions';
      }
    },
  },

  'subcategory-drill': {
    page: 'host',
    screen: 'category-screen',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const grid = document.getElementById('category-grid');
      if (grid) grid.style.display = 'none';
      const subView = document.getElementById('subcategory-view');
      if (subView) subView.style.display = '';
      const title = document.getElementById('subcategory-view__title');
      if (title) title.textContent = '⏳ History';
      const options = document.getElementById('subcategory-view__options');
      if (options) {
        const subs = [
          { icon: '🏛️', label: 'All History', count: 287, all: true },
          { icon: '🏺', label: 'Ancient', count: 84 },
          { icon: '⚔️', label: 'Medieval', count: 62 },
          { icon: '🏰', label: 'Early Modern', count: 48 },
          { icon: '🏭', label: 'Modern', count: 58 },
          { icon: '🌐', label: 'World History', count: 35 },
        ];
        options.innerHTML = subs.map(s =>
          '<div class="subcategory-row' + (s.all ? ' subcategory-row--all' : '') + '">' +
          '<span class="subcategory-row__icon">' + s.icon + '</span>' +
          '<span class="subcategory-row__label">' + s.label + '</span>' +
          '<span class="subcategory-row__count">' + s.count + '</span>' +
          '</div>'
        ).join('');
      }
    },
  },

  // ==========================================
  // JOIN.HTML
  // ==========================================
  'join-empty': {
    page: 'join',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const empty = document.getElementById('public-games-empty');
      if (empty) empty.classList.remove('hidden');
    },
  },

  'join-public-games': {
    page: 'join',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const container = document.getElementById('public-games');
      if (!container) return;
      // Three hosts, three states of reputation, because they render as three
      // different things and only rendering one leaves the others unreviewed:
      // measured and good, measured and POOR (the only coloured case), and a
      // host with no account or no ratings — which must read as "new host" and
      // never as 0%.
      const games = [
        { host: 'CaptainTrivia', icon: '⏳', cat: 'History \u00b7 10Q \u00b7 30s', code: 'ABCD', players: '4 players', statusClass: 'lobby', statusText: 'In Lobby',
          rep: '<span class="host-rep">92% \u00b7 48 ratings</span>' },
        { host: 'QuizWhiz', icon: '⚗️', cat: 'Science \u00b7 15Q \u00b7 45s', code: 'EFGH', players: '2 players', statusClass: 'lobby', statusText: 'In Lobby',
          rep: '<span class="host-rep host-rep--poor">31% \u00b7 13 ratings</span>' },
        { host: 'BrainStorm', icon: '🃏', cat: 'Wild Card \u00b7 20Q \u00b7 30s', code: 'IJKL', players: '6 players', statusClass: 'playing', statusText: 'In Progress',
          rep: '<span class="host-rep host-rep--none">new host</span>' },
      ];
      container.innerHTML = games.map(g => `
        <button class="public-game-row" data-code="${g.code}">
          <span class="public-game-row__icon">${g.icon}</span>
          <div class="public-game-row__info">
            <div class="public-game-row__host">${g.host}'s game &middot; ${g.rep}</div>
            <div class="public-game-row__category">${g.cat}</div>
          </div>
          <div class="public-game-row__meta">
            <div class="public-game-row__code">${g.code}</div>
            <div class="public-game-row__players">${g.players}</div>
            <div class="public-game-row__status public-game-row__status--${g.statusClass}">${g.statusText}</div>
          </div>
        </button>
      `).join('');
    },
  },

  // ==========================================
  // LOBBY.HTML
  // ==========================================
  'lobby-waiting': {
    page: 'lobby',
    screen: 'lobby-screen',
    injectArgs: () => PLAYERS,
    inject: (P) => {
      function av(p, x) { return '<div class="avatar' + (x||'') + '" style="background:' + p.color + '">' + p.emoji + '</div>'; }
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

      document.getElementById('lobby-category-icon').textContent = '⏳';
      document.getElementById('lobby-category').textContent = 'History';
      document.getElementById('lobby-code').textContent = 'ABCD';
      const sb = document.getElementById('btn-settings');
      if (sb) sb.classList.remove('hidden');

      // Mirrors _renderPlayerItem() in js/lobby.js exactly.
      //
      // This used to emit `.player-row` / `.player-row__name`, which appear in
      // neither the app nor the stylesheet — so every lobby screenshot showed
      // unstyled markup that has never shipped. A row that overflowed by 71px
      // in a real game reviewed as perfect here, because this was not a lobby.
      // If _renderPlayerItem changes, change this in the same commit.
      function row(p, opts) {
        opts = opts || {};
        const badges = [];
        if (opts.roleBadge && p.isHost) badges.push('<span class="badge badge--host">Host</span>');
        if (opts.roleBadge && p.isCohost) badges.push('<span class="badge badge--cohost">Co-Host</span>');
        // Ready state is suppressed for host and co-host, as in the app.
        if (!p.isHost && !p.isCohost) {
          badges.push(opts.ready
            ? '<span class="badge badge--ready">Ready</span>'
            : '<span class="badge badge--not-ready">Not Ready</span>');
        }
        // A bot carries one badge and nothing else — no ready state, no tier,
        // no title. Same as the app.
        if (p.isBot) {
          badges.length = 0;
          badges.push('<span class="badge badge--bot">Bot</span>');
        }
        const sub = p.isBot ? '' :
          ((p.tier ? '<span class="player-tier" data-tier="' + p.tier.toLowerCase() + '">' + p.tier + '</span>' : '')
           + (p.title ? '<span class="player-title">' + p.title + '</span>' : ''));
        // The host sees action buttons on everyone but themselves — and on a
        // bot, only the remove button. Host and co-host are for humans.
        const actions = p.isHost ? '' : p.isBot
          ? '<button class="icon-btn remove-bot-btn" aria-label="Remove bot">✕</button>'
          : '<button class="honk-btn" aria-label="Quack">\u{1F986}</button>'
          + '<button class="icon-btn cohost-btn' + (p.isCohost ? ' cohost-btn--demote' : '') + '" aria-label="Co-host">'
          + (p.isCohost ? '★' : '☆') + '</button>'
          + '<button class="icon-btn transfer-host-btn" aria-label="Make host">\u{1F451}</button>';
        return '<div class="player-item">'
          + '<div class="avatar-wrap">' + av(p) + '</div>'
          + '<div class="name-stack"><span class="player-item__name">' + p.name + '</span>'
          + '<span class="name-substack">' + sub + '</span></div>'
          + actions
          + '<span class="player-item__badges">' + badges.join('') + '</span>'
          + '</div>';
      }

      // A signed-in player carries a tier; a guest does not. That difference is
      // what the robot playtests cannot represent and what broke the real row,
      // so the mock deliberately mixes both.
      const host = { ...P[0], isHost: true, tier: 'Oracle', title: 'Keeper of Secrets' };
      const cohost = { ...P[1], isCohost: true, tier: 'Scholar' };
      document.getElementById('host-list').innerHTML =
        row(host, { roleBadge: true }) + row(cohost, { roleBadge: true });

      document.getElementById('player-list').innerHTML = [
        { ...P[2], tier: 'Apprentice' },
        { ...P[3] },
        { ...P[4], tier: 'Novice', title: 'Student of the Ages' },
        { ...P[5] },
        // A practice bot sits in the same list as everyone else, so its row has
        // to fit the same budget. It is here because a bot row that was never
        // previewed is a bot row nobody measured.
        { name: 'Practice Bot', color: '#6b7280', emoji: '\u{1F916}', isBot: true },
      ].map(p => row(p, { ready: false })).join('');

      // The host's add-bot button is hidden once the room has one, exactly as
      // renderAddBotButton() does it — so this state previews the "already has
      // a bot" case and lobby-ready below previews the other.
      const addBot = document.getElementById('btn-add-bot');
      if (addBot) addBot.classList.add('hidden');

      const chat = document.getElementById('chat-drawer-messages');
      if (chat) {
        // Mirrors appendChatMessage() in js/lobby.js.
        function bubble(p, text, hearts) {
          return '<div class="chat-bubble">'
            + '<div class="chat-bubble__header">' + av(p, ' avatar--chat')
            + '<div class="chat-bubble__name">' + p.name + '</div></div>'
            + '<div class="chat-bubble__body"><div class="chat-bubble__text">' + text + '</div>'
            + '<div class="chat-bubble__hearts"><button class="heart-btn" aria-label="Heart">&hearts;</button>'
            + '<span class="heart-count' + (hearts ? '' : ' hidden') + '">' + (hearts || 0) + '</span>'
            + '</div></div></div>';
        }
        chat.innerHTML = bubble(P[2], 'Ready to go! 🎉', 2)
          + bubble(P[0], 'Waiting for one more...', 0)
          + bubble(P[5], "Let's do this! 💪", 1);
      }

      const startBtn = document.getElementById('btn-start-game');
      if (startBtn) startBtn.classList.remove('hidden');
    },
  },

  // A room part-way through an evening: two games played, so the cumulative
  // Room Scores tally is showing. It lives on the room now (migration 038)
  // rather than in each phone's sessionStorage, and .room-score-row had never
  // been rendered by the sweep in any state.
  'lobby-room-scores': {
    page: 'lobby',
    screen: 'lobby-screen',
    inherits: 'lobby-waiting',
    injectArgs: () => PLAYERS,
    inject: (P) => {
      const section = document.getElementById('room-scores');
      const list = document.getElementById('room-scores-list');
      if (!section || !list) return;
      section.style.display = '';
      const tally = [[P[0].name, 128], [P[2].name, 96], [P[3].name, 71], [P[1].name, -14]];
      list.innerHTML = tally.map(([name, score], i) =>
        `<div class="room-score-row${i === 0 ? ' room-score-row--me' : ''}">
          <span class="room-score-row__rank">${i + 1}</span>
          <span class="room-score-row__name">${name}</span>
          <span class="room-score-row__score">${score} pts</span>
        </div>`).join('');
    },
  },

  'lobby-ready': {
    page: 'lobby',
    screen: 'lobby-screen',
    inherits: 'lobby-waiting',
    inject: () => {
      // Flip "Not Ready" to "Ready" in place, in the badge strip where the app
      // puts it. Appending to .player-row did nothing once the rows became
      // .player-item, and appending to the row rather than its badge strip
      // would have put the badge outside the container that bounds it.
      document.querySelectorAll('#player-list .player-item__badges').forEach(strip => {
        const notReady = strip.querySelector('.badge--not-ready');
        if (notReady) {
          notReady.className = 'badge badge--ready';
          notReady.textContent = 'Ready';
        }
      });

      // The no-bot half of the lobby: the bot's row goes and the host's
      // add-bot button appears. Both halves have to be previewed somewhere or
      // one of them is never measured — the button was invisible in every
      // state until this was added, so the sweep had nothing to check.
      const bot = document.querySelector('#player-list .badge--bot');
      if (bot) bot.closest('.player-item').remove();
      const addBot = document.getElementById('btn-add-bot');
      if (addBot) addBot.classList.remove('hidden');
    },
  },

  // An away player, and specifically an away CO-HOST — the combination that
  // overflowed this row by 71px in August and made the whole page draggable
  // sideways. "Away" replaces the Ready badge rather than joining it, so the
  // budget is unchanged, but that has to be measured rather than asserted.
  'lobby-away': {
    page: 'lobby',
    screen: 'lobby-screen',
    inherits: 'lobby-waiting',
    inject: () => {
      const rows = [...document.querySelectorAll('#player-list .player-item')];
      // Whichever rows have a ready badge are ordinary players; fade one and
      // relabel it exactly as _renderPlayerItem does.
      for (const row of rows) {
        const strip = row.querySelector('.player-item__badges');
        if (!strip) continue;
        const isCohost = !!strip.querySelector('.badge--cohost');
        const ready = strip.querySelector('.badge--ready, .badge--not-ready');
        if (!isCohost && !ready) continue;
        row.classList.add('player-item--away');
        if (ready) {
          ready.className = 'badge badge--away';
          ready.textContent = 'Away';
        } else {
          // A co-host carries no ready badge, so Away is appended — the two
          // together are the widest this row ever gets.
          const away = document.createElement('span');
          away.className = 'badge badge--away';
          away.textContent = 'Away';
          strip.appendChild(away);
        }
      }
    },
  },

  // ==========================================
  // GAME.HTML — Question
  // ==========================================
  'question-fresh': {
    page: 'game',
    screen: 'question-screen',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      document.getElementById('question-category').textContent = '⏳ History';
      document.getElementById('question-progress').textContent = 'Question 3 of 10';
      document.getElementById('question-text').textContent = 'What ancient wonder was located in the city of Babylon?';
      document.getElementById('timer-text').textContent = '30';
      document.getElementById('timer-bar').style.width = '100%';
      const grid = document.getElementById('wager-grid');
      let html = '';
      for (let i = 1; i <= 10; i++) {
        let cls = 'wager-btn';
        if (i === 1) cls += ' wager-btn--correct';
        else if (i === 2) cls += ' wager-btn--incorrect';
        html += '<button class="' + cls + '">' + i + '</button>';
      }
      grid.innerHTML = html;
    },
  },

  'question-mid-timer': {
    page: 'game',
    screen: 'question-screen',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      document.getElementById('question-category').textContent = '⏳ History';
      document.getElementById('question-progress').textContent = 'Question 3 of 10';
      document.getElementById('question-text').textContent = 'What ancient wonder was located in the city of Babylon?';
      document.getElementById('timer-text').textContent = '14';
      document.getElementById('timer-bar').style.width = '47%';
      const grid = document.getElementById('wager-grid');
      let html = '';
      for (let i = 1; i <= 10; i++) {
        let cls = 'wager-btn';
        if (i === 1) cls += ' wager-btn--correct';
        else if (i === 2) cls += ' wager-btn--incorrect';
        else if (i === 7) cls += ' wager-btn--selected';
        html += '<button class="' + cls + '">' + i + '</button>';
      }
      grid.innerHTML = html;
    },
  },

  'question-submitted': {
    page: 'game',
    screen: 'question-screen',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      document.getElementById('question-category').textContent = '⏳ History';
      document.getElementById('question-progress').textContent = 'Question 3 of 10';
      document.getElementById('question-text').textContent = 'What ancient wonder was located in the city of Babylon?';
      document.getElementById('timer-text').textContent = '8';
      document.getElementById('timer-bar').style.width = '27%';
      const grid = document.getElementById('wager-grid');
      let html = '';
      for (let i = 1; i <= 10; i++) {
        let cls = 'wager-btn';
        if (i === 1) cls += ' wager-btn--correct';
        else if (i === 2) cls += ' wager-btn--incorrect';
        else if (i === 7) cls += ' wager-btn--selected';
        html += '<button class="' + cls + '">' + i + '</button>';
      }
      grid.innerHTML = html;
      document.getElementById('answer-input').value = 'Hanging Gardens';
      document.getElementById('answer-input').disabled = true;
      document.getElementById('btn-submit-answer').disabled = true;
      document.getElementById('submit-status').classList.remove('hidden');
    },
  },

  'question-final': {
    page: 'game',
    screen: 'question-screen',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      document.getElementById('question-category').textContent = '⏳ History';
      document.getElementById('question-progress').textContent = 'Final Question';
      document.getElementById('question-text').textContent = 'In what year did the Library of Alexandria suffer its most devastating fire?';
      document.getElementById('timer-text').textContent = '30';
      document.getElementById('timer-bar').style.width = '100%';
      document.getElementById('wager-grid').style.display = 'none';
      const label = document.querySelector('.wager-label');
      if (label) label.style.display = 'none';
    },
  },

  // ==========================================
  // GAME.HTML — Reveal
  // ==========================================
  // Flagging a question as "Other", with the free-text box open. The flag is
  // already saved by the time this shows; the note is the follow-up. This state
  // exists because .feedback-flag-menu and .feedback-flag-note had never once
  // been rendered open by the layout sweep, on a phone-width screen where a
  // floating panel is exactly the thing that overflows.
  'reveal-flag-other': {
    page: 'game',
    screen: 'reveal-screen',
    inherits: 'reveal-answers',
    inject: () => {
      const fb = document.getElementById('reveal-feedback');
      if (!fb) return;
      fb.style.display = '';
      fb.classList.remove('reveal__feedback--faded');
      // The reason menu CLOSES when a reason is picked, so it is not open at
      // the same time as the note box. Rendering both was fiction, and the
      // sweep's covered-control check said so: the Send button sat underneath
      // the "Ambiguous" option, which cannot happen in the real flow.
      const menu = fb.querySelector('.feedback-flag-menu');
      if (menu) menu.style.display = 'none';
      const flagBtn = fb.querySelector('.feedback-btn[data-type="flag"]');
      if (flagBtn) flagBtn.classList.add('feedback-btn--active');
      const note = document.getElementById('feedback-flag-note');
      if (note) {
        note.style.display = '';
        const input = document.getElementById('feedback-flag-note-input');
        if (input) input.value = 'The answer key says Kennedy but JFK should count';
      }
    },
  },

  'reveal-answers': {
    page: 'game',
    screen: 'reveal-screen',
    injectArgs: () => PLAYERS,
    inject: (P) => {
      function av(p) { return '<div class="avatar" style="background:' + p.color + '">' + p.emoji + '</div>'; }
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

      document.getElementById('reveal-category').textContent = '⏳ History';
      document.getElementById('reveal-progress').textContent = 'Question 3 of 10';
      document.getElementById('reveal-question-text').textContent = 'What ancient wonder was located in the city of Babylon?';
      document.getElementById('reveal-answer').textContent = 'Hanging Gardens';
      // The MEASURED form, which is the longest this line ever gets — a band
      // plus the sample it rests on. reveal.js used to hide this element
      // outright; the slot had been in game.html from the beginning and was
      // never once filled.
      const diffEl = document.getElementById('reveal-difficulty');
      diffEl.className = 'reveal__difficulty';
      diffEl.dataset.band = 'very-hard';
      diffEl.dataset.measured = 'true';
      diffEl.style.display = '';
      diffEl.innerHTML = '<span class="reveal__difficulty-label">Very Hard</span>'
        + '<span class="reveal__difficulty-detail">18% get this right, from 124 plays</span>';
      const fb = document.getElementById('reveal-feedback');
      if (fb) fb.style.display = '';

      const answers = [
        { p: P[0], a: 'Hanging Gardens', c: true, w: 7 },
        { p: P[1], a: 'Colossus', c: false, w: 5 },
        { p: P[2], a: 'hanging gardens of babylon', c: true, w: 8 },
        { p: P[3], a: 'The Hanging Gardens', c: true, w: 3 },
        { p: P[4], a: 'Tower of Babel', c: false, w: 6 },
        { p: P[5], a: 'Gardens of Babylon', c: true, w: 4 },
      ];

      document.getElementById('reveal-answers').innerHTML = answers.map(x => {
        const cc = x.c ? 'answer-row__answer--correct' : 'answer-row__answer--incorrect';
        const wc = x.c ? 'answer-row__wager--correct' : 'answer-row__wager--incorrect';
        const badge = x.p.isHost ? ' <span class="badge badge--host">Host</span>' : '';
        return '<div class="answer-row">' +
          '<div class="answer-row__top"><div class="avatar-wrap">' + av(x.p) + '</div>' +
          '<span class="answer-row__name">' + x.p.name + badge + '</span>' +
          '<span class="answer-row__wager ' + wc + '">' + x.w + '</span></div>' +
          '<div class="answer-row__bottom"><span class="answer-row__answer ' + cc + '">' + x.a + '</span></div>' +
          '</div>';
      }).join('');

      document.getElementById('btn-next-question').classList.remove('hidden');
    },
  },

  'reveal-with-fun-fact': {
    page: 'game',
    screen: 'reveal-screen',
    inherits: 'reveal-answers',
    inject: () => {
      const ff = document.getElementById('reveal-fun-fact');
      if (ff) {
        ff.textContent = 'Some historians debate whether the Hanging Gardens actually existed — no definitive archaeological evidence has been found.';
        ff.style.display = '';
      }
    },
  },

  // The host-review row, which exists on no other reveal state and appears only
  // on the FINAL round. It sits under the question feedback and means something
  // completely different, so the two have to be looked at together — that is
  // the whole reason it is labelled and ruled off.
  //
  // The FLAG is no longer here: reporting a host moved to the profile card
  // (mock state `profile-card-report`), because a third icon inches from the
  // question feedback, wearing the same glyphs, made tapping the wrong pair
  // silently wrong.
  'reveal-host-review': {
    page: 'game',
    screen: 'reveal-screen',
    inherits: 'reveal-answers',
    inject: () => {
      const row = document.getElementById('reveal-host-review');
      if (!row) return;
      row.style.display = '';
      const down = row.querySelector('[data-host-vote="down"]');
      if (down) down.classList.add('feedback-btn--active');
    },
  },

  // REPORTING A HOST, on the profile card, with the reason menu open. A page
  // with no mock is a page nobody is checking — the flagged-queue row shipped
  // months of unstyled markup for exactly that reason — and this control is
  // brand new, so it has never been rendered by the sweep at any width.
  'profile-card-report': {
    page: 'lobby',
    screen: 'lobby-screen',
    inherits: 'lobby-waiting',
    inject: () => {
      const sheet = document.createElement('div');
      sheet.id = 'profile-card-sheet';
      sheet.className = 'modal-overlay active';
      sheet.innerHTML = `
        <div class="modal profile-card">
          <div id="profile-card-content">
            <div class="profile-card__header">
              <div class="profile-card__avatar"></div>
              <div class="profile-card__name">Alexandra<span class="profile-card__tag">#4821</span></div>
              <div class="profile-card__title">Ancient Chronicler</div>
            </div>
            <p class="host-rep">As host: 71% would play again \u00b7 14 ratings</p>
            <div class="profile-card__report">
              <button class="profile-card__report-btn">Report this host</button>
              <div class="profile-card__report-menu">
                <button data-report-reason="unfair_judging">Unfair judging</button>
                <button data-report-reason="abusive">Abusive</button>
                <button data-report-reason="ended_early">Ended the game early</button>
                <button data-report-reason="other">Other</button>
              </div>
              <p class="profile-card__report-done"></p>
            </div>
            <div class="profile-card__actions">
              <button class="btn btn-secondary btn-block">Add Friend</button>
            </div>
          </div>
        </div>`;
      document.body.appendChild(sheet);
    },
  },

  'reveal-host-override': {
    page: 'game',
    screen: 'reveal-screen',
    inherits: 'reveal-answers',
    inject: () => {
      const disq = document.getElementById('btn-disqualify-round');
      if (disq) disq.classList.remove('hidden');
      // Flip second answer (incorrect → correct) to simulate host override
      const rows = document.querySelectorAll('.answer-row');
      if (rows[1]) {
        const answer = rows[1].querySelector('.answer-row__answer');
        if (answer) {
          answer.classList.remove('answer-row__answer--incorrect');
          answer.classList.add('answer-row__answer--correct');
        }
        const wager = rows[1].querySelector('.answer-row__wager');
        if (wager) {
          wager.classList.remove('answer-row__wager--incorrect');
          wager.classList.add('answer-row__wager--correct');
        }
      }
    },
  },

  // ==========================================
  // GAME.HTML — Scores
  // ==========================================
  'scores-animated': {
    page: 'game',
    screen: 'scores-screen',
    injectArgs: () => PLAYERS,
    inject: (P) => {
      function av(p) { return '<div class="avatar" style="background:' + p.color + '">' + p.emoji + '</div>'; }
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

      document.getElementById('scores-category').textContent = '⏳ History';
      document.getElementById('scores-progress').textContent = 'Question 3 of 10';

      const scores = [
        { p: P[0], score: 22, delta: 7 },
        { p: P[2], score: 20, delta: 8 },
        { p: P[3], score: 17, delta: 3 },
        { p: P[5], score: 13, delta: 4 },
        { p: P[1], score: 10, delta: 0 },
        { p: P[4], score: 8, delta: 0 },
      ];

      document.getElementById('scores-animated-list').innerHTML = scores.map(s => {
        const dc = s.delta > 0 ? 'score-anim-row__delta--positive' :
                   s.delta < 0 ? 'score-anim-row__delta--negative' : 'score-anim-row__delta--zero';
        const ds = s.delta > 0 ? '+' : '';
        const badge = s.p.isHost ? ' <span class="badge badge--host">Host</span>' : '';
        return '<div class="score-anim-row"><div class="avatar-wrap">' + av(s.p) + '</div>' +
          '<span class="score-anim-row__name">' + s.p.name + badge + '</span>' +
          '<span class="score-anim-row__delta ' + dc + '">' + ds + s.delta + '</span>' +
          '<span class="score-anim-row__score">' + s.score + '</span></div>';
      }).join('');

      document.getElementById('btn-scores-action').classList.remove('hidden');
      document.getElementById('btn-scores-action').textContent = 'Next Question';
    },
  },

  'scores-host-view': {
    page: 'game',
    screen: 'scores-screen',
    inherits: 'scores-animated',
    inject: () => {
      const editBtn = document.getElementById('btn-edit-scores');
      if (editBtn) editBtn.classList.remove('hidden');
    },
  },

  // ==========================================
  // GAME.HTML — Final Wager
  // ==========================================
  'final-wager-choosing': {
    page: 'game',
    screen: 'final-wager-screen',
    injectArgs: () => PLAYERS,
    inject: (P) => {
      function av(p) { return '<div class="avatar" style="background:' + p.color + '">' + p.emoji + '</div>'; }
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

      document.getElementById('fw-category').textContent = '⏳ History';
      document.getElementById('fw-current-score').textContent = '42';
      document.getElementById('btn-fw-lock').style.display = '';

      // The 20-second wager clock. Shown mid-count rather than at 20s, because
      // the bar at 100% is indistinguishable from a bar with no fill rule.
      const fwTimer = document.getElementById('fw-timer');
      if (fwTimer) {
        fwTimer.style.display = '';
        document.getElementById('fw-timer-bar').style.width = '55%';
        document.getElementById('fw-timer-text').textContent = '11s';
      }

      // Difficulty vote avatars
      const ea = document.querySelector('[data-dv-avatars="easy"]');
      const ma = document.querySelector('[data-dv-avatars="medium"]');
      const ha = document.querySelector('[data-dv-avatars="hard"]');
      if (ea) ea.innerHTML = av(P[3]) + av(P[5]);
      if (ma) ma.innerHTML = av(P[0]) + av(P[2]) + av(P[4]);
      if (ha) ha.innerHTML = av(P[1]);

      document.getElementById('fw-player-list').innerHTML = P.map((p, i) => {
        const locked = i < 3;
        return '<div class="fw-player-row"><div class="avatar-wrap">' + av(p) + '</div>' +
          '<span class="fw-player-row__name">' + p.name + '</span>' +
          '<span class="fw-player-row__score">' + (42 - i * 7) + ' pts</span>' +
          '<span class="fw-player-row__wager' + (locked ? '' : ' fw-player-row__wager--waiting') + '">' + (locked ? '🔒' : '...') + '</span></div>';
      }).join('');
    },
  },

  'final-wager-locked': {
    page: 'game',
    screen: 'final-wager-screen',
    inherits: 'final-wager-choosing',
    inject: () => {
      const lockBtn = document.getElementById('btn-fw-lock');
      if (lockBtn) lockBtn.style.display = 'none';
      const status = document.getElementById('fw-status');
      if (status) status.classList.remove('hidden');
      // Locked in, so there is nothing left to count. A clock still running
      // here would tell the player something is expected of them.
      const fwTimer = document.getElementById('fw-timer');
      if (fwTimer) fwTimer.style.display = 'none';
      // Mark all players as locked
      document.querySelectorAll('.fw-player-row__wager--waiting').forEach(el => {
        el.classList.remove('fw-player-row__wager--waiting');
        el.textContent = '🔒';
      });
    },
  },

  // ==========================================
  // GAME.HTML — Results
  // ==========================================
  'results-winner': {
    page: 'game',
    screen: 'results-screen',
    injectArgs: () => PLAYERS,
    inject: (P) => {
      function av(p) { return '<div class="avatar" style="background:' + p.color + '">' + p.emoji + '</div>'; }
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

      document.getElementById('results-category').textContent = '⏳ History';
      document.getElementById('results-winner').innerHTML =
        '<div class="results-winner__badge">🏆</div>' +
        '<div class="results-winner__name">' + P[0].name + '</div>' +
        '<div class="results-winner__score">62 points</div>';

      const scores = [
        { p: P[0], score: 62, rank: '1st' },
        { p: P[2], score: 55, rank: '2nd' },
        { p: P[3], score: 48, rank: '3rd' },
        { p: P[5], score: 35, rank: '4th' },
        { p: P[1], score: 28, rank: '5th' },
        { p: P[4], score: 22, rank: '6th' },
      ];

      // Mirrors renderResultsList() in js/game/scores.js. The old markup put a
      // `.results-rank` span first — a class that exists nowhere in the app or
      // the stylesheet — and omitted the name-stack the real row is built on,
      // so this preview never showed the layout it claimed to.
      const PLACE = ['1st', '2nd', '3rd', '4th', '5th', '6th'];
      const PLACE_CLASS = ['results-row__place--1st', 'results-row__place--2nd', 'results-row__place--3rd'];
      document.getElementById('results-list').innerHTML = scores.map((s, i) =>
        '<div class="results-row">' +
        '<span class="results-row__place ' + (PLACE_CLASS[i] || '') + '">' + PLACE[i] + '</span>' +
        '<div class="avatar-wrap">' + av(s.p) + '</div>' +
        '<div class="name-stack"><span class="results-row__name">' + s.p.name +
        (s.p.isHost ? ' <span class="badge badge--host">Host</span>' : '') + '</span></div>' +
        '<span class="results-row__score">' + s.score + '</span></div>'
      ).join('');
    },
  },

  'results-review': {
    page: 'game',
    screen: 'results-screen',
    inherits: 'results-winner',
    inject: () => {
      const overlay = document.getElementById('review-overlay');
      if (overlay) overlay.classList.add('active');
      const list = document.getElementById('review-list');
      if (list) {
        const questions = [
          { q: 'What ancient wonder was located in the city of Babylon?', a: 'Hanging Gardens', yours: 'Hanging Gardens', correct: true, w: 7 },
          { q: 'Who painted the ceiling of the Sistine Chapel?', a: 'Michelangelo', yours: 'Michelangelo', correct: true, w: 9 },
          { q: 'What year did the Berlin Wall fall?', a: '1989', yours: '1991', correct: false, w: 4 },
        ];
        list.innerHTML = questions.map((q, i) =>
          '<div class="review-card">' +
          '<div class="review-card__header">Q' + (i + 1) + ' · Wager: ' + q.w + '</div>' +
          '<div class="review-card__question">' + q.q + '</div>' +
          '<div class="review-card__answer">Answer: <strong>' + q.a + '</strong></div>' +
          '<div class="review-card__yours ' + (q.correct ? 'review-card__yours--correct' : 'review-card__yours--incorrect') + '">You said: ' + q.yours + '</div>' +
          '</div>'
        ).join('');
      }
    },
  },

  // ==========================================
  // GAME.HTML — Modals / Overlays
  // ==========================================
  // ==========================================
  // ADMIN.HTML
  //
  // The admin page had no mock either. The drill-down rows are the densest
  // thing in this app — a name, a metadata line and a button on one row — so
  // they are the most likely to squeeze the name to nothing, which is exactly
  // how the lobby rows broke in a live game.
  // ==========================================
  // The page as it now arrives: four stat cards and eight closed panel rows,
  // each carrying its own count. Mirrors loadDashboardStats() and
  // loadPanelCounts() in js/admin.js — change them together.
  //
  // The counts are deliberately not all plain numbers. "None", "4,782" and
  // "3 ratings, 0 played" are all real outputs, and the longest of them is
  // what decides whether a panel title still fits on a 375px phone.
  //
  // (inject() is serialised into the browser, so these two blocks are
  // duplicated in 'admin-drill' rather than shared — module-scope helpers do
  // not survive the trip. See the note at the top of this file.)
  'admin-panels': {
    page: 'admin',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const loading = document.getElementById('admin-loading');
      if (loading) loading.style.display = 'none';
      const content = document.getElementById('admin-content');
      if (content) content.style.display = '';

      const vals = { 'stat-online': '11', 'stat-games': '3', 'stat-accounts': '11', 'stat-today': '24' };
      for (const [id, v] of Object.entries(vals)) {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      }

      const counts = {
        flagged: ['4 flags', 'alert'],
        hosts: ['2 reports', 'alert'],
        health: ['3 ratings, 0 played', null],
        questions: ['4,782', null],
        games: ['1,204', null],
        errors: ['7 · 7d', 'error'],
        chat: ['None', null],
        announcement: ['Live', 'alert'],
        flags: ['1 on', 'alert'],
      };
      for (const [key, [text, tone]] of Object.entries(counts)) {
        const el = document.querySelector(`[data-count="${key}"]`);
        if (!el) continue;
        el.textContent = text;
        if (tone) el.classList.add(`admin-panel__count--${tone}`);
      }

      // Flagged Questions open, because it is the panel an admin opens first
      // and the only one whose rows carry free text a player typed.
      const head = document.querySelector('.admin-panel__head[data-panel="flagged"]');
      if (head) head.setAttribute('aria-expanded', 'true');
      const body = document.getElementById('panel-flagged');
      if (body) body.hidden = false;
      const queue = document.getElementById('flagged-queue');
      if (!queue) return;
      // Mirrors loadFlaggedQueue() in js/admin.js.
      const flagged = [
        ['Which artist painted the ceiling of the Sistine Chapel between 1508 and 1512?',
         'Michelangelo', 3, 'Wrong answer, Too obscure',
         ['it also accepts Michelangelo Buonarroti surely']],
        ['What is the capital of Australia?', 'Canberra', 1, 'Typo', []],
      ];
      queue.innerHTML = flagged.map(([q, a, n, reasons, notes]) => `
        <div class="admin-flag-row">
          <div class="admin-flag-row__text">${q}</div>
          <div class="admin-flag-row__meta">
            <span class="admin-flag-row__answer">A: ${a}</span>
            <span class="admin-flag-row__count">${n} flag${n > 1 ? 's' : ''}</span>
            <span class="admin-flag-row__reasons">${reasons}</span>
          </div>
          ${notes.map(t => `<div class="admin-flag-row__note">“${t}”</div>`).join('')}
          <div class="admin-flag-row__actions">
            <button class="btn btn-secondary">Unflag</button>
            <button class="btn btn-secondary btn-danger-text">Remove Q</button>
          </div>
        </div>`).join('');
    },
  },

  // Title Words, open and EDITABLE. Every slot carries a text box and up to two
  // buttons beside a fixed-width label, which is the most crowded row on the
  // admin page — and the lobby row is what taught this project that anything
  // added beside a label at 375px is what overflows. The row must wrap.
  //
  // Deliberately mixes all four states, because they lay out differently and a
  // mock showing only one would review a row that does not ship: written and
  // editable (two buttons), empty (one), defined in code (no editor at all),
  // and one carrying a refusal message on its own line.
  'admin-title-words': {
    page: 'admin',
    screen: null,
    inherits: 'admin-panels',
    inject: () => {
      document.querySelectorAll('.admin-panel__head').forEach(h => h.setAttribute('aria-expanded', 'false'));
      document.querySelectorAll('.admin-panel__body').forEach(b => { b.hidden = true; });
      const head = document.querySelector('.admin-panel__head[data-panel="titlewords"]');
      if (head) head.setAttribute('aria-expanded', 'true');
      const body = document.getElementById('panel-titlewords');
      if (body) body.hidden = false;
      const el = document.getElementById('title-words');
      if (!el) return;
      // Mirrors loadTitleWordsPanel() in js/admin.js. If that markup changes,
      // change this in the same commit or the sweep reviews a row that has
      // never shipped — which is how the lobby previewed perfectly while
      // overflowing by 71px in a real game.
      const slot = (tier, word, need, { code = false, status = '' } = {}) => `
        <div class="tw-slot${word ? '' : ' tw-slot--empty'}">
          <span class="tw-slot__tier" data-r="${tier}">${tier}</span>
          ${code
            ? `<span class="tw-slot__word">${word}</span><span class="tw-slot__need">in code</span>`
            : `<input class="input tw-slot__input" type="text" maxlength="24" placeholder="not written" value="${word}">
               <button class="btn btn-secondary tw-slot__save" type="button">Save</button>
               ${word ? '<button class="btn btn-secondary btn-danger-text tw-slot__remove" type="button">Remove</button>' : ''}`}
          <span class="tw-slot__need">${need}</span>
          <span class="tw-slot__status">${status}</span>
        </div>`;
      el.innerHTML = `
        <p class="admin-empty" style="margin-bottom:var(--space-md);">
          <b>19</b> written, <b>87</b> still to write.
          29 of 48 topics are big enough for words of their own (60+ questions).
          A slot with no word does not exist for players.
        </p>
        <div class="tw-subject">
          <div class="tw-subject__head">
            <span class="tw-subject__name">\u{1F3DB}\uFE0F History</span>
            <span class="tw-subject__size">405 questions</span>
          </div>
          ${slot('common', 'History', '10 right in the whole subject', { code: true })}
          ${slot('rare', '', 'a quarter of every topic, 100+ overall')}
          ${slot('mythic', 'Everlasting', 'all 405', { status: 'Not saved \u2014 Permission denied \u2014 the word was not saved' })}
          <div class="tw-topic">
            <div class="tw-topic__head">
              <span class="tw-topic__name">Ancient &amp; Classical Civilisations</span>
              <span class="tw-topic__size">110</span>
            </div>
            ${slot('uncommon', 'Chronicles', '28 right \u00b7 set at 22')}
            ${slot('epic', '', '83 right')}
            ${slot('legendary', 'Antiquity', '110 right')}
          </div>
          <div class="tw-topic">
            <div class="tw-topic__head">
              <span class="tw-topic__name">Medieval</span>
              <span class="tw-topic__size">52</span>
            </div>
            <div class="tw-slot tw-slot--none">too small for its own words</div>
          </div>
        </div>`;
    },
  },

  // Flagged Hosts, open. Its rows carry a name, a standing and free text a
  // player typed, and no other state renders any of that — the flagged-question
  // row shipped for months with two of its three parts unstyled because the
  // only mock used short strings.
  'admin-flagged-hosts': {
    page: 'admin',
    screen: null,
    inherits: 'admin-panels',
    inject: () => {
      document.querySelectorAll('.admin-panel__head').forEach(h => h.setAttribute('aria-expanded', 'false'));
      document.querySelectorAll('.admin-panel__body').forEach(b => { b.hidden = true; });
      const head = document.querySelector('.admin-panel__head[data-panel="hosts"]');
      if (head) head.setAttribute('aria-expanded', 'true');
      const body = document.getElementById('panel-hosts');
      if (body) body.hidden = false;
      const el = document.getElementById('flagged-hosts');
      if (!el) return;
      // Mirrors loadFlaggedHosts() in js/admin.js.
      const rows = [
        ['Wilhelmina-Rose#4417', '22% \u00b7 14 ratings', '3 reports',
         'unfair judging, ended the game early',
         'marked three of my answers wrong when they were right and then quit'],
        ['Jo#0102', 'no rating yet', '1 report', 'other', ''],
      ];
      el.innerHTML = rows.map(([name, standing, count, reasons, note]) => `
        <div class="admin-flag-row">
          <div class="admin-flag-row__text">${name}</div>
          <div class="admin-flag-row__meta">
            <span class="admin-flag-row__answer">${standing}</span>
            <span class="admin-flag-row__count">${count}</span>
            <span class="admin-flag-row__reasons">${reasons}</span>
          </div>
          ${note ? `<div class="admin-flag-row__note">\u201C${note}\u201D</div>` : ''}
        </div>`).join('');
    },
  },

  // The question editor, open. Twelve category chips wrap on a 375px phone
  // and each has to stay a real tap target on its own line, which is exactly
  // the kind of thing that fits in a mock with four chips and breaks with
  // twelve. Mirrors createQuestionRow() in js/admin.js.
  'admin-question-edit': {
    page: 'admin',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const loading = document.getElementById('admin-loading');
      if (loading) loading.style.display = 'none';
      const content = document.getElementById('admin-content');
      if (content) content.style.display = '';

      const head = document.querySelector('.admin-panel__head[data-panel="questions"]');
      if (head) head.setAttribute('aria-expanded', 'true');
      const body = document.getElementById('panel-questions');
      if (body) body.hidden = false;
      const results = document.getElementById('question-results');
      if (!results) return;

      const cats = [
        ['history', 'History'], ['science', 'Science'], ['nature', 'Nature'],
        ['arts-literature', 'Arts & Literature'], ['culture-society', 'Culture & Society'],
        ['pop-culture', 'Pop Culture'], ['world-geography', 'World Geography'],
        ['technology', 'Technology'], ['sports', 'Sports'], ['food', 'Food'],
        ['logic', 'Logic'], ['wild-card', 'Wild Card'],
      ];
      const on = new Set(['culture-society']);
      const chips = cats.map(([k, label]) =>
        `<button type="button" class="admin-cat-chip${on.has(k) ? ' admin-cat-chip--on' : ''}"
                 data-cat="${k}" aria-pressed="${on.has(k)}">${label}</button>`).join('');

      results.innerHTML = `
        <div class="admin-q-row">
          <div class="admin-q-row__summary">
            <div class="admin-q-row__text">Which language has the most native speakers in the world?</div>
            <div class="admin-q-row__meta"><span>culture-society</span><span>open</span><span>medium</span></div>
          </div>
          <div class="admin-q-row__edit">
            <label>Question<textarea class="input admin-q-edit__text" rows="3">Which language has the most native speakers in the world?</textarea></label>
            <label>Answer<input class="input admin-q-edit__answer" value="Mandarin Chinese"></label>
            <label>Alternates (comma-separated)<input class="input admin-q-edit__alts" value="Mandarin, Chinese"></label>
            <div class="admin-q-edit__field">
              <span class="admin-q-edit__label">Categories</span>
              <div class="admin-cat-chips">${chips}</div>
            </div>
            <label>Subcategory<select class="input admin-q-edit__subcategory">
              <option value="language" selected>Language</option>
            </select></label>
            <label>Format<select class="input admin-q-edit__format"><option selected>Open</option></select></label>
            <label>Difficulty<select class="input admin-q-edit__difficulty"><option selected>Medium</option></select></label>
            <button class="btn btn-primary admin-q-edit__save">Save</button>
            <span class="admin-q-edit__status">Saved!</span>
          </div>
        </div>`;
    },
  },

  // The answer-key review, with a flagged row open. The note under a question
  // is the longest run of explanatory text anywhere on this page, and it sits
  // inside a row that also has to fit a question. Mirrors reviewAnswerKeys().
  'admin-answer-review': {
    page: 'admin',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const loading = document.getElementById('admin-loading');
      if (loading) loading.style.display = 'none';
      const content = document.getElementById('admin-content');
      if (content) content.style.display = '';

      const head = document.querySelector('.admin-panel__head[data-panel="questions"]');
      if (head) head.setAttribute('aria-expanded', 'true');
      const body = document.getElementById('panel-questions');
      if (body) body.hidden = false;

      const summary = document.getElementById('q-review-summary');
      if (summary) summary.textContent =
        '22 of 4,859 worth a look — 2 unit abbreviated, 16 exact figure, 4 exact date. '
        + 'Tap one to add the forms people would actually type. These are candidates, not mistakes.';

      const results = document.getElementById('question-results');
      if (!results) return;
      const flagged = [
        ['How tall is One World Trade Center?', '1,776 ft', 'culture-society', 'Unit abbreviated',
         'A player who writes the unit out — "feet" — is marked wrong. Add that spelling as an alternate.'],
        ['In the 1994 movie Speed, what minimum speed must the bus maintain?', '50 mph', 'pop-culture', 'Unit abbreviated',
         'A player who writes the unit out — "miles per hour" — is marked wrong. Add that spelling as an alternate.'],
        ['What are the first 6 digits of Pi?', '3.14159', 'science', 'Exact figure',
         'Digits are matched exactly — no typo tolerance at all — so a rounded or differently-punctuated answer fails. Add the forms people would type.'],
      ];
      results.innerHTML = flagged.map(([q, a, cat, label, why]) => `
        <div class="admin-q-row">
          <div class="admin-q-row__summary">
            <div class="admin-q-row__text">${q}</div>
            <div class="admin-q-row__meta"><span>${cat}</span><span>open</span><span>medium</span></div>
            <p class="admin-review__note">${label} — ${why}</p>
          </div>
        </div>`).join('');
    },
  },

  'admin-drill': {
    page: 'admin',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const loading = document.getElementById('admin-loading');
      if (loading) loading.style.display = 'none';
      const content = document.getElementById('admin-content');
      if (content) content.style.display = '';

      const vals = { 'stat-online': '11', 'stat-games': '3', 'stat-accounts': '11', 'stat-today': '24' };
      for (const [id, v] of Object.entries(vals)) {
        const el = document.getElementById(id);
        if (el) el.textContent = v;
      }

      const counts = {
        flagged: ['4 flags', 'alert'], health: ['612 played', null],
        questions: ['4,782', null], games: ['1,204', null],
        errors: ['None · 7d', null], chat: ['38', null],
        announcement: ['Off', null], flags: ['Off', null],
      };
      for (const [key, [text, tone]] of Object.entries(counts)) {
        const el = document.querySelector(`[data-count="${key}"]`);
        if (!el) continue;
        el.textContent = text;
        if (tone) el.classList.add(`admin-panel__count--${tone}`);
      }
      const card = document.querySelector('[data-drill="accounts"]');
      if (card) card.classList.add('admin-stat-card--open');

      const panel = document.getElementById('stat-drill');
      if (panel) panel.classList.remove('hidden');
      const title = document.getElementById('stat-drill-title');
      if (title) title.textContent = 'Accounts';
      const body = document.getElementById('stat-drill-body');
      if (!body) return;
      // Mirrors drillAccounts() in js/admin.js. Change both together.
      //
      // The second row is shown OPEN, with its detail panel. That panel holds
      // an email, which is the longest unbreakable string this layout ever has
      // to fit next to a label on a 375px phone — exactly the thing worth
      // rendering rather than assuming.
      const rows = [
        ['ArchaeologistAnna', '4821', '31 games · 8 sessions · Aug 3, 14:22', 'you'],
        ['TimeTraveler42', '0917', '12 games · 3 sessions · Aug 7, 09:05', 'del'],
        ['New Player', '3310', 'never played · Aug 11, 21:47 · never set a name', 'del'],
        ['QuizMasterMax', '5566', '4 games · 4 sessions · Aug 14, 18:30', 'admin'],
      ];
      const detail = [
        ['Email', 'bartholomew.kensington-smythe@verylongdomainname.example.com'],
        ['Signed up with', 'Google'],
        ['Email confirmed', 'No — never confirmed'],
        ['Last signed in', 'Aug 7, 09:06'],
        ['Games played', '12'],
        ['Sessions', '3'],
        ['Wins', '4'],
        ['Last played', 'Aug 12, 20:14'],
        ['Plays most', 'History (7), Pop Culture (3), Science (2)'],
      ].map(([k, v]) =>
        `<div class="account-detail__row">
           <span class="account-detail__key">${k}</span>
           <span class="account-detail__val">${v}</span>
         </div>`).join('');

      body.innerHTML = rows.map(([name, disc, at, kind], i) => {
        const action = kind === 'del'
          ? '<button class="btn-danger stat-drill__action">Delete</button>'
          : `<span class="stat-drill__meta">${kind}</span>`;
        const open = i === 1;
        return `<div class="stat-drill__row stat-drill__row--openable${open ? ' stat-drill__row--open' : ''}">
          <span class="stat-drill__name">${name}<span class="stat-drill__tag">#${disc}</span></span>
          <span class="stat-drill__meta">${at}</span>
          ${action}
        </div>` + (open ? `<div class="account-detail">${detail}</div>` : '');
      }).join('');
    },
  },

  // The title collection, which nobody could see at all before: the builder was
  // a padlock and the 40 words behind it were unreachable until you had already
  // got in. All three card states are rendered — earned, locked with its hint,
  // and secret — because the hint is the longest text on the screen and two
  // columns at 375px is where it has to fit.
  'title-gallery': {
    page: 'profile',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const gallery = document.getElementById('title-gallery');
      if (!gallery) return;
      gallery.hidden = false;

      const summary = document.getElementById('title-gallery-summary');
      if (summary) summary.textContent = '6 of 40 earned. A locked one shows what to do, not the word.';

      // MIRRORS galleryCard IN js/profile.js. Every card carries a "how" line
      // now — a riddle is right for a secret and wrong for everything else —
      // and Standing is two groups rather than one pile. If that renderer
      // changes, change this in the same commit or the sweep reviews a screen
      // that no longer ships.
      const slots = [
        ['Playstyle', 'How you play — winning, streaks, showing up, hosting.', 2, 10, [
          ['earned', 'Seasoned', 'common', 'Play 50 games'],
          ['earned', 'Relentless', 'rare', 'Win 10 games in a row'],
          ['locked', '——', 'rare', 'Play on 7 days running'],
          ['locked', '——', 'common', 'Receive 100 honks'],
          ['locked', '——', 'rare', 'Host 20 games'],
          ['secret', '❓', 'legendary', 'Find it yourself'],
        ], null],
        ['Knowledge', 'What you know. Earned by getting questions right in a subject.', 3, 20, [
          ['earned', 'History', 'common', '10 right'],
          ['earned', 'Chronicles', 'uncommon', '15 right in Ancient'],
          ['locked', '——', 'uncommon', '82 right in Modern'],
          ['locked', '——', 'legendary', '327 right in Modern'],
        ], '🏛️ History<span class="title-gallery__group-count">2 / 4</span>'],
        [null, null, 0, 0, [
          ['locked', '——', 'common', '10 right'],
        ], '🔬 Science<span class="title-gallery__group-count">0 / 1</span>'],
        ['Standing', 'The rank you have reached, and one-off feats.', 1, 8, [
          ['earned', 'Apprentice', 'common', 'Reach Apprentice in any subject'],
          ['locked', '——', 'rare', 'Reach Scholar in any subject'],
        ], 'Rank in your best subject'],
        [null, null, 0, 0, [
          ['locked', '——', 'rare', 'Win 25 games'],
          ['locked', '——', 'rare', 'Report 10 bad questions'],
          ['secret', '❓', 'legendary', 'Find it yourself'],
        ], 'One-off feats'],
      ];

      const body = document.getElementById('title-gallery-body');
      if (!body) return;
      // MIRRORS galleryRow IN js/profile.js. Rows, not cards — the two-column
      // grid of ~200px boxes was reviewed on a real phone and was clunky,
      // uncompact and showed no structure. If that renderer changes, change
      // this in the same commit or the sweep reviews a screen that never ships.
      const cardsOf = cards => `<div class="title-rows">${cards.map(([state, word, rarity, how]) => `
        <div class="title-row title-row--${state === 'earned' ? 'earned' : 'locked'}" data-rarity="${rarity}">
          <span class="title-row__word">${word}</span>
          <span class="title-row__how">${how || ''}</span>
          <span class="title-row__mark">${state === 'earned' ? '✓' : state === 'secret' ? '' : '🔒'}</span>
        </div>`).join('')}</div>`;
      body.innerHTML = slots.map(([name, blurb, got, total, cards, group]) => {
        const head = name ? `
          <div class="title-gallery__slot-head">
            <span class="title-gallery__slot-name">${name}</span>
            <span class="title-gallery__slot-count">${got} / ${total}</span>
          </div>
          <p class="title-gallery__slot-blurb">${blurb}</p>` : '';
        const groupLine = group ? `<p class="title-gallery__group">${group}</p>` : '';
        return name
          ? `<section class="title-gallery__slot">${head}${groupLine}${cardsOf(cards)}</section>`
          : `${groupLine}${cardsOf(cards)}`;
      }).join('');
    },
  },

  // The moment you earn something. Both loud tiers are rendered, because they
  // are different shapes: fullscreen dims the game and carries a dismiss
  // button, the quieter one floats and must not swallow taps.
  'celebration-legendary': {
    page: 'game',
    screen: 'scores-screen',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const el = document.createElement('div');
      el.id = 'title-celebration';
      el.className = 'celebration celebration--in';
      el.dataset.tier = 'fullscreen';
      el.dataset.rarity = 'legendary';
      el.innerHTML = `
        <div class="celebration__card">
          <div class="celebration__kicker">legendary</div>
          <div class="celebration__word">Antiquity</div>
          <div class="celebration__sub">added to your titles</div>
          <div class="celebration__why">Get 58 questions right in Ancient &amp; Classical Civilisations</div>
          <div class="celebration__more">+2 more unlocked</div>
          <button type="button" class="celebration__dismiss">Nice</button>
        </div>`;
      document.body.appendChild(el);
    },
  },

  'celebration-common': {
    page: 'game',
    screen: 'scores-screen',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const el = document.createElement('div');
      el.id = 'title-celebration';
      el.className = 'celebration celebration--in';
      el.dataset.tier = 'toast';
      el.dataset.rarity = 'common';
      // An UPGRADE, which is a different sentence from a first unlock —
      // "Brave II" is not a new word and must not claim to be.
      el.innerHTML = `
        <div class="celebration__card">
          <div class="celebration__kicker">Level 2</div>
          <div class="celebration__word">Relentless</div>
          <button type="button" class="celebration__dismiss">Nice</button>
        </div>`;
      document.body.appendChild(el);
    },
  },

  // ==========================================
  // PRIVACY.HTML
  //
  // Long-form reading, which nothing else in this app is, so it has its own
  // type rules and therefore its own way to go wrong. It is also the page a
  // stranger is most likely to open on a phone in daylight.
  // ==========================================
  // ==========================================
  // LEADERBOARD
  //
  // leaderboard.html had NO mock at all, so the sweep had never rendered it —
  // not once, in any theme, at any width. That is the same gap that shipped a
  // bare unstyled back button on Profile and Leaderboard, and an admin flag row
  // that fitted only the two short strings a mock would have used.
  //
  // Two states, because the rows differ: the global board carries a points
  // figure, and the CATEGORY board carries a percentage plus the longest
  // secondary line in the app ("120 Qs met · 96 known"). Names and titles are
  // deliberately long — a row that only fits its mock data is one real display
  // name away from breaking.
  // ==========================================
  // The board is one list now: you and your friends, ranked on mastery or on
  // proficiency. Both mocks exist because they render DIFFERENT stats in the
  // same slots — a count against a percentage — and only rendering one would
  // leave the other unreviewed at 375px.
  'leaderboard-mastered': {
    page: 'leaderboard',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const row = (rank, name, title, primary, secondary, me) => `
        <div class="leaderboard-row${me ? ' leaderboard-row--me' : ''}">
          <span class="leaderboard-rank">${rank}</span>
          <div class="avatar" style="width:28px;height:28px;background:#A87830;">\u{1F98A}</div>
          <div class="leaderboard-row__info">
            <div class="leaderboard-row__name">${name}</div>
            <div class="leaderboard-row__title">${title}</div>
          </div>
          <div class="leaderboard-row__stats">
            <div class="leaderboard-row__primary">${primary}</div>
            <div class="leaderboard-row__secondary">${secondary}</div>
          </div>
        </div>`;
      const note = document.getElementById('lb-scope-note');
      if (note) note.textContent = 'You and 3 friends. Questions you currently get right, counted once each.';
      const list = document.getElementById('lb-list');
      if (list) {
        list.innerHTML = [
          row(1, 'Bartholomew', 'Relentless Oracle of Antiquity', '412', '486 met', false),
          row(2, 'Sam', 'Novice', '188', '240 met', true),
          row(3, 'Wilhelmina-Rose', 'Seasoned Scholar of the Atomic Age', '96', '133 met', false),
          row(4, 'Jo', 'Apprentice', '11', '19 met', false),
        ].join('');
      }
    },
  },

  // What a brand-new player actually sees: no friends yet. The longest string
  // this page renders, and the first thing anybody signing up will read.
  'leaderboard-no-friends': {
    page: 'leaderboard',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const note = document.getElementById('lb-scope-note');
      if (note) note.textContent = 'Just you so far \u2014 add friends to compare. Questions you currently get right, counted once each.';
      const list = document.getElementById('lb-list');
      if (list) {
        list.innerHTML = '<p class="leaderboard-empty">Add friends to build a leaderboard. Tap a signed-in player in a lobby to send a request \u2014 they accept it from their own profile.</p>';
      }
    },
  },

  'leaderboard-proficiency': {
    page: 'leaderboard',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      document.querySelectorAll('.profile-tab').forEach(t => {
        const on = t.dataset.measure === 'proficiency';
        t.classList.toggle('active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      // A category is chosen, so the subcategory menu is showing. That row is
      // three controls wide at 375px and exists in no other state.
      const sub = document.getElementById('lb-subcategory-select');
      if (sub) {
        sub.style.display = '';
        sub.innerHTML = '<option>Ancient &amp; Classical</option>';
      }
      const period = document.getElementById('lb-period-select');
      if (period) period.style.display = '';
      const row = (rank, name, title, primary, secondary, me) => `
        <div class="leaderboard-row${me ? ' leaderboard-row--me' : ''}">
          <span class="leaderboard-rank">${rank}</span>
          <div class="avatar" style="width:28px;height:28px;background:#4A7C59;">\u{1F989}</div>
          <div class="leaderboard-row__info">
            <div class="leaderboard-row__name">${name}</div>
            <div class="leaderboard-row__title">${title}</div>
          </div>
          <div class="leaderboard-row__stats">
            <div class="leaderboard-row__primary">${primary}</div>
            <div class="leaderboard-row__secondary">${secondary}</div>
          </div>
        </div>`;
      const note = document.getElementById('lb-scope-note');
      if (note) note.textContent = 'You and 3 friends. Share of the questions you have met that you currently get right. Needs 10+ met to appear.';
      const list = document.getElementById('lb-list');
      if (list) {
        list.innerHTML = [
          row(1, 'Bartholomew', 'Relentless Oracle of Antiquity', '94%', '233 of 248 known', false),
          row(2, 'Sam', 'Keeper of Secrets', '72%', '86 of 120 known', true),
          row(3, 'Wilhelmina-Rose', 'Seasoned Scholar', '51%', '30 of 60 known', false),
        ].join('');
      }
    },
  },

  'privacy': {
    page: 'privacy',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
    },
  },

  // ==========================================
  // PROFILE.HTML
  //
  // The profile page had NO mock at all, so nothing measured it — the layout
  // sweep only sees what is rendered here. This covers the account box,
  // because that is where the irreversible control lives and an irreversible
  // control that has never been measured on a phone is the wrong one to guess
  // about.
  // ==========================================
  // The three number sections of a profile, with data in them. Until now the
  // only profile mock filled the Account section, so Stats, Mastery and
  // Proficiency have never once been rendered by the sweep — the same gap that
  // let .page-header__back ship with no CSS rule at all.
  //
  // Mastery and Proficiency are both percentages and they measure different
  // things: Mastery is how much of the 4,859-question bank you have got right
  // at least once (so it sits near 1% for a long time and that is correct),
  // Proficiency is how often you are right in a category. Seeing them together
  // is the point of this state.
  //
  // Mirrors the masteryEl / categoriesEl / statsEl innerHTML blocks in
  // js/profile.js. If those change, change this in the same commit.
  'profile-stats': {
    page: 'profile',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

      // The honeycomb, inlined because inject() is serialised into the browser
      // and cannot import js/honeycomb.js. Kept in step with it by hand — if
      // the real geometry changes, this has to change in the same commit or
      // the sweep is reviewing a shape that never ships.
      function hexmap(items, cols, label, showEmptyState) {
        const SQ = Math.sqrt(3), S = 40, W = SQ * S, VSTEP = 1.5 * S;
        const n = items.length, rows = Math.ceil(n / cols);
        const usable = cols * W + (rows > 1 ? W / 2 : 0);
        const vh = (rows - 1) * VSTEP + 2 * S;
        // Whole-cell shifts only: a short row centred exactly lands off the
        // half-step and its hexes overlap instead of tessellating.
        const leftOf = (row, inRow) => {
          const stagger = (rows > 1 && row % 2) ? W / 2 : 0;
          if (inRow >= cols || rows < 2) return stagger;
          return stagger + Math.max(0, Math.round(((usable - inRow * W) / 2 - stagger) / W)) * W;
        };
        let vw = 0;
        for (let r = 0; r < rows; r++) {
          const inRow = Math.min(cols, n - r * cols);
          vw = Math.max(vw, leftOf(r, inRow) + inRow * W);
        }
        const pts = (cx, cy) => {
          const out = [];
          for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 180) * (60 * k - 90);
            out.push((cx + S * Math.cos(a)).toFixed(2) + ',' + (cy + S * Math.sin(a)).toFixed(2));
          }
          return out.join(' ');
        };
        let clips = '', gs = '';
        for (let i = 0; i < n; i++) {
          const row = Math.floor(i / cols), col = i % cols;
          const inRow = Math.min(cols, n - row * cols);
          const cx = leftOf(row, inRow) + col * W + W / 2, cy = row * VSTEP + S;
          const [emoji, name, done, total] = items[i];
          const f = (total > 0 && done > 0) ? Math.max(0.06, Math.min(1, done / total)) : 0;
          const h = 2 * S * f;
          clips += '<clipPath id="hexclip-' + i + '"><polygon points="' + pts(cx, cy) + '"/></clipPath>';
          gs += '<g class="hexcell' + (f > 0 ? '' : ' hexcell--empty') + (showEmptyState ? ' hexcell--open' : '') + '" data-key="k' + i + '">'
            + '<polygon class="hexcell__bg" points="' + pts(cx, cy) + '"/>'
            + (h > 0 ? '<rect class="hexcell__fill" clip-path="url(#hexclip-' + i + ')" x="' + (cx - W / 2).toFixed(2) + '" y="' + (cy + S - h).toFixed(2) + '" width="' + W.toFixed(2) + '" height="' + h.toFixed(2) + '"/>' : '')
            + '<polygon class="hexcell__edge" points="' + pts(cx, cy) + '"/>'
            + '<text class="hexcell__emoji" x="' + cx.toFixed(2) + '" y="' + (cy - S * 0.16).toFixed(2) + '" text-anchor="middle" dominant-baseline="central">' + emoji + '</text>'
            + (done > 0 ? '<text class="hexcell__count" x="' + cx.toFixed(2) + '" y="' + (cy + S * 0.42).toFixed(2) + '" text-anchor="middle" dominant-baseline="central">' + done + '</text>' : '')
            + '<title>' + name + '</title></g>';
        }
        return '<svg viewBox="0 0 ' + vw.toFixed(2) + ' ' + vh.toFixed(2) + '" role="img" aria-label="' + label + '"><defs>' + clips + '</defs>' + gs + '</svg>';
      }


      const name = document.getElementById('profile-name');
      if (name) name.textContent = 'ArchaeologistAnna';
      const title = document.getElementById('profile-title');
      if (title) title.textContent = 'Seasoned Scholar';

      const statsEl = document.getElementById('profile-stats');
      if (statsEl) {
        statsEl.innerHTML = [
          ['47', 'Games'], ['12', 'Wins'], ['26%', 'Win Rate'],
          ['68%', 'Accuracy'], ['⏳', 'Strongest'], ['⚗️', 'Weakest'],
        ].map(([v, l]) =>
          `<div class="profile-stat"><div class="profile-stat__value">${v}</div><div class="profile-stat__label">${l}</div></div>`
        ).join('');
      }

      const masteryEl = document.getElementById('profile-mastery');
      if (masteryEl) {
        const cats = [
          ['⏳', 'History', 84, 412, 20],
          ['⚗️', 'Science', 31, 388, 8],
          ['🎬', 'Pop Culture', 12, 355, 3],
        ];
        masteryEl.innerHTML = `
          <div class="mastery-summary">
            <div class="mastery-summary__text">127 / 4,859 questions mastered</div>
            <div class="mastery-bar"><div class="mastery-bar__fill" style="width: 3%"></div></div>
          </div>
        ` + cats.map(([icon, label, mastered, total, pct], i) => `
          <div class="mastery-group" data-cat="c${i}">
            <div class="mastery-row${i === 0 ? ' mastery-row--expandable' : ''}">
              <span class="mastery-row__icon">${icon}</span>
              <span class="mastery-row__name">${label}</span>
              <span class="mastery-row__fraction">${mastered}/${total}</span>
              <div class="mastery-bar mastery-bar--inline"><div class="mastery-bar__fill" style="width: ${pct}%"></div></div>
              ${i === 0 ? '<span class="mastery-row__chevron">›</span>' : ''}
            </div>
            ${i === 0 ? `<div class="mastery-sub-rows">
              <div class="mastery-row mastery-row--sub">
                <span class="mastery-row__icon">🏛️</span>
                <span class="mastery-row__name">Ancient World</span>
                <span class="mastery-row__fraction">38/104</span>
              </div>
            </div>` : ''}
          </div>
        `).join('');
      }

      // The Map, at the top level. Mirrors renderMasteryMap / js/honeycomb.js.
      // The numbers are deliberately realistic against a 4,859-question bank,
      // which means most cells are a sliver and four are empty — that is what
      // this actually looks like and it is the thing worth reviewing.
      const mapSection = document.getElementById('profile-map-section');
      const mapEl = document.getElementById('profile-map');
      if (mapSection && mapEl) {
        mapSection.style.display = '';
        const HEX = [
          ['⏳', 'History', 84, 412], ['⚗️', 'Science', 31, 388],
          ['🌿', 'Nature', 0, 301], ['📜', 'Arts & Literature', 9, 366],
          ['🏛️', 'Culture & Society', 22, 344], ['🎬', 'Pop Culture', 12, 355],
          ['🌍', 'World Geography', 0, 402], ['💻', 'Technology', 41, 288],
          ['⚽', 'Sports', 3, 331], ['🍕', 'Food & Drink', 0, 276],
          ['🧩', 'Logic', 7, 219], ['🃏', 'Wild Card', 0, 397],
        ];
        mapEl.innerHTML = hexmap(HEX, 4, 'Mastery by category', true);
        const cap = document.getElementById('profile-map-caption');
        if (cap) cap.textContent = '209 of 4,859 mastered · tap a cell to look inside';
      }

      // The radar, with a realistic mix: some strong, some weak, several never
      // tried. The untried ones are the case worth rendering — they must read
      // as "not yet" rather than as a zero score.
      const radarSection = document.getElementById('profile-radar-section');
      const radarEl = document.getElementById('profile-radar');
      if (radarSection && radarEl) {
        radarSection.style.display = '';
        const AX = [
          ['⏳', 0.81], ['⚗️', 0.64], ['🌿', 0.0], ['📜', 0.42],
          ['🏛️', 0.55], ['🎬', 0.43], ['🌍', 0.0], ['💻', 0.71],
          ['⚽', 0.18], ['🍕', 0.0], ['🧩', 0.6], ['🃏', 0.33],
        ];
        const V = 100, R = 34, LR = 44, C = V / 2, n = AX.length;
        const pts = (val, radius) => AX.map((a, i) => {
          const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
          const r = (val === null ? a[1] : val) * radius;
          return `${(C + Math.cos(ang) * r).toFixed(2)},${(C + Math.sin(ang) * r).toFixed(2)}`;
        }).join(' ');
        const rings = [0.25, 0.5, 0.75, 1]
          .map(f => `<polygon class="radar__ring" points="${pts(f, R)}"/>`).join('');
        const spokes = pts(1, R).split(' ')
          .map(p => `<line class="radar__spoke" x1="${C}" y1="${C}" x2="${p.split(',')[0]}" y2="${p.split(',')[1]}"/>`).join('');
        const dots = pts(null, R).split(' ').map((p, i) => AX[i][1] > 0
          ? `<circle class="radar__dot" cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="1.6"/>` : '').join('');
        const labels = pts(1, LR).split(' ').map((p, i) =>
          `<text class="radar__label${AX[i][1] > 0 ? '' : ' radar__label--untried'}" x="${p.split(',')[0]}" y="${p.split(',')[1]}" text-anchor="middle" dominant-baseline="central">${AX[i][0]}</text>`).join('');
        // The shape spans only the axes with data — mirrors renderRadarSvg.
        // Joining untried categories at the centre crossed the outline into a
        // jagged star that read as broken rather than as a profile.
        const playedPts = pts(null, R).split(' ').filter((_, i) => AX[i][1] > 0).join(' ');
        radarEl.innerHTML = `<svg viewBox="0 0 ${V} ${V}" role="img" aria-label="Proficiency by category">${rings}${spokes}<polygon class="radar__shape" points="${playedPts}"/>${dots}${labels}</svg>`;
        const cap = document.getElementById('profile-radar-caption');
        if (cap) cap.textContent = 'Strongest History 81% · weakest Sports 18% · 3 not tried yet';
      }

      const catsEl = document.getElementById('profile-categories');
      if (catsEl) {
        // Sorted strongest first, each carrying the rank line — mirrors the
        // real render. All four states of that line are represented, because
        // the longest of them is what decides whether the row still fits: a
        // rank plus a target, the volume gate, the top rank, and none at all.
        const rows = [
          ['⏳', 'History', 81, 'Scholar · 12 more correct → Master'],
          ['🌍', 'World Geography', 74, 'Oracle · highest rank'],
          ['⚗️', 'Science', 64, 'Apprentice · 17 more correct → Scholar'],
          ['🎬', 'Pop Culture', 43, '14 more questions for a rank'],
        ];
        catsEl.innerHTML = rows.map(([icon, label, acc, rank], i) => `
          <div class="profile-category-group" data-category="c${i}">
            <div class="profile-category-row${i === 0 ? ' profile-category-row--expandable' : ''}">
              <span>${icon}</span>
              <span class="profile-category-row__name">${label}<div class="profile-category-row__rank">${rank}</div></span>
              <span class="profile-category-row__accuracy">${acc}%</span>
              ${i === 0 ? '<span class="profile-category-row__chevron">›</span>' : ''}
            </div>
            ${i === 0 ? `<div class="profile-subcategory-rows">
              <div class="profile-category-row profile-category-row--sub">
                <span>🏺</span>
                <span class="profile-category-row__name">Ancient</span>
                <span class="profile-category-row__accuracy">77%</span>
              </div>
              <div class="profile-category-row profile-category-row--sub">
                <span>⚔️</span>
                <span class="profile-category-row__name">Medieval</span>
                <span class="profile-category-row__accuracy">61%</span>
              </div>
            </div>` : ''}
          </div>
        `).join('');
      }

      const tabContent = document.getElementById('profile-tab-content');
      if (tabContent) tabContent.style.display = '';
    },
  },

  // The Map opened into one category. A state of its own because the back
  // button and the category name only exist here — the top-level map in
  // profile-stats renders neither, so nothing was checking that the row fits
  // its own contents at 375px. That is exactly how the lobby overflowed.
  'mastery-map-drilled': {
    page: 'profile',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const name = document.getElementById('profile-name');
      if (name) name.textContent = 'ArchaeologistAnna';

      const mapSection = document.getElementById('profile-map-section');
      const mapEl = document.getElementById('profile-map');
      if (!mapSection || !mapEl) return;
      mapSection.style.display = '';

      // Same geometry as profile-stats; see the note there.
      function hexmap(items, cols, label) {
        const SQ = Math.sqrt(3), S = 40, W = SQ * S, VSTEP = 1.5 * S;
        const n = items.length, rows = Math.ceil(n / cols);
        const usable = cols * W + (rows > 1 ? W / 2 : 0);
        const vh = (rows - 1) * VSTEP + 2 * S;
        // Whole-cell shifts only: a short row centred exactly lands off the
        // half-step and its hexes overlap instead of tessellating.
        const leftOf = (row, inRow) => {
          const stagger = (rows > 1 && row % 2) ? W / 2 : 0;
          if (inRow >= cols || rows < 2) return stagger;
          return stagger + Math.max(0, Math.round(((usable - inRow * W) / 2 - stagger) / W)) * W;
        };
        let vw = 0;
        for (let r = 0; r < rows; r++) {
          const inRow = Math.min(cols, n - r * cols);
          vw = Math.max(vw, leftOf(r, inRow) + inRow * W);
        }
        const pts = (cx, cy) => {
          const out = [];
          for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 180) * (60 * k - 90);
            out.push((cx + S * Math.cos(a)).toFixed(2) + ',' + (cy + S * Math.sin(a)).toFixed(2));
          }
          return out.join(' ');
        };
        let clips = '', gs = '';
        for (let i = 0; i < n; i++) {
          const row = Math.floor(i / cols), col = i % cols;
          const inRow = Math.min(cols, n - row * cols);
          const cx = leftOf(row, inRow) + col * W + W / 2, cy = row * VSTEP + S;
          const [emoji, nm, done, total] = items[i];
          const f = (total > 0 && done > 0) ? Math.max(0.06, Math.min(1, done / total)) : 0;
          const h = 2 * S * f;
          clips += '<clipPath id="hexclip-' + i + '"><polygon points="' + pts(cx, cy) + '"/></clipPath>';
          gs += '<g class="hexcell' + (f > 0 ? '' : ' hexcell--empty') + '" data-key="k' + i + '">'
            + '<polygon class="hexcell__bg" points="' + pts(cx, cy) + '"/>'
            + (h > 0 ? '<rect class="hexcell__fill" clip-path="url(#hexclip-' + i + ')" x="' + (cx - W / 2).toFixed(2) + '" y="' + (cy + S - h).toFixed(2) + '" width="' + W.toFixed(2) + '" height="' + h.toFixed(2) + '"/>' : '')
            + '<polygon class="hexcell__edge" points="' + pts(cx, cy) + '"/>'
            + '<text class="hexcell__emoji" x="' + cx.toFixed(2) + '" y="' + (cy - S * 0.16).toFixed(2) + '" text-anchor="middle" dominant-baseline="central">' + emoji + '</text>'
            + (done > 0 ? '<text class="hexcell__count" x="' + cx.toFixed(2) + '" y="' + (cy + S * 0.42).toFixed(2) + '" text-anchor="middle" dominant-baseline="central">' + done + '</text>' : '')
            + '<title>' + nm + '</title></g>';
        }
        return '<svg viewBox="0 0 ' + vw.toFixed(2) + ' ' + vh.toFixed(2) + '" role="img" aria-label="' + label + '"><defs>' + clips + '</defs>' + gs + '</svg>';
      }

      // Culture & Society — the longest category name in the game, and five
      // subcategories, so this is the widest the head row ever gets.
      const SUBS = [
        ['🗣️', 'Language', 14, 96], ['⚖️', 'Politics & Law', 0, 88],
        ['🕌', 'Religion & Belief', 5, 74], ['💰', 'Economics', 3, 51],
        ['👥', 'Society', 0, 35],
      ];
      mapEl.innerHTML =
        '<div class="hexmap__head">'
        + '<button type="button" class="hexmap__back" id="profile-map-back">‹ All categories</button>'
        + '<span class="hexmap__title">\u{1F3DB}️ Culture &amp; Society</span>'
        + '</div>'
        + hexmap(SUBS, 3, 'Mastery in Culture & Society');
      const cap = document.getElementById('profile-map-caption');
      if (cap) cap.textContent = '22 of 344 mastered in Culture & Society';

      const tabContent = document.getElementById('profile-tab-content');
      if (tabContent) tabContent.style.display = '';
    },
  },

  'profile-account': {
    page: 'profile',
    screen: null,
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      const name = document.getElementById('profile-name');
      if (name) name.textContent = 'ArchaeologistAnna';
      const acct = document.getElementById('profile-account');
      if (!acct) return;
      // Mirrors the accountEl.innerHTML block in js/profile.js. If that
      // changes, change this in the same commit.
      acct.innerHTML = `
        <div class="profile-toggle">
          <span>Show Online Status</span>
          <label class="profile-switch">
            <input type="checkbox" checked>
            <span class="profile-switch__slider"></span>
          </label>
        </div>
        <div class="profile-toggle">
          <span>OLED Black Mode</span>
          <label class="profile-switch">
            <input type="checkbox">
            <span class="profile-switch__slider"></span>
          </label>
        </div>
        <p style="color: var(--color-text-dim); font-size: var(--text-sm); margin: var(--space-md) 0 var(--space-sm);">archaeologist.anna@example.com</p>
        <button class="btn btn-secondary btn-block">Sign Out</button>
        <div class="danger-zone">
          <div class="danger-zone__title">Delete Account</div>
          <p class="danger-zone__text">
            Permanently removes your account, stats, history, titles and friends.
            This cannot be undone and you will not be able to sign in again.
          </p>
          <button class="btn btn-danger btn-block">Delete Account</button>
        </div>
      `;
      const tabContent = document.getElementById('profile-tab-content');
      if (tabContent) tabContent.style.display = '';
    },
  },

  // The confirmation half, which is the state a player is actually in when
  // they are one tap from destroying their account.
  'profile-delete-confirm': {
    page: 'profile',
    screen: null,
    inherits: 'profile-account',
    inject: () => {
      const zone = document.querySelector('.danger-zone');
      if (!zone) return;
      const btn = zone.querySelector('.btn-danger');
      if (btn) btn.remove();
      const box = document.createElement('div');
      box.innerHTML = `
        <p class="danger-zone__text">Type <strong>DELETE</strong> to confirm.</p>
        <input type="text" class="input" value="DELETE">
        <button class="btn btn-danger btn-block" style="margin-top: var(--space-sm);">Permanently Delete</button>
        <button class="btn btn-secondary btn-block" style="margin-top: var(--space-xs);">Cancel</button>
      `;
      zone.appendChild(box);
    },
  },

  'display-name-modal': {
    page: 'game',
    screen: 'question-screen',
    inject: () => {
      const modal = document.getElementById('display-name-modal');
      if (modal) { modal.style.display = ''; modal.classList.add('active'); }
      document.getElementById('question-text').textContent = 'What ancient wonder was located in the city of Babylon?';
    },
  },

  'host-settings-sheet': {
    page: 'game',
    screen: 'question-screen',
    inject: () => {
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');
      document.getElementById('question-category').textContent = '⏳ History';
      document.getElementById('question-progress').textContent = 'Question 3 of 10';
      document.getElementById('question-text').textContent = 'What ancient wonder was located in the city of Babylon?';
      const sheet = document.getElementById('host-settings-sheet');
      if (sheet) sheet.classList.add('active');
      const ap = document.querySelector('[data-game-setting="autoProceed"] [data-value="0"]');
      if (ap) ap.classList.add('active');
      const qt = document.querySelector('[data-game-setting="questionTimer"] [data-value="30"]');
      if (qt) qt.classList.add('active');
    },
  },

  'chat-open': {
    page: 'game',
    screen: 'reveal-screen',
    injectArgs: () => PLAYERS,
    inject: (P) => {
      function av(p, x) { return '<div class="avatar' + (x||'') + '" style="background:' + p.color + '">' + p.emoji + '</div>'; }
      document.querySelectorAll('.modal-overlay').forEach(m => m.style.display = 'none');

      document.getElementById('reveal-category').textContent = '⏳ History';
      document.getElementById('reveal-progress').textContent = 'Question 3 of 10';
      document.getElementById('reveal-question-text').textContent = 'What ancient wonder was located in the city of Babylon?';
      document.getElementById('reveal-answer').textContent = 'Hanging Gardens';

      const drawer = document.getElementById('chat-drawer');
      if (drawer) drawer.classList.add('open');
      const messages = document.getElementById('chat-drawer-messages');
      if (messages) {
        messages.innerHTML =
          '<div class="chat-row"><div class="avatar-wrap">' + av(P[2],' avatar--chat') + '</div><div class="chat-bubble"><strong>' + P[2].name + '</strong> Great question! 🎯</div></div>' +
          '<div class="chat-row"><div class="avatar-wrap">' + av(P[4],' avatar--chat') + '</div><div class="chat-bubble"><strong>' + P[4].name + '</strong> I was so close!</div></div>' +
          '<div class="chat-row"><div class="avatar-wrap">' + av(P[0],' avatar--chat') + '</div><div class="chat-bubble"><strong>' + P[0].name + '</strong> Nice round everyone 👏</div></div>' +
          '<div class="chat-row"><div class="avatar-wrap">' + av(P[1],' avatar--chat') + '</div><div class="chat-bubble"><strong>' + P[1].name + '</strong> History is my weakness 😅</div></div>';
      }

      const bar = document.getElementById('chat-bar');
      if (bar) bar.classList.remove('hidden');
    },
  },
};
