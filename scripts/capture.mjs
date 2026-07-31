/**
 * Trailer capture.
 *
 * The problem this solves: headless Chromium here runs on SwiftShader and
 * renders the game at single-digit frames per second, so anything recorded in
 * real time looks broken and represents the game unfairly.
 *
 * So time is not real. `requestAnimationFrame` is replaced before the app boots
 * with a manual pump, and the app's whole clock hangs off the timestamp rAF
 * passes it — simulation, input timing, notice dilation, all of it. Each pump
 * advances exactly one frame of *virtual* time no matter how long the render
 * actually took, and a screenshot is taken between pumps. The result is a
 * perfectly even 60fps sequence produced by a machine that cannot draw at 60fps.
 *
 * A bot plays the run, because a trailer wants competent play: it aims the same
 * way a cursor does (by writing the aim latch the mouse would have set) and
 * presses inside the perfect window it computes from the rider's own ballistics.
 * Nothing here reaches past the game's own inputs to fake a score.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/capture.mjs [--seconds=14] [--width=1280] [--height=720]
 */
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.CAPTURE_URL ?? 'http://127.0.0.1:5173';
const EXECUTABLE =
  process.env.SMOKE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split('=')[1]) : fallback;
};

const FPS = arg('fps', 60);
const SECONDS = arg('seconds', 14);
const WIDTH = arg('width', 1280);
const HEIGHT = arg('height', 720);
/** Virtual seconds of bot play before recording, to reach a deeper floor. */
const WARMUP = arg('warmup', 26);
/** Clock left when recording starts, so the endgame ramp lands in shot. */
const CLOCK_AT_START = arg('clock', 21);

const FRAMES = Math.round(FPS * SECONDS);
const OUT = path.join(ROOT, 'build', 'capture');
const FRAME_DIR = path.join(OUT, 'frames');
fs.rmSync(FRAME_DIR, { recursive: true, force: true });
fs.mkdirSync(FRAME_DIR, { recursive: true });

// --- the metered clock, installed before any app code runs ------------------
//
// The browser's own frame loop keeps running — replacing it outright makes
// Playwright's screenshot hang forever waiting for a compositor frame that can
// no longer arrive. Instead the app's callbacks are held in a queue and
// released one per granted credit, with a timestamp that advances by exactly
// one frame's worth of virtual time however long the real frame took.
const DRIVER = (stepMs) => {
  const realRAF = window.requestAnimationFrame.bind(window);
  let virtualMs = 0;
  let pending = [];
  let credits = 0;

  window.__frames = 0;
  window.requestAnimationFrame = (cb) => pending.push(cb);
  window.cancelAnimationFrame = () => {};
  window.__grant = (n) => {
    credits += n;
  };
  window.__diag = () => ({ frames: window.__frames, pending: pending.length, credits, virtualMs });

  const loop = () => {
    // `finally`, because anything that throws in here — the bot, the app —
    // would otherwise skip the re-registration and stop the clock dead, which
    // presents as a capture that hangs rather than as the error it is.
    try {
      // One app frame per real frame at most, so the renderer is never asked to
      // draw twice into the same composited image.
      if (credits > 0 && pending.length > 0) {
        credits--;
        virtualMs += stepMs;
        const due = pending;
        pending = [];
        try {
          if (window.__tick) window.__tick();
        } catch (err) {
          window.__tickError = String(err);
        }
        for (const cb of due) cb(virtualMs);
        window.__frames++;
      }
    } finally {
      realRAF(loop);
    }
  };
  realRAF(loop);
};

// --- the bot ----------------------------------------------------------------
//
// Runs once per frame, before the frame is pumped. Two jobs: point at something
// worth hitting, and press at the right moment.
const BOT = () => {
  const G = 21.0;
  const PERFECT_WINDOW = 0.085;

  window.__bot = { floorY: null, hits: 0 };

  /** Seconds until the rider reaches the floor plane, or null if rising away. */
  const timeToLand = (p, floorY) => {
    const h = p.y - floorY;
    const disc = p.vy * p.vy + 2 * G * h;
    if (disc < 0) return null;
    const t = (p.vy + Math.sqrt(disc)) / G;
    return t > 0 ? t : null;
  };

  window.__tick = () => {
    const app = window.pogo;
    // Nothing to drive until a run is actually under way. The clock still has
    // to advance before then, to boot the app and get past the title screen.
    if (!app || app.phase !== 'playing' || !window.__kinds) return;

    const g = app.game;
    const floor = g.floor;
    const p = g.player;
    const bot = window.__bot;

    // A trailer has no time for tutorials, and a notice dilates time to a tenth
    // while it is up. Keeping the queue empty keeps the run moving.
    app.notifications.clear();

    if (bot.floorY !== floor.y) {
      bot.floorY = floor.y;
      bot.hits = 0;
    }

    // Pick a target. Farm a couple of numbers for the score popups, then take
    // the way down, because descending is what the game is actually about and
    // it is what makes the multiplier climb on screen.
    const kinds = window.__kinds;
    const wantDown = bot.hits >= 1;
    let best = null;
    let bestScore = -Infinity;
    for (const t of floor.tiles) {
      const isDown = t.kind === kinds.Down;
      const isNumber = t.kind === kinds.Number && t.value > 0;
      const isPower = t.kind === kinds.Time || t.kind === kinds.Boost || t.kind === kinds.Freeze;
      if (!isDown && !isNumber && !isPower) continue;

      const x = floor.worldX(t.gx);
      const z = floor.worldZ(t.gy);
      const reach = Math.hypot(x - p.x, z - p.z);
      // Near things first — a target across the board reads as drifting, not
      // playing. Value and kind break the tie.
      let score = -reach * 1.6;
      if (isDown) score += wantDown ? 48 : -10;
      if (isPower) score += 12;
      if (isNumber) score += t.value * 0.7;
      if (score > bestScore) {
        bestScore = score;
        best = { x, z };
      }
    }

    if (best) {
      // Exactly what a mouse cursor does: set the latched aim point. The app
      // only recomputes it when the pointer actually moves, so this holds.
      app.aimLatch = best;
      app.aimLatchFloorY = floor.y;
    }

    // Press so the buffered input is inside the perfect window at impact.
    const t = timeToLand(p, floor.y);
    if (t !== null && t <= PERFECT_WINDOW * 0.55 && !app.input.bounceEdge) {
      app.input.bounceEdge = true;
      app.input.bounceEdgeTime = app.simClock;
      bot.hits++;
    }
  };
};

