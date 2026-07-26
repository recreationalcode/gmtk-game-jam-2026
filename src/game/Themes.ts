import { TileKind } from '../core/Config';
import type { Rand } from '../core/Rand';

/**
 * What kind of floor you have just dropped onto.
 *
 * Every floor used to be the same floor with more tiles on it: one mix, scaled
 * by depth. That makes descending a quantitative decision — the same board,
 * worth more — when it should be a qualitative one. A theme gives each floor a
 * shape you can read at a glance from the top of the arc and plan against
 * before you commit to a landing.
 *
 * Themes are picked with cooldowns rather than pure weights, so the run reads
 * as a *sequence* rather than as noise: two hazard floors back to back is
 * unfair rather than hard, and two bounty floors in a row spends the surprise.
 */
export type FloorTheme =
  | 'default'
  | 'numbers'
  | 'hazard'
  | 'bounty'
  | 'revealTime'
  | 'revealBoost'
  | 'revealFreeze';

export interface ThemeMix {
  /** Shown in the dev floor dump; not surfaced in game. */
  label: string;
  /** Share of the floor that spawns as UP tiles. */
  up: number;
  /** Share that spawns as a powerup, if any are unlocked. */
  powerup: number;
  /**
   * Powerups this theme may spawn, in preference order. Empty means "anything
   * unlocked at this depth". A named list is still filtered by the unlock
   * depths unless `ignoreUnlocks` is set.
   */
  kinds: readonly TileKind[];
  /**
   * Spawn `kinds` whatever the depth. True only for reveal floors — that is
   * exactly what makes one a reveal.
   *
   * It must be false everywhere else, or the ordering falls apart: a "high
   * numbers" floor at depth 4 favours freeze, and without this it would hand
   * the player a freeze tile three floors before the one that exists to explain
   * what freeze is.
   */
  ignoreUnlocks: boolean;
  /** Extra weight given to `kinds[0]` within the powerup share. */
  favour: number;
  /**
   * Extra copies of the top values added to the spawn bag. Raises the average
   * number without narrowing the range — a floor of nothing but nines has
   * nothing to choose between, which is the opposite of the point.
   */
  valueBias: number;
  /** Floors that must pass before this theme can be picked again. */
  cooldown: number;
  /** Base selection weight. `default` is the remainder and is never rolled. */
  weight: number;
  /** Added to `weight` per floor of depth. */
  weightPerDepth: number;
  /** Ceiling on the depth-scaled weight. */
  weightCap: number;
  /**
   * Guaranteed minimum of `kinds[0]`, as a share of the floor. A reveal floor
   * that rolls none of the tile it exists to reveal is a broken promise, and
   * "unlikely" is not the same as "cannot".
   */
  guarantee: number;
  /**
   * Whether leaving this floor restores its numbers.
   *
   * True for ordinary floors — decay is meant to be pressure while you stand on
   * one, not permanent damage to the run. False for reveal floors, which are
   * deliberately generous: a board stacked with one powerup is a fine reward
   * for arriving and a farm if you can refresh it by bouncing up and back.
   */
  resetsOnLeave: boolean;
}

/**
 * The default mix is the one the player sees most, and it is deliberately
 * hostile: half the board sends you back up. Descending is meant to be a real
 * decision, and it is not one if the floor below is simply free points.
 */
