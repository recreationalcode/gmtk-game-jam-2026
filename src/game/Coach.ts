import { CLOCK, FREEZE, TILE_DECAY, TIME_TILE_BONUS, TileKind } from '../core/Config';
import type { GameEvent } from './GameState';
import type { GameState } from './GameState';

/**
 * Decides *when* the player needs to be told something.
 *
 * Pure rules: no DOM, no three.js. It watches the simulation's event stream and
 * a per-frame snapshot, and emits notices for the presentation layer to draw.
 *
 * The design constraints matter more than the individual tips:
 *
 * - **Just in time, never up front.** A tile is explained the first time it is
 *   on the board in front of you, not in a wall of text before you play. The
 *   guide screen is for people who want it; this is for everyone else.
 * - **Say it once.** Every notice has a lifetime show count persisted across
 *   runs. Nothing is more irritating than a jam game re-teaching you on your
 *   ninth attempt.
 * - **Behavioural tips get more patience than discoveries.** Not knowing what a
 *   FREEZE tile is gets one explanation; not having discovered the charged
 *   bounce is worth a second nudge on a later run.
 * - **Nothing during the final seconds.** The endgame is already the loudest
 *   part of the game; a tip there is noise on top of noise.
 */

export type NoticeTone = 'info' | 'good' | 'warn';

export interface Notice {
  id: string;
  title: string;
  body?: string;
  /** Glyph atlas index to draw beside the text, if any. */
  glyph?: number;
  /** Render a composed multiplier instead of a glyph. */
  multiplier?: number;
  tone: NoticeTone;
  /** Higher wins when several are queued at once. */
  priority: number;
}

/** Per-notice lifetime show budget. */
const MAX_SHOWS: Record<string, number> = {
  'tile:down': 2,
  'tile:up': 1,
  'tile:time': 1,
  'tile:boost': 1,
  'tile:freeze': 1,
  'tile:burnout': 1,
  'tip:charge': 3,
  'tip:perfect': 2,
  'tip:reset': 2,
  'tip:stuck': 2,
  'event:multiplier': Number.POSITIVE_INFINITY,
  'event:endgame': 2,
};

/** How many landings without a timed press before we mention it. */
const CHARGE_HINT_AFTER_LANDINGS = 7;
/** How many charged bounces without a perfect before we mention the window. */
const PERFECT_HINT_AFTER_CHARGED = 5;
/** Seconds on the opening floor before we point out the way down. */
const DOWN_HINT_AFTER_SECONDS = 6;

export interface SeenStore {
  count(id: string): number;
  record(id: string): void;
}

export class Coach {
  private readonly seen: SeenStore;
  private readonly pending: Notice[] = [];
  /** Ids already emitted during this run, so a run can never repeat itself. */
  private readonly firedThisRun = new Set<string>();

  /** Set by the app from the detected input scheme, so tips name real actions. */
  touchMode = false;

  private landings = 0;
  private chargedBounces = 0;
  private timedPresses = 0;
  private perfects = 0;
  private runTime = 0;
  private descended = false;

  constructor(seen: SeenStore) {
    this.seen = seen;
  }

  reset(): void {
    this.pending.length = 0;
    this.firedThisRun.clear();
    this.landings = 0;
    this.chargedBounces = 0;
    this.timedPresses = 0;
    this.perfects = 0;
    this.runTime = 0;
    this.descended = false;
  }

  drain(): Notice[] {
    if (this.pending.length === 0) return EMPTY;
    const out = this.pending.slice().sort((a, b) => b.priority - a.priority);
    this.pending.length = 0;
    return out;
  }

  // -- rules ---------------------------------------------------------------

