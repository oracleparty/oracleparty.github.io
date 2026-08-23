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
      const games = [
        { host: 'CaptainTrivia', icon: '⏳', cat: 'History \u00b7 10Q \u00b7 30s', code: 'ABCD', players: '4 players', statusClass: 'lobby', statusText: 'In Lobby' },
        { host: 'QuizWhiz', icon: '⚗️', cat: 'Science \u00b7 15Q \u00b7 45s', code: 'EFGH', players: '2 players', statusClass: 'lobby', statusText: 'In Lobby' },
        { host: 'BrainStorm', icon: '🃏', cat: 'Wild Card \u00b7 20Q \u00b7 30s', code: 'IJKL', players: '6 players', statusClass: 'playing', statusText: 'In Progress' },
      ];
      container.innerHTML = games.map(g => `
        <button class="public-game-row" data-code="${g.code}">
          <span class="public-game-row__icon">${g.icon}</span>
          <div class="public-game-row__info">
            <div class="public-game-row__host">${g.host}'s game</div>
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
      document.getElementById('reveal-difficulty').textContent = 'Medium';
      // Base class only. `reveal__difficulty--medium` was invented here and
      // exists in neither the app nor the stylesheet — reveal.js in fact hides
      // this element outright.
      document.getElementById('reveal-difficulty').className = 'reveal__difficulty';
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

  // ==========================================
  // PRIVACY.HTML
  //
  // Long-form reading, which nothing else in this app is, so it has its own
  // type rules and therefore its own way to go wrong. It is also the page a
  // stranger is most likely to open on a phone in daylight.
  // ==========================================
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

      const catsEl = document.getElementById('profile-categories');
      if (catsEl) {
        const rows = [['⏳', 'History', 81], ['⚗️', 'Science', 64], ['🎬', 'Pop Culture', 43]];
        catsEl.innerHTML = rows.map(([icon, label, acc], i) => `
          <div class="profile-category-group" data-category="c${i}">
            <div class="profile-category-row${i === 0 ? ' profile-category-row--expandable' : ''}">
              <span>${icon}</span>
              <span class="profile-category-row__name">${label}</span>
              <span class="profile-category-row__accuracy">${acc}%</span>
              ${i === 0 ? '<span class="profile-category-row__chevron">›</span>' : ''}
            </div>
            ${i === 0 ? `<div class="profile-subcategory-rows">
              <div class="profile-category-row profile-category-row--sub">
                <span>🏛️</span>
                <span class="profile-category-row__name">Ancient World</span>
                <span class="profile-category-row__accuracy">77%</span>
              </div>
            </div>` : ''}
          </div>
        `).join('');
      }

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
