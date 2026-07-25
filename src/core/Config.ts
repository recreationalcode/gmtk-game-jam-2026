/**
 * Every tunable number in Pogo Drop lives here.
 *
 * The rule this file enforces: no gameplay constant is allowed to hide inside a
 * system. Balance changes during a jam happen at 3am under time pressure, and
 * hunting a magic number through five files is how jam games die. It also means
 * the design decisions flagged as open questions in DESIGN.md are genuinely
 * one-line flips rather than rewrites.
 */

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------

export const SIM = {
  /** Fixed simulation rate. Physics must not vary between a 60Hz and 144Hz screen. */
  hz: 120,
  /**
   * Ceiling on fixed steps per rendered frame, so a stalled tab cannot come
   * back and simulate ten thousand steps at once.
   *
   * It also sets the frame rate below which the game deliberately runs in slow
   * motion rather than dropping simulation: 20 steps at 120Hz is 167ms of
   * simulation per frame, so everything stays real-time down to ~6fps. Slowing
   * down is the right failure mode for a score attack — the alternative is
   * skipping physics, which would teleport the player through tiles.
   *
   * This was 8, which capped the sim at 67ms per frame and quietly ran the
   * match clock at a third speed under software rendering.
   */
  maxStepsPerFrame: 20,
  /** Clamp on wall-clock delta, seconds. Prevents a spiral of death after a stall. */
  maxFrameDelta: 0.25,
} as const;

// ---------------------------------------------------------------------------
// Pogo physics
//
// Derived so a lazy bounce lasts ~0.9s and peaks ~3m above the floor. At that
// apex a 75° vertical FOV sees the whole starting grid; at the bottom of the
// arc it sees under two tiles. That gap is the game: you plan at the top and
// commit at the bottom, and buying altitude buys information.
// ---------------------------------------------------------------------------

export const POGO = {
  gravity: 30.0,

  /** Apex height above the floor for an uncharged bounce, metres. */
  baseApex: 3.05,
  /** Apex multiplier for a charged (well-timed) bounce. */
  chargedApexScale: 1.55,
  /** Apex multiplier for a frame-perfect bounce. */
  perfectApexScale: 1.72,

  /** Distance from the stick's foot up to the rider's eye, metres. */
  riderHeight: 2.2,

  /** Horizontal steering. Limited on purpose — you steer, you do not fly. */
  airAccel: 26.0,
  airMaxSpeed: 6.0,
  /** Fraction of horizontal speed retained through a landing. */
  landingSpeedRetention: 0.62,
  /** Drag applied to horizontal motion each second while airborne. */
  airDrag: 0.9,

  /** A perfect bounce also kicks you in your current steer direction. */
  perfectDashImpulse: 2.4,

  /** Spring visual: how far the foot compresses at peak impact, metres. */
  compressionDepth: 0.55,
  /** Seconds the compress/extend animation takes. */
  compressionTime: 0.16,
} as const;

/**
 * Timing windows for hitting the bounce, in seconds before predicted impact.
 * Generous outer window so the mechanic is discoverable; tight inner window so
 * mastery is expressible.
 */
export const BOUNCE_TIMING = {
  /** Input this long before impact (or later) counts as charged. */
  chargeWindow: 0.22,
  /** Input this close to impact is PERFECT. */
  perfectWindow: 0.085,
  /**
   * How long a press stays buffered waiting for an impact. Must exceed
   * `chargeWindow` or a genuinely charged press could expire before it lands.
   *
   * The buffer is also the anti-mash rule: a press only registers when the
   * buffer is empty (first press wins, not last), so spamming the button fills
   * the buffer far too early and grades out as a plain bounce. One deliberate
   * press beats eight panicked ones.
   */
  inputBuffer: 0.3,
  /** Grace after impact where a late press still counts as charged. */
  lateGrace: 0.05,
} as const;

// ---------------------------------------------------------------------------
// Floors
// ---------------------------------------------------------------------------

export const FLOOR = {
  baseSide: 4,
  maxSide: 10,
  /** side = baseSide + round(depth * sideGrowth), clamped to maxSide. */
  sideGrowth: 0.7,

  /** World extent (metres) of the starting grid. */
  baseExtent: 8.0,
  /**
   * Extent scales as (side / baseSide) ^ extentExponent. Below 1.0 means the
   * grid gains tiles faster than it gains area, so tiles shrink as you descend.
   * More choices, smaller targets — a difficulty ramp with no difficulty knob.
   */
  extentExponent: 0.45,

  /** Gap between tiles as a fraction of cell pitch. */
  gapRatio: 0.12,
  /** Vertical drop between one floor and the next, metres. */
  floorDrop: 7.0,

  /** Seconds for the floor-dissolve transition. */
  dissolveTime: 0.55,
  /** Extra seconds of delay per unit distance from the down tile, for the wave. */
  dissolveWavePerMetre: 0.035,
} as const;

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

export const enum TileKind {
  Number = 0,
  Down = 1,
  Up = 2,
  Spent = 3,
  Time = 4,
  Boost = 5,
  Freeze = 6,
}

