import { LEADERBOARD } from '../core/Config';
import type { RunSummary } from '../game/GameState';

export interface LeaderboardEntry {
  rank: number;
  name: string;
  score: number;
  isSelf: boolean;
}

export type BoardSource = 'simpleboards' | 'local';

export interface BoardResult {
  entries: LeaderboardEntry[];
  source: BoardSource;
  /** Set when the remote board was tried and failed, for an honest UI. */
  error?: string;
}

interface SimpleBoardsConfig {
  apiKey: string;
  leaderboardId: string;
  baseUrl: string;
}

/**
 * Leaderboard access, remote-with-local-fallback.
 *
 * Two things to know about this file:
 *
 * 1. The simpleboards.dev request shape here was reconstructed from their
 *    client libraries, not executed — the build environment blocks their
 *    domain, so it is written defensively (tolerant response parsing, two
 *    candidate endpoint shapes) and needs one verification run against the live
 *    service. See docs/LEADERBOARD.md.
 *
 * 2. The API key ships inside the client bundle and is therefore extractable.
 *    That is inherent to a static itch.io build with no server of its own, not
 *    an oversight — use a submit-scoped key and expect to moderate the board.
 *
 * Scores are always written locally as well, so the player's own history
 * survives an outage, a blocked domain, or an unconfigured key.
 */
export class Leaderboard {
  private readonly config: SimpleBoardsConfig | null;
  private readonly playerId: string;

  constructor() {
    this.config = readConfig();
    this.playerId = ensurePlayerId();
  }

  get isRemoteConfigured(): boolean {
    return this.config !== null;
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
  async submit(name: string, summary: RunSummary): Promise<{ ok: boolean; error?: string }> {
    const clean = sanitiseName(name);
    this.storeName(clean);
    this.writeLocal(clean, summary.score);

    if (!this.config) return { ok: false, error: 'Leaderboard not configured' };

    try {
      const res = await this.request(`${this.config.baseUrl}/api/entries`, {
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

      if (!res.ok) return { ok: false, error: `Submit failed (${res.status})` };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  /** Fetch the top N. Falls back to the local board on any failure. */
  async top(limit = LEADERBOARD.topN): Promise<BoardResult> {
    if (!this.config) {
      return { entries: this.readLocal(limit), source: 'local' };
    }

    const cfg = this.config;
    // Two candidate shapes because the exact path could not be verified from
    // this environment. Whichever answers first wins; both failing falls back.
    const candidates = [
      `${cfg.baseUrl}/api/entries?leaderboardId=${encodeURIComponent(cfg.leaderboardId)}&limit=${limit}`,
      `${cfg.baseUrl}/api/leaderboards/${encodeURIComponent(cfg.leaderboardId)}/entries?limit=${limit}`,
    ];

    let lastError = 'Unknown error';
    for (const url of candidates) {
      try {
        const res = await this.request(url, {
          method: 'GET',
          headers: { 'x-api-key': cfg.apiKey },
        });
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          continue;
        }
        const parsed = parseEntries(await res.json(), this.getStoredName(), limit);
        if (parsed.length > 0 || res.status === 200) {
          return { entries: parsed, source: 'simpleboards' };
        }
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
    return this.rawLocal()
      .slice(0, limit)
      .map((r, i) => ({
        rank: i + 1,
        name: r.name || 'YOU',
        score: r.score,
        isSelf: true,
      }));
  }

  get personalBest(): number {
    const rows = this.rawLocal();
    return rows.length > 0 ? rows[0]!.score : 0;
  }
}

function readConfig(): SimpleBoardsConfig | null {
  const env = import.meta.env as Record<string, string | undefined>;
  const apiKey = env.VITE_SIMPLEBOARDS_API_KEY?.trim();
  const leaderboardId = env.VITE_SIMPLEBOARDS_LEADERBOARD_ID?.trim();
  if (!apiKey || !leaderboardId) return null;
  const baseUrl = (env.VITE_SIMPLEBOARDS_BASE_URL?.trim() || 'https://api.simpleboards.dev').replace(
    /\/+$/,
    '',
  );
  return { apiKey, leaderboardId, baseUrl };
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

function describeError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'AbortError') return 'Request timed out';
  if (err instanceof Error) return err.message;
  return 'Network error';
}
