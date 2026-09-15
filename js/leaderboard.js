// ============================================
// Oracle Party — Leaderboard
//
// ONE BOARD: you and your friends, ranked on what you actually know.
//
// WHY IT IS NOT GLOBAL ANY MORE, in the owner's words and reasoning:
//
// Anyone can play solo and mark themselves right every round, so a global
// ranking is a prize with no way to earn it honestly and no way to police it.
// Removing the prize removes most of the reason to fake anything — and among
// friends there IS a remedy a global board has no equivalent of: if somebody's
// numbers look wrong, unfriend them. A global board also discourages: a top
// score you cannot see a route to is a wall, not an invitation.
//
// WHY IT IS NOT "POINTS" ANY MORE:
//
// Points was `correct_answers` — a count of ATTEMPTS. Answering the same
// question ten times counted ten times, so the measure rewarded re-grinding a
// handful of questions over learning new ones, and it disagreed with every
// other number in the app: the profile, the Map, the tiers and the category
// boards all count QUESTIONS. It was also unbounded, which is what made a top
// score look unreachable and a faked one impossible to spot. Mastery is capped
// by the size of the bank, so a leader at 6% reads as an invitation and one at
// 100% reads as a liar.
//
// MASTERED AND PROFICIENCY ARE BOTH HERE because they answer different
// questions — how much of the bank you have claimed, and how well you know what
// you have met — and neither alone is a ranking. Toggle, not two boards.
//
// THE PERIOD CONTROL IS HIDDEN UNTIL THE SERVER CAN HONOUR IT. See
// fetchLeaderboard: without migration 053 the fallback is lifetime-only, and a
// period shown beside numbers that ignore it is worse than no period at all.
//
// CLAPS ARE THE THIRD MEASURE, and they are not a third slice of the same data.
// A clap is somebody saying they liked your answer best that round — it has no
// category and no time window, because clap_history records a game rather than a
// subject. So on that tab the category, subcategory and period controls are
// HIDDEN and an order control takes their place. Leaving them on screen would
// rank a board on numbers that ignore them and say nothing, which is the fault
// the paragraph above exists to avoid; the scope note says outright that this
// board is every category and all time, so a filter vanishing is explained
// rather than merely noticed.
// ============================================

import { $, $$, escapeHtml, renderAvatar, navigateWithFade } from './utils.js';
import { LEADERBOARD_LIMIT, MIN_QUESTIONS_FOR_TITLE } from './constants.js';
import {
  fetchLeaderboard,
  fetchProfilesBatch,
  fetchFriends,
  fetchClapHistory
} from './supabase.js';
import { clapTotals, CLAP_RATE_FLOOR } from './game/clap-logic.js';
import { initAuth, getCurrentUser } from './auth.js';
import { initThemeToggle } from './theme.js';
import { TITLE_WORDS, buildDisplayTitle } from './titles.js';
import { loadTitleWords } from './title-content.js';
import { CATEGORY_META, flattenSubcategories } from './categories.js';

// A PROFICIENCY FLOOR, and it counts QUESTIONS MET, not attempts.
//
// Without one, three-for-three sits at 100% above somebody at 92% of six
// hundred, which is the single most annoying thing a percentage board can do.
//
// The old category board had a floor of 20 and applied it to
// `questions_answered` — ATTEMPTS — while ranking on questions. So replaying
// three questions twenty times qualified you. Same word, two meanings, which is
// the mistake this project keeps making.
//
// It scales with the period, because a week cannot contain as many questions as
// a lifetime and a fixed 20 would show an empty board for every window.
const PROFICIENCY_FLOOR = { all: 10, 30: 5, 7: 3 };

let _windowSupported = true;   // does the server offer time periods at all

const state = {
  measure: 'mastered',      // 'mastered' | 'proficiency' | 'claps'
  category: '',             // '' = all categories
  subcategory: '',
  periodDays: '',           // '' = all time
  clapOrder: 'total',       // 'total' | 'rate' — only read on the claps tab
};

const onClaps = () => state.measure === 'claps';

// ============================================
// INIT
// ============================================

async function init() {
  // Cancel the boot-guard timer in <head> — JS module chain is alive.
  window.__appReady = true;
  if (window.__appBootGuard) clearTimeout(window.__appBootGuard);
  document.body.style.opacity = '1';
  await initAuth();
  // Titles are rendered beside every name on this board, and an owner-written
  // word would otherwise show as its raw id.
  await loadTitleWords();
  initThemeToggle();

  buildCategorySelect();

  $$('.profile-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      state.measure = tab.dataset.measure;
      $$('.profile-tab').forEach(t => {
        const isActive = t.dataset.measure === state.measure;
        t.classList.toggle('active', isActive);
        t.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      syncControls();
      load();
    });
  });

  $('#lb-clap-order-select').onchange = () => {
    state.clapOrder = $('#lb-clap-order-select').value;
    load();
  };

  $('#lb-category-select').onchange = () => {
    state.category = $('#lb-category-select').value;
    state.subcategory = '';
    updateSubcategorySelect();
    load();
  };
  $('#lb-subcategory-select').onchange = () => {
    state.subcategory = $('#lb-subcategory-select').value;
    load();
  };
  $('#lb-period-select').onchange = () => {
    state.periodDays = $('#lb-period-select').value;
    load();
  };

  $('#btn-back').addEventListener('click', () => { navigateWithFade('index.html'); });
  history.pushState({ page: 'leaderboard' }, '');
  window.addEventListener('popstate', () => { window.location.href = 'index.html'; });

  load();
}

