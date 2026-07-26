# Pogo Drop — Player Guide

You are strapped to a pogo stick, looking straight down. You cannot stop
bouncing. You have **60 seconds** — and the clock does not start until you land,
so use the opening drop to read the board.

---

## The one thing to understand

Every floor has **one way down**. Going down raises your multiplier, and the
multiplier is worth far more than any single tile. So:

> **Dive first. Farm second.**

A `5` at depth −4 is worth 25 points. A `9` on the surface is worth 9.

---

## Controls

| | Keyboard & mouse | Touch | Gamepad |
|---|---|---|---|
| **Steer** | Move the mouse, or `W` `A` `S` `D` | Hold and drag anywhere | Left stick |
| **Bounce** | `Space` or click | **Release** | Any face button |
| **Pause** | `Esc` or `P` | Pause button | — |

The screen *is* the floor. **Point at the tile you want and the pogo goes
there** — the cursor is a target, not a nudge. If a tile is too far to reach in
the time you have left, you will get as close to it as physics allows.

**On touch the whole thing is one gesture: press to start aiming, drag to aim,
release on the beat.** A thumb that is holding and dragging to steer cannot also
tap to time a bounce — the two compete for the same finger — so releasing is
what bounces. Tapping still works, because a tap is a press and a release.

Your aim is held for a moment after you let go, so releasing to bounce does not
throw away the tile you were lining up.

---

## Timing the bounce

You bounce automatically, but a *timed* bounce is much better.

A **ring closes in** on the tile you are about to land on. The square snaps and
flares whenever you steer onto a different tile, so you can always see what you
have selected. Press — or on touch, release — as the ring meets the square:

- **Close enough** → a charged bounce. Higher, longer, more reach.
- **Dead on** → **PERFECT**. Higher still, a dash in the direction you are
  leaning, and it builds a combo multiplier worth up to ×2.2.
- **Miss** → an ordinary bounce. No penalty, just less.

**Do not mash.** The first press is the one that counts, so spamming the button
fills the input buffer far too early and grades out as an ordinary bounce. One
deliberate press beats eight panicked ones.

Height is not just for show. A charged bounce buys you altitude, altitude widens
your view of the floor, and a wider view is how you find the way down.

---

## Tiles

| Tile | What it does |
|---|---|
| **Number** (a digit) | Scores its value × your multiplier. Then it is spent. |
| **Down** (chevrons pointing down, green) | You bounce off it, the whole floor falls away, and you drop to the next one. **Multiplier +1.** |
| **Up** (chevrons pointing up, red) | Throws you back to the floor above. **Multiplier −1.** Deeper floors have a lot more of them. |
| **Spent** (a dim circle) | Already cashed, or burned out. Worth nothing, still in your way. |
| **Time** (a clock, from depth −3) | **+4 seconds.** |
| **Boost** (nested squares, from depth −5) | **Multiplier +1** without descending. |
| **Freeze** (a snowflake, from depth −7) | Freezes every countdown on the board for 4 seconds. Farm hard. |

---

## Tips

The game explains itself as you go. When a tip appears the world slows almost
to a stop so you can read it without losing the bounce — **click or tap to
carry on** the moment you are done, or let the bar under it run out.

---

## The countdown

This is the part that catches people out.

**Every number on the board is ticking down**, roughly once every two and a half
seconds — about one tick per two bounces — whether you are looking at it or not.
Each tile runs on its own slightly different clock, so they do not tick as one
wave, and two tiles showing the same digit are not necessarily about to die
together. A number that reaches zero does not just vanish: **it burns out into
an UP tile**.

So a floor starts generous and *rots*. Tiles shift colour as they decay, from
cool to hot, and pulse when they are nearly gone. Every UP tile you land on is
one you were too slow to cash.

Three things stop that from spiralling:

1. **A floor can only get so hostile.** There is a ceiling on how much of a
   floor may be UP tiles at once — about 45% at the surface, rising with depth.
   Past it, further burnouts go *dead* instead: worth nothing, but harmless. The
   board runs out of opportunities before it becomes a minefield.
2. **Leaving a floor resets it.** Up *or* down: the moment you leave, every
   number on that floor goes back to a fresh value, and anything that burned
   out comes back as a number. Decay is recurring pressure, not permanent
   damage.
3. **The clock is the only thing you can actually lose.**

What *doesn't* reset: **tiles you already cashed stay spent.** That is what
stops a floor being farmed by bouncing down and straight back up — its
harvestable total only ever falls. A floor you return to is a real place you
left, just not a graveyard.

**Points go stale — take the nine now, not the four later.**

---

## The last ten seconds

The screen drains toward red, the music tightens, the edges fray, and **tile
decay speeds up by half again**. The board rots faster than you can farm it.

Time tiles still work. If you are deep enough to have them, that is the moment
they are worth the detour.

---

## Scoring

```
points  =  tile value  ×  depth multiplier  ×  combo multiplier

depth multiplier =  1 + how deep you are
combo multiplier =  up to ×2.2, from consecutive PERFECT bounces
```

Descending also pays a flat bonus, scaled by your new multiplier.

---

## Tips

- **The first ten seconds decide the run.** Find the down tile and commit.
- **Charge your bounce before a long crossing.** An ordinary bounce covers about
  four tiles; a charged one closer to five and a half. On a deep, wide floor
  that difference is the difference between reaching the down tile this bounce
  and next.
- **Plan at the top of the arc, commit at the bottom.** You can see most of the
  floor at your apex and barely one tile at the bottom. Decide early.
- **A bad read is recoverable.** Steering gets *stronger* the closer you are to
  landing, so you can still shift a tile or so with a quarter-second left. Only
  the last fraction of a second is truly locked in.
- **Check a tile's number before you commit to crossing for it.** A 9 will still
  be worth taking when you arrive; a 2 will not.
- **Deep floors are bigger and their tiles are smaller.** Precision matters more
  the further you go.
- There is **no way to die**. Only the clock can stop you — so take risks.

---

## Options

- **Tips** appear at the bottom of the screen the first time something is worth
  explaining, and the game slows down while one is up so you can read it without
  losing the bounce you were lining up. Each one is shown once and then never
  again.
- **Sound** can be toggled on the title screen.
- The game runs in **portrait or landscape**; the camera adjusts.
- If the leaderboard is unreachable, your scores are still saved on your device
  and shown instead.
