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

The Vercel deployment builds the same upload, so the zip can be grabbed without
a local toolchain:

```
https://gmtk-game-jam-2026.vercel.app/pogo-drop-itch.zip
```

See [Shipping to itch.io](#shipping-to-itchio).

---

## Documents

| | |
|---|---|
| [`DESIGN.md`](DESIGN.md) | Full design doc — mechanics, balance, and the reasoning behind them |
| [`GUIDE.md`](GUIDE.md) | Player guide (also shipped inside the game and the zip) |
| [`CREDITS.md`](CREDITS.md) | Asset provenance and licences |
| [`docs/LEADERBOARD.md`](docs/LEADERBOARD.md) | Leaderboard setup — the Vercel proxy, and what still needs verifying |

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Typecheck, then build to `dist/` |
| `npm run preview` | Serve `dist/` |
| `npm run package` | Build, verify the layout, and zip for itch.io |
| `npm run build:vercel` | What Vercel runs: `build`, then the same zip into `dist/` |
| `npm run smoke` | Headless Chromium: boot, play, screenshot, report errors |
| `npm run fullrun` | Headless full match: endgame ramp → score screen → submit |
| `npm run transitions` | Regression: every floor stays renderable across descend/ascend |
| `npm run leaderboard` | Regression: board reachable before playing, and Back/Escape routing |
| `npm run coach` | Regression: tips fire once, carry tile art, persist across runs |
| `npm run touch` | Regression: press aims, drag steers, release bounces |
| `npm run tiles` | Regression: varied spawn values, out-of-phase decay, reset on leaving |
| `npm run music` | Regression: title, match and post-run tracks all play, and differ |
| `npm run proxy` | Regression: the leaderboard function, run under Node with a stubbed upstream |
| `npm run aim` | Regression: the reticle goes where the cursor points, fast |
| `npm run diag` | Screenshot the procedural glyphs, dump floor balance per depth |

`npm run smoke` needs `npm run preview` running in another shell; `npm run
fullrun` needs `npm run dev`, because it uses the dev-only `?matchSeconds=`
override to finish a match in seconds (production strips it, so a shipped
`?matchSeconds=600` can't be used to farm the leaderboard). `npm run proxy`
needs nothing — the function is Web-standard, so it runs under Node directly.

These exist because the bugs that cost the most here were all invisible to the
type checker and obvious in a screenshot: a texture atlas whose rows were
inverted by `flipY`, a lens that collapsed to a 38° horizontal view in portrait,
and `Color.setHSL` defaulting to the *linear* working space rather than sRGB —
which made every colour in the game about twelve times too bright and turned the
endgame screen flat pink.

`?coach=reset` forgets every tip so the teaching system can be reviewed again —
it ships in the real build, because each tip has a lifetime budget of one or two
shows *per device* and anyone who has played a few times has permanently spent
the lot.

Dev-only affordances, all stripped from production by `import.meta.env.DEV`:
`?matchSeconds=`, `?tier=low|medium|high`, and a `window.pogo` inspection
handle. **F3** toggles a frame-budget overlay (fps, draw calls, triangles) and
ships in the real build, because the only performance numbers that matter are
the ones measured on the device someone is actually holding.

`debug.html` (dev server only, never built) previews the procedural glyphs and
the full UI icon sheet — on both button backgrounds, since the icons inherit
colour — and dumps floor composition per depth.

---

## Shipping to itch.io

`dist/` is the itch payload verbatim — `vite build` already emits exactly what
goes in the zip, because `base: './'` makes every asset reference relative and
`index.html` lands at the root. Packaging adds no transformation; it copies
`GUIDE.md` and `CREDITS.md` in, checks the two things that silently break an
upload, and archives the result.

There are two ways to get the archive, and they build the same thing:

| | |
|---|---|
| `npm run package` | `build/pogo-drop-v<version>.zip` — versioned, so builds do not overwrite each other |
| Vercel | `/pogo-drop-itch.zip` on every deployment — a fixed path, so a bookmark survives a version bump |

The Vercel route exists because the build container is discarded when the
deployment finishes: there is no build output to download after the fact, so the
archive has to be placed inside `dist/` while the build is still running, where
the CDN then serves it like any other static file. Preview deployments carry
their own copy, so a branch's zip can be pulled from that branch's URL.

Packaging runs *after* the typecheck and the build, and it fails the deployment
if the layout is wrong. That is deliberate — a bundle that would 404 on itch is
not a bundle worth deploying either.

**The zip is only as configured as the build that made it.** Vite inlines
`VITE_*` variables at build time, so `VITE_LEADERBOARD_PROXY` has to be set in
the *Vercel project's* environment for the downloaded zip to reach the
leaderboard; a zip built without it plays fine and keeps scores in
`localStorage`. It must be an absolute origin, since itch runs the game on a
different one. See [`docs/LEADERBOARD.md`](docs/LEADERBOARD.md).

Uploading: attach the zip, tick **This file will be played in the browser**, and
set the embed to at least 960x640. The game is responsive and handles
fullscreen, so the embed size is a floor rather than a target.

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

api/
  scores.ts    Vercel Edge function — holds the leaderboard API key
```

`api/scores.ts` is deployed separately from the game and is not part of the
itch.io zip. It exists so the simpleboards.dev key lives in a server
environment variable rather than inside the client bundle, where anyone could
read it. `npm run proxy` runs it under Node against a stubbed upstream, so it
can be tested without deploying. See [`docs/LEADERBOARD.md`](docs/LEADERBOARD.md).

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