export const TILE_VALUES = {
  /**
   * Number tiles spawn with a value in this inclusive range, and the value is
   * also the tile's lifetime in decay ticks — a 4 dies in four ticks. The floor
   * of 4 exists because a 3 rots away before a player can realistically cross
   * the board to reach it, which reads as the game cheating rather than as
   * pressure.
   */
  minSpawn: 4,
  maxSpawn: 9,
  /** Deeper floors spawn richer tiles: minSpawn rises by this per depth. */
  minSpawnPerDepth: 0.35,
} as const;

/**
 * The countdown that gives the game its name.
 *
 * Set `enabled: false` to get static tiles exactly as originally specced.
 * Set `burnout: false` to keep the ticking urgency but stop dead tiles turning
 * into up tiles (see DESIGN.md, open question #1).
 */
export const TILE_DECAY = {
  enabled: true,
  burnout: true,
  /**
   * Seconds per decrement. A bounce takes about 0.9s, so this is roughly "one
   * tick per bounce" — the board decays at the speed you act, which is what
   * makes the pressure feel fair instead of arbitrary.
   */
  interval: 1.35,
  /** Decay rate multiplier once the endgame starts. */
  endgameScale: 1.5,
  /** Stagger initial tick phase so a floor doesn't pulse in lockstep. */
  phaseJitter: 0.8,
} as const;

export const FREEZE = {
  /** Seconds of frozen decay granted by a FREEZE tile. */
  duration: 4.0,
} as const;

/** Depth at which each special tile starts appearing. */
export const SPECIAL_UNLOCK_DEPTH = {
  [TileKind.Time]: 3,
  [TileKind.Boost]: 5,
  [TileKind.Freeze]: 7,
} as const;

/**
 * Spawn weights at generation time. Decay handles the drift toward hostility,
 * so the authored mix stays generous.
 */
export const SPAWN_MIX = {
  number: 0.62,
  up: 0.26,
  /** Remainder goes to whichever specials are unlocked. */
  timeWeight: 0.45,
  boostWeight: 0.35,
  freezeWeight: 0.2,

  /** Down tiles are placed explicitly, not rolled. */
  downTiles: (depth: number) => (depth >= 4 ? 2 : 1),
  /**
   * A down tile is never placed in the ring immediately around your landing
   * point, so descending always requires at least one real traversal.
   */
  downMinDistanceFromEntry: 1.5,
} as const;

export const TIME_TILE_BONUS = 4.0;

// ---------------------------------------------------------------------------
// Scoring & clock
// ---------------------------------------------------------------------------

export const SCORE = {
  /** multiplier = 1 + depth, floored at 1. */
  multiplierPerDepth: 1,
  minMultiplier: 1,

  /** comboMultiplier = 1 + min(streak, comboCap) * comboStep. */
  comboStep: 0.15,
  comboCap: 8,

  /** Flat bonus for descending, before multipliers. */
  descendBonus: 25,
} as const;

export const CLOCK: { matchSeconds: number; endgameSeconds: number; maxSeconds: number } = {
  matchSeconds: 60,
  /** Below this the game enters its endgame presentation state. */
  endgameSeconds: 10,
  /** Hard ceiling so time tiles can't run away with the match. */
  maxSeconds: 120,
};

/**
 * Dev-only match-length override, so the endgame ramp and the score screen can
 * be reached in seconds instead of a full minute.
 *
 * `import.meta.env.DEV` is substituted at build time, so this whole block is
 * dead code in a production bundle — a shipped `?matchSeconds=600` would
 * otherwise be a one-line leaderboard exploit.
 */
export const DEV_OVERRIDES: { tier: QualitySettings['name'] | null } = { tier: null };

export function applyDevOverrides(search: string): void {
  if (!import.meta.env.DEV) return;
  const params = new URLSearchParams(search);

  const seconds = Number(params.get('matchSeconds'));
  if (Number.isFinite(seconds) && seconds >= 3 && seconds <= 600) {
    CLOCK.matchSeconds = seconds;
    CLOCK.endgameSeconds = Math.min(CLOCK.endgameSeconds, Math.max(2, seconds * 0.35));
  }

  const tier = params.get('tier');
  if (tier === 'low' || tier === 'medium' || tier === 'high') DEV_OVERRIDES.tier = tier;
}

/** Honour the OS "reduce motion" setting for shake and screen distortion. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

// ---------------------------------------------------------------------------
// Camera & feel
// ---------------------------------------------------------------------------

export const CAMERA = {
  /** Vertical FOV on a landscape screen. */
  fov: 75,
  /**
   * Minimum field of view along whichever screen axis is *narrower*.
   *
   * A fixed vertical FOV collapses on a tall phone: at 9:19.5 a 75° vertical
   * lens is only ~38° horizontally, so the floor you are supposed to read from
   * the top of your arc no longer fits on screen and the whole plan-then-commit
   * loop stops working. Widening the lens until the narrow axis clears this
   * threshold keeps the game legible in portrait.
   */
  minAxisFov: 66,
  /** Ceiling on the widened FOV, past which the distortion is worse than the
   * cropping it fixes. */
  maxFov: 100,
  near: 0.1,
  far: 220,

  /** Degrees of roll per m/s of lateral velocity. */
  rollPerSpeed: 1.5,
  maxRoll: 14,
  /** Degrees of look-ahead pitch per m/s, so you lean into your movement. */
  pitchPerSpeed: 1.1,
  maxPitch: 12,
  /** How fast roll/pitch chase their targets. */
  leanSmoothing: 7.0,

  /** FOV added at peak impact, degrees. */
  fovPunch: 7.0,
  fovPunchDecay: 6.0,
} as const;

