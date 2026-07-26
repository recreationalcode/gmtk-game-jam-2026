import {
  FLOOR,
  SPAWN_MIX,
  SPECIAL_UNLOCK_DEPTH,
  TILE_DECAY,
  TILE_VALUES,
  TileKind,
} from '../core/Config';
import type { Rand } from '../core/Rand';
import { chebyshev, clamp } from '../core/MathUtil';
import type { Tile } from './Tile';

/**
 * One floor of tiles.
 *
 * Grid geometry is derived, never stored twice: `side` drives `extent`, which
 * drives `pitch` and `tileSize`. Extent grows more slowly than side, so deeper
 * floors have more tiles *and* smaller ones — the difficulty ramp is a
 * consequence of the layout rule rather than a separate difficulty system.
 */
export class Floor {
  readonly depth: number;
  readonly side: number;
  readonly extent: number;
  readonly pitch: number;
  readonly tileSize: number;
  readonly y: number;
  readonly tiles: Tile[] = [];

  /** Drives the dissolve animation; 1 while the floor is live. */
  dissolve = 0;
  dissolveOrigin: { x: number; z: number } | null = null;

  /**
   * Shuffled bag of spawn values, dealt from rather than rolled independently.
   *
   * Independent rolls over a 4-wide band clump badly at this sample size: a
   * 5×5 floor routinely came up with three or four of one digit and none of
   * another, which reads as "they're all the same number" even though the draw
   * was fair. A bag guarantees every value in the band appears before any
   * repeats, so the board looks deliberately varied instead of merely random.
   */
  private readonly valueBag: number[] = [];

  constructor(depth: number, rand: Rand, entryGX: number, entryGY: number) {
    this.depth = depth;
    this.side = Floor.sideForDepth(depth);
    this.extent = Floor.extentForSide(this.side);
    this.pitch = this.extent / this.side;
    this.tileSize = this.pitch * (1 - FLOOR.gapRatio);
    this.y = -depth * FLOOR.floorDrop;

    this.generate(rand, entryGX, entryGY);
  }

  static sideForDepth(depth: number): number {
    return Math.min(FLOOR.maxSide, FLOOR.baseSide + Math.round(depth * FLOOR.sideGrowth));
  }

  static extentForSide(side: number): number {
    return FLOOR.baseExtent * Math.pow(side / FLOOR.baseSide, FLOOR.extentExponent);
  }

  // -- geometry ------------------------------------------------------------

  worldX(gx: number): number {
    return (gx + 0.5) * this.pitch - this.extent / 2;
  }

  worldZ(gy: number): number {
    return (gy + 0.5) * this.pitch - this.extent / 2;
  }

  gridX(worldX: number): number {
    return clamp(Math.floor((worldX + this.extent / 2) / this.pitch), 0, this.side - 1);
  }

  gridY(worldZ: number): number {
    return clamp(Math.floor((worldZ + this.extent / 2) / this.pitch), 0, this.side - 1);
  }

  /** Half-width of the playable area, minus a little so you can't perch on the rim. */
  get halfExtent(): number {
    return this.extent / 2 - this.pitch * 0.08;
  }

  index(gx: number, gy: number): number {
    return gy * this.side + gx;
  }

  at(gx: number, gy: number): Tile | undefined {
    if (gx < 0 || gy < 0 || gx >= this.side || gy >= this.side) return undefined;
    return this.tiles[this.index(gx, gy)];
  }

  tileAtWorld(worldX: number, worldZ: number): Tile {
    return this.tiles[this.index(this.gridX(worldX), this.gridY(worldZ))]!;
  }

  // -- generation ----------------------------------------------------------

  private generate(rand: Rand, entryGX: number, entryGY: number): void {
    const count = this.side * this.side;
    const specials = this.unlockedSpecials();

    for (let i = 0; i < count; i++) {
      const gx = i % this.side;
      const gy = Math.floor(i / this.side);
      const kind = this.rollKind(rand, specials);
      const tile: Tile = {
        kind,
        value: kind === TileKind.Number ? this.dealValue(rand) : 0,
        gx,
        gy,
        decayTimer: 0,
        decayEvery: TILE_DECAY.interval,
        alive: 0,
        flash: 0,
        justBurnedOut: false,
        burned: false,
      };
      this.startClock(tile, rand);
      this.tiles.push(tile);
    }

    this.placeDownTiles(rand, entryGX, entryGY);
    this.guaranteeSomeScoring(rand, entryGX, entryGY);
  }

