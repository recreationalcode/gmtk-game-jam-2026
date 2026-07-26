import { CLOCK, FREEZE, TILE_DECAY, TIME_TILE_BONUS, TileKind } from '../core/Config';
import type { GameEvent, GameState } from './GameState';

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
  // The objective, not a tip. Shown on the first few runs and then assumed
  // known — repeating it on someone's ninth attempt is noise, but a player who
  // arrives from an itch.io page with no idea what this is needs it said once.
  'intro:objective': 3,
  'tile:down': 2,
  'tile:up': 1,
  'tile:time': 1,
  'tile:boost': 1,
  'tile:freeze': 1,
  'tile:burnout': 1,
  'tip:charge': 4,
  'tip:perfect': 2,
  'tip:reset': 2,
  'tip:stuck': 2,
  'event:multiplier': Number.POSITIVE_INFINITY,
  'event:multiplierLost': 2,
  'event:endgame': 2,
};

/** How many landings without a timed press before we mention it. */
const CHARGE_HINT_AFTER_LANDINGS = 7;
/**
 * Backstop for the same tip: past the first floor, this long, still no timed
 * press. The landing count normally fires first, but a player who got down a
 * level without ever discovering the bounce is the one who most needs telling,
 * and they should not be able to fall through the gap.
 */
const CHARGE_HINT_AFTER_SECONDS_BELOW_SURFACE = 20;
/** How many charged bounces without a perfect before we mention the window. */
const PERFECT_HINT_AFTER_CHARGED = 5;
/**
 * Seconds on the opening floor before we point out the way down — or, sooner,
 * this many UP tiles taken while still on it. Patient with someone exploring,
 * quick with someone visibly struggling.
 */
