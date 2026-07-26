/**
 * Touch input test.
 *
 * The mobile gesture is press-drag-release: the press starts aiming, the drag
 * aims, and the *release* is the bounce. That last part is easy to break and
 * impossible to notice on a desktop, so it is asserted here directly by
 * dispatching synthetic touch pointer events and reading the input state.
 *
 * The second half checks the target holds when the thumb does. Touch is a
 * relative drag rather than a cursor, so there is no screen point to re-project
 * — instead the app latches wherever the drag was steering the moment the
 * finger stops, which gives the thumb the same "it stays where I put it" the
 * mouse gets.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/touch.mjs
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

const page = await browser.newPage({
  viewport: { width: 420, height: 880 },
  hasTouch: true,
  isMobile: true,
});
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(`${BASE}/?matchSeconds=600`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.click('#screen-title button[data-act="play"]');
await page.waitForTimeout(1000);

const results = await page.evaluate(() => {
  const app = window.pogo;
  const input = app.input;
  const canvas = document.getElementById('gl');

  const send = (type, x, y, target) => {
    const ev = new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: x,
      clientY: y,
      bubbles: true,
      cancelable: true,
    });
    (target ?? canvas).dispatchEvent(ev);
  };

  const pending = () => input.peekBounceAge(app.simClock) !== null;

  const out = {};
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2;

  // Clear anything buffered from starting the run.
  input.consumeBounce();

  // A press must NOT bounce — it starts aiming.
  send('pointerdown', cx, cy);
  out.pressDidNotBounce = !pending();

  // Dragging must steer.
  send('pointermove', cx + 120, cy + 60);
  input.update();
  out.steerX = +input.steer.x.toFixed(3);
  out.steerY = +input.steer.y.toFixed(3);
  out.dragSteers = Math.abs(input.steer.x) > 0.1 && Math.abs(input.steer.y) > 0.1;

  // Releasing must bounce.
  send('pointerup', cx + 120, cy + 60, window);
  out.releaseBounced = pending();
  input.consumeBounce();

  // The aim must survive the release, or bouncing would throw away the tile
  // that was just lined up.
  input.update();
  out.aimHeldAfterRelease =
    Math.abs(input.steer.x) > 0.1 && Math.abs(input.steer.y) > 0.1;
  out.steerAfterRelease = [+input.steer.x.toFixed(3), +input.steer.y.toFixed(3)];

  // A plain tap is a press plus a release, so it must still bounce exactly once.
  send('pointerdown', cx, cy);
  const bouncedOnTapPress = pending();
  send('pointerup', cx, cy, window);
  out.tapBouncesOnce = !bouncedOnTapPress && pending();
  input.consumeBounce();

  return out;
});

// --- the target holds when the thumb does ----------------------------------
//
// Needs real frames between the steps, so unlike the block above this cannot
// live inside one evaluate().
const touch = (type, x, y, onWindow = false) =>
  page.evaluate(
    ([t, cx, cy, w]) => {
      const ev = new PointerEvent(t, {
        pointerId: 1,
        pointerType: 'touch',
        isPrimary: true,
        clientX: cx,
        clientY: cy,
        bubbles: true,
        cancelable: true,
      });
      (w ? window : document.getElementById('gl')).dispatchEvent(ev);
    },
    [type, x, y, onWindow],
  );

const park = () =>
  page.evaluate(() => {
    const g = window.pogo.game;
    g.player.x = 0;
    g.player.z = 0;
    g.player.vx = 0;
    g.player.vz = 0;
    g.player.y = g.floor.y + 10;
    g.player.vy = 0;
  });

const aimNow = () =>
  page.evaluate(() => ({ aim: window.pogo.aimPoint, pitch: window.pogo.game.floor.pitch }));

// Notices dilate time to be readable, which would leave the rider hanging in
// the air and make this prove nothing.
await page.evaluate(() => window.pogo.notifications.clear());
await page.waitForTimeout(650);

const cx = 210;
const cy = 440;
await park();
await touch('pointerdown', cx, cy);
await touch('pointermove', cx + 90, cy - 70);
await page.waitForTimeout(200);

// Thumb now still. Give it a frame to latch, then watch while the rider falls.
await page.waitForTimeout(150);
const origin = await aimNow();
let maxDriftTiles = 0;
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(80);
  const now = await aimNow();
  if (origin.aim && now.aim) {
    maxDriftTiles = Math.max(
      maxDriftTiles,
      Math.hypot(now.aim.x - origin.aim.x, now.aim.z - origin.aim.z) / origin.pitch,
    );
  }
}
results.latched = origin.aim !== null;
results.holdDriftTiles = +maxDriftTiles.toFixed(3);

// Moving the thumb again must release it, or the latch is a lock.
await park();
await touch('pointermove', cx - 80, cy + 60);
await page.waitForTimeout(220);
const moved = await aimNow();
results.releasedOnMove =
  origin.aim !== null &&
  moved.aim !== null &&
  Math.hypot(moved.aim.x - origin.aim.x, moved.aim.z - origin.aim.z) / origin.pitch > 0.25;
await touch('pointerup', cx - 80, cy + 60, true);

const failures = Object.entries({
  'a press should not bounce': results.pressDidNotBounce,
  'dragging should steer': results.dragSteers,
  'releasing should bounce': results.releaseBounced,
  'aim should survive the release': results.aimHeldAfterRelease,
  'a tap should bounce exactly once, on release': results.tapBouncesOnce,
  'a stationary thumb should latch a target': results.latched,
  [`the target should hold while the thumb does (drifted ${results.holdDriftTiles} tiles)`]:
    results.holdDriftTiles <= 0.05,
  'moving the thumb again should re-target': results.releasedOnMove,
})
  .filter(([, ok]) => !ok)
  .map(([label]) => label);

console.log(JSON.stringify({ results, failures, pageErrors }, null, 1));

await browser.close();
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}\n`);
  process.exit(1);
}
console.error('\nPASS: press aims, drag steers, release bounces, aim survives.\n');
