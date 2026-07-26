/**
 * Client ↔ proxy contract test.
 *
 * `npm run proxy` checks the function in isolation. This checks the seam that
 * actually breaks: the game sends `{name, score, playerId}` and the proxy reads
 * those exact keys, and the proxy returns `{entries:[{rank,name,score}]}` and
 * the game parses that. Get a field name wrong in either direction and nothing
 * throws — the board silently falls back to local scores with a warning, which
 * looks like a network problem rather than a bug.
 *
 * So: the *real* handler, wrapped in an HTTP server, with a fake simpleboards
 * behind it, and a real browser playing a real match in front of it. The only
 * thing faked is the third party, which is the one part that cannot be reached
 * from here anyway.
 *
 * Starts everything it needs. Usage:  node scripts/proxy-e2e.mjs
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PROXY_PORT = 5199;
const VITE_PORT = 5174;
const UPSTREAM = 'https://upstream.invalid';
const EXECUTABLE =
  process.env.SMOKE_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

process.env.SIMPLEBOARDS_API_KEY = 'sb_e2e_secret';
process.env.SIMPLEBOARDS_LEADERBOARD_ID = 'e2e-board';
process.env.SIMPLEBOARDS_BASE_URL = UPSTREAM;
delete process.env.LEADERBOARD_ALLOWED_ORIGINS;

// --- a fake simpleboards.dev, in memory -------------------------------------
const board = [{ playerDisplayName: 'HOUSE', score: 999, rank: 1 }];
const upstreamCalls = [];
const realFetch = globalThis.fetch;

globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  // Only the third party is faked; anything else (Playwright, Vite) goes out.
  if (!href.startsWith(UPSTREAM)) return realFetch(url, init);

  upstreamCalls.push({ href, method: init.method ?? 'GET', body: init.body });

  if ((init.method ?? 'GET') === 'GET') {
    if (!href.includes('/api/entries')) return new Response('nope', { status: 404 });
    const sorted = [...board]
      .sort((a, b) => b.score - a.score)
      .map((e, i) => ({ ...e, rank: i + 1 }));
    return new Response(JSON.stringify({ entries: sorted }), { status: 200 });
  }

  const sent = JSON.parse(String(init.body ?? '{}'));
  board.push({ playerDisplayName: sent.playerDisplayName, score: sent.score, rank: 0 });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

const { default: handler } = await import('../api/scores.ts');

// --- run the handler behind a real socket -----------------------------------
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
  );
  const hasBody = chunks.length > 0 && req.method !== 'GET' && req.method !== 'HEAD';

  const out = await handler(
    new Request(`http://127.0.0.1:${PROXY_PORT}${req.url}`, {
      method: req.method,
      headers,
      ...(hasBody ? { body: Buffer.concat(chunks) } : {}),
    }),
  );
  res.writeHead(out.status, Object.fromEntries(out.headers.entries()));
  res.end(Buffer.from(await out.arrayBuffer()));
});
await new Promise((r) => server.listen(PROXY_PORT, '127.0.0.1', r));

// --- a dev server pointed at it ---------------------------------------------
// Spawn the binary directly rather than through npx, and in its own process
// group. Killing an npx wrapper leaves the real dev server orphaned, and an
// orphaned dev server is not harmless here: it quietly eats a core for the rest
// of the session and starves the software renderer the other headless tests
// depend on. That is exactly how this was found.
const vite = spawn(
  'node_modules/.bin/vite',
  ['--port', String(VITE_PORT), '--strictPort'],
  {
    env: { ...process.env, VITE_LEADERBOARD_PROXY: `http://127.0.0.1:${PROXY_PORT}` },
    stdio: 'ignore',
    detached: true,
  },
);

const stopVite = () => {
  try {
    // Negative pid kills the whole group, so nothing survives this script.
    process.kill(-vite.pid, 'SIGTERM');
  } catch {
    /* Already gone. */
  }
};
// Covers the ways this script can end that `finally` does not: Ctrl-C, and a
// throw before the try block is entered.
process.on('exit', stopVite);
process.on('SIGINT', () => {
  stopVite();
  process.exit(130);
});

const BASE = `http://127.0.0.1:${VITE_PORT}`;
for (let i = 0; i < 60; i++) {
  try {
    const r = await realFetch(BASE);
    if (r.ok) break;
  } catch {
    /* not up yet */
  }
  await new Promise((r) => setTimeout(r, 500));
}

const failures = [];
const results = {};
let browser;

try {
  browser = await chromium.launch({
    executablePath: EXECUTABLE,
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 800, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/?matchSeconds=5&tier=low`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  results.mode = await page.evaluate(() => window.pogo.leaderboard.remoteMode);

  await page.click('#screen-title button[data-act="play"]');
  await page.waitForTimeout(16000);

  await page.fill('#screen-over input[data-role="name"]', 'E2E RUNNER');
  await page.click('#screen-over button[data-act="submit"]');
  await page.waitForTimeout(2500);

  results.ui = await page.evaluate(() => ({
    submitLabel: document.querySelector('#screen-over [data-act="submit"]')?.textContent?.trim(),
    notice: document.querySelector('#screen-over [data-role="board-notice"]')?.textContent?.trim(),
    rows: [...document.querySelectorAll('#screen-over .board-row')].map((r) => r.textContent.trim()),
  }));
  results.upstream = upstreamCalls.map((c) => `${c.method} ${c.href.split('?')[0]}`);
  results.wrote = JSON.parse(upstreamCalls.find((c) => c.method === 'POST')?.body ?? '{}');
  results.pageErrors = pageErrors;

  const check = (label, ok, detail) => {
    if (!ok) failures.push(detail ? `${label} — ${detail}` : label);
  };

  check('the game should be in proxy mode', results.mode === 'proxy', results.mode);
  // 'Posted!' is the *remote* success label. A fallback to local scores says
  // 'Saved' instead, so matching the exact word keeps this discriminating.
  check(
    'the submit button should confirm the score went to the board',
    /posted/i.test(results.ui.submitLabel ?? ''),
    results.ui.submitLabel,
  );
  // The single most important assertion. Any contract mismatch shows up here as
  // a fallback to local scores, with a warning where this should be empty.
  check(
    'the board should be the remote one, not the local fallback',
    results.ui.notice === '',
    results.ui.notice,
  );
  check(
    "the player's submitted score should come back in the board",
    results.ui.rows.some((r) => r.includes('E2E RUNNER')),
    JSON.stringify(results.ui.rows),
  );
  check(
    'the pre-existing remote entry should be listed',
    results.ui.rows.some((r) => r.includes('HOUSE')),
    JSON.stringify(results.ui.rows),
  );
  check(
    'the proxy should have forwarded the name under the upstream key',
    results.wrote.playerDisplayName === 'E2E RUNNER',
    JSON.stringify(results.wrote),
  );
  check('the run metadata should survive the round trip', !!results.wrote.metadata);
  check('no page errors', pageErrors.length === 0, pageErrors.join('; '));
} finally {
  await browser?.close();
  stopVite();
  server.close();
}

console.log(JSON.stringify({ results, failures }, null, 1));

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.join('; ')}\n`);
  process.exit(1);
}
console.error('\nPASS: the game talks to the proxy and gets a real board back.\n');
