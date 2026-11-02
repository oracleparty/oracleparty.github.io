import { describe, it, expect, afterEach } from 'vitest';
import { TITLE_WORDS, applyWordOverlay, applyLiveTargets, clearWordOverlay, evaluateUnlocks, describeRequirement } from '../js/titles.js';

// Owner, 2026-11-02: a word may be written before its topic is big enough, and
// stays LOCKED until the topic clears that step's floor (60/70/80/100).
const w = (tier, word, right) => ({ slot: 2, category: 'history', subcategory: 'medieval', tier, word, target_right: right });
const row = (right) => ({ category: 'history', subcategory: 'medieval', questions_met: right, questions_mastered: right });
const earned = (stats) => evaluateUnlocks(stats, {}, [], { hour: 12 }).map(c => c.wordId);
const sizes = (n) => ({ history: { subjectSize: 800, sizes: { medieval: n } } });

afterEach(() => { applyLiveTargets({}); clearWordOverlay(); });

describe('a topic under its floor', () => {
  it('keeps every step locked, however many are right', () => {
    applyWordOverlay([w('uncommon', 'Peasant', 13), w('legendary', 'Inbred', 52)]);
    applyLiveTargets(sizes(52));
    expect(earned([row(52)])).not.toContain('w:history:medieval:uncommon');
    expect(earned([row(52)])).not.toContain('w:history:medieval:legendary');
    expect(describeRequirement(TITLE_WORDS['w:history:medieval:uncommon'])).toBe('Opens when medieval has 60 questions');
  });

  it('opens a step the moment the topic clears that step only', () => {
    applyWordOverlay([w('uncommon', 'Peasant', 13), w('rare', 'Diseased', 26)]);
    applyLiveTargets(sizes(64));
    const got = earned([row(64)]);
    expect(got).toContain('w:history:medieval:uncommon');
    expect(got).not.toContain('w:history:medieval:rare');
  });

  it('an unmeasured topic keeps its saved goal (the old behaviour)', () => {
    applyWordOverlay([w('uncommon', 'Peasant', 13)]);
    applyLiveTargets({});
    expect(earned([row(13)])).toContain('w:history:medieval:uncommon');
  });
});
