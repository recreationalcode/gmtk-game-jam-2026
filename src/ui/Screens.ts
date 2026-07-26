import { CLOCK, FREEZE, TIME_TILE_BONUS } from '../core/Config';
import { formatScore } from '../core/MathUtil';
import type { RunSummary } from '../game/GameState';
import type { BoardResult } from '../net/Leaderboard';
import { GLYPH, renderGlyphToCanvas, renderMultiplierToCanvas } from '../render/GlyphAtlas';
import { applyIcons, icon, iconEl, setIcon, type IconName } from './Icons';

export type ScreenName = 'title' | 'guide' | 'pause' | 'over' | 'board' | null;

export interface ScreenCallbacks {
  onPlay(): void;
  onResume(): void;
  onRestart(): void;
  onQuit(): void;
  onSubmit(name: string): void;
  onRefreshBoard(): void;
  onToggleSound(enabled: boolean): void;
}

/**
 * Menus, the player guide and the run summary.
 *
 * Built as DOM rather than in-world UI for the same reasons as the HUD, plus
 * one more: real buttons and a real text input get focus handling, keyboard
 * navigation and a mobile keyboard for free, none of which is worth
 * reimplementing in WebGL during a jam.
 */
export class Screens {
  private readonly root: HTMLElement;
  private readonly cb: ScreenCallbacks;
  private readonly screens = new Map<Exclude<ScreenName, null>, HTMLElement>();

  private current: ScreenName = null;
  private nameInput!: HTMLInputElement;
  private submitButton!: HTMLButtonElement;
  private soundButton!: HTMLButtonElement;
  private bestEl!: HTMLElement;

  /**
   * The board is rendered in two places — inline under the run summary, where
   * you want to see where your score landed the moment you submit it, and on a
   * standalone screen reachable from the title before you have played at all.
   * One render path feeds both so they can never disagree.
   */
  private readonly boardViews: Array<{ rows: HTMLElement; notice: HTMLElement }> = [];
  /** Where the standalone board's Back button should return to. */
  private boardReturnTo: Exclude<ScreenName, null> = 'title';

  private soundOn = true;
  private lastSummary: RunSummary | null = null;

  constructor(root: HTMLElement, callbacks: ScreenCallbacks) {
    this.root = root;
    this.cb = callbacks;

    this.buildTitle();
    this.buildGuide();
    this.buildPause();
    this.buildOver();
    this.buildBoard();
    this.buildRotateHint();
  }

  get visible(): boolean {
    return this.current !== null;
  }

  get currentScreen(): ScreenName {
    return this.current;
  }

  show(name: ScreenName): void {
    for (const [key, el] of this.screens) el.classList.toggle('visible', key === name);
    this.current = name;
    if (name === 'over') {
      // Defer focus until after the screen paints, or iOS ignores it.
      requestAnimationFrame(() => this.nameInput.focus());
    }
  }

  setPersonalBest(best: number): void {
    this.bestEl.textContent = best > 0 ? `Personal best ${formatScore(best)}` : '';
  }

  // -- title ---------------------------------------------------------------

  private buildTitle(): void {
    const el = this.makeScreen('title');
    el.innerHTML = `
      <div class="panel">
        <h1 class="title">POGO<br /><em>DROP</em></h1>
        <p class="tagline">Can't stop, <i>will</i> drop</p>
        <div class="button-row">
          <button data-act="play" data-icon="play">Play</button>
        </div>
        <div class="button-row">
          <button class="ghost" data-act="guide" data-icon="help">How to play</button>
          <button class="ghost" data-act="board" data-icon="board">Leaderboard</button>
          <button class="ghost" data-act="sound" data-icon="soundOn">Sound: on</button>
        </div>
        <p class="notice" data-role="best"></p>
        <p class="notice credit">GMTK Game Jam 2026</p>
      </div>
    `;
    applyIcons(el);
    this.bestEl = el.querySelector<HTMLElement>('[data-role="best"]')!;
    this.soundButton = el.querySelector<HTMLButtonElement>('[data-act="sound"]')!;

    el.querySelector('[data-act="play"]')!.addEventListener('click', () => this.cb.onPlay());
    el.querySelector('[data-act="guide"]')!.addEventListener('click', () => this.show('guide'));
    el.querySelector('[data-act="board"]')!.addEventListener('click', () => this.openBoard('title'));
    this.soundButton.addEventListener('click', () => this.toggleSound());
  }

