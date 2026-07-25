import {
  BOUNCE_TIMING,
  CLOCK,
  FEEL,
  FLOOR,
  FREEZE,
  SCORE,
  TILE_DECAY,
  TIME_TILE_BONUS,
  TileKind,
} from '../core/Config';
import { clamp } from '../core/MathUtil';
import { Rand, randomSeed } from '../core/Rand';
import { Floor } from './Floor';
import { Player, ascendApex, type BounceQuality } from './Player';
import type { Tile } from './Tile';

export type Phase = 'ready' | 'playing' | 'over';

export type GameEvent =
  | { type: 'land'; quality: BounceQuality; kind: TileKind; x: number; z: number; speed: number }
  | {
      type: 'score';
      amount: number;
      value: number;
      multiplier: number;
      combo: number;
      x: number;
      z: number;
    }
  // Both carry the multiplier as it stood *at the moment of the transition*.
  // Consumers drain events after the whole frame has simulated, by which point
  // a later landing may already have changed it again — reading the live value
  // reports the wrong number for the event being handled.
  | { type: 'descend'; depth: number; multiplier: number; x: number; z: number }
  | { type: 'ascend'; depth: number; multiplier: number; x: number; z: number }
  | { type: 'burnout'; count: number }
  | { type: 'gainTime'; amount: number; x: number; z: number }
  | { type: 'boost'; multiplier: number; x: number; z: number }
  | { type: 'freeze'; x: number; z: number }
  | { type: 'endgame' }
  | { type: 'secondTick'; secondsLeft: number }
  | { type: 'gameover'; summary: RunSummary };

export interface RunSummary {
  score: number;
  maxDepth: number;
  descents: number;
  perfects: number;
  bestCombo: number;
  tilesScored: number;
  seed: number;
}

/**
 * Owns the simulation: floors, the player, the clock and the score.
 *
 * Deliberately knows nothing about three.js, the DOM or audio. It advances in
 * fixed steps and emits an event queue that the presentation layers drain. That
 * separation is what makes the feel tuning safe to do late — nothing visual can
 * change what actually happened.
 */
export class GameState {
  phase: Phase = 'ready';
  readonly player = new Player();

  /** Every floor we have generated, indexed by depth. Floors persist. */
  private readonly floors: Floor[] = [];
  private readonly leftFloorAt: number[] = [];

  depth = 0;
  score = 0;
  // Explicitly `number`: Config is `as const`, so inference would pin these to
  // the literal types of their initial values and reject every later write.
  multiplier: number = SCORE.minMultiplier;
  timeLeft: number = CLOCK.matchSeconds;
  freezeLeft = 0;

  /** Wall-clock-equivalent simulation time in seconds since the run started. */
  simTime = 0;

  /** Frozen-time budget remaining, for impact emphasis. */
  hitstop = 0;
  /** Current camera shake energy, decayed each step. */
  shake = 0;

  endgame = false;
  /**
   * The clock is held until the first landing, so the opening drop is time to
   * read the board rather than time being spent. Everyone gets the same grace,
   * so it costs nothing in leaderboard terms.
   */
  private clockStarted = false;
  private lastWholeSecond = Math.ceil(CLOCK.matchSeconds);

  /** The floor currently playing its dissolve-out animation, if any. */
  dissolving: Floor | null = null;
  private dissolveLeft = 0;

  readonly events: GameEvent[] = [];

  private rand = new Rand(1);
  private stats: RunSummary = blankSummary();

  // -- lifecycle -----------------------------------------------------------

  get floor(): Floor {
    return this.floors[this.depth]!;
  }

  /** Geometry of the floor one level down, for the depth-hint wireframe. */
  get previewGeometry(): { side: number; extent: number; y: number } {
    const side = Floor.sideForDepth(this.depth + 1);
    return {
      side,
      extent: Floor.extentForSide(side),
      y: -(this.depth + 1) * FLOOR.floorDrop,
    };
  }

  /**
   * Build a floor and reset the rider without starting the clock.
   *
   * Exists so the title and pause screens have a live world behind them rather
   * than a black void — and so `floor` is never undefined, which it otherwise
   * is for every frame rendered before the first run begins.
   */
  prepareIdle(seed = randomSeed()): void {
    this.start(seed);
    this.phase = 'ready';
    this.events.length = 0;
  }

