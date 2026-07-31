# Pogo Drop — X post kit

Attach the trailer and use one of the drafts below.

**Fill in `<ITCH LINK>` before posting.** Everything else is ready.

The trailer is built by `npm run capture`, which writes
`build/capture/pogo-drop.mp4`. That directory is not in git, so re-run it
whenever you want a fresh clip rather than looking for a checked-in copy.

---

## Draft A — the tagline (general audience)

> can't stop, will drop.
>
> 60 seconds. One pogo stick. You're looking straight down, and every tile
> you land on is counting down too.
>
> My #GMTKJam 2026 entry. Free in your browser:
> <ITCH LINK>

## Draft B — the hook (clearest explanation of the game)

> The floor is made of numbers.
> The numbers are counting down.
> So are you.
>
> Pogo Drop: bounce deeper, score bigger, beat the clock. Made for
> #GMTKJam 2026, theme Count Down.
>
> Play free:
> <ITCH LINK>

## Draft C — the tech flex (best reach with #gamedev)

> No image files. No audio files. No models. No font files.
>
> Every tile, digit, sound and note in this is generated at runtime. The whole
> game is a 180KB download.
>
> Pogo Drop, my #GMTKJam 2026 entry. Play free:
> <ITCH LINK>

Draft C's claims are all true and checkable: the shipped zip is 6 files
(`index.html`, one JS bundle, one CSS file, and two markdown docs) at 184KB,
with no asset files of any kind. It says "no font *files*" rather than "no
fonts" on purpose — the tile digits are drawn to a canvas at runtime, but from
whatever monospace font the player's system already has. Nothing is downloaded.

---

## Posting notes

- **Put the link in the first reply if you want maximum reach.** Off-platform
  links in the main post tend to get less distribution. Post the video with the
  copy, then immediately reply with "Play it here: `<ITCH LINK>`". If you would
  rather keep it simple, leaving the link in the post is fine.
- **The video has no sound.** X autoplays muted anyway, so this costs nothing in
  feed. Worth knowing if you were planning to mention the soundtrack, since the
  game's music is generated live and is a genuinely good part of it. If you want
  people to hear it, say so in the copy and let the game do the work.
- **Hashtags.** `#GMTKJam` is the one that matters. `#gamedev` and `#indiedev`
  widen it. Don't stack more than three.
- **Tagging the jam.** Worth tagging the GMTK account, but check the current
  handle yourself rather than trusting one from me — I could not verify it from
  here and a wrong tag is worse than none.
- **Timing.** Today is a Friday. If you can hold it, posting Saturday lets you
  add `#screenshotsaturday`, which is a real, well-trafficked tag for this kind
  of clip.
- **First frame matters.** The video opens mid-run on a deep floor with the
  multiplier already high, because the first frame is the thumbnail and an empty
  starting board is a weak one.

## Alt text

For the video's accessibility description, or if you post a still instead:

> First-person view looking straight down at a neon grid of numbered tiles from
> a bouncing pogo stick. The rider lands on tiles, which flash and score, while
> a countdown clock and a score multiplier climb in the screen corners. The view
> drops to a larger, deeper grid as the run continues.
