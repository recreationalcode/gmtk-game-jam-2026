import { LEADERBOARD } from '../core/Config';
import type { RunSummary } from '../game/GameState';

export interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
  isSelf: boolean;
}

export type BoardSource = 'simpleboards' | 'local';

export type SubmitResult =
  | { ok: true; source: BoardSource }
  | { ok: false; error: string };

export interface BoardResult {
  entries: LeaderboardEntry[];
  source: BoardSource;
  /** Set when the remote board was tried and failed, for an honest UI. */
  error?: string;
}

/**
 * Talk to our own proxy, which holds the API key. Nothing secret is bundled.
 * This is the recommended setup — see `api/scores.ts` and docs/LEADERBOARD.md.
 */
interface ProxyConfig {
  kind: 'proxy';
  /** Absolute origin of the deployed function, no trailing slash. */
  baseUrl: string;
}

/**
 * Talk to simpleboards.dev directly with a key inlined into the bundle. Kept
 * as the no-server fallback; anyone who looks can extract the key.
 */
interface DirectConfig {
  kind: 'direct';
  apiKey: string;
  leaderboardId: string;
  baseUrl: string;
}

type RemoteConfig = ProxyConfig | DirectConfig;

/**
 * Leaderboard access, remote-with-local-fallback.
 *
 * Three things to know about this file:
 *
 * 1. There are two remote modes. **Proxy** mode talks to our own serverless
 *    function, which holds the API key server-side — that is the one to use.
 *    **Direct** mode inlines the key into the bundle, where anyone who looks
 *    can extract it; it exists so the game still has an online board without a
 *    server to deploy to. Proxy wins if both are configured.
 *
 * 2. The simpleboards.dev request shape was reconstructed from their client
 *    libraries, not executed — the build environment blocks their domain. In
 *    proxy mode that uncertainty lives on the server, where fixing a wrong
 *    guess is a redeploy rather than a rebuilt game. See docs/LEADERBOARD.md.
 *
 * 3. Scores are always written locally as well, so the player's own history
 *    survives an outage, a blocked domain, or an unconfigured board.
 */
export class Leaderboard {
  private readonly config: RemoteConfig | null;
  private readonly playerId: string;

  constructor() {
    this.config = readConfig();
    this.playerId = ensurePlayerId();
  }

  get isRemoteConfigured(): boolean {
    return this.config !== null;
  }

  /** Which remote path is in use, for diagnostics and the headless tests. */
  get remoteMode(): 'proxy' | 'direct' | 'local' {
    return this.config?.kind ?? 'local';
  }

  getStoredName(): string {
    try {
      return localStorage.getItem(LEADERBOARD.playerNameKey) ?? '';
    } catch {
      return '';
    }
  }

  storeName(name: string): void {
    try {
      localStorage.setItem(LEADERBOARD.playerNameKey, name);
    } catch {
      /* Private browsing. Not worth surfacing. */
    }
  }

