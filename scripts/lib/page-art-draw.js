/*
 * Pogo Drop page art — the drawing half.
 *
 * Plain browser script, loaded into a headless Chromium by scripts/page-art.mjs
 * and called once per frame. Kept separate from the driver so the look can be
 * retuned without touching the screenshot and encoding plumbing.
 *
 * The scene is one idea: an infinite shaft of identical floors, each a
 * different depth hue, falling away through the hole in the middle of the one
 * above it. That is the game — PALETTE.depthHues is indexed by depth, and the
 * board structure does not change as you descend, only its colour does.
 *
 * It is also what makes the animation loop seamlessly. Layer k sits at scale
 * F^(k+t) for phase t in [0,1), so at t=1 every layer has taken the place of
 * the one below it and the frame is identical to t=0 — provided each layer
 * carries the same board, and provided hue slides one step along depthHues
 * across the loop, which is exactly the descent the palette describes.
 */
(function () {
  'use strict';

  /** Gap between tiles, as a fraction of the whole board. */
  const GUTTER = 0.018;

  /**
   * How much of the hole the next floor down fills. Under 1 so a rim of void
   * shows around it — that rim is the only thing distinguishing "a shaft with a
   * floor at the bottom" from "a pattern inside a pattern".
   */
  const HOLE_FIT = 0.9;

  /**
   * A fixed board. Identical on every floor, which the seamless loop requires
   * and the game's own generator roughly agrees with: floors differ by hue and
   * by spawn mix, not by shape.
   *
   * `.` is the hole. It has to be a hole rather than a dark tile — the whole
   * image depends on seeing the next floor through it, which is also how the
   * game reads: the down tile is where the next floor is visible.
   */
  const BOARD = [
    ['7', 'up', '3', '5', 'time', '2', 'up'],
    ['up', '2', '9', 'x2', '6', 'up', '4'],
    ['4', '8', '.', '.', '.', '6', '1'],
    ['up', 'spent', '.', '.', '.', '3', 'up'],
    ['2', 'freeze', '.', '.', '.', '9', '4'],
    ['5', 'up', '6', '1', 'up', '8', '3'],
    ['up', '3', 'x2', '7', '4', 'up', 'spent'],
  ];

  const CELLS = BOARD.length;

  /** One cell, as a fraction of the board. */
  const CELL_FRACTION = (1 - GUTTER * (CELLS - 1)) / CELLS;

  /** Width of the authored hole, in cells. */
  const HOLE_CELLS = (() => {
    let min = CELLS;
    let max = -1;
    for (let row = 0; row < CELLS; row += 1) {
      for (let col = 0; col < CELLS; col += 1) {
        if (BOARD[row][col] === '.') {
          min = Math.min(min, col);
          max = Math.max(max, col);
        }
      }
    }
    if (max < 0) throw new Error('BOARD has no hole — the shaft needs somewhere to go.');
    return max - min + 1;
  })();

  /** The hole, as a fraction of the board. */
  const HOLE_FRACTION = HOLE_CELLS * CELL_FRACTION + (HOLE_CELLS - 1) * GUTTER;

  /**
   * Ratio between adjacent floors, and therefore the zoom across one loop.
   *
   * Derived from the hole rather than chosen: it is exactly the factor that
   * drops the next floor into the gap in this one. Picking a round number
   * instead (2 was the first attempt) leaves the floor below wider than the
   * hole it shows through, so the tiles around it clip it and the image reads
   * as a fractal knot rather than as somewhere you could fall.
   *
   * It also sets how much of the descent is visible at once, which is why the
   * hole is nine cells and not one: a one-cell hole forces a ratio near six,
   * and at six the third floor down is already too small to read. Widen the
   * hole and more of the shaft comes into view, for free.
   */
  const FLOOR_RATIO = 1 / (HOLE_FRACTION * HOLE_FIT);

  function hsla(h, s, l, a) {
    return 'hsla(' + h + ',' + s * 100 + '%,' + l * 100 + '%,' + a + ')';
  }

  /** Shortest path between two hue angles, so 28 to 336 goes down through 0. */
  function lerpHue(a, b, t) {
    const d = (((b - a + 540) % 360) - 180) * t;
    return (a + d + 360) % 360;
  }

  /**
   * Sample depthHues at a fractional index, wrapping. Lets the shaft take a
   * hue *between* two depths, which is what allows the progression across
   * visible floors to be slower than one entry per floor.
   */
  function sampleHues(hues, at) {
    const n = hues.length;
    const p = ((at % n) + n) % n;
    const i = Math.floor(p);
    return lerpHue(hues[i], hues[(i + 1) % n], p - i);
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad);
    ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);
    ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  /** Stacked chevrons — the UP tile, and the one thing on the board that is red. */
  function chevrons(ctx, cx, cy, size, colour, width, count) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const step = size * 0.24;
    const half = size * 0.28;
    for (let i = 0; i < count; i += 1) {
      const y = cy + step * (i - (count - 1) / 2) + step * 0.3;
      ctx.beginPath();
      ctx.moveTo(cx - half, y);
      ctx.lineTo(cx, y - step * 0.7);
      ctx.lineTo(cx + half, y);
      ctx.stroke();
    }
  }

  function clockFace(ctx, cx, cy, size, colour, width) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.28, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, cy - size * 0.02);
    ctx.lineTo(cx, cy - size * 0.18);
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + size * 0.13, cy + size * 0.04);
    ctx.stroke();
  }

  function snowflake(ctx, cx, cy, size, colour, width) {
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    const r = size * 0.28;
    for (let i = 0; i < 3; i += 1) {
      const a = (Math.PI / 3) * i;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(a) * r, cy - Math.sin(a) * r);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.stroke();
    }
  }

  function glyph(ctx, kind, cx, cy, size, hue, palette, alpha) {
    const stroke = size * 0.075;

    if (kind === 'up') {
      chevrons(ctx, cx, cy, size, hsla(palette.hostileHue, 0.86, 0.58, alpha), stroke * 1.5, 3);
      return;
    }
    if (kind === 'x2') {
      ctx.fillStyle = hsla(palette.downHue, 0.86, 0.56, alpha);
      ctx.font = '700 ' + size * 0.5 + 'px ' + palette.mono;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('x2', cx, cy + size * 0.02);
      return;
    }
    if (kind === 'time') {
      clockFace(ctx, cx, cy, size, hsla(palette.timeHue, 0.86, 0.56, alpha), stroke * 1.3);
      return;
    }
    if (kind === 'freeze') {
      snowflake(ctx, cx, cy, size, hsla(palette.freezeHue, 0.86, 0.58, alpha), stroke * 1.3);
      return;
    }
    if (kind === 'spent') {
      // A decayed tile: the ring the game leaves behind when a number burns out.
      ctx.strokeStyle = hsla(hue, 0.4, palette.spentLightness + 0.12, alpha);
      ctx.lineWidth = stroke;
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.2, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }

    ctx.fillStyle = hsla(hue, palette.lineSaturation, palette.lineLightness + 0.14, alpha);
    ctx.font = '700 ' + size * 0.56 + 'px ' + palette.mono;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(kind, cx, cy + size * 0.03);
  }

  /**
   * One floor: a CELLS x CELLS board centred at cx,cy spanning `span` pixels.
   * The hole is left untouched so whatever was drawn beneath shows through.
   */
  function drawFloor(ctx, cx, cy, span, hue, alpha, palette) {
    const gutter = span * GUTTER;
    const cell = span * CELL_FRACTION;
    if (cell < 3) return;

    const radius = cell * 0.1;
    const line = Math.max(0.6, cell * 0.05);

    for (let row = 0; row < CELLS; row += 1) {
      for (let col = 0; col < CELLS; col += 1) {
        const kind = BOARD[row][col];
        if (kind === '.') continue;

        const x = cx - span / 2 + col * (cell + gutter);
        const y = cy - span / 2 + row * (cell + gutter);

        let tileHue = hue;
        if (kind === 'up') tileHue = palette.hostileHue;
        else if (kind === 'x2') tileHue = palette.downHue;
        else if (kind === 'time') tileHue = palette.timeHue;
        else if (kind === 'freeze') tileHue = palette.freezeHue;

        // Dark tinted fill, near-opaque so a tile actually occludes the floor
        // below it. Without that the shaft turns to soup.
        ctx.fillStyle = hsla(tileHue, 0.55, 0.055, alpha * 0.94);
        roundRect(ctx, x, y, cell, cell, radius);
        ctx.fill();

        ctx.strokeStyle = hsla(
          tileHue,
          palette.lineSaturation,
          kind === 'spent' ? palette.spentLightness : palette.lineLightness,
          alpha,
        );
        ctx.lineWidth = line;
        roundRect(ctx, x, y, cell, cell, radius);
        ctx.stroke();

        if (cell > 14) glyph(ctx, kind, x + cell / 2, y + cell / 2, cell, tileHue, palette, alpha);
      }
    }
  }

  /**
   * The shaft. Layers are drawn deepest first so nearer floors occlude them,
   * which is what turns a stack of grids into a hole with a bottom.
   */
  function drawShaft(ctx, w, h, phase, palette, opts) {
    const cx = w * (opts.centreX ?? 0.5);
    const cy = h * (opts.centreY ?? 0.5);
    const base = Math.max(w, h) * (opts.baseSpan ?? 1.5);
    const hues = palette.depthHues;

    // Floors below this are a few pixels across and read as coloured noise
    // rather than as tiles. Worth stopping early for the animation in
    // particular: high-frequency detail is what a GIF pays most for, and the
    // shaft looks better falling away into black than into static.
    const minSpan = opts.minSpan ?? 6;

    for (let k = opts.deepest ?? -8; k <= (opts.nearest ?? 1); k += 1) {
      const span = base * Math.pow(FLOOR_RATIO, k + phase);
      if (span < minSpan) continue;

      // depthHues is indexed by depth, so the *deeper* layer takes the *later*
      // hue. Getting this backwards inverts the palette's whole argument: the
      // shaft came out violet at the surface and cyan at the bottom, which is
      // the descent running the wrong way.
      //
      // Rate under 1 spreads one hue entry across more than one floor. At a
      // full entry per floor the four visible floors are four different
      // colours, which is a rainbow rather than a descent — in the game you
      // only ever see a floor or two at once, so the palette never has to hold
      // up under being seen all at once. The seamless loop survives any rate,
      // because hue depends only on (k + phase): layer k at phase 1 is exactly
      // where layer k+1 sat at phase 0, and takes the hue to match.
      const rate = opts.hueRate ?? 0.45;
      const hue = sampleHues(hues, ((opts.hueOffset ?? 0.5) - (k + phase)) * rate);

      // The far fade is measured against minSpan, not against the canvas, so a
      // floor reaches zero opacity exactly where it gets culled. Scale the two
      // independently and the deepest floor pops into existence at half
      // brightness — which in a loop is a flicker once per cycle.
      let alpha = Math.min(1, Math.max(0, (span / minSpan - 1) / 3));

      // And ease the nearest one out as it grows past the edges.
      const smallness = span / Math.max(w, h);
      if (smallness > 1.5) alpha *= Math.max(0, 1 - (smallness - 1.5) / 2.2);
      if (alpha <= 0.004) continue;

      drawFloor(ctx, cx, cy, span, hue, alpha * (opts.layerAlpha ?? 1), palette);
    }
  }

  /** Bloom. Two radii: a tight core and a wide halo, composited additively. */
  function bloom(target, source, w, h, passes) {
    for (const pass of passes) {
      target.save();
      target.globalCompositeOperation = 'lighter';
      target.globalAlpha = pass.alpha;
      target.filter = 'blur(' + pass.radius + 'px)';
      target.drawImage(source, 0, 0, w, h);
      target.restore();
    }
  }

  function vignette(ctx, w, h, strength) {
    const g = ctx.createRadialGradient(
      w / 2,
      h / 2,
      Math.min(w, h) * 0.16,
      w / 2,
      h / 2,
      Math.max(w, h) * 0.76,
    );
    g.addColorStop(0, 'rgba(5,6,10,0)');
    g.addColorStop(1, 'rgba(5,6,10,' + strength + ')');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }

  /** The cyan-at-the-surface, violet-at-the-bottom wash the CSS theme also runs. */
  function descentWash(ctx, w, h, palette, strength) {
    const top = ctx.createRadialGradient(w / 2, -h * 0.1, 0, w / 2, -h * 0.1, h * 0.95);
    top.addColorStop(0, hsla(palette.depthHues[0], 0.85, 0.5, 0.16 * strength));
    top.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = top;
    ctx.fillRect(0, 0, w, h);

    const bottom = ctx.createRadialGradient(w / 2, h * 1.1, 0, w / 2, h * 1.1, h);
    bottom.addColorStop(0, hsla(palette.depthHues[8], 0.85, 0.5, 0.2 * strength));
    bottom.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bottom;
    ctx.fillRect(0, 0, w, h);
  }

  /**
   * Render one frame.
   *
   * @param {CanvasRenderingContext2D} ctx destination
   * @param {object} spec { w, h, phase, palette, scene }
   */
  function drawFrame(ctx, spec) {
    const { w, h, phase, palette } = spec;
    const scene = spec.scene ?? {};

    // The shaft is drawn to its own canvas so bloom can be taken from it alone
    // — blurring the finished frame would smear the vignette and lift the
    // blacks, which is the "atmosphere instead of glow" failure the game's own
    // bloom notes warn about.
    const layer = document.createElement('canvas');
    layer.width = w;
    layer.height = h;
    const lc = layer.getContext('2d');
    drawShaft(lc, w, h, phase, palette, scene);

    ctx.fillStyle = '#05060a';
    ctx.fillRect(0, 0, w, h);
    descentWash(ctx, w, h, palette, scene.washStrength ?? 1);

    ctx.drawImage(layer, 0, 0);
    bloom(
      ctx,
      layer,
      w,
      h,
      scene.bloom ?? [
        { radius: Math.max(w, h) * 0.008, alpha: 0.5 },
        { radius: Math.max(w, h) * 0.03, alpha: 0.28 },
      ],
    );

    vignette(ctx, w, h, scene.vignette ?? 0.72);
  }

  window.PogoArt = { drawFrame, FLOOR_RATIO };
})();
