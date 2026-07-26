/**
 * Build an itch.io-ready zip from dist/.
 *
 * itch serves an uploaded HTML5 zip by looking for `index.html` at the *root of
 * the archive* and then loading every asset relative to it. The two ways this
 * goes wrong on jam day are zipping the containing folder (so index.html ends
 * up one level down) and building with absolute asset paths. This script
 * verifies both before it writes anything, so a broken upload fails here rather
 * than in front of players.
 *
 * Two callers:
 *
 *   npm run package        →  build/pogo-drop-v<version>.zip, for uploading by hand
 *   npm run build:vercel   →  --out dist/pogo-drop-itch.zip, so the deployment
 *                             serves the upload at a fixed URL
 *
 * The names differ on purpose. A local archive wants the version in the
 * filename so successive builds do not overwrite each other; the deployed one
 * wants a stable path so a bookmark survives a version bump.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createZip } from './lib/zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function fail(message) {
  console.error(`\n  package-itch: ${message}\n`);
  process.exit(1);
}

function parseOut(argv) {
  const flag = argv.indexOf('--out');
  if (flag === -1) return path.join(ROOT, 'build', `pogo-drop-v${pkg.version}.zip`);
  const value = argv[flag + 1];
  if (!value) fail('--out needs a path.');
  return path.resolve(ROOT, value);
}

const ZIP = parseOut(process.argv.slice(2));

if (!fs.existsSync(DIST)) fail('dist/ does not exist. Run `npm run build` first.');

const indexPath = path.join(DIST, 'index.html');
if (!fs.existsSync(indexPath)) fail('dist/index.html is missing — itch needs it at the zip root.');

const html = fs.readFileSync(indexPath, 'utf8');

// Absolute asset paths 404 on itch, which serves the game from a nested path.
const absolute = [...html.matchAll(/(?:src|href)="(\/[^/][^"]*)"/g)].map((m) => m[1]);
if (absolute.length > 0) {
  fail(
    `dist/index.html references absolute paths, which 404 on itch.io:\n` +
      absolute.map((a) => `    ${a}`).join('\n') +
      `\n  Fix: set \`base: './'\` in vite.config.ts.`,
  );
}

// Every local asset the page references must actually be in the archive.
const referenced = [...html.matchAll(/(?:src|href)="(?!https?:|data:|#)([^"]+)"/g)].map((m) => m[1]);
const missing = referenced.filter((rel) => !fs.existsSync(path.join(DIST, rel.replace(/^\.\//, ''))));
if (missing.length > 0) {
  fail(`dist/index.html references files that are not in dist/:\n${missing.map((m) => `    ${m}`).join('\n')}`);
}

// Copy the player-facing docs in beside the game so the download is self-contained.
for (const doc of ['GUIDE.md', 'CREDITS.md']) {
  const from = path.join(ROOT, doc);
  if (fs.existsSync(from)) fs.copyFileSync(from, path.join(DIST, doc));
}

/**
 * Walk dist/ into archive entries.
 *
 * `.zip` is skipped so that writing the archive into dist/ — what the Vercel
 * build does — cannot fold a previous archive into the next one. Collecting the
 * list before writing already prevents an archive containing itself; this also
 * covers re-running the packaging step without a fresh `vite build`.
 */
function collect(dir, prefix = '') {
  const entries = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.name === '.DS_Store' || item.name === '__MACOSX') continue;
    if (item.isDirectory()) {
      entries.push(...collect(path.join(dir, item.name), name));
    } else if (item.isFile() && !item.name.endsWith('.zip')) {
      entries.push({ name, data: fs.readFileSync(path.join(dir, item.name)) });
    }
  }
  return entries;
}

const entries = collect(DIST);

// The layout check the old `unzip -l` grep was doing, against the list we are
// about to write: index.html at the archive root, not one level down.
if (!entries.some((entry) => entry.name === 'index.html')) {
  fail('index.html is not at the root of the archive. itch.io will not run this.');
}

const archive = createZip(entries);

fs.mkdirSync(path.dirname(ZIP), { recursive: true });
fs.writeFileSync(ZIP, archive);

console.log(`
  Pogo Drop — itch.io package
  ---------------------------
  archive : ${path.relative(ROOT, ZIP)}
  size    : ${(archive.length / 1024 / 1024).toFixed(2)} MB
  files   : ${entries.length}
  layout  : index.html verified at archive root
  paths   : verified relative

  Upload to itch.io, tick "This file will be played in the browser",
  and set the embed size to at least 960x640 (the game is responsive
  and also handles fullscreen).
`);