  /**
   * Submit a run. Always records locally; attempts the remote board when
   * configured. Never throws — a failed submission must not eat the score
   * screen.
   */
  async submit(name: string, summary: RunSummary): Promise<SubmitResult> {
    const clean = sanitiseName(name);
    this.storeName(clean);
    this.writeLocal(clean, summary.score);

    // No remote board configured is a success, not a failure — the score really
    // was saved. Reporting it as an error offers the player a "retry" that
    // cannot possibly do anything.
    if (!this.config) return { ok: true, source: 'local' };

    try {
      const res =
        this.config.kind === 'proxy'
          ? await this.request(`${this.config.baseUrl}/api/scores`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                playerId: this.playerId,
                name: clean,
                score: Math.floor(summary.score),
                metadata: {
                  depth: summary.maxDepth,
                  descents: summary.descents,
                  perfects: summary.perfects,
                  bestCombo: summary.bestCombo,
                  tiles: summary.tilesScored,
                },
              }),
            })
          : await this.request(`${this.config.baseUrl}/api/entries`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': this.config.apiKey,
              },
              body: JSON.stringify({
                leaderboardId: this.config.leaderboardId,
                playerId: this.playerId,
                playerDisplayName: clean,
                score: Math.floor(summary.score),
                metadata: JSON.stringify({
                  depth: summary.maxDepth,
                  descents: summary.descents,
                  perfects: summary.perfects,
                  bestCombo: summary.bestCombo,
                  tiles: summary.tilesScored,
                }),
              }),
            });

      if (!res.ok) return { ok: false, error: await describeResponse(res) };
      return { ok: true, source: 'simpleboards' };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  /** Fetch the top N. Falls back to the local board on any failure. */
  async top(limit = LEADERBOARD.topN): Promise<BoardResult> {
    const cfg = this.config;
    if (!cfg) return { entries: this.readLocal(limit), source: 'local' };

    // Proxy mode gets one URL and one response shape, because the server
    // already resolved both. Direct mode still has to guess.
    const attempts =
      cfg.kind === 'proxy'
        ? [{ url: `${cfg.baseUrl}/api/scores?limit=${limit}`, headers: {} as HeadersInit }]
        : [
            {
              url: `${cfg.baseUrl}/api/entries?leaderboardId=${encodeURIComponent(cfg.leaderboardId)}&limit=${limit}`,
              headers: { 'x-api-key': cfg.apiKey } as HeadersInit,
            },
            {
              url: `${cfg.baseUrl}/api/leaderboards/${encodeURIComponent(cfg.leaderboardId)}/entries?limit=${limit}`,
              headers: { 'x-api-key': cfg.apiKey } as HeadersInit,
            },
          ];

    let lastError = 'Unknown error';
    for (const attempt of attempts) {
      try {
        const res = await this.request(attempt.url, { method: 'GET', headers: attempt.headers });
        if (!res.ok) {
          lastError = await describeResponse(res);
          continue;
        }
        return {
          entries: parseEntries(await res.json(), this.getStoredName(), limit),
          source: 'simpleboards',
        };
      } catch (err) {
        lastError = describeError(err);
      }
    }

    return { entries: this.readLocal(limit), source: 'local', error: lastError };
  }

  private request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LEADERBOARD.timeoutMs);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  // -- local fallback ------------------------------------------------------

  private writeLocal(name: string, score: number): void {
    try {
      const rows = this.rawLocal();
      rows.push({ name, score: Math.floor(score), at: Date.now() });
      rows.sort((a, b) => b.score - a.score);
      localStorage.setItem(LEADERBOARD.localStorageKey, JSON.stringify(rows.slice(0, 50)));
    } catch {
      /* Storage unavailable; the run simply is not remembered. */
    }
  }

  private rawLocal(): Array<{ name: string; score: number; at: number }> {
    try {
      const raw = localStorage.getItem(LEADERBOARD.localStorageKey);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (r): r is { name: string; score: number; at: number } =>
          typeof r === 'object' && r !== null && typeof (r as { score?: unknown }).score === 'number',
      );
    } catch {
      return [];
    }
  }

  readLocal(limit: number): LeaderboardEntry[] {
    // Highlight only rows matching the current name. Marking every local row as
    // "you" is technically true — they are all from this device — but it makes
    // the highlight mean nothing, and a shared device really can hold several
    // people's scores.
    const self = sanitiseName(this.getStoredName()).toLowerCase();
    return this.rawLocal()
      .slice(0, limit)
      .map((r, i) => {
        const name = sanitiseName(r.name || 'YOU');
        return {
          rank: i + 1,
          name,
          score: r.score,
          isSelf: self.length > 0 && name.toLowerCase() === self,
        };
      });
  }

  get personalBest(): number {
    const rows = this.rawLocal();
    return rows.length > 0 ? rows[0]!.score : 0;
  }
}

