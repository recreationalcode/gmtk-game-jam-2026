import * as THREE from 'three';
import { formatClock, formatScore } from '../core/MathUtil';
import type { Input } from '../core/Input';
import { icon } from './Icons';

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
    multBurst: HTMLElement;
    perfect: HTMLElement;
    perfectText: HTMLElement;
    pickup: HTMLElement;
    pickupText: HTMLElement;
    stick: HTMLElement;
    nub: HTMLElement;
  };

  private readonly popupPool: HTMLElement[] = [];
  private readonly projected = new THREE.Vector3();

  private shownScore = 0;
  private lastTimeText = '';
  private lastMultiplier = -1;
  private endgame = false;

  constructor(root: HTMLElement) {
    this.root = root;

    const hud = document.createElement('div');
    hud.className = 'hud';
    hud.innerHTML = `
      <div class="hud-corner hud-tl">
        <div class="hud-label">${icon('clock')}Time</div>
        <div class="hud-value" id="hud-time">60.0</div>
      </div>
      <div class="hud-corner hud-tr">
        <div class="hud-label">${icon('star')}Score</div>
        <div class="hud-value" id="hud-score">0</div>
      </div>
      <div class="hud-corner hud-bl">
        <div class="hud-label">${icon('depth')}Depth</div>
        <div class="hud-value small" id="hud-depth">0</div>
      </div>
      <div class="hud-corner hud-br">
        <div class="hud-label">${icon('times')}Multiplier</div>
        <div class="hud-value mult" id="hud-mult">&times;1</div>
      </div>
      <div id="hud-combo"><span class="combo-text">PERFECT &times;1</span></div>
      <div id="hud-bigcount"></div>
      <div id="hud-multburst"></div>
      <div id="hud-perfect"><span></span></div>
      <div id="hud-pickup"><span></span></div>
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
      multBurst: q('hud-multburst'),
      perfect: q('hud-perfect'),
      perfectText: hud.querySelector<HTMLElement>('#hud-perfect span')!,
      pickup: q('hud-pickup'),
      pickupText: hud.querySelector<HTMLElement>('#hud-pickup span')!,
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

    // The multiplier is the single most important number in the game — depth is
    // worth more than any tile — so a change gets its own animation rather than
    // silently swapping a digit.
    if (multiplier !== this.lastMultiplier) {
      const grew = multiplier > this.lastMultiplier && this.lastMultiplier >= 0;
      this.lastMultiplier = multiplier;
      this.el.mult.textContent = `×${multiplier}`;
      this.el.mult.classList.remove('pop', 'drop');
      void this.el.mult.offsetWidth;
      this.el.mult.classList.add(grew ? 'pop' : 'drop');
    }
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

  /**
   * Slam the new multiplier across the middle of the screen.
   *
   * @param gained false when an UP tile took one away, which gets its own
   * animation. Losing a multiplier is the worst thing that happens in a run and
   * it used to be a quarter-second tint on a corner number, which is nothing:
   * the player is looking at the board, not the corner, and is in the middle of
   * being thrown a whole storey upward while it happens.
   */
  celebrateMultiplier(multiplier: number, gained = true): void {
    const el = this.el.multBurst;
    el.textContent = `×${multiplier}`;
    el.classList.remove('fire', 'crash');
    void el.offsetWidth;
    el.classList.add(gained ? 'fire' : 'crash');
  }

  /**
   * The flourish for a perfect landing, scaled by how long the streak is.
   *
   * A perfect is the one thing in the game the player earns purely through
   * timing, and it deserves to be felt rather than merely counted in the corner.
   * The streak drives size and glow through a custom property, so a long chain
   * escalates instead of repeating.
   */
  celebratePerfect(streak: number): void {
    const heat = Math.min(1, (streak - 1) / 7);
    this.el.perfectText.textContent = streak >= 2 ? `PERFECT ×${streak}` : 'PERFECT';
    this.el.perfect.style.setProperty('--heat', heat.toFixed(3));
    this.el.perfect.classList.remove('fire');
    void this.el.perfect.offsetWidth;
    this.el.perfect.classList.add('fire');
  }

  /** Centre flourish for grabbing a powerup. */
  celebratePickup(text: string, tone: 'time' | 'boost' | 'freeze'): void {
    this.el.pickupText.textContent = text;
    this.el.pickup.dataset.tone = tone;
    this.el.pickup.classList.remove('fire');
    void this.el.pickup.offsetWidth;
    this.el.pickup.classList.add('fire');
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
    variant: 'normal' | 'hostile' | 'big' | 'mult' = 'normal',
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
    this.lastMultiplier = -1;
    this.el.score.textContent = '0';
  }
}
