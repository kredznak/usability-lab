# The mark

`the-usability-lab.svg` is the lockup — glyph plus the words, 1241x169.
`the-usability-lab-icon.svg` is the glyph alone, 203x203. Both are the source
artwork; both are `#000`.

**Nothing in the product reads either file at runtime.** The geometry is inlined
into `src/brand.ts` as strings, for the reasons that file gives — chiefly that
`results-full.html` is written to disk and read as a standalone file, where an
`<img src>` pointing anywhere would be a broken image on the one artefact a
customer is most likely to forward.

That inlining is the thing worth being careful about: **the code holds a copy of
these files' path data.** Edit the logo here and the site keeps drawing the old
one, silently and forever, because nothing about the running page would look
wrong. `src/brand.test.ts` exists only to make that impossible — it reads both
files and compares their geometry to what `brand.ts` draws.

So the sequence for changing the mark is:

1. Replace the file(s).
2. Run `npm test`. `brand.test.ts` fails and prints what no longer matches.
3. Copy the new `d` attributes and viewBox into `MARK` / `ICON` in `src/brand.ts`.

Strip the `clipPath` and its `<g>` while you do. Figma exports one on every file
with a generated id, ids in inline SVG are document-global, and the homepage
draws both pieces in one element. Check the clip is a no-op first by rendering
with and without it — both current files were, to the byte.

## Which piece goes where

| surface | piece | width |
|---|---|---|
| homepage, wide | lockup | `min(420px, 52vw)` |
| homepage, under 380px viewport | glyph | 44px |
| results page masthead | lockup | 260px |
| account / billing / schedule / sign-in / about | glyph | 48px, 40px on a phone |
| `/start` progress bar | glyph | 34px, 30px on a phone |

The split is not decorative. The wordmark sits in a **1241-wide** artboard, so at
any given width its letters are less than half the size of the previous mark's —
240px of this lockup puts the caps at 25px where the old one put them at 55px.
`MARK_MIN_WIDTH` in `src/brand.ts` is 200px and the shells are tested against it.
A corner has nowhere near that room, so corners take the glyph.

On the homepage both pieces are in the markup and one is `display:none`, because
CSS cannot swap one SVG for another. Measured: the menu pill is 87px sitting 20px
from the right edge, the mark starts 22px in, and 16px between them is the least
that does not read as a collision — so the room for the lockup is **the viewport
less 145px**, and the words need 345px of viewport. Below that, the glyph.

## What the previous artwork needed and this one does not

`previous/` holds the black slab with the letters knocked out of it, which this
replaced on 2026-08-28. Three treatments went with it, and all three are the kind
of thing that gets reintroduced for a plausible reason:

- **The bleed.** The slab was continued past an element's left edge with a
  rotated pseudo-element so the mark ran off the side of the page. There is no
  slab now. Done to this artwork it would paint a black bar beside the glyph.
- **The two-colour model.** `markCss(slab, word)` described the letters as a hole
  in a rectangle. This artwork is one ink.
- **The hairline correction.** Knockout letters at hairline weight lose ink to
  antialiasing below about 300px and go grey; the fix added 0.6 device pixels of
  stroke on low-density displays only. Measured at 1x, how close the brightest
  letter pixels got to the paper they were meant to be (250):

  | drawn at | 1x | 2x |
  |---|---|---|
  | 438px | 250 | 250 |
  | 300px | 250 | 250 |
  | 240px | 239 | 250 |
  | 190px | 215 | 250 |

  **The current artwork does not have this problem.** Its darkest letter pixels
  reach full ink (35, against paper at 250) at every width from 160px to 600px.
  What changes with size is only how much of the letter is antialiased edge — 9%
  of letter pixels at full ink at 160px, 65% at 600px. A positive letterform
  thins at its edges; a knockout one fills in. They are not the same failure, and
  a stroke would only make this logo bolder than it was drawn.

## Two measurements that could not size a mark

Kept because the first is what anyone will reach for within a minute, and it does
not work. Both were run against the previous artwork:

- **Share of letter pixels reaching paper.** 36.3% at 140px to 42.7% at 240px — a
  flat line with no threshold in it. For a hairline stroke the ratio of core to
  antialiased edge barely depends on scale.
- **Open paper regions inside the slab**, counting counters and stroke gaps as
  connected components, on the theory that mush is counters closing. 33 at 140px,
  52 at 190px, back to 35 at 240px: well-formed letters merge their gaps into
  fewer, larger regions, so the count is confounded by the thing it was meant to
  rank.

Both sizes that ended up shipping were arrived at by rendering four widths and
looking at them.

## Colour

The colours are deliberately **not** copied across. These files are `#000`; the
product paints the mark from whichever palette it lands in, because the marketing
pages use a warm ink (`#26221E`) and the results page a neutral one (`#1a1a1a`),
and literal black beside either reads as a second, colder ink on the same page.
`markCss` and `iconCss` take the colour as an argument for that reason.
