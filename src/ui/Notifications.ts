import { clamp01 } from '../core/MathUtil';
import type { Notice } from '../game/Coach';
import { renderGlyphToCanvas, renderMultiplierToCanvas } from '../render/GlyphAtlas';

/**
 * Draws the coach's notices as a single queued toast.
 *
 * One at a time, deliberately. Stacking toasts is how a helpful system becomes
 * a wall of text over the exact thing it is trying to explain — and this game
 * can fire a discovery, a multiplier gain and a burnout warning within the same
 * second. A queue with a minimum gap turns that into a readable sequence.
 *
 * Notices carry the *actual* tile artwork, drawn through the same procedural
 * code the board uses, so "this is a TIME tile" shows the tile the player is
 * looking at rather than a description of it.
 */

const TONE_COLOR: Record<Notice['tone'], string> = {
  info: '#7fd4ff',
  good: '#6dffb0',
  warn: '#ffb066',
};

/**
 * Seconds a toast stays up, and the pause before the next one.
 *
 * These are *real* seconds, and the simulation runs at a tenth speed underneath
 * them, so a full toast costs well under a second of match clock. That is what
 * makes it affordable to hold one long enough to actually read — and the player
 * can end it early anyway, which is what the prompt is for.
 */
const HOLD_SECONDS = 4.5;
/** Title-only notices need far less time than ones carrying an explanation. */
const TERSE_SCALE = 0.5;
const GAP_SECONDS = 0.25;
/**
 * Anything that has waited this long behind other notices no longer describes
 * what the player is doing, so it is dropped rather than shown out of context.
 */
const MAX_QUEUE_AGE = 10;

interface Queued {
  notice: Notice;
  queuedAt: number;
}

export class Notifications {
  private readonly el: HTMLElement;
  private readonly iconEl: HTMLCanvasElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly promptEl: HTMLElement;
  private readonly timerEl: HTMLElement;

  /** Swaps the prompt between "Click" and "Tap". */
  touchMode = false;
  private lastBarWidth = -1;

  private readonly queue: Queued[] = [];
  private showing: Notice | null = null;

  /** True while a toast is up or waiting. Read by the headless tests. */
  get busy(): boolean {
    return this.showing !== null || this.queue.length > 0;
  }

  private timer = 0;
  private hold = 0;
  private clock = 0;

  /**
   * How far through the current toast we are, 0..1, or null when nothing is
   * showing. The app turns this into time dilation so the notice is readable.
   */
  readingProgress(): number | null {
    if (!this.showing || this.hold <= 0) return null;
    return clamp01(1 - this.timer / this.hold);
  }

  constructor(root: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'notice';
    // Announced politely so a screen reader gets the same teaching a sighted
    // player does, without interrupting whatever it is already reading.
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');
    this.el.innerHTML = `
      <canvas class="notice-icon" width="128" height="128"></canvas>
      <div class="notice-text">
        <div class="notice-title"></div>
        <div class="notice-body"></div>
        <div class="notice-prompt"></div>
      </div>
      <div class="notice-timer"><i></i></div>
    `;
    root.appendChild(this.el);

    this.iconEl = this.el.querySelector<HTMLCanvasElement>('.notice-icon')!;
    this.titleEl = this.el.querySelector<HTMLElement>('.notice-title')!;
    this.bodyEl = this.el.querySelector<HTMLElement>('.notice-body')!;
    this.promptEl = this.el.querySelector<HTMLElement>('.notice-prompt')!;
    this.timerEl = this.el.querySelector<HTMLElement>('.notice-timer > i')!;
  }

  /**
   * End the toast on screen early.
   *
   * The player has read it and pressed to carry on; holding them for the rest
   * of the timer at a tenth speed would turn a helpful tip into a punishment.
   * The next one still waits out the usual gap, so dismissing a burst does not
   * flash five notices past in half a second.
   */
  dismiss(): void {
    if (!this.showing) return;
    this.showing = null;
    this.hold = 0;
    this.timer = GAP_SECONDS;
    this.el.classList.remove('visible');
  }

  push(notices: readonly Notice[]): void {
    for (const notice of notices) {
      // A notice already queued for the same id is not worth duplicating.
      if (this.queue.some((q) => q.notice.id === notice.id)) continue;
      this.queue.push({ notice, queuedAt: this.clock });
    }
  }

  update(dt: number): void {
    this.clock += dt;

    if (this.showing) {
      this.timer -= dt;
      // The auto-dismiss countdown, drawn as a draining bar. Written only when
      // it changes by a visible amount rather than every frame.
      const width = Math.round(clamp01(this.timer / Math.max(0.0001, this.hold)) * 100);
      if (width !== this.lastBarWidth) {
        this.lastBarWidth = width;
        this.timerEl.style.width = `${width}%`;
      }
      if (this.timer <= 0) {
        this.showing = null;
        this.hold = 0;
        this.timer = GAP_SECONDS;
        this.el.classList.remove('visible');
      }
      return;
    }

    if (this.timer > 0) {
      this.timer -= dt;
      return;
    }

    // Drop anything that waited so long behind other notices that it no longer
    // describes what the player is doing.
    while (this.queue.length > 0 && this.clock - this.queue[0]!.queuedAt > MAX_QUEUE_AGE) {
      this.queue.shift();
    }
    const next = this.queue.shift();
    if (next) this.present(next.notice);
  }

  private present(notice: Notice): void {
    this.showing = notice;
    this.hold = notice.body ? HOLD_SECONDS : HOLD_SECONDS * TERSE_SCALE;
    this.timer = this.hold;

    const color = TONE_COLOR[notice.tone];
    this.el.style.setProperty('--notice-color', color);

    if (notice.multiplier !== undefined) {
      this.iconEl.classList.remove('hidden');
      renderMultiplierToCanvas(this.iconEl, notice.multiplier, color);
    } else if (notice.glyph !== undefined) {
      this.iconEl.classList.remove('hidden');
      renderGlyphToCanvas(this.iconEl, notice.glyph, color);
    } else {
      this.iconEl.classList.add('hidden');
    }

    this.titleEl.textContent = notice.title;
    this.bodyEl.textContent = notice.body ?? '';
    this.bodyEl.classList.toggle('hidden', !notice.body);
    this.promptEl.textContent = this.touchMode
      ? 'Tap to keep bouncing!'
      : 'Click to keep bouncing!';
    this.timerEl.style.width = '100%';
    this.lastBarWidth = 100;

    // Restart the entry animation even if a toast was already on screen.
    this.el.classList.remove('visible');
    void this.el.offsetWidth;
    this.el.classList.add('visible');
  }

  /** Drop everything — used on pause, game over and returning to the title. */
  clear(): void {
    this.queue.length = 0;
    this.showing = null;
    this.hold = 0;
    this.timer = 0;
    this.lastBarWidth = -1;
    this.el.classList.remove('visible');
  }
}
