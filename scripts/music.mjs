/**
 * Music regression test.
 *
 * There are three tracks now — title, match, post-run — and none of them can be
 * checked by looking at a screenshot. What *can* be checked is that each one
 * actually reaches the audio hardware, and that they are recognisably different
 * pieces of music rather than the same pattern three times.
 *
 * It works by counting the nodes each track schedules, per second, by patching
 * the AudioContext before the app boots. A silent track counts zero; a track
 * that failed to switch counts the same as the one before it.
 *
 * Deliberately does *not* pass --autoplay-policy=no-user-gesture-required. The
 * title track is requested before any input exists, so the interesting question
 * is whether it starts on the player's first real gesture — and that only gets
 * tested with the real policy in force.
 *
 * That first gesture is a *button on the title panel*, which is what a player
 * actually does. An earlier version of this test pressed a key on `window`
 * instead, which passed while the real thing was silent: `Input` listens on the
 * canvas, and the panel sits on top of it, so no menu click ever reached the
 * unlock. A test is only worth the path it takes.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/music.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.FULLRUN_URL ?? 'http://127.0.0.1:5173';
const EXECUTABLE =
  process.env.SMOKE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
  ],
});

const page = await browser.newPage({ viewport: { width: 800, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

// Patch before any app code runs, so nothing is missed during boot.
await page.addInitScript(() => {
  const tally = { osc: 0, noise: 0, byWave: {} };
  window.__audioTally = tally;
  const AC = window.AudioContext;
  const osc = AC.prototype.createOscillator;
  const buf = AC.prototype.createBufferSource;
  AC.prototype.createOscillator = function patched() {
    const node = osc.call(this);
    const start = node.start.bind(node);
    node.start = (...a) => {
      tally.osc++;
      tally.byWave[node.type] = (tally.byWave[node.type] ?? 0) + 1;
      return start(...a);
    };
    return node;
  };
  AC.prototype.createBufferSource = function patched() {
    const node = buf.call(this);
    const start = node.start.bind(node);
    node.start = (...a) => {
      tally.noise++;
      return start(...a);
    };
    return node;
  };
  window.__audioReset = () => {
    tally.osc = 0;
    tally.noise = 0;
    tally.byWave = {};
  };
});

await page.goto(`${BASE}/?matchSeconds=6&tier=low`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

const results = {};

// --- the title track must survive the autoplay policy ----------------------
// It is requested before any gesture exists, so it can only start once the
// engine retries on unlock. Silence here means that retry is broken.
results.beforeAnyInput = await page.evaluate(() => ({ ...window.__audioTally }));

// The realistic first interaction: a button on the title panel, over the canvas.
await page.click('#screen-title button[data-act="guide"]');
await page.waitForTimeout(500);
results.afterMenuClick = await page.evaluate(() => ({
  notes: window.__audioTally.osc,
  track: window.pogo.audio.currentTrack,
}));

await page.click('#screen-guide button[data-act="back"]');
await page.waitForTimeout(300);
await page.evaluate(() => window.__audioReset());
await page.waitForTimeout(2500);
results.title = await page.evaluate(() => ({ ...window.__audioTally }));
results.titleTrack = await page.evaluate(() => window.pogo.audio.currentTrack);

// --- the match track -------------------------------------------------------
await page.click('#screen-title button[data-act="play"]');
await page.waitForTimeout(600);
await page.evaluate(() => window.__audioReset());
await page.waitForTimeout(2500);
results.match = await page.evaluate(() => ({ ...window.__audioTally }));
results.matchTrack = await page.evaluate(() => window.pogo.audio.currentTrack);

// --- the post-run track ----------------------------------------------------
// The 6-second match runs out on its own; the clock only starts on the first
// landing, so allow for the opening drop.
await page.waitForTimeout(14000);
await page.evaluate(() => window.__audioReset());
await page.waitForTimeout(2500);
results.over = await page.evaluate(() => ({ ...window.__audioTally }));
results.overTrack = await page.evaluate(() => window.pogo.audio.currentTrack);
results.screen = await page.evaluate(() => window.pogo.screens.currentScreen);

const failures = [];
const check = (label, ok) => {
  if (!ok) failures.push(label);
};

// Nothing may sound before the first gesture — that is the autoplay contract,
// and a browser that enforces it harder than Chromium would simply refuse.
check(
  `${results.beforeAnyInput.osc} notes played before any input`,
  results.beforeAnyInput.osc === 0,
);
check(
  'clicking a title-panel button did not start the music — the unlock never reaches the menu',
  results.afterMenuClick.notes > 0 && results.afterMenuClick.track === 'title',
);
check('the title track never started — the unlock retry is broken', results.title.osc > 0);
check('the title track is not selected', results.titleTrack === 'title');
check('the match track is silent', results.match.osc > 0);
check('the match track is not selected', results.matchTrack === 'game');
check('the run did not end into the summary screen', results.screen === 'over');
check('the post-run track is not selected', results.overTrack === 'over');
check('the post-run track is silent', results.over.osc > 0);

// The three are meant to be different pieces of music, not one pattern at three
// tempos. Title is the busiest by design; chill has almost no percussion.
check(
  `title should be busier than post-run (${results.title.osc} vs ${results.over.osc})`,
  results.title.osc > results.over.osc * 1.5,
);
check(
  `post-run should be nearly percussion-free (${results.over.noise} noise hits)`,
  results.over.noise < results.title.noise / 2,
);
check('title should use the clap/hat noise voice', results.title.noise > 0);

console.log(JSON.stringify({ results, failures, pageErrors }, null, 1));

await browser.close();
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}\n`);
  process.exit(1);
}
console.error('\nPASS: all three tracks play, and they are different pieces of music.\n');
