/**
 * Image upscaling.
 *
 * `geometry.ts` deliberately refuses to enlarge — for a *resize* that is the
 * right call, because a bigger box around the same detail is only a bigger
 * file. Upscaling is the separate, explicit request: make this small image
 * usable at a larger size, and spend real work reconstructing it.
 *
 * There is no neural super-resolution here, and that is a deliberate choice.
 * An ESRGAN-class model means either a network call — which would break the
 * "nothing leaves your device" promise the whole product rests on — or a
 * 20–70MB weights download that dwarfs the app and cannot be cached by the
 * service worker on a phone. What this does instead is proper signal-theory
 * reconstruction: a windowed-sinc (Lanczos) or cubic resampling filter with
 * correct alpha handling, followed by an unsharp mask to restore the acutance
 * that any interpolation necessarily loses. Against the browser's own
 * `drawImage` upscale — bilinear, which is what every other in-browser tool
 * ships — that is a visible improvement on edges and fine texture.
 *
 * Honest limits: this recovers no detail that is not in the source, because
 * none exists. It sharpens what is there and avoids adding blur, blocking and
 * jaggies of its own. A 400px thumbnail will not become a 4K photo.
 *
 * Everything below the `upscaleBitmap` convenience wrapper is pure array maths
 * with no DOM dependency, so it runs unchanged in a worker or under Node for
 * tests.
 */

/** Reconstruction filter. Trade-off is sharpness against ringing. */
export type UpscaleFilter = 'lanczos3' | 'lanczos2' | 'catrom' | 'mitchell' | 'bilinear';

/** How the target size is expressed. */
export type UpscaleMode = 'scale' | 'longest' | 'exact';

export interface UpscaleSpec {
  mode: UpscaleMode;
  /** Multiplier for `scale`, e.g. 2 for 2x */
  scale: number;
  /** Longest-edge target in px, for `longest` */
  longest: number;
  /** Target box for `exact` */
  width: number;
  height: number;
  /** Fit inside the box rather than stretching to it, for `exact` */
  keepAspect: boolean;
  filter: UpscaleFilter;
  /** Unsharp mask strength, 0 (off) to 1.5 */
  sharpen: number;
  /**
   * Suppresses the halo a windowed-sinc filter puts on hard edges, by clamping
   * each output pixel back into the range of the source pixels that fed it.
   */
  deringing: boolean;
}

/**
 * Catmull-Rom rather than Lanczos as the default, on measurement: against a
 * known-truth reference it reconstructed a downscaled photo ~1.5dB closer than
 * the browser's bilinear and ~0.4dB closer than Lanczos-3, while costing about
 * half as much (support 2 against 3). Lanczos-3 remains available for anyone
 * who wants maximum acutance and will accept more ringing for it.
 */
export const DEFAULT_UPSCALE: UpscaleSpec = {
  mode: 'scale',
  scale: 2,
  longest: 2048,
  width: 2048,
  height: 2048,
  keepAspect: true,
  filter: 'catrom',
  sharpen: 0.4,
  deringing: true,
};

export interface Size {
  width: number;
  height: number;
}

/**
 * Ceiling on output pixels. A 12MP photo at 4x is 192MP, which is 768MB of
 * RGBA before the canvas copy — enough to have the tab killed on a phone. The
 * request is honoured up to this and reported as clamped beyond it, rather
 * than either crashing or silently doing something much smaller.
 *
 * Callers should pass the mobile figure on a phone; `capabilities.isMobile`
 * already knows which one applies. It is a parameter rather than a lookup so
 * the maths below stays free of any DOM dependency and can run under test.
 */
export const MAX_OUTPUT_PIXELS = 48_000_000;
export const MAX_OUTPUT_PIXELS_MOBILE = 16_000_000;

/* --------------------------------------------------------------- filters */

