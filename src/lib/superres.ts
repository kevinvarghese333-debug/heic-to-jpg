/**
 * Neural super-resolution, in the browser, on the visitor's own GPU.
 *
 * This is the AI half of upscaling; `upscale.ts` is the classical half. The
 * model runs through ONNX Runtime Web on the WebGPU backend, which means the
 * photo still never leaves the device — the only thing that travels is the
 * model file, in the other direction, once, and then it is cached.
 *
 * Why WebGPU and not a server: a GPU box costs real money per image and makes
 * you the custodian of other people's photos. Here the visitor's own hardware
 * does the work, so the marginal cost is zero and the privacy claim in the
 * README survives intact.
 *
 * What it costs instead: ~5MB gzipped for the ONNX runtime plus the model
 * itself, and a hard dependency on WebGPU, which is solid on current
 * Chrome/Edge and patchier elsewhere. `isSupported()` gates the whole thing,
 * and `upscale.ts` is the fallback when the answer is no — a worse result, but
 * never a broken one.
 *
 * On quality: measured against a known original, RealPLKSR reconstructed a
 * downscaled photo ~5.7dB closer than the browser's bilinear and ~3.9dB closer
 * than the classical path. That is a visible difference on texture, not a
 * statistical one. Note that a *higher* score does not always mean a better
 * picture — a lighter model tested here scored above the classical path while
 * visibly erasing wall texture into plastic smoothness. Models are chosen by
 * looking at output, with the metric as a sanity check.
 */

import {
  MAX_OUTPUT_PIXELS,
  resampleRgba,
  resolveUpscale,
  unsharpMask,
  type RgbaImage,
  type UpscaleSpec,
} from './upscale';

export interface SuperResModel {
  /** Display name for the UI */
  name: string;
  /** Where the weights live. Same-origin by default so the CSP stays tight. */
  url: string;
  /** Fixed enlargement the network performs */
  scale: number;
  /**
   * Input tile edge in pixels. Some exports fix this in the graph, in which
   * case it must be matched exactly; dynamic exports can take any size and
   * this is just the chunk we choose.
   */
  tile: number;
  /** True when the graph's input dimensions are fixed rather than dynamic */
  fixedShape: boolean;
  /** Approximate download, for telling the user before they commit to it */
  bytes: number;
  license: string;
}

/**
 * RealPLKSR from the darktable project: MIT, and the best reconstruction of
 * the candidates actually tested rather than the best-reviewed on paper.
 *
 * The 1.8MB alternative that was also measured is not offered. It is much
 * lighter and scored well, but it achieves that partly by smoothing fine
 * texture away, which is the wrong trade for a photo tool.
 */
export const MODELS: Record<string, SuperResModel> = {
  'realplksr-x2': {
    name: 'RealPLKSR 2×',
    url: `${import.meta.env.BASE_URL}models/realplksr_x2.onnx`,
    scale: 2,
    tile: 512,
    fixedShape: true,
    bytes: 28_300_000,
    license: 'MIT (darktable-org)',
  },
};

export const DEFAULT_MODEL_ID = 'realplksr-x2';

/**
 * Measured cost, in seconds per megapixel of *input*, on an Apple M-series GPU
 * through WebGPU: 5.35s for one 512×512 tile.
 *
 * This is the number that decides how the tool is presented. It is roughly 5×
 * faster than the same model on CPU, which is a far smaller win than "GPU" is
 * usually worth — the model is simply heavy. Slower hardware will be worse.
 */
export const SECONDS_PER_MEGAPIXEL = 20.4;

/**
 * Largest input the neural path will accept.
 *
 * At the measured rate a 12MP photo is about four minutes, which is not a
 * thing to put behind a button. The cap is not really a limitation: enlarging
 * exists for images that are *small*, and a 12MP photo does not need it. Above
 * this the classical path is both the sensible answer and the fast one.
 */
export const MAX_AI_INPUT_PIXELS = 2_000_000;

/** Rough wall-clock estimate, so the UI can warn before starting. */
export function estimateSeconds(inputPixels: number, passes = 1): number {
  return (inputPixels / 1_000_000) * SECONDS_PER_MEGAPIXEL * passes;
}

/**
 * Where the ONNX runtime's own wasm binaries are served from.
 *
 * They are not bundled — they are ~26MB and must stay separate files so the
 * browser can cache them independently of the app. Anything serving this app
 * has to copy them out of `node_modules/onnxruntime-web/dist` to this path.
 */
let runtimeDir = `${import.meta.env.BASE_URL}ort/`;

export function setRuntimePath(path: string): void {
  runtimeDir = path;
}

