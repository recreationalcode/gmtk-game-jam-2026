import { TileKind } from '../core/Config';

export { TileKind };

export interface Tile {
  kind: TileKind;
  /** Points value for NUMBER tiles; unused otherwise. */
  value: number;
  /** Grid column / row. */
  gx: number;
  gy: number;
  /** Seconds until the next countdown decrement. */
  decayTimer: number;
  /**
   * 0 → just appeared, 1 → fully settled. Drives the spawn animation and is
   * also read by the renderer during a floor dissolve (running back to 0).
   */
  alive: number;
  /** Seconds since this tile last did something worth flashing about. */
  flash: number;
  /** Set when a tile burns out, so the renderer can play the crackle once. */
  justBurnedOut: boolean;
}

export function isScoring(kind: TileKind): boolean {
  return kind === TileKind.Number;
}

/** Tiles the player can usefully aim at, for the "no targets left" hint. */
export function isUseful(kind: TileKind): boolean {
  return (
    kind === TileKind.Number ||
    kind === TileKind.Down ||
    kind === TileKind.Time ||
    kind === TileKind.Boost ||
    kind === TileKind.Freeze
  );
}

export function tileLabel(kind: TileKind): string {
  switch (kind) {
    case TileKind.Number:
      return 'NUMBER';
    case TileKind.Down:
      return 'DOWN';
    case TileKind.Up:
      return 'UP';
    case TileKind.Spent:
      return 'SPENT';
    case TileKind.Time:
      return 'TIME';
    case TileKind.Boost:
      return 'BOOST';
    case TileKind.Freeze:
      return 'FREEZE';
    default:
      return 'TILE';
  }
}