/**
 * Which controls belong to the measure now selected.
 *
 * ONE PLACE, because the alternative is each tab handler remembering to hide
 * three things and show a fourth — the same rule stated N times and followed
 * N-1, which is the shape this project records more than any other.
 *
 * The period select is the awkward one: it has its own reason to be hidden
 * (the server cannot honour it), so leaving the claps tab must not bring it
 * BACK. `_windowSupported` is the authority on that and this only ever narrows.
 */
function syncControls() {
  const claps = onClaps();
  $('#lb-category-select').style.display = claps ? 'none' : '';
  $('#lb-subcategory-select').style.display =
    (!claps && $('#lb-subcategory-select').options.length > 0 && state.category) ? '' : 'none';
  $('#lb-period-select').style.display = (!claps && _windowSupported) ? '' : 'none';
  $('#lb-clap-order-select').style.display = claps ? '' : 'none';
}

function buildCategorySelect() {
  const sel = $('#lb-category-select');
  const opts = ['<option value="">All categories</option>'];
  for (const [key, meta] of Object.entries(CATEGORY_META)) {
    opts.push(`<option value="${key}">${meta.emoji ? meta.emoji + ' ' : ''}${escapeHtml(meta.label || key)}</option>`);
  }
  sel.innerHTML = opts.join('');
}

function updateSubcategorySelect() {
  const sub = $('#lb-subcategory-select');
  // flattenSubcategories takes the category KEY, and is the single source for
  // this menu everywhere in the app — so a key offered here always resolves back
  // to a real node, which tests/categories.test.js pins.
  const flat = state.category ? flattenSubcategories(state.category) : [];
  if (flat.length === 0) {
    sub.innerHTML = '';
    sub.style.display = 'none';
    return;
  }
  sub.innerHTML = '<option value="">All of it</option>'
    + flat.map(f => `<option value="${escapeHtml(f.key)}">${'  '.repeat(f.depth || 0)}${escapeHtml(f.label)}</option>`).join('');
  sub.style.display = '';
}

// ============================================
// LOADING
// ============================================

function sinceIso() {
  if (!state.periodDays) return null;
  const d = new Date();
  d.setDate(d.getDate() - Number(state.periodDays));
  return d.toISOString();
}

// Every control on this page re-runs load(), and each run is two awaits deep.
// Tap Proficiency then immediately pick a category and the FIRST request can
// land last, painting the board for a filter nobody is looking at any more —
// and there is nothing on screen to say so, because both results are plausible.
// Each run takes a ticket and a stale one draws nothing.
let _loadToken = 0;

// The friends list does not change while somebody is prodding a filter, and
// re-fetching it on every toggle is a query per tap for an answer that cannot
// have moved.
let _friendsCache = null;

async function load() {
  const token = ++_loadToken;
  const container = $('#lb-list');
  const note = $('#lb-scope-note');
  container.innerHTML = '<p class="leaderboard-loading">Loading...</p>';

  const currentUser = getCurrentUser();
  if (!currentUser) {
    note.textContent = 'Ranked among you and your friends.';
    container.innerHTML = '<p class="leaderboard-empty">Create an account to see a leaderboard. It ranks you against your friends, so you need one first.</p>';
    return;
  }

  const myId = currentUser.user.id;
  if (!_friendsCache) _friendsCache = await fetchFriends(myId);
  const friends = _friendsCache;
  const ids = [myId, ...friends.map(f => f.user_id)];

  // THE CLAPS BOARD READS A DIFFERENT TABLE AND STOPS HERE. It shares the
  // friends list, the row template and the scope note, and nothing else: there
  // is no category to filter by, no window to apply and no leaderboard RPC to
  // call, so running it through the block below would mean four arguments that
  // are all null and a `windowed` answer about a question nobody asked.
  if (onClaps()) {
    const rows = await fetchClapHistory(ids);
    if (token !== _loadToken) return;
    return paint(rankClaps(rows, ids), friends, myId, token, container, note);
  }

  const { rows, windowed } = await fetchLeaderboard(ids, {
    category: state.category || null,
    subcategory: state.subcategory || null,
    since: sinceIso(),
  });
  if (token !== _loadToken) return;

  // The period control appears only once the server can answer it. It never
  // reappears mid-session having been hidden, because the reason it was hidden
  // does not change without a deploy.
  if (!windowed && _windowSupported) {
    _windowSupported = false;
    state.periodDays = '';
    $('#lb-period-select').style.display = 'none';
  } else if (windowed && _windowSupported) {
    $('#lb-period-select').style.display = '';
  }

  const floor = PROFICIENCY_FLOOR[state.periodDays || 'all'] ?? PROFICIENCY_FLOOR.all;
  return paint(rankRows(rows, state.measure, floor), friends, myId, token, container, note, floor);
}

