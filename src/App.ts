import * as THREE from 'three';
import { AudioEngine } from './core/Audio';
import {
  BOUNCE_TIMING,
  CLOCK,
  FLOOR,
  PALETTE,
  POGO,
  SIM,
  TileKind,
  prefersReducedMotion,
} from './core/Config';
import { Input } from './core/Input';
import { clamp, clamp01, formatScore, lerp } from './core/MathUtil';
import { GameState, type GameEvent } from './game/GameState';
import { Leaderboard } from './net/Leaderboard';
import { Particles, Shockwaves } from './render/Effects';
import { createGlyphAtlas } from './render/GlyphAtlas';
import { Guides } from './render/Guides';
import { backgroundColor, depthHue, hsl } from './render/Palette';
import { PlayerRig } from './render/PlayerRig';
import { Renderer } from './render/Renderer';
import { TileField } from './render/TileField';
import { HUD } from './ui/HUD';
import { Screens } from './ui/Screens';
import { Stats } from './ui/Stats';

type AppPhase = 'title' | 'playing' | 'paused' | 'over';

const STEP = 1 / SIM.hz;

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
  private readonly audio = new AudioEngine();
  private readonly leaderboard = new Leaderboard();

  private readonly input: Input;
  private readonly renderer: Renderer;
  private readonly rig: PlayerRig;
  private readonly hud: HUD;
  private readonly screens: Screens;
  private readonly stats: Stats;

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
  private readonly guides = new Guides();

  private phase: AppPhase = 'title';
  private accumulator = 0;
  private lastFrame = 0;
  private clock = 0;
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

    this.input.onAnyInput.add(() => void this.audio.unlock());
    this.input.onPause.add(() => this.togglePause());

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('orientationchange', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.phase === 'playing') this.pause();
    });

    this.setAccent(0);
    this.game.prepareIdle();
    this.screens.setPersonalBest(this.leaderboard.personalBest);
    this.screens.show('title');
    this.hud.setVisible(false);
    this.guides.setVisible(false);
    installFavicon();
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
    this.flash = 0;
    this.endgameIntensity = 0;
    this.perfectFlash = 0;
    this.rig.reset();
    this.particles.clear();
    this.hud.resetScore();
    this.hud.setEndgame(false);
    this.hud.setVisible(true);
    this.guides.setVisible(true);
    this.setAccent(0);
    this.screens.show(null);
    this.input.setEnabled(true);
    this.phase = 'playing';
    this.audio.startMusic();
  }

  private toTitle(): void {
    this.phase = 'title';
    this.audio.stopMusic();
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
    this.audio.startMusic();
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
    this.clock += dt;

    this.input.update();

    if (this.phase === 'playing') {
      this.simulate(now, dt);
      this.game.drainEvents(this.handleEvent);
    } else if (this.phase === 'title') {
      this.game.stepIdle(dt);
    }

    this.present(dt);
    this.renderer.render();

    this.stats.update(dt, this.renderer.renderer, {
      tier: this.renderer.quality.name,
      dpr: this.renderer.devicePixelRatioUsed.toFixed(2),
      phase: this.phase,
      depth: this.game.depth,
      eye: (this.game.player.eyeY - this.game.floor.y).toFixed(2),
      vy: this.game.player.vy.toFixed(1),
      flash: this.flash.toFixed(2),
      endg: this.endgameIntensity.toFixed(2),
      shake: this.game.shake.toFixed(2),
    });
  };

  private simulate(now: number, dt: number): void {
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

    const steerX =
      this.steerRight.x * this.input.steer.x + this.steerForward.x * this.input.steer.y;
    const steerZ =
      this.steerRight.z * this.input.steer.x + this.steerForward.z * this.input.steer.y;

    // Sub-step time is derived from the un-simulated remainder, so an input's
    // age is measured against the moment it is actually evaluated. Using the
    // raw frame time here would smear timing accuracy by a whole frame — which
    // is a third of the perfect window.
    let simNow = now - this.accumulator;
    let steps = 0;

    while (this.accumulator >= STEP && steps < SIM.maxStepsPerFrame) {
      simNow += STEP;
      const age = this.input.peekBounceAge(simNow);
      const consumed = this.game.step(STEP, simNow, steerX, steerZ, age);
      if (consumed) this.input.consumeBounce();
      this.accumulator -= STEP;
      steps++;
    }

    if (steps >= SIM.maxStepsPerFrame) this.accumulator = 0;
    this.input.expireBounce(now, BOUNCE_TIMING.inputBuffer);
  }

  // -- events --------------------------------------------------------------

  private readonly handleEvent = (e: GameEvent): void => {
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
        this.popupAt(`+${e.amount}s`, e.x, e.z, 'big');
        this.ring(e.x, e.z, 3.2, 0.5, hsl(PALETTE.timeHue, 0.9, 0.62).clone());
        this.flash = Math.max(this.flash, 0.09);
        break;
      case 'boost':
        this.audio.boost();
        this.popupAt(`×${e.multiplier}`, e.x, e.z, 'big');
        this.ring(e.x, e.z, 3.0, 0.45, hsl(PALETTE.boostHue, 0.85, 0.66).clone());
        break;
      case 'freeze':
        this.audio.freeze();
        this.popupAt('FREEZE', e.x, e.z, 'big');
        this.ring(e.x, e.z, 4.5, 0.8, hsl(PALETTE.freezeHue, 0.75, 0.7).clone(), 0.05);
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
      this.audio.perfect(this.game.player.perfectStreak);
      this.perfectFlash = 1;
      this.flash = Math.max(this.flash, 0.05);
      this.ring(e.x, e.z, floor.tileSize * 4.2, 0.55, this.accent, 0.045);
      if (this.game.player.perfectStreak >= 2) {
        this.popupAt(`PERFECT ×${this.game.player.perfectStreak}`, e.x, e.z);
      }
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
    this.setAccent(e.depth);
    this.flash = Math.max(this.flash, 0.22);
    this.popupAt(`DEPTH −${e.depth}   ×${this.game.multiplier}`, e.x, e.z, 'big');

    const y = this.game.dissolving?.y ?? this.game.floor.y;
    const downColor = hsl(PALETTE.downHue, 0.9, 0.6).clone();
    this.ring(e.x, e.z, 26, 0.9, downColor, 0.03);
    this.ring(e.x, e.z, 14, 0.6, WHITE, 0.06);
    this.particles.burst(e.x, y, e.z, 70, 9, downColor, 1.3, 3.0, 0.8);
  }

  private onAscend(e: Extract<GameEvent, { type: 'ascend' }>): void {
    this.audio.ascend();
    this.setAccent(e.depth);
    const hostile = hsl(PALETTE.hostileHue, 0.82, 0.55).clone();
    this.popupAt(`×${this.game.multiplier}`, e.x, e.z, 'hostile');
    this.ring(e.x, e.z, 16, 0.7, hostile, 0.05);
    this.particles.burst(e.x, this.game.floor.y, e.z, 40, 7, hostile, 1.0, 2.6, 0.9);
  }

  private onSecondTick(secondsLeft: number): void {
    this.hud.pulseClock();
    this.audio.tick(secondsLeft);
    if (secondsLeft <= 5 && secondsLeft > 0) this.hud.bigCount(secondsLeft);
  }

  private onGameOver(): void {
    this.phase = 'over';
    this.audio.gameOver();
    this.input.setEnabled(false);
    this.hud.setVisible(false);
    this.guides.setVisible(false);
    this.flash = 0.6;
    this.screens.showSummary(this.game.summary, this.leaderboard.getStoredName());
    this.screens.show('over');
    this.screens.setPersonalBest(this.leaderboard.personalBest);
  }

  // -- presentation --------------------------------------------------------

  private present(dt: number): void {
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

    this.fieldMain.sync(floor, this.clock);
    if (game.dissolving) {
      this.fieldDissolving.setVisible(true);
      this.fieldDissolving.sync(game.dissolving, this.clock);
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
        this.steerRight.x * this.input.steer.x + this.steerForward.x * this.input.steer.y,
        this.steerRight.z * this.input.steer.x + this.steerForward.z * this.input.steer.y,
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
      );
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
      dt,
      game.timeLeft,
      game.score,
      game.multiplier,
      game.depth,
      game.player.perfectStreak,
    );
    if (this.input.touchDetected) this.hud.updateTouchStick(this.input);

    this.audio.setMusicState(game.depth, this.endgameIntensity);
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
    variant: 'normal' | 'hostile' | 'big' = 'normal',
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
        result.source === 'local' ? 'Saved on this device.' : 'Score submitted.',
        result.source === 'local' ? 'Saved' : 'Submitted',
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
