import * as THREE from 'three';
import { FLOOR, TileKind } from '../core/Config';
import { easeOutBack, clamp01 } from '../core/MathUtil';
import type { Floor } from '../game/Floor';
import { GLYPH } from './GlyphAtlas';
import { tileColor } from './Palette';

const MAX_TILES = FLOOR.maxSide * FLOOR.maxSide;
/** Sentinel glyph id meaning "compose the multiplier text for this tile". */
const DOWN_COMPOUND = -1;
const TILE_THICKNESS = 0.16;

/**
 * Renders an entire floor — bodies, borders, digits and icons — in a single
 * instanced draw call.
 *
 * The border is drawn analytically in the fragment shader from the face UVs
 * rather than as line geometry, and the glyphs come from one procedurally
 * generated atlas. That combination is why a 100-tile floor costs one draw call
 * instead of three hundred, which is the whole reason this runs on a phone.
 */
export class TileField {
  readonly mesh: THREE.InstancedMesh;

  private readonly geometry: THREE.InstancedBufferGeometry | THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aState: THREE.InstancedBufferAttribute;
  private readonly aGlyph: THREE.InstancedBufferAttribute;

  private readonly matrix = new THREE.Matrix4();
  private readonly colorScratch = new THREE.Color();
  private readonly quat = new THREE.Quaternion();
  private readonly pos = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();

  /** Per-tile dissolve delay, recomputed when a dissolve starts. */
  private readonly delays = new Float32Array(MAX_TILES);
  private delaysFloor: Floor | null = null;

