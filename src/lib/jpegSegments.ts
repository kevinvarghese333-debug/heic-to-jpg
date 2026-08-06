/**
 * Writes metadata segments into an encoded JPEG.
 *
 * Canvas output carries no metadata at all, so EXIF, ICC and XMP are spliced in
 * afterwards as APP segments.
 */

const EXIF_HEADER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
const XMP_NAMESPACE = 'http://ns.adobe.com/xap/1.0/\0';
const ICC_IDENTIFIER = 'ICC_PROFILE\0';

const MAX_SEGMENT_PAYLOAD = 0xffff - 2;

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const length = payload.length + 2;
  const out = new Uint8Array(length + 2);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(payload, 4);
  return out;
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export function buildExifSegment(tiff: Uint8Array): Uint8Array | null {
  const payload = concatBytes([new Uint8Array(EXIF_HEADER), tiff]);
  if (payload.length > MAX_SEGMENT_PAYLOAD) return null;
  return segment(0xe1, payload);
}

export function buildXmpSegment(xmp: Uint8Array): Uint8Array | null {
  const payload = concatBytes([new TextEncoder().encode(XMP_NAMESPACE), xmp]);
  // Packets beyond 64KB need the ExtendedXMP mechanism, which almost nothing
  // written by a phone camera requires; oversized packets are skipped.
  if (payload.length > MAX_SEGMENT_PAYLOAD) return null;
  return segment(0xe1, payload);
}

/**
 * ICC profiles routinely exceed one segment, and unlike EXIF the format has a
 * standard chunking mechanism: each APP2 carries a 1-based sequence number and
 * the total count.
 */
export function buildIccSegments(icc: Uint8Array): Uint8Array[] {
  const identifier = new TextEncoder().encode(ICC_IDENTIFIER);
  const perChunk = MAX_SEGMENT_PAYLOAD - identifier.length - 2;
  if (perChunk <= 0) return [];

  const chunkCount = Math.ceil(icc.length / perChunk);
  // The sequence fields are single bytes, so 255 chunks (~16MB) is the ceiling.
  if (chunkCount > 255) return [];

  const segments: Uint8Array[] = [];
  for (let i = 0; i < chunkCount; i++) {
    const chunk = icc.subarray(i * perChunk, (i + 1) * perChunk);
    const payload = new Uint8Array(identifier.length + 2 + chunk.length);
    payload.set(identifier, 0);
    payload[identifier.length] = i + 1;
    payload[identifier.length + 1] = chunkCount;
    payload.set(chunk, identifier.length + 2);
    segments.push(segment(0xe2, payload));
  }
  return segments;
}

type SegmentKind = 'exif' | 'xmp' | 'icc' | 'jfif' | 'other';

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function identifySegment(jpeg: Uint8Array, at: number): SegmentKind {
  const marker = jpeg[at + 1];
  const payload = at + 4;
  if (marker === 0xe0) return 'jfif';
  if (marker === 0xe1) {
    if (startsWith(jpeg, payload, 'Exif')) return 'exif';
    if (startsWith(jpeg, payload, 'http://ns.adobe.com/xap/1.0/')) return 'xmp';
  }
  if (marker === 0xe2 && startsWith(jpeg, payload, 'ICC_PROFILE')) return 'icc';
  return 'other';
}

export interface SegmentReplacements {
  exif?: boolean;
  xmp?: boolean;
  icc?: boolean;
}

/**
 * Rewrites a JPEG's APP segment block.
 *
 * Browsers tag their own canvas output with an sRGB ICC profile, so simply
 * prepending ours would leave the file carrying two conflicting profiles.
 * Anything we are about to supply is stripped first, then our segments are
 * placed immediately after JFIF (which must stay first).
 */
export function insertJpegSegments(
  jpeg: Uint8Array,
  segments: Uint8Array[],
  replace: SegmentReplacements = {},
): Uint8Array {
  const usable = segments.filter((s) => s.length > 0);
  if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return jpeg;
  if (usable.length === 0 && !replace.exif && !replace.xmp && !replace.icc) return jpeg;

  const kept: Uint8Array[] = [];
  let jfif: Uint8Array | null = null;
  let p = 2;

  while (p + 4 <= jpeg.length && jpeg[p] === 0xff && jpeg[p + 1] >= 0xe0 && jpeg[p + 1] <= 0xef) {
    const length = (jpeg[p + 2] << 8) | jpeg[p + 3];
    const end = p + 2 + length;
    if (length < 2 || end > jpeg.length) break;

    const kind = identifySegment(jpeg, p);
    const dropped =
      (kind === 'icc' && replace.icc) ||
      (kind === 'exif' && replace.exif) ||
      (kind === 'xmp' && replace.xmp);

    if (!dropped) {
      if (kind === 'jfif' && !jfif) jfif = jpeg.subarray(p, end);
      else kept.push(jpeg.subarray(p, end));
    }
    p = end;
  }

  const head = jfif ? [jpeg.subarray(0, 2), jfif] : [jpeg.subarray(0, 2)];
  return concatBytes([...head, ...usable, ...kept, jpeg.subarray(p)]);
}
