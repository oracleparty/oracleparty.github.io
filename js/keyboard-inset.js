// ============================================
// Oracle Party — The on-screen keyboard
//
// REPORTED FROM A LIVE GAME: "when I type I can't see the question."
//
// Every screen in this app is `position: fixed; inset: 0; height: 100dvh`, and
// that is exactly the shape a phone keyboard breaks. On iOS the keyboard does
// NOT shrink the layout viewport, so `100dvh` stays the full height of the
// phone; the browser instead PANS the visual viewport up to bring the focused
// input into view, and a fixed element pans with the layout viewport rather
// than the visible one. The top of the screen — the question — goes off the top
// edge, and there is nothing to scroll back to because the screen itself is
// `overflow: hidden`.
//
// `window.visualViewport` is what makes that measurable rather than guessed at:
// it reports the height actually visible and how far down the page that window
// currently sits. Given both, the screen can be resized and re-anchored to the
// visible area, at which point the browser has no reason to pan at all.
//
// NO IMPORTS, and the arithmetic is separated from the DOM, because this is
// behaviour nothing in this repo can reproduce — the robots drive a desktop
// browser with no keyboard and no visual-viewport offset, and the layout sweep
// measures a viewport that never shrinks. The pure half is unit tested; the
// wiring is one listener, and if `visualViewport` is missing it does nothing at
// all and every screen behaves exactly as it does today.
// ============================================

// A keyboard covers a third of a phone or more. Browser chrome sliding away
// while scrolling moves the visual viewport by far less, and treating that as a
// keyboard would resize the screen under somebody who is only reading.
export const KEYBOARD_MIN_INSET_PX = 120;

// A PINCH-ZOOM SHRINKS THE VISUAL VIEWPORT EXACTLY LIKE A KEYBOARD DOES, and
// nothing here could tell them apart. `visualViewport.scale` is the one signal
// that can: it is 1 whenever the page is at its natural size, whatever the
// keyboard is doing.
//
// This matters because `maximum-scale=1, user-scalable=no` in the viewport meta
// IS IGNORED BY iOS SAFARI, and has been for years — so every screen in this
// app really is pinch-zoomable, and a two-finger brush while holding a phone
// zooms it. At 1.5x on an 844px phone the visible window is ~563px, which is
// 281px "covered" — well past the 120px threshold — so the app declared a
// keyboard that was not there and resized and re-anchored the question screen
// underneath somebody who had not typed a word.
//
// A small tolerance rather than `=== 1`: the property is a float and browsers
// report values a hair off after a double-tap zoom settles.
export const ZOOM_TOLERANCE = 1.05;

/**
 * Is the thing with focus something a keyboard is FOR?
 *
 * THE 120px THRESHOLD WAS A GUESS ABOUT BROWSER CHROME AND IT WAS NEVER
 * MEASURED ON A PHONE. `covered` is `innerHeight - visualViewport.height -
 * offsetTop`, and on iOS Safari the layout viewport does not shrink with the
 * toolbars — so the top bar plus the bottom bar plus the home indicator all
 * land in that number. On a phone whose chrome totals more than 120px,
 * `kb-open` was TRUE for the whole game with no keyboard anywhere, and the
 * question screen was resized and re-anchored the entire time.
 *
 * A keyboard cannot open without something focused to type into. That is not a
 * threshold, it is the definition, so it holds on every phone at every chrome
 * height — which is what a guess about pixels can never do.
 *
 * `showQuestionScreen` focuses the answer box on every round even when iOS
 * refuses to raise a keyboard for it, so this is not sufficient ON ITS OWN and
 * is not used that way: it is ANDed with the measurement, and a focused box
 * with nothing covered is still a closed keyboard.
 */
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    // A checkbox or a button raises no keyboard.
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'file', 'range', 'color']
      .includes(String(el.type || 'text').toLowerCase());
  }
  return el.isContentEditable === true;
}

/**
 * What the visual viewport is telling us, as numbers a stylesheet can use.
 *
 * `covered` subtracts BOTH the height lost and how far the window has been
 * panned down: on iOS a keyboard produces some of each, and counting only the
 * height change reads a panned viewport as no keyboard at all.
 */
