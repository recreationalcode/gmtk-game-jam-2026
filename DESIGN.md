# Pogo Drop — Design Document

**GMTK Game Jam 2026 · Theme: "Count Down"**

A first-person score attack. You are strapped to a pogo stick, looking straight
down at a floor made of tiles. You cannot stop bouncing. Every landing does
something. One tile per floor drops you to the next floor down, and going down
is the only way to make points worth anything.

---

## 1. The theme, three ways

"Count Down" is load-bearing in three separate systems rather than being a
timer bolted to a generic game:

1. **The match clock counts down.** 60 seconds, extendable.
2. **The floors count down.** Depth is displayed as `-1`, `-2`, `-3`… You are
   descending. Progress is literally counting down.
3. **The tiles count down.** This is the important one. Every scoring tile
   displays a number that ticks down about once every two and a half seconds —
   roughly one tick per two bounces. Land on a `9` and you bank 9 × your
   multiplier. Dither, and that 9 becomes an 8, a 7, a 3 — and when it hits zero
   the tile *burns out* and flips into an UP tile that costs you a floor.

That third reading is what makes the game rather than decorates it. It means:

- The board is a field of decaying opportunities, so there is always a *best*
  tile right now and it is not the same tile two seconds from now.
- The original spec's "most tiles are up tiles" becomes emergent instead of
  authored. A floor **starts** generous and **rots** into hostile. Every up
  tile you land on is a tile you were too slow to cash.
- Urgency is intrinsic and continuous, not just a number shrinking in a corner.

> **Open question for Neel #1** — this is the one real departure from your spec.
> If you'd rather have static tile values, `TILE_DECAY.enabled = false` in
> `src/core/Config.ts` reverts to exactly what you described;
> `TILE_DECAY.burnout = false` keeps the decay but stops tiles turning hostile;
> and `resetOnLeave`, `maxUpFraction` and `interval` tune how forgiving the rot
> is without changing the idea.

---

## 2. Core loop

```
bounce ─▶ steer in the air ─▶ pick a tile ─▶ land ─▶ tile effect ─▶ bounce
                                    ▲                                │
                                    └────────────────────────────────┘
                                        …until the clock hits 0
```

A single bounce is ~1.35s of hang time and covers about 4.7 tiles (5.9 if
charged). That's the game's heartbeat and every decision fits inside it.

Two rounds of playtesting set that number. An early, snappier 0.9s bounce
reached one or two tiles: the arc *is* the thinking time, and a board you
cannot reach across is a board you cannot plan on. Lengthening it further to
1.35s then over-extended the reach to 5.3 tiles — past the width of the whole
opening floor — so top speed came down with it. Airtime and speed multiply into
reach, and the goal was a bounce that *floats*, not one that darts.

**The run opens on a drop.** The rider falls in from 11m rather than starting
mid-bounce on the ground, and the clock is held until the first landing. That
buys a second of wide establishing shot with the whole floor legible and the
down tile's multiplier already readable — the difference between starting a run
and being thrown into one. Everyone gets the same grace, so it costs nothing in
leaderboard terms.

## 3. Movement & controls

**The bounce is not automatic.** It bounces on its own, but you can *hit* it:

- Press/tap/click within a window just before impact → **charged bounce**:
  ~1.55× apex, much more airtime, much more reach.
- Land the input inside the tight inner window → **PERFECT**, which additionally
  builds a combo that scales your score.
- Miss entirely → a normal bounce. Never a punishment, just less.

This is what makes the pogo stick a mechanic rather than a metronome, and it
creates the risk/reward that carries the whole game: **the tile you want is
usually further than a lazy bounce can reach.**

| | Desktop | Mobile |
|---|---|---|
| Steer | Mouse position, or `WASD`/arrows | Hold and drag (thumb-relative virtual stick) |
| Bounce | `Space` / click / any key | **Release** |
| Pause | `Esc` / `P` | Pause button |

A **landing reticle** projects where you will touch down and highlights that
tile. In a first-person-down camera this is non-negotiable for readability.

**The mouse aims at a point rather than leaning in a direction.** Treating the
cursor as a lean meant the reticle showed where physics was carrying you rather
than where you were pointing, and the response curve compounded it — a cursor a
fifth of the way to the screen edge produced ten percent steering authority, so
aiming at a neighbouring tile barely moved the reticle. It read as lag.

