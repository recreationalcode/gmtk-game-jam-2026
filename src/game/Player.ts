import { BOUNCE_TIMING, FLOOR, POGO } from '../core/Config';
import { clamp, clamp01 } from '../core/MathUtil';

export type BounceQuality = 'normal' | 'charged' | 'perfect';

export interface LandingInfo {
  /** World position of the foot at the moment of contact. */
  x: number;
  z: number;
  /** Downward speed at contact, m/s (positive). */
  impactSpeed: number;
  quality: BounceQuality;
}

/**
 * The pogo rider.
 *
 * Vertical motion is pure ballistics with an authored apex rather than
 * conserved energy — a real spring would either die out or run away, and this
 * game needs an exactly predictable rhythm for the timing mechanic to be fair.
 * The *spring* is therefore visual only: a damped oscillator driven by impact
 * speed, which is what sells the compression without touching the sim.
 */
export class Player {
  /** Foot position. The camera rides `riderHeight` above this, minus compression. */
  x = 0;
  y = 0;
  z = 0;

  vx = 0;
  vy = 0;
  vz = 0;

  /** Y of the floor surface currently being bounced on. */
  floorY = 0;
  /** Current depth, which sets how high a bounce goes. */
  depth = 0;

  /** Visual spring compression, metres. */
  compression = 0;
  private compressionVel = 0;

  /** Seconds since the last landing — drives one-shot effects. */
  timeSinceLanding = 999;

  /** Set at launch, describing the bounce currently in progress. */
  lastQuality: BounceQuality = 'normal';

  /** How many perfect bounces in a row. Reset by any non-perfect landing. */
  perfectStreak = 0;

  /**
   * Set by `step()` when it used the caller's buffered bounce press, so the
   * caller knows to clear it. Reset at the top of every step.
   */
  consumedBounceInput = false;

  private lateGraceUntil = -Infinity;
  private lateGraceBaseApex = 0;

  reset(floorY: number): void {
    this.x = 0;
    this.z = 0;
    this.floorY = floorY;
    this.depth = 0;
    // Fall in from height rather than starting mid-bounce on the ground.
    this.y = floorY + POGO.startDropHeight;
    this.vx = 0;
    this.vy = 0;
    this.vz = 0;
    this.compression = 0;
    this.compressionVel = 0;
    this.timeSinceLanding = 999;
    this.lastQuality = 'normal';
    this.perfectStreak = 0;
    this.lateGraceUntil = -Infinity;
  }

  get height(): number {
    return this.y - this.floorY;
  }

  /** Eye height in world space, including the visual squash. */
  get eyeY(): number {
    return this.y + POGO.riderHeight - this.compression;
  }

  get horizontalSpeed(): number {
    return Math.hypot(this.vx, this.vz);
  }

  /**
   * Seconds until the foot reaches the floor, or Infinity while rising away
   * from a floor that is above us (which happens mid-ascend).
   */
  timeToImpact(): number {
    const h = this.y - this.floorY;
    const disc = this.vy * this.vy + 2 * POGO.gravity * h;
    if (disc < 0) return Infinity;
    return (this.vy + Math.sqrt(disc)) / POGO.gravity;
  }

  /**
   * Where the foot will touch down if the player keeps steering exactly as they
   * are now. Forward-integrating the steer input (rather than assuming they let
   * go) makes the reticle a promise instead of a guess, which is what lets the
   * player commit to a tile from the top of the arc.
   */
  predictLanding(steerX: number, steerZ: number, out: { x: number; z: number }): number {
    const t = this.timeToImpact();
    if (!Number.isFinite(t) || t <= 0) {
      out.x = this.x;
      out.z = this.z;
      return 0;
    }

    const steps = 12;
    const dt = t / steps;
    let px = this.x;
    let pz = this.z;
    let vx = this.vx;
    let vz = this.vz;

    for (let i = 0; i < steps; i++) {
      const remaining = t - i * dt;
      const accel = steerAccelAt(remaining);
      const maxSpeed = steerMaxSpeedAt(remaining);
      vx += steerX * accel * dt;
      vz += steerZ * accel * dt;
      const speed = Math.hypot(vx, vz);
      if (speed > maxSpeed) {
        const s = maxSpeed / speed;
        vx *= s;
        vz *= s;
      }
      const drag = Math.exp(-POGO.airDrag * dt);
      vx *= drag;
      vz *= drag;
      px += vx * dt;
      pz += vz * dt;
    }

    out.x = px;
    out.z = pz;
    return t;
  }

