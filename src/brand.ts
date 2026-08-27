/**
 * The mark, in one place, because three shells now draw it.
 *
 * It started inside `marketing.ts` beside the pages that used it. The results
 * page needs it too, and `marketing.ts` already imports from `render.ts`, so
 * putting it anywhere either of them owns makes a cycle. The artwork is not
 * really marketing or rendering — it is the one thing every surface has in
 * common — so it gets a module of its own.
 *
 * ## Inline SVG, not `<img>`
 *
 * The CSP is `default-src 'none'; img-src 'self'`, so an image would work on the
 * served pages. It would not work in `results-full.html`, which is written to
 * disk and opened as a file with nothing beside it — a `<img src="/logo.png">`
 * there is a broken image on the one artefact a customer is most likely to
 * forward to somebody. Inline, the page stays a single self-contained file, is
 * vector at every size, costs no request, and takes its colours from whatever
 * palette it lands in.
 *
 * ## The angle is in the artwork
 *
 * `rotate(-6.20348)` is a transform on the `<rect>`, not a CSS transform on the
 * element. Tilting it in CSS would rotate the box the letters are laid out in
 * and need a matching counter-rotation to stay legible; here the geometry is
 * already correct and the element stays an ordinary unrotated box.
 *
 * ## The two colours are arguments, not constants
 *
 * Kelly's file is `#000` on `#FFF`. Neither shell uses either: the marketing
 * palette is a warm `--ink` (#26221E) on `--paper`, and the results page is a
 * neutral `--ink` (#1a1a1a) on `--bg`. Pure black beside either reads as a
 * second, colder ink on the same page — the same argument the palette note in
 * `marketing.ts` makes about `#FFFFFF`. So `markCss` takes them, and each shell
 * passes its own; what cannot drift is the artwork.
 */

