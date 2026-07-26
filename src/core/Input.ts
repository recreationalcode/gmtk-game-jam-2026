import { clamp } from './MathUtil';

export type InputScheme = 'pointer' | 'keyboard' | 'touch' | 'gamepad';

/**
 * Unified input for mouse, keyboard, touch and gamepad.
 *
 * Two outputs only: a steering vector and an edge-triggered bounce press.
 * Because the camera looks straight down, screen space *is* the ground plane —
 * pointing at a tile means leaning toward it, which is why absolute mouse
 * position works better here than relative mouse movement plus pointer lock
 * (and skips the click-to-capture friction entirely).
 */
export class Input {
  /** Steering vector, components in [-1, 1]. +x right, +y "down" on screen. */
  readonly steer = { x: 0, y: 0 };

  /** Set on the frame a bounce input begins; cleared by `consumeBounce()`. */
  private bounceEdge = false;
  private bounceEdgeTime = -Infinity;

  /** True while any bounce input is held. */
  bounceHeld = false;

  lastScheme: InputScheme = 'pointer';
  /** True once we have seen a touch, so the UI can switch to touch hints. */
  touchDetected = false;

  private enabled = true;
  private readonly keys = new Set<string>();
  private pointerInside = false;
  private pointerX = 0.5;
  private pointerY = 0.5;

  private touchId: number | null = null;
  private touchOriginX = 0;
  private touchOriginY = 0;
  private touchStickRadius = 90;
  private readonly activeTouches = new Map<number, { x: number; y: number }>();

  private gamepadIndex: number | null = null;
  private gamepadBouncePrev = false;

  private readonly element: HTMLElement;
  private readonly disposers: Array<() => void> = [];

  /**
   * Source of truth for input timestamps. The app points this at its *simulated*
   * clock rather than the wall clock, so that when time dilates the bounce
   * timing window dilates with it — otherwise slow motion would silently make
   * PERFECT unreachable, since the window is measured in simulated seconds.
   */
  private clockSource: () => number = () => performance.now() / 1000;

  private lastUpdate = -1;
  private touchReleasedAt = -Infinity;

  /**
   * Bumped whenever the aiming input actually moves.
   *
   * The app latches a world-space target and only re-derives it when this
   * changes. Without that, a stationary cursor still walks across the board:
   * the same screen pixel maps to a different world point every frame as the
   * camera falls, so the reticle drifts off the tile the player is pointing at
   * while they are doing nothing at all.
   */
  aimSeq = 0;

  /** Callbacks fired on any input at all — used to unlock WebAudio. */
  readonly onAnyInput = new Set<() => void>();
  /**
   * Fired on a deliberate "yes, carry on" press: click, tap or a bounce key.
   *
   * Separate from `onAnyInput` because that includes steering keys, and
   * dismissing a tip because the player nudged left is not what the prompt
   * offered them. Fires on press even on touch, where the bounce itself lands
   * on release — the acknowledgement should be immediate.
   */
  readonly onConfirm = new Set<() => void>();
  /** Fired on pause requests (Esc / P). */
  readonly onPause = new Set<() => void>();

  constructor(element: HTMLElement) {
    this.element = element;
    this.attach();
    this.resize();
  }

  // -- lifecycle -----------------------------------------------------------

  private listen<K extends keyof WindowEventMap>(
    target: Window | Document | HTMLElement,
    type: K | string,
    handler: (ev: never) => void,
    options?: AddEventListenerOptions,
  ): void {
    const fn = handler as EventListener;
    target.addEventListener(type, fn, options);
    this.disposers.push(() => target.removeEventListener(type, fn, options));
  }

