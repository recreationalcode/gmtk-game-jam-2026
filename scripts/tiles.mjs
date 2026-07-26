/**
 * Tile countdown regression test.
 *
 * Three properties, all of them things a player reported before they were
 * properties at all:
 *
 *  1. A floor spawns a *spread* of starting numbers. The depth ramp used to
 *     raise the low end of the range into the high end, so by depth 10 every
 *     tile on the board spawned as a 9.
 *  2. Tiles tick out of phase. They used to be jittered only across half an
 *     interval and then advanced by exactly the same amount forever, so the
 *     floor flashed in visible waves for the whole run.
 *  3. Leaving a floor resets its numbers — but does *not* give back tiles you
 *     already scored, which is what stops a down-then-up bounce farming one
 *     floor indefinitely.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/tiles.mjs
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

await page.goto(`${BASE}/?matchSeconds=600&tier=low`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.locator('#screen-title button[data-act="play"]').click();
await page.waitForTimeout(1200);

/** Keep the rider airborne so a stray landing cannot change depth mid-assertion. */
const hover = () =>
  page.evaluate(() => {
    const g = window.pogo.game;
    g.player.y = g.floor.y + 40;
    g.player.vy = 6;
    g.player.x = 0;
    g.player.z = 0;
  });

const descend = async () => {
  await hover();
  await page.evaluate(() => window.pogo.game.descend(0, 0));
  await page.waitForTimeout(1100);
  await hover();
};

const ascend = async () => {
  await hover();
  await page.evaluate(() => {
    const g = window.pogo.game;
    g.ascend(0, 0, g.floor.tiles[0]);
  });
  await page.waitForTimeout(1100);
  await hover();
};

/** Everything worth knowing about the active floor's number tiles. */
const survey = () =>
  page.evaluate(() => {
    const f = window.pogo.game.floor;
    const nums = f.tiles.filter((t) => t.kind === 0);
    const values = nums.map((t) => t.value);
    const counts = {};
    for (const v of values) counts[v] = (counts[v] ?? 0) + 1;

    // Countdown phase in [0, 1). Clustering here is what makes a floor flash
    // in waves, and it is visible in the data long before it is on screen.
    const buckets = new Array(8).fill(0);
    for (const t of nums) {
      const phase = Math.min(0.999, Math.max(0, t.decayTimer / t.decayEvery));
      buckets[Math.floor(phase * 8)]++;
    }

    return {
      depth: f.depth,
      side: f.side,
      numberTiles: nums.length,
      minSpawn: f.minSpawnValue(),
      distinctValues: Object.keys(counts).length,
      commonestShare: nums.length ? +(Math.max(...Object.values(counts)) / nums.length).toFixed(2) : 0,
      meanValue: nums.length ? +(values.reduce((a, b) => a + b, 0) / nums.length).toFixed(2) : 0,
      distinctRates: new Set(nums.map((t) => t.decayEvery.toFixed(4))).size,
      fullestPhaseBucket: nums.length ? +(Math.max(...buckets) / nums.length).toFixed(2) : 0,
    };
  });

const failures = [];
const report = {};

// --- 1. a fresh floor is varied ---------------------------------------------
report.surface = await survey();
if (report.surface.distinctValues < 5) {
  failures.push(`surface floor spawned only ${report.surface.distinctValues} distinct values`);
}
if (report.surface.commonestShare > 0.45) {
  failures.push(`surface floor is ${report.surface.commonestShare * 100}% one value`);
}

// --- 2. and so is a deep one ------------------------------------------------
// This is the actual reported bug: the depth ramp squeezed the range shut.
for (let i = 0; i < 12; i++) await descend();
report.deep = await survey();
if (report.deep.depth < 12) failures.push(`expected to be at depth 12, got ${report.deep.depth}`);
if (report.deep.distinctValues < 5) {
  failures.push(
    `depth ${report.deep.depth} spawned only ${report.deep.distinctValues} distinct values`,
  );
}
if (report.deep.commonestShare > 0.45) {
  failures.push(`depth ${report.deep.depth} is ${report.deep.commonestShare * 100}% one value`);
}

// --- 3. tiles tick out of phase, at their own rates -------------------------
if (report.deep.distinctRates < 5) {
  failures.push(`only ${report.deep.distinctRates} distinct decay rates — tiles tick in lockstep`);
}
if (report.deep.fullestPhaseBucket > 0.35) {
  failures.push(
    `${report.deep.fullestPhaseBucket * 100}% of tiles share a countdown phase — the floor will flash in waves`,
  );
}

// --- 4. leaving a floor resets its numbers, but not what you scored ---------
await hover();
report.rot = await page.evaluate(() => {
  const g = window.pogo.game;
  // Freeze decay for the rest of the test. The two transitions below take a
  // couple of seconds of real time, which is long enough for a fast tile to
  // tick — and then "one tile is below the spawn minimum" would be honest
  // decay, not a failed reset. Freezing makes the assertion exact.
  g.freezeLeft = 60;
  const f = g.floor;
  const nums = f.tiles.filter((t) => t.kind === 0);
  // Run half the board down to nearly dead, and mark a few as already scored.
  const scored = [];
  nums.forEach((t, i) => {
    if (i % 2 === 0) t.value = 1;
    if (i % 7 === 0) {
      t.kind = 3; // Spent — burned stays false, exactly as scoreTile leaves it.
      t.value = 0;
      scored.push([t.gx, t.gy]);
    }
  });
  const live = f.tiles.filter((t) => t.kind === 0);
  return {
    scoredCells: scored,
    meanValue: +(live.reduce((a, t) => a + t.value, 0) / live.length).toFixed(2),
  };
});

