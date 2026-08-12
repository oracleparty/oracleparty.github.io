// ============================================
// Module integrity — catches "called but never imported" bugs.
//
// In an ES module, calling a name that is neither imported nor declared throws
// ReferenceError the moment that line runs. Three of these shipped to
// production undetected:
//
//   phases.js  fetchRoom            -> countdown self-heal was dead code, so a
//                                      host quitting mid-countdown hung the room
//   init.js    showCountdownScreen  -> threw on the host's start-game path,
//                                      skipping initHostSettingsPanel()
//   init.js    hideHostSettingsGear -> cleanup() died before reaching
//                                      `unsubscribe(ch)`, leaking one set of
//                                      Realtime subscriptions per game exit
//
// The rest of the suite cannot catch these: it only imports leaf helpers, and a
// module that throws halfway through a function still passes an import test —
// ReferenceError happens at call time, not load time. So this check is static.
//
// Scope is deliberately narrow to stay trustworthy without parsing JavaScript:
// we only consider names that some project module actually exports. That is
// precisely the bug class above (forgetting to import a real function), and it
// keeps the candidate set small enough to verify by eye.
// ============================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const JS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'js');

function collectJsFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectJsFiles(full));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

const FILES = collectJsFiles(JS_DIR);
const SOURCES = new Map(FILES.map(f => [f, fs.readFileSync(f, 'utf8')]));

/** Every name exported anywhere in the project. */
function collectProjectExports() {
  const names = new Set();
  for (const src of SOURCES.values()) {
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s+class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    // export { a, b as c }  /  export { ... } from '...'
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/gs)) {
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const halves = t.split(/\s+as\s+/);
        names.add((halves[1] || halves[0]).trim());
      }
    }
  }
  names.delete('default');
  return names;
}

const PROJECT_EXPORTS = collectProjectExports();

/** Names brought into scope by this module's import statements. */
function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/import\s+([^;]+?)\s+from\s+['"][^'"]+['"]/gs)) {
    const clause = m[1];
    for (const braced of clause.matchAll(/\{([^}]*)\}/gs)) {
      for (const part of braced[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const halves = t.split(/\s+as\s+/);
        names.add((halves[1] || halves[0]).trim());
      }
    }
    const bare = clause.replace(/\{[^}]*\}/gs, '').replace(/\*\s+as\s+/, '').replace(/,/g, '').trim();
    if (/^[A-Za-z_$][\w$]*$/.test(bare)) names.add(bare);
  }
  // Names destructured from a dynamic import: import('./x.js').then(({ a }) => …)
  for (const m of src.matchAll(/import\([^)]*\)\s*\.then\s*\(\s*\(?\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Names declared locally. Searched against raw source on purpose: a declaration
 * that only appears inside a comment would cost us a missed warning, never a
 * false alarm — the safe direction for a test that must stay trustworthy.
 */
function declaredNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  // Destructured bindings, incl. `const { data: rows } = await …`
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/gs)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().trim().split('=')[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return names;
}

const isCommentLine = line => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

/** Project-exported names this module calls as a bare identifier. */
function calledProjectExports(src) {
  const hits = new Map();
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (isCommentLine(lines[i])) continue;
    for (const m of lines[i].matchAll(/(^|[^.\w$'"`])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const name = m[2];
      if (PROJECT_EXPORTS.has(name) && !hits.has(name)) hits.set(name, i + 1);
    }
  }
  return hits;
}

describe('module integrity', () => {
  it('discovers the project source files and their exports', () => {
    expect(FILES.length).toBeGreaterThan(20);
    expect(PROJECT_EXPORTS.size).toBeGreaterThan(50);
  });

  it.each(FILES.map(f => [path.relative(JS_DIR, f), f]))(
    'js/%s imports every project function it calls',
    (_label, file) => {
      const src = SOURCES.get(file);
      const inScope = new Set([...importedNames(src), ...declaredNames(src)]);
      const missing = [...calledProjectExports(src)]
        .filter(([name]) => !inScope.has(name))
        .map(([name, line]) => `  line ${line}: ${name}() is exported elsewhere but never imported here`);

      expect(missing.join('\n'), `\n${missing.join('\n')}\n`).toBe('');
    }
  );
});
