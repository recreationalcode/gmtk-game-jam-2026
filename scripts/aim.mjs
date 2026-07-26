/**
 * Mouse aiming test.
 *
 * The cursor is a target, not a lean: pointing at a tile should move the
 * reticle onto that tile, quickly, and it should hold there. This measures how
 * long that takes from a standing start and asserts it does not drift once
 * acquired.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/aim.mjs
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

const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(`${BASE}/?matchSeconds=600&tier=low`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.click('#screen-title button[data-act="play"]');
await page.waitForTimeout(2500);

const box = await page.locator('#gl').boundingBox();

/** Screen position of a grid cell's centre, via the same projection the game uses. */
const cellScreen = (gx, gy) =>
  page.evaluate(
    ([cx, cy]) => {
      const app = window.pogo;
      const f = app.game.floor;
      // Project the tile centre through the live camera, borrowing the Vector3
      // constructor off an existing instance so the test needs no import.
      const THREEVec = app.rig.camera.position.constructor;
      const p = new THREEVec(f.worldX(cx), f.y, f.worldZ(cy));
      p.project(app.rig.camera);
      return {
        x: (p.x * 0.5 + 0.5) * window.innerWidth,
        y: (-p.y * 0.5 + 0.5) * window.innerHeight,
        onScreen: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1,
      };
    },
    [gx, gy],
  );

const reticleCell = () =>
  page.evaluate(() => {
    const app = window.pogo;
    const f = app.game.floor;
    const g = app.guides;
    return { gx: g.lockGX, gy: g.lockGY, side: f.side };
  });

const results = { attempts: [] };

// Park high with plenty of time left, so aiming is not physically constrained.
for (const [gx, gy] of [
  [0, 0],
  [3, 3],
  [0, 3],
  [2, 1],
]) {
  await page.evaluate(() => {
    const g = window.pogo.game;
    g.player.x = 0;
    g.player.z = 0;
    g.player.vx = 0;
    g.player.vz = 0;
    g.player.y = g.floor.y + 8;
    g.player.vy = 0;
  });
  await page.waitForTimeout(120);

  const screen = await cellScreen(gx, gy);
  if (!screen.onScreen) {
    results.attempts.push({ target: [gx, gy], skipped: 'off screen' });
    continue;
  }
  await page.mouse.move(box.x + screen.x, box.y + screen.y);

  // How long until the reticle sits on the tile being pointed at?
  let acquiredMs = null;
  const t0 = Date.now();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(40);
    const cell = await reticleCell();
    if (cell.gx === gx && cell.gy === gy) {
      acquiredMs = Date.now() - t0;
      break;
    }
  }

  // And does it stay there? Re-park each sample so the rider keeps enough time
  // to reach the tile — otherwise this measures physical reach, not aiming, and
  // a far corner legitimately falls short as the arc runs out.
  let heldSamples = 0;
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const g = window.pogo.game;
      g.player.y = g.floor.y + 8;
      g.player.vy = 0;
    });
    await page.waitForTimeout(60);
    const cell = await reticleCell();
    if (cell.gx === gx && cell.gy === gy) heldSamples++;
  }

  results.attempts.push({ target: [gx, gy], acquiredMs, heldSamples, of: 6 });
}

const failures = [];
const tried = results.attempts.filter((a) => !a.skipped);
for (const a of tried) {
  if (a.acquiredMs === null) failures.push(`never acquired tile ${a.target.join(',')}`);
  else if (a.heldSamples < 5) {
    failures.push(`tile ${a.target.join(',')} drifted after acquiring (${a.heldSamples}/6)`);
  }
}
if (tried.length === 0) failures.push('no tiles were on screen to aim at');

// --- the target holds while the cursor holds -------------------------------
//
// The camera falls with the rider, so the same screen pixel maps to a different
// world point every frame. Re-projecting the cursor each frame therefore walks
// the target across the board while the player is doing nothing at all. This is
// the assertion that the target is latched in *world* space and only moves when
// the player asks it to — so it deliberately does NOT re-park altitude: the
// whole point is that the camera keeps moving.
/**
 * Drop any queued coaching notice and let the clock come back to full speed.
 *
 * Notices dilate time so they can be read, which is correct in the game and
 * ruinous here: the hold test measures the reticle against a *moving* camera,
 * and at 35% speed the rider barely falls, so the test passes without having
 * exercised anything. The camera-movement guard below caught exactly that.
 */
const clearNotices = async () => {
  await page.evaluate(() => window.pogo.notifications.clear());
  await page.waitForTimeout(650);
};

const park = (height) =>
  page.evaluate((h) => {
    const g = window.pogo.game;
    g.player.x = 0;
    g.player.z = 0;
    g.player.vx = 0;
    g.player.vz = 0;
    g.player.y = g.floor.y + h;
    g.player.vy = 0;
  }, height);

