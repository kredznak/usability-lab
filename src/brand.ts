/**
 * The mark, in one place, because four shells now draw it.
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
 * vector at every size, costs no request, and takes its colour from whatever
 * palette it lands in.
 *
 * ## Two pieces, because they are used in different places
 *
 * `MARK` is the whole lockup — glyph plus the words. `ICON` is the glyph alone.
 * The words need room: at 200px wide the letters are 21px tall and that is
 * about the floor. A dashboard corner does not have that room, and a wordmark
 * squeezed into it is unreadable rather than small. So the corner takes `ICON`,
 * which is square and reads at 36px, and the homepage — the one page where a
 * stranger has to learn the name — takes `MARK`.
 *
 * ## What this replaced, and what went with it — 2026-08-28
 *
 * The previous artwork (`brand/previous/`) was a black slab with the letters
 * knocked out of it, and three things in this module existed only to serve it:
 *
 *   - **`bleedCss`.** It continued the slab past an element's left edge with a
 *     rotated pseudo-element, so the mark ran off the side of the page. There
 *     is no slab now — this artwork is line work on nothing — so there is
 *     nothing to continue, and the treatment is gone from all four shells.
 *   - **`markCss(slab, word)`.** Two colours, because the letters were a hole
 *     in the rectangle. This artwork is one ink.
 *   - **The hairline correction** (`hairlineCss`, `RESOLVES_ABOVE`). Knockout
 *     letters at hairline weight lose ink to antialiasing below about 300px and
 *     go grey; the fix put 0.6 device pixels of stroke back on low-density
 *     displays. Measured against this artwork, the problem does not exist: the
 *     darkest letter pixels reach full ink (35, against paper at 250) at every
 *     width from 160px to 600px. What changes with size is only how much of the
 *     letter is antialiased edge — 9% of letter pixels at full ink at 160px,
 *     65% at 600px — which is ordinary, and which a stroke would not improve.
 *     A positive letterform thins at the edges; a knockout one fills in. They
 *     are not the same failure and this one does not need correcting.
 *
 * `brand/previous/` keeps the old artwork rather than deleting it, and the
 * measurement tables that justified the correction are in `brand/README.md`.
 * They are the reason not to reintroduce any of it by reflex if the artwork
 * ever changes again — re-measure first.
 *
 * ## The colour is an argument, not a constant
 *
 * Kelly's files are `#000`. No shell uses it: the marketing palette is a warm
 * `--ink` (#26221E) and the results page a neutral one (#1a1a1a). Pure black
 * beside either reads as a second, colder ink on the same page. So `markCss`
 * and `iconCss` take the colour and each shell passes its own; what cannot
 * drift is the artwork.
 *
 * ## No ids in the markup
 *
 * Both source files wrap their paths in a `clipPath` with a Figma-generated id
 * (`clip0_56_155`, `clip0_56_156`). Ids in inline SVG are document-global, so
 * two marks on one page would collide. Both clips were checked by rendering
 * with and without them — zero differing bytes, in both files — so they are
 * dropped rather than renamed, and the hazard goes with them.
 */

