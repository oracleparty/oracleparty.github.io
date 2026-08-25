#!/usr/bin/env node
// ============================================
// Oracle Party — does every RPC the client calls match the function's real
// parameter names?
//
// PostgREST resolves a function by its ARGUMENT NAMES, not by position. Call
// op_set_judgement with `p_answer` where the function declares `p_answer_id`
// and the answer is HTTP 404 — the same answer you get for a function that was
// never created. The client treats 404 as "not installed" and silently takes
// its fallback, so a typo here looks exactly like a migration nobody ran.
//
// CLAUDE.md #6 records the probe learning this the hard way: it reported
// increment_questions_answered as NOT INSTALLED for days, having only ever
// POSTed `{}`. The probe now calls with the real names — but it can only say so
// AFTER a deploy, and only for the live database. This says it before.
//
// Sound by narrowing, like check-arity:
//   * only functions some migration in this repo declares, so the parameter
//     names are known rather than guessed;
//   * only `.rpc('name', { ... })` calls whose argument object is a flat
//     literal — spreads, computed keys and variables are skipped and counted.
//
// A name the client sends that the function does not declare is a hard failure.
// A parameter the function declares that the client omits is only reported when
// it has no DEFAULT, since Postgres fills the rest in.
// ============================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rel = f => path.relative(ROOT, f);

function collect(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(full, ext));
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}

// ---- what the migrations declare -------------------------------------------
//
// Later migrations replace earlier ones, so the LAST definition of a name wins —
// exactly as it does when they are pasted in order.
const declared = new Map();   // name -> { params: [{ name, hasDefault }], file }

for (const file of collect(path.join(ROOT, 'migrations'), '.sql').sort()) {
  const sql = fs.readFileSync(file, 'utf8');
  for (const m of sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_][\w]*)\s*\(([^)]*)\)/gi)) {
    const [, name, raw] = m;
    const params = raw.split(',').map(p => p.trim()).filter(Boolean).map(p => {
      const pname = (p.match(/^([a-z_][\w]*)/i) || [])[1] || null;
      return { name: pname, hasDefault: /\bDEFAULT\b|=/i.test(p) };
    }).filter(p => p.name);
    declared.set(name, { params, file });
  }
}

// ---- what the client sends -------------------------------------------------
const problems = [];
let checked = 0;
let skipped = 0;

for (const file of collect(path.join(ROOT, 'js'), '.js')) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/\.rpc\(\s*'([a-z_][\w]*)'\s*,\s*\{/g)) {
    const name = m[1];
    const spec = declared.get(name);
    if (!spec) { skipped++; continue; }   // declared in a migration this repo does not hold

    // Balance the object literal so nested braces cannot truncate it.
    const open = src.indexOf('{', m.index + m[0].length - 1);
    let depth = 0, close = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { close = i; break; } }
    }
    if (close === -1) { skipped++; continue; }

    const body = src.slice(open + 1, close);
    if (body.includes('...')) { skipped++; continue; }

    // Keys at depth zero only.
    const keys = [];
    let d = 0, token = '';
    for (const ch of body) {
      if ('{(['.includes(ch)) d++;
      else if ('})]'.includes(ch)) d--;
      if (ch === ',' && d === 0) { token = ''; continue; }
      if (ch === ':' && d === 0) { keys.push(token.trim()); token = ''; continue; }
      token += ch;
    }
    const clean = keys.map(k => k.replace(/^[\s\n]*/, '').replace(/['"]/g, '')).filter(Boolean);
    if (clean.some(k => !/^[a-z_][\w]*$/i.test(k))) { skipped++; continue; }

    checked++;
    const line = src.slice(0, m.index).split('\n').length;
    const names = new Set(spec.params.map(p => p.name));

    for (const k of clean) {
      // The harness adds this to every call so the fake store can tell who is
      // asking; it is stripped before anything reaches PostgREST.
      if (k === '__callerUserId') continue;
      if (!names.has(k)) {
        problems.push(`${rel(file)}:${line}  ${name}({ ${k} }) — the function declares (${[...names].join(', ')}). PostgREST answers 404 to an unknown argument name, which the client reads as "not installed" and silently falls back.`);
      }
    }
    for (const p of spec.params) {
      if (p.hasDefault) continue;
      if (!clean.includes(p.name)) {
        problems.push(`${rel(file)}:${line}  ${name}(...) never sends "${p.name}", which has no default — declared in ${rel(spec.file)}`);
      }
    }
  }
}

console.log(`checked ${checked} rpc call(s) against ${declared.size} declared function(s); skipped ${skipped} not declared in this repo or too dynamic to read`);

if (problems.length === 0) {
  console.log('✓ every readable rpc call matches its function signature');
  process.exit(0);
}
console.log(`\n✗ ${problems.length} rpc call(s) do not match:\n`);
for (const p of problems) console.log('  ' + p);
process.exit(1);
