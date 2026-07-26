import * as THREE from 'three';
import { AudioEngine } from './core/Audio';
import {
  BOUNCE_TIMING,
  CLOCK,
  FLOOR,
  PALETTE,
  POGO,
  POINTER_AIM,
  NOTICE_TIME,
  SIM,
  TileKind,
  prefersReducedMotion,
} from './core/Config';
import { Input } from './core/Input';
import { clamp, clamp01, damp, formatScore, lerp, smoothstep } from './core/MathUtil';
import { Coach, type SeenStore } from './game/Coach';
import { GameState, type GameEvent } from './game/GameState';
import { steerAccelAt } from './game/Player';
import { Leaderboard } from './net/Leaderboard';
import { Particles, Shockwaves } from './render/Effects';
import { createGlyphAtlas } from './render/GlyphAtlas';
import { Guides } from './render/Guides';
import { backgroundColor, depthHue, hsl } from './render/Palette';
import { PlayerRig } from './render/PlayerRig';
import { Renderer } from './render/Renderer';
import { TileField } from './render/TileField';
import { HUD } from './ui/HUD';
import { Notifications } from './ui/Notifications';
import { Screens } from './ui/Screens';
import { Stats } from './ui/Stats';

type AppPhase = 'title' | 'playing' | 'paused' | 'over';

const STEP = 1 / SIM.hz;

/** Best guess at a touch device before any input has arrived. */
const COARSE_POINTER =
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

/**
 * Wires the simulation to everything that presents it.
 *
 * The split matters: `GameState` advances on a fixed 120Hz step and knows
 * nothing about three.js, the DOM or WebAudio; this class drains its event
 * queue once per rendered frame and turns each event into sound, particles,
 * screen shake and DOM. Feel can therefore be retuned right up to the deadline
 * without any risk of changing what actually happened in a run.
 */
export class App {
  /** Public for the dev-only inspection handle installed by main.ts. */
  readonly game = new GameState();
  /** Public for the dev handle and the headless music test. */
  readonly audio = new AudioEngine();
  /** Public for the dev handle and the headless tests. */
  readonly leaderboard = new Leaderboard();

  /** Public for the dev-only inspection handle installed by main.ts. */
  readonly input: Input;
  private readonly renderer: Renderer;
  /** Public for the dev-only inspection handle installed by main.ts. */
  readonly rig: PlayerRig;
  private readonly hud: HUD;
  /** Public for the dev handle and the headless tests. */
  readonly screens: Screens;
  private readonly stats: Stats;
  /** Public for the dev-only inspection handle installed by main.ts. */
  readonly notifications: Notifications;
  /** Public for the dev handle and the headless tests. */
  readonly coach = new Coach(new LocalSeenStore());

  /**
   * Scales every camera shake, chromatic separation and screen flash. Motion
   * sensitivity is a real accessibility need and this game is built almost
   * entirely out of the things that trigger it.
   */
  private readonly motionScale: number;

  private readonly fieldMain: TileField;
  private readonly fieldDissolving: TileField;
  private readonly shockwaves: Shockwaves;
  private readonly particles: Particles;
  /** Public for the dev-only inspection handle installed by main.ts. */
  readonly guides = new Guides();

  private phase: AppPhase = 'title';
  private accumulator = 0;
  private lastFrame = 0;
  private clock = 0;

  /**
   * Simulated time, in seconds. Distinct from wall time because notices dilate
   * the simulation — and input timestamps are taken against *this* clock, so a
   * dilated bounce window stays exactly as wide in simulated seconds as it is
   * at full speed.
   */
  private simClock = 0;
  private timeScale = 1;
  private flash = 0;
  private endgameIntensity = 0;
  private perfectFlash = 0;

  private readonly accent = new THREE.Color();
  private readonly bgColor = new THREE.Color();
  private readonly tint = new THREE.Color(1, 1, 1);
  private readonly scratchVec = new THREE.Vector3();
  private readonly steerRight = new THREE.Vector3();
  private readonly steerForward = new THREE.Vector3();
  private readonly landing = { x: 0, z: 0 };
  private readonly aimTarget = new THREE.Vector3();
  private readonly aimRay = new THREE.Vector3();
  private readonly aimOrigin = new THREE.Vector3();
  /** Steering command for this frame, in world space. */
  private readonly steerWorld = { x: 0, z: 0 };
  /**
   * The world point currently being aimed at, latched until the input moves.
   *
   * Re-projecting the cursor every frame looks right and is not: the camera is
   * falling, so the same screen pixel maps to a different world point each
   * frame, and a player holding perfectly still watches the reticle walk off
   * the tile they picked. The target is therefore a world position that only
   * changes when the player actually asks for it to.
   */
  private aimLatch: { x: number; z: number } | null = null;

