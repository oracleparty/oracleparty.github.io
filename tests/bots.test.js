// Bot roster — checks the definitions are coherent before any behaviour is
// built on them. Nothing here tests gameplay; there is no gameplay yet.

import { describe, it, expect } from 'vitest';
import {
  BOT_ROSTER, DIFFICULTY_SHIFT, SKILL_FLOOR, SKILL_CEILING,
  getBot, botAccuracy, describeBot, debutBots, shouldHonk, HONK_PROFILE,
} from '../js/bots.js';
import { CATEGORY_META } from '../js/categories.js';

describe('the roster', () => {
  it('has unique ids and names', () => {
    const ids = BOT_ROSTER.map(b => b.id);
    const names = BOT_ROSTER.map(b => b.name);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(names).size).toBe(names.length);
  });

  it('only names categories the game actually has', () => {
    // A typo here would silently fall back to `base`, so a bot would quietly
    // lose the blind spot that gives it its character.
    const known = new Set(Object.keys(CATEGORY_META));
    for (const bot of BOT_ROSTER) {
      for (const cat of Object.keys(bot.skills || {})) {
        expect(known.has(cat), `${bot.name} lists unknown category "${cat}"`).toBe(true);
      }
    }
  });

  it('keeps every percentage inside 0..100', () => {
    for (const bot of BOT_ROSTER) {
      expect(bot.base).toBeGreaterThanOrEqual(0);
      expect(bot.base).toBeLessThanOrEqual(100);
      for (const [cat, pct] of Object.entries(bot.skills || {})) {
        expect(pct, `${bot.name}/${cat}`).toBeGreaterThanOrEqual(0);
        expect(pct, `${bot.name}/${cat}`).toBeLessThanOrEqual(100);
      }
    }
  });

  it('gives every bot a sane answer delay', () => {
    // A bot that answers instantly ends the round before anyone has read the
    // question, and is unmistakably a machine.
    for (const bot of BOT_ROSTER) {
      const [lo, hi] = bot.speed;
      expect(lo, `${bot.name} answers too fast`).toBeGreaterThanOrEqual(2);
      expect(hi).toBeGreaterThan(lo);
    }
  });

  it('spans a real range of strength, not six variations of medium', () => {
    const bases = BOT_ROSTER.map(b => b.base);
    expect(Math.max(...bases) - Math.min(...bases)).toBeGreaterThanOrEqual(40);
  });

  it('gives the specialists genuine blind spots', () => {
    // The whole point of per-category skill: a bot that is uniformly mediocre
    // is a difficulty slider, not a character.
    //
    // Two bots are exempt, and they are the ends of the range rather than
    // specialists: The Archivist is meant to be strong everywhere (that is
    // what makes it the yardstick), and Pip is meant to be weak everywhere.
    // Handing Pip a strong category to satisfy this rule would blur the one
    // thing Pip is for.
    const ENDS_OF_THE_RANGE = new Set(['archivist', 'pip']);
    for (const bot of BOT_ROSTER.filter(b => !ENDS_OF_THE_RANGE.has(b.id))) {
      const pcts = Object.values(bot.skills || {});
      const spread = Math.max(...pcts) - Math.min(...pcts);
      expect(spread, `${bot.name} has no real weakness`).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('botAccuracy', () => {
  const bot = getBot('wick');

  it('uses the category skill when there is one', () => {
    expect(botAccuracy(bot, 'history', 'medium')).toBe(92);
  });

  it('falls back to base for a category the bot has no opinion about', () => {
    expect(botAccuracy(bot, 'food', 'medium')).toBe(bot.base);
  });

  it('shifts with difficulty', () => {
    const easy = botAccuracy(bot, 'science', 'easy');
    const medium = botAccuracy(bot, 'science', 'medium');
    const hard = botAccuracy(bot, 'science', 'hard');
    expect(easy).toBeGreaterThan(medium);
    expect(hard).toBeLessThan(medium);
    expect(easy - medium).toBe(DIFFICULTY_SHIFT.easy);
  });

  it('never reaches certainty in either direction', () => {
    // Even Wick on an easy history question can miss, and even Pip on a hard
    // science question can fluke it. A bot that is guaranteed right is not
    // playing the game.
    const best = botAccuracy(getBot('archivist'), 'history', 'easy');
    const worst = botAccuracy(getBot('pip'), 'logic', 'hard');
    expect(best).toBeLessThanOrEqual(SKILL_CEILING);
    expect(worst).toBeGreaterThanOrEqual(SKILL_FLOOR);
  });

  it('returns 0 rather than throwing for a bot that does not exist', () => {
    expect(botAccuracy(getBot('nobody'), 'history', 'easy')).toBe(0);
  });
});

describe('describeBot', () => {
  it('names the best and worst category', () => {
    const text = describeBot(getBot('bo'), { sports: 'Sports', science: 'Science' });
    expect(text).toMatch(/Sports/);
    expect(text).toMatch(/Science/);
  });

  it('survives a bot with no listed skills', () => {
    expect(describeBot({ base: 50, skills: {} })).toBe('50% everywhere');
  });
});

describe('honks', () => {
  it('ships exactly three bots to start with', () => {
    // Six is a lot to tune without having played any of them.
    expect(debutBots().length).toBe(3);
  });

  it('spans the range in the three that debut', () => {
    // The point of picking three is contrast, not variety for its own sake.
    const debut = debutBots();
    const bases = debut.map(b => b.base);
    expect(Math.max(...bases) - Math.min(...bases)).toBeGreaterThanOrEqual(40);
    expect(new Set(debut.map(b => b.typing)).size).toBeGreaterThan(1);
    expect(new Set(debut.map(b => b.honk)).size).toBe(3);
  });

  it('applauds a human more readily than it congratulates itself', () => {
    // The reserved and glacial bots exist to make a hard question feel earned.
    // If they honked at themselves more than at a person, they would read as
    // smug rather than generous.
    for (const id of ['wick', 'archivist']) {
      const bot = getBot(id);
      const p = HONK_PROFILE[bot.honk];
      expect(p.humanNailedIt, `${bot.name}`).toBeGreaterThan(p.nailedIt);
    }
  });

  it('honks by chance, not on a schedule', () => {
    const pip = getBot('pip');
    expect(shouldHonk(pip, 'nailedIt', 0.01)).toBe(true);
    expect(shouldHonk(pip, 'nailedIt', 0.99)).toBe(false);
  });

  it('never honks for a bot or trigger it does not know', () => {
    expect(shouldHonk(null, 'nailedIt', 0)).toBe(false);
    expect(shouldHonk(getBot('pip'), 'nonsense', 0)).toBe(false);
    expect(shouldHonk({ honk: 'nonsense' }, 'nailedIt', 0)).toBe(false);
  });
});
