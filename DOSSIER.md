# HEIC → JPG — Complete Technical & Commercial Dossier

Everything about this application in one document: what it is, how it was built,
what it was built from, what was verified, and whether it is a business.

- **Live:** https://heic-to-jpg-tan.vercel.app
- **Source:** https://github.com/kevinvarghese333-debug/heic-to-jpg
- **Licence:** project code is yours; bundled libheif is LGPL-2.1 (see §10)
- **Built:** 6–7 August 2026

---

## 1. What it is

A browser-based converter that turns Apple HEIC/HEIF photos into JPG, PNG, WebP,
AVIF or PDF. Every step — decoding, resizing, encoding, metadata handling, ZIP
packaging — happens inside the visitor's own browser tab using WebAssembly.

There is no server. No file is ever transmitted. The application is a set of
static files; the "backend" does not exist rather than being merely private.

This single architectural fact drives nearly every other property: zero hosting
cost, no upload limits, no queue, no data-protection surface, and no ability to
offer a server-side API.

---

## 2. Framework and technology stack

### Core stack

| Layer | Choice | Version | Why |
| --- | --- | --- | --- |
| Build tool | **Vite** | 5.4.21 | Fast, first-class Web Worker + WASM handling, emits plain static files |
| Language | **TypeScript** | 5.6 (strict) | Strict mode on, including `noUnusedLocals`/`noUnusedParameters` |
| UI framework | **None — vanilla DOM** | — | See below |
| HEIC decoding | **libheif-js** (WebAssembly) | 1.19.8 | The only production-grade HEIC decoder available client-side |
| Image encoding | **Browser-native canvas** | — | `OffscreenCanvas.convertToBlob`, with an `HTMLCanvasElement` fallback |
| ZIP | **fflate** | 0.8.3 | Tiny, streaming-capable |
| Hosting | **Vercel** (static) | — | Netlify + Cloudflare Pages configs also committed |

### Why no React/Vue/Svelte

Deliberate. The application has one screen and a single central store. A
framework would have added ~40KB gzipped and a virtual-DOM layer to manage a
list of cards whose updates are already surgical (each card holds direct
references to the four nodes that change).

The real performance constraint here is WASM decode and canvas encode time,
neither of which a UI framework improves. The entire UI layer compiles to 60KB
raw / 23KB gzipped.

### Bundle economics

```
index.html                 9.64 kB   gzip  2.79 kB
assets/index-*.css        16.24 kB   gzip  4.15 kB
assets/index-*.js          2.97 kB   gzip  1.44 kB   ← entry
assets/ui-*.js            60.16 kB   gzip 23.36 kB   ← lazy
assets/decode.worker-*.js  1.46 MB              ← lazy, only on first conversion
```

First paint costs ~16KB gzipped. The 1.46MB WASM decoder (libheif + libde265
compiled via Emscripten, with the `.wasm` binary inlined as base64) is fetched
only when the first file is actually dropped. A visitor who bounces never pays
for it.

---

## 3. Where the ideas and data came from

Stated plainly, because provenance matters for licensing and for credibility.

### Code and libraries adopted

| Component | Origin | Licence | Role |
| --- | --- | --- | --- |
| **libheif** | strukturag/libheif | LGPL-2.1-or-later | The actual HEIC/HEIF decoder |
| **libde265** | strukturag/libde265 | LGPL-3.0 | HEVC decoding, bundled inside the libheif build |
| **libheif-js** | catdad-experiments/libheif-js | MIT wrapper around the above | Emscripten/WASM build published to npm |
| **fflate** | 101arrowz/fflate | MIT | ZIP writing, and zlib for the PNG `iCCP` chunk |

**Nothing was copied from a competing converter.** No competitor code, no
scraped data, no dataset of any kind is used or bundled.

### Specifications implemented from scratch

The container and metadata handling is written directly against published
standards rather than adopted from a library — this is the bulk of the original
work in the project:

