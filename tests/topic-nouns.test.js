import { describe, it, expect, afterEach } from 'vitest';
import { TITLE_WORDS, applyWordOverlay, clearWordOverlay, evaluateUnlocks, describeRequirement } from '../js/titles.js';

// Topic nouns (owner, 2026-11-02): earned at a topic's RARE step and worn with
// any reel-2 word. Each follows its topic's Rare word, so the goal is never
// written down twice.
const rare = (sub, word, right) => ({ slot: 2, category: 'science', subcategory: sub, tier: 'rare', word, target_right: right });
const row = (sub, right) => ({ category: 'science', subcategory: sub, questions_met: right, questions_mastered: right });
const earned = (stats) => evaluateUnlocks(stats, {}, [], { hour: 12 }).map(c => c.wordId);

afterEach(() => clearWordOverlay());

describe('topic nouns', () => {
  it('cannot be earned while its Rare word is not loaded', () => {
    clearWordOverlay();
    expect(TITLE_WORDS.nounAlien.unlock.condition.right).toBe(0);
    expect(earned([row('space', 500)])).not.toContain('nounAlien');
    expect(describeRequirement(TITLE_WORDS.nounAlien)).toBe('Get half of space right');
  });

  it("takes its topic's Rare goal, and is earned exactly when that word is", () => {
    applyWordOverlay([rare('space', 'Gassy', 43)]);
    expect(TITLE_WORDS.nounAlien.unlock.condition.right).toBe(43);
    expect(earned([row('space', 42)])).not.toContain('nounAlien');
    const got = earned([row('space', 43)]);
    expect(got).toContain('nounAlien');
    expect(got).toContain('w:science:space:rare');
  });

  it('is a reel-3 word shown in Rare colour, and is not capped like a rank', () => {
    for (const id of ['nounBigfoot', 'nounGoldDigger', 'nounAlien']) {
      expect(TITLE_WORDS[id].slot).toBe(3);
      expect(TITLE_WORDS[id].rarity).toBe('rare');
      expect(TITLE_WORDS[id].unlock.type).not.toBe('rank');
    }
  });

  it('a noun in one topic is not earned by another topic', () => {
    applyWordOverlay([rare('space', 'Gassy', 43), rare('elements', 'Unstable', 50)]);
    const got = earned([row('space', 60)]);
    expect(got).toContain('nounAlien');
    expect(got).not.toContain('nounGoldDigger');
    expect(got).not.toContain('nounBigfoot');
  });
});
