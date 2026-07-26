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
// Derived so a lazy bounce lasts ~1.35s, peaks ~4.8m above the floor, and
// covers about four and a half tiles. At that apex the lens sees most of the floor; at the bottom
// of the arc it sees barely one tile. That gap is the game: you plan at the top
// and commit at the bottom, and buying altitude buys information.
// ---------------------------------------------------------------------------

export const POGO = {
  /**
   * Lower than earth gravity on purpose. A 30 m/s² bounce was over in 0.9s and
   * only covered a couple of tiles, which made the whole board feel out of
   * reach; the arc is the thinking time, so shortening it removes the game.
   */
  gravity: 21.0,

  /** Apex height above the floor for an uncharged bounce, metres. */
  baseApex: 4.8,

  /**
   * Height the rider falls in from at the start of a run, metres.
   *
   * Starting on the ground mid-bounce threw the player straight into a landing
   * with no idea what was on the board. Dropping in from above opens on a wide
   * establishing shot of the whole floor that closes as you fall — and the fog
   * makes the floor resolve out of the dark on the way down rather than simply
   * being there.
   */
  startDropHeight: 11.0,
  /** Apex multiplier for a charged (well-timed) bounce. */
  chargedApexScale: 1.55,
  /** Apex multiplier for a frame-perfect bounce. */
  perfectApexScale: 1.72,

  /** Distance from the stick's foot up to the rider's eye, metres. */
  riderHeight: 2.2,

  /**
   * Horizontal steering. Still limited — you steer, you do not fly — but a
   * normal bounce now crosses about four tiles and a charged one about five,
   * instead of the one-to-two that made every floor feel like a cage.
   */
  airAccel: 30.0,
  /**
   * Trimmed when the arc was lengthened. Airtime and top speed multiply into
   * reach, so leaving this at 8 turned a longer bounce into a 5.3-tile one that
   * overshot the whole starting floor and spent its time against the soft
   * boundary. Lower speed over a longer arc keeps the generous reach while
   * making the motion float rather than dart.
   */
  airMaxSpeed: 7.0,

  /**
   * Late-arc steering assist.
   *
   * Constant air control makes last-moment corrections physically impossible,
   * not merely hard: with 0.2s left, 30 m/s² moves you 0.6m and a tile is 2m
   * wide, so the reticle correctly refuses to budge. That reads as the game
   * ignoring you rather than as commitment.
   *
   * Control authority therefore ramps up as impact approaches, so a bad read at
   * the top of the arc is always recoverable at the bottom. The same curve is
   * applied inside the landing prediction, so the reticle stays an honest
   * promise rather than an optimistic one.
   */
  lateSteerWindow: 0.5,
  /** Extra acceleration at the moment of impact, as a multiple of airAccel. */
  lateSteerBoost: 2.6,
  /** Extra top speed at the moment of impact, as a fraction of airMaxSpeed. */
  lateSpeedBoost: 0.55,
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
   * also the tile's lifetime in decay ticks — a 5 dies in five ticks. Combined
   * with the decay interval that is 10–23 seconds of life, so a floor ages over
   * a whole visit rather than collapsing into arrows within a few bounces.
   *
   * The floor of this range is the knob that trades variety against decay
   * pressure, because those are the same number: dropping it to 3 buys another
   * distinct digit on the board but also means the shortest-lived tile dies in
   * seven seconds rather than ten. Four is the compromise — six distinct values
   * at the surface, and nothing that rots faster than the tuning the decay rate
   * was set against.
   */
  minSpawn: 4,
  maxSpawn: 9,
  /** Deeper floors spawn richer tiles: minSpawn rises by this per depth. */
  minSpawnPerDepth: 0.3,
  /**
   * The spawn range is never allowed to narrow below this many steps.
   *
   * Without it the depth ramp eats its own variety: `minSpawn` climbs into
   * `maxSpawn` and every tile on the floor spawns as the same digit — by depth
   * 9 the board was two values wide and by depth 10 it was literally all nines.
   * A board of identical numbers has nothing to choose between, which throws
   * away the one decision the player makes on every single bounce.
   */
  minSpread: 4,
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
   * Seconds per decrement — roughly one tick every two bounces. Fast enough
   * that you watch the numbers fall and feel the pressure, slow enough that a
   * floor stays worth farming for a visit rather than turning into a wall of
   * arrows in a few seconds.
   */
  interval: 2.5,

  /**
   * Ceiling on how much of a floor may be UP tiles at once, counting both the
   * ones the generator placed and the ones that burned out.
   *
   * Past this, a tile that reaches zero goes SPENT instead of UP. The board
   * still degrades — those tiles stop being worth anything — but it stops
   * turning into a minefield where every landing costs you a level. Decay
   * should take your opportunities away, not stack up punishment.
   */
  maxUpFraction: 0.45,
  /**
   * The ceiling rises with depth alongside the spawn share, or burnouts on a
   * deep floor would immediately hit a limit the generator had already spent.
   */
  maxUpFractionPerDepth: 0.012,
  maxUpFractionCap: 0.6,
  /** Decay rate multiplier once the endgame starts. */
  endgameScale: 1.35,
  /**
   * Spread of the *first* tick, as a fraction of the interval. 1 means a tile's
   * opening countdown lands anywhere in the interval rather than bunching up.
   */
  phaseJitter: 1.0,
  /**
   * Per-tile variation in the interval itself, ± this fraction.
   *
   * Phase jitter alone is not enough, because every tile then ticks at exactly
   * the same rate: whatever clusters the first tick creates are locked in for
   * the rest of the run, and the floor flashes in visible waves forever. Giving
   * each tile its own slightly different clock lets those clusters drift apart
   * on their own, and means two tiles showing the same digit are not
   * necessarily about to die together.
   */
  intervalJitter: 0.28,
  /**
   * Flash strength when a tile ticks down, 0–1.
   *
   * Deliberately well under the 1.0 a landing or a burnout gets. A decrement is
   * ambient information — dozens happen a second across a deep floor — so it
   * should register as a shimmer, not as an event. At 0.5 it pushed the tile
   * over the bloom threshold and lit up like something had happened.
   */
  tickFlash: 0.22,

  /**
   * Leaving a floor — up *or* down — restores its number tiles.
   *
   * Without this, decay is a ratchet: every floor you have ever visited is
   * strictly worse than when you left, so an UP tile compounds into a spiral
   * you cannot climb out of. Restoring makes the countdown a recurring pressure
   * rather than permanent damage, and keeps a bad bounce survivable.
   *
   * Tiles you *scored* stay spent, which is what stops this being an exploit:
   * a floor's harvestable total only ever goes down, so bouncing down and
   * straight back up cannot farm it. See DESIGN.md.
   */
  resetOnLeave: true,
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
  /**
   * Share of a floor that spawns as UP tiles, by depth.
   *
   * Deeper floors are meant to be more hostile, and until now they were only
   * more *crowded* — the mix was flat, so a depth-10 board was a depth-0 board
   * with more tiles on it. Growing the hazard share is what makes descending a
   * real decision rather than strictly free points: you are trading a bigger
   * multiplier for a board where the safe tiles are harder to string together.
   *
   * The `number` share is whatever is left after this and the specials.
   */
  up: (depth: number) => Math.min(0.44, 0.2 + depth * 0.03),
  /** Share that spawns as specials, once any are unlocked. */
  specials: 0.12,
  /** Remainder goes to whichever specials are unlocked. */
  timeWeight: 0.45,
  boostWeight: 0.35,
  freezeWeight: 0.2,

  /**
   * Floor under the number-tile count, as a fraction of the board.
   *
   * Falls with depth so the rising hazard share above can actually take effect
   * — a flat 35% floor would simply undo it. It stays a floor, though: a board
   * with nothing worth landing on is not difficult, it is just a dead end. In
   * absolute terms the deeper floors still have far more scoring tiles, because
   * they have far more tiles.
   */
  scoringFloor: (depth: number) => Math.max(0.2, 0.35 - depth * 0.015),

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

/**
 * The landing reticle.
 *
 * It answers two questions at once and the sizes below are the compromise
 * between them. The square says *which tile*; the ring closing on it says
 * *when to press*. A wide lead ring makes the timing unmistakable but stops
 * pointing at any particular tile — at 2.7× tile size it spanned three of them,
 * so from the top of an arc you could not tell what you had selected. Keeping
 * the ring tile-scoped makes it read as a lock-on cursor you can steer onto a
 * target, and the timing cue is carried by brightness and spin instead of by
 * sheer size.
 */
/**
 * Mouse aiming.
 *
 * The cursor is a *target*, not a lean. Treating it as a lean meant the reticle
 * showed where physics was taking you rather than where you were pointing, and
 * the response curve made it worse: a cursor a fifth of the way to the screen
 * edge produced ten percent steering authority, so aiming at a neighbouring
 * tile barely moved the reticle at all. It read as lag, or as the game ignoring
 * the mouse.
 *
 * The cursor now projects onto the floor plane and the steering is solved for:
 * given where you are, how fast you are going and how long is left, what
 * acceleration lands you on that point. The reticle converges on the cursor as
 * fast as the physics allows, and when it cannot reach it saturates and gets as
 * close as it can — which is honest rather than mysterious.
 */
export const POINTER_AIM = {
  enabled: true,
  /**
   * Blend from pure targeting toward the raw solution near the end of the arc.
   * Kept at 1: the solved acceleration already saturates when it runs out of
   * time, so no extra shaping is needed.
   */
  authority: 1,
} as const;

export const RETICLE = {
  /** Seconds of lead over which the ring converges on the square. */
  ringLead: 0.55,
  /** Ring diameter at full lead, as a multiple of tile size. */
  ringMaxScale: 1.7,
  /** Ring diameter at touchdown — matches the square, so they meet exactly. */
  ringMinScale: 1.06,

  /** Opacity floor, in effect at the top of the arc where visibility matters most. */
  ringOpacityBase: 0.3,
  /** Extra opacity as impact closes in. */
  ringOpacityGain: 0.38,
  squareOpacityBase: 0.36,
  squareOpacityGain: 0.34,

  /** Degrees per second the ring rotates, scaled up as impact approaches. */
  ringSpin: 22,
  ringSpinGain: 3.5,

  /**
   * Snap animation when the reticle acquires a different tile. Without it the
   * reticle teleports between tiles with no acknowledgement, and the player
   * cannot tell a deliberate re-aim from a jitter.
   */
  lockPulseScale: 0.55,
  lockPulseDecay: 5.5,
} as const;

/**
 * Time dilation while a tip is on screen.
 *
 * A notice that appears mid-arc is unreadable at full speed — you are about to
 * land on something. Slowing the simulation gives the player the arc back.
 *
 * The clock slows with everything else. Keeping it at real time would mean a
 * tip you never asked for costs you several seconds of a sixty-second run,
 * which is a worse trade than the leaderboard impurity of giving them back:
 * tips fire at most once per lifetime, so a returning player gets no dilation
 * at all and a first-timer's score is not competitive anyway.
 */
export const NOTICE_TIME = {
  /**
   * Slowest the simulation runs while a notice is being read.
   *
   * Near-stopped rather than merely slowed. Reading a sentence takes a couple
   * of seconds of *attention*, and at a third speed that was still most of a
   * bounce — so the player was choosing between reading the tip and playing the
   * arc. At a tenth, the whole toast costs well under a second of match clock,
   * which is what makes it affordable to hold it long enough to actually read.
   */
  slowScale: 0.1,
  /**
   * Fraction of the toast's life spent easing *into* slow motion. Stepping the
   * target straight to `slowScale` leaves the damping to absorb the whole jump,
   * which is visibly abrupt on a device that is not hitting 60fps.
   */
  entryFraction: 0.12,
  /**
   * Fraction of the toast's life held at full slow before easing back up.
   * Long, because the player can end it early — the ramp back is a fallback for
   * someone who did not, not the expected path.
   */
  holdFraction: 0.72,
  /** How fast the scale chases its target, per second. */
  smoothing: 4.5,
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

  lineSaturation: 0.82,
  lineLightness: 0.52,
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
  /**
   * High enough that only the brightest strokes bloom at all. Bloom accumulates
   * across everything above the threshold, so a floor full of number tiles adds
   * up far faster than a test scene with three — which is exactly how a setting
   * that looks right in isolation ends up glaring in play.
   */
  threshold: 0.45,
  /**
   * Kept tight. UnrealBloomPass's widest mip smears glow across the entire
   * frame, which lifts the blacks and undoes the "dark void" the art direction
   * depends on. Local glow, not atmosphere.
   */
  radius: 0.28,
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
    bloomStrength: 0.30,
    particleBudget: 320,
    trails: true,
    antialias: false,
    shockwaves: 5,
  },
  high: {
    name: 'high',
    maxPixelRatio: 2.0,
    bloom: true,
    bloomStrength: 0.38,
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

/**
 * The three pieces of music, all built from the same handful of synth voices.
 *
 * Splitting them by tempo, tone and gain rather than by having three separate
 * engines is what keeps this cheap: the scheduler, the scale and the voices are
 * shared, and a track is just a pattern function plus these three numbers.
 */
export const MUSIC_TRACKS = {
  /** In-match. Tempo is interpolated bpmStart → bpmEnd by endgame intensity. */
  game: { bpm: 96, cutoff: 1400, gain: 0.42 },
  /**
   * Title. Upbeat and groovy: four-on-the-floor, a backbeat clap and a
   * syncopated bass. Brighter than the match music on purpose — the menu should
   * sound like an invitation, not like the pressure you are about to be under.
   */
  title: { bpm: 112, cutoff: 4600, gain: 0.4 },
  /**
   * Post-run. Chill: no drums to speak of, long pads, a sparse melody. Quieter
   * too, because it plays under a screen people are reading.
   */
  over: { bpm: 70, cutoff: 1900, gain: 0.32 },
} as const;

export type MusicTrack = keyof typeof MUSIC_TRACKS;

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
