# Upscaling

Two modules, one problem. `upscale.ts` is classical resampling — instant,
universal, no download. `superres.ts` is a neural model on the visitor's GPU —
much better, much slower, needs WebGPU. Both are wired into the UI as the
**Upscale** tab: the classical path applies live like every other setting, and
the neural one runs on an explicit button because it costs seconds per
megapixel.

---

# 1. Classical — `src/lib/upscale.ts`

`src/lib/upscale.ts` — a self-contained image enlarger, written to drop into
the existing pipeline as a fifth tool. It runs inside the normal encode path,
so changing the scale or the filter re-renders immediately like any other
setting — no button, no waiting.

## What it does

Enlarges an image with a proper reconstruction filter instead of the browser's
bilinear `drawImage`, then restores the acutance that any interpolation
necessarily loses.

- **Five filters** — Lanczos-3/2, Catmull-Rom, Mitchell, bilinear.
- **Correct alpha** — premultiplied throughout, so upscaled cut-outs don't get
  the dark fringe that straight-RGBA interpolation produces.
- **De-ringing** — windowed-sinc kernels have negative lobes that overshoot on
  hard edges (the bright halo). Each output pixel is clamped back into the
  range of the source pixels that fed it, in both passes.
- **Unsharp mask** — radius scales with the enlargement factor, with a
  threshold so film grain and JPEG noise aren't amplified into speckle.
- **Bounded memory** — rows are scaled on demand and cached only while the
  vertical kernel window needs them, so the intermediate is a couple of dozen
  rows rather than a full float-precision copy.

### Why no AI super-resolution

An ESRGAN-class model would mean either a network call — which breaks the
"nothing leaves your device" promise the product is built on, and which
`netGuard` exists to make checkable — or a 20–70MB weights download that dwarfs
the app and won't reliably cache on a phone. This is classical reconstruction
instead. It does not invent detail, because there is none to invent; it avoids
adding blur and jaggies of its own, and sharpens what is actually there.

## Measured

Downscale a known image, upscale it back, compare against the truth (PSNR,
higher is closer):

| filter | quality | vs. browser default |
| --- | --- | --- |
| bilinear (what `drawImage` does) | 33.55 dB | baseline |
| Mitchell | 33.95 dB | +0.40 dB |
| Lanczos-2 | 34.63 dB | +1.08 dB |
| Lanczos-3 | 34.66 dB | +1.11 dB |
| **Catmull-Rom (default)** | **35.08 dB** | **+1.53 dB** |

Catmull-Rom is the default on that measurement *and* because it costs about
half what Lanczos-3 does (support 2 against 3). Lanczos-3 is kept for anyone
who wants maximum acutance and will take more ringing for it.

On a clean step edge, de-ringing removes 100% of halo pixels and holds the
output to the source's exact value range.

Throughput, single-threaded (M-series laptop):

| job | time |
| --- | --- |
| 3MP → 2× (4000×3000 out) | 1.1s |
| 1000×750 → 4× | 1.0s |
| 12MP → 2× (8000×6000 out, the cap) | 4.9s |

Peak RSS for the largest permitted job is ~700MB.

## How it is wired

Both engines live behind one **Upscale** tab, next to Resize.

- **Standard** flows through the normal pipeline like any other setting.
  `resolveResize` deliberately never enlarges, so `targetDimensions` in
  `encode.ts` routes past it to `resolveUpscale` when an upscale spec is set.
- **AI** cannot work that way. At ~20s/megapixel it would be ruinous to re-run
  every time the quality slider moves, so it is an explicit button. The result
  is cached on the item as `enhanced` (an `ImageBitmap`) and from then on
  *replaces the source* for encoding — which makes format, quality, crop and
  rotation instant again, exactly like the rest of the app.
- `enhancedKey` records the upscale spec the cached result came from. Change the
  multiplier and the cache goes stale: output silently falls back to the
  classical path, the AI badge disappears, and the button re-arms. Change it
  back and the cached result returns instantly.
- The key deliberately excludes crop, rotation and flip. The model runs on the
  whole source and those are applied afterwards, so adjusting them never throws
  away GPU work.
- WebGPU is probed once at startup by requesting an actual adapter. Where it is
  missing the AI option explains itself and the standard upscaler carries on.

Files touched: `types.ts`, `state.ts`, `lib/encode.ts`, `ui.ts`, `index.html`,
`styles.css`, `vite.config.ts`.

## Tests

The pure half runs under Node with no DOM. 46 property checks cover flat-field
and border handling, brightness preservation, gradient monotonicity, alpha
fringing, de-ringing, the unsharp mask, every sizing rule, and the memory clamp.
Bundle with the esbuild already in `node_modules` and run with `node`.


---

# 2. Neural — `src/lib/superres.ts`

Real super-resolution via ONNX Runtime Web on **WebGPU**. The photo still never
leaves the device; the only thing that travels is the model, once, inbound.

## Measured, not assumed

Everything below was run on a real Apple M-series GPU (`metal-3`) through the
actual module, not estimated.

**Quality** — downscale a real photo, upscale it back, compare to the original:

| method | PSNR | vs. browser bilinear |
| --- | --- | --- |
| bilinear (`drawImage`) | 30.56 dB | baseline |
| classical (`upscale.ts`) | 32.45 dB | +1.89 dB |
| ClearReality (1.8MB AI) | 33.02 dB | +2.46 dB |
| **RealPLKSR (28MB AI)** | **36.30 dB** | **+5.74 dB** |

RealPLKSR is a large, visible jump — it reconstructs wall stipple and fabric
weave that the classical path can only smooth.

**Do not pick a model on the metric alone.** ClearReality scores above the
classical path while visibly *erasing* fine texture into plastic smoothness.
It looks cleaner and is worse. Models get chosen by looking at output.