  // -- standalone leaderboard ---------------------------------------------

  private buildBoard(): void {
    const el = this.makeScreen('board');
    el.innerHTML = `
      <div class="panel">
        <h1 class="title" style="font-size:clamp(1.6rem,7vw,2.2rem)">LEADERBOARD</h1>
        <div class="board" data-role="board"></div>
        <p class="notice" data-role="board-notice"></p>
        <div class="button-row">
          <button data-act="back" data-icon="back">Back</button>
          <button class="ghost" data-act="refresh" data-icon="refresh">Refresh</button>
        </div>
      </div>
    `;

    applyIcons(el);
    this.boardViews.push({
      rows: el.querySelector<HTMLElement>('[data-role="board"]')!,
      notice: el.querySelector<HTMLElement>('[data-role="board-notice"]')!,
    });

    el.querySelector('[data-act="back"]')!.addEventListener('click', () => {
      this.show(this.boardReturnTo);
    });
    el.querySelector('[data-act="refresh"]')!.addEventListener('click', () => {
      this.setBoardLoading();
      this.cb.onRefreshBoard();
    });
  }

  /**
   * Open the standalone board, remembering where to go back to. Fetching is
   * kicked off on open rather than cached, so a board opened from the title is
   * current rather than whatever was loaded at boot.
   */
  openBoard(from: Exclude<ScreenName, null>): void {
    this.boardReturnTo = from;
    this.setBoardLoading();
    this.show('board');
    this.cb.onRefreshBoard();
  }

  /**
   * Escape backs out of a sub-screen before it reaches the pause toggle.
   * Returns true if it consumed the key.
   */
  handleBack(): boolean {
    if (this.current === 'board') {
      this.show(this.boardReturnTo);
      return true;
    }
    if (this.current === 'guide') {
      this.show(this.lastSummary ? 'over' : 'title');
      return true;
    }
    return false;
  }

  private setBoardLoading(): void {
    for (const view of this.boardViews) {
      view.rows.replaceChildren();
      const p = document.createElement('p');
      p.className = 'notice';
      p.textContent = 'Fetching the scoreboard…';
      view.rows.appendChild(p);
      view.notice.textContent = '';
      view.notice.classList.remove('warn');
    }
  }

  private toggleSound(): void {
    this.soundOn = !this.soundOn;
    this.soundButton.textContent = `Sound: ${this.soundOn ? 'on' : 'off'}`;
    setIcon(this.soundButton, this.soundOn ? 'soundOn' : 'soundOff');
    this.cb.onToggleSound(this.soundOn);
  }

  // -- guide ---------------------------------------------------------------