/** Point at a cell, failing loudly rather than quietly aiming off-screen. */
const pointAt = async (gx, gy) => {
  // The camera leans with velocity and damps back over several frames, so a
  // cell's screen position is only meaningful once it has settled — and under a
  // software renderer "several frames" is long enough to be worth retrying
  // rather than declaring the tile unreachable on the first look.
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.waitForTimeout(150);
    const screen = await cellScreen(gx, gy);
    if (screen.onScreen) {
      await page.mouse.move(box.x + screen.x, box.y + screen.y);
      return true;
    }
  }
  failures.push(`tile ${gx},${gy} stayed off-screen — the test cannot point at it`);
  return false;
};

// High enough that the fall is long and the whole floor is in frame. Falling
// from 11m takes ~1.02s, so a 650ms window stays comfortably airborne — this
// has to measure aiming, not reach, and not the last frames before impact
// where a saturated steer legitimately falls short of an unreachable target.
results.hold = await (async () => {
  await clearNotices();
  await park(11);
  if (!(await pointAt(3, 1))) return { skipped: true };
  await page.waitForTimeout(200);

  const start = await reticleCell();
  const origin = await page.evaluate(() => ({
    aim: window.pogo.aimPoint,
    y: window.pogo.game.player.y,
    pitch: window.pogo.game.floor.pitch,
  }));
  const cells = [];
  let maxDriftTiles = 0;
  // Sample through the fall without touching the mouse again.
  for (let i = 0; i < 5; i++) {
    await page.waitForTimeout(90);
    const now = await page.evaluate(() => ({
      cell: [window.pogo.guides.lockGX, window.pogo.guides.lockGY],
      aim: window.pogo.aimPoint,
    }));
    cells.push(now.cell.join(','));
    if (origin.aim && now.aim) {
      const d = Math.hypot(now.aim.x - origin.aim.x, now.aim.z - origin.aim.z) / origin.pitch;
      maxDriftTiles = Math.max(maxDriftTiles, d);
    }
  }
  const to = await page.evaluate(() => window.pogo.game.player.y);
  const wanted = `${start.gx},${start.gy}`;
  return {
    target: wanted,
    samples: cells,
    // The tile index is a coarse read — sub-tile drift hides inside it — so
    // the aim point itself is measured too. That is the quantity the latch
    // actually fixes.
    maxDriftTiles: +maxDriftTiles.toFixed(3),
    // How much the camera moved underneath the stationary cursor. If this is
    // small the test proves nothing, so it is reported rather than assumed.
    cameraFellMetres: +(origin.y - to).toFixed(2),
    stable: cells.every((c) => c === wanted),
  };
})();

if (results.hold.skipped) {
  failures.push('the hold test never ran');
} else if (!results.hold.stable) {
  failures.push(
    `the target drifted while the cursor was still: ${results.hold.target} -> ${results.hold.samples.join(' ')}`,
  );
} else if (results.hold.maxDriftTiles > 0.05) {
  failures.push(
    `the aim point moved ${results.hold.maxDriftTiles} tiles while the cursor was still`,
  );
} else if (results.hold.cameraFellMetres < 2) {
  failures.push(
    `the camera only moved ${results.hold.cameraFellMetres}m — the hold test did not actually test anything`,
  );
}

// ...and moving the cursor must still re-target immediately, or the latch has
// simply become a lock.
results.retarget = await (async () => {
  await clearNotices();
  await park(11);
  if (!(await pointAt(0, 2))) return { skipped: true };
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(50);
    const c = await reticleCell();
    if (c.gx === 0 && c.gy === 2) return { reacquired: true, afterMs: (i + 1) * 50 };
  }
  return { reacquired: false, ended: await reticleCell() };
})();

if (!results.retarget.skipped && !results.retarget.reacquired) {
  failures.push(
    `moving the cursor no longer re-targets — the latch never releases (stuck on ${results.retarget.ended?.gx},${results.retarget.ended?.gy})`,
  );
}

// Saturation: pointing somewhere unreachable should move the reticle as far
// toward it as physics allows, not refuse to move at all.
results.saturation = await page.evaluate(() => {
  const app = window.pogo;
  const g = app.game;
  const f = g.floor;
  // Almost no time left, aiming at the far corner.
  g.player.x = f.worldX(0);
  g.player.z = f.worldZ(0);
  g.player.vx = 0;
  g.player.vz = 0;
  g.player.y = f.y + 0.35;
  g.player.vy = -3;
  const before = { x: g.player.x, z: g.player.z };
  const out = { x: 0, z: 0 };
  // Solve as the app would, then forward-integrate it.
  app.computeSteer();
  g.player.predictLanding(app.steerWorld.x, app.steerWorld.z, out);
  return {
    steerMagnitude: +Math.hypot(app.steerWorld.x, app.steerWorld.z).toFixed(3),
    movedTowardTarget: +(Math.hypot(out.x - before.x, out.z - before.z) / f.pitch).toFixed(2),
  };
});

console.log(JSON.stringify({ results, failures, pageErrors }, null, 1));

await browser.close();
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}\n`);
  process.exit(1);
}
console.error('\nPASS: the reticle goes where the cursor points, and stays there.\n');