  /** The latched aim point, for the dev handle and the headless aim test. */
  get aimPoint(): { x: number; z: number } | null {
    return this.aimLatch;
  }

  private aimLatchSeq = -1;
  private aimLatchFloorY = Number.NaN;

  private submitted = false;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.input = new Input(canvas);
    this.rig = new PlayerRig(window.innerWidth / Math.max(1, window.innerHeight));
    this.renderer = new Renderer(canvas, this.rig.camera);

    const atlas = createGlyphAtlas(this.renderer.quality.name === 'low' ? 128 : 256);
    const fog = new THREE.Color(PALETTE.fog);

    this.fieldMain = new TileField(atlas, fog, FOG_DENSITY);
    this.fieldDissolving = new TileField(atlas, fog, FOG_DENSITY);
    this.shockwaves = new Shockwaves(this.renderer.quality);
    this.particles = new Particles(this.renderer.quality, this.renderer.devicePixelRatioUsed);

    this.renderer.scene.add(
      this.rig.group,
      this.fieldMain.mesh,
      this.fieldDissolving.mesh,
      this.shockwaves.mesh,
      this.particles.points,
      this.guides.group,
    );

    this.motionScale = prefersReducedMotion() ? 0.25 : 1;
    this.hud = new HUD(uiRoot);
    this.notifications = new Notifications(uiRoot);
    this.stats = new Stats(uiRoot);
    this.screens = new Screens(uiRoot, {
      onPlay: () => this.startRun(),
      onResume: () => this.resume(),
      onRestart: () => this.startRun(),
      onQuit: () => this.toTitle(),
      onSubmit: (name) => void this.submitScore(name),
      onRefreshBoard: () => void this.refreshBoard(),
      onToggleSound: (on) => this.audio.setMuted(!on),
    });

