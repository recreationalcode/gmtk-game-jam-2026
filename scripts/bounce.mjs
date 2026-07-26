/**
 * Bounce-height ramp test.
 *
 * The arc shrinks with depth, which is the difficulty curve. Two things have to
 * hold and neither is visible in a screenshot: the curve is smooth and
 * monotonic all the way down, and it never shrinks so far that the game stops
 * working — an UP tile still has to clear a whole storey, and a perfect still
 * has to be worth pressing for.
 *
 * Checks the pure functions across the whole depth range by importing them into
 * the page, then confirms the live simulation actually bounces to those heights.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/bounce.mjs
 */
import { chromium } from 'playwright';

const BASE = process.env.FULLRUN_URL ?? 'http://127.0.0.1:5173';
const EXECUTABLE =
  process.env.SMOKE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${BASE}/debug.html`, { waitUntil: 'networkidle' });

const failures = [];
const results = {};

// --- the curve --------------------------------------------------------------
const curve = await page.evaluate(async () => {
  const { apexFor, ascendApex, apexScaleForDepth } = await import('/src/game/Player.ts');
  const { POGO, FLOOR } = await import('/src/core/Config.ts');
  const rows = [];
  for (let d = 0; d <= 30; d++) {
    const base = apexFor('normal', d);
    rows.push({
      depth: d,
      scale: apexScaleForDepth(d),
      base,
      charged: apexFor('charged', d),
      perfect: apexFor('perfect', d),
      // Airtime is what the player actually experiences as "time to think".
      airtime: 2 * Math.sqrt((2 * base) / POGO.gravity),
    });
  }
  return { rows, ascend: ascendApex(), floorDrop: FLOOR.floorDrop, apexFloor: POGO.apexDepthFloor };
});

const rows = curve.rows;
results.sample = [0, 1, 2, 4, 8, 16, 30].map((d) => ({
  depth: d,
  base: +rows[d].base.toFixed(2),
  perfect: +rows[d].perfect.toFixed(2),
  airtime: +rows[d].airtime.toFixed(2),
}));

// Monotonic: every floor is a little lower than the one above it.
for (let d = 1; d < rows.length; d++) {
  if (rows[d].base >= rows[d - 1].base) {
    failures.push(`apex did not fall from depth ${d - 1} to ${d}`);
    break;
  }
}

// Smooth: no single floor may drop the arc by a jarring amount.
let biggestStep = 0;
let stepAt = 0;
for (let d = 1; d < rows.length; d++) {
  const step = (rows[d - 1].base - rows[d].base) / rows[0].base;
  if (step > biggestStep) {
    biggestStep = step;
    stepAt = d;
  }
}
results.biggestStep = { fraction: +biggestStep.toFixed(4), atDepth: stepAt };
if (biggestStep > 0.09) {
  failures.push(
    `depth ${stepAt} cut the bounce by ${(biggestStep * 100).toFixed(1)}% in one floor — not a smooth ramp`,
  );
}

// Bounded: it decays toward the configured floor and never past it.
const deepest = rows[rows.length - 1];
results.deepestScale = +deepest.scale.toFixed(3);
if (deepest.scale < curve.apexFloor - 0.001) {
  failures.push(`the arc fell below its floor (${deepest.scale} < ${curve.apexFloor})`);
}
if (deepest.scale > curve.apexFloor + 0.05) {
  failures.push(`the ramp has barely moved by depth 30 (${deepest.scale}) — too shallow to feel`);
}

// A perfect is always worth pressing for, at every depth...
for (const r of rows) {
  if (!(r.perfect > r.charged && r.charged > r.base)) {
    failures.push(`at depth ${r.depth} the bounce qualities are not ordered`);
    break;
  }
}
// ...and is lower than the same press one floor up, which is the whole point.
results.perfectFalls = rows[8].perfect < rows[0].perfect && rows[16].perfect < rows[8].perfect;
if (!results.perfectFalls) failures.push('a perfect bounce does not get lower with depth');

// The escape hatch must keep working however deep it gets used.
results.ascendClearance = +(curve.ascend - curve.floorDrop).toFixed(2);
if (curve.ascend <= curve.floorDrop) {
  failures.push('an UP tile can no longer clear a full storey');
}

// And the deepest bounce must still be a bounce.
results.deepestAirtime = +deepest.airtime.toFixed(2);
if (deepest.airtime < 0.85) {
  failures.push(`the deepest bounce is only ${deepest.airtime.toFixed(2)}s — no time to aim`);
}

// --- and the live simulation agrees ----------------------------------------
await page.goto(`${BASE}/?matchSeconds=600&tier=low`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.click('#screen-title button[data-act="play"]');
await page.waitForTimeout(1200);
await page.evaluate(() => window.pogo.notifications.clear());

/**
 * Bounce once from rest and report the apex actually reached, in metres, plus
 * what kind of bounce it turned out to be.
 *
 * The rider is parked over a plain NUMBER tile rather than over the origin.
 * Whatever the generator happened to put at (0, 0) is what gets landed on, and
 * half of a deep floor is UP tiles — those launch to `ascendApex`, which is
 * deliberately *not* depth-scaled, so the measurement comes back at roughly
 * twice the real bounce height and the failure looks like a broken curve.
 */
const measureApex = () =>
  page.evaluate(async () => {
    const g = window.pogo.game;
    const { TileKind } = await import('/src/core/Config.ts');
    const target = g.floor.tiles.find((t) => t.kind === TileKind.Number) ?? g.floor.tiles[0];
    g.player.x = g.floor.worldX(target.gx);
    g.player.z = g.floor.worldZ(target.gy);
    g.player.vx = 0;
    g.player.vz = 0;
    g.player.y = g.floor.y + 0.05;
    g.player.vy = -1;

    const startDepth = g.depth;
    let peak = -Infinity;
    let quality = null;
    let lastVy = g.player.vy;
    const started = performance.now();
    // Watch until it comes back down, so this is the real trajectory rather
    // than an assertion about the number that went into it.
    while (performance.now() - started < 6000) {
      await new Promise((r) => requestAnimationFrame(r));
      if (quality === null && lastVy < 0 && g.player.vy > 0) quality = g.player.lastQuality;
      lastVy = g.player.vy;
      const h = g.player.y - g.floor.y;
      if (h > peak) peak = h;
      else if (peak > 0.5 && h < peak - 0.4) break;
    }
    return { apex: +peak.toFixed(2), quality, movedFloor: g.depth !== startDepth };
  });

/** Unwrap a measurement, failing loudly if it was not the bounce we asked for. */
const apexOf = (m, where) => {
  if (m.quality !== 'normal') {
    failures.push(`the ${where} measurement got a '${m.quality}' bounce, not a plain one`);
  }
  if (m.movedFloor) failures.push(`the ${where} measurement changed floor mid-bounce`);
  return m.apex;
};

results.measured = { surface: apexOf(await measureApex(), 'surface') };
for (let i = 0; i < 8; i++) {
  await page.evaluate(() => {
    const g = window.pogo.game;
    // Park high *and rising*. Left to fall, the rider lands during the wait,
    // and on a board that is half UP tiles it climbs straight back out of the
    // depth this is trying to reach.
    g.player.x = 0;
    g.player.z = 0;
    g.player.y = g.floor.y + 40;
    g.player.vy = 6;
    g.descend(0, 0);
    window.pogo.notifications.clear();
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const g = window.pogo.game;
    g.player.y = g.floor.y + 40;
    g.player.vy = 6;
  });
}
results.measured.depthReached = await page.evaluate(() => window.pogo.game.depth);
if (results.measured.depthReached !== 8) {
  failures.push(
    `expected to be at depth 8 for the deep measurement, got ${results.measured.depthReached}`,
  );
}
results.measured.depth8 = apexOf(await measureApex(), 'depth-8');
results.measured.expectedSurface = +rows[0].base.toFixed(2);
results.measured.expectedDepth8 = +rows[8].base.toFixed(2);

const close = (a, b) => Math.abs(a - b) < 0.35;
if (!close(results.measured.surface, results.measured.expectedSurface)) {
  failures.push(
    `surface bounce peaked at ${results.measured.surface}m, expected ${results.measured.expectedSurface}m`,
  );
}
if (!close(results.measured.depth8, results.measured.expectedDepth8)) {
  failures.push(
    `depth-8 bounce peaked at ${results.measured.depth8}m, expected ${results.measured.expectedDepth8}m`,
  );
}

console.log(JSON.stringify({ results, failures, pageErrors }, null, 1));

await browser.close();
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}\n`);
  process.exit(1);
}
console.error('\nPASS: the arc shrinks smoothly with depth and never stops working.\n');