/**
 * Pixels either side of a tile that are computed and then thrown away.
 *
 * A convolutional network has no data beyond its input, so it invents an edge
 * where the tile ends. Cutting that margin off every tile and overlapping the
 * neighbours means every kept pixel had real context on all sides, which is
 * what stops visible seams on a tile grid.
 */
const TILE_OVERLAP = 24;

export interface SuperResProgress {
  /** Tiles finished */
  done: number;
  total: number;
  /** 0–1 over the whole job, including the model download */
  fraction: number;
  stage: 'downloading' | 'warming' | 'upscaling';
}

interface WebGpuNavigator extends Navigator {
  gpu?: { requestAdapter(): Promise<unknown> };
}

/**
 * Whether this browser can actually run the model.
 *
 * `navigator.gpu` existing is not enough — asking for an adapter is what
 * catches the machines where WebGPU is present but disabled, blocklisted, or
 * has no usable device behind it.
 */
export async function isSupported(): Promise<boolean> {
  const gpu = (navigator as WebGpuNavigator).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ conversion */

/** RGBA bytes to the planar NCHW float the network expects, 0–1. */
function toTensorData(img: RgbaImage): Float32Array {
  const { data, width, height } = img;
  const plane = width * height;
  const out = new Float32Array(plane * 3);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    out[p] = data[i] / 255;
    out[plane + p] = data[i + 1] / 255;
    out[plane * 2 + p] = data[i + 2] / 255;
  }
  return out;
}

/** Planar NCHW float back to RGBA bytes, opaque. */
function fromTensorData(t: Float32Array, width: number, height: number): RgbaImage {
  const plane = width * height;
  const data = new Uint8ClampedArray(plane * 4);
  for (let p = 0, i = 0; p < plane; p++, i += 4) {
    // Networks routinely return values slightly outside 0–1; Uint8ClampedArray
    // pins them for us rather than wrapping.
    data[i] = t[p] * 255;
    data[i + 1] = t[plane + p] * 255;
    data[i + 2] = t[plane * 2 + p] * 255;
    data[i + 3] = 255;
  }
  return { data, width, height };
}

/**
 * Copies a tile out of the source, clamping reads at the edges.
 *
 * Edge clamping rather than zero-padding matters: black padding would make the
 * network treat the image border as a hard edge against darkness and sharpen a
 * frame onto every result.
 */
function extractTile(src: RgbaImage, ox: number, oy: number, size: number): RgbaImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, oy + y));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, ox + x));
      const sp = (sy * src.width + sx) * 4;
      const dp = (y * size + x) * 4;
      data[dp] = src.data[sp];
      data[dp + 1] = src.data[sp + 1];
      data[dp + 2] = src.data[sp + 2];
      data[dp + 3] = src.data[sp + 3];
    }
  }
  return { data, width: size, height: size };
}

/** Writes the trustworthy middle of an upscaled tile into the output. */
function blitCore(
  dst: RgbaImage,
  tile: RgbaImage,
  marginPx: number,
  dstX: number,
  dstY: number,
  coreW: number,
  coreH: number,
): void {
  for (let y = 0; y < coreH; y++) {
    const ty = marginPx + y;
    const dy = dstY + y;
    if (dy < 0 || dy >= dst.height || ty >= tile.height) continue;
    for (let x = 0; x < coreW; x++) {
      const tx = marginPx + x;
      const dx = dstX + x;
      if (dx < 0 || dx >= dst.width || tx >= tile.width) continue;
      const sp = (ty * tile.width + tx) * 4;
      const dp = (dy * dst.width + dx) * 4;
      dst.data[dp] = tile.data[sp];
      dst.data[dp + 1] = tile.data[sp + 1];
      dst.data[dp + 2] = tile.data[sp + 2];
      dst.data[dp + 3] = 255;
    }
  }
}

/**
 * Runs a whole image through a tile-at-a-time upscaler.
 *
 * Work is tiled regardless of image size: a 12MP photo as one tensor is far
 * beyond any browser GPU's allocation limit, and a fixed-shape export cannot
 * accept it anyway. Between tiles control returns to the event loop so the page
 * keeps responding and a cancel can actually land.
 *
 * `runTile` is injected rather than called directly so this can be exercised
 * with a plain synthetic upscaler in tests — tiling bugs show up as seams,
 * which no type checker will catch.
 */