export function keyboardInset({ innerHeight, viewportHeight, offsetTop = 0, scale = 1, typing = true, minInsetPx = KEYBOARD_MIN_INSET_PX }) {
  const inner = Number(innerHeight);
  const vh = Number(viewportHeight);
  const top = Number(offsetTop) || 0;
  const zoom = Number(scale);
  // Nothing measurable — say so, rather than reporting a closed keyboard, so
  // the caller leaves the layout alone instead of acting on a guess.
  if (!Number.isFinite(inner) || !Number.isFinite(vh) || inner <= 0 || vh <= 0) {
    return { covered: 0, open: false, height: null, offsetTop: 0 };
  }
  // ZOOMED IN. The visible window is small because the page is magnified, and
  // every number below would describe the magnification rather than a keyboard.
  // Reported as NOTHING MEASURABLE, the same answer as a broken reading, which
  // is what leaves the screen exactly as it is: a wrongly applied `kb-open`
  // resizes a fixed, full-screen element under a person who did not type,
  // while a missing one is simply the layout this app had before any of this
  // existed. A keyboard opened while zoomed loses the fix and keeps the game.
  if (Number.isFinite(zoom) && zoom > ZOOM_TOLERANCE) {
    return { covered: 0, open: false, height: null, offsetTop: 0 };
  }
  const covered = Math.max(0, inner - vh - top);
  return {
    covered,
    // BOTH, ALWAYS. The measurement says how much of the screen is gone; the
    // focus says whether a keyboard is what took it. Browser chrome and a pan
    // satisfy the first and never the second.
    open: covered > minInsetPx && typing !== false,
    height: Math.round(vh),
    offsetTop: Math.round(top),
  };
}

/**
 * Keep `--kb-visible-height` / `--kb-offset-top` and the `kb-open` class on the
 * document in step with the visual viewport. Returns a teardown function.
 *
 * The CSS that reads these is scoped to the question screen and to `kb-open`,
 * so on a browser without `visualViewport` — and at every moment no keyboard is
 * up — not one rule applies and the layout is byte-for-byte what it was.
 */
export function initKeyboardInset() {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return () => {};

  const root = document.documentElement;
  let frame = 0;

  function apply() {
    frame = 0;
    const { open, height, offsetTop } = keyboardInset({
      innerHeight: window.innerHeight,
      viewportHeight: vv.height,
      offsetTop: vv.offsetTop,
      // `scale` is undefined on browsers that predate it; Number(undefined) is
      // NaN, which the guard treats as "not zoomed" rather than as zoomed —
      // the direction that leaves the keyboard fix working.
      scale: vv.scale,
      typing: isTypingTarget(document.activeElement),
    });
    if (height !== null) {
      root.style.setProperty('--kb-visible-height', `${height}px`);
      root.style.setProperty('--kb-offset-top', `${offsetTop}px`);
    }
    document.body.classList.toggle('kb-open', open);
    // A pinch that starts WHILE the keyboard is up reports "not measurable",
    // so the class is removed above and the variables are left holding their
    // last values. That is correct: nothing reads them without the class.
  }

  // Coalesced: iOS fires resize and scroll together, many times, while the
  // keyboard animates in.
  const onChange = () => { if (!frame) frame = requestAnimationFrame(apply); };
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  // FOCUS IS HALF THE ANSWER NOW, so it has to be watched like the other half.
  // Tapping the answer box raises the keyboard and the viewport resizes a beat
  // later, which the resize listener catches; DISMISSING it can leave the
  // viewport unchanged, and without these the class would stay on.
  document.addEventListener('focusin', onChange);
  document.addEventListener('focusout', onChange);
  apply();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
    document.removeEventListener('focusin', onChange);
    document.removeEventListener('focusout', onChange);
    document.body.classList.remove('kb-open');
    root.style.removeProperty('--kb-visible-height');
    root.style.removeProperty('--kb-offset-top');
  };
}
