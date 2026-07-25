/**
 * Full-match test: play a short run all the way to the score screen.
 *
 * Runs against the **dev server**, using the dev-only `?matchSeconds=` override
 * so a whole match takes seconds instead of a minute. The production bundle
 * strips that override, which is why this cannot use the built game.
 *
 * Covers the parts a mid-run screenshot never reaches: the endgame ramp, the
 * clock hitting zero, the run summary, name entry, submission, and the
 * leaderboard falling back to local storage when no board is configured.
 *
 * Usage:  npm run dev   (in one shell)
 *         node scripts/fullrun.mjs
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
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
const pageErrors = [];
const consoleErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});

await page.goto(`${BASE}/?matchSeconds=14`, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);

await page.locator('#screen-title button[data-act="play"]').click();
const box = await page.locator('#gl').boundingBox();

let sawEndgame = false;
let endgameShot = false;

for (let i = 0; i < 420; i++) {
  const a = (i / 420) * Math.PI * 12;
  await page.mouse.move(
    box.x + box.width / 2 + Math.cos(a) * box.width * 0.36,
    box.y + box.height / 2 + Math.sin(a) * box.height * 0.36,
  );
  if (i % 4 === 0) {
    await page.mouse.down();
    await page.mouse.up();
  }
  await page.waitForTimeout(60);

  if (!sawEndgame) {
    sawEndgame = await page.locator('.hud.endgame').count().then((n) => n > 0);
    if (sawEndgame && !endgameShot) {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, 'run-endgame.png') });
      endgameShot = true;
    }
  }

  if (await page.locator('#screen-over.visible').count().then((n) => n > 0)) break;
}

const reachedSummary = (await page.locator('#screen-over.visible').count()) > 0;
await page.waitForTimeout(500);
await page.screenshot({ path: path.join(OUT, 'run-summary.png') });

const summary = reachedSummary
  ? await page.evaluate(() => {
      const root = document.querySelector('#screen-over');
      const stats = [...root.querySelectorAll('.stat-grid div')].map(
        (d) => `${d.querySelector('span')?.textContent}=${d.querySelector('b')?.textContent}`,
      );
      return {
        score: root.querySelector('[data-role="score"]')?.textContent,
        stats,
        notice: root.querySelector('[data-role="board-notice"]')?.textContent,
      };
    })
  : null;

// Submit a score and confirm the local-fallback board renders it.
let board = null;
if (reachedSummary) {
  await page.fill('#screen-over [data-role="name"]', 'SMOKE TESTER');
  await page.click('#screen-over [data-act="submit"]');
  await page.waitForTimeout(1200);
  board = await page.evaluate(() => {
    const root = document.querySelector('#screen-over');
    return {
      submitLabel: root.querySelector('[data-act="submit"]')?.textContent,
      notice: root.querySelector('[data-role="board-notice"]')?.textContent,
      rows: [...root.querySelectorAll('.board-row')].map((r) => r.textContent.trim()),
    };
  });
  await page.screenshot({ path: path.join(OUT, 'run-board.png') });
}

// Guide screen, so the legend canvases are exercised too.
await page.click('#screen-over [data-act="guide"]');
await page.waitForTimeout(400);
const legendCanvases = await page.locator('#screen-guide .legend canvas').count();
await page.screenshot({ path: path.join(OUT, 'run-guide.png') });

console.log(
  JSON.stringify(
    { sawEndgame, reachedSummary, summary, board, legendCanvases, pageErrors, consoleErrors },
    null,
    2,
  ),
);

await browser.close();
if (pageErrors.length > 0 || !reachedSummary) process.exit(1);
