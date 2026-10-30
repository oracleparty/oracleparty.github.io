import { describe, it, expect } from 'vitest';
import {
  TOPIC_FLOOR, TOPIC_SHARE, TOPIC_CAP, SUBJECT_RULE,
  tiersForTopic, topicTarget, subjectTargets, meetsTopic, isMiscTopic,
  liveTarget, shapeTopicSizes,
  placeholderWord, PLACEHOLDER_MAX,
} from '../js/title-tiers.js';

describe('which tiers a topic offers', () => {
  it('offers nothing below the smallest floor', () => {
    expect(tiersForTopic(59)).toEqual([]);
    expect(tiersForTopic(5)).toEqual([]);
  });

  it('opens up as the topic grows: 60 / 70 / 80 / 100', () => {
    expect(tiersForTopic(60)).toEqual(['uncommon']);
    expect(tiersForTopic(70)).toEqual(['uncommon', 'rare']);
    expect(tiersForTopic(80)).toEqual(['uncommon', 'rare', 'epic']);
    expect(tiersForTopic(100)).toEqual(['uncommon', 'rare', 'epic', 'legendary']);
    expect(tiersForTopic(339)).toEqual(['uncommon', 'rare', 'epic', 'legendary']);
  });
});

describe('topic targets', () => {
  it('is a share of the topic, rounded up, while under the cap', () => {
    expect(topicTarget(86, 'uncommon')).toBe(22);    // 21.5
    expect(topicTarget(103, 'rare')).toBe(52);       // 51.5
    expect(topicTarget(151, 'epic')).toBe(114);      // 113.25
    expect(topicTarget(151, 'legendary')).toBe(151);
  });

  // THE OWNER'S CAPS (2026-10-30): whichever comes first, the share or the cap.
  it('never asks more than 25 / 100 / 250 for the easier steps', () => {
    expect(topicTarget(151, 'uncommon')).toBe(25);
    expect(topicTarget(400, 'rare')).toBe(100);
    expect(topicTarget(600, 'epic')).toBe(250);
    expect(topicTarget(600, 'legendary')).toBe(600);   // no cap: meant to be hard
  });

  it('refuses a tier the topic is too small for', () => {
    expect(topicTarget(69, 'rare')).toBeNull();
    expect(topicTarget(70, 'epic')).toBeNull();
    expect(topicTarget(90, 'legendary')).toBeNull();
    expect(topicTarget(50, 'uncommon')).toBeNull();
  });

  // THE LADDER MUST NEVER INVERT, caps included: a higher step is never
  // easier than the one below it, at any size.
  it('never lets a higher tier be easier than a lower one', () => {
    for (let size = 60; size <= 2000; size++) {
      const ladder = ['uncommon', 'rare', 'epic', 'legendary']
        .map(t => topicTarget(size, t)).filter(x => x != null);
      for (let i = 1; i < ladder.length; i++) expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
    }
  });

  it('is meaningful even at the floor', () => {
    expect(topicTarget(60, 'uncommon')).toBe(15);
    expect(topicTarget(70, 'rare')).toBe(35);
    expect(topicTarget(80, 'epic')).toBe(60);
    expect(topicTarget(100, 'legendary')).toBe(100);
  });
});

describe('subject targets', () => {
  const t = subjectTargets(405);
  it('keeps the on-ramp cheap', () => expect(t.common).toBe(10));
  it('asks for all of it at mythic', () => expect(t.mythic).toBe(405));
  it('has no subject-wide rare any more (it moved onto the topics)', () => {
    expect(t.rare).toBeUndefined();
  });
});