  /** Advance only the bouncing, for the attract-mode backdrop. */
  stepIdle(dt: number): void {
    if (this.phase !== 'ready') return;
    this.simTime += dt;
    this.floor.update(dt, 0, true);
    // A slow orbit, so the title screen shows the game moving rather than a
    // still frame of it.
    const a = this.simTime * 0.32;
    this.player.step(
      dt,
      this.simTime,
      Math.cos(a) * 0.5,
      Math.sin(a) * 0.5,
      null,
      this.floor.halfExtent,
    );
    this.events.length = 0;
  }

  start(seed = randomSeed()): void {
    this.rand = new Rand(seed);
    this.floors.length = 0;
    this.leftFloorAt.length = 0;
    this.depth = 0;
    this.score = 0;
    this.multiplier = SCORE.minMultiplier;
    this.timeLeft = CLOCK.matchSeconds;
    this.freezeLeft = 0;
    this.simTime = 0;
    this.hitstop = 0;
    this.shake = 0;
    this.endgame = false;
    this.clockStarted = false;
    this.lastWholeSecond = Math.ceil(CLOCK.matchSeconds);
    this.dissolving = null;
    this.dissolveLeft = 0;
    this.events.length = 0;
    this.stats = blankSummary();
    this.stats.seed = seed;

    const centre = Math.floor(Floor.sideForDepth(0) / 2);
    this.floors[0] = new Floor(0, this.rand, centre, centre);
    this.player.reset(this.floors[0]!.y);
    this.phase = 'playing';
  }

  // -- per fixed step ------------------------------------------------------

  /**
   * @param dt fixed step, seconds
   * @param now wall-clock seconds matching this sub-step, for input timing
   * @param steerX/steerZ steering vector, components in [-1, 1]
   * @param bounceAge seconds since the buffered bounce press, or null
   * @returns true if the buffered press was consumed
   */
  step(
    dt: number,
    now: number,
    steerX: number,
    steerZ: number,
    bounceAge: number | null,
  ): boolean {
    if (this.phase !== 'playing') return false;

    // Hitstop eats the step whole. The clock is deliberately included: freezing
    // everything is what makes an impact read as an impact.
    if (this.hitstop > 0) {
      this.hitstop = Math.max(0, this.hitstop - dt);
      return false;
    }

    this.simTime += dt;
    this.shake = Math.max(0, this.shake - this.shake * FEEL.shakeDecay * dt);

    this.advanceClock(dt);
    if (this.phase !== 'playing') return false;

    if (this.freezeLeft > 0) this.freezeLeft = Math.max(0, this.freezeLeft - dt);

    if (this.dissolveLeft > 0) {
      this.dissolveLeft = Math.max(0, this.dissolveLeft - dt);
      if (this.dissolving) {
        this.dissolving.dissolve = 1 - this.dissolveLeft / FLOOR.dissolveTime;
      }
      if (this.dissolveLeft === 0) this.dissolving = null;
    }

    const decayScale = this.endgame ? TILE_DECAY.endgameScale : 1;
    const burned = this.floor.update(dt, decayScale, this.freezeLeft > 0);
    if (burned > 0) this.events.push({ type: 'burnout', count: burned });

    const landing = this.player.step(
      dt,
      now,
      steerX,
      steerZ,
      bounceAge,
      this.floor.halfExtent,
    );
    const consumed = this.player.consumedBounceInput;

    if (landing) this.resolveLanding(landing.x, landing.z, landing.impactSpeed, landing.quality);

    return consumed;
  }