export const FEEL = {
  /** Seconds of frozen time on a normal landing / a perfect one / a descend. */
  hitstopNormal: 0.0,
  hitstopPerfect: 0.045,
  hitstopDescend: 0.11,
  hitstopAscend: 0.08,

  shakeOnLand: 0.12,
  shakeOnPerfect: 0.3,
  shakeOnDescend: 0.85,
  shakeOnAscend: 0.6,
  shakeDecay: 5.5,
  shakeMaxOffset: 0.4,

  /** Baseline shake once the endgame starts. */
  endgameAmbientShake: 0.11,
} as const;

// ---------------------------------------------------------------------------
// Palette
//
// One accent hue per depth, cycling. Reads as a descent rather than a rainbow:
// cool at the surface, hot in the middle, deep violet at the bottom. Swap this
// block for the white-paper/black-ink variant (DESIGN.md open question #2).
// ---------------------------------------------------------------------------

export const PALETTE = {
  background: 0x05060a,
  fog: 0x05060a,

  /** Accent hue in degrees, indexed by depth (wraps). */
  depthHues: [188, 168, 142, 96, 52, 28, 336, 300, 268, 232],

  /** Hue for hostile things (up tiles, burnout, endgame wash). */
  hostileHue: 352,
  /** Hue for the down tile. Always the same so it is instantly readable. */
  downHue: 140,
  /** Hue for time tiles. */
  timeHue: 48,
  /** Hue for boost tiles. */
  boostHue: 292,
  /** Hue for freeze tiles. */
  freezeHue: 196,

  lineSaturation: 0.85,
  lineLightness: 0.62,
  spentLightness: 0.18,
} as const;

// ---------------------------------------------------------------------------
// Rendering quality tiers
// ---------------------------------------------------------------------------

export interface QualitySettings {
  readonly name: 'low' | 'medium' | 'high';
  readonly maxPixelRatio: number;
  readonly bloom: boolean;
  readonly bloomStrength: number;
  readonly particleBudget: number;
  readonly trails: boolean;
  readonly antialias: boolean;
  readonly shockwaves: number;
}

/**
 * Bloom is the difference between "wireframes" and "neon", but it is also the
 * easiest effect in the world to overdo. The threshold has to sit *above* the
 * dark tile fill, or every surface in the scene starts glowing and the image
 * turns to milk — which is exactly what a low threshold did on the first pass.
 */
export const BLOOM = {
  /**
   * Threshold is in the linear working space, where an sRGB "bright neon line"
   * around 0.85 lands near 0.68 — so this sits just under the glowing strokes
   * and well above the dark tile fill.
   */
  threshold: 0.32,
  /**
   * Kept tight. UnrealBloomPass's widest mip smears glow across the entire
   * frame, which lifts the blacks and undoes the "dark void" the art direction
   * depends on. Local glow, not atmosphere.
   */
  radius: 0.3,
} as const;

export const QUALITY: Record<QualitySettings['name'], QualitySettings> = {
  low: {
    name: 'low',
    maxPixelRatio: 1.0,
    bloom: false,
    bloomStrength: 0,
    particleBudget: 120,
    trails: false,
    antialias: false,
    shockwaves: 3,
  },
  medium: {
    name: 'medium',
    maxPixelRatio: 1.5,
    bloom: true,
    bloomStrength: 0.42,
    particleBudget: 320,
    trails: true,
    antialias: false,
    shockwaves: 5,
  },
  high: {
    name: 'high',
    maxPixelRatio: 2.0,
    bloom: true,
    bloomStrength: 0.58,
    particleBudget: 640,
    trails: true,
    antialias: true,
    shockwaves: 8,
  },
};

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export const AUDIO = {
  masterGain: 0.75,
  sfxGain: 0.9,
  musicGain: 0.42,

  /** Pentatonic minor, semitone offsets. Hard to make sound wrong. */
  scale: [0, 3, 5, 7, 10],
  rootMidi: 57, // A3

  /** Music beats per minute at the start of a match, and at zero seconds. */
  bpmStart: 96,
  bpmEnd: 150,
} as const;

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

export const LEADERBOARD = {
  /** How many entries to show. */
  topN: 20,
  maxNameLength: 16,
  /** Give up on a network call after this long, ms. */
  timeoutMs: 8000,
  localStorageKey: 'pogodrop.local.scores.v1',
  playerIdKey: 'pogodrop.playerId.v1',
  playerNameKey: 'pogodrop.playerName.v1',
} as const;