  private buildGuide(): void {
    const el = this.makeScreen('guide');
    el.innerHTML = `
      <div class="panel">
        <h1 class="title" style="font-size:clamp(1.6rem,7vw,2.2rem)">HOW TO PLAY</h1>

        <h2>The idea</h2>
        <p>
          You can't stop bouncing, and every landing does something. Bounce on numbers to
          collect them. One green tile per floor takes you down, and going down is what makes
          everything worth more. You get ${CLOCK.matchSeconds} seconds. Go.
        </p>

        <h2>Controls</h2>
        <div class="keys" data-role="keys"></div>

        <h2>Timing your bounce</h2>
        <p>
          Watch the ring closing in on the tile you're about to hit. Click right as it lands on
          the square (on a phone, <b>let go</b> instead) and you get a <b>PERFECT</b>: higher,
          further, and it starts a combo that stacks up fast.
        </p>
        <p>
          Mashing won't help you. The first click wins, so one well-judged press beats eight
          panicked ones.
        </p>

        <h2>Tiles</h2>
        <div class="legend" data-role="legend"></div>

        <h2>Everything is counting down</h2>
        <p>
          Every number on the board is ticking away, each on its own clock. When one hits zero
          it <b>turns into a red tile</b> and starts working against you. So points go stale.
          Take the nine now, not the four in ten seconds.
        </p>
        <p>
          Good news: leave a floor and its numbers <b>come back fresh</b>. What doesn't come
          back is anything you took. Numbers you scored and powerups you grabbed are gone for
          good, so a floor is worth a little less every time you visit it. The three powerup
          floors don't refill at all.
        </p>

        <h2>Floors have moods</h2>
        <p>
          Most are about half red tiles. Some are stuffed with big numbers and worth farming,
          some are near enough a minefield, and every so often you'll drop into one loaded with
          powerups. <b>The first floor has no red tiles at all</b>, so take a moment there.
        </p>
        <p>
          The deeper you go, the lower you bounce. It creeps in gently, but by a few floors
          down you're seeing less of the board each time you peak. That's when timing starts
          to really pay.
        </p>

        <div class="button-row">
          <button data-act="back" data-icon="back">Back</button>
        </div>
      </div>
    `;

    applyIcons(el);

    const keys = el.querySelector<HTMLElement>('[data-role="keys"]')!;
    for (const row of CONTROL_ROWS) {
      const iEl = document.createElement('div');
      iEl.className = 'key-icon';
      iEl.appendChild(iconEl(row.icon));
      const kEl = document.createElement('div');
      // Static, code-authored markup — the <kbd> tags are the point of it.
      kEl.innerHTML = row.keys;
      const vEl = document.createElement('div');
      vEl.textContent = row.what;
      keys.append(iEl, kEl, vEl);
    }

    const legend = el.querySelector<HTMLElement>('[data-role="legend"]')!;
    for (const row of LEGEND_ROWS) {
      const canvas = document.createElement('canvas');
      canvas.width = 76;
      canvas.height = 76;
      if (row.multiplier !== undefined) {
        renderMultiplierToCanvas(canvas, row.multiplier, row.color);
      } else {
        renderGlyphToCanvas(canvas, row.glyph, row.color);
      }
      const text = document.createElement('div');
      text.innerHTML = `<b class="legend-name">${row.title}</b>${row.body}`;
      legend.append(canvas, text);
    }

    el.querySelector('[data-act="back"]')!.addEventListener('click', () => {
      this.show(this.lastSummary ? 'over' : 'title');
    });
  }

  // -- pause ---------------------------------------------------------------

  private buildPause(): void {
    const el = this.makeScreen('pause');
    el.innerHTML = `
      <div class="panel">
        <h1 class="title" style="font-size:clamp(1.8rem,8vw,2.6rem)">PAUSED</h1>
        <div class="button-row"><button data-act="resume" data-icon="play">Resume</button></div>
        <div class="button-row">
          <button class="ghost" data-act="board" data-icon="board">Leaderboard</button>
          <button class="ghost" data-act="restart" data-icon="restart">Restart</button>
          <button class="ghost" data-act="quit" data-icon="quit">Quit</button>
        </div>
      </div>
    `;
    applyIcons(el);
    el.querySelector('[data-act="board"]')!.addEventListener('click', () => this.openBoard('pause'));
    el.querySelector('[data-act="resume"]')!.addEventListener('click', () => this.cb.onResume());
    el.querySelector('[data-act="restart"]')!.addEventListener('click', () => this.cb.onRestart());
    el.querySelector('[data-act="quit"]')!.addEventListener('click', () => this.cb.onQuit());
  }

  // -- game over -----------------------------------------------------------

