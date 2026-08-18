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
        const sub = (p.tier ? '<span class="player-tier" data-tier="' + p.tier.toLowerCase() + '">' + p.tier + '</span>' : '')
                  + (p.title ? '<span class="player-title">' + p.title + '</span>' : '');
        // The host sees action buttons on everyone but themselves.
        const actions = p.isHost ? '' :
          '<button class="honk-btn" aria-label="Quack">\u{1F986}</button>'
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
      ].map(p => row(p, { ready: false })).join('');

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
