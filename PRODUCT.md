# HEIC → JPG — Product Overview

A browser-based HEIC/HEIF to JPG converter. Everything runs client-side via a
WebAssembly build of libheif, so photos never leave the user's device and there
is no backend to operate.

---

## 1. What it does

| | |
| --- | --- |
| **Input** | HEIC, HEIF, AVIF containers — including Apple's tiled-grid HEICs (large iPhone photos stored as dozens of HEVC tiles) |
| **Output** | JPEG, with optional EXIF preservation |
| **Where it runs** | Entirely in the browser tab. No upload, no server, no queue |
| **Cost to operate** | $0 — static hosting only |
| **Limits** | None imposed. Bounded by the user's own RAM and CPU |

---

## 2. How to use it

### As an end user

1. Open the site.
2. Drop HEIC photos onto the page (or click to browse). Batch is fine.
3. Each photo decodes and appears as a card with a preview and its new file size.
4. **Adjust settings — this is the differentiating bit.** Quality, resize, and
   metadata are all changeable *after* conversion. Every file re-encodes
   instantly as you move the slider, so you can dial in the size/quality
   tradeoff while watching the actual output size update.
5. Download one file, or all of them as a ZIP.

The three controls:

| Control | Effect |
| --- | --- |
| **JPEG quality** (30–100) | Live size feedback. Defaults to 85 — good for photos and web use |
| **Resize** | Caps the longest edge. Only ever scales down, never up |
| **Keep camera metadata** | Carries over date, camera, lens — **and GPS location**. Turn off to strip everything |

### Running it locally

```bash
cd ~/heic-to-jpg
npm install
npm run dev
```

### Deploying it

Any static host. Configs for Vercel and Netlify are already committed.

```bash
npx vercel deploy --prod
```

Cloudflare Pages: build command `npm run build`, output directory `dist`.
Serve over HTTPS — workers and `OffscreenCanvas` need a secure context.

---

## 3. Use cases

**The core one:** someone is sent an iPhone photo, and the thing they need to
put it into won't accept HEIC. This is an extremely common, recurring, low-stakes
annoyance — which is exactly why the category has durable search demand.

Concretely:

- **Uploading to systems that reject HEIC** — job portals, government and visa
  forms, insurance claims, university submissions, older CMSes, e-commerce
  listings, printing services.
- **Sending photos to Windows or Android users** who see a file they can't open.
- **Web publishing** — converting and downsizing phone photos before putting
  them on a site, without opening Photoshop.
- **Email attachments** — resize to 1920px and quality 70 turns a 4 MB photo
  into ~150 KB.
- **Bulk archive conversion** — exporting a photo library into a format that
  will still open in twenty years.
- **Stripping location data** before sharing photos publicly — the metadata
  toggle is a genuine privacy feature, not just a checkbox.

### Where the privacy angle actually matters

This is the segment most competitors can't serve, because they upload to a server:

- **Legal / insurance** — evidence photos that must not touch a third party.
- **Healthcare** — clinical or dermatological photos under HIPAA-style rules.
- **Journalism / NGOs** — source photos with sensitive location metadata.
- **Corporate IT** — employees converting internal photos without exfiltrating
  them to an unknown vendor.
- **Anyone on a slow or metered connection** — no upload means no wait and no
  data cost.

---

## 4. Extension potential

### Already shipped

The following were built out and verified, and are no longer roadmap items:
PNG/WebP/AVIF output, target file size, metadata studio with selective field
removal, HEIC→PDF, ICC colour-profile preservation, XMP, before/after compare,
per-file overrides, batch rename, cancel with batch progress and ETA, adaptive
memory and worker sizing, browser-support gating, streaming ZIP, PWA/offline,
the live uploaded-bytes counter, and in-app licence and privacy panels.

**One item was investigated and abandoned as impossible:** JPG → HEIC. The
bundled `libheif-js` is a decode-only build — `heif_have_encoder_for_format`
returns false for every format and there is no `HeifEncoder` in its JS API.
Doing it needs a custom wasm build with x265, which is GPL-2.0 and would poison
any redistributable or embeddable bundle. Depth-map extraction is also blocked
for now: the JS API exposes only top-level images, not auxiliary ones.

### Still open

Roughly ordered by effort-to-value.

### Cheap wins

| Idea | Why it's easy |
| --- | --- |
| **PNG / WebP / AVIF output** | `encode.ts` already goes through a canvas — it's a MIME-type change plus a UI selector. WebP output is a real differentiator most converters lack |
| **Per-file setting overrides** | The queue in `state.ts` is already per-item; settings are just read globally today |
| **Batch rename patterns** | e.g. `vacation-001.jpg`. Pure string work on `outName` |
| **Before/after compare slider** | The decoded bitmap and encoded blob are both already in memory |
| **PWA + install to home screen** | It already works offline once loaded. Needs a manifest and a service worker |
| **Target file size mode** | "Get this under 500 KB" — binary-search the quality value. Genuinely useful for upload limits |

### Moderate effort

