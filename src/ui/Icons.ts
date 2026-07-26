/**
 * Procedural line-art icons for the DOM UI.
 *
 * Same rule as everything else in this project: no files, no libraries. Each
 * icon is geometry computed at call time on a shared 24-unit grid, with one
 * stroke weight and round caps, so the UI reads as the same hand that drew the
 * tiles rather than as a downloaded icon set bolted onto a line-art game.
 *
 * SVG rather than the Canvas2D path used for the in-world glyphs, because these
 * live in the DOM: they scale with the button's font size, inherit its colour
 * through `currentColor` — which is what makes one definition work on both a
 * solid button (dark ink) and a ghost button (accent) — and cost no texture
 * memory.
 *
 * The markup produced here is entirely code-generated and never interpolates
 * caller data, so assigning it through `innerHTML` introduces no injection path.
 */

const GRID = 24;
const STROKE = 2;

const r2 = (n: number): number => Math.round(n * 100) / 100;

// -- geometry helpers --------------------------------------------------------

/** Polyline through points, optionally closed. */
function line(points: ReadonlyArray<readonly [number, number]>, close = false): string {
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${r2(x)} ${r2(y)}`).join(' ');
  return `<path d="${d}${close ? ' Z' : ''}"/>`;
}

/** Filled polygon — used sparingly, where a solid shape reads better. */
function solid(points: ReadonlyArray<readonly [number, number]>): string {
  const d = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${r2(x)} ${r2(y)}`).join(' ');
  return `<path d="${d} Z" fill="currentColor" stroke-linejoin="round"/>`;
}

function circle(cx: number, cy: number, radius: number): string {
  return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(radius)}"/>`;
}

function dot(cx: number, cy: number, radius = 1.15): string {
  return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(radius)}" fill="currentColor" stroke="none"/>`;
}

function rect(x: number, y: number, w: number, h: number, radius = 0): string {
  return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r2(radius)}"/>`;
}

const rad = (deg: number): number => (deg * Math.PI) / 180;

function pointOn(cx: number, cy: number, radius: number, deg: number): [number, number] {
  return [cx + Math.cos(rad(deg)) * radius, cy + Math.sin(rad(deg)) * radius];
}

/** Arc from `fromDeg` to `toDeg`, degrees clockwise from three o'clock. */
function arc(cx: number, cy: number, radius: number, fromDeg: number, toDeg: number): string {
  const [x0, y0] = pointOn(cx, cy, radius, fromDeg);
  const [x1, y1] = pointOn(cx, cy, radius, toDeg);
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const sweep = toDeg > fromDeg ? 1 : 0;
  return `<path d="M ${r2(x0)} ${r2(y0)} A ${r2(radius)} ${r2(radius)} 0 ${large} ${sweep} ${r2(x1)} ${r2(y1)}"/>`;
}

/** A small solid arrowhead, pointing along `deg`. */
function head(x: number, y: number, deg: number, size = 3.4): string {
  const back = deg + 180;
  return solid([
    [x, y],
    [x + Math.cos(rad(back - 26)) * size, y + Math.sin(rad(back - 26)) * size],
    [x + Math.cos(rad(back + 26)) * size, y + Math.sin(rad(back + 26)) * size],
  ]);
}

/** Chevron pointing along `deg`, centred on (x, y). */
function chevron(x: number, y: number, deg: number, size = 4): string {
  const a = pointOn(x, y, size, deg - 135);
  const b = pointOn(x, y, size, deg + 135);
  return line([a, [x, y], b]);
}

/** N evenly spaced bars rising from a baseline — the leaderboard podium. */
function bars(heights: readonly number[], baseline: number, top: number): string {
  const w = 4.2;
  const gap = (GRID - 4 - heights.length * w) / Math.max(1, heights.length - 1);
  return heights
    .map((h, i) => {
      const x = 2 + i * (w + gap);
      const y = baseline - (baseline - top) * h;
      return rect(x, y, w, baseline - y);
    })
    .join('');
}

/** Star as a polar zig-zag, rather than typed-out path data. */
function star(cx: number, cy: number, outer: number, inner: number, points = 5): string {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < points * 2; i++) {
    const deg = -90 + (i * 360) / (points * 2);
    pts.push(pointOn(cx, cy, i % 2 === 0 ? outer : inner, deg));
  }
  return line(pts, true);
}

