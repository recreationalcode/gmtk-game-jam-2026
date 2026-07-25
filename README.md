# Pogo Drop

**GMTK Game Jam 2026 · Theme: "Count Down"**

A first-person pogo-stick score attack. You are looking straight down at a floor
made of tiles, you cannot stop bouncing, and every number on the board is ticking
down. One tile per floor drops you to the next one, and going down is the only
way to make points worth anything.

```bash
npm install
npm run dev          # play at http://localhost:5173
npm run package      # build + verified itch.io zip in build/
```

---

## Documents

| | |
|---|---|
| [`DESIGN.md`](DESIGN.md) | Full design doc — mechanics, balance, and the reasoning behind them |
| [`GUIDE.md`](GUIDE.md) | Player guide (also shipped inside the game and the zip) |
| [`CREDITS.md`](CREDITS.md) | Asset provenance and licences |
| [`docs/LEADERBOARD.md`](docs/LEADERBOARD.md) | Leaderboard setup, and what still needs verifying |

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Typecheck, then build to `dist/` |
| `npm run preview` | Serve `dist/` |
| `npm run package` | Build, verify the layout, and zip for itch.io |
| `npm run smoke` | Headless Chromium: boot, play, screenshot, report errors |
| `npm run fullrun` | Headless full match: endgame ramp → score screen → submit |
| `npm run transitions` | Regression: every floor stays renderable across descend/ascend |
| `npm run leaderboard` | Regression: board reachable before playing, and Back/Escape routing |
| `npm run coach` | Regression: tips fire once, carry tile art, persist across runs |
| `npm run diag` | Screenshot the procedural glyphs, dump floor balance per depth |

`npm run smoke` needs `npm run preview` running in another shell; `npm run
fullrun` needs `npm run dev`, because it uses the dev-only `?matchSeconds=`
override to finish a match in seconds (production strips it, so a shipped
`?matchSeconds=600` can't be used to farm the leaderboard).

These exist because the bugs that cost the most here were all invisible to the
type checker and obvious in a screenshot: a texture atlas whose rows were
inverted by `flipY`, a lens that collapsed to a 38° horizontal view in portrait,
and `Color.setHSL` defaulting to the *linear* working space rather than sRGB —
which made every colour in the game about twelve times too bright and turned the
endgame screen flat pink.

Dev-only affordances, all stripped from production by `import.meta.env.DEV`:
`?matchSeconds=`, `?tier=low|medium|high`, and a `window.pogo` inspection
handle. **F3** toggles a frame-budget overlay (fps, draw calls, triangles) and
ships in the real build, because the only performance numbers that matter are
the ones measured on the device someone is actually holding.

`debug.html` (dev server only, never built) previews the procedural glyphs and
dumps floor composition per depth.

---

## Architecture

```
src/
  core/        Config · Input · Audio · Rand · MathUtil
  game/        GameState · Floor · Player · Tile · Coach ← no three.js, no DOM
  render/      Renderer · TileField · PlayerRig · PogoStick · Effects · Guides
  ui/          HUD · Screens · Notifications · Stats · style.css
  net/         Leaderboard
  App.ts       wires simulation → presentation
```

Two properties are load-bearing:

**The simulation is isolated.** `src/game/` knows nothing about three.js, the
DOM or WebAudio. It advances on a fixed 120Hz step and emits an event queue that
`App.ts` drains once per rendered frame. Feel can be retuned right up to the
deadline with no risk of changing what actually happened in a run, and physics
are identical on a 60Hz and a 144Hz display.

**Every tunable is in one file.** `src/core/Config.ts` holds all of it — physics,
timing windows, spawn mix, decay rate, scoring, camera, palette, quality tiers.
Balance changes during a jam happen at 3am; hunting a magic number through five
files is how jam games die.

## Rendering notes

- A whole floor — bodies, borders, digits and icons — is **one instanced draw
  call**. Borders are an analytic SDF in the fragment shader rather than line
  geometry, and glyphs come from a runtime-generated **texture array** (a grid
  atlas bleeds across cells under minification; array layers do not).
- Everything is procedural. No image, font, model or audio file exists in the
  repo or the build. See [`CREDITS.md`](CREDITS.md).
- Post chain is three passes: bloom, a combined grade pass (vignette, tint,
  chromatic separation), and output. Bloom and particle budgets scale down by
  device tier; the tier is guessed from what the browser exposes and fails
  toward *playable*.

## Requirements

WebGL 2. Recent Chrome, Firefox, Edge or Safari, desktop or mobile. An
unsupported browser gets a message rather than a black screen.