/** Kelly's artwork, 2026-08-28. 1241x169; height follows from width. */
export const MARK = `<svg class="mark" viewBox="0 0 1241 169" role="img" aria-label="The Usability Lab" focusable="false"><path class="word" d="M154.379 130V47.06H122.659V39.39H194.549V47.06H162.959V130H154.379ZM208.176 130V39.39H216.626V79.82H264.466V39.39H273.046V130H264.466V87.75H216.626V130H208.176ZM295.139 130V39.39H354.419V47.06H303.589V80.08H349.219V87.75H303.589V122.33H354.419V130H295.139ZM436.537 131.3C426.137 131.3 418.164 128.397 412.617 122.59C407.071 116.783 404.297 108.333 404.297 97.24V39.39H412.747V96.33C412.747 102.223 413.571 107.207 415.217 111.28C416.864 115.267 419.421 118.3 422.887 120.38C426.441 122.373 430.991 123.37 436.537 123.37C441.997 123.37 446.504 122.33 450.057 120.25C453.611 118.083 456.254 115.007 457.987 111.02C459.721 106.947 460.587 101.963 460.587 96.07V39.39H468.907V96.59C468.907 107.857 466.134 116.48 460.587 122.46C455.041 128.353 447.024 131.3 436.537 131.3ZM515.138 131.17C506.298 131.17 499.062 128.873 493.428 124.28C487.795 119.687 484.372 113.577 483.158 105.95L491.478 103.87C492.518 110.283 495.162 115.18 499.408 118.56C503.742 121.853 509.072 123.5 515.398 123.5C519.125 123.5 522.462 122.763 525.408 121.29C528.442 119.817 530.825 117.737 532.558 115.05C534.292 112.363 535.158 109.287 535.158 105.82C535.158 102.093 534.162 99.1033 532.168 96.85C530.175 94.51 527.532 92.5167 524.238 90.87C520.945 89.2233 517.218 87.62 513.058 86.06C508.378 84.24 504.175 82.29 500.448 80.21C496.722 78.0433 493.775 75.4433 491.608 72.41C489.528 69.3767 488.488 65.6067 488.488 61.1C488.488 56.5933 489.572 52.65 491.738 49.27C493.905 45.8033 496.938 43.0733 500.838 41.08C504.825 39.0867 509.418 38.09 514.618 38.09C520.165 38.09 525.062 39.3467 529.308 41.86C533.555 44.3733 536.978 48.0567 539.578 52.91L532.818 57.07C530.738 53.43 528.138 50.6133 525.018 48.62C521.985 46.6267 518.432 45.63 514.358 45.63C510.892 45.63 507.858 46.28 505.258 47.58C502.658 48.88 500.622 50.7 499.148 53.04C497.675 55.2933 496.938 57.8933 496.938 60.84C496.938 63.96 497.762 66.6033 499.408 68.77C501.142 70.9367 503.568 72.8 506.688 74.36C509.895 75.92 513.622 77.48 517.868 79.04C522.895 80.9467 527.315 83.0267 531.128 85.28C535.028 87.4467 538.062 90.1333 540.228 93.34C542.395 96.5467 543.478 100.533 543.478 105.3C543.478 110.327 542.265 114.79 539.838 118.69C537.412 122.59 534.075 125.667 529.828 127.92C525.582 130.087 520.685 131.17 515.138 131.17ZM551.776 130L585.446 39.39H592.596L626.136 130H616.906L589.086 51.22L561.266 130H551.776ZM568.416 106.73L571.146 99.06H606.896L609.756 106.73H568.416ZM640.324 130V39.39H667.754C676.161 39.39 682.748 41.3833 687.514 45.37C692.281 49.3567 694.664 54.86 694.664 61.88C694.664 66.56 693.581 70.6333 691.414 74.1C689.248 77.5667 686.214 80.1233 682.314 81.77C687.774 83.07 691.934 85.7133 694.794 89.7C697.741 93.6 699.214 98.67 699.214 104.91C699.214 112.97 696.701 119.167 691.674 123.5C686.734 127.833 679.628 130 670.354 130H640.324ZM648.774 122.2H669.834C683.788 122.2 690.764 116.307 690.764 104.52C690.764 98.9733 689.204 94.6833 686.084 91.65C683.051 88.53 678.718 86.97 673.084 86.97H648.774V122.2ZM648.774 79.3H670.094C674.948 79.3 678.848 77.8267 681.794 74.88C684.741 71.9333 686.214 67.99 686.214 63.05C686.214 58.11 684.568 54.2533 681.274 51.48C678.068 48.62 673.561 47.19 667.754 47.19H648.774V79.3ZM717.639 130V39.39H726.089V130H717.639ZM748.235 130V39.39H756.685V122.33H798.415V130H748.235ZM811.965 130V39.39H820.415V130H811.965ZM865.571 130V47.06H833.851V39.39H905.741V47.06H874.151V130H865.571ZM942.637 130V95.29L910.657 39.39H920.277L946.667 86.71L973.317 39.39H983.067L951.217 95.29V130H942.637ZM1030.2 130V39.39H1038.65V122.33H1080.38V130H1030.2ZM1085.87 130L1119.54 39.39H1126.69L1160.23 130H1151L1123.18 51.22L1095.36 130H1085.87ZM1102.51 106.73L1105.24 99.06H1140.99L1143.85 106.73H1102.51ZM1174.42 130V39.39H1201.85C1210.25 39.39 1216.84 41.3833 1221.61 45.37C1226.37 49.3567 1228.76 54.86 1228.76 61.88C1228.76 66.56 1227.67 70.6333 1225.51 74.1C1223.34 77.5667 1220.31 80.1233 1216.41 81.77C1221.87 83.07 1226.03 85.7133 1228.89 89.7C1231.83 93.6 1233.31 98.67 1233.31 104.91C1233.31 112.97 1230.79 119.167 1225.77 123.5C1220.83 127.833 1213.72 130 1204.45 130H1174.42ZM1182.87 122.2H1203.93C1217.88 122.2 1224.86 116.307 1224.86 104.52C1224.86 98.9733 1223.3 94.6833 1220.18 91.65C1217.14 88.53 1212.81 86.97 1207.18 86.97H1182.87V122.2ZM1182.87 79.3H1204.19C1209.04 79.3 1212.94 77.8267 1215.89 74.88C1218.83 71.9333 1220.31 67.99 1220.31 63.05C1220.31 58.11 1218.66 54.2533 1215.37 51.48C1212.16 48.62 1207.65 47.19 1201.85 47.19H1182.87V79.3Z"/><path class="glyph" d="M68.1005 110.241C62.7407 110.241 58.3787 105.881 58.3787 100.519C58.3787 95.0725 53.9458 90.6396 48.4991 90.6396C43.0525 90.6396 38.6196 95.0725 38.6196 100.519C38.6196 105.879 34.2594 110.239 28.8996 110.241C23.4511 110.241 19.02 114.672 19.02 120.121C19.02 125.569 23.4529 130 28.8996 130C34.3463 130 38.7791 125.567 38.7791 120.121C38.7791 114.761 43.1411 110.401 48.5009 110.401C53.8608 110.401 58.2209 114.761 58.2209 120.122C58.2209 125.569 62.6538 130.002 68.1005 130.002C73.5472 130.002 77.98 125.569 77.98 120.122C77.98 114.676 73.549 110.243 68.1005 110.243V110.241Z"/><path class="glyph" d="M29.4809 91.3787C34.9276 91.3787 39.3604 86.9476 39.3604 81.4991C39.3604 76.0507 34.9276 71.6196 29.4809 71.6196C24.1211 71.6196 19.7609 67.2594 19.7591 61.8996C19.7591 56.4511 15.328 52.02 9.87955 52.02C4.43108 52.02 0 56.4511 0 61.8996C0 67.348 4.43108 71.7791 9.87955 71.7791C15.2394 71.7791 19.6013 76.1393 19.6013 81.5009C19.6013 86.8625 15.2412 91.2209 9.87955 91.2209C4.43286 91.2209 0 95.652 0 101.1C0 106.549 4.43108 110.98 9.87955 110.98C15.328 110.98 19.7591 106.547 19.7591 101.1C19.7591 95.7407 24.1193 91.3787 29.4809 91.3787Z"/><path class="glyph" d="M28.8996 52.7589C34.2594 52.7589 38.6214 57.1191 38.6214 62.4807C38.6214 67.9274 43.0542 72.3603 48.5009 72.3603C53.9476 72.3603 58.3805 67.9292 58.3805 62.4807C58.3805 57.1209 62.7407 52.7607 68.1005 52.7589C73.549 52.7589 77.98 48.3278 77.98 42.8794C77.98 37.4309 73.5472 32.9998 68.1005 32.9998C62.6538 32.9998 58.2209 37.4309 58.2209 42.8794C58.2209 48.2392 53.859 52.5994 48.4991 52.5994C43.1393 52.5994 38.7791 48.2392 38.7791 42.8776C38.7791 37.4309 34.3463 32.998 28.8996 32.998C23.4529 32.998 19.02 37.4291 19.02 42.8776C19.02 48.3261 23.4511 52.7589 28.8996 52.7589Z"/><path class="glyph" d="M87.1205 91.2209C81.7607 91.2209 77.3987 86.8608 77.3987 81.4991C77.3987 76.1375 81.7589 71.7791 87.1205 71.7791C92.5672 71.7791 97.0001 67.348 97.0001 61.8996C97.0001 56.4511 92.5672 52.02 87.1205 52.02C81.6739 52.02 77.241 56.4511 77.241 61.8996C77.241 67.2594 72.8808 71.6214 67.5192 71.6214C62.0725 71.6214 57.6396 76.0542 57.6396 81.5009C57.6396 86.9476 62.0725 91.3805 67.5192 91.3805C72.879 91.3805 77.2392 95.7407 77.241 101.1C77.241 106.549 81.6739 110.98 87.1205 110.98C92.5672 110.98 97.0001 106.547 97.0001 101.1C97.0001 95.6538 92.5672 91.2209 87.1205 91.2209Z"/></svg>`;

