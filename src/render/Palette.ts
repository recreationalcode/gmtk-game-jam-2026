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

/**
 * HSL in **sRGB**, which is the only sensible reading of "lightness 0.62".
 *
 * `Color.setHSL` defaults its colour space to the *working* space (linear),
 * unlike `setHex` and `setStyle` which default to sRGB. Omitting the argument
 * therefore treats authored lightness as a linear value and produces a colour
 * roughly twelve times brighter than intended — which showed up here as a
 * washed-out bloom, tiles that clipped far too easily, and an endgame
 * background that turned the whole screen pink.
 */
export function hsl(h: number, s: number, l: number, target = scratch): THREE.Color {
  return target.setHSL(((h % 360) + 360) / 360, s, l, THREE.SRGBColorSpace);
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

const warmScratch = new THREE.Color();

/** Background colour, pushed toward red once the endgame starts. */
export function backgroundColor(endgameIntensity: number, target = new THREE.Color()): THREE.Color {
  target.setHex(PALETTE.background);
  if (endgameIntensity > 0) {
    target.lerp(hsl(PALETTE.hostileHue, 0.75, 0.05, warmScratch), clamp01(endgameIntensity));
  }
  return target;
}
