import type { OutputFormat } from './capabilities';
import { applyOutputCorrections, fitExifToSegment, type ExifData } from './exif';
import { baseSize, resolveResize, sourceRect } from './geometry';
import { buildExifSegment, buildIccSegments, buildXmpSegment, insertJpegSegments } from './jpegSegments';
import { addPngMetadata } from './pngChunks';
import type { CropRect, ResizeSpec } from '../types';

export interface MetadataPayload {
  /** Parsed EXIF model, already filtered to whatever the user chose to keep */
  exif: ExifData | null;
  icc: Uint8Array | null;
  xmp: Uint8Array | null;
}

export interface EncodeOptions {
  format: OutputFormat;
  /** 0.3–1.0; ignored by PNG, which is lossless */
  quality: number;
  resize: ResizeSpec;
  /** Normalised crop, applied before rotation */
  crop: CropRect | null;
  /** Clockwise rotation in degrees */
  rotate: 0 | 90 | 180 | 270;
  flipHorizontal: boolean;
  /** Desired maximum output size in bytes; 0 disables the search */
  targetBytes: number;
  metadata: MetadataPayload;
}

export interface EncodeResult {
  blob: Blob;
  width: number;
  height: number;
  /** The quality actually used, which differs from the request under a size target */
  qualityUsed: number;
  /** Anything the user should know, e.g. metadata that could not be carried */
  notes: string[];
}

const LOSSY_FORMATS = new Set<OutputFormat>(['image/jpeg', 'image/webp', 'image/avif']);

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
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Could not get a 2D canvas context');
  return ctx;
}

function toBlob(canvas: AnyCanvas, format: OutputFormat, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: format, quality });
  }
  return new Promise((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Image encoding failed'))),
      format,
      quality,
    );
  });
}

/**
 * Draws `source` at the target size. Browsers alias badly when downscaling by
 * more than 2x in a single drawImage, so large reductions are done as repeated
 * halvings first.
 */
function drawScaled(source: CanvasImageSource, sw: number, sh: number, dw: number, dh: number): AnyCanvas {
  let currentSource = source;
  let currentW = sw;
  let currentH = sh;

  while (currentW / 2 > dw && currentH / 2 > dh) {
    const halfW = Math.max(dw, Math.round(currentW / 2));
    const halfH = Math.max(dh, Math.round(currentH / 2));
    const step = createCanvas(halfW, halfH);
    const stepCtx = context2d(step);
    stepCtx.imageSmoothingEnabled = true;
    stepCtx.imageSmoothingQuality = 'high';
    stepCtx.drawImage(currentSource, 0, 0, halfW, halfH);
    currentSource = step as CanvasImageSource;
    currentW = halfW;
    currentH = halfH;
  }

  const canvas = createCanvas(dw, dh);
  const ctx = context2d(canvas);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(currentSource, 0, 0, dw, dh);
  return canvas;
}

/** JPEG has no alpha channel, so transparency is flattened onto white. */
function flattenOntoWhite(canvas: AnyCanvas): AnyCanvas {
  const flattened = createCanvas(canvas.width, canvas.height);
  const ctx = context2d(flattened);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(canvas as CanvasImageSource, 0, 0);
  return flattened;
}

function targetDimensions(bitmap: ImageBitmap, options: EncodeOptions, extraScale = 1): { width: number; height: number } {
  const base = baseSize(bitmap, options.crop, options.rotate);
  return resolveResize(base, options.resize, extraScale);
}

/**
 * Applies crop, rotation and flip, returning something drawable at the
 * post-transform size. When nothing is transformed the bitmap is handed back
 * untouched so the common path costs nothing.
 */