The cursor now projects onto the floor plane and the steering is *solved*:
from `target = p + v·t + ½at²`, the required acceleration is
`a = 2(target − p − v·t)/t²`. Solved analytically rather than run as a
proportional controller on the predicted landing, which would oscillate, since
the prediction already depends on the steer being chosen. When the solution
exceeds what the rider can do it saturates, so an unreachable tile reads as
"as close as possible" instead of as the game ignoring you. Measured
acquisition is one frame. Keyboard, gamepad and touch remain lean inputs —
they have no cursor to point with.

**Touch bounces on release, not on press.** A thumb holding and dragging to
steer cannot simultaneously produce a new touch to time the bounce with — the
two gestures compete for the same finger, which left one-handed play unable to
charge a bounce at all. Releasing completes the gesture instead: press to start
aiming, drag to aim, release on the beat. Tapping still works, since a tap is a
press followed by a release, and firing on both would double-register it. The
aim is held briefly after release so bouncing does not discard the tile you had
lined up.

Air control is deliberately limited (you steer, you don't fly), so charging the
bounce stays the primary way to cover distance.

**Steering authority ramps up as impact approaches.** With constant air control
a last-moment correction is not merely hard but physically impossible — 30 m/s²
over the final 0.2s moves you 0.6m and a tile is 2m wide — so the reticle
correctly refuses to budge, which reads as the game ignoring you. Boosting
authority late means a bad read at the top of the arc is always recoverable at
the bottom: roughly 1.3 tiles of adjustment remain with 0.3s left, falling to
nothing inside the last 0.12s. The prediction applies the identical curve, so
the reticle stays an honest promise rather than an optimistic one.

## 4. Camera

First person, locked looking straight down, mounted at the rider's head.

The camera does most of the juice for free: your head height *is* the bounce
height, so the world rushes away as you rise and slams toward you on descent.
At apex you can see most of the floor and plan; at the bottom you see almost
nothing. Planning happens at the top of the arc, commitment at the bottom.

Layered on top: roll proportional to lateral velocity, FOV punch on impact,
positional shake, and a short hitstop on significant landings.

The pogo stick is visible in the lower frame — shaft, spring coil, footpegs,
and a foot that visibly compresses on impact.

## 5. Tiles

| Tile | Look | Effect | Appears |
|---|---|---|---|
| **NUMBER** | Digit 1–9, ticking down | `score += value × multiplier × combo`. Tile is spent afterward. | Always |
| **DOWN** | Nested descending chevrons, pulsing | Whole floor dissolves, new floor revealed below, `multiplier + 1` | Always (1, then 2 at depth ≥ 4) |
| **UP** | Inverted chevrons, hostile hue | Kicked back up a floor, `multiplier − 1` | Always |
| **SPENT** | Dim, hollow | Nothing. Dead weight. | After landing on a NUMBER |
| **TIME** | Ring with a sweeping hand | `+4s` on the clock | Depth ≥ 3 |
| **BOOST** | Concentric squares | `multiplier + 1` outright | Depth ≥ 5 |
| **FREEZE** | Crystalline lattice | Halts all tile decay for 4s | Depth ≥ 7 |

**Spawn mix** (before decay does its work): ~68% number, ~20% up, 1–2 down, the
remainder specials once unlocked. Decay then shifts that mix toward up tiles, so
pressure ramps *within* a floor as well as across floors.

Two governors keep that from running away, both added after the first pass made
a floor unplayable within seconds:

- **A hazard ceiling.** At most ~45% of a floor may be UP tiles at once. Past
  that, burnouts go SPENT instead — dead weight rather than punishment. Decay
  takes away opportunities; it does not stack up damage.
- **Leaving a floor resets it.** Up or down, the floor you arrive at has every
  number restored to a fresh value on a fresh clock, and anything that burned
  out is a number again. Without this, decay is a one-way ratchet and a single
  bad bounce compounds into a spiral with no way out.

  The guard that stops this being an exploit is that **tiles you scored stay
  spent**. A floor's harvestable total only ever falls, so bouncing down and
  straight back up — which costs nothing in multiplier terms — cannot farm one.
  What it *can* do is rescue a floor whose numbers you were about to lose, and
  that is a legitimate tactic with a real cost in bounces and clock.

Two smaller properties matter more than they look:

- **Each tile has its own countdown clock**, both in phase and in rate
  (`intervalJitter`). Jittering only the first tick is not enough — every tile
  then advances by exactly the same amount forever, so whatever clusters the
  first tick creates are locked in for the whole run and the floor visibly
  flashes in waves. Per-tile rates let those clusters drift apart on their own.
- **Spawn values keep a spread** (`minSpread`). The depth ramp raises the low
  end of the spawn range, and left uncapped it climbed into the high end: by
  depth 9 a board was two values wide and by depth 10 it was literally all
  nines. A board of identical numbers has nothing to choose between, which
  throws away the decision the player makes on every bounce. Values are also
  dealt from a shuffled bag rather than rolled independently, because at
  25–100 tiles independent rolls clump enough to read as "they're all the
  same" even when the draw is fair.

Nothing is hidden by a fog of war or a face-down state — the tiles are honest.
The uncertainty comes from the camera: looking straight down through a limited
field of view means you simply cannot see the whole floor from the bottom of
your bounce. That's a more elegant source of tension than a memory game, and it
rewards the player for buying altitude with a charged bounce.

## 6. Floors

Floor `n` is an `S × S` grid where `S` grows with depth (4 → 10, capped). The
world extent grows *sub-linearly*, so tiles shrink as you descend: more choices,
smaller targets, tighter execution. Difficulty ramps without a difficulty knob.

- **Descending** dissolves the current floor tile-by-tile in a radial wave from
  the down tile, revealing the next floor, and increments the multiplier.
- **Ascending** returns you to the floor you left with its countdown reset —
  same layout, same spent tiles, fresh numbers. Getting knocked up is a
  multiplier loss and lost time, not a dead board.
- The grid is bounded. Steering past the edge is softly clamped rather than
  killing you — there is no fail state except the clock.

## 7. Scoring

```
points = tileValue × depthMultiplier × comboMultiplier
depthMultiplier  = 1 + depth                       (down +1, up −1, min 1)
comboMultiplier  = 1 + min(perfectStreak, 8) × 0.15   (max ×2.2)
```

Depth is the dominant term, so the strategy the game teaches is *dive first,
farm second* — which is exactly the behaviour that makes the game exciting to
watch and to play.

## 7b. Teaching, just in time

There is no tutorial. A **coach** watches the event stream and surfaces a single
toast at the moment a thing first becomes relevant — the first TIME tile you
collect explains what clock tiles are, seven landings without a timed press
suggests trying one, coming back up a level explains that burned tiles refresh.

The rules that keep it from becoming an irritation:

- **Just in time, never up front.** Nothing is explained before it is on the
  board in front of you. The guide screen exists for players who want it.
- **Say it once.** Each notice carries a lifetime show budget persisted in
  `localStorage`. Discoveries fire once ever; behavioural nudges get two or
  three chances across runs, because not having found the charged bounce on run
  one is worth mentioning again on run three.
- **One at a time.** A queue with a minimum gap, and anything that waits more
  than ten seconds behind other notices is dropped rather than shown out of
  context.
- **Silence during the endgame.** The last ten seconds are already the loudest
  part of the game.

**Time dilates while a notice is up.** A tip that appears mid-arc is unreadable
at full speed — you are about to land on something. The simulation eases down to
0.35×, holds, and eases back up over the second half of the toast's life, so
play has resumed before the text leaves. The match clock slows with it: keeping
it at real time would mean an unrequested tip costs several seconds of a
sixty-second run. Input timestamps are taken against the *simulated* clock, so
the bounce window stays exactly as wide in simulated seconds — otherwise slow
motion would silently make PERFECT unreachable.

The rules live in `src/game/Coach.ts` with no DOM dependency; the toast lives in
`src/ui/Notifications.ts`. Notices carry the real tile artwork, drawn through
the same procedural code the board uses, so an explanation can never depict a
tile that does not match the one on screen.

## 8. The final ten seconds

At `t ≤ 10s` the game changes state visibly and audibly:

- Palette drains toward red, vignette pulses on every second tick
- Music tempo climbs, a driving layer enters, filter opens
- Tile decay accelerates (×1.5) — the board rots faster than you can farm it
- Giant numerals count down behind the play field
- Baseline camera shake, chromatic separation at the edges
- On zero: hitstop, desaturate, slow-motion final bounce, then the tally

## 9. Art direction

Minimal line art, everything procedurally generated at runtime. **The project
ships zero image files, zero model files, zero font files, and zero audio
files.**

- Dark void background, glowing wireframe geometry, bloom on capable devices
- Each depth level shifts hue, so descending is *felt* as a colour change
- In-world digits are procedurally built 7-segment glyphs — thematically on the
  nose for a countdown game, and it sidesteps font licensing entirely
- UI text uses the system font stack (no font file shipped)

> **Open question for Neel #2** — I'm building toward dark-void-plus-neon
> because it's the cheapest way to look expensive and glow makes juice land.
> A white-paper/black-ink variant is a palette swap in `Config.PALETTE` if you
> want the cleaner blueprint look instead.

## 10. Audio

100% procedurally synthesised through WebAudio. No sample files.

This is a deliberate choice on your licensing requirement: synthesised audio has
no licence to track, no attribution to get wrong, adds nothing to the download,
and — the actual reason — it can be *parameterised*. Bounce pitch rises with
your combo, the scoring blip's note is chosen by the tile's value, and the music
bed layers up as you descend.

- **SFX**: bounce thump, charge whirr, perfect chime, score blip, descend sweep,
  ascend buzz, burnout crackle, clock tick
- **Music**: three pieces sharing one scheduler and one set of voices — a
  track is a pattern function plus a tempo, a filter cutoff and a gain.
  - *Match*: generative pentatonic bed; parts unlock with depth; tempo and
    filter respond to the clock
  - *Title*: upbeat and groovy — four-on-the-floor kick, a synthesised backbeat
    clap, and a bass that plays between the beats rather than on them, which is
    what a groove actually is. Chord stabs are root-fifth-octave with no third,
    so one voicing sits correctly on both the major and minor chords in the
    progression without the pattern needing to know which it is on.
  - *Post-run*: chill — long pads, a sparse melody whose 12-note phrase is
    coprime with the four-bar chord loop so it takes four loops to repeat, and
    one soft kick a bar as a pulse rather than a beat. It plays under a screen
    people are reading, so nothing in it competes.

  The title track is requested before any input exists, which no browser will
  allow to sound. The engine remembers the request and starts it from the
  autoplay unlock, so the menu comes alive on the first keypress rather than
  staying silent until someone presses Play.

## 11. Technology

Vite + TypeScript + three.js, no game engine. An engine's editor and asset
pipeline buy nothing here because there are no assets — everything is generated
in code — and raw three.js keeps the bundle small, which matters for mobile.

- Fixed-timestep simulation (120Hz) with an interpolated render, so physics feel
  identical on 60Hz and 144Hz displays
- Tiles drawn as instanced meshes; digit segments instanced too
- Device tiering: DPR clamp, bloom and particle budgets scale down on mobile
- Builds to a self-contained `dist/` with relative paths, zipped for itch.io

## 12. Leaderboard

[simpleboards.dev](https://simpleboards.dev) behind a thin adapter, with a
localStorage leaderboard as fallback so the game is always playable and
testable offline.

⚠️ **Two things need your input here** (see `docs/LEADERBOARD.md`):
1. This build container's network policy blocks `simpleboards.dev`, so the
   integration is written to their documented request shape but **has not been
   executed against the live service**. It needs one verification run from your
   machine.
2. A purely static itch.io game has no server, so the API key is in the client
   bundle and is extractable. That is inherent to client-only leaderboards, not
   a bug — but you should use a submit-only key if simpleboards offers one, and
   expect the board to need occasional moderation.

## 13. Scope ladder

Each tier is independently shippable, so we always have a working build:

- **Tier 1 — playable**: bounce, steer, number/up/down tiles, clock, score, HUD
- **Tier 2 — the game**: charged/perfect bounce, decay + burnout, multiplier,
  floor transitions, full juice pass, procedural audio
- **Tier 3 — the product**: specials, leaderboard, guide, menus, mobile tuning,
  endgame intensity, packaged zip
- **Tier 4 — if time allows**: daily seed, replay ghost, accessibility options
  (reduced motion, high contrast, colour-blind-safe palette), haptics
