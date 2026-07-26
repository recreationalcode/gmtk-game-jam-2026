/**
 * Leaderboard proxy — a Vercel function that holds the simpleboards.dev API key
 * so the game does not have to.
 *
 *     itch.io (static, no key)  →  this function (holds the key)  →  simpleboards.dev
 *
 * Two endpoints on one route:
 *
 *     GET  /api/scores?limit=20   → { entries: [{ rank, name, score }], source }
 *     POST /api/scores            → { ok: true }
 *          body { name, score, playerId, metadata? }
 *
 * ---------------------------------------------------------------------------
 * What this does and does not buy you
 *
 * It **does** keep the API key off the client. That is the whole point, and it
 * works: nothing in the shipped bundle can be used to talk to simpleboards.dev
 * directly.
 *
 * It **does not** make scores trustworthy. Anyone can POST a number here — CORS
 * is a browser politeness mechanism, not an authorisation one, and a determined
 * player has curl. The validation below rejects nonsense, not lies. A board that
 * genuinely has to be trusted needs the server to simulate the run, which is a
 * much larger thing than a jam needs. Expect to moderate.
 *
 * ---------------------------------------------------------------------------
 * Environment variables (set in the Vercel dashboard)
 *
 *     SIMPLEBOARDS_API_KEY         required — the secret, never sent to clients
 *     SIMPLEBOARDS_LEADERBOARD_ID  required
 *     SIMPLEBOARDS_BASE_URL        optional — defaults to api.simpleboards.dev
 *     LEADERBOARD_ALLOWED_ORIGINS  optional — comma-separated, defaults to *
 *     LEADERBOARD_MAX_SCORE        optional — plausibility ceiling, default 250000
 */

export const config = { runtime: 'edge' };

// The Edge runtime exposes process.env. Declared locally rather than pulling in
// @types/node, which this project otherwise has no need for.
declare const process: { env: Record<string, string | undefined> };

const DEFAULT_BASE_URL = 'https://api.simpleboards.dev';
const DEFAULT_MAX_SCORE = 250_000;
const MAX_NAME_LENGTH = 16;
const MAX_PLAYER_ID_LENGTH = 64;
const MAX_LIMIT = 100;
const UPSTREAM_TIMEOUT_MS = 8000;

interface Env {
  apiKey: string;
  leaderboardId: string;
  baseUrl: string;
  maxScore: number;
}

export default async function handler(request: Request): Promise<Response> {
  const cors = corsHeaders(request.headers.get('origin'));

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  const env = readEnv();
  if (!env) {
    // Deliberately explicit: a misconfigured deployment should say so rather
    // than look like an outage. It names no values.
    return json(
      { error: 'Leaderboard is not configured on the server.' },
      503,
      cors,
    );
  }

  try {
    if (request.method === 'GET') return await readBoard(request, env, cors);
    if (request.method === 'POST') return await writeScore(request, env, cors);
  } catch (err) {
    return json({ error: describeError(err) }, 502, cors);
  }

  return json({ error: 'Method not allowed.' }, 405, { ...cors, Allow: 'GET, POST, OPTIONS' });
}

// -- read --------------------------------------------------------------------

/**
 * The board is a nested resource: `/api/leaderboards/{id}/entries`.
 *
 * This was originally a guess between two candidate shapes, reconstructed from
 * their client libraries rather than executed, because the build environment
 * blocks the service. A live deployment settled it: the flat `/api/entries`
 * returns 404 with an empty body (no such route), while the nested path reached
 * a real handler — it named itself `LeaderboardGetEntries` in an error. The
 * dead candidate is gone, so a failure is now one round trip and one story.
 *
 * The path still comes back in `x-upstream-path`, which is what confirmed it.
 */
async function readBoard(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get('limit'), 1, MAX_LIMIT, 20);
  const target = `${env.baseUrl}/api/leaderboards/${encodeURIComponent(env.leaderboardId)}/entries?limit=${limit}`;
  const path = new URL(target).pathname;

  const attempts: Attempt[] = [];
  try {
    const upstream = await fetchUpstream(target, {
      method: 'GET',
      headers: { 'x-api-key': env.apiKey, accept: 'application/json' },
    });

    if (upstream.ok) {
      const payload: unknown = await upstream.json().catch(() => null);
      return json(
        { entries: normaliseEntries(payload, limit), source: 'simpleboards' },
        200,
        // No caching. A player refreshes the board the instant they submit, and
        // serving them a five-second-old copy without their own score in it looks
        // exactly like a failed submission. Upstream load is not a jam's problem.
        { ...cors, 'Cache-Control': 'no-store', 'x-upstream-path': path },
      );
    }

    // Keep the body. The status alone cannot tell a wrong id from a wrong key
    // from a genuine outage, and upstream almost always says which.
    const detail = await upstream.text().catch(() => '');
    attempts.push({ path, status: upstream.status, detail: detail.slice(0, 300) });
  } catch (err) {
    attempts.push({ path, status: null, detail: describeError(err) });
  }

  return json(
    {
      error: `Upstream read failed: ${attempts.map((a) => `${a.path} → ${a.status ?? a.detail}`).join(', ')}`,
      hint: diagnose(attempts, env),
      attempts,
    },
    502,
    cors,
  );
}

