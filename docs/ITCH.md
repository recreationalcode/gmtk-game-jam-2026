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