describe('live targets follow the topic size', () => {
  const rows = [
    { category: 'science', subcategory: 'human-body', n: 151 },
    { category: 'science', subcategory: 'space', n: 86 },
    { category: 'science', subcategory: null, n: 3 },
    { category: 'world-geography', subcategory: 'human-countries', n: 146 },
    { category: 'world-geography', subcategory: 'human-countries-capitals', n: 121 },
  ];
  const keys = { science: ['human-body', 'space', 'elements'], 'world-geography': ['human', 'human-countries'] };
  const sizes = shapeTopicSizes(rows, Object.keys(keys), c => keys[c]);

  it('sums a topic by prefix, the way questions are picked', () => {
    expect(sizes['world-geography'].sizes.human).toBe(267);
    expect(sizes['world-geography'].sizes['human-countries']).toBe(267);
    expect(sizes.science.sizes.elements).toBe(0);
    expect(sizes.science.subjectSize).toBe(240);
  });

  it('gives each word its goal from today\'s size', () => {
    expect(liveTarget(sizes, 'science', 'human-body', 'rare')).toBe(76);
    expect(liveTarget(sizes, 'science', 'space', 'legendary')).toBeNull();
    expect(liveTarget(sizes, 'science', null, 'mythic')).toBe(240);
    expect(liveTarget(sizes, 'science', null, 'common')).toBe(10);
  });

  it('says nothing when it cannot tell', () => {
    expect(liveTarget(null, 'science', 'space', 'uncommon')).toBeNull();
    expect(liveTarget(sizes, 'nature', 'animals', 'uncommon')).toBeNull();
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
  it('floors are 60 / 70 / 80 / 100', () => {
    expect(TOPIC_FLOOR).toEqual({ uncommon: 60, rare: 70, epic: 80, legendary: 100 });
  });
  it('shares are a quarter, half, three quarters and all', () => {
    expect(TOPIC_SHARE).toEqual({ uncommon: 0.25, rare: 0.50, epic: 0.75, legendary: 1.00 });
  });
  it('caps are 25 / 100 / 250, none on legendary', () => {
    expect(TOPIC_CAP).toEqual({ uncommon: 25, rare: 100, epic: 250 });
  });
  it('subject words are 10 right, and all of it', () => {
    expect(SUBJECT_RULE).toEqual({ common: { right: 10 }, mythic: { share: 1.00 } });
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
    expect(tiersForTopic(148, 'space')).toEqual(['uncommon', 'rare', 'epic', 'legendary']);
    // Not every key containing "misc" is one — only the topic itself.
    expect(tiersForTopic(148, 'miscellany-of-arms')).toEqual(['uncommon', 'rare', 'epic', 'legendary']);
  });

  it('is unchanged when no key is given', () => {
    expect(tiersForTopic(148)).toEqual(['uncommon', 'rare', 'epic', 'legendary']);
  });
});

// A PLACEHOLDER IS NAMED BY RULE, NEVER INVENTED. The real words are the
// owner's to write — two earlier attempts at model-written title text were
// deleted at their instruction — so scaffolding has to read as scaffolding.
describe('placeholder words', () => {
  it('is the tier and what it is about', () => {
    expect(placeholderWord('epic', 'Science')).toBe('Epic Science');
    expect(placeholderWord('mythic', 'History')).toBe('Mythic History');
  });

  // The table refuses anything over 24 characters, so a long topic name would
  // make the save fail — silently turning "fill every empty slot" into "fill
  // most of them".
  it('never exceeds what the database allows', () => {
    const longest = [
      'Ancient & Classical Civilisations', 'Entertainment Movies',
      'Human Countries & States', 'Brands & Restaurants', 'Athletics Events',
    ];
    for (const label of longest) {
      for (const tier of ['common', 'uncommon', 'rare', 'epic', 'legendary', 'mythic']) {
        const w = placeholderWord(tier, label);
        expect(w.length, `${tier} ${label} -> "${w}"`).toBeLessThanOrEqual(PLACEHOLDER_MAX);
        expect(w.length, `${tier} ${label} came out empty`).toBeGreaterThan(0);
      }
    }
  });

  it('trims on a word boundary rather than mid-word', () => {
    expect(placeholderWord('legendary', 'Ancient & Classical Civilisations')).toBe('Legendary Ancient');
    expect(placeholderWord('uncommon', 'Entertainment Movies')).not.toMatch(/\s$/);
  });
});