  private buildOver(): void {
    const el = this.makeScreen('over');
    el.innerHTML = `
      <div class="panel">
        <h2 class="score-heading">Your score</h2>
        <div class="final-score" data-role="score">0</div>
        <div class="stat-grid" data-role="stats"></div>

        <h2>Leaderboard</h2>
        <input type="text" data-role="name" maxlength="16" placeholder="YOUR NAME"
               autocomplete="off" autocapitalize="characters" spellcheck="false" />
        <div class="button-row">
          <button data-act="submit" data-icon="submit">Submit score</button>
          <button class="ghost" data-act="again" data-icon="restart">Play again</button>
        </div>
        <div class="board" data-role="board"></div>
        <p class="notice" data-role="board-notice"></p>
        <div class="button-row">
          <button class="ghost" data-act="guide" data-icon="help">How to play</button>
          <button class="ghost" data-act="title" data-icon="home">Title</button>
        </div>
      </div>
    `;

    applyIcons(el);
    this.nameInput = el.querySelector<HTMLInputElement>('[data-role="name"]')!;
    this.submitButton = el.querySelector<HTMLButtonElement>('[data-act="submit"]')!;
    this.boardViews.push({
      rows: el.querySelector<HTMLElement>('[data-role="board"]')!,
      notice: el.querySelector<HTMLElement>('[data-role="board-notice"]')!,
    });

    this.submitButton.addEventListener('click', () => this.submit());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.submit();
      e.stopPropagation();
    });
    el.querySelector('[data-act="again"]')!.addEventListener('click', () => this.cb.onRestart());
    el.querySelector('[data-act="guide"]')!.addEventListener('click', () => this.show('guide'));
    el.querySelector('[data-act="title"]')!.addEventListener('click', () => this.cb.onQuit());
  }

  private submit(): void {
    const name = this.nameInput.value.trim();
    if (name.length === 0) {
      this.nameInput.focus();
      return;
    }
    this.setSubmitState('sending');
    this.cb.onSubmit(name);
  }

  showSummary(summary: RunSummary, storedName: string): void {
    this.lastSummary = summary;
    const el = this.screens.get('over')!;
    el.querySelector('[data-role="score"]')!.textContent = formatScore(summary.score);

    const stats = el.querySelector<HTMLElement>('[data-role="stats"]')!;
    stats.replaceChildren();
    for (const [label, value, ico] of [
      // "−1" is how the HUD writes depth mid-run, but on the results card,
      // with no floor under it for context, it just reads as a bad number.
      ['Got to', summary.maxDepth === 0 ? 'Surface' : `Floor ${summary.maxDepth}`, 'depth'],
      ['Floors dropped', String(summary.descents), 'layers'],
      ['Perfects', String(summary.perfects), 'target'],
      // The HUD only calls it a combo from two in a row, so anything less has
      // no number to show. "×0" just looks like a scoring bug.
      ['Best combo', summary.bestCombo >= 2 ? `×${summary.bestCombo}` : 'None', 'bolt'],
    ] as ReadonlyArray<readonly [string, string, IconName]>) {
      const d = document.createElement('div');
      const s = document.createElement('span');
      s.append(iconEl(ico), document.createTextNode(label));
      const b = document.createElement('b');
      b.textContent = value;
      d.append(s, b);
      stats.appendChild(d);
    }

    if (storedName && !this.nameInput.value) this.nameInput.value = storedName;
    this.setSubmitState('idle');
    this.setBoardLoading();
    this.cb.onRefreshBoard();
  }

  setSubmitState(
    state: 'idle' | 'sending' | 'done' | 'failed',
    message = '',
    doneLabel = 'Submitted',
  ): void {
    switch (state) {
      case 'sending':
        this.submitButton.disabled = true;
        this.submitButton.textContent = 'Sending…';
        setIcon(this.submitButton, 'submit');
        break;
      case 'done':
        this.submitButton.disabled = true;
        this.submitButton.textContent = doneLabel;
        setIcon(this.submitButton, 'check');
        break;
      case 'failed':
        this.submitButton.disabled = false;
        this.submitButton.textContent = 'Try again';
        setIcon(this.submitButton, 'warning');
        break;
      default:
        this.submitButton.disabled = false;
        this.submitButton.textContent = 'Submit score';
        setIcon(this.submitButton, 'submit');
    }
    if (message) {
      for (const view of this.boardViews) {
        view.notice.textContent = message;
        if (state === 'failed') view.notice.prepend(iconEl('warning'));
        view.notice.classList.toggle('warn', state === 'failed');
      }
    }
  }

  /** Render the board into every view. Rows use textContent, never innerHTML. */
  showBoard(result: BoardResult): void {
    for (const view of this.boardViews) this.renderBoardInto(view, result);
  }

  private renderBoardInto(
    view: { rows: HTMLElement; notice: HTMLElement },
    result: BoardResult,
  ): void {
    view.rows.replaceChildren();

    if (result.entries.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'notice';
      empty.textContent = 'Nobody has posted a score yet. Go on then.';
      view.rows.appendChild(empty);
    }

    for (const entry of result.entries) {
      const row = document.createElement('div');
      row.className = `board-row${entry.isSelf ? ' self' : ''}`;

      const rank = document.createElement('span');
      rank.className = 'rank';
      // The leader gets a crown rather than a numeral — it is the one row
      // anybody scans the board for.
      if (entry.rank === 1) rank.appendChild(iconEl('crown', 'crown'));
      else rank.textContent = `${entry.rank}.`;

      const name = document.createElement('span');
      name.textContent = entry.name;

      const score = document.createElement('span');
      score.className = 'score';
      score.textContent = formatScore(entry.score);

      row.append(rank, name, score);
      view.rows.appendChild(row);
    }

    if (result.source === 'local') {
      view.notice.textContent = result.error
        ? `Can't reach the online board (${result.error}), so these are your scores from this device.`
        : 'These are your scores from this device. The online board is not set up.';
      view.notice.prepend(iconEl('warning'));
      view.notice.classList.add('warn');
    } else {
      view.notice.textContent = '';
      view.notice.classList.remove('warn');
    }
  }

  // -- plumbing ------------------------------------------------------------

  private makeScreen(name: Exclude<ScreenName, null>): HTMLElement {
    const el = document.createElement('div');
    el.className = 'screen';
    el.id = `screen-${name}`;
    this.root.appendChild(el);
    this.screens.set(name, el);
    return el;
  }

  private buildRotateHint(): void {
    const el = document.createElement('div');
    el.id = 'rotate-hint';
    el.innerHTML = `<div>${icon('rotate', 'big')}<p>Turn your phone upright</p>
      <p class="notice">Pogo Drop needs a taller screen than this one.</p></div>`;
    this.root.appendChild(el);
    // Only nag on genuinely touch devices; a short desktop window is fine.
    if (window.matchMedia?.('(pointer: coarse)').matches) el.classList.add('enabled');
  }
}

