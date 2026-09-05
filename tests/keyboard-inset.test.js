import { describe, it, expect } from 'vitest';
import { keyboardInset, KEYBOARD_MIN_INSET_PX } from '../js/keyboard-inset.js';

// The arithmetic behind "is the keyboard up, and how much of the screen is
// left". Unit tested because NOTHING else in this repo can reach it: the robots
// drive a desktop browser with no keyboard, and the layout sweep measures a
// viewport that never shrinks. Reported from a live game as "when I type I
// can't see the question".

describe('keyboardInset', () => {
  const phone = { innerHeight: 844 };   // iPhone 14

  it('is closed when the whole viewport is visible', () => {
    const r = keyboardInset({ ...phone, viewportHeight: 844, offsetTop: 0 });
    expect(r.open).toBe(false);
    expect(r.covered).toBe(0);
    expect(r.height).toBe(844);
  });

  it('is open when a keyboard has taken a third of the phone', () => {
    const r = keyboardInset({ ...phone, viewportHeight: 508, offsetTop: 0 });
    expect(r.open).toBe(true);
    expect(r.covered).toBe(336);
    expect(r.height).toBe(508);
  });

  it('counts a PANNED viewport as covered, not as no keyboard', () => {
    // iOS produces some of each: the visible window shrinks AND slides down.
    // Measuring only the height change reads this as a much smaller keyboard,
    // and below the threshold it reads as none at all.
    const r = keyboardInset({ ...phone, viewportHeight: 600, offsetTop: 244 });
    expect(r.covered).toBe(0);
    expect(r.open).toBe(false);

    const panned = keyboardInset({ ...phone, viewportHeight: 508, offsetTop: 120 });
    expect(panned.covered).toBe(216);
    expect(panned.offsetTop).toBe(120);
  });

  it('ignores browser chrome sliding away, which is not a keyboard', () => {
    // Resizing the screen under somebody who is only scrolling would be a
    // worse bug than the one this fixes.
    const chrome = keyboardInset({ ...phone, viewportHeight: 844 - 90, offsetTop: 0 });
    expect(chrome.covered).toBe(90);
    expect(chrome.open).toBe(false);
    expect(90).toBeLessThan(KEYBOARD_MIN_INSET_PX);
  });

  it('reports the threshold as a boundary, not a range', () => {
    expect(keyboardInset({ ...phone, viewportHeight: 844 - KEYBOARD_MIN_INSET_PX }).open).toBe(false);
    expect(keyboardInset({ ...phone, viewportHeight: 844 - KEYBOARD_MIN_INSET_PX - 1 }).open).toBe(true);
  });

  it('reports NOTHING MEASURABLE rather than a closed keyboard', () => {
    // The caller leaves the layout alone on a null height. Returning "closed"
    // here would strip the class off a screen whose keyboard is still up.
    for (const bad of [
      { innerHeight: 0, viewportHeight: 844 },
      { innerHeight: 844, viewportHeight: 0 },
      { innerHeight: NaN, viewportHeight: 844 },
      { innerHeight: 844, viewportHeight: undefined },
    ]) {
      const r = keyboardInset(bad);
      expect(r.height).toBe(null);
      expect(r.open).toBe(false);
    }
  });

  it('never reports a negative cover', () => {
    // A visual viewport TALLER than the layout viewport is a real transient on
    // iOS during rotation.
    expect(keyboardInset({ ...phone, viewportHeight: 900 }).covered).toBe(0);
  });
});
