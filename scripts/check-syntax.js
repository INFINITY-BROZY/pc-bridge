'use strict';

/**
 * Syntax-check all JavaScript and JSON files in the repository without any
 * third-party dependencies. Used by npm run check and CI.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP = new Set(['.git', 'node_modules', 'workspace', 'logs', 'coverage', 'dist', 'build']);
const jsFiles = [];
const jsonFiles = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full);
    } else if (entry.isFile()) {
      if (/\.(?:c|m)?js$/i.test(entry.name)) jsFiles.push(full);
      else if (/\.json$/i.test(entry.name)) jsonFiles.push(full);
    }
  }
}

walk(ROOT);

let failed = 0;

for (const file of jsFiles) {
  const rel = path.relative(ROOT, file);
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    console.error(`\n[FAIL] ${rel}\n${result.stderr || result.stdout}`);
  }
}

for (const file of jsonFiles) {
  const rel = path.relative(ROOT, file);
  try {
    JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    failed++;
    console.error(`\n[FAIL] ${rel}\n${err.message}`);
  }
}

if (failed) {
  console.error(`\n${failed} file(s) failed validation.`);
  process.exit(1);
}

console.log(`Syntax OK: ${jsFiles.length} JavaScript file(s), ${jsonFiles.length} JSON file(s).`);
