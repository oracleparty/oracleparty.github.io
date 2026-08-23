import { describe, it, expect } from 'vitest';
import { classifyAnswer, findAnswersNeedingReview, LONG_ANSWER_CHARS } from '../js/answer-health.js';

// These rules produce a list a person is asked to act on, so the cost of a
// false positive is real: a list that flags ordinary answers is a list nobody
// reads twice. The controls below matter as much as the hits.

const q = (correct_answer, acceptable_answers = []) =>
  ({ id: 'x', question: 'Q?', correct_answer, acceptable_answers });

describe('classifyAnswer — nothing to say', () => {
  it('says nothing about an ordinary answer', () => {
    for (const a of ['Paris', 'Mount Everest', 'George Washington', 'Blue', 'Oxygen']) {
      expect(classifyAnswer(q(a)), a).toBe(null);
    }
  });

  it('says nothing about a bare year, which is what the rule asks for', () => {
    for (const a of ['1776', '1969', '44 BC', 'c. 1350', 'circa 800', '2001 AD']) {
      expect(classifyAnswer(q(a)), a).toBe(null);
    }
  });

  it('says nothing about a small number inside a name', () => {
    for (const a of ['Apollo 11', 'Catch-22', 'Area 51', 'Boeing 747']) {
      expect(classifyAnswer(q(a)), a).toBe(null);
    }
  });

  it('says nothing about a month on its own', () => {
    expect(classifyAnswer(q('May'))).toBe(null);
    expect(classifyAnswer(q('September'))).toBe(null);
  });

  it('says nothing about a blank or missing answer', () => {
    expect(classifyAnswer(q(''))).toBe(null);
    expect(classifyAnswer({})).toBe(null);
    expect(classifyAnswer(null)).toBe(null);
  });

  // The single most important control. An alternate is the author saying they
  // have already thought about how this is typed; flagging it anyway would be
  // nagging somebody about work they have done, and that is how a review list
  // stops being read.
  it('says nothing about a question that already has an alternate', () => {
    expect(classifyAnswer(q('1,776 ft', ['1776 feet']))).toBe(null);
    expect(classifyAnswer(q('July 4, 1776', ['1776']))).toBe(null);
    expect(classifyAnswer(q('3.14159', ['3.14', 'pi']))).toBe(null);
  });
});

describe('classifyAnswer — what it flags', () => {
  it('flags an abbreviated unit, and names the spelling a player would use', () => {
    const f = classifyAnswer(q('1,776 ft'));
    expect(f?.kind).toBe('unit');
    expect(f.why).toContain('feet');

    expect(classifyAnswer(q('50 mph'))?.kind).toBe('unit');
    expect(classifyAnswer(q('100 km'))?.kind).toBe('unit');
  });

  it('does not read a unit out of a word that merely ends in those letters', () => {
    // No preceding digit, so none of these is a unit.
    for (const a of ['Draft', 'Gift', 'Vermin', 'Sec', 'Loft']) {
      const f = classifyAnswer(q(a));
      expect(f?.kind, a).not.toBe('unit');
    }
  });

  it('flags a full date', () => {
    for (const a of ['July 4, 1776', '4 July 1776', '11/09/2001', 'March 15', 'December 7']) {
      expect(classifyAnswer(q(a))?.kind, a).toBe('date');
    }
  });

  it('flags an exact figure', () => {
    for (const a of ['8,848', '299792458', '3.14159', '1900-1910']) {
      expect(classifyAnswer(q(a))?.kind, a).toBe('number');
    }
  });

  it('flags an answer too long to grade', () => {
    const long = 'a'.repeat(LONG_ANSWER_CHARS + 1);
    expect(classifyAnswer(q(long))?.kind).toBe('long');
    expect(classifyAnswer(q('a'.repeat(LONG_ANSWER_CHARS)))).toBe(null);
  });

  // A unit answer is also a number answer. The unit finding is the more
  // useful of the two — it names the exact spelling to add — so it wins.
  it('prefers the unit finding over the figure finding', () => {
    expect(classifyAnswer(q('1,776 ft'))?.kind).toBe('unit');
  });

  it('every finding carries a label and a reason a person can act on', () => {
    for (const a of ['1,776 ft', 'July 4, 1776', '8,848', 'a'.repeat(80)]) {
      const f = classifyAnswer(q(a));
      expect(f.label, a).toBeTruthy();
      expect(f.why.length, a).toBeGreaterThan(20);
    }
  });
});

describe('findAnswersNeedingReview', () => {
  it('returns only the questions with something to say', () => {
    const rows = [q('Paris'), q('1,776 ft'), q('1969'), q('July 4, 1776')];
    const found = findAnswersNeedingReview(rows);
    expect(found.map(f => f.finding.kind)).toEqual(['unit', 'date']);
  });

  it('copes with nothing', () => {
    expect(findAnswersNeedingReview([])).toEqual([]);
    expect(findAnswersNeedingReview(null)).toEqual([]);
  });
});