interface Attempt {
  path: string;
  /** null when the request never got a response at all. */
  status: number | null;
  detail: string;
}

/** Board ids are GUIDs upstream. A name in that slot is a 500, not a 404. */
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Turn the collected statuses into the thing to go and change. */
function diagnose(attempts: Attempt[], env: Env): string {
  const statuses = attempts.map((a) => a.status);
  const all = (p: (s: number | null) => boolean) => statuses.length > 0 && statuses.every(p);

  // Checked before anything else, and deliberately before the 5xx branch. This
  // failure arrives as a 500 from upstream, which otherwise reads as "their
  // problem, wait it out" when it is entirely ours: their API binds the path
  // segment to a System.Guid, so a human-readable board name fails to convert
  // and takes the handler down with it.
  if (!GUID.test(env.leaderboardId) && statuses.some((s) => s !== null && s >= 400)) {
    return `SIMPLEBOARDS_LEADERBOARD_ID is "${env.leaderboardId}", which is a name rather than an id. Upstream wants the board's GUID — copy it from the simpleboards dashboard.`;
  }

  if (all((s) => s === null)) {
    return 'No response at all. Check SIMPLEBOARDS_BASE_URL, or upstream is down.';
  }
  if (all((s) => s === 401 || s === 403)) {
    return 'Upstream refused the key. Check SIMPLEBOARDS_API_KEY and that it has read access.';
  }
  if (all((s) => s === 404)) {
    return 'Both URL shapes 404. Either SIMPLEBOARDS_LEADERBOARD_ID is wrong, or neither candidate path in readBoard() matches the current API — check their docs and pin the right one.';
  }
  if (statuses.some((s) => s === 429)) {
    return 'Rate limited upstream. Back off and retry.';
  }
  if (all((s) => s !== null && s >= 500)) {
    return 'Upstream is erroring. This one is not yours to fix; retry later.';
  }
  return 'See `attempts` for what each candidate path returned.';
}

// -- write -------------------------------------------------------------------

async function writeScore(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return json({ error: 'Expected a JSON object.' }, 400, cors);
  }
  const input = body as Record<string, unknown>;

  const score = Math.floor(asNumber(input.score) ?? Number.NaN);
  if (!Number.isFinite(score) || score < 0) {
    return json({ error: 'Score must be a non-negative number.' }, 400, cors);
  }
  if (score > env.maxScore) {
    // Not an anti-cheat measure — see the header comment. This rejects values
    // that could not come from the game at all, so obvious garbage never
    // reaches the board and has to be moderated off it by hand.
    return json({ error: 'Score is outside the plausible range.' }, 422, cors);
  }

  const name = sanitiseName(asString(input.name) ?? '');
  const playerId = (asString(input.playerId) ?? '').slice(0, MAX_PLAYER_ID_LENGTH).trim();
  if (playerId.length === 0) {
    return json({ error: 'Missing playerId.' }, 400, cors);
  }

  // The same nested resource the read uses, and for the same reason: the flat
  // `/api/entries` does not exist. The board is in the path, so the body does
  // not repeat it.
  const target = `${env.baseUrl}/api/leaderboards/${encodeURIComponent(env.leaderboardId)}/entries`;
  const path = new URL(target).pathname;

  const upstream = await fetchUpstream(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.apiKey,
      accept: 'application/json',
    },
    body: JSON.stringify({
      playerId,
      playerDisplayName: name,
      score,
      metadata: JSON.stringify(pickMetadata(input.metadata)),
    }),
  });

  if (upstream.ok) {
    return json({ ok: true, name, score }, 200, { ...cors, 'x-upstream-path': path });
  }

  // Never retried. Upstream has matched the route and made its own decision, so
  // a second attempt could put the same run on the board twice — a worse
  // outcome than a score that failed to submit, which the client already
  // handles by keeping it locally.
  const detail = await upstream.text().catch(() => '');
  const attempts: Attempt[] = [{ path, status: upstream.status, detail: detail.slice(0, 300) }];
  return json(
    {
      error: `Upstream rejected the score: ${path} → ${upstream.status}`,
      hint: diagnose(attempts, env),
      attempts,
    },
    upstream.status >= 500 ? 502 : 400,
    cors,
  );
}

