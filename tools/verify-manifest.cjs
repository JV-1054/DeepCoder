'use strict';

// Verifies a package folder against its own release-manifest.json.
//
//   node tools/verify-manifest.cjs [package folder]

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const dir = process.argv[2] || path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'release-manifest.json'), 'utf8'));
let bad = 0;
for (const file of manifest.files) {
  const bytes = fs.readFileSync(path.join(dir, ...file.path.split('/')));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== file.sha256 || bytes.length !== file.bytes) {
    console.log('MISMATCH', file.path);
    bad += 1;
  }
}
const SKIP_DIRS = new Set(['node_modules', '.git', '.github', '.githooks']);
const onDisk = [];
(function walk(root, prefix = '') {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'release-manifest.json') continue;
    if (entry.name === 'deepcoder-config.json') continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(root, entry.name), relative);
    else if (entry.isFile()) onDisk.push(relative);
  }
})(dir);
onDisk.sort();
const listed = manifest.files.map((f) => f.path).sort();
const missing = onDisk.filter((name) => !listed.includes(name));
console.log(`${manifest.files.length} files listed, ${bad} mismatches, ${missing.length} unlisted on disk`);
if (missing.length) console.log('unlisted:', missing.join(', '));
process.exitCode = bad === 0 && missing.length === 0 ? 0 : 1;
