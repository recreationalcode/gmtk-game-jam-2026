import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { POGO } from '../core/Config';
import { clamp } from '../core/MathUtil';

/**
 * The pogo stick, built from primitives at boot.
 *
 * Framing note: the camera looks straight down, so a stick directly beneath you
 * would be seen end-on and effectively invisible. What you actually see from up
 * there is the rig *around* you — handlebars at the top of frame, footpegs
 * below them, and the shaft receding toward the ground between your feet. That
 * reads as first-person far better than a stick hanging in view would, and it
 * keeps the "looking straight down" constraint intact.
 *
 * Everything is drawn twice: a near-black solid pass so the stick occludes the
 * floor behind it, and an edge pass for the glowing line art. Two passes per
 * group, four draw calls total.
 */

const SPRING_BASE = 0.5;
const SPRING_TOP = 1.12;

export class PogoStick {
  readonly group = new THREE.Group();

  private readonly upper = new THREE.Group();
  private readonly springLine: THREE.Line;
  private readonly springHeight = SPRING_TOP - SPRING_BASE;

  private readonly edgeMaterial: THREE.LineBasicMaterial;
  private readonly solidMaterial: THREE.MeshBasicMaterial;
  private readonly springMaterial: THREE.LineBasicMaterial;

  private readonly springPoints: THREE.Vector3[] = [];
  private readonly springGeometry: THREE.BufferGeometry;

  constructor() {
    // Pure black, not near-black: any fill brightness at all gets picked up by
    // bloom and turns the rig into a glowing slab in front of the camera.
    this.solidMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
    this.edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true });
    this.springMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true });

    this.group.add(this.makePart(buildShaftGeometry()));
    // The foot is drawn as outline only. Solid, it sits directly between the
    // camera and the tile being landed on and hides the one thing the player is
    // looking at; as line art it frames the target instead of covering it.
    this.group.add(this.makeOutline(buildFootGeometry()));
    this.upper.add(this.makePart(buildUpperGeometry()));
    this.group.add(this.upper);

    this.springGeometry = new THREE.BufferGeometry();
    for (let i = 0; i < SPRING_SEGMENTS + 1; i++) this.springPoints.push(new THREE.Vector3());
    this.springGeometry.setFromPoints(this.springPoints);
    this.springLine = new THREE.Line(this.springGeometry, this.springMaterial);
    this.springLine.frustumCulled = false;
    this.group.add(this.springLine);

    this.updateSpring(0);
    // Never let the rig clip through the near plane or the floor it lands on.
    this.group.renderOrder = 2;
  }

  private makePart(geo: THREE.BufferGeometry): THREE.Group {
    const g = new THREE.Group();
    const solid = new THREE.Mesh(geo, this.solidMaterial);
    solid.frustumCulled = false;
    g.add(solid);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 24),
      this.edgeMaterial,
    );
    edges.frustumCulled = false;
    g.add(edges);
    return g;
  }

  private makeOutline(geo: THREE.BufferGeometry): THREE.LineSegments {
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 24), this.edgeMaterial);
    edges.frustumCulled = false;
    geo.dispose();
    return edges;
  }

  /** Accent colour follows the current depth so the rig belongs to the floor. */
  setColor(color: THREE.Color): void {
    this.edgeMaterial.color.copy(color);
    this.springMaterial.color.copy(color);
  }

  setOpacity(v: number): void {
    this.edgeMaterial.opacity = v;
    this.springMaterial.opacity = v;
  }

  /**
   * @param compression metres the spring is currently squashed by
   */
  update(compression: number): void {
    const c = clamp(compression, -0.25, this.springHeight * 0.8);
    this.upper.position.y = -c;
    this.updateSpring(c);
  }

  private updateSpring(compression: number): void {
    const height = Math.max(0.1, this.springHeight - compression);
    // Coils bunch as the spring shortens, which is the detail that makes a
    // helix read as a spring rather than a decorative squiggle.
    const turns = SPRING_TURNS;
    const radius = 0.105 + compression * 0.09;

    for (let i = 0; i <= SPRING_SEGMENTS; i++) {
      const t = i / SPRING_SEGMENTS;
      const a = t * Math.PI * 2 * turns;
      const p = this.springPoints[i]!;
      p.set(Math.cos(a) * radius, SPRING_BASE + t * height, Math.sin(a) * radius);
    }

    this.springGeometry.setFromPoints(this.springPoints);
    this.springGeometry.attributes.position!.needsUpdate = true;
    this.springGeometry.computeBoundingSphere();
  }

  dispose(): void {
    this.group.traverse((o: THREE.Object3D) => {
      const mesh = o as Partial<THREE.Mesh>;
      mesh.geometry?.dispose();
    });
    this.solidMaterial.dispose();
    this.edgeMaterial.dispose();
    this.springMaterial.dispose();
  }
}