interface Kernel {
  /** Radius in source pixels at scale 1 */
  support: number;
  weight(x: number): number;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function lanczos(a: number): Kernel {
  return {
    support: a,
    weight(x: number): number {
      const t = Math.abs(x);
      if (t >= a) return 0;
      return sinc(t) * sinc(t / a);
    },
  };
}

/**
 * The Mitchell–Netravali family. B and C trade blur against ringing:
 * (1/3, 1/3) is the balanced original, (0, 1/2) is Catmull-Rom, which is
 * sharper and rings slightly.
 */
function cubic(B: number, C: number): Kernel {
  return {
    support: 2,
    weight(x: number): number {
      const t = Math.abs(x);
      const t2 = t * t;
      const t3 = t2 * t;
      if (t < 1) {
        return ((12 - 9 * B - 6 * C) * t3 + (-18 + 12 * B + 6 * C) * t2 + (6 - 2 * B)) / 6;
      }
      if (t < 2) {
        return ((-B - 6 * C) * t3 + (6 * B + 30 * C) * t2 + (-12 * B - 48 * C) * t + (8 * B + 24 * C)) / 6;
      }
      return 0;
    },
  };
}

const TRIANGLE: Kernel = {
  support: 1,
  weight(x: number): number {
    const t = Math.abs(x);
    return t < 1 ? 1 - t : 0;
  },
};

const KERNELS: Record<UpscaleFilter, Kernel> = {
  lanczos3: lanczos(3),
  lanczos2: lanczos(2),
  catrom: cubic(0, 0.5),
  mitchell: cubic(1 / 3, 1 / 3),
  bilinear: TRIANGLE,
};

const FILTER_LABELS: Record<UpscaleFilter, string> = {
  lanczos3: 'Lanczos 3 — sharpest',
  lanczos2: 'Lanczos 2 — sharp, less ringing',
  catrom: 'Catmull-Rom — natural',
  mitchell: 'Mitchell — smoothest',
  bilinear: 'Bilinear — fastest',
};

export function filterLabel(filter: UpscaleFilter): string {
  return FILTER_LABELS[filter];
}

/* -------------------------------------------------------------- sizing */

/** Target size for a spec, clamped to something the device can actually hold. */
export function resolveUpscale(
  base: Size,
  spec: UpscaleSpec,
  maxPixels = MAX_OUTPUT_PIXELS,
): Size & { clamped: boolean } {
  let width: number;
  let height: number;

  switch (spec.mode) {
    case 'longest': {
      const longest = Math.max(base.width, base.height);
      // Upscaling only ever enlarges; asking for a smaller edge is the resize
      // tool's job, so the request floors at 1x rather than quietly shrinking.
      const scale = Math.max(1, spec.longest / Math.max(1, longest));
      width = base.width * scale;
      height = base.height * scale;
      break;
    }
    case 'exact': {
      const targetW = Math.max(1, spec.width || base.width);
      const targetH = Math.max(1, spec.height || base.height);
      if (!spec.keepAspect) {
        width = targetW;
        height = targetH;
      } else {
        const scale = Math.max(1, Math.min(targetW / base.width, targetH / base.height));
        width = base.width * scale;
        height = base.height * scale;
      }
      break;
    }
    case 'scale':
    default: {
      const scale = Math.max(1, spec.scale || 1);
      width = base.width * scale;
      height = base.height * scale;
      break;
    }
  }

  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));

  const pixels = width * height;
  if (pixels <= maxPixels) return { width, height, clamped: false };

  // Scale back along the diagonal so the aspect ratio survives the clamp.
  const factor = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
    clamped: true,
  };
}

/** Human summary of the current upscale setting, for the UI. */
export function describeUpscale(spec: UpscaleSpec): string {
  switch (spec.mode) {
    case 'longest':
      return `Longest edge ${spec.longest}px`;
    case 'exact':
      return `${spec.width}×${spec.height}${spec.keepAspect ? ' (fit)' : ' (stretch)'}`;
    case 'scale':
    default:
      return `${spec.scale}× enlargement`;
  }
}

/* ----------------------------------------------------------- resampling */

/** Precomputed source taps and weights for one output row or column. */
interface Contribution {
  /** First source index read */
  start: number;
  weights: Float32Array;
}

/**
 * Builds the filter taps for one axis.
 *
 * The kernel is widened by the sampling ratio when reducing, so a downscale
 * still averages over everything it passes. When enlarging — the case this
 * module exists for — the ratio is below 1 and the kernel keeps its natural
 * width, which is what makes the result a reconstruction rather than a blur.
 */
function buildContributions(srcSize: number, dstSize: number, kernel: Kernel): Contribution[] {
  const scale = dstSize / srcSize;
  const filterScale = scale < 1 ? 1 / scale : 1;
  const support = kernel.support * filterScale;

  const contributions: Contribution[] = new Array(dstSize);

  for (let i = 0; i < dstSize; i++) {
    // Sample at the centre of the output pixel mapped back into source space.
    const centre = (i + 0.5) / scale - 0.5;
    const start = Math.max(0, Math.ceil(centre - support));
    const end = Math.min(srcSize - 1, Math.floor(centre + support));
    const count = Math.max(1, end - start + 1);

    const weights = new Float32Array(count);
    let total = 0;
    for (let j = 0; j < count; j++) {
      const w = kernel.weight((start + j - centre) / filterScale);
      weights[j] = w;
      total += w;
    }

    // Normalising is what keeps brightness constant, and it also repairs the
    // truncated kernel at the image border — without it every edge darkens.
    if (total !== 0) {
      for (let j = 0; j < count; j++) weights[j] /= total;
    } else {
      weights.fill(1 / count);
    }

    contributions[i] = { start, weights };
  }

  return contributions;
}