**Speed** — this is the constraint:

| | |
| --- | --- |
| RealPLKSR, one 512×512 tile | **5.35s** |
| per megapixel of input | **~20s** |
| 0.25MP (500×500) | ~5s |
| 1MP | ~20s |
| 12MP iPhone photo | **~4 minutes** |

WebGPU is only ~5× faster than the same model on CPU here. The model is simply
heavy. **Slower GPUs will be worse.**

**Payload**, one-time and then cached: ~5MB gzipped ONNX runtime + 28MB model.

## What that means for the product

`MAX_AI_INPUT_PIXELS` caps the neural path at 2MP. This is not really a
limitation — enlarging exists for images that are *small*, and a 12MP photo
does not need it. Above the cap, the classical path is both the right answer
and the instant one.

So the tool should present as: classical by default, always instant, always
works; "Enhance with AI" as an explicit opt-in on small images, with a size
estimate and a progress bar, because 20s/MP needs to be a promise made up front.

## Rejected

- **ClearReality x4 (1.8MB)** — tempting on size, but it **fails outright on
  WebGPU** (unsupported operator in the execution provider), and it smooths
  texture away. Not offered.
- **RealPLKSR x4** — exists upstream and would halve the passes for 4× jobs,
  but it was never tested here, so it is deliberately not in `MODELS`.

## Setup

The runtime's wasm and the model are large binaries served as static assets,
deliberately not bundled so the browser caches them separately. They are
gitignored — a deploy step has to place them:

```bash
mkdir -p public/ort public/models
# Exactly three files. The webgpu build references the *asyncify* wasm — not
# jsep, not the plain one — and copying the whole dist folder ships 76MB.
cp node_modules/onnxruntime-web/dist/ort.webgpu.bundle.min.mjs public/ort/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.{mjs,wasm} public/ort/
curl -L -o public/models/realplksr_x2.onnx \
  https://huggingface.co/darktable-org/upscale-realplksr-onnx/resolve/main/onnx/model_x2.onnx
```

That is ~23MB of runtime (≈5MB gzipped) plus the 28MB model. `superres.ts`
loads the runtime **by URL**, not by package specifier: importing the package
makes the bundler inline the wasm into the build as well as serving it from
`public/`, paying for it twice.

Model licence: **MIT**, from the darktable project.

`vite.config.ts` needed two changes for this, both already applied: excluding
`onnxruntime-web` from dep pre-bundling, and a dev middleware stripping query
strings under `/ort/`. Without them Vite rewrites the runtime's dynamic wasm
imports with `?import` and they 404 against `public/`.

The CSP in `vercel.json` / `netlify.toml` will need `wasm-unsafe-eval` in
`script-src`. That is what actually gates where anything can be sent, so change
it deliberately.

## Usage

```ts
import { SuperResSession, MODELS, DEFAULT_MODEL_ID, isSupported, superResolve } from './lib/superres';

if (await isSupported()) {
  const session = new SuperResSession(MODELS[DEFAULT_MODEL_ID]);
  const { image, notes } = await superResolve(src, spec, session, onProgress, signal);
} else {
  const { image, notes } = upscaleRgba(src, spec);   // classical fallback
}
```

`isSupported()` requests an actual adapter rather than checking `navigator.gpu`
exists, which is what catches machines where WebGPU is present but blocklisted.
Keep one `SuperResSession` alive across a batch — it holds VRAM and takes ~21s
to compile shaders on first use, so rebuilding it per image is ruinous. Call
`dispose()` when the tool is closed.

`webgpu-bench.html` (dev only, not in the build) reports adapter info and
per-tile timings — worth running on any target device, since these numbers vary
a lot by GPU.

## Tests

Tiling is the seam-prone part, so `tileUpscale` takes the per-tile function as
an argument and is tested with a synthetic nearest-neighbour upscaler: tiled
output must equal whole-image output **pixel for pixel**, across five awkward
sizes, plus abort and progress behaviour. Verified end-to-end with the real
model too — the delta at the tile boundary (5.85) came in *below* the image's
own mean column delta (13.11), i.e. no detectable seam.

---

# 3. Classical vs. neural — measured together

Same method as above, but comparing both engines on one image: a deliberately
hostile 480×320 target (one-pixel hairlines, text, hard circular edges, smooth
gradients), halved to 240×160 and then enlarged 2× back to the original size.

| upscaler | PSNR | vs. browser default |
| --- | --- | --- |
| browser `drawImage` | 18.35 dB | baseline |
| bilinear | 18.76 dB | +0.41 dB |
| Mitchell | 18.95 dB | +0.60 dB |
| Catmull-Rom | 19.25 dB | +0.90 dB |
| Lanczos-3 | 19.66 dB | +1.31 dB |
| **RealPLKSR ×2 (neural)** | **21.15 dB** | **+2.80 dB** |

The model is worth its download: nearly 2 dB clear of the best classical filter,
which is the difference between "less blurry" and "reconstructed".

Note that Lanczos-3 beats Catmull-Rom here while the single-image table above
has it the other way round. That is content, not contradiction — this target is
full of one-pixel lines, which reward a wider, sharper kernel. Catmull-Rom stays
the default because it is the better all-rounder on photographic content and
costs about half as much.

## Caveat on the time estimate

`SECONDS_PER_MEGAPIXEL = 20.4` drives the "this will take about N seconds"
message. It has **not** been confirmed on real hardware: every measurement here
was taken in a backgrounded browser tab, where throughput is throttled and
small-image fixed costs dominate (0.038 MP took 3.4 s, which extrapolates to
roughly 87 s/MP — almost certainly a throttling artefact rather than the real
rate). Time a visible tab on a real GPU before trusting the figure shown to
users.
