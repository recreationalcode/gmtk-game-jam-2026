/**
 * Generate the itch.io page art.
 *
 *   npm run art              all of it
 *   npm run art -- cover     one asset, for iterating on the look
 *
 * Nothing here is hand-drawn. The palette is parsed out of src/core/Config.ts
 * at generation time, so the page art cannot quietly disagree with the game the
 * way a hand-picked PNG would after a palette change — retune PALETTE, re-run
 * this, and the page follows. Parsing fails loudly rather than falling back to
 * a copy of the values, because a silent fallback is exactly how the two drift.
 *
 * Chromium does the drawing (canvas 2D via scripts/lib/page-art-draw.js) and
 * gifenc does the GIF encoding. Not ffmpeg: the copy Playwright bundles is
 * configured `--disable-everything` for its own screencast needs, with no GIF
 * muxer and no palettegen filter, so it cannot write a GIF at all.
 */
import { chromium } from 'playwright';
// gifenc ships a CommonJS bundle whose exports are getters, which Node cannot
// statically detect — named imports fail, the default interop object works.
import gifenc from 'gifenc';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'itch');
const DRAW = path.join(ROOT, 'scripts', 'lib', 'page-art-draw.js');
const CONFIG = path.join(ROOT, 'src', 'core', 'Config.ts');

const CHROMIUM =
  process.env.ART_CHROMIUM ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

/**
 * Ordered dither, applied before quantising to 8 bits.
 *
 * A GIF gets 256 colours and this scene spends nearly all of them on neon, so
 * the large dark areas — the vignette, the wash, the void between floors — come
 * back as visible contour rings. A couple of levels of ordered noise breaks the
 * bands up for far less size than throwing palette entries at the problem.
 * Amplitude is deliberately low: dither is incompressible, and LZW pays for it.
 */
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];
/** Nudge each pixel by its position in the Bayer matrix, in place. Alpha is left alone. */
function dither(rgba, width, amplitude) {
  if (amplitude <= 0) return;
  for (let i = 0; i < rgba.length; i += 4) {
    const pixel = i >> 2;
    const bias = (BAYER_8[((pixel / width) | 0) & 7][(pixel % width) & 7] / 63 - 0.5) * amplitude;
    for (let c = 0; c < 3; c += 1) {
      rgba[i + c] = Math.max(0, Math.min(255, Math.round(rgba[i + c] + bias)));
    }
  }
}

const MONO =
  'ui-monospace, "SF Mono", SFMono-Regular, "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';