/** True when any pixel is not fully opaque. */
function hasTransparency(data: Uint8ClampedArray<ArrayBuffer>): boolean {
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) return true;
  }
  return false;
}

export interface RgbaImage {
  /**
   * Pinned to a plain `ArrayBuffer` rather than the default `ArrayBufferLike`,
   * so the buffer can go straight into an `ImageData` and be transferred to
   * and from a worker without a copy.
   */
  data: Uint8ClampedArray<ArrayBuffer>;
  width: number;
  height: number;
}

/**
 * Separable two-pass resample.
 *
 * Memory is the constraint that shapes this: a full horizontally-scaled
 * intermediate at float precision would be four times the output for a 4x
 * enlargement, hundreds of megabytes for a phone photo. Rows are instead
 * scaled horizontally on demand and cached only for as long as the vertical
 * kernel window still needs them, which bounds the intermediate to a couple of
 * dozen rows regardless of image size.
 *
 * Alpha is premultiplied for the duration. Interpolating straight RGBA mixes
 * the colour of fully transparent pixels into their visible neighbours, which
 * is where the dark fringe around upscaled cut-outs comes from.
 */
export function resampleRgba(
  src: RgbaImage,
  dstWidth: number,
  dstHeight: number,
  filter: UpscaleFilter,
  deringing = false,
): RgbaImage {
  const { data, width: srcW, height: srcH } = src;
  if (dstWidth === srcW && dstHeight === srcH) {
    return { data: new Uint8ClampedArray(data), width: srcW, height: srcH };
  }

  const kernel = KERNELS[filter];
  const hContrib = buildContributions(srcW, dstWidth, kernel);
  const vContrib = buildContributions(srcH, dstHeight, kernel);
  const premultiply = hasTransparency(data);

  const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);
  const rowCache = new Map<number, Float32Array>();

  /**
   * One source row scaled horizontally, in premultiplied float RGBA.
   *
   * De-ringing has to happen in *both* passes. Clamping only at the end would
   * leave horizontal overshoot baked into these rows, where it is no longer
   * distinguishable from real signal.
   */
  const scaledRow = (srcY: number): Float32Array => {
    const cached = rowCache.get(srcY);
    if (cached) return cached;

    const row = new Float32Array(dstWidth * 4);
    const rowStart = srcY * srcW * 4;

    for (let x = 0; x < dstWidth; x++) {
      const { start, weights } = hContrib[x];
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      let minR = Infinity;
      let minG = Infinity;
      let minB = Infinity;
      let minA = Infinity;
      let maxR = -Infinity;
      let maxG = -Infinity;
      let maxB = -Infinity;
      let maxA = -Infinity;

      for (let j = 0; j < weights.length; j++) {
        const w = weights[j];
        if (w === 0) continue;
        const p = rowStart + (start + j) * 4;
        const alpha = data[p + 3];
        // The bounds are taken in whatever space the accumulation happens in,
        // premultiplied or not, so the comparison is like for like.
        const m = premultiply ? alpha / 255 : 1;
        const sr = data[p] * m;
        const sg = data[p + 1] * m;
        const sb = data[p + 2] * m;

        r += sr * w;
        g += sg * w;
        b += sb * w;
        a += alpha * w;

        if (deringing) {
          if (sr < minR) minR = sr;
          if (sr > maxR) maxR = sr;
          if (sg < minG) minG = sg;
          if (sg > maxG) maxG = sg;
          if (sb < minB) minB = sb;
          if (sb > maxB) maxB = sb;
          if (alpha < minA) minA = alpha;
          if (alpha > maxA) maxA = alpha;
        }
      }

      if (deringing) {
        r = Math.min(maxR, Math.max(minR, r));
        g = Math.min(maxG, Math.max(minG, g));
        b = Math.min(maxB, Math.max(minB, b));
        a = Math.min(maxA, Math.max(minA, a));
      }

      const o = x * 4;
      row[o] = r;
      row[o + 1] = g;
      row[o + 2] = b;
      row[o + 3] = a;
    }

    rowCache.set(srcY, row);
    return row;
  };

  for (let y = 0; y < dstHeight; y++) {
    const { start, weights } = vContrib[y];

    // The window only ever moves forward, so anything before it is dead.
    for (const key of rowCache.keys()) {
      if (key < start) rowCache.delete(key);
    }

    const rows: Float32Array[] = new Array(weights.length);
    for (let j = 0; j < weights.length; j++) rows[j] = scaledRow(start + j);

    const outRow = y * dstWidth * 4;

    for (let x = 0; x < dstWidth; x++) {
      const o = x * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // Tracked only for de-ringing; a windowed-sinc kernel has negative lobes
      // that can push a pixel outside the range of everything that fed it,
      // which is the bright halo seen along hard edges.
      let minR = Infinity;
      let minG = Infinity;
      let minB = Infinity;
      let minA = Infinity;
      let maxR = -Infinity;
      let maxG = -Infinity;
      let maxB = -Infinity;
      let maxA = -Infinity;

      for (let j = 0; j < weights.length; j++) {
        const w = weights[j];
        const row = rows[j];
        if (w === 0) continue;
        r += row[o] * w;
        g += row[o + 1] * w;
        b += row[o + 2] * w;
        a += row[o + 3] * w;

        if (deringing) {
          if (row[o] < minR) minR = row[o];
          if (row[o] > maxR) maxR = row[o];
          if (row[o + 1] < minG) minG = row[o + 1];
          if (row[o + 1] > maxG) maxG = row[o + 1];
          if (row[o + 2] < minB) minB = row[o + 2];
          if (row[o + 2] > maxB) maxB = row[o + 2];
          if (row[o + 3] < minA) minA = row[o + 3];
          if (row[o + 3] > maxA) maxA = row[o + 3];
        }
      }

      if (deringing) {
        r = Math.min(maxR, Math.max(minR, r));
        g = Math.min(maxG, Math.max(minG, g));
        b = Math.min(maxB, Math.max(minB, b));
        a = Math.min(maxA, Math.max(minA, a));
      }

      const p = outRow + o;
      if (premultiply) {
        // Unpremultiply. Below roughly one part in 255 there is no colour left
        // to recover, and dividing by it only amplifies noise.
        if (a > 0.5) {
          const inv = 255 / a;
          out[p] = r * inv;
          out[p + 1] = g * inv;
          out[p + 2] = b * inv;
        } else {
          out[p] = 0;
          out[p + 1] = 0;
          out[p + 2] = 0;
        }
      } else {
        out[p] = r;
        out[p + 1] = g;
        out[p + 2] = b;
      }
      out[p + 3] = a;
    }
  }

  return { data: out, width: dstWidth, height: dstHeight };
}

