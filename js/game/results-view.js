/**
 * The results screen's markup: the scoreboard rows, the Favourite Answers
 * carousel, and the "scroll for all N" cue.
 *
 * It imports nothing that reaches Supabase, so scripts/mock-states.js loads
 * THIS module and the layout sweep reviews the screen that ships — the mock
 * used to rebuild these rows by hand and drifted from them more than once.
 *
 * The screen as the owner designed it (2026-10-28): the podium before it has
 * already crowned the winner, so this one opens on the scoreboard. Medals
 * stand in the place column for the top three; the rows are compact enough
 * that six fit on a 320x523 phone, and only when they do not is there a fade
 * and a cue. Favourite answers are a swipe carousel under it.
 */
import { escapeHtml, renderAvatar } from '../utils.js';
import { rankPlayers, ordinal } from './podium-logic.js';

const MEDAL = { 1: '🥇', 2: '🥈', 3: '🥉' };

/**
 * One row per player, best first. `sorted` is in descending score order.
 * Places are competition ranks, so two players level on points share a medal
 * here exactly as they do on the podium.
 */
export function resultsRowsHtml(sorted, { scoreOf, fwDeltaOf, meId, honkCountOf = () => 0 }) {
  const ranks = rankPlayers(sorted, scoreOf);
  return sorted.map((p, i) => {
    const rank = ranks[i];
    const place = MEDAL[rank]
      ? `<span class="results-row__place results-row__place--medal" aria-label="${ordinal(rank)}">${MEDAL[rank]}</span>`
      : `<span class="results-row__place">${ordinal(rank)}</span>`;
    const fwDelta = fwDeltaOf(p);
    const fwClass = fwDelta > 0 ? 'score-anim-row__delta--positive'
      : fwDelta < 0 ? 'score-anim-row__delta--negative' : 'score-anim-row__delta--zero';
    const isMe = String(p.id) === String(meId);
    const honks = honkCountOf(p.id);
    const honkBadge = `<span class="honk-badge" data-honk-player="${p.id}" style="${honks > 0 ? '' : 'display:none'}">${honks}</span>`;
    const honkBtn = (isMe || p.is_bot) ? '' : `<button class="honk-btn" data-honk-target="${p.id}" aria-label="Quack">&#x1F986;</button>`;
    const title = p.title ? `<span class="player-title">${escapeHtml(p.title)}</span>` : '';
    return `
      <div class="results-row${isMe ? ' results-row--me' : ''}" data-player-id="${p.id}" data-profile-player-id="${p.id}" ${p.user_id ? `data-profile-user-id="${p.user_id}"` : ''}>
        ${place}
        <div class="avatar-wrap">
          ${renderAvatar({ displayName: p.display_name, avatarColor: p.avatar_color, avatarEmoji: p.avatar_emoji })}
          ${honkBadge}
        </div>
        <div class="name-stack">
          <span class="results-row__name">${escapeHtml(p.display_name)}${p.is_host ? ' <span class="badge badge--host">Host</span>' : ''}</span>
          ${title}
        </div>
        ${honkBtn}
        <span class="results-row__fw-delta ${fwClass}">${fwDelta > 0 ? '+' : ''}${fwDelta}</span>
        <span class="results-row__score">${scoreOf(p)}</span>
      </div>`;
  }).join('');
}

/**
 * The carousel. `entries` are `{ question, answer, who, claps }`; `more` counts
 * answers tied with the last one shown that did not fit — said out loud rather
 * than letting three of eight equal answers look special.
 */
export function favouritesHtml(entries, more = 0) {
  const cards = entries.map(e => `
    <div class="fav-answer">
      ${e.question ? `<div class="fav-answer__q">${escapeHtml(e.question)}</div>` : ''}
      <div class="fav-answer__a">${escapeHtml(e.answer)}</div>
      <div class="fav-answer__who">
        <span class="fav-answer__name">${escapeHtml(e.who)}</span>
        <span class="fav-answer__claps"><span aria-hidden="true">&#x1F44F;</span> ${e.claps}</span>
      </div>
    </div>`).join('');
  const dots = entries.length > 1
    ? `<div class="fav-answers__dots" aria-hidden="true">${entries.map((_, i) => `<span${i === 0 ? ' class="on"' : ''}></span>`).join('')}</div>`
    : '';
  return `<div class="fav-answers__title">👏 Favourite answers${more ? `<span class="fav-answers__more"> · +${more} more tied</span>` : ''}</div>
    <div class="fav-answers__track${entries.length === 1 ? ' fav-answers__track--one' : ''}">${cards}</div>
    ${dots}`;
}

/** Keep the dots on the card that is in view. */
export function wireFavouriteDots(host) {
  const track = host?.querySelector('.fav-answers__track');
  const dots = host ? [...host.querySelectorAll('.fav-answers__dots span')] : [];
  if (!track || !dots.length) return;
  track.onscroll = () => {
    const cards = [...track.children];
    const left = track.getBoundingClientRect().left;
    let best = 0, bestD = Infinity;
    cards.forEach((c, i) => {
      const d = Math.abs(c.getBoundingClientRect().left - left);
      if (d < bestD) { bestD = d; best = i; }
    });
    dots.forEach((d, i) => d.classList.toggle('on', i === best));
  };
}

/**
 * The fade and "▾ scroll for all N" — only when the scoreboard really does
 * not fit. A cue under a list that is all on screen is a promise of more that
 * is not there. Call after anything that changes the screen's height.
 */
export function fitScoreboard() {
  const board = document.querySelector('#results-screen .results-scoreboard');
  const cue = document.getElementById('results-more');
  if (!board || !cue) return;
  // Anything that changes the screen's height afterwards — the host review
  // landing, the favourites arriving, a keyboard — re-asks the question.
  if (!board._fitWatched && typeof ResizeObserver === 'function') {
    board._fitWatched = true;
    new ResizeObserver(() => fitScoreboard()).observe(board);
  }
  const n = board.querySelectorAll('.results-row').length;
  const over = board.scrollHeight > board.clientHeight + 2;
  board.classList.toggle('results-scoreboard--overflows', over);
  cue.hidden = !over;
  cue.textContent = over ? `▾ scroll for all ${n}` : '';
  board.onscroll = over ? () => {
    const atEnd = board.scrollTop + board.clientHeight >= board.scrollHeight - 4;
    board.classList.toggle('results-scoreboard--overflows', !atEnd);
    cue.hidden = atEnd;
  } : null;
}