| Written from spec | Standard |
| --- | --- |
| ISOBMFF box parsing (`meta`, `iinf`, `iloc`, `iprp`/`ipco`, `infe`) | ISO/IEC 14496-12 |
| HEIF item model, `Exif` and `mime` items, `colr` box | ISO/IEC 23008-12 |
| EXIF/TIFF parse, edit and re-serialise | CIPA DC-008 (Exif 2.3) / TIFF 6.0 |
| JPEG `APP1`/`APP2` segment handling, multi-segment ICC | ITU-T T.81, ICC.1:2010 Annex B.4 |
| PNG `iCCP` and `eXIf` chunks, CRC-32 | PNG (ISO/IEC 15948) + 2017 eXIf extension |
| PDF writer with `DCTDecode` image XObjects | PDF 1.4 / ISO 32000 |
| ZIP central directory (verified by parsing output) | PKWARE APPNOTE |

### The feature roadmap

The upgrade list came from **your own `CORRECTIONS-AND-UPGRADES.md`**, not from
market research. I audited each item against the actual codebase before
building — which mattered, because three of its claims were wrong (§6).

### Empirical data

All performance and behaviour numbers in this document were **measured in-browser
during development**, not estimated:

- The proxy-vs-full encode size bias (~61–65%) — measured across four quality
  levels on a real 12MP photo.
- Encode counts for the size-target search — measured by instrumenting
  `convertToBlob`.
- Decode throughput — measured on a real tiled-grid HEIC.
- Codec support (`heif_have_encoder_for_format`) — probed directly against the
  compiled WASM module.

### What is NOT backed by data

**Market size, search volume and revenue potential are qualitative judgements
only.** No keyword tool, analytics or competitor traffic data was consulted. Any
number in §9 that looks like a market estimate is not one. This is called out
again where it matters.

---

## 4. Methodology — the engineering decisions

The non-obvious choices, and the reasoning behind each.

### 4.1 Decode once, encode many

Decoding a 12MP HEIC costs roughly a second. Encoding a JPEG costs a fraction of
that. So each file is decoded exactly once into an `ImageBitmap`, cached, and
re-encoded on every settings change.

This is what makes quality/resize/format/metadata adjustable *after* conversion
with instant feedback — the headline UX property of the app.

**Cost:** a decoded 12MP bitmap is ~48MB of RGBA. Forty files would be ~2GB.
**Mitigation:** an LRU cache with a memory budget; evicted entries are re-decoded
on demand from the original `File`, which stays on disk and costs nothing to
retain.

### 4.2 Adaptive resource sizing

The cache budget and worker count derive from `navigator.deviceMemory` and
`hardwareConcurrency`, with an explicit fallback path — deliberately, because
`deviceMemory` does not exist on iOS Safari, which is *the* most likely device
to be holding HEIC files. A fixed budget would have been wrong for exactly the
target user.

Caches are trimmed to 25% when the tab is backgrounded, which is when a phone is
most likely to kill it.

### 4.3 Worker pool, created lazily

libheif is CPU-bound and each instance carries its own ~1.4MB WASM heap. The
pool is capped (4 desktop / 2 mobile) and workers are spawned only when work
arrives — so a visitor who never converts anything never instantiates the module.

Cancellation terminates workers, because that is the only way to interrupt a
decode already running inside WASM. In-flight promises are explicitly settled on
cancel; otherwise they would hang forever and pin their buffers.

### 4.4 Size targeting — proxy search with per-image calibration

The most technically interesting part of the app.

**Problem:** "get this under 500KB" needs a search over JPEG quality. A naive
binary search costs ~8 full-resolution encodes ≈ most of a minute per photo.

**First attempt:** run the search on a small (~1000px) proxy and scale the
budget by pixel-count ratio. **This was wrong.** Measurement showed the proxy
over-predicts full-size output by a consistent 61–65%:

