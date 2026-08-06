# HEIC → JPG

A browser-based HEIC/HEIF converter. Photos are decoded with a WebAssembly build
of [libheif](https://github.com/strukturag/libheif) inside the visitor's own tab —
nothing is uploaded, and there is no backend to run or pay for.

## Why in-browser

| | In-browser (this) | Server-side API |
| --- | --- | --- |
| Hosting cost | $0 static | ~$5–20/mo container |
| Privacy | Photos never leave the device | You hold user photos in transit |
| Upload limits | None | Body-size and timeout limits |
| Scaling | Free, client CPU | You pay per conversion |
| Programmatic API | No | Yes |

## Features

- **Formats** — JPG, PNG, WebP and AVIF out, gated on what the browser can
  actually encode (AVIF is Chromium-only, and unsupported options are hidden
  rather than silently falling back to PNG).
- **Target file size** — type "500kb" and every file lands under it. Solves the
  real problem behind most conversions: a form with an upload limit.
- **Metadata studio** — every EXIF field listed and individually removable, with
  a warning showing the decoded GPS coordinates when a photo carries them.
- **PDF export** — combine photos into one document, A4 with margins or matching
  each photo exactly. JPEG data is embedded verbatim via DCTDecode.
- **Colour accuracy** — the source ICC profile is carried through, so wide-gamut
  (Display P3) iPhone photos don't silently shift toward sRGB.
- **Batch** — decoding runs across a worker pool sized to the device, with batch
  progress, an ETA and a working cancel.
- **Live settings** — quality, resize, format and metadata are adjustable *after*
  conversion. Each file is decoded once and cached, so changing a setting
  re-encodes in milliseconds rather than re-running the HEIC decode.
- **Per-file overrides** — one file in a batch can have its own quality or size
  target.
- **Batch rename** — `{name}` `{n}` `{n:3}` `{date}` `{w}` `{h}`.
- **ZIP** — stored, not deflated. Streams straight to disk where the File System
  Access API exists, so a huge batch never has to fit in memory.
- **Offline / installable** — a service worker makes it work with no network at
  all, which is also the easiest way to verify the no-upload claim.
- Handles Apple's **tiled grid HEICs** (large iPhone photos are stored as dozens
  of HEVC tiles plus a `grid` item), multi-image files, and AVIF containers.

## Getting started

```bash
npm install
npm run dev
```

Then open the printed localhost URL. To produce a production build:

```bash
npm run build
```

The output lands in `dist/` as fully static files.

## Deploying

Any static host works — there is no server component.

**Vercel** (`vercel.json` is included):

```bash
npx vercel deploy --prod
```

**Netlify** (`netlify.toml` is included):

```bash
npx netlify deploy --prod
```

**Cloudflare Pages** — build command `npm run build`, output directory `dist`.

**Any other host** — upload `dist/`. Serve it over HTTPS; workers, service
workers and the File System Access API all require a secure context.

Both bundled configs ship a strict CSP. Note the `'wasm-unsafe-eval'` script
directive: it is required for *any* WebAssembly to instantiate and does not
permit JavaScript `eval`.

## Metadata handling

Canvas encoding discards metadata, so it is re-attached by hand.

**EXIF** is parsed into a model, filtered, and re-serialised — not patched in
place. That is what makes selective field removal possible without breaking
every offset in the block. Two corrections are always applied:

- **Orientation** is forced to `1`. libheif already applies the container's
  `irot`/`imir` rotation while decoding, so copying the original value would
  make viewers rotate the image a second time.
- **PixelXDimension / PixelYDimension** are set to the real output size.

**ICC** profiles are read from the `colr` box and written as `APP2` segments
(JPEG) or an `iCCP` chunk (PNG). Both are chunked/compressed per spec.

This matters more than it sounds: libheif hands back the source's raw pixel
values, and the canvas labels them sRGB without converting. Attaching the real
profile is what makes a Display P3 photo render correctly instead of shifting.
The browser tags its own canvas output with an sRGB profile, so ours *replaces*
it rather than being appended — two profiles in one file is malformed.

