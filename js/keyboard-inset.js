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

/**
 * What the visual viewport is telling us, as numbers a stylesheet can use.
 *
 * `covered` subtracts BOTH the height lost and how far the window has been
 * panned down: on iOS a keyboard produces some of each, and counting only the
 * height change reads a panned viewport as no keyboard at all.
 */
export function keyboardInset({ innerHeight, viewportHeight, offsetTop = 0, minInsetPx = KEYBOARD_MIN_INSET_PX }) {
  const inner = Number(innerHeight);
  const vh = Number(viewportHeight);
  const top = Number(offsetTop) || 0;
  // Nothing measurable — say so, rather than reporting a closed keyboard, so
  // the caller leaves the layout alone instead of acting on a guess.
  if (!Number.isFinite(inner) || !Number.isFinite(vh) || inner <= 0 || vh <= 0) {
    return { covered: 0, open: false, height: null, offsetTop: 0 };
  }
  const covered = Math.max(0, inner - vh - top);
  return {
    covered,
    open: covered > minInsetPx,
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
    });
    if (height !== null) {
      root.style.setProperty('--kb-visible-height', `${height}px`);
      root.style.setProperty('--kb-offset-top', `${offsetTop}px`);
    }
    document.body.classList.toggle('kb-open', open);
  }

  // Coalesced: iOS fires resize and scroll together, many times, while the
  // keyboard animates in.
  const onChange = () => { if (!frame) frame = requestAnimationFrame(apply); };
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  apply();

  return () => {
    if (frame) cancelAnimationFrame(frame);
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
    document.body.classList.remove('kb-open');
    root.style.removeProperty('--kb-visible-height');
    root.style.removeProperty('--kb-offset-top');
  };
}