| Quality | Proxy (1000×563) | Predicted full | Actual full | Error |
| --- | --- | --- | --- | --- |
| 0.3 | 32 KB | 515 KB | 320 KB | +61% |
| 0.4 | 39 KB | 635 KB | 390 KB | +63% |
| 0.5 | 46 KB | 748 KB | 457 KB | +64% |
| 0.6 | 54 KB | 873 KB | 528 KB | +65% |

Bytes-per-pixel is *not* constant across scales — downscaling concentrates
detail, so a shrunken image is less compressible per pixel.

**Final design:** rather than assume any correction factor, one reference encode
measures the real proxy→full ratio *for that specific image*, and the ratio is
re-measured whenever output dimensions change. When quality alone cannot reach
the target, the required downscale is derived from the square root of the
overshoot (output size tracks pixel count).

**Result:** 2–3 full-size encodes plus ~9 cheap proxy encodes, landing within
1–3% of the budget:

| Target | Result | Budget used | Output dimensions |
| --- | --- | --- | --- |
| 500 KB | 390 KB | 97% | 4032×2268 (full resolution kept) |
| 300 KB | 291 KB | 97% | 3790×2132 |
| 120 KB | 118 KB | 99% | 2157×1214 |

Note it preserves resolution wherever quality alone suffices, rather than
downscaling reflexively.

### 4.5 EXIF: parse → model → filter → serialise

Most tools patch EXIF bytes in place. That cannot support removing a field,
because every subsequent offset in the block shifts.

This implementation parses TIFF into a typed model, lets the caller filter it,
and writes a fresh TIFF with recomputed offsets. Consequences:

- Individual fields can be stripped (the metadata studio).
- An oversized EXIF block drops its MakerNote — nearly always the culprit —
  instead of discarding all metadata.
- Sub-IFD pointers are recomputed, and pointers to IFDs not being emitted
  (Interop, the IFD1 thumbnail) are removed rather than left dangling.
- Round-trip is byte-identical when nothing is filtered (verified).

Two corrections are always applied:

- **Orientation → 1.** libheif already applies the container's `irot`/`imir`
  rotation during decode. Copying the original value would make viewers rotate
  a second time.
- **PixelXDimension/PixelYDimension → actual output size**, so resized files
  don't advertise stale dimensions.

### 4.6 ICC colour — replace, don't append

The single biggest output-quality fix, and the subtlest.

libheif returns pixel values in the **source's** colour space (Display P3 for a
modern iPhone photo). The canvas then labels those values sRGB **without
converting them**. Result: a P3 photo silently renders wrong.

Attaching the source's real ICC profile fixes it — the values were always
correct, they were merely mislabelled.

The trap: **browsers tag their own canvas JPEG output with an sRGB profile**
(measured: a 472-byte APP2 segment). Naively prepending ours produced a file
with two conflicting ICC profiles — malformed, and 474 wasted bytes. The
implementation now strips whatever it is about to supply before inserting.

ICC goes into JPEG as chunked `APP2` (standard multi-segment mechanism) and into
PNG as a deflate-compressed `iCCP` chunk.

### 4.7 PDF — hand-rolled, zero dependency

JPEG data can be embedded into a PDF verbatim using the `DCTDecode` filter, so
no re-compression and no PDF library is needed. The writer is ~150 lines and
emits catalog, page tree, image XObjects, content streams and a correct xref
table.

Validated two ways: by parsing the output back and confirming every xref offset
resolves to the object it claims (the thing hand-rolled PDFs usually get wrong),
and by loading it in Chrome's own PDF viewer.

### 4.8 Other decisions worth naming

- **Progressive downscaling.** Browsers alias badly when `drawImage` reduces by
  more than 2× in one step, so large reductions are done as repeated halvings.
- **Alpha flattening.** HEIC supports transparency; JPEG does not. Images are
  flattened onto white rather than letting transparent pixels encode black.
- **Format gating.** Encodable formats are probed at runtime by encoding a 4×4
  test image and checking the returned MIME type, because browsers silently
  substitute PNG when they can't honour a request. AVIF is Chromium-only and is
  hidden elsewhere rather than failing quietly.