  private advanceClock(dt: number): void {
    if (!this.clockStarted) return;
    this.timeLeft -= dt;

    const whole = Math.ceil(this.timeLeft);
    if (whole < this.lastWholeSecond && whole >= 0) {
      this.lastWholeSecond = whole;
      this.events.push({ type: 'secondTick', secondsLeft: whole });
    }

    if (!this.endgame && this.timeLeft <= CLOCK.endgameSeconds) {
      this.endgame = true;
      this.events.push({ type: 'endgame' });
    }

    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      this.finish();
    }
  }

  private finish(): void {
    this.phase = 'over';
    this.stats.score = Math.floor(this.score);
    this.events.push({ type: 'gameover', summary: { ...this.stats } });
  }

  // -- landing resolution --------------------------------------------------

  private resolveLanding(x: number, z: number, speed: number, quality: BounceQuality): void {
    this.clockStarted = true;
    const floor = this.floor;
    const tile = floor.tileAtWorld(x, z);
    tile.flash = 1;

    this.events.push({ type: 'land', quality, kind: tile.kind, x, z, speed });
    this.addShake(quality === 'perfect' ? FEEL.shakeOnPerfect : FEEL.shakeOnLand);
    if (quality === 'perfect') {
      this.hitstop = Math.max(this.hitstop, FEEL.hitstopPerfect);
      this.stats.perfects++;
      this.stats.bestCombo = Math.max(this.stats.bestCombo, this.player.perfectStreak);
    }

    switch (tile.kind) {
      case TileKind.Number:
        this.scoreTile(tile, x, z);
        break;
      case TileKind.Down:
        this.descend(x, z);
        break;
      case TileKind.Up:
        this.ascend(x, z, tile);
        break;
      case TileKind.Time:
        this.gainTime(tile, x, z);
        break;
      case TileKind.Boost:
        this.applyBoost(tile, x, z);
        break;
      case TileKind.Freeze:
        this.applyFreeze(tile, x, z);
        break;
      case TileKind.Spent:
      default:
        break;
    }
  }

  private get comboMultiplier(): number {
    return 1 + Math.min(this.player.perfectStreak, SCORE.comboCap) * SCORE.comboStep;
  }

  private scoreTile(tile: Tile, x: number, z: number): void {
    const combo = this.comboMultiplier;
    const amount = tile.value * this.multiplier * combo;
    this.score += amount;
    this.stats.tilesScored++;

    this.events.push({
      type: 'score',
      amount,
      value: tile.value,
      multiplier: this.multiplier,
      combo,
      x,
      z,
    });

    // Spent, not removed: a dead tile still has to be navigated around, which
    // keeps the board shrinking in a way the player can see and plan for.
    tile.kind = TileKind.Spent;
    tile.value = 0;
  }

  private descend(x: number, z: number): void {
    const leaving = this.floor;
    this.leftFloorAt[this.depth] = this.simTime;

    // The tile you bounced off takes the whole floor with it — but only after
    // the bounce, so you launch from solid ground and then watch it go.
    leaving.dissolve = 0;
    leaving.dissolveOrigin = { x, z };
    this.dissolving = leaving;
    this.dissolveLeft = FLOOR.dissolveTime;

    this.depth++;
    this.multiplier += SCORE.multiplierPerDepth;
    this.stats.descents++;
    this.stats.maxDepth = Math.max(this.stats.maxDepth, this.depth);

    const bonus = SCORE.descendBonus * this.multiplier;
    this.score += bonus;

    this.ensureFloor(this.depth, x, z);
    this.player.setFloorY(this.floor.y);

    this.hitstop = Math.max(this.hitstop, FEEL.hitstopDescend);
    this.addShake(FEEL.shakeOnDescend);
    this.events.push({ type: 'descend', depth: this.depth, multiplier: this.multiplier, x, z });
  }

  private ascend(x: number, z: number, tile: Tile): void {
    if (this.depth === 0) {
      // Nothing above the surface. The bounce is simply wasted, which is
      // punishment enough at a multiplier that cannot go lower.
      tile.kind = TileKind.Spent;
      this.player.launchToApex(ascendApex() * 0.5);
      this.addShake(FEEL.shakeOnAscend * 0.5);
      this.events.push({ type: 'ascend', depth: 0, multiplier: this.multiplier, x, z });
      return;
    }

    this.leftFloorAt[this.depth] = this.simTime;
    this.depth--;
    this.multiplier = Math.max(SCORE.minMultiplier, this.multiplier - SCORE.multiplierPerDepth);

    this.ensureFloor(this.depth, x, z);
    this.player.setFloorY(this.floor.y);
    // Big launch: the floor above is a whole storey up, so an UP tile has to
    // throw you clear of it rather than merely bounce you.
    this.player.launchToApex(ascendApex());

    this.hitstop = Math.max(this.hitstop, FEEL.hitstopAscend);
    this.addShake(FEEL.shakeOnAscend);
    this.events.push({ type: 'ascend', depth: this.depth, multiplier: this.multiplier, x, z });
  }

  private gainTime(tile: Tile, x: number, z: number): void {
    this.timeLeft = Math.min(CLOCK.maxSeconds, this.timeLeft + TIME_TILE_BONUS);
    this.lastWholeSecond = Math.ceil(this.timeLeft);
    if (this.endgame && this.timeLeft > CLOCK.endgameSeconds) this.endgame = false;
    tile.kind = TileKind.Spent;
    this.events.push({ type: 'gainTime', amount: TIME_TILE_BONUS, x, z });
  }

  private applyBoost(tile: Tile, x: number, z: number): void {
    this.multiplier += 1;
    tile.kind = TileKind.Spent;
    this.events.push({ type: 'boost', multiplier: this.multiplier, x, z });
  }

  private applyFreeze(tile: Tile, x: number, z: number): void {
    this.freezeLeft = Math.max(this.freezeLeft, FREEZE.duration);
    tile.kind = TileKind.Spent;
    this.events.push({ type: 'freeze', x, z });
  }

  // -- floors --------------------------------------------------------------

  /**
   * Floors persist for the whole run rather than being regenerated on arrival.
   *
   * That matters for balance: if the floor above were rebuilt fresh, an UP tile
   * would hand you a board full of nines in exchange for one multiplier — often
   * a net gain, which would invert the entire risk structure. Instead the floor
   * you return to is the floor you left, aged by exactly how long you were
   * away. Going up is unambiguously bad, and "the surface has rotted while I
   * was down here" is a better story anyway.
   */
  private ensureFloor(depth: number, entryX: number, entryZ: number): void {
    const existing = this.floors[depth];
    if (existing) {
      // Ageing while away is capped: coming back to a floor should feel like
      // time passed, not like the floor died without you.
      const away = Math.min(
        TILE_DECAY.maxAwaySeconds,
        this.simTime - (this.leftFloorAt[depth] ?? this.simTime),
      );
      if (away > 0) this.catchUpDecay(existing, away);
      // Clear any leftover drop-through state before it becomes active again.
      if (this.dissolving === existing) {
        this.dissolving = null;
        this.dissolveLeft = 0;
      }
      existing.restore(this.rand);
      return;
    }
    const probe = new Floor(depth, this.rand, 0, 0);
    const gx = probe.gridX(entryX);
    const gy = probe.gridY(entryZ);
    this.floors[depth] = new Floor(depth, this.rand, gx, gy);
  }

  /** Apply the decay a floor would have accumulated while we were elsewhere. */
  private catchUpDecay(floor: Floor, seconds: number): void {
    if (!TILE_DECAY.enabled) return;
    let burned = 0;
    let upCount = floor.countUp();
    const upCeiling = Math.floor(floor.tiles.length * TILE_DECAY.maxUpFraction);

    for (const tile of floor.tiles) {
      if (tile.kind !== TileKind.Number) continue;
      let timer = tile.decayTimer - seconds;
      while (timer <= 0 && tile.value > 0) {
        tile.value--;
        timer += TILE_DECAY.interval;
        if (tile.value <= 0) {
          const asHazard = TILE_DECAY.burnout && upCount < upCeiling;
          tile.kind = asHazard ? TileKind.Up : TileKind.Spent;
          if (asHazard) upCount++;
          tile.value = 0;
          tile.burned = true;
          burned++;
          break;
        }
      }
      tile.decayTimer = Math.max(0.05, timer);
    }

    if (burned > 0) this.events.push({ type: 'burnout', count: burned });
  }

  // -- helpers -------------------------------------------------------------

  addShake(amount: number): void {
    this.shake = clamp(this.shake + amount, 0, 1.6);
  }

  /** Seconds of buffered press that are still worth keeping. */
  get inputBufferSeconds(): number {
    return BOUNCE_TIMING.inputBuffer;
  }

  get summary(): RunSummary {
    return { ...this.stats, score: Math.floor(this.score) };
  }

  drainEvents(sink: (e: GameEvent) => void): void {
    for (const e of this.events) sink(e);
    this.events.length = 0;
  }
}

function blankSummary(): RunSummary {
  return {
    score: 0,
    maxDepth: 0,
    descents: 0,
    perfects: 0,
    bestCombo: 0,
    tilesScored: 0,
    seed: 0,
  };
}