  /** Lowest value a number tile spawns with on this floor. */
  minSpawnValue(): number {
    // Clamped to keep a spread: the depth ramp may raise the floor of the
    // range, but never far enough to squeeze out the variety.
    return clamp(
      Math.round(TILE_VALUES.minSpawn + this.depth * TILE_VALUES.minSpawnPerDepth),
      1,
      TILE_VALUES.maxSpawn - TILE_VALUES.minSpread,
    );
  }

  /**
   * Next spawn value, dealt from a shuffled bag that refills when empty. See
   * `valueBag` for why this is not just `rand.int(min, max)`.
   */
  private dealValue(rand: Rand): number {
    if (this.valueBag.length === 0) {
      for (let v = this.minSpawnValue(); v <= TILE_VALUES.maxSpawn; v++) this.valueBag.push(v);
      rand.shuffle(this.valueBag);
    }
    return this.valueBag.pop()!;
  }

  /**
   * Give a tile its own countdown clock: a slightly different rate, and a first
   * tick placed anywhere within it.
   */
  private startClock(tile: Tile, rand: Rand): void {
    tile.decayEvery =
      TILE_DECAY.interval *
      rand.range(1 - TILE_DECAY.intervalJitter, 1 + TILE_DECAY.intervalJitter);
    // Floored well above zero so a tile never spawns already mid-tick.
    tile.decayTimer =
      tile.decayEvery * rand.range(Math.max(0.08, 1 - TILE_DECAY.phaseJitter), 1);
  }

  private unlockedSpecials(): Array<{ kind: TileKind; weight: number }> {
    const out: Array<{ kind: TileKind; weight: number }> = [];
    if (this.depth >= SPECIAL_UNLOCK_DEPTH[TileKind.Time]) {
      out.push({ kind: TileKind.Time, weight: SPAWN_MIX.timeWeight });
    }
    if (this.depth >= SPECIAL_UNLOCK_DEPTH[TileKind.Boost]) {
      out.push({ kind: TileKind.Boost, weight: SPAWN_MIX.boostWeight });
    }
    if (this.depth >= SPECIAL_UNLOCK_DEPTH[TileKind.Freeze]) {
      out.push({ kind: TileKind.Freeze, weight: SPAWN_MIX.freezeWeight });
    }
    return out;
  }

  private rollKind(rand: Rand, specials: Array<{ kind: TileKind; weight: number }>): TileKind {
    const specialShare = Math.max(0, 1 - SPAWN_MIX.number - SPAWN_MIX.up);
    const roll = rand.next();
    if (roll < SPAWN_MIX.number) return TileKind.Number;
    if (roll < SPAWN_MIX.number + SPAWN_MIX.up) return TileKind.Up;
    if (specials.length === 0 || specialShare <= 0) return TileKind.Number;
    const pick = rand.weighted(specials.map((s) => s.weight));
    return pick < 0 ? TileKind.Number : specials[pick]!.kind;
  }

  /**
   * Down tiles are placed rather than rolled, so their count is exact and they
   * are never adjacent to where the player arrives — descending always costs at
   * least one real traversal.
   */
  private placeDownTiles(rand: Rand, entryGX: number, entryGY: number): void {
    const wanted = SPAWN_MIX.downTiles(this.depth);
    const candidates: number[] = [];
    const fallback: number[] = [];

    for (let gy = 0; gy < this.side; gy++) {
      for (let gx = 0; gx < this.side; gx++) {
        const idx = this.index(gx, gy);
        const dist = chebyshev(gx, gy, entryGX, entryGY);
        if (dist > SPAWN_MIX.downMinDistanceFromEntry) candidates.push(idx);
        else if (dist > 0) fallback.push(idx);
      }
    }

    rand.shuffle(candidates);
    rand.shuffle(fallback);
    const pool = candidates.length >= wanted ? candidates : candidates.concat(fallback);
    const placed: number[] = [];

    for (const idx of pool) {
      if (placed.length >= wanted) break;
      // Keep multiple down tiles apart so they don't read as one blob.
      const gx = idx % this.side;
      const gy = Math.floor(idx / this.side);
      const tooClose = placed.some((p) =>
        chebyshev(gx, gy, p % this.side, Math.floor(p / this.side)) < 2,
      );
      if (tooClose) continue;
      this.tiles[idx]!.kind = TileKind.Down;
      this.tiles[idx]!.value = 0;
      placed.push(idx);
    }

    // Degenerate tiny grids: force at least one down tile somewhere.
    if (placed.length === 0 && this.tiles.length > 1) {
      const idx = this.index(entryGX, entryGY) === 0 ? this.tiles.length - 1 : 0;
      this.tiles[idx]!.kind = TileKind.Down;
      this.tiles[idx]!.value = 0;
    }
  }

