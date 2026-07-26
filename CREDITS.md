# Pogo Drop — Credits, Assets and Licences

**Short version: this game ships no third-party creative assets at all.** There
are no image files, no model files, no font files and no audio files in the
repository or in the itch.io build. Every visual and every sound is generated in
code at runtime.

That was a deliberate choice, partly to satisfy the "everything procedural"
art direction and partly because it makes the licensing position unambiguous:
there is nothing to attribute incorrectly and nothing whose terms could change.

---

## 1. Verifying the claim

The build contains exactly three files. You can confirm there are no media
assets yourself:

```bash
npm run package
unzip -l build/pogo-drop-*.zip
```

Expected output — one HTML file, one CSS file, one JS bundle:

```
index.html
assets/style.<hash>.css
assets/pogo-drop.<hash>.js
```

No `.png`, `.jpg`, `.svg`, `.woff`, `.ttf`, `.mp3`, `.ogg`, `.wav`, `.glb` or
`.fbx` at any point.

---

## 2. Art — 100% procedural, generated at runtime

| Asset | How it is made | Source file |
|---|---|---|
| Tile bodies, borders | Analytic square-frame SDF in a fragment shader | `src/render/TileField.ts` |
| Digits 0–9 | Seven-segment glyphs drawn as stroked lines with Canvas2D | `src/render/GlyphAtlas.ts` |
| Tile icons (down, up, spent, time, boost, freeze) | Canvas2D paths | `src/render/GlyphAtlas.ts` |
| Pogo stick, handlebars, footpegs, foot | three.js primitives merged and edge-extracted | `src/render/PogoStick.ts` |
| Spring coil | Polyline traced along a helix, regenerated per frame | `src/render/PogoStick.ts` |
| Shockwave rings | Radial SDF in a fragment shader | `src/render/Effects.ts` |
| Particles | Point sprites with a procedural circular falloff | `src/render/Effects.ts` |
| Landing reticle, horizon lattice | Generated line geometry | `src/render/Guides.ts` |
| Colour palette | HSL computed per depth and per tile urgency | `src/render/Palette.ts` |
| UI icons (26, all buttons and labels) | SVG paths computed from a shared 24-unit grid — arcs, polar stars, looped bars, no icon library | `src/ui/Icons.ts` |
| Favicon | Drawn with Canvas2D at boot, injected as a data URI | `src/App.ts` |

### Typography

The UI uses the **system monospace font stack** (`ui-monospace`, `SF Mono`,
`Menlo`, `Consolas`, `Liberation Mono`, `monospace`). No font file is
downloaded or bundled — each platform renders with a face it already has, so
there is no font licence involved. In-world numerals are the seven-segment
glyphs above, not type.

---

## 3. Audio — 100% procedural, synthesised via WebAudio

No sample, loop, or recording is used. Every sound is built from oscillators,
a runtime-generated white-noise buffer, and biquad filters in
`src/core/Audio.ts`.

| Sound | Synthesis |
|---|---|
| Bounce | Sine with a fast downward pitch sweep + band-passed noise transient |
| Charged / perfect bounce | Adds a rising triangle "spring" partial |
| Perfect chime | Pentatonic note, pitch rising with combo length |
| Score blip | Pentatonic note chosen by the tile's value |
| Descend | Falling saw sweep through a closing filter, over a rising arpeggio |
| Ascend | Rising saw plus a tritone partner |
| Burnout | Short band-passed noise crackles |
| Time / boost / freeze | Pentatonic arpeggios and clusters |
| Clock tick | Filtered noise, pitch and level rising in the final ten seconds |
| Music (match) | Generative pentatonic sequencer — kick, bass, hats, arpeggio and pad, layered by depth, tempo driven by the clock |
| Music (title) | Same voices, upbeat pattern — four-on-the-floor kick, synthesised backbeat clap, syncopated bass, chord stabs over i–VI–III–VII |
| Music (post-run) | Same voices, chill pattern — long triangle pads, sparse filtered plucks, one soft kick a bar over i–iv–VI–III |

All three pieces are *composed by the code*, not performed, recorded or sampled
from any source. They share one scheduler and one set of synth voices; a track
is a pattern function plus a tempo, a filter cutoff and a gain.

---

## 4. Third-party software

Only these, all runtime or build-time libraries — none contributes creative
content to the game.

| Package | Version | Licence | Used for |
|---|---|---|---|
| [three.js](https://github.com/mrdoob/three.js) | 0.185.x | MIT | WebGL rendering, math, post-processing |
| [Vite](https://vitejs.dev) | 8.x | MIT | Build tooling (dev only) |
| [TypeScript](https://www.typescriptlang.org) | 5.9.x | Apache-2.0 | Type checking (dev only) |
| [Playwright](https://playwright.dev) | latest | Apache-2.0 | Headless smoke test (dev only) |
| `@types/three` | 0.185.x | MIT | Type definitions (dev only) |

three.js is the only one whose code ships in the build. Its MIT licence text is
reproduced in `licenses/three.LICENSE`.

Three.js addons used from `three/addons` (all part of the same MIT-licensed
repository): `BufferGeometryUtils`, `EffectComposer`, `RenderPass`,
`ShaderPass`, `UnrealBloomPass`, `OutputPass`.

---

## 5. Services

| Service | Used for | Notes |
|---|---|---|
| [SimpleBoards](https://simpleboards.dev) | Online leaderboard | Optional. The game runs and stores scores locally without it. See `docs/LEADERBOARD.md`. |

---

## 6. Design and code

Game design, code, procedural art and procedural audio for Pogo Drop were
written for GMTK Game Jam 2026 (theme: **Count Down**).

---

## 7. If you add anything

If a real asset ever does get added, record it here **before** it is committed,
with: what it is, where it came from (direct link), its licence, the licence
holder, and whether attribution is required. Then update section 1, because the
"no media files" claim will no longer be true.
