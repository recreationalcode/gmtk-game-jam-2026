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
  /** Seconds on screen. Omitted means "derive it from the length". */
  holdSeconds?: number;
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
/** Below this share of number tiles, a floor counts as picked clean. */
const STUCK_SCORING_FRACTION = 0.06;

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
  /** Tile kinds already introduced this run. */
  private readonly kindsSeen = new Set<TileKind>();

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
    this.kindsSeen.clear();
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
          title: 'That one ran out',
          body: "Every number is counting down. When one hits zero it turns red and starts bouncing you the wrong way. Grab them while they're big.",
          glyph: GLYPH_UP,
          tone: 'warn',
          priority: 50,
        });
        break;

      case 'gainTime':
        this.push({
          id: 'tile:time',
          title: `+${TIME_TILE_BONUS} seconds!`,
          body: 'Clock tiles are the only way to buy yourself more time. Never walk past one.',
          glyph: GLYPH_TIME,
          tone: 'good',
          priority: 70,
        });
        break;

      case 'boost':
        this.push({
          id: 'tile:boost',
          title: 'Multiplier up!',
          body: 'Boost tiles bump you up without making you find the way down. Free money.',
          glyph: GLYPH_BOOST,
          tone: 'good',
          priority: 70,
        });
        break;

      case 'freeze':
        this.push({
          id: 'tile:freeze',
          title: 'Everything just froze!',
          body: `Nothing counts down for ${FREEZE.duration} seconds. Go and clean up.`,
          glyph: GLYPH_FREEZE,
          tone: 'good',
          priority: 70,
        });
        break;

      case 'endgame':
        this.push({
          id: 'event:endgame',
          title: `${CLOCK.endgameSeconds} seconds left!`,
          body: "Numbers are draining twice as fast now. Forget the plan, grab whatever is closest.",
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
      return `Bigger board, smaller tiles, and every number down here scores ×${multiplier}. This is how you win.`;
    }
    if (this.seen.count('event:multiplier') < 3) {
      return `Numbers are worth ×${multiplier} now. Going deeper always beats hanging around.`;
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
        title: 'Red means up',
        body: "Those throw you back a floor and take a multiplier with them. You're on the top floor so that one was free. Call it a warning.",
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
      title: `Ouch, back to ×${multiplier}`,
      body: `A red tile threw you up a floor and took a multiplier with it. Everything scores ×${multiplier} until you win it back. Green tile, go.`,
      multiplier,
      tone: 'warn',
      priority: 82,
    });

    // Never both at once. They are about the same bounce, and the queue would
    // spend seven seconds of a sixty-second run explaining it.
    if (lost) return;
    this.push({
      id: 'tip:reset',
      title: 'The floor refilled',
      body: 'Leave a floor and its numbers come back fresh. Anything that had run out is worth points again.',
      tone: 'info',
      priority: 55,
    });
  }

  /**
   * Polled conditions — things defined by an *absence* of player action.
   *
   * @param notifierBusy whether a notice is already showing or queued. The one
   * piece of presentation state this class takes, and it earns its place: a
   * discovery landing on top of a descent's fanfare makes two toasts out of one
   * moment. Expressed as "wait until the player has capacity" rather than as a
   * timer, because a timer here would have to be told which clock it is on —
   * the simulated one runs at a tenth speed while a notice is up, which is
   * exactly when this matters.
   */
  update(dt: number, game: GameState, notifierBusy = false): void {
    const first = this.runTime === 0;
    this.runTime += dt;

    // The objective, before anything else. It fits in the opening drop, which
    // is dead time the clock is not even counting yet.
    if (first) {
      this.push({
        id: 'intro:objective',
        title: `Grab as many points as you can in ${Math.round(CLOCK.matchSeconds)} seconds`,
        body: "Bounce on the numbers. That's the whole game.",
        // Short on purpose. It is the one notice that fires before the player
        // has done anything, so it is the one most in the way — and the way
        // down gets its own notice a few seconds later anyway.
        holdSeconds: 3,
        tone: 'info',
        priority: 100,
      });
    }

    // Never teach during the endgame; it is already the busiest the game gets.
    if (game.endgame) return;

    if (!notifierBusy) this.announceNewTiles(game);

    const stillNoTimedPress = this.timedPresses === 0;
    const strandedBelow =
      this.descended && this.runTime > CHARGE_HINT_AFTER_SECONDS_BELOW_SURFACE;
    if (stillNoTimedPress && (this.landings >= CHARGE_HINT_AFTER_LANDINGS || strandedBelow)) {
      this.push({
        id: 'tip:charge',
        title: 'Try clicking as you land',
        body: this.touchMode
          ? 'Hold and drag to aim, then let go just as you touch down. Time it right and you bounce higher and reach further.'
          : 'Click or hit Space just as you touch down. Time it right and you bounce higher and reach further.',
        tone: 'info',
        priority: 90,
      });
    }

    if (this.chargedBounces >= PERFECT_HINT_AFTER_CHARGED && this.perfects === 0) {
      this.push({
        id: 'tip:perfect',
        title: 'Now go for a PERFECT',
        body: this.touchMode
          ? 'Let go the instant the ring closes onto the tile. Perfects chain into a combo, and the combo is where the big scores hide.'
          : 'Click the instant the ring closes onto the tile. Perfects chain into a combo, and the combo is where the big scores hide.',
        tone: 'info',
        priority: 85,
      });
    }

    const stuckOnSurface =
      this.runTime > DOWN_HINT_AFTER_SECONDS || this.surfaceUps >= DOWN_HINT_AFTER_SURFACE_UPS;
    if (!this.descended && stuckOnSurface) {
      this.push({
        id: 'tile:down',
        title: `Go find the ×${game.multiplier + 1} tile`,
        body: "The green one is your way down. Every floor has exactly one, and dropping a floor makes everything below worth more.",
        multiplier: game.multiplier + 1,
        tone: 'info',
        priority: 95,
      });
    }

    // A floor with almost nothing left on it is a floor to leave.
    //
    // Judged as a fraction, not as zero. A deep floor spawns forty-odd number
    // tiles and resets whenever you leave it, so "not one left" essentially
    // never happened and this tip was unreachable in practice.
    if (this.descended && TILE_DECAY.enabled) {
      const floor = game.floor;
      let scoring = 0;
      for (const t of floor.tiles) if (t.kind === TileKind.Number) scoring++;
      if (scoring <= Math.max(1, Math.floor(floor.tiles.length * STUCK_SCORING_FRACTION))) {
        this.push({
          id: 'tip:stuck',
          title: 'Nothing left up here',
          body: "You've picked this floor clean. Take the way down, the next one is untouched.",
          tone: 'info',
          priority: 65,
        });
      }
    }
  }

  /**
   * Introduce a tile kind the first time it is *on the board*, not the first
   * time it is landed on.
   *
   * These used to fire from the gainTime/boost/freeze events, which meant the
   * player found out what a TIME tile was only after already having used one —
   * exactly backwards for tiles whose whole purpose is to be spotted and
   * detoured toward. The use-events keep the same ids, so they now act as a
   * fallback for the case where somebody lands on one before the notice lands.
   */
  private announceNewTiles(game: GameState): void {
    if (this.kindsSeen.size >= DISCOVERABLE.length) return;

    for (const tile of game.floor.tiles) {
      if (this.kindsSeen.has(tile.kind)) continue;
      const build = DISCOVERIES[tile.kind];
      if (!build) continue;
      this.kindsSeen.add(tile.kind);
      this.push(build());
      // One at a time. A floor carrying all three would otherwise queue three
      // toasts at once, and the player meets them as a wall rather than as
      // three separate discoveries.
      return;
    }
  }

  /**
   * Spend a notice's lifetime budget — called when it actually reaches the
   * screen, not when it is queued.
   *
   * Those are not the same moment, and conflating them quietly destroyed most
   * of this system. The queue is cleared on pause, on quitting to the title and
   * on game over, so any notice queued in the last second of a run — or while
   * the player tabbed away — was marked as taught without ever being displayed.
   * Most budgets are one, so that was permanent: the tip could never appear
   * again on that device.
   */
  markPresented(id: string): void {
    this.seen.record(id);
  }

  /**
   * Whether a rule has fired this run, regardless of whether the notice has
   * reached the screen yet. Read by the headless tests, which previously used
   * the seen-store for this and can no longer: that now records *display*, and
   * a rule firing and its notice being shown are several seconds apart.
   */
  hasFired(id: string): boolean {
    return this.firedThisRun.has(id);
  }

  /** @returns true if the notice was actually queued. */
  private push(notice: Notice): boolean {
    if (this.firedThisRun.has(notice.id)) return false;
    const limit = MAX_SHOWS[notice.id] ?? 1;
    if (this.seen.count(notice.id) >= limit) return false;

    // Only the within-run guard is set here. The persistent count is spent by
    // `markPresented`, once the notice has actually been shown.
    this.firedThisRun.add(notice.id);
    this.pending.push(notice);
    return true;
  }
}