/** Concentric rings — a target, drawn by loop rather than by repetition. */
function rings(cx: number, cy: number, outer: number, count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) out += circle(cx, cy, outer * (1 - i / count));
  return out;
}

// -- the set -----------------------------------------------------------------

const SPEAKER: ReadonlyArray<readonly [number, number]> = [
  [4, 9.5],
  [7.5, 9.5],
  [11.5, 5.5],
  [11.5, 18.5],
  [7.5, 14.5],
  [4, 14.5],
];

const ICONS = {
  /** Play / resume. */
  play: () => solid([
    [8.5, 5],
    [19, 12],
    [8.5, 19],
  ]),

  pause: () => rect(7.5, 5, 3, 14, 1) + rect(13.5, 5, 3, 14, 1),

  /** How to play. */
  help: () =>
    circle(12, 12, 9) +
    arc(12, 9.4, 3, 200, 375) +
    line([
      ...[pointOn(12, 9.4, 3, 15)],
      [12, 13.6],
      [12, 15],
    ]) +
    dot(12, 17.6, 1.1),

  /** Leaderboard: a podium, tallest in the middle. */
  board: () => bars([0.62, 1, 0.44], 20.5, 4),

  soundOn: () => line(SPEAKER, true) + arc(12.5, 12, 3.6, -55, 55) + arc(12.5, 12, 6.4, -50, 50),

  soundOff: () =>
    line(SPEAKER, true) +
    line([
      [15.5, 9],
      [20.5, 15],
    ]) +
    line([
      [20.5, 9],
      [15.5, 15],
    ]),

  back: () =>
    line([
      [20, 12],
      [5.5, 12],
    ]) + chevron(5.5, 12, 180, 4.6),

  /** Refresh: an open loop closed by an arrowhead. */
  refresh: () => arc(12, 12, 7.5, -60, 200) + head(...pointOn(12, 12, 7.5, 200), 290),

  /** Restart: the same loop the other way round, so it never reads as refresh. */
  restart: () => arc(12, 12, 7.5, 240, -20) + head(...pointOn(12, 12, 7.5, -20), -110),

  /** Quit: an arrow leaving an open frame. */
  quit: () =>
    line([
      [13, 4.5],
      [4.5, 4.5],
      [4.5, 19.5],
      [13, 19.5],
    ]) +
    line([
      [9.5, 12],
      [19.5, 12],
    ]) +
    head(20, 12, 0),

  /** Submit: up and out of a tray. */
  submit: () =>
    line([
      [4.5, 15.5],
      [4.5, 19.5],
      [19.5, 19.5],
      [19.5, 15.5],
    ]) +
    line([
      [12, 15],
      [12, 4.5],
    ]) +
    head(12, 4, -90),

  check: () =>
    line([
      [4.5, 12.5],
      [9.5, 18],
      [19.5, 6],
    ]),

  home: () =>
    line([
      [3.5, 11],
      [12, 4],
      [20.5, 11],
    ]) +
    line([
      [5.8, 10.2],
      [5.8, 20],
      [18.2, 20],
      [18.2, 10.2],
    ]),

  clock: () =>
    circle(12, 12, 8.5) +
    line([
      [12, 6.8],
      [12, 12],
      [16, 14.2],
    ]),

  /** Depth: chevrons stepping down. */
  depth: () => chevron(12, 9, 90, 4.6) + chevron(12, 15.5, 90, 4.6),

  /** Score. */
  star: () => star(12, 12.4, 8.4, 3.6),

  times: () =>
    line([
      [6, 6],
      [18, 18],
    ]) +
    line([
      [18, 6],
      [6, 18],
    ]),

  /** Perfect bounces. */
  target: () => rings(12, 12, 8.5, 3) + dot(12, 12, 1.3),

  /** Combo streak. */
  bolt: () =>
    line(
      [
        [13.5, 3],
        [6, 13.5],
        [11, 13.5],
        [10.5, 21],
        [18, 10.5],
        [13, 10.5],
      ],
      true,
    ),

  /** Descents. */
  layers: () => {
    let out = '';
    for (let i = 0; i < 3; i++) {
      const y = 6 + i * 6;
      out += line(
        [
          [12, y - 2.6],
          [20, y],
          [12, y + 2.6],
          [4, y],
        ],
        true,
      );
    }
    return out;
  },

  warning: () =>
    line(
      [
        [12, 4],
        [21, 19.5],
        [3, 19.5],
      ],
      true,
    ) +
    line([
      [12, 10],
      [12, 14.5],
    ]) +
    dot(12, 17, 1.05),

  /** Rank one. */
  crown: () =>
    line(
      [
        [3.5, 17.5],
        [3.5, 7],
        [7.75, 11],
        [12, 5.5],
        [16.25, 11],
        [20.5, 7],
        [20.5, 17.5],
      ],
      true,
    ),

  /** Turn the phone upright. */
  rotate: () =>
    rect(9.5, 6, 5, 12, 1.2) +
    arc(12, 12, 9.5, 150, 208) +
    head(...pointOn(12, 12, 9.5, 210), 300, 3.8) +
    arc(12, 12, 9.5, -30, 28) +
    head(...pointOn(12, 12, 9.5, 30), 120, 3.8),

  mouse: () =>
    rect(7, 3.5, 10, 17, 5) +
    line([
      [12, 7],
      [12, 10.5],
    ]) +
    line([
      [3.5, 12],
      [5.2, 12],
    ]) +
    line([
      [18.8, 12],
      [20.5, 12],
    ]),

  keyboard: () => {
    let keys = '';
    for (let i = 0; i < 4; i++) keys += dot(6.5 + i * 3.7, 10.5, 0.85);
    for (let i = 0; i < 3; i++) keys += dot(8.3 + i * 3.7, 14.5, 0.85);
    return rect(2.5, 6, 19, 12, 1.6) + keys;
  },

  /** A press: impact rays over the button being pressed. */
  click: () => {
    let rays = '';
    for (const deg of [-150, -90, -30]) {
      rays += line([pointOn(12, 8.8, 4.2, deg), pointOn(12, 8.8, 7.4, deg)]);
    }
    return rays + rect(6.5, 9, 11, 13, 5.5) + dot(12, 13.2, 1.4);
  },

  /** A hand with a pointing finger — the one shape touch always reads as. */
  touch: () =>
    rect(8, 11, 10, 10, 3.2) +
    line([
      [10, 12],
      [10, 6.2],
    ]) +
    arc(11.5, 6.2, 1.5, 180, 360) +
    line([
      [13, 6.2],
      [13, 11],
    ]),
} as const;

