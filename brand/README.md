# The mark

`the-usability-lab.svg` is the source artwork. `the-usability-lab.png` is an
export of it, kept because it is what was handed over first; nothing in the
product reads it.

**Nothing in the product reads either file at runtime.** The geometry is inlined
into `src/brand.ts` as a string, for the reasons that file gives — chiefly that
`results-full.html` is written to disk and read as a standalone file, where a
`<img src>` pointing anywhere would be a broken image on the one artefact a
customer is most likely to forward.

That inlining is the thing worth being careful about: **the code holds a copy of
this file's path data.** Edit the logo here and the site keeps drawing the old
one, silently and forever, because nothing about the running page would look
wrong. `src/brand.test.ts` exists only to make that impossible — it reads this
file and compares its geometry to what `brand.ts` draws.

So the sequence for changing the mark is:

1. Replace `the-usability-lab.svg`.
2. Run `npm test`. `brand.test.ts` fails, and prints what no longer matches.
3. Copy the new `<rect>` attributes and the new `d` into `MARK` in `src/brand.ts`.

## The mark has an optical size

The letterforms are hairlines. Measured at 1x, how close the brightest letter
pixels get to the paper they are meant to be (250):

| drawn at | 1x | 2x |
|---|---|---|
| 438px | 250 | 250 |
| 300px | 250 | 250 |
| 240px | 239 | 250 |
| 190px | 215 | 250 |

Below about 300px on a non-retina display the strokes fall under one device
pixel and antialias to grey — which is what "the logo looks pixelated" turned
out to mean. `markCss` takes the width the mark is drawn at and, below that
threshold and only on low-density displays, thickens the letters by 0.6 device
pixels to put the ink back.

**If you replace the artwork with a heavier face, that correction may no longer
be wanted.** It is one constant, `HAIRLINE_PX` in `src/brand.ts`, and the
threshold beside it is `RESOLVES_ABOVE`. Re-measure before trusting either.

## Colour

The colours are deliberately **not** copied across. This file is `#000` on
`#FFF`; the product paints the mark from whichever palette it lands in, because
the marketing pages use a warm ink (`#26221E`) and the results page a neutral
one (`#1a1a1a`), and literal black beside either reads as a second, colder ink on
the same page. `markCss` takes the two colours as arguments for that reason.