/**
 * Draw a ranked list, whichever measure produced it.
 *
 * ONE PAINTER for all three boards. The profile fetch, the stale-token check,
 * the empty case and the row template were about to be written twice, and this
 * file already carries a note about what a second copy of buildDisplayTitle
 * would have done — printed a raw word id as somebody's title on this screen
 * alone, for as long as nobody compared the two.
 */
async function paint(ranked, friends, myId, token, container, note, floor) {
  note.textContent = scopeNote(friends.length, floor);

  if (ranked.length === 0) {
    container.innerHTML = `<p class="leaderboard-empty">${emptyMessage(friends.length, floor)}</p>`;
    return;
  }

  const profiles = await fetchProfilesBatch(ranked.map(r => r.user_id));
  if (token !== _loadToken) return;
  const profileMap = {};
  for (const p of profiles) profileMap[p.user_id] = p;

  container.innerHTML = ranked.slice(0, LEADERBOARD_LIMIT).map((row, i) => {
    const p = profileMap[row.user_id] || {};
    return renderRow(i + 1, p, buildProfileTitle(p), primaryStat(row), secondaryStat(row), row.user_id === myId);
  }).join('');
}

/**
 * Sort and filter for the chosen measure.
 *
 * Exported shape kept simple on purpose: rows in, rows out, no DOM. The two
 * measures need different ties AND different eligibility, and mixing that into
 * the render loop is how the old board came to rank on one thing while
 * labelling another.
 */
function rankRows(rows, measure, floor) {
  const withStats = (rows || []).map(r => {
    const met = r.questions_met || 0;
    const mastered = r.questions_mastered || 0;
    return { ...r, met, mastered, accuracy: met > 0 ? mastered / met : 0 };
  });

  if (measure === 'proficiency') {
    return withStats
      .filter(r => r.met >= floor)
      // Ties go to the bigger sample: 100% of ten must not outrank 92% of six
      // hundred just because it got there first.
      .sort((a, b) => b.accuracy - a.accuracy || b.met - a.met);
  }
  // met > 0, not mastered > 0. Somebody who has played and mastered nothing yet
  // still belongs on their own board — hiding them would make the one screen
  // that is meant to show where you stand answer "nowhere", and the row already
  // says "0" beside "12 met", which is more use than an absence.
  return withStats
    .filter(r => r.met > 0)
    .sort((a, b) => b.mastered - a.mastered || b.accuracy - a.accuracy);
}

/**
 * Rank the claps board from raw clap_history rows.
 *
 * One row per player per finished game, so they are summed per person —
 * clapTotals is the single place that does it, shared with both profile
 * surfaces, so the three can never disagree about what a lifetime total is.
 *
 * TWO ORDERS, BOTH REAL, which is why this is a control rather than a tiebreak.
 * Most claps is a record of turning up and being funny for a long time; the best
 * rate is a record of being the one people picked. Ranking one by the other
 * would quietly answer a question nobody asked.
 *
 * THE RATE ORDER HAS A FLOOR AND THE TOTAL ORDER HAS NONE, exactly as
 * proficiency has one and mastered does not. A count is a count at any size; a
 * share of three claps is not a fact about a player. `available` is the floor's
 * unit rather than `received`, because it measures how much CHANCE they have
 * had — somebody in twenty rounds who was never clapped has a real 0% and
 * belongs on the board.
 *
 * Everybody the board knows about is included, at zero if they have never been
 * clapped. Hiding them would make the one screen meant to show where you stand
 * answer "nowhere", which is the same call rankRows already makes for mastered.
 */
function rankClaps(rows, ids) {
  const byUser = new Map(ids.map(id => [String(id), []]));
  for (const r of (rows || [])) {
    const key = String(r.user_id);
    if (byUser.has(key)) byUser.get(key).push(r);
  }

  const withStats = [...byUser.entries()].map(([user_id, mine]) => {
    const t = clapTotals(mine);
    return { user_id, claps: t.received, available: t.available, rate: t.rate };
  });

  if (state.clapOrder === 'rate') {
    return withStats
      .filter(r => r.rate !== null)
      // Ties to the bigger sample, the same rule proficiency follows: a perfect
      // rate over the minimum must not outrank a near-perfect one over a year.
      .sort((a, b) => b.rate - a.rate || b.available - a.available);
  }
  return withStats
    .filter(r => r.available > 0)
    .sort((a, b) => b.claps - a.claps || (b.rate ?? -1) - (a.rate ?? -1));
}