export async function tileUpscale(
  src: RgbaImage,
  scale: number,
  tile: number,
  runTile: (patch: RgbaImage) => Promise<RgbaImage>,
  onProgress?: (p: SuperResProgress) => void,
  signal?: AbortSignal,
): Promise<RgbaImage> {
  const stride = tile - TILE_OVERLAP * 2;
  if (stride <= 0) throw new Error('Tile size is too small for the overlap');

  const outWidth = src.width * scale;
  const outHeight = src.height * scale;
  const out: RgbaImage = {
    data: new Uint8ClampedArray(outWidth * outHeight * 4),
    width: outWidth,
    height: outHeight,
  };

  const cols = Math.ceil(src.width / stride);
  const rows = Math.ceil(src.height / stride);
  const total = cols * rows;
  let done = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (signal?.aborted) throw new Error('Cancelled');

      const coreX = col * stride;
      const coreY = row * stride;
      const patch = extractTile(src, coreX - TILE_OVERLAP, coreY - TILE_OVERLAP, tile);
      const upscaled = await runTile(patch);

      blitCore(
        out,
        upscaled,
        TILE_OVERLAP * scale,
        coreX * scale,
        coreY * scale,
        Math.min(stride, src.width - coreX) * scale,
        Math.min(stride, src.height - coreY) * scale,
      );

      done++;
      onProgress?.({ done, total, fraction: done / total, stage: 'upscaling' });
      // Yielding keeps the tab interactive between tiles.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return out;
}

/* --------------------------------------------------------------- session */

/**
 * Types only — the runtime itself is loaded from a URL at the bottom of this
 * file, never imported as a module. `typeof import(...)` in a type position
 * emits no code, so the bundler never sees a dependency here.
 */
type OrtModule = typeof import('onnxruntime-web/webgpu');
type OrtSession = Awaited<ReturnType<OrtModule['InferenceSession']['create']>>;

/**
 * Holds a loaded model.
 *
 * Kept as a class because the session is expensive to build — tens of
 * megabytes parsed and shader pipelines compiled — and must be reused across
 * every tile and every image in a batch, not rebuilt per call.
 */
export class SuperResSession {
  private ort: OrtModule | null = null;
  private session: OrtSession | null = null;
  private loading: Promise<void> | null = null;

  constructor(readonly model: SuperResModel) {}

  get ready(): boolean {
    return this.session !== null;
  }

  /**
   * Downloads the weights and builds the session. Safe to call repeatedly;
   * concurrent callers share the one in-flight load rather than each starting
   * their own multi-megabyte download.
   */
  async load(onProgress?: (p: SuperResProgress) => void): Promise<void> {
    if (this.session) return;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      onProgress?.({ done: 0, total: 1, fraction: 0, stage: 'downloading' });

      // Loaded by URL rather than by package specifier, quite deliberately.
      // Importing the package makes the bundler inline a ~24MB wasm into the
      // build *as well as* the copy served from `public/`, paying for the
      // runtime twice. A URL import keeps it a plain static asset that the
      // browser caches on its own, and keeps it out of the app bundle entirely
      // for the visitors who never open this tool.
      const ort = (await import(/* @vite-ignore */ `${runtimeDir}ort.webgpu.bundle.min.mjs`)) as OrtModule;
      ort.env.wasm.wasmPaths = runtimeDir;
      // One thread: the GPU does the work, and spawning wasm workers here only
      // competes with the page for cores while needing cross-origin isolation.
      ort.env.wasm.numThreads = 1;
      this.ort = ort;

      const bytes = await this.fetchWeights(onProgress);

      onProgress?.({ done: 0, total: 1, fraction: 0.9, stage: 'warming' });
      this.session = await ort.InferenceSession.create(bytes, {
        executionProviders: ['webgpu'],
        graphOptimizationLevel: 'all',
      });
    })();

    try {
      await this.loading;
    } catch (error) {
      // A failed load must not poison the instance — the user may well retry,
      // and a stuck promise would make every later attempt fail instantly.
      this.loading = null;
      this.session = null;
      throw new Error(`Could not load the upscaling model: ${(error as Error).message}`);
    }
    this.loading = null;
  }

  /** Streams the weights so the UI can show real progress on a 28MB file. */
  private async fetchWeights(onProgress?: (p: SuperResProgress) => void): Promise<Uint8Array> {
    const response = await fetch(this.model.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const total = Number(response.headers.get('content-length')) || this.model.bytes;
    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array(await response.arrayBuffer());

    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.({
        done: 0,
        total: 1,
        // The download is most of the wait but not all of it, so it is scaled
        // into the first 90% rather than reaching 100% before work starts.
        fraction: Math.min(0.9, (received / total) * 0.9),
        stage: 'downloading',
      });
    }

    const out = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /** Runs one tile through the network. */
  private async runTile(tile: RgbaImage): Promise<RgbaImage> {
    const ort = this.ort;
    const session = this.session;
    if (!ort || !session) throw new Error('Model is not loaded');

    const input = new ort.Tensor('float32', toTensorData(tile), [1, 3, tile.height, tile.width]);
    const feeds: Record<string, typeof input> = { [session.inputNames[0]]: input };
    const output = await session.run(feeds);
    const result = output[session.outputNames[0]];
    const [, , h, w] = result.dims as number[];
    return fromTensorData(result.data as Float32Array, w, h);
  }

  /**
   * Enlarges an image by the model's native factor.
   *
   * The tiling itself lives in `tileUpscale` so it can be tested without a GPU
   * or a model — seams are the classic failure here, and a bug in the offsets
   * is invisible until someone looks at a large photo.
   */
  async upscale(
    src: RgbaImage,
    onProgress?: (p: SuperResProgress) => void,
    signal?: AbortSignal,
  ): Promise<RgbaImage> {
    if (!this.session) await this.load(onProgress);
    return tileUpscale(src, this.model.scale, this.model.tile, (tile) => this.runTile(tile), onProgress, signal);
  }

  /** Frees GPU memory. The session holds real VRAM, so this matters. */
  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = null;
    this.ort = null;
  }
}