    this.input.setClockSource(() => this.simClock);
    this.input.onAnyInput.add(() => void this.audio.unlock());
    // A click, tap or bounce key ends the tip on screen. The press still flows
    // through to the bounce as normal — taking the input away to pay for the
    // dismissal would mean the prompt cost you the thing it invited you to do.
    this.input.onConfirm.add(() => this.notifications.dismiss());
    this.notifications.onPresent = (id) => this.coach.markPresented(id);
    this.listenForFirstGesture();
    this.input.onPause.add(() => {
      // Escape backs out of the guide or the leaderboard first; only then does
      // it mean "pause".
      if (this.screens.handleBack()) return;
      this.togglePause();
    });

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('orientationchange', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.phase === 'playing') this.pause();
    });

    // Boot straight into the same state Quit lands on, rather than a
    // hand-rolled copy of it. The copy had already drifted: it never asked for
    // the title music, so the menu was silent on first load and scored on
    // return from a run.
    this.toTitle();
    installFavicon();
  }

  /**
   * Unlock WebAudio on the first gesture *anywhere*, not just on the canvas.
   *
   * `Input` only listens on the play surface, and the title panel sits on top
   * of it — so clicking Play, or How to play, or Leaderboard never reached it,
   * and a player whose first action was a button (which is to say: every
   * player) got a silent menu. Capture phase, so this runs before the button's
   * own handler and the title track is already going by the time anything else
   * happens.
   *
   * Kept attached rather than `once`, because the first attempt can still be
   * refused; `unlock()` is a pair of cheap checks once the context is running.
   */
  private listenForFirstGesture(): void {
    const unlock = () => void this.audio.unlock();
    for (const type of ['pointerdown', 'keydown', 'touchstart'] as const) {
      window.addEventListener(type, unlock, { capture: true, passive: true });
    }
  }

  // -- lifecycle -----------------------------------------------------------

  start(): void {
    this.lastFrame = performance.now() / 1000;
    requestAnimationFrame(this.frame);
  }

  private startRun(): void {
    void this.audio.unlock();
    this.game.start();
    this.submitted = false;
    this.accumulator = 0;
    this.timeScale = 1;
    this.flash = 0;
    this.endgameIntensity = 0;
    this.perfectFlash = 0;
    this.rig.reset();
    this.particles.clear();
    this.coach.reset();
    this.notifications.clear();
    this.hud.resetScore();
    this.hud.setEndgame(false);
    this.hud.setVisible(true);
    this.guides.setVisible(true);
    this.guides.resetLock();
    this.setAccent(0);
    this.screens.show(null);
    this.input.setEnabled(true);
    this.phase = 'playing';
    this.audio.startMusic('game');
  }

  private toTitle(): void {
    this.phase = 'title';
    this.notifications.clear();
    // The menu gets its own track rather than silence. It may not actually
    // sound until the first input — no browser starts an AudioContext without
    // a gesture — but the engine remembers the request and picks it up there.
    this.audio.startMusic('title');
    this.input.setEnabled(false);
    this.hud.setVisible(false);
    this.guides.setVisible(false);
    this.particles.clear();
    this.game.prepareIdle();
    this.setAccent(0);
    this.screens.setPersonalBest(this.leaderboard.personalBest);
    this.screens.show('title');
  }

  private togglePause(): void {
    if (this.phase === 'playing') this.pause();
    else if (this.phase === 'paused') this.resume();
  }

  private pause(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.notifications.clear();
    this.input.setEnabled(false);
    this.audio.stopMusic();
    this.screens.show('pause');
  }

  private resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'playing';
    this.input.setEnabled(true);
    this.accumulator = 0;
    this.lastFrame = performance.now() / 1000;
    this.screens.show(null);
    this.audio.startMusic('game');
  }

  private onResize(): void {
    this.renderer.resize();
    this.rig.setAspect(window.innerWidth / Math.max(1, window.innerHeight));
    this.particles.setPixelRatio(this.renderer.devicePixelRatioUsed);
  }

  // -- main loop -----------------------------------------------------------

  private readonly frame = (nowMs: number): void => {
    requestAnimationFrame(this.frame);

    const now = nowMs / 1000;
    const raw = now - this.lastFrame;
    this.lastFrame = now;
    // Clamp so a backgrounded tab returning does not simulate a thousand steps.
    const dt = clamp(raw, 0, SIM.maxFrameDelta);

    // Notices dilate time so they can be read mid-arc. The scale is eased
    // rather than stepped, so entering and leaving slow motion is a ramp.
    this.timeScale = damp(this.timeScale, this.targetTimeScale(), NOTICE_TIME.smoothing, dt);
    const simDt = dt * this.timeScale;
    this.clock += simDt;

    this.input.update();

    if (this.phase === 'playing') {
      this.game.drainHitstop(dt);
      this.simulate(simDt);
      this.game.drainEvents(this.handleEvent);
      // `touchDetected` only flips once a finger has actually landed on the
      // canvas, and the first notice fires before that — so a phone was being
      // told to "click". The media query is the initial guess; a real touch
      // still wins if the device somehow reports otherwise.
      const touch = this.input.touchDetected || COARSE_POINTER;
      this.coach.touchMode = touch;
      this.notifications.touchMode = touch;
      this.coach.update(simDt, this.game, this.notifications.busy);
      this.notifications.push(this.coach.drain());
    } else if (this.phase === 'title') {
      this.game.stepIdle(simDt);
    }

    // Reading time is real time: the toast must not linger just because the
    // world slowed down for it.
    this.notifications.update(dt);
    this.present(simDt, dt);
    this.renderer.render();

    this.stats.update(dt, this.renderer.renderer, {
      tier: this.renderer.quality.name,
      dpr: this.renderer.devicePixelRatioUsed.toFixed(2),
      phase: this.phase,
      depth: this.game.depth,
      scale: this.timeScale.toFixed(2),
      eye: (this.game.player.eyeY - this.game.floor.y).toFixed(2),
      vy: this.game.player.vy.toFixed(1),
      flash: this.flash.toFixed(2),
      endg: this.endgameIntensity.toFixed(2),
      shake: this.game.shake.toFixed(2),
    });
  };

  /**
   * Slow motion while a notice is up, easing back to full speed over the second
   * half of its life so play resumes before the toast leaves.
   */
  private targetTimeScale(): number {
    if (this.phase !== 'playing') return 1;
    const progress = this.notifications.readingProgress();
    if (progress === null) return 1;

    // A full envelope: ease down, hold, ease back up. Both ends are shaped
    // here rather than left to the damping, so the ramp is smooth even when
    // the frame rate is too low for damping to hide a step.
    const entered = smoothstep(0, NOTICE_TIME.entryFraction, progress);
    const released = smoothstep(NOTICE_TIME.holdFraction, 1, progress);
    return lerp(1, NOTICE_TIME.slowScale, entered * (1 - released));
  }

  /**
   * Resolve this frame's steering into world space.
   *
   * The mouse aims at a point; everything else leans in a direction. Those are
   * genuinely different inputs and collapsing them into one was what made the
   * cursor feel disconnected from the reticle.
   */
  private computeSteer(): void {
    // Lean vector first — the fallback, and what the touch latch is derived
    // from before it is latched.
    this.steerWorld.x =
      this.steerRight.x * this.input.steer.x + this.steerForward.x * this.input.steer.y;
    this.steerWorld.z =
      this.steerRight.z * this.input.steer.x + this.steerForward.z * this.input.steer.y;

    if (!POINTER_AIM.enabled) return;

    const floorY = this.game.floor.y;
    // A change of floor invalidates the latch outright: different height,
    // different extent, different grid.
    if (this.aimLatchFloorY !== floorY) {
      this.aimLatch = null;
      this.aimLatchFloorY = floorY;
    }
    const inputMoved = this.input.aimSeq !== this.aimLatchSeq;

    const aim = this.input.getPointerAim();
    if (aim) {
      // Mouse: the cursor is an absolute position, so a move re-projects it.
      if ((inputMoved || this.aimLatch === null) && this.projectToFloor(aim.x, aim.y)) {
        this.aimLatch = { x: this.aimTarget.x, z: this.aimTarget.z };
        this.aimLatchSeq = this.input.aimSeq;
      }
    } else if (this.input.lastScheme === 'touch') {
      // Touch is a relative drag, so there is no cursor to project. Instead,
      // the moment the finger stops moving, whatever the drag was steering
      // toward becomes the target and holds — which gives the thumb the same
      // "it stays where I put it" as the mouse, without giving up the relative
      // gesture that suits a thumb in the first place.
      if (inputMoved) {
        this.aimLatch = null;
        this.aimLatchSeq = this.input.aimSeq;
      } else if (this.aimLatch === null) {
        const t = this.game.player.predictLanding(
          this.steerWorld.x,
          this.steerWorld.z,
          this.landing,
        );
        if (Number.isFinite(t)) this.aimLatch = { x: this.landing.x, z: this.landing.z };
      }
    } else {
      // Keyboard and gamepad stay pure leans. "Hold a direction and keep
      // going" is what those controls mean, and latching would stop the player
      // dead the moment they reached the tile they were heading for.
      this.aimLatch = null;
      this.aimLatchSeq = this.input.aimSeq;
      return;
    }

    if (this.aimLatch) this.solveSteerToward(this.aimLatch.x, this.aimLatch.z);
  }

  /**
   * Cast the cursor through the camera onto the active floor plane. Returns
   * false when the ray runs parallel to the floor, which the straight-down
   * camera makes effectively impossible but is cheap to guard.
   */
  private projectToFloor(nx: number, ny: number): boolean {
    const camera = this.rig.camera;
    camera.updateMatrixWorld();
    camera.getWorldPosition(this.aimOrigin);

    this.aimRay.set(nx * 2 - 1, -(ny * 2 - 1), 0.5).unproject(camera).sub(this.aimOrigin);
    if (Math.abs(this.aimRay.y) < 1e-4) return false;

    const floor = this.game.floor;
    const t = (floor.y - this.aimOrigin.y) / this.aimRay.y;
    if (t <= 0) return false;

    this.aimTarget.copy(this.aimRay).multiplyScalar(t).add(this.aimOrigin);
    // Aiming past the rim would ask for a landing the containment will refuse.
    const half = floor.halfExtent;
    this.aimTarget.x = clamp(this.aimTarget.x, -half, half);
    this.aimTarget.z = clamp(this.aimTarget.z, -half, half);
    return true;
  }

  /**
   * Solve for the steering that lands the rider on a world point.
   *
   * From `target = p + v·t + ½·a·t²`, the required acceleration is
   * `a = 2(target − p − v·t) / t²`. Solving analytically rather than running a
   * proportional controller on the predicted landing avoids the oscillation a
   * feedback loop would have, since the prediction already depends on the steer
   * being chosen. Drag and the speed cap make it approximate, but it is
   * recomputed every frame from live state, so the residual corrects itself.
   */
  private solveSteerToward(targetX: number, targetZ: number): void {
    const player = this.game.player;
    const t = player.timeToImpact();

    if (!Number.isFinite(t) || t <= 1e-3) {
      this.steerWorld.x = 0;
      this.steerWorld.z = 0;
      return;
    }

    const accel = steerAccelAt(t);
    const ax = (2 * (targetX - player.x - player.vx * t)) / (t * t);
    const az = (2 * (targetZ - player.z - player.vz * t)) / (t * t);

    let sx = (ax / accel) * POINTER_AIM.authority;
    let sz = (az / accel) * POINTER_AIM.authority;
    // Saturate rather than exceed what the rider can actually do — this is what
    // makes an unreachable tile read as "as close as possible" instead of a lie.
    const len = Math.hypot(sx, sz);
    if (len > 1) {
      sx /= len;
      sz /= len;
    }
    this.steerWorld.x = sx;
    this.steerWorld.z = sz;
  }

  private simulate(dt: number): void {
    this.accumulator += dt;

    // Steering is resolved through the camera's own basis, so a rolled or
    // leaning view still moves you where the screen says it will.
    this.rig.camera.updateMatrixWorld();
    const m = this.rig.camera.matrixWorld.elements;
    this.steerRight.set(m[0]!, 0, m[2]!);
    this.steerForward.set(-m[4]!, 0, -m[6]!);
    if (this.steerRight.lengthSq() < 1e-6) this.steerRight.set(1, 0, 0);
    if (this.steerForward.lengthSq() < 1e-6) this.steerForward.set(0, 0, 1);
    this.steerRight.normalize();
    this.steerForward.normalize();

    this.computeSteer();
    const steerX = this.steerWorld.x;
    const steerZ = this.steerWorld.z;

    // Every sub-step advances the simulated clock, and input ages are measured
    // against it. Using wall time here would smear timing accuracy by a whole
    // frame — a third of the perfect window — and would break outright under
    // dilation, where wall seconds and simulated seconds are not the same unit.
    let steps = 0;

    while (this.accumulator >= STEP && steps < SIM.maxStepsPerFrame) {
      this.simClock += STEP;
      const age = this.input.peekBounceAge(this.simClock);
      const consumed = this.game.step(STEP, this.simClock, steerX, steerZ, age);
      if (consumed) this.input.consumeBounce();
      this.accumulator -= STEP;
      steps++;
    }

    if (steps >= SIM.maxStepsPerFrame) this.accumulator = 0;
    this.input.expireBounce(this.simClock, BOUNCE_TIMING.inputBuffer);
  }

  // -- events --------------------------------------------------------------

  private readonly handleEvent = (e: GameEvent): void => {
    this.coach.onEvent(e);
    switch (e.type) {
      case 'land':
        this.onLand(e);
        break;
      case 'score':
        this.onScore(e);
        break;
      case 'descend':
        this.onDescend(e);
        break;
      case 'ascend':
        this.onAscend(e);
        break;
      case 'burnout':
        this.audio.burnout(e.count);
        break;
      case 'gainTime':
        this.audio.gainTime();
        this.celebratePickup(
          `+${e.amount} SECONDS`,
          'time',
          e.x,
          e.z,
          hsl(PALETTE.timeHue, 0.9, 0.62).clone(),
        );
        break;
      case 'boost':
        this.audio.boost();
        this.celebratePickup(
          `MULTIPLIER ×${e.multiplier}`,
          'boost',
          e.x,
          e.z,
          hsl(PALETTE.boostHue, 0.85, 0.66).clone(),
        );
        break;
      case 'freeze':
        this.audio.freeze();
        this.celebratePickup(
          'EVERYTHING FROZE',
          'freeze',
          e.x,
          e.z,
          hsl(PALETTE.freezeHue, 0.75, 0.7).clone(),
        );
        break;
      case 'secondTick':
        this.onSecondTick(e.secondsLeft);
        break;
      case 'endgame':
        this.flash = Math.max(this.flash, 0.2);
        this.game.addShake(0.5);
        break;
      case 'gameover':
        this.onGameOver();
        break;
      default:
        break;
    }
  };

  private onLand(e: Extract<GameEvent, { type: 'land' }>): void {
    const quality = e.quality === 'perfect' ? 2 : e.quality === 'charged' ? 1 : 0;
    this.audio.bounce(clamp(e.speed / 14, 0.3, 1.5), quality, this.game.player.perfectStreak);
    this.rig.punch(clamp(e.speed / 16, 0.25, 1.4));

    const floor = this.game.floor;
    const color = this.accentFor(e.kind);
    const strength = clamp01(e.speed / 22);

    this.ring(e.x, e.z, floor.tileSize * (1.6 + strength * 2.4), 0.42, color);

    const count = Math.round(lerp(4, 16, strength) * (quality === 2 ? 1.8 : 1));
    this.particles.burst(e.x, floor.y, e.z, count, 3 + strength * 5, color, 0.55, 2.4);

    if (e.quality === 'perfect') {
      const streak = this.game.player.perfectStreak;
      // Escalates with the streak instead of repeating. A perfect is the only
      // thing in the game earned purely by timing, and the fifth one in a row
      // should not look exactly like the first.
      const heat = clamp01((streak - 1) / 7);

      this.audio.perfect(streak);
      this.perfectFlash = 1;
      this.flash = Math.max(this.flash, 0.07 + heat * 0.08);
      this.rig.punch(0.5 + heat * 0.7);
      this.game.addShake(0.06 + heat * 0.1);
      this.hud.celebratePerfect(streak);

      // Two rings travelling at different speeds read as a shockwave; one reads
      // as a circle.
      this.ring(e.x, e.z, floor.tileSize * (4.2 + heat * 3), 0.55, this.accent, 0.045);
      this.ring(e.x, e.z, floor.tileSize * (2.1 + heat * 1.5), 0.3, WHITE, 0.075);
      this.particles.burst(
        e.x,
        floor.y,
        e.z,
        Math.round(22 + heat * 34),
        6 + heat * 5,
        this.accent,
        0.85,
        3.0,
        0.55,
      );
    }
  }

  private onScore(e: Extract<GameEvent, { type: 'score' }>): void {
    this.audio.score(e.value, this.game.player.perfectStreak);
    const total = Math.round(e.amount);
    this.popupAt(`+${formatScore(total)}`, e.x, e.z, total >= 100 ? 'big' : 'normal');
    this.particles.burst(
      e.x,
      this.game.floor.y,
      e.z,
      10,
      4.5,
      this.accent,
      0.7,
      2.2,
    );
  }

  private onDescend(e: Extract<GameEvent, { type: 'descend' }>): void {
    this.audio.descend(e.depth);
    this.audio.multiplierUp(e.multiplier);
    this.setAccent(e.depth);
    this.guides.resetLock();
    this.flash = Math.max(this.flash, 0.1);

    // Gaining a multiplier is the biggest thing that happens in a run — it is
    // worth more than any single tile — so it gets the loudest moment: a huge
    // centred numeral, a triple shockwave, and the deepest hitstop in the game.
    this.hud.celebrateMultiplier(e.multiplier);
    this.popupAt(`×${e.multiplier}`, e.x, e.z, 'mult');

    const y = this.game.dissolving?.y ?? this.game.floor.y;
    const downColor = hsl(PALETTE.downHue, 0.9, 0.6).clone();
    this.ring(e.x, e.z, 30, 1.0, downColor, 0.025);
    this.ring(e.x, e.z, 18, 0.7, downColor, 0.045);
    this.ring(e.x, e.z, 9, 0.45, WHITE, 0.07);
    this.particles.burst(e.x, y, e.z, 90, 10, downColor, 1.4, 3.2, 0.85);
  }

  private onAscend(e: Extract<GameEvent, { type: 'ascend' }>): void {
    this.audio.ascend();
    this.setAccent(e.depth);
    this.guides.resetLock();
    const hostile = hsl(PALETTE.hostileHue, 0.82, 0.55).clone();
    this.popupAt(`×${e.multiplier}`, e.x, e.z, 'hostile');
    this.ring(e.x, e.z, 16, 0.7, hostile, 0.05);
    this.ring(e.x, e.z, 7, 0.4, hostile, 0.085);
    this.particles.burst(e.x, this.game.floor.y, e.z, 55, 7.5, hostile, 1.0, 2.6, 0.9);

    // Only when it actually cost something. Bouncing off an UP tile on the top
    // floor takes nothing, and a fanfare for nothing teaches the wrong lesson.
    if (e.from > 0) {
      this.hud.celebrateMultiplier(e.multiplier, false);
      this.flash = Math.max(this.flash, 0.11);
    }
  }

  private onSecondTick(secondsLeft: number): void {
    this.hud.pulseClock();
    this.audio.tick(secondsLeft);
    if (secondsLeft <= 5 && secondsLeft > 0) this.hud.bigCount(secondsLeft);
  }

  private onGameOver(): void {
    this.phase = 'over';
    this.notifications.clear();
    this.audio.gameOver();
    this.audio.startMusic('over');
    this.input.setEnabled(false);
    this.hud.setVisible(false);
    this.guides.setVisible(false);
    this.flash = 0.6;
    this.screens.showSummary(this.game.summary, this.leaderboard.getStoredName());
    this.screens.show('over');
    this.screens.setPersonalBest(this.leaderboard.personalBest);
  }

  // -- presentation --------------------------------------------------------

  /**
   * @param dt simulated seconds — drives everything in the world
   * @param realDt wall seconds — drives the HUD, which should not crawl in
   * slow motion
   */
  private present(dt: number, realDt: number): void {
    const game = this.game;
    const floor = game.floor;

    this.perfectFlash = Math.max(0, this.perfectFlash - dt * 3.4);
    this.flash = Math.max(0, this.flash - dt * 2.6);

    const endgameTarget = game.endgame && this.phase === 'playing' ? 1 : 0;
    const urgency = game.endgame
      ? clamp01(1 - game.timeLeft / CLOCK.endgameSeconds)
      : 0;
    this.endgameIntensity = lerp(
      this.endgameIntensity,
      endgameTarget * (0.45 + urgency * 0.55),
      Math.min(1, dt * 3),
    );

    this.rig.update(
      dt,
      game.player,
      game.shake * this.motionScale,
      this.endgameIntensity * this.motionScale,
    );
    this.rig.setAccent(this.accent);

    this.fieldMain.sync(floor, this.clock, game.multiplier + 1);
    if (game.dissolving) {
      this.fieldDissolving.setVisible(true);
      this.fieldDissolving.sync(game.dissolving, this.clock, game.multiplier);
    } else {
      this.fieldDissolving.setVisible(false);
    }

    // Everything glows a little harder as the clock runs out.
    const brightness = 1 + this.endgameIntensity * 0.3;
    this.fieldMain.setBrightness(brightness);
    this.fieldDissolving.setBrightness(brightness);

    this.shockwaves.update(this.clock);
    this.particles.update(dt, POGO.gravity * 0.45);

    this.guides.updateHorizon(floor.y, this.accent);

    if (this.phase === 'playing') {
      const t = game.player.predictLanding(
        this.steerWorld.x,
        this.steerWorld.z,
        this.landing,
      );
      this.guides.update(
        floor,
        this.landing.x,
        this.landing.z,
        game.player.x,
        game.player.y,
        game.player.z,
        t,
        this.accent,
        this.perfectFlash,
        this.clock,
      );
      if (this.guides.consumeLockChanged()) this.audio.lockTick();
      const preview = game.previewGeometry;
      this.guides.updatePreview(preview.side, preview.extent, preview.y, this.accent);
      // The floor below fades in as you climb, so the hint appears exactly when
      // you have the altitude to act on it.
      const altitude = clamp01((game.player.height - POGO.baseApex * 0.35) / POGO.baseApex);
      this.guides.setPreviewOpacity(0.05 + altitude * 0.16);
    }

    backgroundColor(this.endgameIntensity, this.bgColor);
    this.renderer.setClearColor(this.bgColor);
    this.fieldMain.setFogColor(this.bgColor);
    this.fieldDissolving.setFogColor(this.bgColor);

    this.tint.setRGB(
      1 + this.endgameIntensity * 0.16,
      1 - this.endgameIntensity * 0.12,
      1 - this.endgameIntensity * 0.1,
    );
    this.renderer.setGrade(
      0.34 + this.endgameIntensity * 0.3,
      this.endgameIntensity * 0.85 * this.motionScale,
      this.tint,
      this.flash * this.motionScale,
    );
    this.renderer.setBloomStrength(
      this.renderer.quality.bloomStrength * (1 + this.endgameIntensity * 0.5),
    );

    this.hud.setEndgame(game.endgame && this.phase === 'playing');
    this.hud.update(
      realDt,
      game.timeLeft,
      game.score,
      game.multiplier,
      game.depth,
      game.player.perfectStreak,
    );
    if (this.input.touchDetected) this.hud.updateTouchStick(this.input);

    this.audio.setMusicState(game.depth, this.endgameIntensity, this.timeScale);
  }

  // -- helpers -------------------------------------------------------------

  private setAccent(depth: number): void {
    hsl(depthHue(depth), PALETTE.lineSaturation, PALETTE.lineLightness, this.accent);
    this.hud.setAccent(this.accent);
  }

  private accentFor(kind: TileKind): THREE.Color {
    switch (kind) {
      case TileKind.Up:
        return hsl(PALETTE.hostileHue, 0.82, 0.55).clone();
      case TileKind.Down:
        return hsl(PALETTE.downHue, 0.9, 0.6).clone();
      default:
        return this.accent.clone();
    }
  }

  /**
   * The full fanfare for grabbing a powerup.
   *
   * These are rare, they never come back, and two of them are worth going a
   * long way out of your way for. A small ring and a floating label undersold
   * that badly next to the fireworks a descent already gets.
   */
  private celebratePickup(
    label: string,
    tone: 'time' | 'boost' | 'freeze',
    x: number,
    z: number,
    color: THREE.Color,
  ): void {
    this.hud.celebratePickup(label, tone);
    this.popupAt(label.split(' ')[0] ?? label, x, z, 'big');
    this.flash = Math.max(this.flash, 0.13);
    this.rig.punch(0.85);
    this.game.addShake(0.14);

    this.ring(x, z, 22, 0.85, color, 0.03);
    this.ring(x, z, 11, 0.55, color, 0.055);
    this.ring(x, z, 5, 0.32, WHITE, 0.09);
    this.particles.burst(x, this.game.floor.y, z, 55, 8.5, color, 1.1, 2.9, 0.7);
  }

  private ring(
    x: number,
    z: number,
    radius: number,
    duration: number,
    color: THREE.Color,
    thickness = 0.1,
  ): void {
    this.shockwaves.spawn(x, this.game.floor.y, z, radius, duration, color, this.clock, thickness);
  }

  private popupAt(
    text: string,
    x: number,
    z: number,
    variant: 'normal' | 'hostile' | 'big' | 'mult' = 'normal',
  ): void {
    this.scratchVec.set(x, this.game.floor.y + FLOOR.floorDrop * 0.06, z);
    this.hud.popup(text, this.scratchVec, this.rig.camera, variant);
  }

  // -- leaderboard ---------------------------------------------------------

  private async submitScore(name: string): Promise<void> {
    if (this.submitted) return;
    this.screens.setSubmitState('sending');
    const result = await this.leaderboard.submit(name, this.game.summary);
    if (result.ok) {
      this.submitted = true;
      this.screens.setSubmitState(
        'done',
        result.source === 'local' ? 'Saved on this device.' : 'You are on the board.',
        result.source === 'local' ? 'Saved' : 'Posted!',
      );
    } else {
      this.screens.setSubmitState('failed', result.error);
    }
    await this.refreshBoard();
    this.screens.setPersonalBest(this.leaderboard.personalBest);
  }

  private async refreshBoard(): Promise<void> {
    const result = await this.leaderboard.top();
    this.screens.showBoard(result);
  }
}

