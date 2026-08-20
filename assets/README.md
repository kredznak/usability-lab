# assets/

Static files served by `GET /s/<name>`, allowlisted in `src/assets.ts` and read
into memory at boot.

## inter.woff2

Inter v4.1, variable, subset to Latin. **67 KB**, down from 352 KB.

Self-hosted rather than linked from a CDN. A CDN link would hand a third party
the IP address of every reader, and it would be one more thing that has to stay
up for our pages to look right.

The full variable font carries Greek, Cyrillic and Vietnamese that these pages
will never render. Subsetting it is the difference between a 352 KB blocking
font request and a 67 KB one, on the homepage of a product that audits other
people's pages for exactly this.

### Reproducing it

```sh
curl -sSL -o Inter-4.1.zip \
  https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
unzip -j Inter-4.1.zip web/InterVariable.woff2 LICENSE.txt

# fontTools needs brotli to read or write woff2
python3 -m venv fontenv && ./fontenv/bin/pip install fonttools brotli

./fontenv/bin/pyftsubset InterVariable.woff2 \
  --output-file=inter.woff2 \
  --flavor=woff2 \
  --layout-features='kern,liga,calt,ccmp,locl,mark,mkmk,rlig,tnum' \
  --unicodes='U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+2074,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD' \
  --name-IDs='*' --name-legacy --notdef-outline
```

### What was checked after subsetting

- It is a real woff2 — `file` reports `Web Open Font Format (Version 2)`.
- The `wght` axis survived at 100–900, which covers the 300–600 the design uses.
  A subset that silently instanced the font to one weight would have rendered
  every heading in Regular and looked merely *slightly wrong*, which is the
  hardest kind of wrong to notice.
- `opsz` survived at 14–32.
- **Every character in the approved mockups is in the cmap** — checked by
  stripping tags from `docs/specs/2026-08-20-homepage-mockups/*.html` and looking
  up each codepoint. That is the check that catches a missing em dash or curly
  quote before a customer does.

`src/assets.test.ts` asserts the first of those on every run. The rest were
one-time checks at vendoring; redo them if the font is ever re-subset.

## inter-LICENSE.txt

SIL Open Font License 1.1. Inter is redistributable under it, and the OFL
requires the licence to travel with the font. It ships here for that reason and
must not be deleted as an unused file.