  onEvent(e: GameEvent, game: GameState): void {
    switch (e.type) {
      case 'land':
        this.landings++;
        if (e.quality !== 'normal') {
          this.timedPresses++;
          this.chargedBounces++;
        }
        if (e.quality === 'perfect') this.perfects++;
        if (e.kind === TileKind.Up) {
          this.push({
            id: 'tile:up',
            title: 'That cost you a level',
            body: 'Red arrows throw you back up and drop your multiplier. Give them a wide berth.',
            glyph: GLYPH_UP,
            tone: 'warn',
            priority: 60,
          });
        }
        break;

      case 'descend':
        this.descended = true;
        this.push({
          id: 'event:multiplier',
          title: `Multiplier ×${e.multiplier}`,
          // The explanation is only worth saying while it is still news.
          body:
            this.seen.count('event:multiplier') < 2
              ? `Every tile is now worth ${e.multiplier}× its number. Depth beats farming.`
              : undefined,
          multiplier: e.multiplier,
          tone: 'good',
          priority: 80,
        });
        break;

      case 'ascend':
        if (e.depth > 0 || game.depth > 0) {
          this.push({
            id: 'tip:reset',
            title: 'Burned tiles came back',
            body: 'Changing level restores anything that decayed to zero on the floor you arrive at.',
            tone: 'info',
            priority: 55,
          });
        }
        break;

      case 'burnout':
        this.push({
          id: 'tile:burnout',
          title: 'A tile burned out',
          body: 'Numbers tick down. One that reaches zero turns into an UP tile — spend them while they are high.',
          glyph: GLYPH_UP,
          tone: 'warn',
          priority: 50,
        });
        break;

      case 'gainTime':
        this.push({
          id: 'tile:time',
          title: `+${TIME_TILE_BONUS} seconds`,
          body: 'Clock tiles are the only way to extend a run.',
          glyph: GLYPH_TIME,
          tone: 'good',
          priority: 70,
        });
        break;

      case 'boost':
        this.push({
          id: 'tile:boost',
          title: 'Multiplier boost',
          body: 'Boost tiles raise your multiplier without having to find the way down.',
          glyph: GLYPH_BOOST,
          tone: 'good',
          priority: 70,
        });
        break;

      case 'freeze':
        this.push({
          id: 'tile:freeze',
          title: `Countdowns frozen for ${FREEZE.duration}s`,
          body: 'Nothing decays while this is running. Cash the big numbers now.',
          glyph: GLYPH_FREEZE,
          tone: 'good',
          priority: 70,
        });
        break;

      case 'endgame':
        this.push({
          id: 'event:endgame',
          title: `Final ${CLOCK.endgameSeconds} seconds`,
          body: 'Tiles decay faster now. Take what is in front of you.',
          tone: 'warn',
          priority: 75,
        });
        break;

      default:
        break;
    }
  }

  /** Polled conditions — things defined by an *absence* of player action. */
  update(dt: number, game: GameState): void {
    this.runTime += dt;

    // Never teach during the endgame; it is already the busiest the game gets.
    if (game.endgame) return;

    if (this.landings >= CHARGE_HINT_AFTER_LANDINGS && this.timedPresses === 0) {
      this.push({
        id: 'tip:charge',
        title: 'Try timing your bounce',
        body: this.touchMode
          ? 'Hold and drag to aim, then release just before you land. A timed bounce goes higher and reaches further.'
          : 'Click or press Space just before you land. A timed bounce goes higher and reaches further.',
        tone: 'info',
        priority: 90,
      });
    }

    if (this.chargedBounces >= PERFECT_HINT_AFTER_CHARGED && this.perfects === 0) {
      this.push({
        id: 'tip:perfect',
        title: 'Aim for PERFECT',
        body: this.touchMode
          ? 'Release at the moment the closing ring meets the square. Perfect bounces build a combo multiplier.'
          : 'Press at the moment the closing ring meets the square. Perfect bounces build a combo multiplier.',
        tone: 'info',
        priority: 85,
      });
    }

    if (!this.descended && this.runTime > DOWN_HINT_AFTER_SECONDS) {
      this.push({
        id: 'tile:down',
        title: 'Find the green tile',
        body: 'It shows the multiplier it gives you. Landing on it drops you a floor — that is where the points are.',
        multiplier: game.multiplier + 1,
        tone: 'info',
        priority: 95,
      });
    }

    // A floor with almost nothing left on it is a floor to leave.
    if (this.descended && TILE_DECAY.enabled) {
      const floor = game.floor;
      let scoring = 0;
      for (const t of floor.tiles) if (t.kind === TileKind.Number) scoring++;
      if (scoring === 0) {
        this.push({
          id: 'tip:stuck',
          title: 'This floor is spent',
          body: 'Nothing left worth landing on. Take the way down — the next floor is fresh.',
          tone: 'info',
          priority: 65,
        });
      }
    }
  }

  private push(notice: Notice): void {
    if (this.firedThisRun.has(notice.id)) return;
    const limit = MAX_SHOWS[notice.id] ?? 1;
    if (this.seen.count(notice.id) >= limit) return;

    this.firedThisRun.add(notice.id);
    this.seen.record(notice.id);
    this.pending.push(notice);
  }
}

const EMPTY: Notice[] = [];

// Kept as plain numbers so this module stays free of render-layer imports.
// They match src/render/GlyphAtlas.ts.
const GLYPH_UP = 11;
const GLYPH_TIME = 13;
const GLYPH_BOOST = 14;
const GLYPH_FREEZE = 15;
