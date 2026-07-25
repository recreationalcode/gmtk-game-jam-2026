import * as THREE from 'three';

/**
 * Every glyph in the game, drawn with Canvas2D at boot into a single texture
 * atlas. Nothing here is loaded from disk — the project ships no font file and
 * no image file, which keeps the art direction honest ("everything procedural")
 * and the licensing trivially clean.
 *
 * Digits are 7-segment because a countdown game should look like a countdown,
 * and because a 7-segment glyph is a handful of stroked lines rather than a
 * typeface someone owns.
 */

export const GLYPH = {
  DIGIT_0: 0,
  DOWN: 10,
  UP: 11,
  SPENT: 12,
  TIME: 13,
  BOOST: 14,
  FREEZE: 15,
  /** The multiplication sign, composed beside digits to spell "x3" in-world. */
  TIMES: 16,
  NONE: 17,
} as const;

/** Glyphs are layers of a texture array; index 16 (NONE) draws nothing. */
export const ATLAS_LAYERS = 17;

/** Layout used only by the diagnostics page, which previews them as a grid. */
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 5;

/** Segment bitmask per digit. Bit order a,b,c,d,e,f,g → 1,2,4,8,16,32,64. */
const SEVEN_SEGMENT: readonly number[] = [
  0b0111111, // 0
  0b0000110, // 1
  0b1011011, // 2
  0b1001111, // 3
  0b1100110, // 4
  0b1101101, // 5
  0b1111101, // 6
  0b0000111, // 7
  0b1111111, // 8
  0b1101111, // 9
];

/**
 * Build the glyphs as a **texture array**, one glyph per layer.
 *
 * A conventional grid atlas does not survive here. Tiles are minified hard when
 * you are at the top of a bounce, and once mipmapping kicks in a grid atlas
 * blends across cell boundaries — a SPENT tile comes out speckled with
 * fragments of the digits stored beside it. Padding cannot fix it, because deep
 * mip levels reach further than any gutter you can afford. Dropping mipmaps
 * instead just trades bleeding for aliasing on the same tiles.
 *
 * Layers do not bleed into each other and mipmap independently, so this is the
 * one option where distant tiles stay clean. WebGL 2 gives us `sampler2DArray`
 * for free, and three compiles every ShaderMaterial as GLSL ES 3.00 anyway.
 */
export function createGlyphAtlas(cellSize: number): THREE.DataArrayTexture {
  const canvas = document.createElement('canvas');
  canvas.width = cellSize;
  canvas.height = cellSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;

  const bytesPerLayer = cellSize * cellSize * 4;
  const data = new Uint8Array(bytesPerLayer * ATLAS_LAYERS);

  for (let i = 0; i < ATLAS_LAYERS; i++) {
    ctx.clearRect(0, 0, cellSize, cellSize);
    applyStrokeStyle(ctx);
    drawCell(ctx, i, cellSize);
    const image = ctx.getImageData(0, 0, cellSize, cellSize);
    data.set(image.data, i * bytesPerLayer);
  }

  const texture = new THREE.DataArrayTexture(data, cellSize, cellSize, ATLAS_LAYERS);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

function applyStrokeStyle(ctx: CanvasRenderingContext2D): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
}

/** Preview all glyphs as one grid image. Used only by the diagnostics page. */
export function createAtlasPreview(cellSize: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = cellSize * ATLAS_COLS;
  canvas.height = cellSize * ATLAS_ROWS;
  const ctx = canvas.getContext('2d')!;
  for (let i = 0; i < ATLAS_LAYERS; i++) {
    ctx.save();
    ctx.translate((i % ATLAS_COLS) * cellSize, Math.floor(i / ATLAS_COLS) * cellSize);
    applyStrokeStyle(ctx);
    drawCell(ctx, i, cellSize);
    ctx.restore();
  }
  return canvas;
}

/**
 * Draw a single glyph into an arbitrary canvas, for the in-game tile legend.
 * The guide therefore shows the *same* procedural artwork the tiles use — it
 * can never drift out of sync with the game, because there is only one drawing.
 */
export function renderGlyphToCanvas(
  canvas: HTMLCanvasElement,
  index: number,
  color: string,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyStrokeStyle(ctx);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  drawCell(ctx, index, canvas.width);
}

/**
 * Draw a composed multiplier ("x3") into a canvas, matching how the shader lays
 * it out on a DOWN tile. The guide's legend uses this so it shows the same
 * artwork the board does and cannot drift out of sync with it.
 */
export function renderMultiplierToCanvas(
  canvas: HTMLCanvasElement,
  value: number,
  color: string,
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const s = canvas.width;
  ctx.clearRect(0, 0, s, s);
  applyStrokeStyle(ctx);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  const digits = String(Math.max(0, Math.round(value))).split('');
  const cells = ['x', ...digits];
  const slot = 1 / cells.length;

  // Mirrors the crop the shader applies per fragment: each glyph's ink region
  // is stretched to fill its slot, rather than the whole padded cell being
  // squeezed. Without this the legend renders visibly narrower than the board.
  const scaleX = slot / (INK_X1 - INK_X0);
  const scaleY = 1 / (INK_Y1 - INK_Y0);

  cells.forEach((cell, i) => {
    ctx.save();
    ctx.translate(i * slot * s - INK_X0 * s * scaleX, -INK_Y0 * s * scaleY);
    ctx.scale(scaleX, scaleY);
    drawCell(ctx, cell === 'x' ? GLYPH.TIMES : Number(cell), s);
    ctx.restore();
  });
}