const WHITE = new THREE.Color(1, 1, 1);

/**
 * Remembers which tips a player has already been shown, across runs and across
 * sessions. A jam game that re-teaches you the charged bounce on your ninth
 * attempt is worse than one that never taught you at all.
 */
class LocalSeenStore implements SeenStore {
  private static readonly KEY = 'pogodrop.coach.v1';
  private readonly counts: Record<string, number>;

  constructor() {
    this.counts = LocalSeenStore.load();
  }

  private static load(): Record<string, number> {
    try {
      // `?coach=reset` forgets every tip, so they can be seen again.
      //
      // Not a dev-only override, deliberately. Every tip has a lifetime budget
      // of one or two shows *per device*, which means anyone who has played a
      // few times — the developer most of all — has permanently exhausted the
      // entire teaching system and cannot review it without clearing site data
      // by hand. It cannot be abused: it only makes the game more talkative.
      if (new URLSearchParams(location.search).get('coach') === 'reset') {
        localStorage.removeItem(LocalSeenStore.KEY);
        return {};
      }
      const raw = localStorage.getItem(LocalSeenStore.KEY);
      if (!raw) return {};
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return {};
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      }
      return out;
    } catch {
      return {};
    }
  }

  count(id: string): number {
    return this.counts[id] ?? 0;
  }

  record(id: string): void {
    this.counts[id] = this.count(id) + 1;
    try {
      localStorage.setItem(LocalSeenStore.KEY, JSON.stringify(this.counts));
    } catch {
      /* Private browsing: tips simply repeat next session. */
    }
  }
}

/**
 * Draw the favicon at runtime rather than shipping an .ico. Keeps the "no image
 * files anywhere" claim honest, and silences the 404 browsers fire when a page
 * declares no icon.
 */
function installFavicon(): void {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  ctx.fillStyle = '#05060a';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = '#38e8ff';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 6;

  // Three descending chevrons: the DOWN tile, which is the game in one mark.
  for (let i = 0; i < 3; i++) {
    const y = 16 + i * 15;
    ctx.beginPath();
    ctx.moveTo(16, y);
    ctx.lineTo(32, y + 11);
    ctx.lineTo(48, y);
    ctx.stroke();
  }

  const link = document.createElement('link');
  link.rel = 'icon';
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
  document.head.appendChild(link);
}

/**
 * Fog density is tuned so the floor two levels down is a suggestion rather than
 * a spoiler — you can feel the depth without being able to plan three moves
 * ahead from the top of a bounce.
 */
const FOG_DENSITY = 0.055;
