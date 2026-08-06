import type { OutputFormat } from './lib/capabilities';
import type { ExifData } from './lib/exif';

export type ItemStatus = 'queued' | 'decoding' | 'ready' | 'error' | 'cancelled';

export interface Settings {
  format: OutputFormat;
  /** JPEG/WebP/AVIF quality, 0.3–1.0 */
  quality: number;
  /** Longest-edge cap in px; 0 means keep original size */
  maxDimension: number;
  /** Desired maximum output size in bytes; 0 disables the search */
  targetBytes: number;
  keepExif: boolean;
  keepGps: boolean;
  keepIcc: boolean;
  keepXmp: boolean;
  /** Batch rename pattern; empty keeps the original stem */
  namePattern: string;
}

/** Per-file settings that win over the global ones. */
export type ItemOverride = Partial<Pick<Settings, 'format' | 'quality' | 'maxDimension' | 'targetBytes'>>;

export interface SourceMetadata {
  exif: ExifData | null;
  icc: Uint8Array | null;
  xmp: Uint8Array | null;
}

export interface QueueItem {
  id: string;
  file: File;
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
