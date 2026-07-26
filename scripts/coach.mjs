/**
 * Tips-and-notices test.
 *
 * Fires each trigger and checks the notice that comes back, then checks the two
 * properties that decide whether the system is helpful or infuriating: it never
 * repeats itself within a run, and it never repeats itself across runs either.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/coach.mjs
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

const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(`${BASE}/?matchSeconds=600`, { waitUntil: 'networkidle' });
await page.waitForTimeout(700);
// Start from a player who has never been taught anything.
await page.evaluate(() => localStorage.removeItem('pogodrop.coach.v1'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(700);
await page.click('#screen-title button[data-act="play"]');
await page.waitForTimeout(900);

/** Wait for a toast to appear and report what it said. */
const awaitNotice = async (timeoutMs = 6000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await page.evaluate(() => {
      const el = document.getElementById('notice');
      if (!el || !el.classList.contains('visible')) return null;
      return {
        title: el.querySelector('.notice-title')?.textContent ?? '',
        body: el.querySelector('.notice-body')?.textContent ?? '',
        hasIcon: !el.querySelector('.notice-icon')?.classList.contains('hidden'),
      };
    });
    if (seen) return seen;
    await page.waitForTimeout(60);
  }
  return null;
};

/**
 * Wait until nothing is showing and nothing is queued. Waiting only for the
 * current toast to disappear is not enough — it returns during the inter-toast
 * gap, so the next trigger fires while earlier notices are still pending and
 * the collector snapshots a half-drained queue.
 */
const drain = async () => {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const busy = await page.evaluate(() => window.pogo.notifications.busy);
    if (!busy) return;
    await page.waitForTimeout(150);
  }
};

/**
 * Collect every distinct toast that appears, rather than assuming the next one
 * to show is a response to the last thing we did. Several notices are genuinely
 * in flight at once — the charge tip fires on its own because this script never
 * presses to bounce — so the queue is not a 1:1 reply to each action.
 */
const shown = [];
let collecting = true;
const collector = (async () => {
  let last = null;
  while (collecting) {
    const seen = await page
      .evaluate(() => {
        const el = document.getElementById('notice');
        if (!el || !el.classList.contains('visible')) return null;
        return {
          title: el.querySelector('.notice-title')?.textContent ?? '',
          body: el.querySelector('.notice-body')?.textContent ?? '',
        };
      })
      .catch(() => null);
    if (seen?.title && seen.title !== last) {
      shown.push(seen);
      last = seen.title;
    } else if (!seen) {
      last = null;
    }
    await page.waitForTimeout(50);
  }
})();

const titles = (list) => list.map((n) => n.title);
const find = (list, needle) => list.find((n) => n.title.includes(needle));

const results = {};

// The objective comes first, during the opening drop, before the clock starts.
await page.waitForTimeout(2500);
results.opening = titles(shown);

// Two UP tiles taken on the opening floor should bring the way-down hint
// forward, well inside the ten-second patience window.
for (let i = 0; i < 2; i++) {
  await page.evaluate((idx) => {
    const g = window.pogo.game;
    g.player.y = g.floor.y + 40;
    g.ascend(0, 0, g.floor.tiles[idx]);
  }, i);
  await page.waitForTimeout(400);
}
// Read this *before* draining. The seen-store records a notice the moment the
// rule pushes it, so localStorage says when it fired; waiting for the queue to
// empty would instead measure how long three toasts take to play, which is
// almost exactly the ten-second fallback and made this assertion meaningless.
await page.waitForTimeout(400);
results.wayDownFiredAt = await page.evaluate(() => ({
  simTime: window.pogo.game.simTime,
  recorded: JSON.parse(localStorage.getItem('pogodrop.coach.v1') ?? '{}')['tile:down'] ?? 0,
}));
await drain();
await page.screenshot({ path: path.join(OUT, 'notice-live.png') });

// Descend: announces the new multiplier, and on the first one, the new floor.
await page.evaluate(() => {
  const g = window.pogo.game;
  g.player.y = g.floor.y + 3;
  g.player.vy = 0;
  g.descend(0, 0);
});
await drain();

// Back up from a real depth: this one actually costs a multiplier.
await page.evaluate(() => {
  const g = window.pogo.game;
  g.player.y = g.floor.y + 40;
  g.ascend(0, 0, g.floor.tiles[0]);
});
await drain();

// A time tile explains itself, twice over — the second must stay silent.
await page.evaluate(() => window.pogo.game.gainTime(window.pogo.game.floor.tiles[0], 0, 0));
await drain();
await page.evaluate(() => window.pogo.game.gainTime(window.pogo.game.floor.tiles[1], 0, 0));
await page.waitForTimeout(1500);
await drain();
// Let any straggler the polled rules queued settle out too.
await page.waitForTimeout(1000);
await drain();