/** Kelly's artwork, 2026-08-26. 438x121; height follows from width. */
export const MARK = `<svg class="mark" viewBox="0 0 438 121" role="img" aria-label="The Usability Lab" focusable="false"><rect class="slab" y="46.6932" width="432.106" height="74.4613" transform="rotate(-6.20348 0 46.6932)"/><path class="word" d="M40.9353 95.245L37.704 65.5167L26.2735 66.7591L26.082 64.9971L50.9309 62.2961L51.1224 64.0581L39.6919 65.3006L42.9232 95.0289L40.9353 95.245ZM59.4478 93.2327L56.0249 61.7424L57.9676 61.5312L59.5489 76.0791L77.2594 74.1541L75.6781 59.6062L77.6208 59.395L81.0437 90.8853L79.101 91.0965L77.4558 75.9613L59.7453 77.8863L61.3905 93.0216L59.4478 93.2327ZM89.2735 89.9908L85.8506 58.5005L106.272 56.2808L106.463 58.0428L87.9849 60.0513L89.3894 72.9727L105.79 71.1901L105.981 72.9521L89.5809 74.7347L91.0247 88.0176L109.503 86.0091L109.695 87.7711L89.2735 89.9908ZM138.137 85.0453C134.643 85.425 131.837 84.709 129.72 82.8973C127.634 81.0822 126.384 78.2771 125.971 74.482L123.786 54.377L125.729 54.1659L127.895 74.0901C128.13 76.2588 128.661 78.0601 129.488 79.494C130.314 80.928 131.432 81.9645 132.843 82.6036C134.253 83.2427 135.952 83.4541 137.94 83.2381C139.988 83.0154 141.632 82.4405 142.873 81.5134C144.14 80.5528 145.021 79.2685 145.517 77.6603C146.012 76.0522 146.141 74.1487 145.902 71.95L143.756 52.2064L145.698 51.9953L147.859 71.8744C148.281 75.7598 147.655 78.8298 145.98 81.0842C144.305 83.3386 141.691 84.6589 138.137 85.0453ZM164.702 82.1577C161.781 82.4752 159.288 81.9691 157.223 80.6392C155.159 79.3094 153.76 77.3739 153.026 74.8327L154.875 74.1746C155.522 76.4814 156.71 78.1655 158.441 79.2269C160.198 80.2549 162.237 80.6428 164.556 80.3907C166.002 80.2336 167.249 79.7933 168.298 79.0697C169.377 78.3429 170.192 77.4315 170.744 76.3354C171.292 75.2091 171.495 73.9985 171.355 72.7033C171.194 71.2274 170.688 70.0786 169.837 69.2569C168.986 68.4351 167.895 67.7918 166.564 67.3269C165.264 66.8587 163.862 66.4322 162.357 66.0471C160.759 65.6418 159.274 65.1632 157.904 64.6112C156.563 64.056 155.463 63.3223 154.602 62.4102C153.737 61.4679 153.22 60.2137 153.05 58.6475C152.889 57.1716 153.107 55.8071 153.702 54.5538C154.327 53.2973 155.267 52.2657 156.52 51.459C157.773 50.6523 159.258 50.1556 160.975 49.969C162.842 49.766 164.53 50.0093 166.037 50.6988C167.574 51.385 168.867 52.4788 169.914 53.9802L168.486 55.1411C167.589 53.8977 166.528 52.9768 165.305 52.3783C164.112 51.7765 162.718 51.5624 161.121 51.736C159.796 51.88 158.649 52.2637 157.681 52.8871C156.712 53.5104 155.991 54.305 155.517 55.2708C155.04 56.2065 154.863 57.2466 154.988 58.3911C155.122 59.6261 155.549 60.6158 156.27 61.3602C157.018 62.0713 157.995 62.6508 159.202 63.0987C160.409 63.5465 161.796 63.9748 163.365 64.3833C165.15 64.8293 166.747 65.3567 168.154 65.9656C169.557 66.5444 170.71 67.3335 171.611 68.3326C172.542 69.3286 173.099 70.6699 173.283 72.3566C173.466 74.0433 173.208 75.5951 172.509 77.0121C171.836 78.3956 170.82 79.5575 169.459 80.4978C168.125 81.4047 166.54 81.958 164.702 82.1577ZM177.186 80.435L185.058 47.717L186.865 47.5206L201.673 77.7733L199.505 78.0091L186.287 50.1891L179.309 80.2042L177.186 80.435ZM181.118 71.185L181.513 69.3591L195.022 67.8908L195.846 69.584L181.118 71.185ZM207.12 77.1813L203.697 45.691L212.688 44.7137C215.52 44.406 217.809 44.8581 219.556 46.0701C221.329 47.2487 222.349 49.0578 222.614 51.4975C222.801 53.2144 222.554 54.7344 221.875 56.0578C221.227 57.3778 220.209 58.3875 218.822 59.0868C220.789 59.2387 222.375 59.9501 223.58 61.221C224.814 62.4887 225.553 64.2369 225.795 66.4658C226.1 69.2669 225.474 71.4988 223.917 73.1612C222.388 74.7903 220.012 75.78 216.789 76.1303L207.12 77.1813ZM208.867 75.1629L216.502 74.333C221.924 73.7437 224.387 71.175 223.893 66.6269C223.657 64.4582 222.888 62.8504 221.586 61.8034C220.28 60.7263 218.573 60.3024 216.465 60.5315L207.384 61.5186L208.867 75.1629ZM207.192 59.7566L215.279 58.8776C217.147 58.6746 218.577 57.9553 219.57 56.7197C220.56 55.454 220.952 53.8724 220.746 51.9749C220.53 49.987 219.73 48.5196 218.348 47.5728C216.965 46.626 215.144 46.2753 212.885 46.5209L205.837 47.287L207.192 59.7566ZM233.725 74.2894L230.302 42.7991L232.245 42.5879L235.668 74.0783L233.725 74.2894ZM243.873 73.1864L240.45 41.6961L242.393 41.4849L245.624 71.2132L260.443 69.6025L260.635 71.3645L243.873 73.1864ZM265.801 70.8029L262.378 39.3126L264.321 39.1014L267.744 70.5917L265.801 70.8029ZM284.262 68.7963L281.031 39.068L269.6 40.3104L269.409 38.5484L294.258 35.8474L294.449 37.6094L283.019 38.8519L286.25 68.5802L284.262 68.7963ZM310.907 65.9001L309.61 53.9726L296.279 35.6277L298.538 35.3821L310.298 51.8865L318.327 33.2312L320.541 32.9905L311.508 53.7664L312.804 65.6938L310.907 65.9001ZM340.851 62.6453L337.428 31.155L339.371 30.9438L342.602 60.6721L357.421 59.0613L357.612 60.8234L340.851 62.6453ZM360.023 60.5614L367.895 27.8433L369.702 27.6469L384.51 57.8997L382.342 58.1354L369.124 30.3154L362.146 60.3305L360.023 60.5614ZM363.955 51.3113L364.35 49.4854L377.859 48.0171L378.683 49.7103L363.955 51.3113ZM389.957 57.3076L386.534 25.8173L395.525 24.84C398.357 24.5323 400.646 24.9844 402.393 26.1964C404.166 27.375 405.186 29.1841 405.451 31.6239C405.638 33.3407 405.391 34.8608 404.712 36.1841C404.064 37.5041 403.046 38.5138 401.659 39.2131C403.626 39.365 405.212 40.0764 406.417 41.3473C407.651 42.615 408.39 44.3632 408.632 46.5921C408.937 49.3933 408.311 51.6251 406.754 53.2876C405.225 54.9167 402.849 55.9064 399.626 56.2567L389.957 57.3076ZM391.704 55.2892L399.339 54.4593C404.761 53.87 407.224 51.3013 406.73 46.7532C406.494 44.5846 405.725 42.9768 404.423 41.9298C403.117 40.8526 401.41 40.4287 399.302 40.6579L390.221 41.6449L391.704 55.2892ZM390.029 39.8829L398.116 39.0039C399.984 38.8009 401.414 38.0816 402.407 36.8461C403.397 35.5804 403.789 33.9987 403.583 32.1012C403.367 30.1133 402.567 28.6459 401.185 27.6991C399.802 26.7523 397.981 26.4017 395.722 26.6472L388.674 27.4133L390.029 39.8829Z"/></svg>`;