/* -------------------------------------------------------------- pipeline */

export interface SuperResResult {
  image: RgbaImage;
  notes: string[];
}

/**
 * Full path: neural enlargement to the model's native factor, then the
 * classical resampler to land on exactly the size the user asked for.
 *
 * The two-step exists because the network only knows one factor. Asking for 3×
 * from a 2× model means running it once and resampling up, and asking for 2×
 * from a 4× model means running it and resampling down — the latter being much
 * the better direction, since it discards information rather than inventing it.
 *
 * Alpha is deliberately not fed to the network. These models are trained on
 * three-channel photographs and have no notion of transparency; the channel is
 * carried across with the classical resampler, which handles it correctly.
 */
export async function superResolve(
  src: RgbaImage,
  spec: UpscaleSpec,
  session: SuperResSession,
  onProgress?: (p: SuperResProgress) => void,
  signal?: AbortSignal,
  maxPixels = MAX_OUTPUT_PIXELS,
): Promise<SuperResResult> {
  const target = resolveUpscale(src, spec, maxPixels);
  const notes: string[] = [];
  if (target.clamped) {
    notes.push(`Enlargement capped at ${target.width}×${target.height} to stay within memory`);
  }

  const inputPixels = src.width * src.height;
  if (inputPixels > MAX_AI_INPUT_PIXELS) {
    throw new Error(
      `Image is too large for AI upscaling (${(inputPixels / 1e6).toFixed(1)}MP; limit ${
        MAX_AI_INPUT_PIXELS / 1e6
      }MP). Use the standard upscaler instead.`,
    );
  }

  const factor = Math.max(target.width / src.width, target.height / src.height);
  if (factor <= 1) {
    return { image: { ...src, data: new Uint8ClampedArray(src.data) }, notes };
  }

  // Running the network on more pixels than the target needs is wasted GPU
  // time, and it is the slowest part of the job by a wide margin.
  const passes = Math.max(1, Math.ceil(Math.log(factor) / Math.log(session.model.scale)));
  if (passes > 1) {
    // Each pass runs on the previous pass's output, so the cost multiplies by
    // the model's scale squared — worth saying out loud before it starts.
    const seconds = estimateSeconds(inputPixels, (session.model.scale ** (2 * passes) - 1) / (session.model.scale ** 2 - 1));
    notes.push(`Running the model ${passes}× to reach ${Math.round(factor)}× — roughly ${Math.round(seconds)}s`);
  }

  let current = src;
  for (let pass = 0; pass < passes; pass++) {
    current = await session.upscale(current, onProgress, signal);
  }

  // Land on the exact requested size. Almost always a small reduction from the
  // model's native factor, which costs nothing in quality.
  if (current.width !== target.width || current.height !== target.height) {
    current = resampleRgba(current, target.width, target.height, spec.filter, spec.deringing);
  }

  // Restore the source's alpha, which never went near the network.
  if (src.data.some((v, i) => i % 4 === 3 && v !== 255)) {
    const alpha = resampleRgba(src, target.width, target.height, spec.filter, false);
    for (let i = 3; i < current.data.length; i += 4) current.data[i] = alpha.data[i];
    notes.push('Transparency was resized separately — the model itself is RGB-only');
  }

  // These models already produce a sharp result; the classical unsharp pass on
  // top of that would be over-sharpening, so it is applied only if asked for.
  if (spec.sharpen > 0.6) unsharpMask(current, spec.sharpen - 0.6, 1);

  return { image: current, notes };
}