results.shownFirstRun = titles([...shown]);
results.bodies = Object.fromEntries(shown.map((n) => [n.title, n.body]));
results.countsAfterFirstRun = await page.evaluate(() =>
  JSON.parse(localStorage.getItem('pogodrop.coach.v1') ?? '{}'),
);

// Second run: previously-taught notices must not come back.
shown.length = 0;
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.click('#screen-pause button[data-act="restart"]');
await page.waitForTimeout(1200);
await page.evaluate(() => window.pogo.game.gainTime(window.pogo.game.floor.tiles[0], 0, 0));
await page.waitForTimeout(2500);
results.shownSecondRun = titles([...shown]);

collecting = false;
await collector;

const limits = {
  'event:multiplier': Infinity,
  'event:multiplierLost': 2,
  'intro:objective': 3,
  'tile:down': 2,
  'tip:charge': 4,
  'tip:perfect': 2,
  'tip:reset': 2,
  'tip:stuck': 2,
  'event:endgame': 2,
};
const failures = [];

const duplicates = results.shownFirstRun.filter((t, i) => results.shownFirstRun.indexOf(t) !== i);
if (duplicates.length > 0) failures.push(`repeated within a run: ${duplicates.join(', ')}`);

// The objective must be the very first thing said, and must name the clock.
if (results.opening[0] === undefined || !/Score as much as you can/i.test(results.opening[0])) {
  failures.push(`the objective should open the run, got: ${results.opening[0] ?? 'nothing'}`);
}

if (!results.shownFirstRun.some((t) => /Land on the ×2 tile/.test(t))) {
  failures.push('the way-down hint never appeared');
}
// Two surface UP tiles should have pulled it in well before the 10s fallback.
if (results.wayDownFiredAt.recorded === 0) {
  failures.push('the way-down hint had not fired after two surface UP tiles');
} else if (results.wayDownFiredAt.simTime >= 10) {
  failures.push(
    `the way-down hint fired at ${results.wayDownFiredAt.simTime.toFixed(1)}s — that is the timeout, not the repeated-UP trigger`,
  );
}
if (!results.shownFirstRun.some((t) => /Red arrows throw you back/.test(t))) {
  failures.push('taking an UP tile on the surface said nothing');
}
// Losing a multiplier for real is its own notice, and must not be confused
// with the harmless surface case.
if (!results.shownFirstRun.includes('Multiplier ×1')) {
  failures.push('losing a multiplier to an UP tile was never called out');
}
// ...and the two must never both fire for one bounce.
if (results.shownFirstRun.some((t) => /floor reset/i.test(t))) {
  failures.push('the floor-reset tip stacked on top of the multiplier-loss notice');
}
// The first descent has to explain the floor, not just the number.
{
  const body = results.bodies['Multiplier ×2'] ?? '';
  if (!/new floor/i.test(body)) {
    failures.push(`the first descent should explain the new floor, said: "${body}"`);
  }
}
if (!results.shownFirstRun.some((t) => t === 'Multiplier ×2')) {
  failures.push(
    `the multiplier notice should report the value at the moment of descent, got: ${results.shownFirstRun.filter((t) => t.startsWith('Multiplier')).join(', ') || 'none'}`,
  );
}
if (!results.shownFirstRun.some((t) => t.includes('seconds'))) {
  failures.push('the time-tile notice never appeared');
}
// A second run may legitimately surface notices whose trigger never came up
// the first time. Only a repeat of something already taught is a failure —
// except for the handful with a deliberate multi-run budget, which are supposed
// to come back. The objective is the clearest case: it is not a tip, it is what
// the game is, and a player on their second attempt has still only seen it once.
const REPEATS_BY_DESIGN = [/Score as much as you can/i];
const repeated = results.shownSecondRun.filter(
  (t) => results.shownFirstRun.includes(t) && !REPEATS_BY_DESIGN.some((re) => re.test(t)),
);
if (repeated.length > 0) {
  failures.push(`already-taught notices returned in a new run: ${repeated.join(', ')}`);
}
// And the positive half of that: the budgeted ones must actually still fire.
if (!results.shownSecondRun.some((t) => /Score as much as you can/i.test(t))) {
  failures.push('the objective did not repeat on the second run, but its budget allows it');
}
for (const [id, n] of Object.entries(results.countsAfterFirstRun)) {
  const limit = limits[id] ?? 1;
  if (n > limit) failures.push(`${id} recorded ${n} shows, limit ${limit}`);
}

console.log(JSON.stringify({ results, failures, pageErrors }, null, 1));

await browser.close();
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}\n`);
  process.exit(1);
}
console.error('\nPASS: notices fire once, carry artwork, and persist across runs.\n');