  /**
   * Advance one fixed step.
   *
   * `bounceAge` is how long ago the player's unconsumed bounce press happened,
   * or null if there isn't one. Returns landing info on the step where the foot
   * touches down, so the caller can resolve the tile before the next step.
   */
  step(
    dt: number,
    now: number,
    steerX: number,
    steerZ: number,
    bounceAge: number | null,
    halfExtent: number,
  ): LandingInfo | null {
    this.timeSinceLanding += dt;
    this.consumedBounceInput = false;

    // Horizontal: accelerate toward the steer direction, cap, then drag.
    // Authority rises as impact nears so a late correction is always possible.
    const tti = this.timeToImpact();
    const accel = steerAccelAt(tti);
    const maxSpeed = steerMaxSpeedAt(tti);
    this.vx += steerX * accel * dt;
    this.vz += steerZ * accel * dt;
    const speed = Math.hypot(this.vx, this.vz);
    if (speed > maxSpeed) {
      const s = maxSpeed / speed;
      this.vx *= s;
      this.vz *= s;
    }
    const drag = Math.exp(-POGO.airDrag * dt);
    this.vx *= drag;
    this.vz *= drag;

    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // Soft containment: push back before the rim, hard clamp at it. There is no
    // death in this game, so leaving the grid must be corrected, not punished.
    const soft = halfExtent * 0.86;
    if (Math.abs(this.x) > soft) this.vx -= Math.sign(this.x) * accel * 1.6 * dt;
    if (Math.abs(this.z) > soft) this.vz -= Math.sign(this.z) * accel * 1.6 * dt;
    if (this.x > halfExtent) {
      this.x = halfExtent;
      this.vx = Math.min(this.vx, 0);
    } else if (this.x < -halfExtent) {
      this.x = -halfExtent;
      this.vx = Math.max(this.vx, 0);
    }
    if (this.z > halfExtent) {
      this.z = halfExtent;
      this.vz = Math.min(this.vz, 0);
    } else if (this.z < -halfExtent) {
      this.z = -halfExtent;
      this.vz = Math.max(this.vz, 0);
    }

    // Vertical.
    const prevY = this.y;
    this.vy -= POGO.gravity * dt;
    this.y += this.vy * dt;

    this.updateSpring(dt);

    // A late press, just after impact, still upgrades the bounce. Timing
    // mechanics live or die on this kind of forgiveness.
    if (bounceAge !== null && now < this.lateGraceUntil && this.vy > 0) {
      this.applyLateUpgrade();
      this.consumedBounceInput = true;
      return null;
    }

    if (this.y <= this.floorY && this.vy < 0 && prevY >= this.floorY - 0.001) {
      return this.land(now, bounceAge, steerX, steerZ);
    }

    return null;
  }

  private land(
    now: number,
    bounceAge: number | null,
    steerX: number,
    steerZ: number,
  ): LandingInfo {
    const impactSpeed = Math.abs(this.vy);
    this.y = this.floorY;

    const quality = classifyBounce(bounceAge);
    this.lastQuality = quality;
    if (bounceAge !== null) this.consumedBounceInput = true;

    if (quality === 'perfect') {
      this.perfectStreak++;
      // A perfect bounce also kicks you the way you're leaning, which is what
      // turns a timing mechanic into a movement mechanic.
      const len = Math.hypot(steerX, steerZ);
      if (len > 0.01) {
        this.vx += (steerX / len) * POGO.perfectDashImpulse;
        this.vz += (steerZ / len) * POGO.perfectDashImpulse;
      }
    } else {
      this.perfectStreak = 0;
    }

    this.vx *= POGO.landingSpeedRetention;
    this.vz *= POGO.landingSpeedRetention;

    // Peak squash is roughly impulse / 23.5 for this spring, so the ceiling
    // keeps even a full-storey drop from folding the rider down onto the foot.
    this.compressionVel += clamp(impactSpeed * 0.95, 4, 16);
    this.timeSinceLanding = 0;

    if (quality === 'normal') {
      this.lateGraceUntil = now + BOUNCE_TIMING.lateGrace;
      this.lateGraceBaseApex = baseApexAt(this.depth);
    } else {
      this.lateGraceUntil = -Infinity;
    }

    this.vy = launchSpeed(apexFor(quality, this.depth));
    return { x: this.x, z: this.z, impactSpeed, quality };
  }

