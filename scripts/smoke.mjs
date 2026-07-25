/**
 * Headless smoke test.
 *
 * Boots the built game in Chromium, plays it, and reports anything the browser
 * complained about. Also captures screenshots at several points in a bounce and
 * in both orientations, because the two bugs that hurt most in this project —
 * an inverted texture atlas and a lens that collapses in portrait — were both
 * invisible to a type checker and obvious in a picture.
 *
 * Usage:  npm run build && npm run preview   (in one shell)
 *         npm run smoke                      (in another)
 * Env:    SMOKE_URL, SMOKE_OUT, SMOKE_CHROMIUM
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const URL_BASE = process.env.SMOKE_URL ?? 'http://127.0.0.1:4173';
const OUT = process.env.SMOKE_OUT ?? path.dirname(fileURLToPath(import.meta.url));
// The container ships a pinned Chromium that may not match whatever build the
// installed Playwright expects, so point at it explicitly.
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

const problems = { pageErrors: [], consoleErrors: [] };
const report = { orientations: {} };

for (const [label, viewport] of [
  ['portrait', { width: 430, height: 932 }],
  ['landscape', { width: 1280, height: 720 }],
]) {
  const page = await browser.newPage({ viewport });
  page.on('console', (m) => {
    if (m.type() === 'error') problems.consoleErrors.push(`[${label}] ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.pageErrors.push(`[${label}] ${String(e)}`));

  await page.goto(URL_BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(OUT, `${label}-title.png`) });

  await page.locator('#screen-title button[data-act="play"]').click();
  await page.waitForTimeout(500);

  const box = await page.locator('#gl').boundingBox();
  const readHud = () =>
    page.evaluate(() => ({
      time: document.getElementById('hud-time')?.textContent ?? '',
      score: document.getElementById('hud-score')?.textContent ?? '',
      mult: document.getElementById('hud-mult')?.textContent ?? '',
      depth: document.getElementById('hud-depth')?.textContent ?? '',
    }));

  // Play for a while: sweep the pointer to steer, click to time bounces.
  const shots = [];
  for (let i = 0; i < 110; i++) {
    const a = (i / 110) * Math.PI * 6;
    await page.mouse.move(
      box.x + box.width / 2 + Math.cos(a) * box.width * 0.34,
      box.y + box.height / 2 + Math.sin(a) * box.height * 0.34,
    );
    if (i % 5 === 0) {
      await page.mouse.down();
      await page.mouse.up();
    }
    await page.waitForTimeout(55);
    // Consecutive frames catch different points in the bounce arc.
    if (i === 40 || i === 44 || i === 48 || i === 95) {
      const name = `${label}-play-${shots.length}.png`;
      await page.screenshot({ path: path.join(OUT, name) });
      shots.push({ name, hud: await readHud() });
    }
  }

  const fps = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let frames = 0;
        const t0 = performance.now();
        const tick = () => {
          frames++;
          if (performance.now() - t0 < 1500) requestAnimationFrame(tick);
          else resolve(Math.round((frames * 1000) / (performance.now() - t0)));
        };
        requestAnimationFrame(tick);
      }),
  );

  const aspect = await page.evaluate(() => window.innerWidth / window.innerHeight);

  report.orientations[label] = {
    viewport,
    aspect: +aspect.toFixed(3),
    fps,
    shots,
    hud: await readHud(),
  };
  await page.close();
}

report.problems = problems;
console.log(JSON.stringify(report, null, 2));

await browser.close();
if (problems.pageErrors.length > 0) process.exit(1);
