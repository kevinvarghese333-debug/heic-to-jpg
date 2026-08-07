import type { OutputFormat } from './lib/capabilities';
import type { SourceKind } from './lib/detect';
import type { ExifData } from './lib/exif';

export type ItemStatus = 'queued' | 'decoding' | 'ready' | 'error' | 'cancelled';

/** Which control group the UI is showing. All operate on the same queue. */
export type Tool = 'compress' | 'resize' | 'crop' | 'convert';

export type ResizeMode = 'none' | 'longest' | 'exact' | 'percent';

export interface ResizeSpec {
  mode: ResizeMode;
  /** Longest-edge cap in px, for `longest` */
  longest: number;
  /** Target box for `exact` */
  width: number;
  height: number;
  /** Keep the aspect ratio when using `exact` (fit inside the box) */
  keepAspect: boolean;
  /** Percentage of the original, for `percent` */
  percent: number;
}

/** Normalised crop rectangle, 0–1 relative to the source image. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Settings {
  tool: Tool;
  format: OutputFormat;
  /** JPEG/WebP/AVIF quality, 0.3–1.0 */
  quality: number;
  resize: ResizeSpec;
  /** Desired maximum output size in bytes; 0 disables the search */
  targetBytes: number;
  /** Clockwise rotation applied before resizing */
  rotate: 0 | 90 | 180 | 270;
  flipHorizontal: boolean;
  keepExif: boolean;
  keepGps: boolean;
  keepIcc: boolean;
  keepXmp: boolean;
  /** Batch rename pattern; empty keeps the original stem */
  namePattern: string;
}

/** Per-file settings that win over the global ones. */
export type ItemOverride = Partial<Pick<Settings, 'format' | 'quality' | 'targetBytes'>>;

export interface SourceMetadata {
  exif: ExifData | null;
  icc: Uint8Array | null;
  xmp: Uint8Array | null;
}

export interface QueueItem {
  id: string;
  file: File;
  /** How the file has to be decoded */
  kind: SourceKind;
  /** Output filename including extension */
  outName: string;
  status: ItemStatus;
  error?: string;
  srcWidth: number;
  srcHeight: number;
  outWidth: number;
  outHeight: number;
  thumbUrl?: string;
  outBlob?: Blob;
  outSize: number;
  /** True while a re-encode is in flight */
  encoding: boolean;
  metadata: SourceMetadata;
  /** Fields the user chose to strip, keyed `${ifd}:${tag}` */
  strippedKeys: Set<string>;
  /** Per-image crop, or null for the whole frame */
  crop: CropRect | null;
  /** Warnings from the last encode, e.g. metadata that could not be carried */
  notes: string[];
  override: ItemOverride | null;
  qualityUsed: number;
}

export interface DecodeRequest {
  id: number;
  buffer: ArrayBuffer;
}

export type DecodeResponse =
  | { id: number; ok: true; bitmap: ImageBitmap; width: number; height: number }
  | { id: number; ok: false; error: string };

export interface BatchProgress {
  total: number;
  ready: number;
  failed: number;
  busy: boolean;
  /** Milliseconds remaining, or null when not yet estimable */
  etaMs: number | null;
}