export const THEMES: Record<FloorTheme, ThemeMix> = {
  default: {
    label: 'default',
    up: 0.5,
    powerup: 0.1,
    kinds: [],
    ignoreUnlocks: false,
    favour: 0,
    valueBias: 0,
    cooldown: 0,
    weight: 0,
    weightPerDepth: 0,
    weightCap: 0,
    guarantee: 0,
    resetsOnLeave: true,
  },

  /**
   * A farm. Big numbers, few hazards, and freeze weighted heavily inside the
   * powerup share — freeze is worth little on a sparse board and enormous on
   * this one, so the two belong together.
   */
  numbers: {
    label: 'numbers',
    up: 0.25,
    powerup: 0.1,
    kinds: [TileKind.Freeze, TileKind.Time, TileKind.Boost],
    ignoreUnlocks: false,
    favour: 3,
    valueBias: 2,
    cooldown: 4,
    weight: 0.24,
    weightPerDepth: 0,
    weightCap: 0.24,
    guarantee: 0,
    resetsOnLeave: true,
  },

  /** A minefield. Gets likelier the deeper you are, never twice in a row. */
  hazard: {
    label: 'hazard',
    up: 0.68,
    powerup: 0.07,
    kinds: [],
    ignoreUnlocks: false,
    favour: 0,
    valueBias: 0,
    cooldown: 3,
    weight: 0.08,
    weightPerDepth: 0.022,
    weightCap: 0.32,
    guarantee: 0,
    resetsOnLeave: true,
  },

  /**
   * A payday. Never freeze: freeze buys time to farm, and this floor has
   * little to farm — the two read as a contradiction when they land together.
   */
  bounty: {
    label: 'bounty',
    up: 0.35,
    powerup: 0.35,
    kinds: [TileKind.Time, TileKind.Boost],
    ignoreUnlocks: false,
    favour: 0,
    valueBias: 0,
    cooldown: 5,
    weight: 0.07,
    weightPerDepth: 0,
    weightCap: 0.07,
    guarantee: 0,
    resetsOnLeave: true,
  },

  // Reveal floors. Enough of one powerup that it cannot be missed, and nothing
  // else competing for the eye, because a tile that explains itself is only
  // useful if the player is looking at one when it does.
  revealTime: {
    label: 'reveal:time',
    up: 0.3,
    powerup: 0.22,
    kinds: [TileKind.Time],
    ignoreUnlocks: true,
    favour: 0,
    valueBias: 0,
    cooldown: 0,
    weight: 0,
    weightPerDepth: 0,
    weightCap: 0,
    guarantee: 0.1,
    resetsOnLeave: false,
  },
  revealBoost: {
    label: 'reveal:boost',
    up: 0.3,
    powerup: 0.22,
    kinds: [TileKind.Boost],
    ignoreUnlocks: true,
    favour: 0,
    valueBias: 0,
    cooldown: 0,
    weight: 0,
    weightPerDepth: 0,
    weightCap: 0,
    guarantee: 0.1,
    resetsOnLeave: false,
  },
  revealFreeze: {
    label: 'reveal:freeze',
    up: 0.3,
    powerup: 0.22,
    kinds: [TileKind.Freeze],
    ignoreUnlocks: true,
    favour: 0,
    valueBias: 0,
    cooldown: 0,
    weight: 0,
    weightPerDepth: 0,
    weightCap: 0,
    guarantee: 0.1,
    resetsOnLeave: false,
  },
};

/**
 * No themed floor before this depth.
 *
 * The opening three floors are where a player learns to bounce, to read the
 * board and to find the way down, and depth 3 is the first reveal. Dealing them
 * a hazard floor in the middle of that teaches the wrong lesson — and a themed
 * floor means nothing to someone who has not yet seen the default to contrast
 * it against.
 */
export const FIRST_THEMED_DEPTH = 4;

/**
 * Depths that introduce a powerup, one at a time and always in this order.
 *
 * After the second floor, so the opening is about learning to bounce and find
 * the way down rather than about a wall of new tile types — and spaced, so each
 * introduction lands on its own.
 */
export const REVEAL_FLOORS: ReadonlyMap<number, FloorTheme> = new Map([
  [3, 'revealTime'],
  [5, 'revealBoost'],
  [7, 'revealFreeze'],
]);

/**
 * The first floors are gentler than the default mix, and the very first has no
 * hazards at all.
 *
 * Half a board of hazards is the right steady state and the wrong first
 * impression. Floor 0 is where a player learns that landing does something, and
 * it cannot teach that if some landings undo themselves — every tile there
 * either scores or takes you down. The scale eases in over the next two floors
 * rather than switching on.
 */
const OPENING_HAZARD_SCALE: readonly number[] = [0, 0.5, 0.78];

export function hazardScaleForDepth(depth: number): number {
  return OPENING_HAZARD_SCALE[depth] ?? 1;
}

/**
 * Picks a theme per floor, remembering what it has recently used.
 *
 * Lives here rather than in `Floor` because a floor cannot know what the last
 * three floors were, and cooldowns are the whole reason this reads as a
 * sequence rather than as a slot machine.
 */
export class ThemeDirector {
  /** Depth at which each theme was last used, for cooldowns. */
  private readonly lastUsed = new Map<FloorTheme, number>();

  reset(): void {
    this.lastUsed.clear();
  }

  pick(depth: number, rand: Rand): FloorTheme {
    const reveal = REVEAL_FLOORS.get(depth);
    if (reveal) {
      this.lastUsed.set(reveal, depth);
      return reveal;
    }

    if (depth < FIRST_THEMED_DEPTH) return 'default';

    const candidates: Array<{ theme: FloorTheme; weight: number }> = [];
    for (const [name, mix] of Object.entries(THEMES) as Array<[FloorTheme, ThemeMix]>) {
      if (mix.weight <= 0 && mix.weightPerDepth <= 0) continue;
      const since = depth - (this.lastUsed.get(name) ?? -Infinity);
      if (since <= mix.cooldown) continue;
      candidates.push({
        theme: name,
        weight: Math.min(mix.weightCap, mix.weight + mix.weightPerDepth * depth),
      });
    }

    const roll = rand.next();
    let acc = 0;
    for (const c of candidates) {
      acc += c.weight;
      if (roll < acc) {
        this.lastUsed.set(c.theme, depth);
        return c.theme;
      }
    }
    // Everything else is the default floor, which has no cooldown — it is the
    // baseline the other themes are deviations from, not a theme in its own
    // right, so repeating it is not repetition.
    return 'default';
  }
}
