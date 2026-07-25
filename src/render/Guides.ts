import * as THREE from 'three';
import { BOUNCE_TIMING, RETICLE } from '../core/Config';
import { clamp01, degToRad, lerp } from '../core/MathUtil';
import type { Floor } from '../game/Floor';

const RING_SEGMENTS = 48;

/**
 * The landing reticle, and the wireframe hint of the floor below.
 *
 * The reticle does double duty. The square answers "which tile am I about to
 * hit", which a straight-down camera cannot otherwise convey from the top of an
 * arc. The ring converging on that square answers "when do I press", which
 * teaches the timing window without a tutorial: press when the ring meets the
 * square. Everything the bounce mechanic needs the player to know is in one
 * piece of diegetic UI.
 */
export class Guides {
  readonly group = new THREE.Group();

  private readonly square: THREE.LineSegments;
  private readonly ring: THREE.LineLoop;
  private readonly dropLine: THREE.Line;
  private readonly preview: THREE.LineSegments;
  private readonly horizon: THREE.LineSegments;

  private readonly squareMat: THREE.LineBasicMaterial;
  private readonly ringMat: THREE.LineBasicMaterial;
  private readonly dropMat: THREE.LineBasicMaterial;
  private readonly previewMat: THREE.LineBasicMaterial;
  private readonly horizonMat: THREE.LineBasicMaterial;

  private readonly dropPoints = [new THREE.Vector3(), new THREE.Vector3()];
  private previewKey = '';

  constructor() {
    this.squareMat = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
    this.ringMat = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
    this.dropMat = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false });
    this.previewMat = new THREE.LineBasicMaterial({
      transparent: true,
      depthWrite: false,
      opacity: 0.16,
    });

    // A wide, very dim lattice under the play area. Without it the floor is a
    // handful of tiles hanging in black, which reads as unfinished and gives
    // the eye nothing to track lateral movement against.
    this.horizonMat = new THREE.LineBasicMaterial({
      transparent: true,
      depthWrite: false,
      opacity: 0.07,
    });

    this.square = new THREE.LineSegments(unitSquareGeometry(), this.squareMat);
    this.ring = new THREE.LineLoop(unitCircleGeometry(RING_SEGMENTS), this.ringMat);
    this.dropLine = new THREE.Line(new THREE.BufferGeometry(), this.dropMat);
    this.preview = new THREE.LineSegments(new THREE.BufferGeometry(), this.previewMat);
    this.horizon = new THREE.LineSegments(
      gridGeometry(HORIZON_DIVISIONS, HORIZON_EXTENT, 0),
      this.horizonMat,
    );

    for (const o of [this.square, this.ring, this.dropLine, this.preview, this.horizon]) {
      o.frustumCulled = false;
      o.renderOrder = 3;
      this.group.add(o);
    }
    this.horizon.renderOrder = 0;
    this.dropLine.geometry.setFromPoints(this.dropPoints);
  }

  /** Park the ambient lattice just under the active floor. */
  updateHorizon(floorY: number, accent: THREE.Color): void {
    this.horizon.position.set(0, floorY - 0.6, 0);
    this.horizonMat.color.copy(accent);
  }

  setVisible(v: boolean): void {
    this.square.visible = v;
    this.ring.visible = v;
    this.dropLine.visible = v;
  }

  /**
   * @param landX/landZ predicted touchdown, world space
   * @param timeToImpact seconds until the foot lands
   */
  update(
    floor: Floor,
    landX: number,
    landZ: number,
    playerX: number,
    playerY: number,
    playerZ: number,
    timeToImpact: number,
    accent: THREE.Color,
    perfectFlash: number,
    time: number,
  ): void {
    const gx = floor.gridX(landX);
    const gy = floor.gridY(landZ);
    const cx = floor.worldX(gx);
    const cz = floor.worldZ(gy);
    const y = floor.y + 0.06;

    this.square.position.set(cx, y, cz);
    this.square.scale.setScalar(floor.tileSize * 1.06);

    // Ring converges on the square exactly at touchdown, but stays tile-scoped
    // the whole way so it always reads as pointing at one specific tile.
    const lead = clamp01(timeToImpact / RETICLE.ringLead);
    const ringScale = floor.tileSize * lerp(RETICLE.ringMinScale, RETICLE.ringMaxScale, lead);
    this.ring.position.set(cx, y + 0.01, cz);
    this.ring.scale.setScalar(ringScale);

    const closeness = 1 - clamp01(timeToImpact / (BOUNCE_TIMING.chargeWindow * 3));

    // Now that the ring barely changes size, rotation and brightness carry the
    // timing cue its diameter used to. It winds up as impact approaches.
    this.ring.rotation.y = degToRad(
      time * RETICLE.ringSpin * (1 + closeness * RETICLE.ringSpinGain),
    );

    // Opacity is the only real lever on bloom here: a saturated accent puts two
    // channels near full, so the line clears the bloom threshold at any width.
    this.ringMat.opacity = RETICLE.ringOpacityBase + closeness * RETICLE.ringOpacityGain;
    this.ringMat.color.copy(accent).lerp(WHITE, 0.2 + closeness * 0.4 + perfectFlash * 0.4);

    this.squareMat.opacity =
      RETICLE.squareOpacityBase + closeness * RETICLE.squareOpacityGain + perfectFlash * 0.2;
    this.squareMat.color.copy(accent).lerp(WHITE, perfectFlash * 0.6);

    this.dropPoints[0]!.set(playerX, playerY, playerZ);
    this.dropPoints[1]!.set(landX, floor.y + 0.02, landZ);
    this.dropLine.geometry.setFromPoints(this.dropPoints);
    this.dropLine.geometry.attributes.position!.needsUpdate = true;
    this.dropMat.color.copy(accent);
    this.dropMat.opacity = 0.13 + closeness * 0.12;
  }

  /** Dim wireframe of the floor one level down, so depth reads as depth. */
  updatePreview(side: number, extent: number, y: number, accent: THREE.Color): void {
    const key = `${side}:${extent.toFixed(3)}:${y.toFixed(2)}`;
    if (key !== this.previewKey) {
      this.previewKey = key;
      this.preview.geometry.dispose();
      this.preview.geometry = gridGeometry(side, extent, y);
    }
    this.previewMat.color.copy(accent);
  }

  setPreviewOpacity(v: number): void {
    this.previewMat.opacity = v;
  }

  dispose(): void {
    for (const o of [this.square, this.ring, this.dropLine, this.preview, this.horizon]) {
      o.geometry.dispose();
    }
    this.squareMat.dispose();
    this.ringMat.dispose();
    this.dropMat.dispose();
    this.previewMat.dispose();
    this.horizonMat.dispose();
  }
}

const WHITE = new THREE.Color(1, 1, 1);

/** Big enough to reach past the fog, coarse enough to stay cheap. */
const HORIZON_EXTENT = 90;
const HORIZON_DIVISIONS = 36;

function unitSquareGeometry(): THREE.BufferGeometry {
  const h = 0.5;
  const pts = [
    -h, 0, -h, h, 0, -h,
    h, 0, -h, h, 0, h,
    h, 0, h, -h, 0, h,
    -h, 0, h, -h, 0, -h,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function unitCircleGeometry(segments: number): THREE.BufferGeometry {
  const pts: number[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    pts.push(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}

function gridGeometry(side: number, extent: number, y: number): THREE.BufferGeometry {
  const pts: number[] = [];
  const half = extent / 2;
  for (let i = 0; i <= side; i++) {
    const t = -half + (i / side) * extent;
    pts.push(t, y, -half, t, y, half);
    pts.push(-half, y, t, half, y, t);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return g;
}