const DOWN_HINT_AFTER_SECONDS = 10;
const DOWN_HINT_AFTER_SURFACE_UPS = 2;

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
  /** UP tiles taken while still on the opening floor. */
  private surfaceUps = 0;

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
    this.surfaceUps = 0;
  }

  drain(): Notice[] {
    if (this.pending.length === 0) return EMPTY;
    const out = this.pending.slice().sort((a, b) => b.priority - a.priority);
    this.pending.length = 0;
    return out;
  }

  // -- rules ---------------------------------------------------------------

  /**
   * Takes no live game state, deliberately.
   *
   * Events are drained after the whole frame has simulated, so by the time a
   * rule runs, `GameState` describes a later moment than the event does. That
   * has already produced one wrong notice — a ×2 descent announced as "×1" —
   * so everything a rule needs now travels on the event itself, and there is no
   * live state here to reach for by mistake.
   */
  onEvent(e: GameEvent): void {
    switch (e.type) {
      case 'land':
        this.landings++;
        if (e.quality !== 'normal') {
          this.timedPresses++;
          this.chargedBounces++;
        }
        if (e.quality === 'perfect') this.perfects++;
        // What an UP tile actually costs depends on where you were standing,
        // and the land event does not know that. Handled under `ascend`, which
        // does.
        break;

      case 'descend':
        this.descended = true;
        this.push({
          id: 'event:multiplier',
          title: `Multiplier ×${e.multiplier}`,
          // The explanation is only worth saying while it is still news, and
          // the *first* descent has more to explain than the number: the floor
          // under you is a different, bigger one now.
          body: this.descendBody(e.multiplier, e.depth),
          multiplier: e.multiplier,
          tone: 'good',
          priority: 80,
        });
        break;

      case 'ascend':
        this.onAscend(e.from, e.multiplier);
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

  /**
   * What a descent is worth saying, which changes with how many you have made.
   *
   * The first one is not really about the number. The floor visibly fell away
   * and a different, larger one took its place, and nothing else in the game
   * tells the player that is what descending *is*.
   */
  private descendBody(multiplier: number, depth: number): string | undefined {
    if (depth === 1) {
      return `You are on a new floor — bigger, more tiles, smaller targets. Every tile down here is worth ${multiplier}× its number.`;
    }
    if (this.seen.count('event:multiplier') < 3) {
      return `Every tile is now worth ${multiplier}× its number. Depth beats farming.`;
    }
    return undefined;
  }

  /**
   * An UP tile does three different things depending on where you took it, and
   * the player should be told the one that actually happened.
   *
   * @param from depth departed — 0 means the bounce was simply wasted
   */
  private onAscend(from: number, multiplier: number): void {
    if (from === 0) {
      this.surfaceUps++;
      this.push({
        id: 'tile:up',
        title: 'Red arrows throw you back',
        body: 'Up a level, and a multiplier with it. On the surface there is nowhere to go, so this one only cost you the bounce.',
        glyph: GLYPH_UP,
        tone: 'warn',
        priority: 60,
      });
      return;
    }

    // A real loss. This is the first time the multiplier has ever gone *down*,
    // and the HUD number dropping is easy to miss in the middle of being
    // thrown a whole storey upward.
    const lost = this.push({
      id: 'event:multiplierLost',
      title: `Multiplier ×${multiplier}`,
      body: `An UP tile knocked you back a floor and took a multiplier with it. Every tile is worth ${multiplier}× now — get back down.`,
      multiplier,
      tone: 'warn',
      priority: 82,
    });

    // Never both at once. They are about the same bounce, and the queue would
    // spend seven seconds of a sixty-second run explaining it.
    if (lost) return;
    this.push({
      id: 'tip:reset',
      title: 'The floor reset',
      body: 'Leaving a floor restores its numbers — anything that decayed to zero is a number again.',
      tone: 'info',
      priority: 55,
    });
  }

  /** Polled conditions — things defined by an *absence* of player action. */
  update(dt: number, game: GameState): void {
    const first = this.runTime === 0;
    this.runTime += dt;

    // The objective, before anything else. It fits in the opening drop, which
    // is dead time the clock is not even counting yet.
    if (first) {
      this.push({
        id: 'intro:objective',
        title: `Score as much as you can in ${Math.round(CLOCK.matchSeconds)} seconds`,
        body: 'Bounce on numbered tiles to collect them. Find the green tile to drop a floor — that is what makes everything worth more.',
        tone: 'info',
        priority: 100,
      });
    }

    // Never teach during the endgame; it is already the busiest the game gets.
    if (game.endgame) return;

    const stillNoTimedPress = this.timedPresses === 0;
    const strandedBelow =
      this.descended && this.runTime > CHARGE_HINT_AFTER_SECONDS_BELOW_SURFACE;
    if (stillNoTimedPress && (this.landings >= CHARGE_HINT_AFTER_LANDINGS || strandedBelow)) {
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

    const stuckOnSurface =
      this.runTime > DOWN_HINT_AFTER_SECONDS || this.surfaceUps >= DOWN_HINT_AFTER_SURFACE_UPS;
    if (!this.descended && stuckOnSurface) {
      this.push({
        id: 'tile:down',
        title: `Land on the ×${game.multiplier + 1} tile`,
        body: 'The green tile is the way down. Every floor has one, and dropping a floor multiplies everything you score after it.',
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

  /** @returns true if the notice was actually queued. */
  private push(notice: Notice): boolean {
    if (this.firedThisRun.has(notice.id)) return false;
    const limit = MAX_SHOWS[notice.id] ?? 1;
    if (this.seen.count(notice.id) >= limit) return false;

    this.firedThisRun.add(notice.id);
    this.seen.record(notice.id);
    this.pending.push(notice);
    return true;
  }
}

const EMPTY: Notice[] = [];

// Kept as plain numbers so this module stays free of render-layer imports.
// They match src/render/GlyphAtlas.ts.
const GLYPH_UP = 11;
const GLYPH_TIME = 13;
const GLYPH_BOOST = 14;
const GLYPH_FREEZE = 15;