const EMPTY: Notice[] = [];

/**
 * Tiles worth introducing on sight.
 *
 * Only the specials. DOWN and UP are on the board from the first second and are
 * learned within a bounce or two of playing; announcing them at t=0 would be
 * the wall of text this system exists to avoid. These three are rare, unlock
 * with depth, and are worth going out of your way for — which you cannot do if
 * you do not know they are there.
 */
const DISCOVERIES: Partial<Record<TileKind, () => Notice>> = {
  [TileKind.Time]: () => ({
    id: 'tile:time',
    title: `Clock tile, +${TIME_TILE_BONUS} seconds`,
    body: "There's one on this floor. Time is the only thing you truly run out of, so go out of your way for it.",
    glyph: GLYPH_TIME,
    tone: 'good',
    priority: 72,
  }),
  [TileKind.Boost]: () => ({
    id: 'tile:boost',
    title: 'Boost tile',
    body: 'Land on it and your multiplier jumps, no descending needed. Take every one you see.',
    glyph: GLYPH_BOOST,
    tone: 'good',
    priority: 72,
  }),
  [TileKind.Freeze]: () => ({
    id: 'tile:freeze',
    title: 'Freeze tile',
    body: `Stops every countdown on the board for ${FREEZE.duration} seconds. Land on it, then help yourself.`,
    glyph: GLYPH_FREEZE,
    tone: 'good',
    priority: 72,
  }),
};

const DISCOVERABLE = Object.keys(DISCOVERIES);

// Kept as plain numbers so this module stays free of render-layer imports.
// They match src/render/GlyphAtlas.ts.
const GLYPH_UP = 11;
const GLYPH_TIME = 13;
const GLYPH_BOOST = 14;
const GLYPH_FREEZE = 15;