function fail(message) {
  console.error(`\n  page-art: ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Palette, read from the game
// ---------------------------------------------------------------------------

function readPalette() {
  const src = fs.readFileSync(CONFIG, 'utf8');
  const block = src.match(/export const PALETTE = \{([\s\S]*?)\n\} as const;/);
  if (!block) fail(`could not find the PALETTE block in ${path.relative(ROOT, CONFIG)}.`);

  const scalar = (name) => {
    const m = block[1].match(new RegExp(`\\b${name}:\\s*([0-9.]+)`));
    if (!m) fail(`PALETTE.${name} not found — has Config.ts been restructured?`);
    return Number(m[1]);
  };

  const hues = block[1].match(/depthHues:\s*\[([^\]]+)\]/);
  if (!hues) fail('PALETTE.depthHues not found — has Config.ts been restructured?');

  return {
    depthHues: hues[1].split(',').map((n) => Number(n.trim())),
    hostileHue: scalar('hostileHue'),
    downHue: scalar('downHue'),
    timeHue: scalar('timeHue'),
    boostHue: scalar('boostHue'),
    freezeHue: scalar('freezeHue'),
    lineSaturation: scalar('lineSaturation'),
    lineLightness: scalar('lineLightness'),
    spentLightness: scalar('spentLightness'),
    mono: MONO,
  };
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

/**
 * Composition per asset. `scene` is passed through to the drawing code; the
 * text block is drawn by this script, since where a title sits is composition
 * rather than scene.
 */
const ASSETS = {
  cover: {
    // PNG, unlike the other two stills. itch re-encodes covers into its own
    // thumbnail sizes, so a JPEG here would be compressed twice, and dark
    // gradients are exactly where that shows as blotching.
    file: 'cover-630x500.png',
    w: 630,
    h: 500,
    note: 'itch cover image — the required slot, shown on browse and jam pages',
    // Off-centre so the shaft does not sit behind the title, and the eye has
    // somewhere to go. The cover is seen at thumbnail size more often than not.
    scene: { centreX: 0.5, centreY: 0.66, baseSpan: 1.5, vignette: 0.8 },
    text: {
      title: 'POGO DROP',
      titleSize: 62,
      tagline: 'EVERY NUMBER IS COUNTING DOWN',
      taglineSize: 15,
      footnote: 'GMTK GAME JAM 2026',
      y: 0.19,
      footnoteY: 0.95,
    },
  },
  banner: {
    file: 'banner-1920x480.jpg',
    w: 1920,
    h: 480,
    quality: 0.93,
    note: 'wide banner for the top of the page description, and for sharing',
    scene: { centreX: 0.5, centreY: 0.5, baseSpan: 2.6, vignette: 0.82 },
    text: {
      title: 'POGO DROP',
      titleSize: 96,
      tagline: 'BOUNCE DOWN THROUGH COLLAPSING FLOORS BEFORE THE CLOCK RUNS OUT',
      taglineSize: 19,
      footnote: null,
      y: 0.36,
    },
  },
  background: {
    // 1920 wide, not 2560. It is stretched to cover a viewport and is a dim
    // out-of-focus backdrop; the extra pixels were paying for detail nobody
    // looks at, on the heaviest file on the page.
    file: 'background-1920x1080.jpg',
    w: 1920,
    h: 1080,
    quality: 0.9,
    note: 'page background — deliberately low contrast so body text stays readable',
    // A page background has one job it must not fail: staying behind the text.
    // Dimmed hard, pushed off centre so the busiest part of the shaft sits
    // under the right column rather than under the description.
    scene: {
      // Off to the right: at background-size cover the middle of the image sits
      // directly behind itch's content column, which is the one place the art
      // must not be interesting. This puts the shaft out past the column edge.
      centreX: 0.74,
      centreY: 0.46,
      baseSpan: 2.2,
      vignette: 0.9,
      layerAlpha: 0.32,
      washStrength: 0.75,
      bloom: [{ radius: 22, alpha: 0.32 }, { radius: 90, alpha: 0.2 }],
    },
    text: null,
  },
  embed: {
    file: 'embed-bg.gif',
    // Small on purpose. Every pixel moves in a zoom, so there is no inter-frame
    // redundancy for the encoder to find and size scales with area x frames.
    // It is a dark, glowing, out-of-focus backdrop that the CSS scales up — the
    // softness of the upscale is indistinguishable from more bloom, and the game
    // it sits behind is a 184kB download that should not wait on its wallpaper.
    w: 512,
    h: 288,
    note: 'animated embed surround — one seamless floor-to-floor descent',
    frames: 40,
    fps: 10,
    colors: 96,
    dither: 2,
    scene: {
      centreX: 0.5,
      centreY: 0.5,
      baseSpan: 1.45,
      vignette: 0.72,
      layerAlpha: 0.9,
      // A flatter wash than the stills get. Every pixel moves in a zoom, so
      // there is no inter-frame redundancy to lean on, and a smooth full-frame
      // gradient is the most expensive thing a GIF can be asked to hold — it
      // defeats the run-length coding LZW depends on. Flattening the wash turns
      // most of the frame back into one repeated colour.
      washStrength: 0.4,
      minSpan: 26,
    },
    text: null,
  },
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const shell = (drawSource) => `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #05060a; }
  canvas { display: block; }
</style>
<canvas id="c"></canvas>
<script>${drawSource}</script>
<script>
  const canvas = document.getElementById('c');
  const ctx = canvas.getContext('2d');

  /* Title block. Drawn after the scene so it sits over the bloom rather than
     inside it — text picked up by a blur pass turns to mush at small sizes,
     and the cover is a thumbnail more often than it is a picture. */
  function drawText(spec, palette) {
    const { w, h } = spec;
    const t = spec.text;
    if (!t) return;

    const accentHue = palette.depthHues[0];
    const accent = 'hsl(' + accentHue + ',82%,62%)';
    let y = h * t.y;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    /* A plate behind the type. Neon strokes behind a title cost legibility, and
       legibility is the whole job of a cover that is a 315x250 thumbnail more
       often than it is a picture. Nearly opaque through the middle: the first
       pass at 0.82 still let a green x2 tile read through the tagline. */
    const top = y - t.titleSize * 1.6;
    const plateH = t.titleSize * 3.1;
    const plate = ctx.createLinearGradient(0, top, 0, top + plateH);
    plate.addColorStop(0, 'rgba(5,6,10,0)');
    plate.addColorStop(0.28, 'rgba(5,6,10,0.95)');
    plate.addColorStop(0.72, 'rgba(5,6,10,0.95)');
    plate.addColorStop(1, 'rgba(5,6,10,0)');
    ctx.fillStyle = plate;
    ctx.fillRect(0, top, w, plateH);

    ctx.save();
    ctx.font = '700 ' + t.titleSize + 'px ' + palette.mono;
    ctx.shadowColor = 'hsla(' + accentHue + ',90%,60%,0.55)';
    ctx.shadowBlur = t.titleSize * 0.7;
    ctx.fillStyle = '#eef4ff';
    ctx.letterSpacing = (t.titleSize * 0.06) + 'px';
    ctx.fillText(t.title, w / 2, y);
    ctx.restore();

    y += t.titleSize * 0.85;
    ctx.save();
    ctx.font = '400 ' + t.taglineSize + 'px ' + palette.mono;
    ctx.letterSpacing = (t.taglineSize * 0.18) + 'px';
    ctx.fillStyle = accent;
    ctx.shadowColor = 'hsla(' + accentHue + ',90%,60%,0.4)';
    ctx.shadowBlur = t.taglineSize * 1.2;
    ctx.fillText(t.tagline, w / 2, y);
    ctx.restore();

    if (t.footnote) {
      /* Sat under the tagline at first, which put it straight on top of the
         second floor down — the one part of the shaft worth looking at. It
         belongs at the bottom edge, out of the way of the descent. */
      const fy = t.footnoteY ? h * t.footnoteY : y + t.taglineSize * 2.4;
      const size = t.taglineSize * 0.82;
      const strip = ctx.createLinearGradient(0, fy - size * 2.2, 0, fy + size * 1.4);
      strip.addColorStop(0, 'rgba(5,6,10,0)');
      strip.addColorStop(1, 'rgba(5,6,10,0.9)');
      ctx.fillStyle = strip;
      ctx.fillRect(0, fy - size * 2.2, w, size * 3.6);

      ctx.font = '400 ' + size + 'px ' + palette.mono;
      ctx.letterSpacing = (t.taglineSize * 0.24) + 'px';
      ctx.fillStyle = 'rgba(238,244,255,0.55)';
      ctx.fillText(t.footnote, w / 2, fy);
    }
  }

  window.renderFrame = (spec, palette, phase) => {
    canvas.width = spec.w;
    canvas.height = spec.h;
    window.PogoArt.drawFrame(ctx, {
      w: spec.w,
      h: spec.h,
      phase,
      palette,
      scene: spec.scene,
    });
    drawText(spec, palette);
    return true;
  };

  /* Raw RGBA as base64, for the GIF path. Chunked through fromCharCode because
     spreading a 1.2MB array into one call overflows the argument limit. */
  window.framePixels = (spec, palette, phase) => {
    window.renderFrame(spec, palette, phase);
    const data = ctx.getImageData(0, 0, spec.w, spec.h).data;
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < data.length; i += chunk) {
      binary += String.fromCharCode.apply(null, data.subarray(i, i + chunk));
    }
    return btoa(binary);
  };

  /* Encoded through the canvas rather than Playwright's screenshot, which only
     emits PNG. JPEG is worth having for the two large stills: they are smooth
     dark gradients where lossless coding spends most of its bytes on noise
     nobody can see. */
  window.frameEncoded = (spec, palette, phase, mime, quality) => {
    window.renderFrame(spec, palette, phase);
    return canvas.toDataURL(mime, quality).split(',')[1];
  };
</script>`;

async function main() {
  const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const names = wanted.length > 0 ? wanted : Object.keys(ASSETS);
  for (const name of names) if (!ASSETS[name]) fail(`unknown asset "${name}".`);

  if (!fs.existsSync(CHROMIUM)) fail(`Chromium not found at ${CHROMIUM}. Set ART_CHROMIUM.`);

  const palette = readPalette();
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.setContent(shell(fs.readFileSync(DRAW, 'utf8')));

  const made = [];

  for (const name of names) {
    const spec = ASSETS[name];
    const target = path.join(OUT, spec.file);

    if (!spec.frames) {
      // Encoder per format, because they are not equally good at both. Chromium's
      // canvas writes a PNG about 50% larger than Playwright's screenshot
      // encoder does for the same pixels, and Playwright only emits PNG — so
      // each format goes through whichever path is better at it.
      let bytes;
      if (spec.file.endsWith('.jpg')) {
        const b64 = await page.evaluate(
          ([s, p, q]) => window.frameEncoded(s, p, 0, 'image/jpeg', q),
          [spec, palette, spec.quality ?? 0.92],
        );
        bytes = Buffer.from(b64, 'base64');
      } else {
        await page.evaluate(([s, p]) => window.renderFrame(s, p, 0), [spec, palette]);
        bytes = await page.locator('#c').screenshot({ animations: 'disabled' });
      }
      fs.writeFileSync(target, bytes);
      made.push({ name, file: spec.file, bytes: bytes.length, note: spec.note });
      continue;
    }

    // The loop is a claim about the drawing code — that phase 1 reproduces
    // phase 0 exactly, because every layer has advanced into the place of the
    // one below it. Check it rather than trust it: a seam here is a visible
    // twitch every few seconds behind the game, and it is the kind of thing
    // that survives a glance at the first few frames.
    const frameAt = (phase) =>
      page.evaluate(([s, p, ph]) => window.framePixels(s, p, ph), [spec, palette, phase]);
    const [start, wrap] = [await frameAt(0), await frameAt(1)];
    if (start !== wrap) {
      fail(
        `${name}: phase 1 does not reproduce phase 0, so the loop would visibly jump.\n` +
          '  Every layer must advance exactly one floor across the loop, which means\n' +
          '  the zoom per loop has to equal FLOOR_RATIO and hue has to depend only on\n' +
          '  (k + phase). See scripts/lib/page-art-draw.js.',
      );
    }

    // Raw RGBA straight off the canvas rather than a PNG per frame: the frames
    // only exist to be quantised, and decoding PNG back to pixels would mean
    // another dependency to do work we just undid.
    const frames = [];
    for (let i = 0; i < spec.frames; i += 1) {
      // Phase stops one frame short of 1. Phase 1 is pixel-identical to phase 0
      // — that is what the check above just established — so including it would
      // hold the first frame twice and put a hitch in a loop whose whole selling
      // point is not having one.
      const phase = i / spec.frames;
      const b64 = await page.evaluate(
        ([s, p, ph]) => window.framePixels(s, p, ph),
        [spec, palette, phase],
      );
      frames.push(new Uint8Array(Buffer.from(b64, 'base64')));
    }

    for (const frame of frames) dither(frame, spec.w, spec.dither ?? 4);

    // One palette for the whole loop. Quantising per frame lets the palette
    // shift under a scene that is mostly slow gradient, and the void then
    // crawls between frames — the exact artefact a static background must not
    // have. Sampled across the loop so a colour that only appears halfway
    // through still gets a seat.
    const stride = Math.max(1, Math.floor(spec.frames / 12));
    const sampled = frames.filter((_, i) => i % stride === 0);
    const sample = new Uint8Array(sampled.length * frames[0].length);
    sampled.forEach((frame, i) => sample.set(frame, i * frames[0].length));
    const gifPalette = quantize(sample, spec.colors ?? 128);

    const gif = GIFEncoder();
    const delay = Math.round(1000 / spec.fps);
    frames.forEach((frame, i) => {
      const indexed = applyPalette(frame, gifPalette);
      // The palette is written once, as a global colour table. Passing it again
      // per frame makes gifenc emit a local table each time, which is 192 extra
      // colours on every frame for no change in what is displayed.
      gif.writeFrame(
        indexed,
        spec.w,
        spec.h,
        i === 0 ? { palette: gifPalette, first: true, delay, repeat: 0 } : { delay },
      );
    });
    gif.finish();

    const bytes = gif.bytes();
    fs.writeFileSync(target, bytes);
    made.push({
      name,
      file: spec.file,
      bytes: bytes.length,
      note: `${spec.note} — ${spec.frames} frames, ${(spec.frames / spec.fps).toFixed(1)}s loop`,
    });
  }

  await browser.close();

  console.log('\n  Pogo Drop — itch.io page art\n  ----------------------------');
  for (const m of made) {
    const size =
      m.bytes > 1024 * 1024
        ? `${(m.bytes / 1024 / 1024).toFixed(2)} MB`
        : `${Math.round(m.bytes / 1024)} kB`;
    console.log(`  ${m.file.padEnd(26)} ${size.padStart(9)}   ${m.note}`);
  }
  console.log(`\n  written to ${path.relative(ROOT, OUT)}/\n`);
}

await main();