- **Streaming ZIP.** Entries are read in 4MB slices and stored (not deflated) —
  JPEG is already compressed, so deflating wastes seconds for a fraction of a
  percent.

---

## 5. Feature inventory

**Input:** HEIC, HEIF, AVIF containers, including Apple's tiled-grid layout
(large iPhone photos are stored as dozens of HEVC tiles plus a `grid` item).

**Output:** JPG, PNG, WebP, AVIF (browser-permitting), PDF.

**Controls** — all live, all adjustable after conversion:
quality, resize cap, target file size, output format, batch rename
(`{name}` `{n}` `{n:3}` `{date}` `{w}` `{h}`), and four metadata toggles
(EXIF, GPS, colour profile, XMP).

**Per-file:** overrides for quality and size target; a metadata studio listing
every EXIF field individually removable; a before/after compare slider.

**Batch:** worker pool, progress with ETA, working cancel, ZIP download
(streaming to disk for batches over 250MB), PDF combining.

**Platform:** PWA with offline support, installable, adaptive to device memory,
browser-support gate with an explanatory message rather than a blank page,
baseline accessibility (focus management, ARIA live regions, reduced-motion).

**Trust:** live counter of bytes sent by the page, a "verify this yourself"
panel, and in-app licence attribution.

---

## 6. Verification, and the bugs it caught

Testing was scripted in-browser against real fixtures — including a genuine
tiled-grid HEIC and a purpose-built fixture carrying EXIF, GPS, Display P3 ICC
and XMP.

### Confirmed working

EXIF round-trips byte-identically · GPS decodes to 51.50000, −0.12750 (exactly
the London coordinates encoded into the fixture) · a 536-byte Display P3 profile
survives conversion · size targets land at 97–99% of budget · PDFs load in
Chrome's viewer · ZIP entries carry correct CRCs and sizes including a 5MB
chunked entry · the production bundle converts, and the service worker activates
and pre-caches.

### Bugs found by testing, not by review

1. **Two ICC profiles per JPEG** — the canvas tags its own output; mine was
   appended rather than replacing.
2. **Size target returned 132KB for a 120KB target** — the calibration ratio was
   being extrapolated by pixel count, i.e. assuming the linearity already proven
   false.
3. **Size target ~10× slower than necessary** — the full downscale was re-run on
   every quality probe.
4. **A discarded full-resolution encode** performed purely to initialise a
   variable.
5. **Cancel left cards spinning forever** — three distinct causes, including
   decode promises that never settle on a terminated worker.
6. **The service worker never registered** — it hooked the `load` event, which
   had already fired by the time the lazily-imported module ran. Offline support
   was silently dead.
7. **Hidden elements still rendered** — a CSS `display` rule outranks the user
   agent's `[hidden]` rule, so an empty modal covered the page on load and the
   loading spinner sat over every thumbnail permanently. Missed initially
   because tests asserted on the `hidden` attribute rather than computed style.
8. **ZIP always opened a native "Save As" dialog**, which is blocked in iframes
   and embedded views — and dismissing it forced a download anyway.

### Three claims in the upgrade brief that were wrong

- **"Per-file error cards" listed as missing** — already implemented and working.
- **"No keyboard or screen reader support worth speaking of"** — a baseline
  existed (focusable dropzone, ARIA labels, live regions, focus rings).
- **"Multi-segment APP1 is standard and widely supported" for oversized EXIF** —
  it is standard for *Extended XMP*, not EXIF, where reader support is poor.
  Dropping the MakerNote is the correct fix.

### Honest gaps

- **No automated test suite.** Verification was manual and scripted. Given how
  many defects the manual pass surfaced, this is the highest-value next task.
