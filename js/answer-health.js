// ============================================
// Oracle Party — Answer health
//
// Which answer keys a person should look at, and why.
//
// NO IMPORTS, deliberately. This is shared by the admin page (which runs in a
// browser and pulls Supabase from esm.sh) and scripts/probe-db.mjs (which runs
// on a GitHub runner and cannot load that), and it has to be unit-testable in
// Node, which cannot load it either. Two copies of these rules would drift,
// and the whole point is that the CI log and the admin page say the same thing.
//
// WHY THESE RULES
//
// Judging is fuzzy matching against the answer key plus its stored alternates:
// exact under four characters, then roughly one typo per four. So the shape of
// the key decides what a player is allowed to type, and a key nobody can type
// correctly produces no error and no complaint — the player simply concludes
// they were wrong.
//
// CLAUDE.md has carried the underlying rules since long before anything
// measured them: ask for the year rather than the exact date, accept ranges or
// rounded values for numbers, and flag any imported question that demands an
// exact figure.
//
// THESE ARE CANDIDATES, NOT VERDICTS. "9/11" and "1776" are exact dates that
// belong in the bank. Nothing here decides anything or writes anything; it
// produces a short list for a person to read.
// ============================================

const MONTH = '(january|february|march|april|may|june|july|august|september|october|november|december)';

// A full date — a month name beside a day number, or a numeric d/m/y — as
// opposed to a bare year, which is what the rule actually asks for.
const FULL_DATE = new RegExp(
  `(\\b\\d{1,2}\\s+${MONTH}\\b|\\b${MONTH}\\s+\\d{1,2}\\b|\\b\\d{1,2}[\\/-]\\d{1,2}[\\/-]\\d{2,4}\\b)`, 'i');

// Four or more significant digits. 1969 is a year somebody knows; 8,848 is a
// figure they have to reproduce exactly, because the matcher allows no typo
// tolerance on digits at all.
const BIG_NUMBER = /(\d[\d,.]{3,})/;

const BARE_YEAR = /^\s*(circa\s+|c\.\s*|around\s+)?\d{3,4}\s*(bc|bce|ad|ce)?\s*$/i;

// Anchored to a preceding digit, exactly like the bil/mil/k expansions already
// in normalizeAnswer, so a name ending in "m" or a word ending in "ft" is not
// caught. A key of "1,776 ft" rejects "1776 feet": distance 2, threshold 1.
const UNIT_ABBREVIATIONS = [
  ['ft', 'feet'], ['km', 'kilometres'], ['mi', 'miles'], ['cm', 'centimetres'],
  ['mm', 'millimetres'], ['kg', 'kilograms'], ['lbs', 'pounds'], ['lb', 'pounds'],
  ['oz', 'ounces'], ['mph', 'miles per hour'], ['kph', 'kilometres per hour'],
  ['sec', 'seconds'], ['min', 'minutes'], ['hr', 'hours'], ['yr', 'years'],
];

// Above this the typo allowance is so wide that almost anything passes: at 60
// characters the matcher tolerates 15 edits.
export const LONG_ANSWER_CHARS = 60;

/**
 * Look at one question's answer key.
 *
 * → null when there is nothing to say, otherwise { kind, label, why }.
 *
 * A question that already carries an acceptable alternate is never flagged.
 * An alternate is the author saying they have thought about how this gets
 * typed, which is exactly what every rule below is asking for — so listing it
 * again would be nagging somebody about work they have already done.
 */
export function classifyAnswer(question) {
  const answer = String(question?.correct_answer ?? question?.answer ?? '').trim();
  if (!answer) return null;

  const alternates = question?.acceptable_answers;
  if (Array.isArray(alternates) && alternates.length > 0) return null;

  for (const [abbr, full] of UNIT_ABBREVIATIONS) {
    if (new RegExp(`\\d\\s*${abbr}\\b\\.?\\s*$`, 'i').test(answer)) {
      return {
        kind: 'unit',
        label: 'Unit abbreviated',
        why: `A player who writes the unit out — "${full}" — is marked wrong. Add that spelling as an alternate.`,
      };
    }
  }

  if (FULL_DATE.test(answer)) {
    return {
      kind: 'date',
      label: 'Exact date',
      why: 'The rule is to ask for the year unless the date is famous. If this one is famous, add the forms people write it in.',
    };
  }

  if (!BARE_YEAR.test(answer) && BIG_NUMBER.test(answer)) {
    return {
      kind: 'number',
      label: 'Exact figure',
      why: 'Digits are matched exactly — no typo tolerance at all — so a rounded or differently-punctuated answer fails. Add the forms people would type.',
    };
  }

  if (answer.length > LONG_ANSWER_CHARS) {
    return {
      kind: 'long',
      label: 'Very long',
      why: `Over ${LONG_ANSWER_CHARS} characters, so the matcher tolerates 15+ typos and almost anything passes.`,
    };
  }

  return null;
}

/** Every question worth a look, each with its finding attached. */
export function findAnswersNeedingReview(questions) {
  const out = [];
  for (const q of questions || []) {
    const finding = classifyAnswer(q);
    if (finding) out.push({ question: q, finding });
  }
  return out;
}