  /**
   * A floor that rolls almost all UP tiles is a miserable floor. Guarantee a
   * minimum number of scoring tiles so no seed produces a dead board.
   */
  private guaranteeSomeScoring(rand: Rand, entryGX: number, entryGY: number): void {
    const target = Math.max(3, Math.floor(this.tiles.length * 0.35));
    let scoring = this.tiles.reduce((n, t) => n + (t.kind === TileKind.Number ? 1 : 0), 0);
    if (scoring >= target) return;

    const upIndices = this.tiles
      .map((t, i) => (t.kind === TileKind.Up ? i : -1))
      .filter((i) => i >= 0);
    rand.shuffle(upIndices);

    for (const idx of upIndices) {
      if (scoring >= target) break;
      const t = this.tiles[idx]!;
      if (chebyshev(t.gx, t.gy, entryGX, entryGY) === 0) continue;
      t.kind = TileKind.Number;
      t.value = this.dealValue(rand);
      this.startClock(t, rand);
      scoring++;
    }
  }

  // -- per-step ------------------------------------------------------------

  /**
   * Advance spawn animations and the tile countdown.
   * Returns the number of tiles that burned out this step.
   */
  update(dt: number, decayScale: number, frozen: boolean): number {
    let burnedOut = 0;
    let upCount = this.countUp();
    const upCeiling = Math.floor(this.tiles.length * TILE_DECAY.maxUpFraction);

    for (const tile of this.tiles) {
      if (tile.alive < 1) tile.alive = Math.min(1, tile.alive + dt * 3.2);
      if (tile.flash > 0) tile.flash = Math.max(0, tile.flash - dt * 3);
      tile.justBurnedOut = false;

      if (!TILE_DECAY.enabled || frozen) continue;
      if (tile.kind !== TileKind.Number) continue;

      tile.decayTimer -= dt * decayScale;
      while (tile.decayTimer <= 0) {
        tile.decayTimer += tile.decayEvery;
        tile.value--;
        tile.flash = TILE_DECAY.tickFlash;
        if (tile.value <= 0) {
          // Once the floor has as many hazards as it is allowed, further
          // burnouts go dead rather than hostile.
          const asHazard = TILE_DECAY.burnout && upCount < upCeiling;
          tile.kind = asHazard ? TileKind.Up : TileKind.Spent;
          if (asHazard) upCount++;
          tile.value = 0;
          tile.justBurnedOut = true;
          tile.burned = true;
          tile.flash = 1;
          burnedOut++;
          break;
        }
      }
    }

    return burnedOut;
  }

  /**
   * Re-entering a floor we previously left, in either direction.
   *
   * Two jobs. The first is cleanup: floors persist for the whole run, but
   * `dissolve` is left at 1 once the drop-through animation finishes — so
   * without resetting it, returning to a floor makes it the active floor with
   * every tile scaled to zero. It renders as an empty void you can still bounce
   * on. Replaying the spawn animation is not merely tidy either: it reads as
   * the floor re-forming around you, which is the right story for arriving.
   *
   * The second is the countdown reset. Every number tile goes back to a fresh
   * value on a fresh clock, and tiles that burned out come back as numbers.
   * What does *not* come back is anything you scored — those stay spent, so a
   * floor's harvestable total only ever falls and there is no way to farm one
   * by bouncing down and straight back up.
   *
   * Done on arrival rather than departure purely so the numbers do not visibly
   * change on a floor that is still on screen mid-dissolve. Nothing decays
   * while a floor is unoccupied, so the two are equivalent.
   */
  restore(rand: Rand): void {
    this.dissolve = 0;
    this.dissolveOrigin = null;

    for (const tile of this.tiles) {
      tile.alive = 0;
      if (!TILE_DECAY.resetOnLeave) continue;

      // Authored hazards keep the floor's shape; scored and used tiles stay
      // consumed. Everything else is either a live number or a burned one.
      const revivable = tile.kind === TileKind.Number || tile.burned;
      if (!revivable) continue;

      tile.kind = TileKind.Number;
      tile.value = this.dealValue(rand);
      this.startClock(tile, rand);
      tile.burned = false;
      tile.flash = 1;
    }
  }

  /** How many tiles currently send the player back up a level. */
  countUp(): number {
    let n = 0;
    for (const t of this.tiles) if (t.kind === TileKind.Up) n++;
    return n;
  }

  /** Number of tiles still worth landing on. Drives the "floor is dead" nudge. */
  countUseful(): number {
    let n = 0;
    for (const t of this.tiles) {
      if (t.kind !== TileKind.Up && t.kind !== TileKind.Spent) n++;
    }
    return n;
  }
}