/** Ink region of a glyph cell. Must match `glyphIn` in the tile shader. */
const INK_X0 = 0.24;
const INK_X1 = 0.76;
const INK_Y0 = 0.1;
const INK_Y1 = 0.9;

function drawCell(ctx: CanvasRenderingContext2D, index: number, s: number): void {
  if (index <= 9) {
    drawSevenSegment(ctx, SEVEN_SEGMENT[index]!, s);
    return;
  }
  switch (index) {
    case GLYPH.DOWN:
      drawChevrons(ctx, s, 1);
      break;
    case GLYPH.UP:
      drawChevrons(ctx, s, -1);
      break;
    case GLYPH.SPENT:
      drawSpent(ctx, s);
      break;
    case GLYPH.TIME:
      drawClock(ctx, s);
      break;
    case GLYPH.BOOST:
      drawBoost(ctx, s);
      break;
    case GLYPH.FREEZE:
      drawFreeze(ctx, s);
      break;
    case GLYPH.TIMES:
      drawTimes(ctx, s);
      break;
    default:
      break;
  }
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function drawSevenSegment(ctx: CanvasRenderingContext2D, mask: number, s: number): void {
  const L = 0.3 * s;
  const R = 0.7 * s;
  const T = 0.19 * s;
  const M = 0.5 * s;
  const B = 0.81 * s;
  // Pull segment ends in slightly so corners read as separate strokes rather
  // than a continuous outline — that gap is what makes it look like a display.
  const inset = 0.035 * s;

  ctx.lineWidth = 0.075 * s;

  if (mask & 1) line(ctx, L + inset, T, R - inset, T);
  if (mask & 2) line(ctx, R, T + inset, R, M - inset);
  if (mask & 4) line(ctx, R, M + inset, R, B - inset);
  if (mask & 8) line(ctx, L + inset, B, R - inset, B);
  if (mask & 16) line(ctx, L, M + inset, L, B - inset);
  if (mask & 32) line(ctx, L, T + inset, L, M - inset);
  if (mask & 64) line(ctx, L + inset, M, R - inset, M);
}

/** Nested arrowheads. `dir` of 1 points down (descend), -1 points up. */
function drawChevrons(ctx: CanvasRenderingContext2D, s: number, dir: number): void {
  ctx.lineWidth = 0.075 * s;
  const cx = 0.5 * s;
  const halfWidth = 0.21 * s;
  const rise = 0.15 * s;
  // Shift the stack so both directions stay optically centred in the cell.
  const first = dir > 0 ? 0.26 : 0.41;

  for (let i = 0; i < 3; i++) {
    const shoulder = (first + i * 0.17) * s;
    const tip = shoulder + dir * rise;
    ctx.beginPath();
    ctx.moveTo(cx - halfWidth, shoulder);
    ctx.lineTo(cx, tip);
    ctx.lineTo(cx + halfWidth, shoulder);
    ctx.stroke();
  }
}

function drawSpent(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.lineWidth = 0.05 * s;
  ctx.beginPath();
  ctx.arc(0.5 * s, 0.5 * s, 0.11 * s, 0, Math.PI * 2);
  ctx.stroke();
}

function drawClock(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.lineWidth = 0.07 * s;
  const cx = 0.5 * s;
  const cy = 0.5 * s;
  const r = 0.26 * s;

  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.lineWidth = 0.055 * s;
  line(ctx, cx, cy, cx, cy - r * 0.62);
  line(ctx, cx, cy, cx + r * 0.46, cy);

  // A "+" in the corner, so it reads as *gaining* time rather than costing it.
  ctx.lineWidth = 0.06 * s;
  const px = 0.79 * s;
  const py = 0.21 * s;
  const pr = 0.075 * s;
  line(ctx, px - pr, py, px + pr, py);
  line(ctx, px, py - pr, px, py + pr);
}

function drawBoost(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.lineWidth = 0.065 * s;
  for (let i = 0; i < 3; i++) {
    const half = (0.3 - i * 0.09) * s;
    ctx.strokeRect(0.5 * s - half, 0.5 * s - half, half * 2, half * 2);
  }
  ctx.lineWidth = 0.05 * s;
  const cx = 0.5 * s;
  const cy = 0.5 * s;
  const r = 0.06 * s;
  line(ctx, cx - r, cy, cx + r, cy);
  line(ctx, cx, cy - r, cx, cy + r);
}

/** A bold multiplication sign, drawn to the same optical weight as the digits. */
function drawTimes(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.lineWidth = 0.085 * s;
  const c = 0.5 * s;
  const r = 0.17 * s;
  line(ctx, c - r, c - r, c + r, c + r);
  line(ctx, c + r, c - r, c - r, c + r);
}

function drawFreeze(ctx: CanvasRenderingContext2D, s: number): void {
  ctx.lineWidth = 0.06 * s;
  const cx = 0.5 * s;
  const cy = 0.5 * s;
  const r = 0.28 * s;

  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const ex = cx + Math.cos(a) * r;
    const ey = cy + Math.sin(a) * r;
    line(ctx, cx, cy, ex, ey);

    // Barbs, so it reads as a crystal rather than a wheel.
    const bx = cx + Math.cos(a) * r * 0.6;
    const by = cy + Math.sin(a) * r * 0.6;
    const barb = r * 0.24;
    line(ctx, bx, by, bx + Math.cos(a + 0.9) * barb, by + Math.sin(a + 0.9) * barb);
    line(ctx, bx, by, bx + Math.cos(a - 0.9) * barb, by + Math.sin(a - 0.9) * barb);
  }
}
