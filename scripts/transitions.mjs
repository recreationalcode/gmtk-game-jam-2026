/**
 * Floor-transition regression test.
 *
 * Drives descend/ascend directly rather than hoping a random bounce lands on
 * the right tile, and asserts that every floor you can be standing on is
 * actually renderable.
 *
 * Guards the bug where descending left the departed floor's `dissolve` pinned
 * at 1 forever. Because floors persist for the whole run, bouncing back up made
 * that floor active with every tile scaled to zero — you could bounce around on
 * a completely invisible board.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/transitions.mjs
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.FULLRUN_URL ?? 'http://127.0.0.1:5173';
const OUT = process.env.SMOKE_OUT ?? path.dirname(fileURLToPath(import.meta.url));
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

await page.goto(`${BASE}/?matchSeconds=600&tier=low`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.locator('#screen-title button[data-act="play"]').click();
await page.waitForTimeout(1200);
// This test is about floors, not tips, and its waits are in real time. A notice
// on screen slows the simulation to a tenth, which would leave a freshly
// generated floor still playing its spawn animation when the probe runs.
await page.evaluate(() => window.pogo.notifications.clear());
await page.waitForTimeout(500);

/**
 * Park the rider high above the floor with upward velocity, so the live
 * simulation cannot land them on a random tile mid-test and quietly change the
 * depth out from under an assertion.
 */
const hover = () =>
  page.evaluate(() => {
    const g = window.pogo.game;
    g.player.y = g.floor.y + 40;
    g.player.vy = 6;
    g.player.x = 0;
    g.player.z = 0;
  });

/**
 * Drop the rider back to a normal bounce height before screenshotting. At the
 * hover altitude the fog fully occludes the floor, which makes for a very
 * convincing but entirely misleading "the tiles are missing" picture.
 */
const settle = () =>
  page.evaluate(() => {
    const g = window.pogo.game;
    g.player.y = g.floor.y + 3;
    g.player.vy = 0;
  });

/** Snapshot of whether the active floor could actually be seen. */
const probe = (label, expectedDepth) =>
  page.evaluate(([tag, expected]) => {
    const g = window.pogo.game;
    const f = g.floor;
    return {
      step: tag,
      expectedDepth: expected,
      depth: g.depth,
      multiplier: g.multiplier,
      dissolve: +f.dissolve.toFixed(3),
      // A floor whose tiles are all scaled to zero is invisible even though it
      // is fully present in the simulation — this is the assertion that matters.
      visibleTiles: f.tiles.filter((t) => t.alive > 0.01).length,
      totalTiles: f.tiles.length,
      floorY: f.y,
      playerFloorY: g.player.floorY,
    };
  }, [label, expectedDepth]);

const descend = async () => {
  await hover();
  await page.evaluate(() => {
    window.pogo.game.descend(0, 0);
    window.pogo.notifications.clear();
  });
  // Long enough to outlast the dissolve animation, which is when the bug bit.
  await page.waitForTimeout(1100);
  await hover();
};

const ascend = async () => {
  await hover();
  await page.evaluate(() => {
    const g = window.pogo.game;
    g.ascend(0, 0, g.floor.tiles[0]);
    window.pogo.notifications.clear();
  });
  await page.waitForTimeout(1100);
  await hover();
};

await hover();
const steps = [await probe('start', 0)];

// Descend, wait past the dissolve, then climb back — the reported sequence.
await descend();
steps.push(await probe('after descend', 1));

await ascend();
steps.push(await probe('after ascend back', 0));
await settle();
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT, 'transition-after-ascend.png') });

// And down again, to confirm a revisited floor still works.
await descend();
steps.push(await probe('after re-descend', 1));

// Three levels deep, then all the way back up.
await descend();
await descend();
steps.push(await probe('depth 3', 3));

await ascend();
await ascend();
await ascend();
steps.push(await probe('back at surface', 0));
await settle();
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT, 'transition-back-at-surface.png') });

const failures = steps.filter(
  (s) => s.visibleTiles === 0 || s.dissolve > 0.001 || s.depth !== s.expectedDepth,
);

// --- burned tiles must come back as numbers when a floor is re-entered -----
//
// Without this, decay is a one-way ratchet: every floor you have visited is
// permanently worse than you left it, and one bad bounce compounds into a
// spiral. Rot the surface floor hard, leave, come back, and check it recovered.
await hover();
const rot = await page.evaluate(() => {
  const g = window.pogo.game;
  // Force every number tile to the brink so the next ticks burn them out.
  for (const t of g.floor.tiles) {
    if (t.kind === 0) {
      t.value = 1;
      t.decayTimer = 0.05;
    }
  }
  return null;
});
void rot;
await page.waitForTimeout(1800);

const before = await page.evaluate(() => {
  const f = window.pogo.game.floor;
  const k = f.tiles.reduce((m, t) => ((m[t.kind] = (m[t.kind] || 0) + 1), m), {});
  return { numbers: k[0] || 0, up: k[2] || 0, burned: f.tiles.filter((t) => t.burned).length };
});

await descend();
await ascend();

const after = await page.evaluate(() => {
  const f = window.pogo.game.floor;
  const k = f.tiles.reduce((m, t) => ((m[t.kind] = (m[t.kind] || 0) + 1), m), {});
  return { numbers: k[0] || 0, up: k[2] || 0, burned: f.tiles.filter((t) => t.burned).length };
});

const refresh = {
  before,
  after,
  recovered: after.numbers > before.numbers && after.burned === 0,
};
if (!refresh.recovered) failures.push({ step: 'burned tiles did not refresh', ...refresh });

console.log(JSON.stringify({ steps, refresh, failures, pageErrors }, null, 1));

await browser.close();
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\nFAIL: ${failures.length} floor(s) were active but not renderable.\n`);
  process.exit(1);
}
console.error('\nPASS: every active floor was renderable.\n');