- **Reverse direction (JPG → HEIC)** — libheif can encode, not just decode.
- **Whole-folder conversion** via the File System Access API — pick a folder,
  convert in place, no manual downloading.
- **Live Photo and burst handling** — the decoder already returns every image in
  the file; the app currently takes the primary one and ignores the rest.
- **Depth-map extraction** — iPhone portrait shots carry depth data that is
  currently discarded. Niche but nothing else offers it.
- **ICC colour profile preservation** — currently dropped, output is sRGB. Matters
  to photographers and is a legitimate quality gap.
- **HEIC → PDF** — a genuinely common request, especially for document scans.
- **Standalone metadata viewer/editor** — the EXIF parser already exists.

### Bigger plays

- **A REST API as a paid tier.** The one thing the client-side design gives up.
  `src/lib` is plain TypeScript and would port to a Node + `sharp` service.
  Sell the API; keep the web tool free as the funnel.
- **An embeddable widget / npm SDK.** Other products need HEIC handling in their
  own upload flows. This is arguably a better business than the website — you'd
  be selling to developers who have the problem inside their own product.
- **A CLI** built on the same modules for scripted/bulk workflows.

---

## 5. Marketable aspects

### The honest competitive position

The HEIC-conversion category is crowded but weakly differentiated. Most incumbents
share the same shape: upload your photo to their server, wait, hit a file-count or
size cap, then get upsold. That creates three openings:

1. **Privacy is a real, checkable claim here — not marketing.** "Your photos are
   never uploaded" is verifiable by opening the network tab. You can turn that
   into the entire brand. Competitors that upload structurally cannot copy it.
2. **No limits.** Batch caps and "upgrade for more files" paywalls exist because
   servers cost money. They don't here, so removing the limit costs nothing and
   removes the most common reason people bounce to a competitor.
3. **Speed.** No upload and no download round-trip. On a large batch over a
   typical connection this is not a marginal difference — it's the difference
   between seconds and minutes.

### Why the economics are unusually good

Operating cost is effectively zero and stays flat regardless of traffic — a
static bundle on a free tier. There's no per-conversion cost, so a viral spike
is free rather than a bill. Practically any revenue is margin, and the project
can sit dormant indefinitely without costing anything.

### Demand characteristics

"HEIC to JPG" is evergreen, high-intent, and non-seasonal — it recurs as long as
iPhones default to HEIC. Users arrive already knowing exactly what they want,
which is the easiest kind of traffic to convert.

**Verify the actual numbers yourself** with a keyword tool before committing —
I don't have current search-volume data and won't guess at it. The category is
also genuinely competitive on SEO, with established domains holding the head
terms. Realistic entry points are long-tail queries ("heic to jpg without
uploading", "convert heic offline", "heic to jpg batch free", "remove gps from
iphone photo") where the privacy angle is a natural match for the intent.

### Monetisation options, with the tradeoffs stated

| Model | Reality check |
| --- | --- |
| **Display ads** | The default for this category. Works with volume, but sits awkwardly against a privacy-first brand — ad networks track users, which undercuts the pitch. Privacy-respecting networks earn less |
| **Donations / "buy me a coffee"** | Low yield, but zero brand damage and fits the ethos |
| **Sponsorship** | One tasteful sponsor beats an ad network for a privacy brand |
| **Paid API tier** | The most defensible revenue. Sells to developers, not consumers |
| **White-label / embed licence** | Companies pay to drop this into their own upload flow. Highest value per customer |
| **Pro features in-app** | ⚠️ Hard to enforce. Everything runs client-side and the source is inspectable, so a determined user can bypass gating. Don't build a business on this |

The strongest combination is probably: **free unlimited web tool as the funnel,
paid API and embeddable SDK as the revenue.** The consumer tool builds the brand
and the SEO surface; developers pay for the same engine in their own products.

### Compliance angle worth naming explicitly

Because no photo is ever transmitted, there is no data processing, no data
retention, and no cross-border transfer. For GDPR purposes there's essentially
nothing to disclose, and a corporate buyer typically doesn't need a DPA. That is
a genuinely strong enterprise sales point and is very difficult for a
server-based competitor to match.

### One legal caveat to handle before commercialising

The bundled libheif build is **LGPL-2.1**. That is fine for a hosted website, but
if you redistribute the code — an SDK, a white-label bundle, a desktop app — read
the terms properly and keep the licence and attribution intact. Worth a lawyer's
half-hour before signing a commercial licensing deal.

---

## 6. Current limitations

Stated plainly, since they shape what's worth building next:

- No programmatic API — the tradeoff of the client-side design.
- ICC colour profiles and XMP are not preserved; output is sRGB.
- EXIF larger than 64 KB is dropped rather than truncated (APP1 has a 16-bit
  length field).
- Very large batches are bounded by device RAM. A 600 MB bitmap cache with
  LRU eviction keeps this safe, but a low-end phone will be slower.
- Requires a modern browser — Web Workers, WebAssembly, and `OffscreenCanvas`
  (Safari 16.4+).
