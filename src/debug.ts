/**
 * Dev diagnostics, loaded only by debug.html. Not part of the shipped build.
 */
import { ATLAS_COLS, ATLAS_LAYERS, createAtlasPreview } from './render/GlyphAtlas';
import { Floor } from './game/Floor';
import { ThemeDirector } from './game/Themes';
import { Rand } from './core/Rand';
import { TileKind } from './core/Config';
import { ICON_NAMES, icon } from './ui/Icons';

// Icon sheet. These are drawn as computed geometry with no reference art, so
// seeing all of them side by side — on both button backgrounds, since they
// inherit colour — is the only way to catch an arrowhead pointing the wrong way.
const iconHost = document.getElementById('icons')!;
iconHost.innerHTML = ICON_NAMES.map(
  (name) =>
    `<figure><div class="swatches">` +
    `<span class="on-solid">${icon(name)}</span>` +
    `<span class="on-ghost">${icon(name)}</span>` +
    `</div><figcaption>${name}</figcaption></figure>`,
).join('');

const atlasHost = document.getElementById('atlas')!;
const view = createAtlasPreview(128);

// Overlay the layer index on each glyph so the mapping is unambiguous.
const ctx = view.getContext('2d')!;
const cell = view.width / ATLAS_COLS;
ctx.strokeStyle = '#38e8ff55';
ctx.fillStyle = '#ffcc44';
ctx.font = '16px monospace';
for (let i = 0; i < ATLAS_LAYERS; i++) {
  const x = (i % ATLAS_COLS) * cell;
  const y = Math.floor(i / ATLAS_COLS) * cell;
  ctx.strokeRect(x, y, cell, cell);
  ctx.fillText(String(i), x + 4, y + 18);
}
view.style.width = `${view.width}px`;
atlasHost.appendChild(view);

const note = document.createElement('p');
note.textContent = `glyphs are texture-array layers (${ATLAS_LAYERS} total)`;
atlasHost.appendChild(note);

// Floor composition per depth — the check that specials stay locked until their
// unlock depth and that every floor has a way down.
const out: string[] = [];
// Three runs, so the theme sequence and its cooldowns are visible rather than
// inferred from a single roll.
for (const seed of [12345, 777, 20260726]) {
  const rand = new Rand(seed);
  const themes = new ThemeDirector();
  out.push(`--- seed ${seed} ---`);
  for (let depth = 0; depth <= 14; depth++) {
    const theme = themes.pick(depth, rand);
    const floor = new Floor(depth, rand, 0, 0, theme);
    const counts = new Map<TileKind, number>();
    for (const t of floor.tiles) counts.set(t.kind, (counts.get(t.kind) ?? 0) + 1);
    const n = floor.tiles.length;
    const pct = (k: TileKind) => `${Math.round(((counts.get(k) ?? 0) / n) * 100)}%`;
    const specials =
      (counts.get(TileKind.Time) ?? 0) +
      (counts.get(TileKind.Boost) ?? 0) +
      (counts.get(TileKind.Freeze) ?? 0);
    out.push(
      `d${String(depth).padStart(2)} ${floor.mix.label.padEnd(13)} ` +
        `n=${String(n).padStart(3)}  ` +
        `num ${pct(TileKind.Number).padStart(4)}  up ${pct(TileKind.Up).padStart(4)}  ` +
        `pow ${String(Math.round((specials / n) * 100)).padStart(3)}%  ` +
        `down=${counts.get(TileKind.Down) ?? 0}  ` +
        `[T${counts.get(TileKind.Time) ?? 0} B${counts.get(TileKind.Boost) ?? 0} F${counts.get(TileKind.Freeze) ?? 0}]`,
    );
  }
}
document.getElementById('floors')!.textContent = out.join('\n');
