/**
 * Reads metadata out of an existing JPEG.
 *
 * Needed because JPEG is now an accepted input, not just an output — someone
 * compressing a photo expects its camera data and colour profile to survive.
 */

const EXIF_PREFIX = 'Exif\0\0';
const XMP_PREFIX = 'http://ns.adobe.com/xap/1.0/\0';
const ICC_PREFIX = 'ICC_PROFILE\0';

export interface JpegMetadata {
  exif: Uint8Array | null;
  icc: Uint8Array | null;
  xmp: Uint8Array | null;
}

function startsWith(bytes: Uint8Array, at: number, text: string): boolean {
  if (at + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

export function extractJpegMetadata(buffer: ArrayBuffer): JpegMetadata {
  const result: JpegMetadata = { exif: null, icc: null, xmp: null };
  try {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return result;

    // ICC profiles are split across numbered APP2 segments and have to be
    // stitched back together in sequence order.
    const iccChunks: Array<{ index: number; data: Uint8Array }> = [];

    let p = 2;
    while (p + 4 <= bytes.length) {
      if (bytes[p] !== 0xff) break;
      const marker = bytes[p + 1];

      // Start of scan: image data follows, no more metadata.
      if (marker === 0xda || marker === 0xd9) break;
      // Standalone markers carry no length field.
      if (marker >= 0xd0 && marker <= 0xd9) {
        p += 2;
        continue;
      }

      const length = (bytes[p + 2] << 8) | bytes[p + 3];
      if (length < 2 || p + 2 + length > bytes.length) break;

      const payload = p + 4;
      const payloadEnd = p + 2 + length;

      if (marker === 0xe1) {
        if (!result.exif && startsWith(bytes, payload, EXIF_PREFIX)) {
          result.exif = bytes.slice(payload + EXIF_PREFIX.length, payloadEnd);
        } else if (!result.xmp && startsWith(bytes, payload, XMP_PREFIX)) {
          result.xmp = bytes.slice(payload + XMP_PREFIX.length, payloadEnd);
        }
      } else if (marker === 0xe2 && startsWith(bytes, payload, ICC_PREFIX)) {
        const seqAt = payload + ICC_PREFIX.length;
        if (seqAt + 2 <= payloadEnd) {
          iccChunks.push({ index: bytes[seqAt], data: bytes.slice(seqAt + 2, payloadEnd) });
        }
      }

      p = payloadEnd;
    }

    if (iccChunks.length > 0) {
      iccChunks.sort((a, b) => a.index - b.index);
      const total = iccChunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
      const icc = new Uint8Array(total);
      let at = 0;
      for (const chunk of iccChunks) {
        icc.set(chunk.data, at);
        at += chunk.data.length;
      }
      // A valid profile is at least a 128-byte header plus a tag count.
      if (icc.length >= 132) result.icc = icc;
    }

    return result;
  } catch {
    return result;
  }
}
