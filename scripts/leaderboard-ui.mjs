/**
 * Leaderboard navigation test.
 *
 * Checks the board is reachable *before* playing — from the title screen and
 * from pause — not only buried in the run summary, and that Back returns to
 * wherever you opened it from.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/leaderboard-ui.mjs
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

const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.goto(`${BASE}/?matchSeconds=600`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

// Seed a couple of local scores so the board has something to render.
await page.evaluate(() => {
  localStorage.setItem(
    'pogodrop.local.scores.v1',
    JSON.stringify([
      { name: 'PRIOR PLAYER', score: 4210, at: 1 },
      { name: 'SOMEONE ELSE', score: 980, at: 2 },
    ]),
  );
});
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const visible = (sel) => page.locator(sel).count().then((n) => n > 0);
const results = {};

// --- from the title, without ever pressing Play ----------------------------
results.titleHasButton = await visible('#screen-title button[data-act="board"]');
await page.click('#screen-title button[data-act="board"]');
await page.waitForTimeout(900);

results.boardOpenBeforePlaying = await visible('#screen-board.visible');
results.rowsBeforePlaying = await page
  .locator('#screen-board .board-row')
  .allTextContents()
  .then((r) => r.map((t) => t.trim()));
await page.screenshot({ path: path.join(OUT, 'board-from-title.png') });

await page.click('#screen-board button[data-act="back"]');
await page.waitForTimeout(400);
results.backReturnsToTitle = await visible('#screen-title.visible');

// --- from pause, mid-run ---------------------------------------------------
await page.click('#screen-title button[data-act="play"]');
await page.waitForTimeout(900);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
results.pauseOpened = await visible('#screen-pause.visible');

await page.click('#screen-pause button[data-act="board"]');
await page.waitForTimeout(900);
results.boardOpenFromPause = await visible('#screen-board.visible');

// Escape should back out of the board rather than toggling pause.
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
results.escapeReturnsToPause = await visible('#screen-pause.visible');

await page.click('#screen-pause button[data-act="resume"]');
await page.waitForTimeout(400);
results.resumedAfterwards = !(await visible('#screen-pause.visible'));

const failures = Object.entries(results).filter(([k, v]) => {
  if (k === 'rowsBeforePlaying') return v.length === 0;
  return v !== true;
});

console.log(JSON.stringify({ results, failures: failures.map(([k]) => k), pageErrors }, null, 1));

await browser.close();
if (failures.length > 0 || pageErrors.length > 0) {
  console.error(`\nFAIL: ${failures.map(([k]) => k).join(', ')}\n`);
  process.exit(1);
}
console.error('\nPASS: leaderboard reachable before playing and from pause.\n');