  constructor(atlas: THREE.DataArrayTexture, fogColor: THREE.Color, fogDensity: number) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    this.geometry = box;

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uAtlas: { value: atlas },
        uDissolve: { value: 0 },
        uTime: { value: 0 },
        uBorder: { value: 0.085 },
        uFogColor: { value: fogColor.clone() },
        uFogDensity: { value: fogDensity },
        uGlobalTint: { value: new THREE.Color(1, 1, 1) },
        uBrightness: { value: 1 },
        uDownGlyph: { value: GLYPH.TIMES },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: false,
      depthWrite: true,
    });

    this.mesh = new THREE.InstancedMesh(box, this.material, MAX_TILES);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    this.aColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TILES * 3), 3);
    this.aState = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TILES * 4), 4);
    this.aGlyph = new THREE.InstancedBufferAttribute(new Float32Array(MAX_TILES * 2), 2);
    this.aColor.setUsage(THREE.DynamicDrawUsage);
    this.aState.setUsage(THREE.DynamicDrawUsage);
    this.aGlyph.setUsage(THREE.DynamicDrawUsage);

    box.setAttribute('aColor', this.aColor);
    box.setAttribute('aState', this.aState);
    box.setAttribute('aGlyph', this.aGlyph);
  }

  setFogDensity(density: number): void {
    this.material.uniforms.uFogDensity!.value = density;
  }

  setFogColor(color: THREE.Color): void {
    (this.material.uniforms.uFogColor!.value as THREE.Color).copy(color);
  }

  /** Global multiplier on emissive brightness — used for the endgame flare. */
  setBrightness(v: number): void {
    this.material.uniforms.uBrightness!.value = v;
  }

  setTint(color: THREE.Color): void {
    (this.material.uniforms.uGlobalTint!.value as THREE.Color).copy(color);
  }

  /**
   * Push the floor's current state into the instance buffers. Called once per
   * rendered frame; ~100 instances makes a full rewrite cheaper than tracking
   * dirty ranges.
   *
   * @param nextMultiplier what the multiplier becomes if the player takes a
   * DOWN tile from here — rendered on the tile itself, because "this is the one
   * you want" is the single most important thing on the board.
   */
  sync(floor: Floor, time: number, nextMultiplier: number): void {
    const n = floor.tiles.length;
    this.mesh.count = n;
    this.material.uniforms.uTime!.value = time;
    this.material.uniforms.uDissolve!.value = floor.dissolve;

    if (this.delaysFloor !== floor || floor.dissolve === 0) this.computeDelays(floor);

    const colors = this.aColor.array as Float32Array;
    const states = this.aState.array as Float32Array;
    const glyphs = this.aGlyph.array as Float32Array;

    this.quat.identity();

    for (let i = 0; i < n; i++) {
      const tile = floor.tiles[i]!;

      this.pos.set(floor.worldX(tile.gx), floor.y - TILE_THICKNESS / 2, floor.worldZ(tile.gy));
      this.scale.set(floor.tileSize, TILE_THICKNESS, floor.tileSize);
      this.matrix.compose(this.pos, this.quat, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);

      const urgency = tile.kind === TileKind.Number ? clamp01(1 - (tile.value - 1) / 8) : 0;
      tileColor(tile.kind, floor.depth, urgency, this.colorScratch);
      colors[i * 3] = this.colorScratch.r;
      colors[i * 3 + 1] = this.colorScratch.g;
      colors[i * 3 + 2] = this.colorScratch.b;

      // easeOutBack on spawn gives the floor a physical "snap into place" that
      // a linear fade never sells.
      states[i * 4] = tile.alive >= 1 ? 1 : easeOutBack(tile.alive, 1.35);
      states[i * 4 + 1] = tile.flash;
      states[i * 4 + 2] = urgency;
      states[i * 4 + 3] = this.delays[i]!;

      glyphs[i * 2] = glyphFor(tile.kind, tile.value);
      glyphs[i * 2 + 1] = nextMultiplier;
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aState.needsUpdate = true;
    this.aGlyph.needsUpdate = true;
  }

  /**
   * Radial delay from wherever the down tile was, so the floor comes apart as a
   * wave travelling outward from the bounce that broke it.
   */
  private computeDelays(floor: Floor): void {
    this.delaysFloor = floor;
    const origin = floor.dissolveOrigin;
    const ox = origin?.x ?? 0;
    const oz = origin?.z ?? 0;
    let max = 0.0001;

    for (let i = 0; i < floor.tiles.length; i++) {
      const t = floor.tiles[i]!;
      const dx = floor.worldX(t.gx) - ox;
      const dz = floor.worldZ(t.gy) - oz;
      const d = Math.hypot(dx, dz) * FLOOR.dissolveWavePerMetre;
      this.delays[i] = d;
      if (d > max) max = d;
    }

    // Normalise so the last tile always finishes exactly at dissolve = 1.
    const norm = Math.min(0.75, max);
    for (let i = 0; i < floor.tiles.length; i++) {
      this.delays[i] = (this.delays[i]! / max) * norm;
    }
  }

  setVisible(v: boolean): void {
    this.mesh.visible = v;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}

function glyphFor(kind: TileKind, value: number): number {
  switch (kind) {
    case TileKind.Number:
      return Math.max(0, Math.min(9, value));
    case TileKind.Down:
      // Sentinel: the shader spells out the multiplier instead of sampling a
      // single layer. GLYPH.DOWN is still drawn in the guide's legend.
      return DOWN_COMPOUND;
    case TileKind.Up:
      return GLYPH.UP;
    case TileKind.Spent:
      return GLYPH.SPENT;
    case TileKind.Time:
      return GLYPH.TIME;
    case TileKind.Boost:
      return GLYPH.BOOST;
    case TileKind.Freeze:
      return GLYPH.FREEZE;
    default:
      return GLYPH.NONE;
  }
}

const VERT = /* glsl */ `
attribute vec3 aColor;
attribute vec4 aState;   // x spawn, y flash, z urgency, w dissolveDelay
attribute vec2 aGlyph;

uniform float uDissolve;

varying vec2 vUv;
varying vec3 vColor;
varying vec4 vState;
varying vec2 vGlyph;
varying float vTop;
varying float vFogDepth;

void main() {
  vUv = uv;
  vColor = aColor;
  vState = aState;
  vGlyph = aGlyph;
  vTop = step(0.5, normal.y);

  // Each tile waits its turn, then shrinks and drops out of the world.
  float d = clamp((uDissolve - aState.w) / max(0.0001, 1.0 - aState.w), 0.0, 1.0);
  float s = aState.x * (1.0 - d);

  vec4 world = instanceMatrix * vec4(position * s, 1.0);
  world.y -= d * d * 9.0;

  vec4 mv = modelViewMatrix * world;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const FRAG = /* glsl */ `
precision highp float;

uniform sampler2DArray uAtlas;
uniform float uTime;
uniform float uDownGlyph;
uniform float uBorder;
uniform float uBrightness;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uGlobalTint;

varying vec2 vUv;
varying vec3 vColor;
varying vec4 vState;
varying vec2 vGlyph;
varying float vTop;
varying float vFogDepth;

// Data textures are not flipped on upload the way canvas textures are, so v is
// inverted here to keep glyphs the right way up.
float sampleGlyph(float layer, vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture(uAtlas, vec3(uv.x, 1.0 - uv.y, layer)).a;
}

// Map a sub-rectangle of the tile face onto a glyph cell, cropping to the
// cell's ink area so the glyph fills its slot instead of floating in padding.
float glyphIn(float layer, vec2 uv, float x0, float x1) {
  float lx = (uv.x - x0) / (x1 - x0);
  if (lx < 0.0 || lx > 1.0) return 0.0;
  vec2 cropped = vec2(mix(0.24, 0.76, lx), mix(0.10, 0.90, uv.y));
  return sampleGlyph(layer, cropped);
}

// Spell "x2", "x12" and so on across the tile face.
float multiplierGlyph(vec2 uv, float value) {
  float n = clamp(floor(value + 0.5), 0.0, 99.0);
  if (n < 10.0) {
    return max(glyphIn(uDownGlyph, uv, 0.10, 0.48), glyphIn(n, uv, 0.50, 0.90));
  }
  float tens = floor(n / 10.0);
  float ones = n - tens * 10.0;
  return max(
    glyphIn(uDownGlyph, uv, 0.02, 0.34),
    max(glyphIn(tens, uv, 0.34, 0.66), glyphIn(ones, uv, 0.66, 0.98))
  );
}

void main() {
  vec3 col;

  if (vTop > 0.5) {
    // Distance from the rim, in UV units: 0 at the edge, 1 at the centre.
    vec2 p = vUv * 2.0 - 1.0;
    float e = 1.0 - max(abs(p.x), abs(p.y));
    // Screen-space derivative, so the border stays one crisp line whether the
    // tile fills the screen or sits far below you at the top of a bounce.
    float aa = max(fwidth(e), 0.0008) * 1.2;
    float border = 1.0 - smoothstep(uBorder - aa, uBorder + aa, e);

    // A DOWN tile spells out the multiplier it grants rather than showing an
    // arrow. The arrow only said "down"; the number says "this is worth it".
    float glyph = vGlyph.x > 16.5
      ? 0.0
      : (vGlyph.x < -0.5 ? multiplierGlyph(vUv, vGlyph.y) : sampleGlyph(vGlyph.x, vUv));

    float ink = max(border, glyph);

    // Near-black fill so a tile still occludes the floor below it, with just
    // enough of the accent bled in to keep the surface from reading as a hole.
    col = mix(vColor * 0.055, vColor, ink);

    col += vColor * vState.y * 0.75 * ink;

    // Tiles about to burn out breathe, so the board's decay is legible from
    // the top of the arc without reading every digit.
    float pulse = 0.5 + 0.5 * sin(uTime * 9.0);
    col += vColor * vState.z * vState.z * pulse * 0.28 * ink;
  } else {
    col = vColor * 0.14;
  }

  col *= uBrightness;
  col *= uGlobalTint;

  float f = 1.0 - exp(-pow(max(vFogDepth, 0.0) * uFogDensity, 2.0));
  col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;