function readConfig(): RemoteConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;

  // Proxy first. If someone has deployed the function, that is what they meant
  // to use, whatever else is lying around in their .env from an earlier setup.
  const proxy = env.VITE_LEADERBOARD_PROXY?.trim().replace(/\/+$/, '');
  if (proxy) return { kind: 'proxy', baseUrl: proxy };

  const apiKey = env.VITE_SIMPLEBOARDS_API_KEY?.trim();
  const leaderboardId = env.VITE_SIMPLEBOARDS_LEADERBOARD_ID?.trim();
  if (!apiKey || !leaderboardId) return null;
  const baseUrl = (env.VITE_SIMPLEBOARDS_BASE_URL?.trim() || 'https://api.simpleboards.dev').replace(
    /\/+$/,
    '',
  );
  return { kind: 'direct', apiKey, leaderboardId, baseUrl };
}

function ensurePlayerId(): string {
  try {
    const existing = localStorage.getItem(LEADERBOARD.playerIdKey);
    if (existing) return existing;
    const id =
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `p-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
    localStorage.setItem(LEADERBOARD.playerIdKey, id);
    return id;
  } catch {
    return `anon-${Math.random().toString(36).slice(2)}`;
  }
}

export function sanitiseName(name: string): string {
  // Drop control characters and the five markup-significant ones. Everything
  // else (spaces, punctuation, accents) is a legitimate part of a player name.
  // Rows are written with textContent, so this is defence in depth against a
  // service that does not sanitise its own output, not the only guard.
  let stripped = '';
  for (const ch of name) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (MARKUP_CHARS.has(ch)) continue;
    stripped += ch;
  }
  const safe = stripped.replace(/\s+/g, ' ').trim().slice(0, LEADERBOARD.maxNameLength);
  return safe.length > 0 ? safe : 'ANON';
}

const MARKUP_CHARS = new Set(['<', '>', '&', '"', "'"]);

/**
 * Tolerant parsing: the response could be a bare array, `{entries}`, `{data}`
 * or `{items}`, and names could arrive under several keys. Being permissive
 * here is cheaper than being wrong on jam day.
 */
function parseEntries(payload: unknown, selfName: string, limit: number): LeaderboardEntry[] {
  const rows = extractArray(payload);
  const self = sanitiseName(selfName).toLowerCase();

  return rows
    .map((row, i) => {
      const r = row as Record<string, unknown>;
      const name = firstString(r, ['playerDisplayName', 'displayName', 'name', 'player']) || 'ANON';
      const score = firstNumber(r, ['score', 'value', 'points']) ?? 0;
      const rank = firstNumber(r, ['rank', 'position']) ?? i + 1;
      return {
        rank,
        name: sanitiseName(name),
        score: Math.floor(score),
        isSelf: sanitiseName(name).toLowerCase() === self && self.length > 0,
      };
    })
    .sort((a, b) => a.rank - b.rank)
    .slice(0, limit);
}

function extractArray(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'object' && payload !== null) {
    for (const key of ['entries', 'data', 'items', 'results']) {
      const v = (payload as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v;
    }
  }
  return [];
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function firstNumber(obj: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/**
 * The proxy explains its own refusals in the body, and those explanations are
 * the useful ones — "Score is outside the plausible range" beats "HTTP 422" on
 * a score screen. Falls back to the status when there is nothing to read.
 */
async function describeResponse(res: Response): Promise<string> {
  try {
    const body: unknown = await res.clone().json();
    if (typeof body === 'object' && body !== null) {
      const msg = (body as { error?: unknown }).error;
      if (typeof msg === 'string' && msg.length > 0) return msg;
    }
  } catch {
    /* Not JSON, or already consumed. The status is still informative. */
  }
  return `HTTP ${res.status}`;
}

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return 'Request timed out';
  if (err instanceof Error) return err.message;
  return 'Network error';
}
