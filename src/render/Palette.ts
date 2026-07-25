import * as THREE from 'three';
import { PALETTE, TileKind } from '../core/Config';
import { clamp01, lerp } from '../core/MathUtil';

/**
 * Colour is the game's depth gauge. Every floor gets its own accent hue, so
 * "am I making progress" is answered by the whole screen changing colour rather
 * than by reading a number in the corner.
 *
 * Tile *kinds* that matter for survival (down, up) keep fixed hues regardless
 * of depth — they must stay instantly recognisable even as everything else
 * shifts around them.
 */

export function depthHue(depth: number): number {
  const hues = PALETTE.depthHues;
  return hues[((depth % hues.length) + hues.length) % hues.length]!;
}

const scratch = new THREE.Color();

export function hsl(h: number, s: number, l: number, target = scratch): THREE.Color {
  return target.setHSL(((h % 360) + 360) / 360, s, l);
}

/**
 * @param urgency 0 → freshly spawned, 1 → about to burn out. Low-value tiles
 * drift toward the hostile hue, so the board visibly turns against you.
 */
export function tileColor(
  kind: TileKind,
  depth: number,
  urgency: number,
  target = new THREE.Color(),
): THREE.Color {
  const accent = depthHue(depth);

  switch (kind) {
    case TileKind.Down:
      return hsl(PALETTE.downHue, 0.9, 0.6, target);
    case TileKind.Up:
      return hsl(PALETTE.hostileHue, 0.82, 0.55, target);
    case TileKind.Time:
      return hsl(PALETTE.timeHue, 0.9, 0.62, target);
    case TileKind.Boost:
      return hsl(PALETTE.boostHue, 0.85, 0.66, target);
    case TileKind.Freeze:
      return hsl(PALETTE.freezeHue, 0.75, 0.7, target);
    case TileKind.Spent:
      return hsl(accent, 0.25, PALETTE.spentLightness, target);
    case TileKind.Number:
    default: {
      const u = clamp01(urgency);
      // Shortest-path hue blend toward hostile as the countdown runs out.
      let delta = PALETTE.hostileHue - accent;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      const h = accent + delta * u * 0.55;
      const s = lerp(PALETTE.lineSaturation, 0.95, u);
      const l = lerp(PALETTE.lineLightness, 0.5, u);
      return hsl(h, s, l, target);
    }
  }
}

/** Background colour, pushed toward red once the endgame starts. */
export function backgroundColor(endgameIntensity: number, target = new THREE.Color()): THREE.Color {
  target.setHex(PALETTE.background);
  if (endgameIntensity > 0) {
    const warm = new THREE.Color().setHSL(PALETTE.hostileHue / 360, 0.7, 0.06);
    target.lerp(warm, clamp01(endgameIntensity));
  }
  return target;
}
