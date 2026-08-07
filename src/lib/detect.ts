import { looksLikeHeif } from './isobmff';

/**
 * Which decoder a file needs.
 *
 * HEIC/HEIF has to go through the libheif WASM worker. Everything else the
 * browser can already decode natively, which is both faster and avoids paying
 * for the 1.4MB decoder at all.
 */
export type SourceKind = 'heif' | 'jpeg' | 'png' | 'webp' | 'gif' | 'bmp' | 'unknown';

function matches(bytes: Uint8Array, signature: number[], at = 0): boolean {
  for (let i = 0; i < signature.length; i++) {
    if (bytes[at + i] !== signature[i]) return false;
  }
  return true;
}

/** Identifies a file from its magic bytes rather than trusting its extension. */
export function detectKind(buffer: ArrayBuffer): SourceKind {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return 'unknown';

  // JPEG: SOI marker
  if (matches(bytes, [0xff, 0xd8, 0xff])) return 'jpeg';

  // PNG signature
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';

  // RIFF....WEBP
  if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'webp';
  }

  if (matches(bytes, [0x47, 0x49, 0x46, 0x38])) return 'gif';
  if (matches(bytes, [0x42, 0x4d])) return 'bmp';

  // AVIF shares the HEIF brand table, so this covers it too.
  if (looksLikeHeif(buffer)) return 'heif';

  return 'unknown';
}

const KIND_LABELS: Record<SourceKind, string> = {
  heif: 'HEIC',
  jpeg: 'JPG',
  png: 'PNG',
  webp: 'WebP',
  gif: 'GIF',
  bmp: 'BMP',
  unknown: 'unknown',
};

export function kindLabel(kind: SourceKind): string {
  return KIND_LABELS[kind];
}