export type IconName = keyof typeof ICONS;

/** Every icon, for the dev icon sheet. */
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(ICONS, name);
}

/**
 * SVG markup for an icon, sized in `em` so it tracks the text beside it.
 *
 * `aria-hidden` throughout: every icon here sits next to its own label, so
 * announcing it would make a screen reader read everything twice.
 */
export function icon(name: IconName, extraClass = ''): string {
  return (
    `<svg class="icon${extraClass ? ` ${extraClass}` : ''}" viewBox="0 0 ${GRID} ${GRID}" ` +
    `fill="none" stroke="currentColor" stroke-width="${STROKE}" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">` +
    `${ICONS[name]()}</svg>`
  );
}

/** The same icon as a detached element, for code that builds DOM directly. */
export function iconEl(name: IconName, extraClass = ''): SVGSVGElement {
  const holder = document.createElement('div');
  holder.innerHTML = icon(name, extraClass);
  return holder.firstElementChild as SVGSVGElement;
}

/**
 * Give every `[data-icon]` element inside `root` its icon.
 *
 * Declarative on purpose: the screens are authored as HTML templates, so the
 * alternative is a `querySelector` and an `insertAdjacentHTML` for every single
 * button. Idempotent, so re-running it on a rebuilt screen cannot double up.
 */
export function applyIcons(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = el.dataset.icon;
    if (!name || !isIconName(name)) continue;
    if (el.firstElementChild?.classList.contains('icon')) continue;
    el.insertAdjacentHTML('afterbegin', icon(name));
    el.classList.add('has-icon');
  }
}

/**
 * Swap the icon on an element that already has one — a button whose meaning
 * changes, such as sound on/off or submit → submitted.
 */
export function setIcon(el: HTMLElement, name: IconName): void {
  el.querySelector(':scope > .icon')?.remove();
  el.insertAdjacentHTML('afterbegin', icon(name));
  el.classList.add('has-icon');
  el.dataset.icon = name;
}