/** The artwork's aspect ratio, so a shell can work out its own clearance. */
export const MARK_ASPECT = 121 / 438;

/**
 * The slab, in the artwork's own units. `bleedCss` derives from these, and
 * `brand.test.ts` reads them back out of the source file.
 */
const SLAB = { y: 46.6932, height: 74.4613, angle: -6.20348 } as const;
const ART_HEIGHT = 121;

/**
 * Continue the slab off the left edge of the screen, without moving the letters.
 *
 * Asked for 2026-08-26: the dashboard mark should bleed like the hero's rather
 * than float in the corner. The obvious way is what the hero does — pull the
 * element left with a negative offset — and at 240px it does not work. The
 * letters begin 26 artwork units in, which is 14px at that size, so any offset
 * big enough to read as a bleed eats the T. Tried it, and it reads as broken
 * rather than deliberate.
 *
 * So nothing moves. A pseudo-element picks the slab up at the element's left
 * edge and carries it further left, off the screen. The letters stay exactly
 * where they were, and the slab runs out of the viewport, which is the whole
 * gesture.
 *
 * ## Why it lines up, and why it keeps lining up
 *
 * Every number here is a percentage of the element's own box, so one rule is
 * correct at 240px, at 186px, and at any size a later layout picks:
 *
 *   - the box's height is the artwork's height, since the svg fills its width
 *     and keeps its ratio, so `top` and `height` as percentages of it land on
 *     the slab's own band;
 *   - `right:100%` puts the strip's right edge on the element's left edge, which
 *     is where the svg's `x=0` is;
 *   - `transform-origin:100% 0` is then exactly the slab's top-left corner, and
 *     rotating about it by the slab's own angle continues the same band — the
 *     strip's right edge maps onto the rect's slanted left edge rather than
 *     merely near it.
 *
 * The 1px overlap is for the seam: two shapes meeting on a slanted edge each
 * antialias against the background, and a hairline of paper shows through where
 * they meet.
 *
 * **The selector must already be positioned.** No `position` is emitted here on
 * purpose: every current caller is `position:absolute`, and declaring
 * `position:relative` would silently move the mark back into the flow it was
 * taken out of. `marketing.test.ts` checks the pairing rather than this
 * function trying to guess it.
 *
 * The strip must also be clipped by something. An ancestor with
 * `overflow:hidden` is ideal; absent one, overflow to the left of the viewport
 * does not extend the scrollable area in LTR, so it is still safe — but that is
 * a fact about direction, not about the strip, and a mirrored layout would need
 * looking at again.
 */
export function bleedCss(selector: string, slab: string): string {
  const pct = (n: number) => `${((n / ART_HEIGHT) * 100).toFixed(3)}%`;
  return (
    `  ${selector}::before { content:""; position:absolute; right:calc(100% - 1px);` +
    ` top:${pct(SLAB.y)}; height:${pct(SLAB.height)}; width:70%;` +
    ` background:${slab}; transform:rotate(${SLAB.angle}deg); transform-origin:100% 0; }\n`
  );
}