  private attach(): void {
    this.listen(window, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    this.listen(window, 'keyup', (e: KeyboardEvent) => this.onKeyUp(e));
    this.listen(window, 'blur', () => this.releaseAll());

    this.listen(this.element, 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
    this.listen(this.element, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e));
    this.listen(window, 'pointerup', (e: PointerEvent) => this.onPointerUp(e));
    this.listen(window, 'pointercancel', (e: PointerEvent) => this.onPointerUp(e));
    this.listen(this.element, 'pointerleave', () => {
      this.pointerInside = false;
    });
    this.listen(this.element, 'pointerenter', () => {
      this.pointerInside = true;
    });

    // Suppress the browser's own gestures over the play surface.
    this.listen(this.element, 'contextmenu', (e: Event) => e.preventDefault());
    this.listen(this.element, 'touchstart', (e: Event) => e.preventDefault(), { passive: false });
    this.listen(this.element, 'touchmove', (e: Event) => e.preventDefault(), { passive: false });
    this.listen(window, 'resize', () => this.resize());
  }

  dispose(): void {
    for (const d of this.disposers) d();
    this.disposers.length = 0;
    this.onAnyInput.clear();
    this.onPause.clear();
  }

  private resize(): void {
    this.touchStickRadius = clamp(Math.min(window.innerWidth, window.innerHeight) * 0.22, 60, 160);
  }

  setClockSource(source: () => number): void {
    this.clockSource = source;
  }

  /**
   * Gameplay input is ignored while a menu is up, but we still track key state
   * so releasing a key during a menu doesn't leave it stuck down afterwards.
   */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  private releaseAll(): void {
    this.keys.clear();
    this.bounceHeld = false;
    this.bounceEdge = false;
    this.touchId = null;
    this.activeTouches.clear();
    this.steer.x = 0;
    this.steer.y = 0;
  }

  /**
   * Normalised cursor position, or null when the mouse is not the active
   * scheme. The app projects this onto the floor to aim, so it is deliberately
   * raw — no dead zone, no response curve, because it is a position rather than
   * a lean.
   */
  getPointerAim(): { x: number; y: number } | null {
    if (this.lastScheme !== 'pointer' || !this.pointerInside) return null;
    return { x: this.pointerX, y: this.pointerY };
  }

  /** Screen-space origin and current offset of the touch stick, for the HUD. */
  getTouchStick(): { ox: number; oy: number; radius: number } | null {
    if (this.touchId === null) return null;
    return { ox: this.touchOriginX, oy: this.touchOriginY, radius: this.touchStickRadius };
  }

  private notifyAny(): void {
    for (const fn of this.onAnyInput) fn();
  }

  private notifyConfirm(): void {
    for (const fn of this.onConfirm) fn();
  }

  // -- keyboard ------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return;
    this.notifyAny();

    if (e.code === 'Escape' || e.code === 'KeyP') {
      for (const fn of this.onPause) fn();
      return;
    }
    if (!this.enabled) return;

    this.keys.add(e.code);
    if (STEER_KEYS.has(e.code)) {
      this.lastScheme = 'keyboard';
      e.preventDefault();
    }
    if (BOUNCE_KEYS.has(e.code)) {
      this.notifyConfirm();
      this.pressBounce();
      e.preventDefault();
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.keys.delete(e.code);
    if (BOUNCE_KEYS.has(e.code) && !this.anyBounceKeyHeld()) {
      this.bounceHeld = false;
    }
  }

  private anyBounceKeyHeld(): boolean {
    for (const k of BOUNCE_KEYS) if (this.keys.has(k)) return true;
    return false;
  }

  // -- pointer / touch -----------------------------------------------------

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touchDetected = true;
      const prev = this.activeTouches.get(e.pointerId);
      this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touchId === e.pointerId) {
        this.lastScheme = 'touch';
        const moved =
          !prev ||
          Math.abs(e.clientX - prev.x) > TOUCH_AIM_EPSILON_PX ||
          Math.abs(e.clientY - prev.y) > TOUCH_AIM_EPSILON_PX;
        if (moved) this.aimSeq++;
      }
      return;
    }
    this.pointerInside = true;
    const nx = e.clientX / window.innerWidth;
    const ny = e.clientY / window.innerHeight;
    // Sub-pixel jitter is not a move. Browsers emit pointermove for hover
    // effects and sub-pixel scroll, and treating those as intent would defeat
    // the latch entirely.
    if (Math.abs(nx - this.pointerX) > AIM_EPSILON || Math.abs(ny - this.pointerY) > AIM_EPSILON) {
      this.aimSeq++;
    }
    this.pointerX = nx;
    this.pointerY = ny;
    if (this.lastScheme !== 'keyboard') this.lastScheme = 'pointer';
  }

  private onPointerDown(e: PointerEvent): void {
    this.notifyAny();
    if (!this.enabled) return;
    this.notifyConfirm();

    if (e.pointerType === 'touch') {
      this.touchDetected = true;
      this.lastScheme = 'touch';
      this.activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // The first finger down owns steering; later fingers just ride along.
      if (this.touchId === null) {
        this.touchId = e.pointerId;
        this.touchOriginX = e.clientX;
        this.touchOriginY = e.clientY;
      }
      // Deliberately no bounce here — see onPointerUp. On touch the whole
      // gesture is press-drag-release, so the press is "start aiming".
      return;
    } else {
      this.pointerInside = true;
      this.pointerX = e.clientX / window.innerWidth;
      this.pointerY = e.clientY / window.innerHeight;
      this.lastScheme = 'pointer';
    }
    this.pressBounce();
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      /**
       * Touch bounces on *release*.
       *
       * A thumb that is holding and dragging to steer cannot also produce a new
       * touchstart to time the bounce with — the two gestures compete for the
       * same finger, which made one-handed play unable to charge a bounce at
       * all. Releasing completes the gesture: press to start aiming, drag to
       * aim, release on the beat.
       *
       * Tapping still works, because a tap is a press followed by a release,
       * and firing on both would double-register every tap.
       */
      if (this.enabled) this.pressBounce();
      this.touchReleasedAt = performance.now() / 1000;
      this.activeTouches.delete(e.pointerId);
      if (this.touchId === e.pointerId) {
        this.touchId = null;
        // Hand steering to whichever finger is still down, so lifting the
        // steering thumb mid-flight doesn't yank control away.
        const next = this.activeTouches.keys().next();
        if (!next.done) {
          const pos = this.activeTouches.get(next.value)!;
          this.touchId = next.value;
          this.touchOriginX = pos.x - this.steer.x * this.touchStickRadius;
          this.touchOriginY = pos.y - this.steer.y * this.touchStickRadius;
        }
      }
    }
    this.bounceHeld = false;
  }

  private pressBounce(): void {
    this.bounceHeld = true;
    // First press wins. See BOUNCE_TIMING.inputBuffer — this is what stops
    // button-mashing from stumbling into perfect timing by brute force.
    if (this.bounceEdge) return;
    this.bounceEdge = true;
    this.bounceEdgeTime = this.clockSource();
  }

  // -- gamepad -------------------------------------------------------------

  private pollGamepad(): { x: number; y: number } | null {
    if (typeof navigator.getGamepads !== 'function') return null;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    if (this.gamepadIndex !== null) pad = pads[this.gamepadIndex] ?? null;
    if (!pad) {
      for (const p of pads) {
        if (p && p.connected) {
          pad = p;
          this.gamepadIndex = p.index;
          break;
        }
      }
    }
    if (!pad) return null;

    const bounce = pad.buttons.some((b, i) => GAMEPAD_BOUNCE_BUTTONS.has(i) && b.pressed);
    if (bounce && !this.gamepadBouncePrev) {
      this.pressBounce();
      this.lastScheme = 'gamepad';
    }
    this.gamepadBouncePrev = bounce;
    this.bounceHeld = this.bounceHeld || bounce;

    const ax = deadzone(pad.axes[0] ?? 0);
    const ay = deadzone(pad.axes[1] ?? 0);
    if (ax !== 0 || ay !== 0) {
      this.lastScheme = 'gamepad';
      return { x: ax, y: ay };
    }
    return null;
  }

  // -- per-frame -----------------------------------------------------------

  /**
   * Recompute the steering vector. Call once per rendered frame, before the
   * simulation steps.
   */
  update(): void {
    const wall = performance.now() / 1000;
    const dt = this.lastUpdate < 0 ? 0 : clamp(wall - this.lastUpdate, 0, 0.25);
    this.lastUpdate = wall;

    if (!this.enabled) {
      this.steer.x = 0;
      this.steer.y = 0;
      return;
    }

    const gamepad = this.pollGamepad();
    if (gamepad) {
      this.steer.x = gamepad.x;
      this.steer.y = gamepad.y;
      return;
    }

    // Touch takes priority whenever a steering finger is down.
    if (this.touchId !== null) {
      const pos = this.activeTouches.get(this.touchId);
      if (pos) {
        const dx = (pos.x - this.touchOriginX) / this.touchStickRadius;
        const dy = (pos.y - this.touchOriginY) / this.touchStickRadius;
        const len = Math.hypot(dx, dy);
        if (len > 1) {
          this.steer.x = dx / len;
          this.steer.y = dy / len;
        } else {
          this.steer.x = dx;
          this.steer.y = dy;
        }
        return;
      }
    }

    // Keyboard overrides the mouse while any steer key is held, so players who
    // reach for WASD aren't fighting wherever they left the cursor.
    let kx = 0;
    let ky = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) kx -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) kx += 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) ky -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) ky += 1;
    if (kx !== 0 || ky !== 0) {
      const len = Math.hypot(kx, ky);
      this.steer.x = kx / len;
      this.steer.y = ky / len;
      this.lastScheme = 'keyboard';
      return;
    }

    if (this.lastScheme === 'touch') {
      // Releasing is how you bounce, so the aim must survive the release —
      // otherwise every bounce would throw away the steering right when late
      // control authority is at its highest. Hold, then coast.
      if (wall - this.touchReleasedAt < TOUCH_AIM_HOLD) return;
      const decay = Math.exp(-TOUCH_COAST_RATE * dt);
      this.steer.x *= decay;
      this.steer.y *= decay;
      return;
    }

    if (this.pointerInside) {
      // Absolute cursor position, with a dead zone in the middle of the screen
      // so resting near centre means "hold still".
      const dx = (this.pointerX - 0.5) * 2;
      const dy = (this.pointerY - 0.5) * 2;
      this.steer.x = applyDeadzoneCurve(dx);
      this.steer.y = applyDeadzoneCurve(dy);
    } else {
      const decay = Math.exp(-TOUCH_COAST_RATE * dt);
      this.steer.x *= decay;
      this.steer.y *= decay;
    }
  }

  /**
   * Returns how long ago the bounce press happened (seconds), or null if there
   * is no unconsumed press. The sim uses the age to judge timing accuracy, so a
   * press is never silently dropped because it landed between fixed steps.
   */
  peekBounceAge(now: number): number | null {
    if (!this.bounceEdge) return null;
    return now - this.bounceEdgeTime;
  }

  consumeBounce(): void {
    this.bounceEdge = false;
    this.bounceEdgeTime = -Infinity;
  }

  /** Drop a stale buffered press so it can't fire a bounce much later. */
  expireBounce(now: number, maxAge: number): void {
    if (this.bounceEdge && now - this.bounceEdgeTime > maxAge) this.consumeBounce();
  }
}

/** Seconds the aim is held after a touch release, before it starts to decay. */
/**
 * How far an aiming input must move before it counts as a move, rather than as
 * jitter the latch should ignore. Normalised for the mouse, pixels for touch —
 * a fingertip resting on glass reports a couple of pixels of wander.
 */
const AIM_EPSILON = 0.0015;
const TOUCH_AIM_EPSILON_PX = 2.5;

const TOUCH_AIM_HOLD = 0.28;
/** Decay rate once the hold expires, per second. */
const TOUCH_COAST_RATE = 6;

const STEER_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

const BOUNCE_KEYS = new Set(['Space', 'Enter', 'ShiftLeft', 'ShiftRight', 'KeyJ', 'KeyZ']);

const GAMEPAD_BOUNCE_BUTTONS = new Set([0, 1, 2, 3, 6, 7]);

function deadzone(v: number, dz = 0.18): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

/** Small centre dead zone, then a slightly eased ramp to full lean. */
function applyDeadzoneCurve(v: number, dz = 0.06): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  const t = Math.min(1, (a - dz) / (0.75 - dz));
  return Math.sign(v) * t * t * (3 - 2 * t);
}