/** The glyph alone. Square, and the only piece small enough for a corner. */
export const ICON = `<svg class="icon" viewBox="0 0 203 203" role="img" aria-label="The Usability Lab" focusable="false"><path class="glyph" d="M142.519 161.648C131.303 161.648 122.174 152.523 122.174 141.303C122.174 129.904 112.897 120.627 101.498 120.627C90.0994 120.627 80.8224 129.904 80.8224 141.303C80.8224 152.52 71.6974 161.645 60.4804 161.648C49.078 161.648 39.8047 170.922 39.8047 182.324C39.8047 193.727 49.0817 203 60.4804 203C71.8792 203 81.1562 193.723 81.1562 182.324C81.1562 171.107 90.2848 161.982 101.502 161.982C112.719 161.982 121.844 171.107 121.844 182.328C121.844 193.727 131.121 203.004 142.519 203.004C153.918 203.004 163.195 193.727 163.195 182.328C163.195 170.929 153.922 161.652 142.519 161.652V161.648Z"/><path class="glyph" d="M61.6971 122.174C73.0959 122.174 82.3729 112.901 82.3729 101.498C82.3729 90.0957 73.0959 80.8224 61.6971 80.8224C50.4801 80.8224 41.3552 71.6974 41.3515 60.4804C41.3515 49.078 32.0782 39.8047 20.6758 39.8047C9.2733 39.8047 0 49.078 0 60.4804C0 71.8829 9.2733 81.1562 20.6758 81.1562C31.8927 81.1562 41.0214 90.2811 41.0214 101.502C41.0214 112.723 31.8964 121.844 20.6758 121.844C9.27701 121.844 0 131.117 0 142.519C0 153.922 9.2733 163.195 20.6758 163.195C32.0782 163.195 41.3515 153.918 41.3515 142.519C41.3515 131.303 50.4764 122.174 61.6971 122.174Z"/><path class="glyph" d="M60.4804 41.3516C71.6974 41.3516 80.8261 50.4765 80.8261 61.6972C80.8261 73.0959 90.1031 82.3729 101.502 82.3729C112.901 82.3729 122.178 73.0996 122.178 61.6972C122.178 50.4802 131.303 41.3553 142.519 41.3516C153.922 41.3516 163.195 32.0783 163.195 20.6758C163.195 9.27335 153.918 4.72118e-05 142.519 4.72118e-05C131.121 4.72118e-05 121.844 9.27335 121.844 20.6758C121.844 31.8928 112.715 41.0177 101.498 41.0177C90.2811 41.0177 81.1562 31.8928 81.1562 20.6721C81.1562 9.27335 71.8792 -0.00366211 60.4804 -0.00366211C49.0817 -0.00366211 39.8047 9.26964 39.8047 20.6721C39.8047 32.0745 49.078 41.3516 60.4804 41.3516Z"/><path class="glyph" d="M182.324 121.844C171.107 121.844 161.978 112.719 161.978 101.498C161.978 90.2774 171.103 81.1562 182.324 81.1562C193.723 81.1562 203 71.8829 203 60.4804C203 49.078 193.723 39.8047 182.324 39.8047C170.925 39.8047 161.648 49.078 161.648 60.4804C161.648 71.6974 152.523 80.8261 141.303 80.8261C129.904 80.8261 120.627 90.1031 120.627 101.502C120.627 112.901 129.904 122.178 141.303 122.178C152.52 122.178 161.645 131.303 161.648 142.519C161.648 153.922 170.925 163.195 182.324 163.195C193.723 163.195 203 153.918 203 142.519C203 131.121 193.723 121.844 182.324 121.844Z"/></svg>`;

/**
 * Height over width, for callers that need to know how tall the mark will be
 * before the browser lays it out. `marketing.test.ts` proves the h1 clears it.
 */
export const MARK_ASPECT = 169 / 1241;
export const ICON_ASPECT = 1;

/**
 * The smallest width at which the words are still words.
 *
 * At 200px the caps are 21px tall and it reads; below that the lockup is a grey
 * dash with a glyph on it. Not a soft preference — `marketing.test.ts` refuses
 * a shell that draws `MARK` narrower, because the failure looks like a design
 * choice rather than a bug and nothing else would catch it.
 */
export const MARK_MIN_WIDTH = 200;

/**
 * @param ink  what the whole lockup is painted with, as a CSS value
 */
export function markCss(ink: string): string {
  return `
  .mark { display:block; width:100%; height:auto; }
  .mark .word, .mark .glyph { fill:${ink}; }
`;
}

/**
 * @param ink  what the glyph is painted with, as a CSS value
 */
export function iconCss(ink: string): string {
  return `
  .icon { display:block; width:100%; height:auto; }
  .icon .glyph { fill:${ink}; }
`;
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