**XMP** is carried into JPEG (`APP1`) and **EXIF into PNG** via the `eXIf` chunk.

Oversized EXIF drops the MakerNote first — almost always the culprit — rather
than discarding the whole block, since `APP1` has a 16-bit length field.
WebP and AVIF output carries no metadata, and the UI says so.

## How the size target works

Encoding a 12MP frame costs on the order of a second, so a naive binary search
would take most of a minute per photo. Instead the search runs on a ~1000px
proxy and only the answer is verified at full resolution.

Bytes-per-pixel is *not* constant across scales — downscaling concentrates
detail, so a proxy over-predicts the full-size result by roughly 60% on a
typical photo. Rather than assume a correction factor, one reference encode
measures the real ratio for that image, and the ratio is re-measured whenever
the output dimensions change. Cost is 2–3 full-size encodes plus a handful of
cheap proxy ones, and results land within a few percent of the budget.

## Layout

```
src/
  main.ts              entry point; installs the network counter first
  ui.ts                DOM rendering, modals, event wiring
  state.ts             Converter: queue, settings, cancel, encode scheduling
  types.ts
  styles.css
  worker/
    decode.worker.ts   libheif wasm decode → ImageBitmap
  lib/
    isobmff.ts         HEIC container parsing; EXIF/ICC/XMP extraction
    exif.ts            EXIF parse → model → filter → serialise, plus display
    jpegSegments.ts    APP1/APP2 building and replacement
    pngChunks.ts       iCCP / eXIf chunks
    encode.ts          format selection, resizing, size targeting, metadata
    pdf.ts             PDF writer (DCTDecode, hand-rolled, no dependency)
    pool.ts            lazy worker pool with cancellation
    bitmapCache.ts     LRU cache with an adaptive memory budget
    zip.ts             streaming ZIP, to disk where supported
    capabilities.ts    browser support gate, device-sized limits
    netGuard.ts        counts outbound bytes for the trust panel
    format.ts          byte/name/size helpers
```

## Notes on the implementation

**Memory.** A decoded 12MP photo costs ~48MB as RGBA. The cache budget is
derived from `navigator.deviceMemory` where available and falls back to a
device-class guess — deliberately, because that API is absent on iOS Safari,
the single most likely device to be holding HEIC files. Caches are trimmed when
the tab is backgrounded, which is when a phone is most likely to kill it.

**Downscaling.** Browsers alias badly when `drawImage` reduces by more than 2×
in one step, so large reductions are done as repeated halvings.

**Alpha.** HEIC can carry transparency and JPEG cannot, so images are flattened
onto white instead of letting transparent pixels encode as black.

**The byte counter** is instrumentation, not a security control — it reports
what this page's own code does. The CSP and the browser's network panel are the
independent checks, and the trust panel says exactly that.

## Known limits

- No programmatic API — the trade-off of the client-side design.
- **JPG → HEIC is not possible** with this dependency: `libheif-js` is a
  decode-only build (`heif_have_encoder_for_format` returns false for every
  format, and there is no `HeifEncoder` in its JS API). It would need a custom
  wasm build with x265, which is GPL-2.0 and would be a licensing problem for
  any redistributable bundle.
- Depth maps and Live Photo alternates are not extracted; the JS API only
  exposes top-level images, and auxiliary items would need extended bindings.
- EXIF over 64KB loses its MakerNote. Multi-segment `APP1` is standard for
  *Extended XMP*, not for EXIF, where reader support is poor.
- WebP/AVIF output carries no metadata.
- Whole-folder conversion and streaming ZIP-to-disk need the File System Access
  API (Chromium desktop only); everything falls back gracefully.

## Licence

The bundled libheif build is LGPL-2.1, and libde265 inside it is LGPL-3.0. Both
are surfaced in the in-app About panel, which is where compliance for a
distributed build actually has to live.
