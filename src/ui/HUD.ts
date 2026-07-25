import * as THREE from 'three';
import { formatClock, formatScore } from '../core/MathUtil';
import type { Input } from '../core/Input';

/**
 * The DOM overlay: clock, score, multiplier, depth, combo, and floating
 * score popups anchored to world positions.
 *
 * All of it is DOM rather than in-world text. Text in WebGL means a font atlas,
 * a draw call per label and blurry glyphs at odd pixel ratios; DOM text is
 * crisp at every DPR, costs the GPU nothing, and is readable by a screen
 * reader. The only thing that has to cross over is the projection used to place
 * a popup where the tile was.
 */
export class HUD {
  private readonly root: HTMLElement;
  private readonly el: {
    hud: HTMLElement;
    time: HTMLElement;
    score: HTMLElement;
    mult: HTMLElement;
    depth: HTMLElement;
    combo: HTMLElement;
    comboText: HTMLElement;
    bigCount: HTMLElement;
    stick: HTMLElement;
    nub: HTMLElement;
  };

  private readonly popupPool: HTMLElement[] = [];
  private readonly projected = new THREE.Vector3();

  private shownScore = 0;
  private lastTimeText = '';
  private endgame = false;

  constructor(root: HTMLElement) {
    this.root = root;

    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="hud-corner hud-tl">
        <div class="hud-label">Time</div>
        <div class="hud-value" id="hud-time">60.0</div>
      </div>
      <div class="hud-corner hud-tr">
        <div class="hud-label">Score</div>
        <div class="hud-value" id="hud-score">0</div>
        <div class="hud-value small" id="hud-mult">&times;1</div>
      </div>
      <div class="hud-corner hud-bl">
        <div class="hud-label">Depth</div>
        <div class="hud-value small" id="hud-depth">0</div>
      </div>
      <div id="hud-combo"><span class="combo-text">PERFECT &times;1</span></div>
      <div id="hud-bigcount"></div>
      <div id="touch-stick"><div id="touch-nub"></div></div>
    `;
    root.appendChild(hud);

    const q = <T extends HTMLElement>(id: string): T => hud.querySelector<T>(`#${id}`)!;
    this.el = {
      hud,
      time: q('hud-time'),
      score: q('hud-score'),
      mult: q('hud-mult'),
      depth: q('hud-depth'),
      combo: q('hud-combo'),
      comboText: hud.querySelector<HTMLElement>('.combo-text')!,
      bigCount: q('hud-bigcount'),
      stick: q('touch-stick'),
      nub: q('touch-nub'),
    };
  }

  setVisible(visible: boolean): void {
    this.el.hud.classList.toggle('visible', visible);
  }

  setAccent(color: THREE.Color): void {
    const css = `#${color.getHexString()}`;
    this.root.style.setProperty('--accent', css);
    this.root.style.setProperty('--accent-dim', `${css}40`);
  }

  setEndgame(active: boolean): void {
    if (this.endgame === active) return;
    this.endgame = active;
    this.el.hud.classList.toggle('endgame', active);
  }

  /**
   * @param dt real seconds, used to roll the displayed score toward the true
   * one. A counter that visibly climbs is worth more than an accurate one.
   */
  update(
    dt: number,
    timeLeft: number,
    score: number,
    multiplier: number,
    depth: number,
    perfectStreak: number,
  ): void {
    const text = formatClock(timeLeft);
    if (text !== this.lastTimeText) {
      this.lastTimeText = text;
      this.el.time.textContent = text;
    }

    // Chase the real score fast enough to never lag noticeably, but slowly
    // enough that a big descend bonus reads as a *ramp*.
    const diff = score - this.shownScore;
    if (Math.abs(diff) > 0.5) {
      this.shownScore += diff * Math.min(1, dt * 11);
      if (Math.abs(score - this.shownScore) < 1) this.shownScore = score;
      this.el.score.textContent = formatScore(this.shownScore);
    } else if (this.shownScore !== score) {
      this.shownScore = score;
      this.el.score.textContent = formatScore(score);
    }

    this.el.mult.textContent = `×${multiplier}`;
    this.el.depth.textContent = depth === 0 ? 'SURFACE' : `−${depth}`;

    const comboActive = perfectStreak >= 2;
    this.el.combo.classList.toggle('active', comboActive);
    if (comboActive) this.el.comboText.textContent = `PERFECT ×${perfectStreak}`;
  }

  /** Re-trigger the clock pulse. Requires a reflow to restart the animation. */
  pulseClock(): void {
    this.el.time.classList.remove('tick');
    void this.el.time.offsetWidth;
    this.el.time.classList.add('tick');
  }

  /** Giant numeral behind the play field during the final seconds. */
  bigCount(n: number): void {
    this.el.bigCount.textContent = String(n);
    this.el.bigCount.classList.remove('pulse');
    void this.el.bigCount.offsetWidth;
    this.el.bigCount.classList.add('pulse');
  }

  /** Place a floating label at a world position. */
  popup(
    text: string,
    world: THREE.Vector3,
    camera: THREE.Camera,
    variant: 'normal' | 'hostile' | 'big' = 'normal',
  ): void {
    this.projected.copy(world).project(camera);
    // Behind the camera, or well outside the frame: not worth a DOM node.
    if (this.projected.z > 1) return;
    const x = (this.projected.x * 0.5 + 0.5) * window.innerWidth;
    const y = (-this.projected.y * 0.5 + 0.5) * window.innerHeight;
    if (x < -80 || y < -80 || x > window.innerWidth + 80 || y > window.innerHeight + 80) return;

    const el = this.popupPool.pop() ?? document.createElement('div');
    el.className = `popup${variant === 'normal' ? '' : ` ${variant}`}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    el.style.animation = 'none';
    this.root.appendChild(el);
    void el.offsetWidth;
    el.style.animation = 'popup-float 0.95s cubic-bezier(0.16, 1, 0.3, 1) forwards';

    window.setTimeout(() => {
      el.remove();
      if (this.popupPool.length < 24) this.popupPool.push(el);
    }, 1000);
  }

  updateTouchStick(input: Input): void {
    const stick = input.getTouchStick();
    if (!stick) {
      this.el.stick.classList.remove('active');
      return;
    }
    this.el.stick.classList.add('active');
    this.el.stick.style.left = `${stick.ox}px`;
    this.el.stick.style.top = `${stick.oy}px`;
    this.el.stick.style.width = `${stick.radius * 2}px`;
    this.el.stick.style.height = `${stick.radius * 2}px`;
    this.el.nub.style.left = `${50 + input.steer.x * 32}%`;
    this.el.nub.style.top = `${50 + input.steer.y * 32}%`;
  }

  resetScore(): void {
    this.shownScore = 0;
    this.el.score.textContent = '0';
  }
}