const CONTROL_ROWS: ReadonlyArray<{ icon: IconName; keys: string; what: string }> = [
  {
    icon: 'mouse',
    keys: '<kbd>Move mouse</kbd>',
    what: 'Point where you want to land. The screen is the floor.',
  },
  {
    icon: 'keyboard',
    keys: '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>',
    what: 'Or steer with the keyboard, if you prefer',
  },
  { icon: 'click', keys: '<kbd>Space</kbd> / <kbd>Click</kbd>', what: 'Time your bounce as you land' },
  {
    icon: 'touch',
    keys: '<kbd>Touch</kbd>',
    what: 'Hold and drag to aim, let go to bounce',
  },
  { icon: 'pause', keys: '<kbd>Esc</kbd> / <kbd>P</kbd>', what: 'Take a breather' },
];

const LEGEND_ROWS: ReadonlyArray<{
  glyph: number;
  /** When set, the legend draws a composed multiplier instead of a glyph. */
  multiplier?: number;
  color: string;
  title: string;
  body: string;
}> = [
  {
    glyph: 7,
    color: '#38e8ff',
    title: 'NUMBER',
    body: 'Worth its face value times your multiplier. It counts down while you dither, so go early.',
  },
  {
    glyph: GLYPH.DOWN,
    multiplier: 3,
    color: '#3dffa0',
    title: 'DOWN',
    body: 'Shows what your multiplier becomes: <b>&times;2</b>, <b>&times;3</b> and up. <b>One per floor.</b> Bounce off it and the whole floor drops away beneath you. This is how you win.',
  },
  {
    glyph: GLYPH.UP,
    color: '#ff3b5c',
    title: 'UP',
    body: 'Bounces you back up a floor and knocks a multiplier off. Small mercy: the floor above has refilled while you were gone.',
  },
  {
    glyph: GLYPH.SPENT,
    color: '#5a6478',
    title: 'SPENT',
    body: "Already collected, or it ran out of time. Worth nothing now, and still in your way.",
  },
  {
    glyph: GLYPH.TIME,
    color: '#ffcc44',
    title: 'TIME',
    body: `Buys you ${TIME_TILE_BONUS} more seconds. You'll meet these on floor &minus;3. Take one and it's gone for good.`,
  },
  {
    glyph: GLYPH.BOOST,
    color: '#c78bff',
    title: 'BOOST',
    body: "Multiplier +1 without having to find the way down. Turns up from floor &minus;5. Gone once taken.",
  },
  {
    glyph: GLYPH.FREEZE,
    color: '#7fdcff',
    title: 'FREEZE',
    body: `Everything stops counting down for ${FREEZE.duration} seconds. From floor &minus;7. Gone once taken.`,
  },
];