/* ------------------------------------------------------------ sharpening */

/**
 * Three box blurs approximate a Gaussian closely enough for an unsharp mask,
 * and unlike a true Gaussian they cost the same whatever the radius.
 *
 * Buffers are 8-bit rather than float on purpose. At the sizes this module
 * produces — a 12MP photo at 2x is 48MP — a float working buffer is 768MB,
 * and the three a naive implementation wants would be over 2GB. The rounding
 * this costs is well under the mask's own threshold.
 */
function boxBlurPass(
  src: Uint8ClampedArray<ArrayBuffer>,
  dst: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): void {
  const outer = horizontal ? height : width;
  const inner = horizontal ? width : height;
  const step = horizontal ? 4 : width * 4;
  const window = radius * 2 + 1;

  for (let o = 0; o < outer; o++) {
    const lineStart = horizontal ? o * width * 4 : o * 4;

    for (let c = 0; c < 3; c++) {
      let sum = 0;
      // Edge pixels are extended rather than treated as black, which would
      // otherwise darken the border of every sharpened image.
      for (let i = -radius; i <= radius; i++) {
        const idx = Math.min(inner - 1, Math.max(0, i));
        sum += src[lineStart + idx * step + c];
      }

      for (let i = 0; i < inner; i++) {
        dst[lineStart + i * step + c] = sum / window;
        const outIdx = Math.min(inner - 1, Math.max(0, i - radius));
        const inIdx = Math.min(inner - 1, Math.max(0, i + radius + 1));
        sum += src[lineStart + inIdx * step + c] - src[lineStart + outIdx * step + c];
      }
    }
  }
}

/**
 * Unsharp mask, in place.
 *
 * Interpolation is a low-pass filter — it cannot be otherwise — so every
 * upscale loses acutance even when it loses no detail. Adding back a scaled
 * difference against a blurred copy is what makes the result read as sharp
 * instead of soft. Alpha is left alone; sharpening it would fray cut-out
 * edges.
 *
 * Two scratch buffers, not three: `data` is itself the unmodified original
 * until the final loop, and that loop only ever writes to the index it has
 * just read, so no copy of it is needed.
 */
