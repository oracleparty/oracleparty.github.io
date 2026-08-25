#!/usr/bin/env node
// ============================================
// Oracle Party — is any project function CALLED with fewer arguments than it
// requires?
//
// This bug class has shipped here. `amendQuestionHistory` and
// `revokeQuestionHistory` gained a required `roomId` when migration 041 moved
// them behind SECURITY DEFINER functions, and a call site that forgot it passed
// `undefined` — which is not an error in JavaScript, so the correction simply
// did nothing for that player. Nothing in the suite could see it: the unit tests
// do not touch those modules, and module-integrity only checks that a called
// name is IMPORTED, not that it is called properly.
//
// REGEX IS NOT A JAVASCRIPT PARSER, and this does not pretend to be one. It
// narrows the problem until a simple check is provably sound (CLAUDE.md):
//
//   * only functions this project EXPORTS, declared as `export function f(...)`
//     with a parameter list containing no nested brackets — so the parameters
//     can be split on commas without ambiguity;
//   * only BARE calls `f(...)`, never `obj.f(...)`, so a same-named method on
//     some other object cannot be mistaken for ours;
//   * only argument lists with no nested parentheses, brackets, braces,
//     template literals, arrow functions or strings containing commas — so the
//     arguments can be counted by splitting on commas without ambiguity.
//
// Anything it cannot read with certainty is SKIPPED, and the count of skipped
// calls is printed. A check that guesses is worse than one with a known blind
// spot, because people stop reading the one that cries wolf.
// ============================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');

function collect(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(full));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const FILES = collect(JS_DIR);
const SRC = new Map(FILES.map(f => [f, fs.readFileSync(f, 'utf8')]));
const rel = f => path.relative(path.join(JS_DIR, '..'), f);

/** Strip comments and string/template bodies so they cannot be mistaken for code. */
function blank(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '//') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? src.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else if (src[i] === '"' || src[i] === "'" || src[i] === '`') {
      // KEEP THE QUOTES, blank only the contents. Replacing the whole literal
      // with spaces made every string argument vanish, so `f('a')` read as a
      // call with NO arguments — six of the first seven findings were that, and
      // a checker that cries wolf is one people stop reading.
      const quote = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== quote) j += src[j] === '\\' ? 2 : 1;
      const stop = Math.min(j + 1, src.length);
      const body = src.slice(i + 1, Math.max(i + 1, stop - 1)).replace(/[^\n]/g, 'x');
      out += quote + body + (stop > i + 1 ? quote : '');
      i = stop;
    } else {
      out += src[i];
      i++;
    }
  }
  return out;
}

const CLEAN = new Map([...SRC].map(([f, s]) => [f, blank(s)]));

// ---- how many arguments each exported function REQUIRES -------------------
//
// Required means: positional, before any parameter that has a default, is a
// rest element, or is a destructuring pattern carrying its own default. A
// destructured parameter with NO default is still required — calling without it
// throws, which is exactly the failure worth catching.
const required = new Map();      // name -> { count, file, params }
const declaredIn = new Map();

for (const [file, src] of CLEAN) {
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^()]*)\)/g)) {
    const [, name, raw] = m;
    if (/[[\]{}]/.test(raw) && /=/.test(raw)) {
      // A destructured parameter with a default — readable, but the split below
      // is not safe on braces. Treat as unreadable rather than guess.
      required.set(name, null);
      continue;
    }
    if (/[[\]{}]/.test(raw)) {
      // Destructured with no default: exactly one required parameter, and no
      // commas can be split safely, so count it as 1 and stop.
      required.set(name, { count: 1, file, params: raw.trim() });
      declaredIn.set(name, file);
      continue;
    }
    const params = raw.split(',').map(p => p.trim()).filter(Boolean);
    let count = 0;
    for (const p of params) {
      if (p.startsWith('...') || p.includes('=')) break;
      count++;
    }
    required.set(name, { count, file, params: params.join(', ') });
    declaredIn.set(name, file);
  }
}

// ---- names a file declares LOCALLY, which shadow the exported one ----------
//
// question.js declares its own `getServerTimeLeft()` wrapping the imported
// three-argument version under an alias. Without this, both call sites read as
// passing no arguments to the exported function — the last two false positives,
// and the kind that would have made this script untrustworthy.
const localNames = new Map();
for (const [file, src] of CLEAN) {
  const names = new Set();
  for (const m of src.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) names.add(m[1]);
  localNames.set(file, names);
}

// ---- count arguments at each bare call site --------------------------------
const findings = [];
let skipped = 0;
let checked = 0;

for (const [file, src] of CLEAN) {
  for (const [name, info] of required) {
    if (!info || info.count === 0) continue;
    // Declared locally in this file? Then this name is not ours here.
    if (file !== info.file && localNames.get(file)?.has(name)) continue;
    const call = new RegExp(`(^|[^\\w$.])${name}\\s*\\(`, 'g');
    let m;
    while ((m = call.exec(src)) !== null) {
      const open = src.indexOf('(', m.index + m[0].length - 1);
      // The declaration itself is not a call.
      const before = src.slice(Math.max(0, m.index - 30), m.index + m[0].length);
      if (/\bfunction\s+$|\bfunction\s+[A-Za-z_$][\w$]*\s*\($/.test(before)) continue;

      let depth = 0, close = -1;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (depth === 0) { close = i; break; } }
      }
      if (close === -1) { skipped++; continue; }

      const args = src.slice(open + 1, close);
      // Only argument lists simple enough to split on commas with certainty.
      if (/[()[\]{}]/.test(args) || args.includes('=>') || args.includes('?')) { skipped++; continue; }

      const parts = args.split(',').map(a => a.trim());
      const given = args.trim() === '' ? 0 : parts.length;
      if (parts.some(p => p.startsWith('...'))) { skipped++; continue; }
      checked++;

      if (given < info.count) {
        const line = src.slice(0, m.index).split('\n').length;
        findings.push({
          file: rel(file), line, name,
          given, needs: info.count,
          params: info.params,
          declaredIn: rel(info.file),
        });
      }
    }
  }
}

console.log(`checked ${checked} call sites of ${[...required].filter(([, v]) => v && v.count).length} functions; skipped ${skipped} too complex to read with certainty`);

if (findings.length === 0) {
  console.log('✓ every readable call passes at least as many arguments as its function requires');
  process.exit(0);
}

console.log(`\n✗ ${findings.length} call(s) pass fewer arguments than required:\n`);
for (const f of findings) {
  console.log(`  ${f.file}:${f.line}  ${f.name}(...) given ${f.given}, needs ${f.needs}`);
  console.log(`      declared in ${f.declaredIn} as (${f.params})`);
}
process.exit(1);
