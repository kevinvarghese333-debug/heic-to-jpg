/**
 * PNG metadata embedding.
 *
 * Canvas PNG output is untagged, so the ICC profile and EXIF are added as
 * `iCCP` and `eXIf` chunks. Both are standard: `iCCP` since PNG 1.0, `eXIf`
 * since the 2017 extension, and both are widely honoured by modern viewers.
 */
import { zlibSync } from 'fflate';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

/** Offset just past the IHDR chunk, which every other chunk must follow. */
function afterIhdr(bytes: Uint8Array): number {
  if (bytes.length < 8 + 12) return -1;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = dv.getUint32(8);
  const end = 8 + 12 + length;
  return end <= bytes.length ? end : -1;
}

export interface PngMetadata {
  icc: Uint8Array | null;
  exif: Uint8Array | null;
}

export function addPngMetadata(png: Uint8Array, metadata: PngMetadata): Uint8Array {
  if (!isPng(png)) return png;
  const insertAt = afterIhdr(png);
  if (insertAt < 0) return png;

  const chunks: Uint8Array[] = [];

  if (metadata.icc) {
    try {
      const name = new TextEncoder().encode('ICC profile');
      const compressed = zlibSync(metadata.icc, { level: 6 });
      const data = new Uint8Array(name.length + 2 + compressed.length);
      data.set(name, 0);
      data[name.length] = 0; // null terminator
      data[name.length + 1] = 0; // compression method: deflate
      data.set(compressed, name.length + 2);
      chunks.push(buildChunk('iCCP', data));
    } catch {
      /* a profile we cannot compress simply isn't embedded */
    }
  }

  if (metadata.exif) {
    // eXIf holds the bare TIFF block — no "Exif\0\0" prefix, unlike JPEG APP1.
    chunks.push(buildChunk('eXIf', metadata.exif));
  }

  if (chunks.length === 0) return png;

  const extra = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(png.length + extra);
  out.set(png.subarray(0, insertAt), 0);
  let at = insertAt;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  out.set(png.subarray(insertAt), at);
  return out;
}