/**
 * The size below which the mark stops drawing itself properly.
 *
 * Reported 2026-08-26: the dashboard mark "looks pixelated". It is an SVG, so
 * the first suspects were rasterisation — the `opacity:.92` on the link (an
 * element under 1 opacity gets its own compositing layer) and the transition
 * beside it. Both were measured and both were wrong: the transition changed not
 * one byte of output, and the opacity difference was a flat 8% lightening, not a
 * loss of resolution.
 *
 * The real cause is the artwork. These are hairline knockout letterforms drawn
 * at 438px wide, and their strokes fall under one device pixel long before the
 * mark does. Rendered at 1x, measuring how close the brightest letter pixels get
 * to `--paper` (250):
 *
 *     438px  250      the size the logo was drawn at
 *     300px  250      still resolving
 *     240px  239      the dashboard — visibly grey
 *     190px  215      the results masthead — washed out
 *     186px  212      the dashboard on a phone
 *
 * 300px is where it stops mattering, which is what this constant is.
 */
const RESOLVES_ABOVE = 300;

/**
 * A hairline reinforcement, in CSS pixels, for marks drawn below that size.
 *
 * `vector-effect:non-scaling-stroke` keeps it constant in device pixels however
 * large the mark is drawn, which is the right model for "put back the ink
 * antialiasing took away" — but it is emphatically *not* self-limiting, and
 * assuming it was is the second thing measured wrong here. Total letter ink,
 * against the same mark with no stroke:
 *
 *              0.4      0.6      0.8
 *     438px  +15.2%   +36.7%   +54.0%
 *     240px  +39.3%   +88.3%  +127.2%
 *     190px  +72.3%  +144.6%  +199.2%
 *
 * At 438px the letters already reach paper, so that +37% is pure weight gain on
 * artwork that was rendering correctly — Kelly's logo, quietly made bolder. Hence
 * the threshold above: the correction is applied where the ink was lost and
 * nowhere else. 0.6 lifts 190px from 215 to 234 and 240px from 239 to 243,
 * without turning a light face into a medium one.
 *
 * ## And only on the displays that need it
 *
 * The same measurement at `deviceScaleFactor: 2` is the one that decides the
 * shape of this fix:
 *
 *     width    1x plain  1x fixed   2x plain  2x fixed
 *     438px         250       250        250       250
 *     240px         239       243        250       250
 *     190px         215       234        250       250
 *
 * On a retina display there is no problem to solve — twice the device pixels is
 * enough for these strokes at every size we draw them. An unconditional stroke
 * would therefore make the mark bolder for the majority of viewers in order to
 * fix a minority's, so it sits behind a low-density media query. Both spellings
 * are needed: `resolution` is the standard one, and `-webkit-max-device-pixel-
 * ratio` covers Safari before 16.
 */
const HAIRLINE_PX = 0.6;
const LOW_DENSITY = `@media (max-resolution:1.4dppx),(-webkit-max-device-pixel-ratio:1.4)`;

/**
 * @param slab  what the rectangle is painted with, as a CSS value
 * @param word  what the letters knocked out of it are painted with
 * @param drawnAt  the widest this mark is ever rendered, in CSS px. Below
 *   `RESOLVES_ABOVE` the hairline correction is emitted; at or above it, none
 *   is, because none is needed and adding it would change the artwork's weight.
 */
export function markCss(slab: string, word: string, drawnAt = RESOLVES_ABOVE): string {
  const hairline =
    drawnAt < RESOLVES_ABOVE
      ? `  ${LOW_DENSITY} {\n` +
        `    .mark .word { stroke:${word}; stroke-width:${HAIRLINE_PX}px;` +
        ` vector-effect:non-scaling-stroke; }\n  }\n`
      : "";
  return `
  .mark { display:block; width:100%; height:auto; }
  .mark .slab { fill:${slab}; }
  .mark .word { fill:${word}; }
${hairline}`;
}

/**
 * Where the mark points, for the shells that make it a link.
 *
 * `results-full.html` is written to disk and read as a file, so a root-relative
 * href would point at the reader's own filesystem. It has to be absolute, which
 * means it has to come from somewhere — the same variable the server builds
 * magic links from. The fallback is the live domain rather than nothing: a
 * results page exported with no environment is still a results page somebody
 * may forward, and an unlinked mark on it is a worse failure than a link to the
 * site that produced it.
 */
export function siteUrl(): string {
  const configured = process.env.USABILITY_LAB_BASE_URL?.trim();
  return (configured || "https://theusabilitylab.com").replace(/\/+$/, "");
}