function primaryStat(row) {
  if (onClaps()) {
    return state.clapOrder === 'rate' ? `${Math.round(row.rate * 100)}%` : `${row.claps}`;
  }
  if (state.measure === 'proficiency') return `${Math.round(row.accuracy * 100)}%`;
  return `${row.mastered}`;
}

function secondaryStat(row) {
  // THE SAMPLE IS ALWAYS PRINTED BESIDE THE PERCENTAGE. "100%" and "100% of 12
  // questions" are different claims and must never look alike — the same rule
  // the difficulty band on the reveal follows.
  if (onClaps()) {
    // BOTH NUMBERS ON EVERY ROW, whichever way the board is sorted. The owner
    // asked for the total and the weighted figure together, and the order
    // control decides which one the ranking is for rather than which one is
    // visible — a board that hides the number it is not sorting by makes the
    // toggle look like two different leaderboards.
    if (state.clapOrder === 'rate') return `${row.claps} of ${row.available}`;
    return row.rate === null
      // Under the floor there is no rate to print, and the sample says why.
      ? `${row.available} available`
      : `${Math.round(row.rate * 100)}% of ${row.available}`;
  }
  if (state.measure === 'proficiency') return `${row.mastered} of ${row.met} known`;
  return `${row.met} met`;
}

function scopeNote(friendCount, floor) {
  const who = friendCount === 0 ? 'Just you so far — add friends to compare.'
                                : `You and ${friendCount} friend${friendCount === 1 ? '' : 's'}.`;
  // SAY THAT THE FILTERS ARE GONE BECAUSE THEY DO NOT APPLY. A category menu
  // disappearing when you change tab reads as a glitch unless the line under it
  // accounts for the board being every category and all time.
  const what = onClaps()
    ? (state.clapOrder === 'rate'
        ? `Claps you were given out of the claps available to you. Every category, all time. Needs ${CLAP_RATE_FLOOR}+ available to appear.`
        : 'Claps other players gave your answers. Every category, all time.')
    : state.measure === 'proficiency'
      ? `Share of the questions you have met that you currently get right. Needs ${floor}+ met to appear.`
      : 'Questions you currently get right, counted once each.';
  return `${who} ${what}`;
}

function emptyMessage(friendCount, floor) {
  // SAY WHAT ACTUALLY HAPPENS. "Tap a player to add them" was half the story:
  // the button sends a REQUEST, which the other person accepts from their own
  // profile, and it is only offered for players who have an account. Somebody
  // who taps once, sees "Request Sent" and comes back to an empty board would
  // reasonably conclude the board is broken.
  if (friendCount === 0) return 'Add friends to build a leaderboard. Tap a signed-in player in a lobby to send a request — they accept it from their own profile.';
  if (onClaps()) {
    return state.clapOrder === 'rate'
      ? `Nobody here has had ${CLAP_RATE_FLOOR} claps available yet — that is about one game with a few people in it.`
      : 'No claps yet. Tap 👏 on the answer you liked best each round and they start collecting.';
  }
  if (state.measure === 'proficiency') return `Nobody here has met ${floor} questions in this slice yet.`;
  return 'Nothing mastered here yet — play a game and it fills in.';
}

// ============================================
// RENDERING HELPERS
// ============================================

// A SECOND COPY OF buildDisplayTitle IS HOW THE TWO DISAGREE. This one had the
// same `|| id` fallback, so the leaderboard would have printed "w:science::rare"
// as somebody's title independently of every other screen. One reader now.
const buildProfileTitle = buildDisplayTitle;

function renderRow(rank, profile, title, primary, secondary, isMe) {
  const avatar = renderAvatar({
    displayName: profile.display_name || '?',
    avatarColor: profile.avatar_color || null,
    avatarEmoji: profile.avatar_emoji || null,
    size: '28px'
  });
  const name = escapeHtml(profile.display_name || 'Unknown');
  const meClass = isMe ? ' leaderboard-row--me' : '';

  return `
    <div class="leaderboard-row${meClass}">
      <span class="leaderboard-rank">${rank}</span>
      ${avatar}
      <div class="leaderboard-row__info">
        <div class="leaderboard-row__name">${name}</div>
        <div class="leaderboard-row__title">${escapeHtml(title)}</div>
      </div>
      <div class="leaderboard-row__stats">
        <div class="leaderboard-row__primary">${primary}</div>
        <div class="leaderboard-row__secondary">${secondary}</div>
      </div>
    </div>
  `;
}

init();