function renderSource(
  bitmap: ImageBitmap,
  options: EncodeOptions,
): { source: CanvasImageSource; width: number; height: number } {
  const { sx, sy, sw, sh } = sourceRect(bitmap, options.crop);
  const untouched =
    options.rotate === 0 &&
    !options.flipHorizontal &&
    sx === 0 &&
    sy === 0 &&
    sw === bitmap.width &&
    sh === bitmap.height;

  if (untouched) return { source: bitmap, width: bitmap.width, height: bitmap.height };

  const swapped = options.rotate === 90 || options.rotate === 270;
  const width = swapped ? sh : sw;
  const height = swapped ? sw : sh;

  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((options.rotate * Math.PI) / 180);
  if (options.flipHorizontal) ctx.scale(-1, 1);
  ctx.drawImage(bitmap, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
  ctx.restore();

  return { source: canvas as CanvasImageSource, width, height };
}

/** Builds the metadata bytes and reports how much space they will take. */
function prepareMetadata(
  options: EncodeOptions,
  width: number,
  height: number,
): { attach: (bytes: Uint8Array) => Uint8Array; overhead: number; notes: string[] } {
  const notes: string[] = [];
  const { format, metadata } = options;

  const supportsMetadata = format === 'image/jpeg' || format === 'image/png';
  if (!supportsMetadata) {
    if (metadata.exif || metadata.icc || metadata.xmp) {
      notes.push(`Metadata is not carried into ${format === 'image/webp' ? 'WebP' : 'AVIF'}`);
    }
    return { attach: (bytes) => bytes, overhead: 0, notes };
  }

  let exifTiff: Uint8Array | null = null;
  if (metadata.exif) {
    // The model is cloned by serialisation, but corrections mutate it, so this
    // is done on the caller's copy deliberately — the values are output-specific
    // and recomputed on every encode anyway.
    applyOutputCorrections(metadata.exif, width, height);
    const fitted = fitExifToSegment(metadata.exif);
    exifTiff = fitted.tiff;
    if (fitted.droppedMakerNote) {
      notes.push('Oversized MakerNote removed so EXIF would fit');
    }
    if (!exifTiff) notes.push('EXIF too large to embed and was dropped');
  }

  if (format === 'image/png') {
    const icc = metadata.icc;
    const overhead = (exifTiff?.length ?? 0) + (icc ? icc.length : 0) + 64;
    return {
      attach: (bytes) => addPngMetadata(bytes, { icc, exif: exifTiff }),
      overhead,
      notes,
    };
  }

  const segments: Uint8Array[] = [];
  if (exifTiff) {
    const seg = buildExifSegment(exifTiff);
    if (seg) segments.push(seg);
  }
  if (metadata.icc) {
    const iccSegments = buildIccSegments(metadata.icc);
    if (iccSegments.length === 0) notes.push('ICC profile too large to embed');
    segments.push(...iccSegments);
  }
  if (metadata.xmp) {
    const seg = buildXmpSegment(metadata.xmp);
    if (seg) segments.push(seg);
    else notes.push('XMP packet too large to embed');
  }

  const overhead = segments.reduce((sum, seg) => sum + seg.length, 0);
  // Whatever we are supplying replaces the encoder's own version of it. In
  // particular the browser tags canvas JPEGs with an sRGB profile, which must
  // go when we attach the source's real profile.
  const replace = {
    exif: Boolean(exifTiff),
    icc: Boolean(metadata.icc),
    xmp: Boolean(metadata.xmp),
  };
  return { attach: (bytes) => insertJpegSegments(bytes, segments, replace), overhead, notes };
}

/**
 * Rasterises the bitmap at a given size, ready to be encoded repeatedly.
 *
 * Scaling is by far the expensive half of the work, so the size-target search
 * prepares a canvas once per dimension and then only re-runs the encoder.
 */
function prepareCanvas(bitmap: ImageBitmap, options: EncodeOptions, width: number, height: number): AnyCanvas {
  const rendered = renderSource(bitmap, options);
  const canvas = drawScaled(rendered.source, rendered.width, rendered.height, width, height);
  return options.format === 'image/jpeg' ? flattenOntoWhite(canvas) : canvas;
}

export async function encodeImage(bitmap: ImageBitmap, options: EncodeOptions): Promise<EncodeResult> {
  const { width, height } = targetDimensions(bitmap, options);
  const meta = prepareMetadata(options, width, height);
  const notes = [...meta.notes];

  const canTune = LOSSY_FORMATS.has(options.format);

  // Straight path: no size target, or a format whose quality knob does nothing.
  if (options.targetBytes <= 0 || !canTune) {
    const canvas = prepareCanvas(bitmap, options, width, height);
    const raw = await toBlob(canvas, options.format, options.quality);
    const bytes = meta.attach(new Uint8Array(await raw.arrayBuffer()));
    if (options.targetBytes > 0 && !canTune) {
      notes.push('PNG is lossless, so a size target cannot be met by quality alone');
    }
    return {
      blob: new Blob([bytes as unknown as BlobPart], { type: options.format }),
      width,
      height,
      qualityUsed: options.quality,
      notes,
    };
  }

  // Size-target path: binary search quality, then shrink dimensions if even the
  // lowest acceptable quality overshoots.
  const budget = Math.max(1024, options.targetBytes - meta.overhead);

  /*
   * Encoding a 12MP frame costs on the order of a second, so a naive binary
   * search would take most of a minute per photo. The search instead runs on a
   * small proxy and only the answer is verified at full resolution.
   *
   * Bytes-per-pixel is *not* constant across scales — downscaling concentrates
   * detail, so a proxy over-predicts the full-size result by a wide margin
   * (~60% for a typical photo). Rather than assume a correction factor, one
   * reference encode at each size measures the real ratio for this image.
   */
  const PROXY_EDGE = 1000;
  const REFERENCE_QUALITY = 0.6;
  const FLOOR_QUALITY = 0.3;
  const ceiling = Math.min(0.98, options.quality);

  let dims = targetDimensions(bitmap, options, 1);
  let canvas = prepareCanvas(bitmap, options, dims.width, dims.height);
  let quality = ceiling;
  // Definitely assigned: every branch below either encodes or falls through to
  // the floor-quality fallback.
  let blob!: Blob;

  const proxyScale = Math.min(1, PROXY_EDGE / Math.max(dims.width, dims.height));

  if (proxyScale >= 0.9) {
    // Already cheap to encode — search the real thing directly.
    blob = await toBlob(canvas, options.format, FLOOR_QUALITY);
    if (blob.size <= budget) {
      let low = FLOOR_QUALITY;
      let high = ceiling;
      quality = FLOOR_QUALITY;
      for (let i = 0; i < 6 && high - low > 0.015; i++) {
        const mid = (low + high) / 2;
        const candidate = await toBlob(canvas, options.format, mid);
        if (candidate.size <= budget) {
          blob = candidate;
          quality = mid;
          low = mid;
        } else {
          high = mid;
        }
      }
    } else {
      notes.push('Could not reach the target size — this is the smallest result');
      quality = FLOOR_QUALITY;
    }
  } else {
    const proxy = prepareCanvas(
      bitmap,
      options,
      Math.max(1, Math.round(dims.width * proxyScale)),
      Math.max(1, Math.round(dims.height * proxyScale)),
    );

    // Proxy encodes are ~1/16 the cost, and each quality is measured once.
    const proxySizes = new Map<number, number>();
    const proxySize = async (q: number): Promise<number> => {
      const cached = proxySizes.get(q);
      if (cached !== undefined) return cached;
      const size = (await toBlob(proxy, options.format, q)).size;
      proxySizes.set(q, size);
      return size;
    };

    /** Highest quality whose predicted full-size output fits, or null. */
    const searchProxy = async (proxyBudget: number): Promise<number | null> => {
      if ((await proxySize(FLOOR_QUALITY)) > proxyBudget) return null;
      let low = FLOOR_QUALITY;
      let high = ceiling;
      let found = FLOOR_QUALITY;
      for (let i = 0; i < 7 && high - low > 0.01; i++) {
        const mid = (low + high) / 2;
        if ((await proxySize(mid)) <= proxyBudget) {
          found = mid;
          low = mid;
        } else {
          high = mid;
        }
      }
      return found;
    };

    let scale = 1;
    let fitted = false;

    // At most three attempts: each one calibrates against the current size,
    // searches the proxy, and verifies for real. Bytes do not scale linearly
    // with pixel count, so the calibration is re-measured whenever the output
    // dimensions change rather than being extrapolated.
    for (let attempt = 0; attempt < 3 && !fitted; attempt++) {
      if (attempt > 0) {
        dims = targetDimensions(bitmap, options, scale);
        canvas = prepareCanvas(bitmap, options, dims.width, dims.height);
      }

      const reference = await toBlob(canvas, options.format, REFERENCE_QUALITY);
      let ratio = reference.size / Math.max(1, await proxySize(REFERENCE_QUALITY));

      const seed = await searchProxy(budget / ratio);
      if (seed === null) {
        // Quality alone cannot get there at this size. Output size tracks pixel
        // count, so the linear scale needed is the square root of the overshoot.
        const predicted = (await proxySize(FLOOR_QUALITY)) * ratio;
        scale *= Math.max(0.3, Math.min(0.9, Math.sqrt(budget / predicted) * 0.97));
        continue;
      }

      quality = seed;
      blob = await toBlob(canvas, options.format, quality);
      if (blob.size <= budget) {
        fitted = true;
        break;
      }

      // The estimate overshot — recalibrate from what actually came out and
      // take one more shot at this size before shrinking.
      ratio = blob.size / Math.max(1, await proxySize(quality));
      const corrected = await searchProxy(budget / ratio);
      if (corrected !== null) {
        quality = corrected;
        blob = await toBlob(canvas, options.format, quality);
        if (blob.size <= budget) {
          fitted = true;
          break;
        }
      }
      scale *= 0.8;
    }

    if (!fitted) {
      quality = FLOOR_QUALITY;
      blob = await toBlob(canvas, options.format, quality);
      if (blob.size > budget) {
        notes.push('Could not reach the target size — this is the smallest result');
      }
    }
  }

  const best = { blob, quality, width: dims.width, height: dims.height };

  const finalMeta = prepareMetadata(options, best.width, best.height);
  const bytes = finalMeta.attach(new Uint8Array(await best.blob.arrayBuffer()));

  return {
    blob: new Blob([bytes as unknown as BlobPart], { type: options.format }),
    width: best.width,
    height: best.height,
    qualityUsed: best.quality,
    notes: [...notes, ...finalMeta.notes.filter((n) => !notes.includes(n))],
  };
}

/**
 * Preview image for the UI grid and the compare view.
 *
 * The compare view needs a near-lossless render so the user is judging the
 * output against the source, not against a second lossy copy.
 */
export async function encodeThumbnail(bitmap: ImageBitmap, maxEdge = 400, quality = 0.72): Promise<Blob> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = drawScaled(bitmap, bitmap.width, bitmap.height, width, height);
  return toBlob(canvas, 'image/jpeg', quality);
}
