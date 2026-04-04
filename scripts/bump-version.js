#!/usr/bin/env node
// ============================================
// Oracle Party — Cache Version Bumper
// Updates ?v= suffixes on all CSS and JS references in HTML files.
//
// Usage:
//   node scripts/bump-version.js          # uses today's date (YYYYMMDD)
//   node scripts/bump-version.js 20260405 # uses custom version string
// ============================================

import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..');
const HTML_FILES = [
  'index.html', 'host.html', 'join.html', 'lobby.html',
  'game.html', 'leaderboard.html', 'admin.html', 'profile.html',
];

const version = process.argv[2] || new Date().toISOString().slice(0, 10).replace(/-/g, '');

let totalUpdates = 0;

for (const file of HTML_FILES) {
  const filePath = join(ROOT, file);
  let content = await readFile(filePath, 'utf8');
  const original = content;

  // Update CSS: style.css?v=XXXX
  content = content.replace(/style\.css\?v=[^"']+/g, `style.css?v=${version}`);

  // Update JS: src="js/...?v=XXXX"
  content = content.replace(/(src="js\/[^"?]+)\?v=[^"]+/g, `$1?v=${version}`);

  if (content !== original) {
    await writeFile(filePath, content);
    totalUpdates++;
    console.log(`  ${file} → v=${version}`);
  }
}

console.log(`\nUpdated ${totalUpdates} file${totalUpdates !== 1 ? 's' : ''} to v=${version}`);