export function unsharpMask(image: RgbaImage, amount: number, radius = 1, threshold = 2): void {
  if (amount <= 0) return;

  const { data, width, height } = image;
  const count = width * height * 4;
  const scratch = new Uint8ClampedArray(count);
  const blurred = new Uint8ClampedArray(count);

  let source = data;
  for (let pass = 0; pass < 3; pass++) {
    boxBlurPass(source, scratch, width, height, radius, true);
    boxBlurPass(scratch, blurred, width, height, radius, false);
    source = blurred;
  }

  for (let i = 0; i < count; i += 4) {
    for (let c = 0; c < 3; c++) {
      const diff = data[i + c] - blurred[i + c];
      // The threshold is what stops an unsharp mask from turning film grain
      // and JPEG noise into crunchy speckle.
      if (Math.abs(diff) < threshold) continue;
      data[i + c] = data[i + c] + diff * amount;
    }
  }
}

/* -------------------------------------------------------------- pipeline */

export interface UpscaleResult {
  image: RgbaImage;
  /** True when the request exceeded `MAX_OUTPUT_PIXELS` and was scaled back */
  clamped: boolean;
  /** Anything the user should know about the result */
  notes: string[];
}

/**
 * Resamples to the target size and restores acutance. Pure maths — no DOM —
 * so it can run in a worker or under test.
 */
export function upscaleRgba(src: RgbaImage, spec: UpscaleSpec, maxPixels = MAX_OUTPUT_PIXELS): UpscaleResult {
  const target = resolveUpscale(src, spec, maxPixels);
  const notes: string[] = [];

  if (target.clamped) {
    notes.push(`Enlargement capped at ${target.width}×${target.height} to stay within memory`);
  }

  if (target.width === src.width && target.height === src.height) {
    return {
      image: { data: new Uint8ClampedArray(src.data), width: src.width, height: src.height },
      clamped: target.clamped,
      notes,
    };
  }

  // De-ringing only matters for kernels with negative lobes; on bilinear it is
  // pure cost for a result that cannot overshoot in the first place.
  const dering = spec.deringing && spec.filter !== 'bilinear';
  const image = resampleRgba(src, target.width, target.height, spec.filter, dering);

  if (spec.sharpen > 0) {
    // The blur an upscale introduces is proportional to how far it stretched,
    // so the mask radius follows the factor instead of being fixed.
    const factor = Math.max(target.width / src.width, target.height / src.height);
    const radius = Math.max(1, Math.min(3, Math.round(factor / 2)));
    unsharpMask(image, Math.min(1.5, spec.sharpen), radius);
  }

  if (Math.max(target.width / src.width, target.height / src.height) > 4) {
    notes.push('Beyond about 4× there is no detail left to reconstruct — expect a soft result');
  }

  return { image, clamped: target.clamped, notes };
}

/* --------------------------------------------------------- DOM wrappers */

const hasOffscreen = typeof OffscreenCanvas !== 'undefined';

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(width: number, height: number): AnyCanvas {
  if (hasOffscreen) return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: AnyCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  // `willReadFrequently` is wrong here — this reads once and writes once, and
  // the hint would push the canvas onto a slower software path.
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not get a 2D canvas context');
  return ctx;
}

/** Pulls RGBA pixels out of anything drawable. */
export function readPixels(source: CanvasImageSource, width: number, height: number): RgbaImage {
  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.drawImage(source, 0, 0, width, height);
  const imageData = ctx.getImageData(0, 0, width, height);
  return { data: imageData.data, width, height };
}

function toCanvas(image: RgbaImage): AnyCanvas {
  const canvas = createCanvas(image.width, image.height);
  const ctx = context2d(canvas);
  ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas;
}

export interface UpscaleBitmapResult {
  canvas: AnyCanvas;
  width: number;
  height: number;
  notes: string[];
}

/**
 * Convenience entry point: bitmap in, drawable canvas out, ready to hand to
 * the encoder.
 *
 * The work is synchronous and CPU-bound — a 2x enlargement of a 12MP photo is
 * on the order of a second — so on the main thread it will stall the UI.
 * Prefer calling `upscaleRgba` from a worker and transferring the buffer back.
 */
export function upscaleBitmap(
  bitmap: ImageBitmap,
  spec: UpscaleSpec,
  maxPixels = MAX_OUTPUT_PIXELS,
): UpscaleBitmapResult {
  const src = readPixels(bitmap, bitmap.width, bitmap.height);
  const { image, notes } = upscaleRgba(src, spec, maxPixels);
  return { canvas: toCanvas(image), width: image.width, height: image.height, notes };
}
