import * as THREE from 'three';
import { CAMERA, FEEL, POGO } from '../core/Config';
import { clamp, damp, degToRad } from '../core/MathUtil';
import type { Player } from '../game/Player';
import { PogoStick } from './PogoStick';

/**
 * Camera and pogo stick share one transform.
 *
 * The rig sits at the stick's foot and tilts as the rider leans, so the camera
 * swinging over the floor and the stick tipping under you are the same rotation
 * rather than two effects that have to be kept in sync. Looking "straight down"
 * then means straight down *the stick*, which is both what the brief asked for
 * and more expressive than a gimbal locked to world down.
 */
export class PlayerRig {
  readonly group = new THREE.Group();
  readonly camera: THREE.PerspectiveCamera;
  readonly stick = new PogoStick();

  private leanX = 0;
  private leanZ = 0;
  private roll = 0;
  private fovPunch = 0;
  private baseFov: number = CAMERA.fov;

  private shakeSeed = Math.random() * 1000;
  private readonly pitchQuat = new THREE.Quaternion();
  private readonly rollQuat = new THREE.Quaternion();
  private readonly axisX = new THREE.Vector3(1, 0, 0);
  private readonly axisZ = new THREE.Vector3(0, 0, 1);

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);
    this.pitchQuat.setFromAxisAngle(this.axisX, -Math.PI / 2);
    this.group.add(this.stick.group);
    this.group.add(this.camera);
    this.setAspect(aspect);
  }

  reset(): void {
    this.leanX = 0;
    this.leanZ = 0;
    this.roll = 0;
    this.fovPunch = 0;
  }

  /** Called on impact, sized by how hard the landing was. */
  punch(strength: number): void {
    this.fovPunch = Math.min(CAMERA.fovPunch * 1.8, this.fovPunch + CAMERA.fovPunch * strength);
  }

  /**
   * @param dt real frame delta (not the fixed step) — this is presentation
   * @param shake current shake energy from the sim, 0..~1.6
   */
  update(dt: number, player: Player, shake: number, endgameIntensity: number): void {
    // Lean tracks velocity rather than input so it reads as momentum, and it
    // keeps leaning through the moment you let go of the stick.
    const targetLeanX = clamp(player.vz * CAMERA.pitchPerSpeed, -CAMERA.maxPitch, CAMERA.maxPitch);
    const targetLeanZ = clamp(-player.vx * CAMERA.pitchPerSpeed, -CAMERA.maxPitch, CAMERA.maxPitch);
    const targetRoll = clamp(-player.vx * CAMERA.rollPerSpeed, -CAMERA.maxRoll, CAMERA.maxRoll);

    this.leanX = damp(this.leanX, targetLeanX, CAMERA.leanSmoothing, dt);
    this.leanZ = damp(this.leanZ, targetLeanZ, CAMERA.leanSmoothing, dt);
    this.roll = damp(this.roll, targetRoll, CAMERA.leanSmoothing * 0.8, dt);

    this.group.position.set(player.x, player.y, player.z);
    this.group.rotation.set(degToRad(this.leanX), 0, degToRad(this.leanZ));

    this.stick.update(player.compression);

    const eye = POGO.riderHeight - player.compression;
    this.camera.position.set(0, eye, 0);

    // Roll is applied in the camera's own frame, after the look-down pitch, so
    // it spins the horizon rather than yawing the rig.
    this.rollQuat.setFromAxisAngle(this.axisZ, degToRad(this.roll));
    this.camera.quaternion.copy(this.pitchQuat).multiply(this.rollQuat);

    this.applyShake(dt, shake + endgameIntensity * FEEL.endgameAmbientShake);

    this.fovPunch = damp(this.fovPunch, 0, CAMERA.fovPunchDecay, dt);
    const fov = this.baseFov + this.fovPunch;
    if (Math.abs(this.camera.fov - fov) > 0.001) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Layered sines rather than white noise: random-per-frame shake reads as a
   * broken renderer, whereas a few incommensurate frequencies read as impact.
   */
  private applyShake(dt: number, energy: number): void {
    if (energy <= 0.0005) return;
    this.shakeSeed += dt;
    const t = this.shakeSeed;
    const amp = Math.min(FEEL.shakeMaxOffset, energy * FEEL.shakeMaxOffset);

    const ox = (Math.sin(t * 47.3) * 0.6 + Math.sin(t * 31.1) * 0.4) * amp;
    const oz = (Math.sin(t * 41.7 + 1.7) * 0.6 + Math.sin(t * 27.9 + 0.4) * 0.4) * amp;
    const oy = Math.sin(t * 53.2 + 2.3) * amp * 0.45;

    this.camera.position.x += ox;
    this.camera.position.y += oy;
    this.camera.position.z += oz;

    const rollJitter = Math.sin(t * 37.1 + 0.9) * energy * 2.4;
    this.rollQuat.setFromAxisAngle(this.axisZ, degToRad(this.roll + rollJitter));
    this.camera.quaternion.copy(this.pitchQuat).multiply(this.rollQuat);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.baseFov = fovForAspect(aspect);
    this.camera.fov = this.baseFov + this.fovPunch;
    this.camera.updateProjectionMatrix();
  }

  setAccent(color: THREE.Color): void {
    this.stick.setColor(color);
  }

  dispose(): void {
    this.stick.dispose();
  }
}

/**
 * Widen the lens until the narrower screen axis clears `CAMERA.minAxisFov`.
 * Landscape screens keep the authored vertical FOV untouched; only tall phones
 * pay the distortion, and only as much as they have to.
 */
export function fovForAspect(aspect: number): number {
  const baseTanV = Math.tan(degToRad(CAMERA.fov) / 2);
  const minTan = Math.tan(degToRad(CAMERA.minAxisFov) / 2);

  let tanV = baseTanV;
  const narrowTan = aspect < 1 ? tanV * aspect : tanV;
  if (narrowTan < minTan) tanV = aspect < 1 ? minTan / aspect : minTan;

  const fov = (2 * Math.atan(tanV) * 180) / Math.PI;
  return clamp(fov, CAMERA.fov, CAMERA.maxFov);
}
