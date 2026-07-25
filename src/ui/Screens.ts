import { CLOCK, FREEZE, TIME_TILE_BONUS } from '../core/Config';
import { formatScore } from '../core/MathUtil';
import type { RunSummary } from '../game/GameState';
import type { BoardResult } from '../net/Leaderboard';
import { GLYPH, renderGlyphToCanvas, renderMultiplierToCanvas } from '../render/GlyphAtlas';

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
        <p class="tagline">Bounce down before the clock runs out</p>
        <div class="button-row">
          <button data-act="play">Play</button>
        </div>
        <div class="button-row">
          <button class="ghost" data-act="guide">How to play</button>
          <button class="ghost" data-act="board">Leaderboard</button>
          <button class="ghost" data-act="sound">Sound: on</button>
        </div>
        <p class="notice" data-role="best"></p>
        <p class="notice">
          GMTK Game Jam 2026 &middot; theme <b>Count Down</b>. Everything you see and hear is
          generated in code &mdash; no images, no fonts, no audio files.
        </p>
      </div>
    `;
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
          <button data-act="back">Back</button>
          <button class="ghost" data-act="refresh">Refresh</button>
        </div>
      </div>
    `;

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
      p.textContent = 'Loading scores…';
      view.rows.appendChild(p);
      view.notice.textContent = '';
      view.notice.classList.remove('warn');
    }
  }

  private toggleSound(): void {
    this.soundOn = !this.soundOn;
    this.soundButton.textContent = `Sound: ${this.soundOn ? 'on' : 'off'}`;
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
          You cannot stop bouncing. Every landing does something. One tile on each floor drops
          you to the floor below, and going down is the only way to make points worth anything.
          You have ${CLOCK.matchSeconds} seconds.
        </p>

        <h2>Controls</h2>
        <div class="keys" data-role="keys"></div>

        <h2>Timing your bounce</h2>
        <p>
          A ring closes in on the tile you are about to hit. Press exactly as it meets the
          square for a <b>PERFECT</b> bounce &mdash; higher, further, and it builds a combo
          multiplier. Mashing does not work: the first press wins, so one deliberate press
          beats eight panicked ones.
        </p>

        <h2>Tiles</h2>
        <div class="legend" data-role="legend"></div>

        <h2>The countdown</h2>
        <p>
          Numbers tick down about once a second, everywhere, all the time. A tile that reaches
          zero <b>burns out into an UP tile</b>. Every floor starts generous and rots into
          hostile, so points go stale &mdash; take the nine now, not the three later.
        </p>

        <div class="button-row">
          <button data-act="back">Back</button>
        </div>
      </div>
    `;

    const keys = el.querySelector<HTMLElement>('[data-role="keys"]')!;
    for (const [k, v] of CONTROL_ROWS) {
      const kEl = document.createElement('div');
      kEl.innerHTML = k;
      const vEl = document.createElement('div');
      vEl.textContent = v;
      keys.append(kEl, vEl);
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
      text.innerHTML = `<b>${row.title}</b> &mdash; ${row.body}`;
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
        <div class="button-row"><button data-act="resume">Resume</button></div>
        <div class="button-row">
          <button class="ghost" data-act="board">Leaderboard</button>
          <button class="ghost" data-act="restart">Restart</button>
          <button class="ghost" data-act="quit">Quit</button>
        </div>
      </div>
    `;
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
        <h2>Time up</h2>
        <div class="final-score" data-role="score">0</div>
        <div class="stat-grid" data-role="stats"></div>

        <h2>Leaderboard</h2>
        <input type="text" data-role="name" maxlength="16" placeholder="YOUR NAME"
               autocomplete="off" autocapitalize="characters" spellcheck="false" />
        <div class="button-row">
          <button data-act="submit">Submit score</button>
          <button class="ghost" data-act="again">Play again</button>
        </div>
        <div class="board" data-role="board"></div>
        <p class="notice" data-role="board-notice"></p>
        <div class="button-row">
          <button class="ghost" data-act="guide">How to play</button>
          <button class="ghost" data-act="title">Title</button>
        </div>
      </div>
    `;

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
    this.submitButton.disabled = true;
    this.submitButton.textContent = 'Submitting…';
    this.cb.onSubmit(name);
  }

  showSummary(summary: RunSummary, storedName: string): void {
    this.lastSummary = summary;
    const el = this.screens.get('over')!;
    el.querySelector('[data-role="score"]')!.textContent = formatScore(summary.score);

    const stats = el.querySelector<HTMLElement>('[data-role="stats"]')!;
    stats.replaceChildren();
    for (const [label, value] of [
      ['Deepest', summary.maxDepth === 0 ? 'Surface' : `−${summary.maxDepth}`],
      ['Descents', String(summary.descents)],
      ['Perfects', String(summary.perfects)],
      ['Best combo', `×${summary.bestCombo}`],
    ] as const) {
      const d = document.createElement('div');
      const s = document.createElement('span');
      s.textContent = label;
      const b = document.createElement('b');
      b.textContent = value;
      d.append(s, b);
      stats.appendChild(d);
    }

    if (storedName && !this.nameInput.value) this.nameInput.value = storedName;
    this.submitButton.disabled = false;
    this.submitButton.textContent = 'Submit score';
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
        this.submitButton.textContent = 'Submitting…';
        break;
      case 'done':
        this.submitButton.disabled = true;
        this.submitButton.textContent = doneLabel;
        break;
      case 'failed':
        this.submitButton.disabled = false;
        this.submitButton.textContent = 'Retry submit';
        break;
      default:
        this.submitButton.disabled = false;
        this.submitButton.textContent = 'Submit score';
    }
    if (message) {
      for (const view of this.boardViews) {
        view.notice.textContent = message;
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
      empty.textContent = 'No scores yet. Be the first.';
      view.rows.appendChild(empty);
    }

    for (const entry of result.entries) {
      const row = document.createElement('div');
      row.className = `board-row${entry.isSelf ? ' self' : ''}`;

      const rank = document.createElement('span');
      rank.className = 'rank';
      rank.textContent = `${entry.rank}.`;

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
        ? `Showing local scores — online board unreachable (${result.error}).`
        : 'Showing scores saved on this device. Online board is not configured.';
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
    el.innerHTML = `<div><p>Rotate your device upright.</p>
      <p class="notice">Pogo Drop wants a taller screen than this.</p></div>`;
    this.root.appendChild(el);
    // Only nag on genuinely touch devices; a short desktop window is fine.
    if (window.matchMedia?.('(pointer: coarse)').matches) el.classList.add('enabled');
  }
}

const CONTROL_ROWS: ReadonlyArray<readonly [string, string]> = [
  ['<kbd>Move mouse</kbd>', 'Steer — the screen is the floor, point where you want to go'],
  ['<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>', 'Steer with the keyboard instead'],
  ['<kbd>Space</kbd> / <kbd>Click</kbd>', 'Time your bounce'],
  ['<kbd>Drag</kbd>', 'On touch: drag to steer, tap to bounce'],
  ['<kbd>Esc</kbd> / <kbd>P</kbd>', 'Pause'],
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
    body: 'Scores its value times your multiplier. The number ticks down, so grab it while it is high.',
  },
  {
    glyph: GLYPH.DOWN,
    multiplier: 3,
    color: '#3dffa0',
    title: 'DOWN',
    body: 'Shows the multiplier you get for taking it — <b>&times;2</b>, <b>&times;3</b> and so on. Bounce off it and the whole floor falls away. This is how you win.',
  },
  {
    glyph: GLYPH.UP,
    color: '#ff3b5c',
    title: 'UP',
    body: 'Throws you back to the floor above. Multiplier &minus;1 and lost time &mdash; but anything that burned out up there comes back as numbers.',
  },
  {
    glyph: GLYPH.SPENT,
    color: '#5a6478',
    title: 'SPENT',
    body: 'Already cashed, or burned out to nothing. Worth no points, still in your way.',
  },
  {
    glyph: GLYPH.TIME,
    color: '#ffcc44',
    title: 'TIME',
    body: `Adds ${TIME_TILE_BONUS} seconds to the clock. Appears once you get deep enough.`,
  },
  {
    glyph: GLYPH.BOOST,
    color: '#c78bff',
    title: 'BOOST',
    body: 'Multiplier +1 outright, without having to descend for it.',
  },
  {
    glyph: GLYPH.FREEZE,
    color: '#7fdcff',
    title: 'FREEZE',
    body: `Stops every countdown on the board for ${FREEZE.duration} seconds. Farm fast.`,
  },
];
