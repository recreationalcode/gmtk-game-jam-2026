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
    const minValue = Math.min(
      TILE_VALUES.maxSpawn,
      Math.round(TILE_VALUES.minSpawn + this.depth * TILE_VALUES.minSpawnPerDepth),
    );

    const specials = this.unlockedSpecials();

    for (let i = 0; i < count; i++) {
      const gx = i % this.side;
      const gy = Math.floor(i / this.side);
      const kind = this.rollKind(rand, specials);
      this.tiles.push({
        kind,
        value: kind === TileKind.Number ? rand.int(minValue, TILE_VALUES.maxSpawn) : 0,
        gx,
        gy,
        decayTimer: TILE_DECAY.interval * rand.range(1 - TILE_DECAY.phaseJitter * 0.5, 1),
        alive: 0,
        flash: 0,
        justBurnedOut: false,
      });
    }

    this.placeDownTiles(rand, entryGX, entryGY);
    this.guaranteeSomeScoring(rand, minValue, entryGX, entryGY);
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
  private guaranteeSomeScoring(
    rand: Rand,
    minValue: number,
    entryGX: number,
    entryGY: number,
  ): void {
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
      t.value = rand.int(minValue, TILE_VALUES.maxSpawn);
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

    for (const tile of this.tiles) {
      if (tile.alive < 1) tile.alive = Math.min(1, tile.alive + dt * 3.2);
      if (tile.flash > 0) tile.flash = Math.max(0, tile.flash - dt * 3);
      tile.justBurnedOut = false;

      if (!TILE_DECAY.enabled || frozen) continue;
      if (tile.kind !== TileKind.Number) continue;

      tile.decayTimer -= dt * decayScale;
      while (tile.decayTimer <= 0) {
        tile.decayTimer += TILE_DECAY.interval;
        tile.value--;
        tile.flash = 0.5;
        if (tile.value <= 0) {
          tile.kind = TILE_DECAY.burnout ? TileKind.Up : TileKind.Spent;
          tile.value = 0;
          tile.justBurnedOut = true;
          tile.flash = 1;
          burnedOut++;
          break;
        }
      }
    }

    return burnedOut;
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
