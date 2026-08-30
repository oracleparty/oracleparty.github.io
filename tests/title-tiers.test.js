import { describe, it, expect } from 'vitest';
import {
  TOPIC_FLOOR, TOPIC_SHARE, SUBJECT_RULE,
  tiersForTopic, topicTarget, subjectTargets, meetsTopic, isMiscTopic,
} from '../js/title-tiers.js';

describe('which tiers a topic offers', () => {
  it('offers nothing below the smallest floor', () => {
    expect(tiersForTopic(59)).toEqual([]);
    expect(tiersForTopic(5)).toEqual([]);
  });

  it('opens up as the topic grows', () => {
    expect(tiersForTopic(60)).toEqual(['uncommon']);
    expect(tiersForTopic(80)).toEqual(['uncommon', 'epic']);
    expect(tiersForTopic(100)).toEqual(['uncommon', 'epic', 'legendary']);
    expect(tiersForTopic(339)).toEqual(['uncommon', 'epic', 'legendary']);
  });
});

describe('topic targets', () => {
  it('is a share of the topic, rounded up', () => {
    expect(topicTarget(110, 'uncommon')).toBe(28);   // 27.5
    expect(topicTarget(110, 'epic')).toBe(83);       // 82.5
    expect(topicTarget(110, 'legendary')).toBe(110);
  });

  it('refuses a tier the topic is too small for', () => {
    expect(topicTarget(70, 'epic')).toBeNull();
    expect(topicTarget(90, 'legendary')).toBeNull();
    expect(topicTarget(50, 'uncommon')).toBeNull();
  });

  // THE LADDER MUST NEVER INVERT. A fixed count would: "30 right" in a
  // 40-question topic is harder than 75% of it, so epic would be easier than
  // uncommon. Shares cannot cross, and this is what pins that.
  it('never lets a higher tier be easier than a lower one', () => {
    for (let size = 60; size <= 400; size++) {
      const u = topicTarget(size, 'uncommon');
      const e = topicTarget(size, 'epic');
      const l = topicTarget(size, 'legendary');
      if (e != null) expect(e).toBeGreaterThan(u);
      if (l != null) expect(l).toBeGreaterThan(e);
    }
  });

  // A topic at its floor must still be worth something. 25% of exactly 60 is
  // 15 questions — small, but a real body of knowledge rather than a handful.
  it('is meaningful even at the floor', () => {
    expect(topicTarget(60, 'uncommon')).toBe(15);
    expect(topicTarget(80, 'epic')).toBe(60);
    expect(topicTarget(100, 'legendary')).toBe(100);
  });
});

describe('subject targets', () => {
  const sizes = { ancient: 110, medieval: 96, early: 84, modern: 115 };
  const t = subjectTargets(405, sizes);

  it('keeps the on-ramp cheap', () => {
    expect(t.common).toBe(10);
  });

  it('asks a quarter of EVERY topic for the breadth word', () => {
    expect(t.rare.everyTopic).toEqual({ ancient: 28, medieval: 24, early: 21, modern: 29 });
  });

  // WITHOUT THIS FLOOR, RARE CAN RANK BELOW UNCOMMON. A subject of two
  // 40-question topics would want 10 + 10 = 20 right, which is less than a
  // single uncommon in a big topic.
  it('carries a total floor so breadth can never be cheaper than depth', () => {
    expect(t.rare.atLeast).toBe(100);
    const small = subjectTargets(80, { a: 40, b: 40 });
    const spread = Object.values(small.rare.everyTopic).reduce((n, x) => n + x, 0);
    expect(spread).toBeLessThan(small.rare.atLeast);
  });

  it('asks for all of it at mythic', () => {
    expect(t.mythic).toBe(405);
  });
});

describe('meeting a target', () => {
  it('needs the count to reach it', () => {
    expect(meetsTopic(27, 28)).toBe(false);
    expect(meetsTopic(28, 28)).toBe(true);
    expect(meetsTopic(99, 28)).toBe(true);
  });

  it('is never met when the tier is not offered', () => {
    expect(meetsTopic(999, null)).toBe(false);
  });
});

// The numbers the owner agreed, pinned so a later edit has to be deliberate.
describe('the agreed values', () => {
  it('floors are 60 / 80 / 100', () => {
    expect(TOPIC_FLOOR).toEqual({ uncommon: 60, epic: 80, legendary: 100 });
  });
  it('shares are 25 / 75 / 100 percent', () => {
    expect(TOPIC_SHARE).toEqual({ uncommon: 0.25, epic: 0.75, legendary: 1.00 });
  });
  it('subject words are 10 right, a quarter of every topic, and all of it', () => {
    expect(SUBJECT_RULE.common.right).toBe(10);
    expect(SUBJECT_RULE.rare.everyTopicShare).toBe(0.25);
    expect(SUBJECT_RULE.rare.floorRight).toBe(100);
    expect(SUBJECT_RULE.mythic.share).toBe(1.00);
  });
});

// A "miscellaneous" topic is big enough to qualify in several subjects, but a
// word meaning "you have mastered Miscellaneous" says nothing about what
// somebody knows — which is the whole job of that column.
describe('misc topics', () => {
  it('offers no words of its own however big it is', () => {
    expect(tiersForTopic(148, 'misc')).toEqual([]);
    expect(tiersForTopic(58, 'human-misc')).toEqual([]);
    expect(tiersForTopic(999, 'misc')).toEqual([]);
  });

  it('still lets ordinary topics through', () => {
    expect(tiersForTopic(148, 'space')).toEqual(['uncommon', 'epic', 'legendary']);
    // Not every key containing "misc" is one — only the topic itself.
    expect(tiersForTopic(148, 'miscellany-of-arms')).toEqual(['uncommon', 'epic', 'legendary']);
  });

  it('is unchanged when no key is given', () => {
    expect(tiersForTopic(148)).toEqual(['uncommon', 'epic', 'legendary']);
  });
});