await ascend();
await descend();

report.afterReturn = await page.evaluate(
  (cells) => {
    const f = window.pogo.game.floor;
    const nums = f.tiles.filter((t) => t.kind === 0);
    const min = f.minSpawnValue();
    return {
      depth: f.depth,
      meanValue: +(nums.reduce((a, t) => a + t.value, 0) / nums.length).toFixed(2),
      belowMinSpawn: nums.filter((t) => t.value < min).length,
      // The anti-farm guard: tiles you scored must not come back.
      scoredTilesRevived: cells.filter(([gx, gy]) => f.at(gx, gy).kind === 0).length,
      scoredTilesChecked: cells.length,
    };
  },
  report.rot.scoredCells,
);

if (report.afterReturn.meanValue <= report.rot.meanValue) {
  failures.push(
    `numbers did not reset on leaving: mean went ${report.rot.meanValue} → ${report.afterReturn.meanValue}`,
  );
}
if (report.afterReturn.belowMinSpawn > 0) {
  failures.push(`${report.afterReturn.belowMinSpawn} tile(s) came back below the spawn minimum`);
}
if (report.afterReturn.scoredTilesRevived > 0) {
  failures.push(
    `${report.afterReturn.scoredTilesRevived} scored tile(s) came back — a floor could be farmed`,
  );
}

// --- what you take is gone for good ----------------------------------------
//
// Collected powerups and scored numbers alike. Without that a floor could be
// refilled by bouncing down and straight back up, which costs nothing in
// multiplier terms — and a reveal floor, stacked with one powerup by design,
// would be the best farm in the game.
report.collected = await (async () => {
  await hover();
  const before = await page.evaluate(() => {
    const g = window.pogo.game;
    const f = g.floor;
    // Collect every powerup on the floor the way landing on one does.
    const taken = [];
    for (const t of f.tiles) {
      if (t.kind === 4) g.gainTime(t, 0, 0);
      else if (t.kind === 5) g.applyBoost(t, 0, 0);
      else if (t.kind === 6) g.applyFreeze(t, 0, 0);
      else continue;
      taken.push([t.gx, t.gy]);
    }
    return { taken, theme: f.theme };
  });

  await ascend();
  await descend();

  const after = await page.evaluate(
    (cells) => {
      const f = window.pogo.game.floor;
      return {
        theme: f.theme,
        revived: cells.filter(([gx, gy]) => [4, 5, 6].includes(f.at(gx, gy).kind)).length,
        checked: cells.length,
      };
    },
    before.taken,
  );
  return { ...before, ...after };
})();

if (report.collected.checked === 0) {
  failures.push('no powerups were on the floor to collect — the test proved nothing');
} else if (report.collected.revived > 0) {
  failures.push(
    `${report.collected.revived} collected powerup(s) came back after leaving and returning`,
  );
}

// --- a reveal floor does not refresh at all --------------------------------
report.revealPersists = await (async () => {
  // Depth 5 is the BOOST reveal.
  await page.evaluate(() => {
    const g = window.pogo.game;
    g.player.y = g.floor.y + 40;
    while (g.depth > 5) g.ascend(0, 0, g.floor.tiles[0]);
    while (g.depth < 5) g.descend(0, 0);
  });
  await page.waitForTimeout(400);
  const before = await page.evaluate(() => {
    const f = window.pogo.game.floor;
    // Run the numbers down so a reset would be unmistakable.
    for (const t of f.tiles) if (t.kind === 0) t.value = 1;
    const nums = f.tiles.filter((t) => t.kind === 0);
    return {
      theme: f.theme,
      mean: +(nums.reduce((a, t) => a + t.value, 0) / Math.max(1, nums.length)).toFixed(2),
    };
  });
  await ascend();
  await descend();
  const after = await page.evaluate(() => {
    const f = window.pogo.game.floor;
    const nums = f.tiles.filter((t) => t.kind === 0);
    return {
      theme: f.theme,
      mean: +(nums.reduce((a, t) => a + t.value, 0) / Math.max(1, nums.length)).toFixed(2),
    };
  });
  return { before, after };
})();

if (!report.revealPersists.before.theme.startsWith('reveal')) {
  failures.push(`expected a reveal floor at depth 5, got ${report.revealPersists.before.theme}`);
} else if (report.revealPersists.after.mean > report.revealPersists.before.mean + 0.5) {
  failures.push(
    `a reveal floor reset its numbers on re-entry (${report.revealPersists.before.mean} -> ${report.revealPersists.after.mean})`,
  );
}

console.log(JSON.stringify({ report, failures, pageErrors }, null, 1));

await browser.close();
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}\n`);
  process.exit(1);
}
console.error('\nPASS: floors spawn varied numbers, tick out of phase, and reset on leaving.\n');