- **Wall-clock performance is unmeasured on real hardware.** The test browser
  ran backgrounded, where every `convertToBlob` costs a fixed ~1008ms regardless
  of image size — a 0.56MP proxy encoded as slowly as a 12MP frame. Encode
  *counts* were verified instead. Time it on a visible tab before publishing any
  speed claim.

---

## 7. Known limitations

- **No programmatic API.** The trade-off of the client-side design.
- **JPG → HEIC is impossible here.** `libheif-js` is a decode-only build:
  `heif_have_encoder_for_format` returns false for every format and there is no
  `HeifEncoder` in its JS API. It would require a custom WASM build with x265,
  which is **GPL-2.0** and would contaminate any redistributable bundle.
- **Depth maps and Live Photo alternates are not extracted** — the JS API
  exposes only top-level images; auxiliary items need extended bindings.
- **EXIF over 64KB loses its MakerNote** (APP1 has a 16-bit length field).
- **WebP/AVIF output carries no metadata.**
- **Streaming ZIP-to-disk needs the File System Access API** (Chromium desktop).
- Requires WebAssembly, Web Workers and `createImageBitmap` — Safari 15+,
  modern Chrome/Edge/Firefox.

---

## 8. Operating cost

| Item | Cost |
| --- | --- |
| Hosting | **$0** — static files on a free tier |
| Bandwidth | ~1.5MB per first-time converting visitor; free tiers cover substantial traffic |
| Compute per conversion | **$0** — it runs on the visitor's CPU |
| Storage | **$0** — nothing is stored |
| Scaling | Flat. A traffic spike is free, not a bill |

The project can sit dormant indefinitely at zero cost. There is no per-conversion
marginal cost at any volume.

---

## 9. Is it marketable and monetizable?

**Short answer: marketable yes, monetizable with real constraints.**

### What genuinely differentiates it

1. **The privacy claim is verifiable, not rhetorical.** "Your photos are never
   uploaded" can be checked in the network panel, or by turning off wifi and
   watching it still work. Competitors that upload structurally cannot copy
   this.
2. **No limits.** Batch caps and "upgrade for more files" paywalls exist because
   servers cost money. They don't here, so removing the cap costs nothing and
   removes the commonest reason to bounce.
3. **Capabilities the category mostly lacks** — target file size, per-field
   metadata editing, HEIC→PDF, and correct wide-gamut colour.

### Demand characteristics

The need is evergreen, high-intent and non-seasonal: it recurs for as long as
iPhones default to HEIC and other systems reject it. Users arrive knowing
exactly what they want.

