// ============================================
// Oracle Party — showing somebody they earned something
//
// Unlocking a title used to be a console.debug line. The celebration table had
// been written, exported, and wired to nothing:
//
//   // (Phase 4 will add celebration display here)
//   if (newUnlocks.length > 0) logger.debug('Titles', 'New unlocks', ...)
//
// So every reward in this game was invisible at the exact moment it was
// earned. The gallery makes the collection browsable; this is what makes
// filling it feel like anything.
//
// The DOM is built here rather than sitting in each page's HTML, because
// unlocks can fire from the scores screen AND from sign-in on any page. One
// element that creates itself is the only version that works everywhere.
// ============================================

import { escapeHtml } from './utils.js';
import { CELEBRATION_FULLSCREEN_MS, CELEBRATION_CARD_MS } from './constants.js';
import { TITLE_WORDS, describeRequirement } from './titles.js';
import { labelForKey } from './categories.js';

let _hideTimer = null;

function overlay() {
  let el = document.getElementById('title-celebration');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'title-celebration';
  el.className = 'celebration';
  el.hidden = true;
  // Announced to screen readers, because for somebody not watching the screen
  // this is the only signal that anything happened at all.
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  return el;
}

export function dismissCelebration() {
  clearTimeout(_hideTimer);
  _hideTimer = null;
  const el = document.getElementById('title-celebration');
  if (!el) return;
  el.classList.remove('celebration--in');
  // Left in the DOM but hidden, so the next unlock reuses it rather than
  // stacking a second overlay on top of the first.
  el.hidden = true;
  el.innerHTML = '';
}

/**
 * Show one celebration for a batch of unlocks.
 *
 * `plan` comes from planCelebration in titles.js — the loudest word leads and
 * the rest are counted, because six overlays in a row is a queue to dismiss
 * rather than a reward.
 */
export function showCelebration(plan) {
  if (!plan || !plan.lead) return;
  const { tier, lead, count } = plan;

  const el = overlay();
  dismissCelebration();

  const rarity = lead.rarity || 'common';
  const more = count > 1
    ? `<div class="celebration__more">+${count - 1} more unlocked</div>`
    : '';
  // An upgrade is a different sentence from a first unlock. "Brave II" is not
  // a new word, and saying "new title" about it would be wrong.
  const kicker = lead.isUpgrade ? `Level ${lead.level}` : rarity;

  // WHAT EARNED IT. This card used to say only the word, which is the fault the
  // owner has raised about this system more than any other: they could not tell
  // what any word was for. It matters most HERE, because the sign-in path fires
  // on arrival with no game behind it — a word appearing on the front page out
  // of nowhere is the least explicable moment in the app.
  //
  // A secret says nothing, deliberately: describeRequirement returns null for
  // one, and spoiling it at the moment it lands would take the whole point of
  // it away.
  //
  // AND NEITHER DOES AN UPGRADE. describeRequirement states the BASE
  // requirement, and a level is a multiple of it — so "Win 10 games in a row"
  // on a Level 2 card would be describing something the player passed a while
  // ago, which is worse than saying nothing. The kicker already reads "Level 2".
  const why = lead.isUpgrade
    ? null
    : describeRequirement(TITLE_WORDS[lead.wordId], labelForKey);
  const reason = why
    ? `<div class="celebration__why">${escapeHtml(why)}</div>`
    : '';

  el.dataset.tier = tier;
  el.dataset.rarity = rarity;
  el.innerHTML = `
    <div class="celebration__card">
      <div class="celebration__kicker">${escapeHtml(String(kicker))}</div>
      <div class="celebration__word">${escapeHtml(lead.word)}</div>
      ${lead.isUpgrade ? '' : '<div class="celebration__sub">added to your titles</div>'}
      ${reason}
      ${more}
      <button type="button" class="celebration__dismiss">Nice</button>
    </div>`;

  el.hidden = false;
  // Next frame, so the transition actually runs — setting both the display and
  // the class in one go gives the browser nothing to animate from.
  requestAnimationFrame(() => el.classList.add('celebration--in'));

  el.querySelector('.celebration__dismiss').onclick = dismissCelebration;
  // A fullscreen one blocks the game, so tapping anywhere clears it. The
  // quieter tiers do not, and must not swallow taps meant for what is beneath.
  if (tier === 'fullscreen') el.onclick = dismissCelebration;

  // Always self-clearing. This fires between rounds and nobody should have to
  // dismiss something to carry on playing — a reward that blocks the game
  // stops being one on the second occurrence.
  const life = tier === 'fullscreen' ? CELEBRATION_FULLSCREEN_MS : CELEBRATION_CARD_MS;
  _hideTimer = setTimeout(dismissCelebration, life);
}