  /** Retroactively upgrade a normal bounce into a charged one. */
  private applyLateUpgrade(): void {
    this.lateGraceUntil = -Infinity;
    this.lastQuality = 'charged';
    const target = launchSpeed(this.lateGraceBaseApex * POGO.chargedApexScale);
    if (target > this.vy) this.vy = target;
  }

  /**
   * Launch with an explicit apex — used by UP tiles, which must clear the floor
   * above, and by DOWN tiles if we ever want a different departure.
   */
  launchToApex(apex: number): void {
    this.vy = launchSpeed(apex);
  }

  /** Move the reference floor without touching the player's world position. */
  setFloorY(y: number, depth: number): void {
    this.floorY = y;
    this.depth = depth;
  }

  private updateSpring(dt: number): void {
    // Damped harmonic oscillator, ~4Hz, ζ ≈ 0.35. Underdamped on purpose: the
    // slight rebound past zero is what reads as "spring" rather than "squash".
    const k = 631;
    const c = 17.6;
    this.compressionVel += (-k * this.compression - c * this.compressionVel) * dt;
    this.compression += this.compressionVel * dt;
    if (this.compression > POGO.compressionDepth * 1.45) {
      this.compression = POGO.compressionDepth * 1.45;
      this.compressionVel = Math.min(0, this.compressionVel);
    }
    if (this.compression < -POGO.compressionDepth * 0.5) {
      this.compression = -POGO.compressionDepth * 0.5;
      this.compressionVel = Math.max(0, this.compressionVel);
    }
  }
}

/**
 * How much steering authority the rider has, given how long is left before
 * impact. Ramps from normal at the top of the arc to boosted at touchdown.
 *
 * Both the simulation and the landing prediction call these, which is the whole
 * point: if the reticle used a different curve it would promise landings the
 * physics would not deliver.
 */
function lateFactor(timeToImpact: number): number {
  if (!Number.isFinite(timeToImpact) || timeToImpact <= 0) return 1;
  return 1 - clamp01(timeToImpact / POGO.lateSteerWindow);
}

export function steerAccelAt(timeToImpact: number): number {
  return POGO.airAccel * (1 + POGO.lateSteerBoost * lateFactor(timeToImpact));
}

export function steerMaxSpeedAt(timeToImpact: number): number {
  return POGO.airMaxSpeed * (1 + POGO.lateSpeedBoost * lateFactor(timeToImpact));
}

export function launchSpeed(apex: number): number {
  return Math.sqrt(2 * POGO.gravity * Math.max(0.01, apex));
}

/**
 * How much of the surface bounce you still get at this depth, 0–1.
 *
 * Smooth and monotonic by construction — see `POGO.apexDepthFloor`.
 */
export function apexScaleForDepth(depth: number): number {
  const floor = POGO.apexDepthFloor;
  return floor + (1 - floor) * Math.exp(-Math.max(0, depth) / POGO.apexDepthFalloff);
}

/** The uncharged apex at this depth. */
export function baseApexAt(depth: number): number {
  return POGO.baseApex * apexScaleForDepth(depth);
}

export function apexFor(quality: BounceQuality, depth: number): number {
  const base = baseApexAt(depth);
  switch (quality) {
    case 'perfect':
      return base * POGO.perfectApexScale;
    case 'charged':
      return base * POGO.chargedApexScale;
    default:
      return base;
  }
}

/**
 * Apex needed for an UP tile to carry the player onto the floor above.
 *
 * Deliberately *not* scaled by depth. This is not a bounce the player earned,
 * it is a punishment with a job to do — clearing a full storey — and a depth
 * scale would eventually leave it short of the floor it is meant to reach.
 */
export function ascendApex(): number {
  return FLOOR.floorDrop + POGO.baseApex * 1.05;
}

function classifyBounce(bounceAge: number | null): BounceQuality {
  if (bounceAge === null) return 'normal';
  if (bounceAge <= BOUNCE_TIMING.perfectWindow) return 'perfect';
  if (bounceAge <= BOUNCE_TIMING.chargeWindow) return 'charged';
  return 'normal';
}
