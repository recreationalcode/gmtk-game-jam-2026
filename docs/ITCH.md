# The itch.io page

Two parts: the upload (see [Shipping to itch.io](../README.md#shipping-to-itchio))
and the page around it, which is this document.

## Theme

The palette is not a decorative choice. Every value comes from
`src/ui/style.css` and `PALETTE` in `src/core/Config.ts`, so the page and the
game are the same object — a page that merely coordinates with the game reads as
a page *about* the game, which is one step further from playing it.

Set these in **Edit game → Theme**. itch's editor labels its pickers by role
rather than by these names, so match on what each one controls:

| Controls | Value | Why |
|---|---|---|
| Page background | `#05060a` | `PALETTE.background` — the same void the game renders into, so the frame has no seam |
| Body text | `#eef4ff` | `--ink` |
| Links | `#38e8ff` | `--accent`, the surface depth hue |
| Buttons / call to action | `#38e8ff` on `#04121a` text | Cyan, never red — see below |
| Secondary panels | `#0a0d16` | `--panel` |

Then paste [`itch-theme.css`](itch-theme.css) into the same tab's **Custom CSS**
box. Do both: the pickers style the fragments itch renders before a stylesheet
applies, so a page themed only in CSS flashes light on first paint.

**Red is not available for the call to action.** `PALETTE.hostileHue` is the UP
tiles — the ones that cost you the run. A red Play button teaches the opposite
of what the game means by red, before the player has started. Cyan is the
surface accent and the HUD colour; green (`#20e963`, the down tile) is the
secondary action.

The page descends. `itch-theme.css` runs a fixed cyan-to-violet wash top to
bottom, tracking `PALETTE.depthHues` — cool at the surface, deep violet at the
bottom. Scrolling the page is the gesture the game is about. If you rewrite the
theme, keep that.

## Art

Generated, not drawn — `npm run art` writes all four into `docs/itch/`. The
palette is parsed out of `PALETTE` in `src/core/Config.ts` at generation time, so
retuning the game's colours and re-running is all it takes for the page to
follow; there is no hand-picked PNG to go stale.

| File | Where it goes | Size |
|---|---|---|
| `cover-630x500.png` | Edit game → **Cover image** | 330 kB |
| `banner-1920x480.jpg` | First image in the page description | 151 kB |
| `background-1920x1080.jpg` | `--pd-page-image` in the stylesheet | 169 kB |
| `embed-bg.gif` | `--pd-embed-image`, or `--pd-page-image` for the whole page | 1.72 MB |

All four are the same scene: an infinite shaft of identical floors falling away
through the hole in the middle of the one above, each floor a different depth
hue. That is the game — `depthHues` is indexed by depth and the board's
structure does not change as you descend, only its colour does.

Two numbers in there are derived rather than chosen, and both matter if you
retune it. The ratio between floors is exactly the factor that drops the next
floor into the hole in this one, so widening the hole brings more of the descent
into view. And the hue advances slower than one entry per floor: at a full entry
the four visible floors are four different colours, which is a rainbow, not a
descent.

The GIF is a single seamless loop — 40 frames, 4 seconds, one floor-to-floor
zoom. `npm run art` asserts that frame 0 and the wrap-around frame are
pixel-identical and fails if they are not, because a seam is a twitch every four
seconds behind the game and it is not something a glance at the first few frames
would catch.

**Wiring the two CSS ones up.** itch only gives you a URL once a file is on its
server, so: open the description editor, use its image button to upload, copy the
`img.itch.zone` address it inserts, then delete the inserted image. Paste the
address into the commented-out block at the top of
[`itch-theme.css`](itch-theme.css). They cannot go in the theme editor's
background picker — the stylesheet sets `background-image` for the descent
gradients and custom CSS applies after the editor's own, so a picked image would
be overridden.

**The GIF is the heaviest thing on the page**, by a factor of ten over the game
it decorates — `pogo-drop-itch.zip` is 184 kB. It is the first thing to drop if
the page feels slow, and the static background covers the same ground for a tenth
of the weight. `scripts/page-art.mjs` has the frame count, dimensions and palette
size as tunables at the top of the `embed` entry if you want a different trade.

## Embed settings

| Setting | Value | Why |
|---|---|---|
| Kind of project | HTML | |
| This file will be played in the browser | ticked | Without it the zip is a download, not a game |
| Embed size | 960 × 640 minimum | A floor, not a target — the game is responsive and reads fine wider |
| Fullscreen button | enabled | The camera looks straight down; vertical room is what the game wants |
| Mobile friendly | enabled, orientation *default* | Touch is a first-class input (`npm run touch` covers it) and both orientations are handled |
| Automatically start on page load | off | Click-to-play is the convention, and it spares anyone just browsing a 670kB bundle and a WebGL context |

## Page copy

The description carries the objective, because the game's own opening notice is
budgeted to three runs and someone arriving cold has not spent them yet. Lead
with what you do, not with the theme interpretation — "Count Down" is legible
from the board once play starts.

`GUIDE.md` ships inside the zip and is the source for the controls section.
Keep them in step; a control list that disagrees with the game is worse than
none.