const browser = await chromium.launch({
  executablePath: EXECUTABLE,
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox',
    '--hide-scrollbars',
  ],
});
const page = await browser.newPage({
  viewport: { width: WIDTH, height: HEIGHT },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.addInitScript(DRIVER, 1000 / FPS);
await page.addInitScript(BOT);
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });

/** Let `n` app frames run, and wait until they actually have. */
const pump = async (n) => {
  const target = (await page.evaluate(() => window.__frames)) + n;
  await page.evaluate((count) => window.__grant(count), n);
  // Timer polling, not the default rAF polling: this script owns
  // requestAnimationFrame, so an rAF-based poll would be queued behind the very
  // credits it is waiting on and never fire.
  await page.waitForFunction((t) => window.__frames >= t, target, {
    polling: 30,
    timeout: Math.max(30000, n * 900),
  });
};

await page.waitForFunction(() => !!window.pogo, null, { timeout: 20000 });
await page.evaluate(async () => {
  const { TileKind } = await import('/src/core/Config.ts');
  window.__kinds = TileKind;
});
await pump(20);

await page.click('#screen-title button[data-act="play"]');
await pump(4);

// Warm up off-camera, so recording opens on a deep board with a multiplier
// already earned rather than on an empty surface. Rendering still happens (the
// browser frame loop is intact) but no screenshots are taken, which is where
// nearly all the cost is.
process.stderr.write(`warming up ${WARMUP}s of play...\n`);
await pump(Math.round(WARMUP * FPS));

const warm = await page.evaluate(() => ({
  depth: window.pogo.game.depth,
  score: window.pogo.game.score,
  multiplier: window.pogo.game.multiplier,
}));
process.stderr.write(`  reached depth ${warm.depth}, ×${warm.multiplier}, ${warm.score} points\n`);

// Put the clock where the endgame ramp will land inside the recording.
await page.evaluate((left) => {
  window.pogo.game.timeLeft = left;
}, CLOCK_AT_START);

process.stderr.write(`capturing ${FRAMES} frames at ${WIDTH}x${HEIGHT}...\n`);
const started = Date.now();
for (let i = 0; i < FRAMES; i++) {
  await pump(1);
  await page.screenshot({
    path: path.join(FRAME_DIR, `f${String(i).padStart(5, '0')}.jpg`),
    type: 'jpeg',
    quality: 95,
    animations: 'allow',
  });
  if (i % 60 === 0) {
    const pct = ((i / FRAMES) * 100).toFixed(0);
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    process.stderr.write(`  ${pct}%  (${i}/${FRAMES}, ${elapsed}s)\n`);
  }
}

const final = await page.evaluate(() => ({
  depth: window.pogo.game.depth,
  score: window.pogo.game.score,
  multiplier: window.pogo.game.multiplier,
  timeLeft: +window.pogo.game.timeLeft.toFixed(1),
  phase: window.pogo.phase,
}));

await browser.close();

if (errors.length > 0) {
  console.error(`\npage errors during capture:\n${errors.join('\n')}\n`);
}

// --- encode -----------------------------------------------------------------
const MP4 = path.join(OUT, 'pogo-drop.mp4');
execFileSync(
  'ffmpeg',
  [
    '-y',
    '-framerate', String(FPS),
    '-i', path.join(FRAME_DIR, 'f%05d.jpg'),
    // yuv420p and even dimensions, or the file will not play on iOS or in an
    // X timeline. -movflags +faststart puts the index first so it starts
    // playing before the whole file has arrived.
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-movflags', '+faststart',
    MP4,
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

const bytes = fs.statSync(MP4).size;
console.log(
  JSON.stringify(
    {
      mp4: path.relative(ROOT, MP4),
      megabytes: +(bytes / 1024 / 1024).toFixed(2),
      frames: FRAMES,
      fps: FPS,
      seconds: +(FRAMES / FPS).toFixed(1),
      resolution: `${WIDTH}x${HEIGHT}`,
      runAtEnd: final,
      pageErrors: errors.length,
    },
    null,
    1,
  ),
);
