import { describe, it, expect } from 'vitest';
import { titleWordsHtml } from '../js/titles.js';

// Each word of a worn title carries its rarity, everywhere a title appears
// (owner, 2026-10-30). A seat holds the title as TEXT, so the words are
// matched back reel by reel.
const rarities = html => [...html.matchAll(/data-rarity="(\w+)">([^<]+)</g)].map(m => `${m[2]}:${m[1]}`);

describe('titleWordsHtml', () => {
  it('colours each word of a three-reel title by its own rarity', () => {
    expect(rarities(titleWordsHtml('Lucky Science Oracle')))
      .toEqual(['Lucky:legendary', 'Science:common', 'Oracle:mythic']);
  });
  it('prints a word it does not know plain, never guessed', () => {
    expect(titleWordsHtml('Guest')).toBe('Guest');
    expect(rarities(titleWordsHtml('Brave Mysteryword Hermit')))
      .toEqual(['Brave:common', 'Hermit:uncommon']);
  });
  it('escapes what it prints — the result is set as innerHTML', () => {
    expect(titleWordsHtml('Brave <img src=x> Hermit')).not.toMatch(/<img/);
  });
  it('reads the reels in order, so a word in two reels is read in the right one', () => {
    // Eternal sits in reel 2 AND reel 3; the second word must be read as reel 3.
    const html = titleWordsHtml('Eternal Eternal');
    expect(rarities(html)).toHaveLength(2);
  });
});