const SPRING_SEGMENTS = 96;
const SPRING_TURNS = 7;

/** The foot pad, drawn as an outline so it never masks the landing tile. */
function buildFootGeometry(): THREE.BufferGeometry {
  const pad = new THREE.CylinderGeometry(0.15, 0.185, 0.07, 8);
  pad.translate(0, 0.035, 0);
  return pad;
}

/** The lower shaft — the part that stays with the ground under compression. */
function buildShaftGeometry(): THREE.BufferGeometry {
  const shaft = new THREE.CylinderGeometry(0.05, 0.05, 0.9, 6);
  shaft.translate(0, 0.5, 0);
  return shaft;
}

/**
 * Everything the rider is attached to, which travels with the compression.
 *
 * Distances from the eye are the whole design problem here. Anything within
 * about half a metre of a 75-100 degree lens fills the frame — the handlebar
 * started at 0.4m and rendered as a bar straight across the middle of the
 * screen. These offsets are chosen so the rig frames the shot from the edges
 * instead of blocking it, which matters more than anatomical accuracy.
 */
function buildUpperGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const eye = POGO.riderHeight;

  // The shaft must stop short of the eye. Running it all the way up to
  // `riderHeight` puts its top vertices exactly at the camera, and a cylinder
  // straddling the near plane projects its side edges as long lines shooting
  // across the whole screen.
  const shaftTop = eye - 0.34;
  const shaftLength = shaftTop - 0.9;
  const shaft = new THREE.CylinderGeometry(0.055, 0.055, shaftLength, 6);
  shaft.translate(0, 0.9 + shaftLength / 2, 0);
  parts.push(shaft);

  // Footpegs with boots on them, well down the shaft so they read as *your
  // feet, far below* rather than as blocks floating in front of the lens.
  for (const side of [-1, 1]) {
    const peg = new THREE.BoxGeometry(0.15, 0.035, 0.065);
    peg.translate(side * 0.13, eye - 1.3, 0);
    parts.push(peg);

    const boot = new THREE.BoxGeometry(0.12, 0.045, 0.2);
    boot.translate(side * 0.17, eye - 1.27, -0.01);
    parts.push(boot);
  }

  // Handlebar, offset toward the top of frame so it does not sit directly on
  // the shaft axis — from straight above, an aligned bar hides the shaft
  // entirely and the rig stops reading as a pogo stick at all.
  const barZ = -0.13;
  const bar = new THREE.BoxGeometry(0.42, 0.032, 0.032);
  bar.translate(0, eye - 0.62, barZ);
  parts.push(bar);

  const stem = new THREE.BoxGeometry(0.036, 0.032, 0.15);
  stem.translate(0, eye - 0.62, barZ / 2);
  parts.push(stem);

  for (const side of [-1, 1]) {
    const grip = new THREE.CylinderGeometry(0.03, 0.03, 0.12, 6);
    grip.rotateZ(Math.PI / 2);
    grip.translate(side * 0.17, eye - 0.62, barZ);
    parts.push(grip);
  }

  return mergeGeometries(parts, false)!;
}
