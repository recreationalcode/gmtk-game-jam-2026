/**
 * Build an itch.io-ready zip from dist/.
 *
 * itch serves an uploaded HTML5 zip by looking for `index.html` at the *root of
 * the archive* and then loading every asset relative to it. The two ways this
 * goes wrong on jam day are zipping the containing folder (so index.html ends
 * up one level down) and building with absolute asset paths. This script
 * verifies both before it writes anything, so a broken upload fails here rather
 * than in front of players.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const BUILD = path.join(ROOT, 'build');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ZIP = path.join(BUILD, `pogo-drop-v${pkg.version}.zip`);

function fail(message) {
  console.error(`\n  package-itch: ${message}\n`);
  process.exit(1);
}

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

fs.mkdirSync(BUILD, { recursive: true });
fs.rmSync(ZIP, { force: true });

// `-r . ` from inside dist/ keeps index.html at the archive root; zipping the
// directory itself would nest it one level down and itch would refuse to run it.
execFileSync('zip', ['-r', '-q', '-9', ZIP, '.', '-x', '.DS_Store', '-x', '__MACOSX/*'], {
  cwd: DIST,
  stdio: 'inherit',
});

const listing = execFileSync('unzip', ['-l', ZIP], { encoding: 'utf8' });
if (!/\sindex\.html\s*$/m.test(listing)) {
  fail('index.html is not at the root of the archive. itch.io will not run this.');
}

const bytes = fs.statSync(ZIP).size;
const files = [...listing.matchAll(/^\s+\d+\s+\S+\s+\S+\s+(.+)$/gm)].length;

console.log(`
  Pogo Drop — itch.io package
  ---------------------------
  archive : ${path.relative(ROOT, ZIP)}
  size    : ${(bytes / 1024 / 1024).toFixed(2)} MB
  files   : ${files}
  layout  : index.html verified at archive root
  paths   : verified relative
  board   : ${describeBoard()}

  Upload to itch.io, tick "This file will be played in the browser",
  and set the embed size to at least 960x640 (the game is responsive
  and also handles fullscreen).
`);

/**
 * Report which leaderboard the *archive* will actually use.
 *
 * Vite inlines VITE_* at build time, so a missing variable produces a zip that
 * runs perfectly and quietly keeps scores in localStorage. That is impossible
 * to spot by playing it and only shows up once it is live, so the packager says
 * it out loud. Read from the bundle rather than from .env, because the bundle
 * is what gets uploaded — a variable exported after the build was run would
 * otherwise report a board the zip does not have.
 */
function describeBoard() {
  const bundle = fs
    .readdirSync(path.join(DIST, 'assets'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => fs.readFileSync(path.join(DIST, 'assets', f), 'utf8'))
    .join('');

  // The *assignment* form. A bare mention is just the property access in
  // readConfig(), which is present whether or not the value was ever set.
  const baked = (name) => new RegExp(`${name}\\s*:\\s*["'\`]([^"'\`]+)`).exec(bundle)?.[1];

  const proxy = baked('VITE_LEADERBOARD_PROXY');
  if (proxy) return `proxy → ${proxy}`;
  if (baked('VITE_SIMPLEBOARDS_API_KEY') && baked('VITE_SIMPLEBOARDS_LEADERBOARD_ID')) {
    return 'direct — WARNING: the API key is inside this zip and is extractable';
  }
  return [
    'LOCAL ONLY — no online board in this zip',
    '',
    '            The game will say "The online board is not set up." Set',
    '            VITE_LEADERBOARD_PROXY (see .env.example) and re-run',
    '            `npm run package` before uploading. It is inlined at build',
    '            time, so setting it afterwards changes nothing.',
  ].join('\n');
}