> **Caveat, stated plainly:** I have no search-volume, traffic or competitor
> data. The category is well established and head terms are held by domains with
> years of authority. Verify with a real keyword tool before investing. Realistic
> entry is via long-tail, privacy-shaped queries ("convert heic without
> uploading", "remove gps from iphone photo", "heic to pdf") where the product's
> actual strengths match the intent.

### Monetisation options, with honest trade-offs

| Model | Assessment |
| --- | --- |
| **Embeddable widget / SDK licence** | **Strongest.** Sells to developers who need HEIC handling inside their own upload flows. High value per customer, and the buyer has a real budget |
| **Paid API tier** | Defensible revenue, but note free npm libraries set price expectations near zero, and it means running the server this design deliberately avoids |
| **Sponsorship** | One tasteful sponsor fits a privacy brand far better than an ad network |
| **Donations** | Low yield, zero brand damage |
| **Display ads** | The category default, but sits in direct tension with the brand — ad networks track users, undercutting the one claim that differentiates the product |
| **In-app "pro" gating** | ⚠️ **Do not build on this.** Everything runs client-side with inspectable source; gating is bypassable in an afternoon, and being caught damages the trust position that is the actual asset |

**Recommended shape:** free, unlimited web tool as the funnel and SEO surface;
paid embeddable SDK / API as the revenue. The consumer product builds the brand;
developers pay for the same engine inside their products.

### The compliance angle — an underrated asset

Because no photo is transmitted, there is no data processing, no retention and
no cross-border transfer. For GDPR purposes there is essentially nothing to
disclose, and a corporate buyer typically needs no DPA. That is a strong
enterprise sales point that a server-based competitor cannot match, and it opens
segments others can't serve: legal, healthcare, journalism, corporate IT.

### Blockers to resolve before commercialising

1. **LGPL.** Fine for a hosted website. If you redistribute the code — an SDK, a
   white-label bundle, a desktop app — the LGPL obligations (relinking, source
   availability, attribution) apply to the libheif portion. Worth a lawyer's
   half hour before signing anything.
2. **No test suite.** A paying integrator will ask.
3. **Unverified market numbers.** See the caveat above.
4. **The GPS default.** Location metadata is preserved by default. For a public
   tool that is a defensible fidelity choice, but it deserves a conscious
   decision rather than an accident.

---

## 10. Licensing and legal

| Component | Licence | Obligation |
| --- | --- | --- |
| **libheif** | LGPL-2.1-or-later | Attribution; users must be able to relink a modified version |
| **libde265** | LGPL-3.0 | Same, bundled inside the libheif build |
| **libheif-js** | MIT | Attribution |
| **fflate** | MIT | Attribution |
| **Vite / TypeScript** | MIT / Apache-2.0 | Build-time only, not shipped |
| **Project code** | Yours | — |

Attribution is surfaced in the in-app **About & licences** panel, which is where
compliance for a distributed build has to live — sitting in `node_modules` does
not count.

**x265 is explicitly avoided.** It is GPL-2.0, and adding it (the only route to
HEIC *encoding*) would impose copyleft on any redistributable bundle.

---

## 11. File map

```
src/
  main.ts              entry; installs the outbound-byte counter before app code
  ui.ts                DOM rendering, modals, event wiring
  state.ts             Converter: queue, settings, cancel, encode scheduling
  types.ts
  styles.css
  worker/
    decode.worker.ts   libheif WASM decode → ImageBitmap
  lib/
    isobmff.ts         HEIC container parsing; EXIF/ICC/XMP extraction
    exif.ts            EXIF parse → model → filter → serialise, plus display
    jpegSegments.ts    APP1/APP2 building and replacement
    pngChunks.ts       iCCP / eXIf chunks, CRC-32
    encode.ts          format selection, resizing, size targeting, metadata
    pdf.ts             PDF writer (DCTDecode, hand-rolled)
    pool.ts            lazy worker pool with cancellation
    bitmapCache.ts     LRU cache with an adaptive memory budget
    zip.ts             streaming ZIP, to disk where supported
    capabilities.ts    browser support gate, device-sized limits, format probing
    netGuard.ts        counts outbound bytes for the trust panel
    format.ts          byte/name/size helpers
public/
  manifest.webmanifest, sw.js, icons/
```

---

## 12. Operations

**Develop:**
```bash
npm install && npm run dev
```

**Build:**
```bash
npm run build          # tsc --noEmit && vite build → dist/
```

**Deploy:**
```bash
npx vercel deploy --prod --yes
```

Netlify (`netlify.toml`) and Cloudflare Pages (build `npm run build`, output
`dist`) are also configured. Serve over HTTPS — workers, service workers and the
File System Access API all require a secure context.

Both host configs ship a strict CSP. The `'wasm-unsafe-eval'` script directive
is required for any WebAssembly to instantiate and does **not** permit
JavaScript `eval`.

---

## 13. Recommended next steps

1. **Add a test suite** with fixtures for tiled-grid HEIC, multi-image
   containers, AVIF, alpha, no-EXIF, oversized EXIF, corrupt and zero-byte
   files. Highest value, given the defect rate the manual pass found.
2. **Time it on real hardware** and replace every performance claim with a
   measured one.
3. **Decide the GPS default** consciously.
4. **Validate the market** with a keyword tool before investing further.
5. **Build the embeddable widget** if pursuing revenue — it is the strongest
   commercial path, and the LGPL question should be settled first.