/**
 * Copy only the run statistics we know about, as numbers.
 *
 * Forwarding the client's metadata object verbatim would let anyone write
 * arbitrary JSON of arbitrary size into someone else's service under our key.
 * A whitelist costs nothing and closes that entirely.
 */
function pickMetadata(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== 'object' || raw === null) return out;
  const src = raw as Record<string, unknown>;
  for (const key of ['depth', 'descents', 'perfects', 'bestCombo', 'tiles'] as const) {
    const v = asNumber(src[key]);
    if (v !== null && Number.isFinite(v)) out[key] = clamp(Math.floor(v), 0, 100_000);
  }
  return out;
}

// -- shared ------------------------------------------------------------------

function readEnv(): Env | null {
  const apiKey = process.env.SIMPLEBOARDS_API_KEY?.trim();
  const leaderboardId = process.env.SIMPLEBOARDS_LEADERBOARD_ID?.trim();
  if (!apiKey || !leaderboardId) return null;

  return {
    apiKey,
    leaderboardId,
    baseUrl: (process.env.SIMPLEBOARDS_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    maxScore:
      clampInt(process.env.LEADERBOARD_MAX_SCORE, 1, Number.MAX_SAFE_INTEGER, DEFAULT_MAX_SCORE),
  };
}

/**
 * An origin allowlist is a convenience, not a security boundary — it stops other
 * websites embedding this board, and stops nothing else. Hence the permissive
 * default: a public leaderboard read is public either way.
 */
function corsHeaders(origin: string | null): Record<string, string> {
  const base: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  const configured = (process.env.LEADERBOARD_ALLOWED_ORIGINS ?? '*').trim();
  if (configured === '*' || configured === '') {
    return { ...base, 'Access-Control-Allow-Origin': '*' };
  }

  const allowed = configured.split(',').map((s) => s.trim()).filter(Boolean);
  // No matching header when the origin is not on the list, so the browser
  // blocks the response rather than us returning a wrong-but-present one.
  if (origin && allowed.includes(origin)) {
    return { ...base, 'Access-Control-Allow-Origin': origin };
  }
  return base;
}

function fetchUpstream(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function json(payload: unknown, status: number, headers: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * Tolerant parsing, then a single shape out.
 *
 * The response could be a bare array, or wrapped in `entries`, `data`, `items`
 * or `results`, and names could arrive under any of several keys. Being
 * permissive here is cheaper than being wrong on jam day — and doing it once,
 * server-side, means the client only ever sees one shape.
 */
function normaliseEntries(
  payload: unknown,
  limit: number,
): Array<{ rank: number; name: string; score: number }> {
  let rows: unknown[] = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else if (typeof payload === 'object' && payload !== null) {
    for (const key of ['entries', 'data', 'items', 'results']) {
      const v = (payload as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        rows = v;
        break;
      }
    }
  }

  return rows
    .map((row, i) => {
      const r = (typeof row === 'object' && row !== null ? row : {}) as Record<string, unknown>;
      const name =
        asString(r.playerDisplayName) ??
        asString(r.displayName) ??
        asString(r.name) ??
        asString(r.player) ??
        'ANON';
      return {
        rank: Math.floor(asNumber(r.rank) ?? asNumber(r.position) ?? i + 1),
        name: sanitiseName(name),
        score: Math.floor(asNumber(r.score) ?? asNumber(r.value) ?? asNumber(r.points) ?? 0),
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

/**
 * Mirrors the client's rule: drop control characters and the five
 * markup-significant ones, collapse whitespace, cap the length.
 *
 * Duplicated rather than imported because this file is deployed on its own and
 * must not depend on the game bundle. It is also the copy that matters: the
 * client's runs on the sender's machine, this one runs on ours.
 */
function sanitiseName(name: string): string {
  let stripped = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (ch === '<' || ch === '>' || ch === '&' || ch === '"' || ch === "'") continue;
    stripped += ch;
  }
  const safe = stripped.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return safe.length > 0 ? safe : 'ANON';
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampInt(raw: string | null | undefined, lo: number, hi: number, fallback: number): number {
  const n = asNumber(raw ?? null);
  return n === null ? fallback : clamp(Math.floor(n), lo, hi);
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return 'Upstream timed out';
  if (err instanceof Error) return err.message;
  return 'Network error';
}
