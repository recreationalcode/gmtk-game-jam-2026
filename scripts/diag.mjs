// Dev diagnostics runner: screenshots the glyph atlas and dumps floor
// composition per depth, so layout and balance can be checked without eyeballing
// the running game.
import { chromium } from 'playwright';

const OUT = process.env.OUT ?? '.';
const URL = process.env.DEBUG_URL ?? 'http://127.0.0.1:5173/debug.html';
const EXECUTABLE =
  process.env.SMOKE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage({ viewport: { width: 700, height: 1000 } });
page.on('pageerror', (e) => console.log('PAGEERROR', String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('CONSOLE', m.text());
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('#atlas canvas').screenshot({ path: `${OUT}/atlas.png` });
console.log(await page.locator('#atlas p').textContent());
console.log(await page.locator('#floors').textContent());
await browser.close();
