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
    g.player.y = g.floor.y + 4.8;
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
      g.player.y = g.floor.y + 4.8;
      g.player.vy = 0;
    });
    await page.waitForTimeout(60);
    const cell = await reticleCell();
    if (cell.gx === gx && cell.gy === gy) heldSamples++;
  }

  results.attempts.push({ target: [gx, gy], acquiredMs, heldSamples, of: 6 });
}

const tried = results.attempts.filter((a) => !a.skipped);
const failures = [];
for (const a of tried) {
  if (a.acquiredMs === null) failures.push(`never acquired tile ${a.target.join(',')}`);
  else if (a.heldSamples < 5) {
    failures.push(`tile ${a.target.join(',')} drifted after acquiring (${a.heldSamples}/6)`);
  }
}
if (tried.length === 0) failures.push('no tiles were on screen to aim at');

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
