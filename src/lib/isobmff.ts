/**
 * Minimal ISOBMFF (ISO base media file format) reader.
 *
 * HEIC files are ISOBMFF containers. Everything we want to carry across to the
 * output image — EXIF, the ICC colour profile, XMP — lives in boxes here, so
 * this module is the single place that understands the container layout.
 */

export interface Box {
  type: string;
  /** Offset of the box payload, relative to the start of the file */
  start: number;
  /** Offset just past the end of the box */
  end: number;
}

export function readType(u8: Uint8Array, p: number): string {
  return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);
}

/** Walks sibling boxes in [start, end). Stops cleanly on malformed data. */
export function* walkBoxes(u8: Uint8Array, dv: DataView, start: number, end: number): Generator<Box> {
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = readType(u8, p + 4);
    let header = 8;

    if (size === 1) {
      if (p + 16 > end) return;
      size = Number(dv.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }

    if (size < header || p + size > end) return;
    yield { type, start: p + header, end: p + size };
    p += size;
  }
}

export function findBox(
  u8: Uint8Array,
  dv: DataView,
  start: number,
  end: number,
  type: string,
): Box | null {
  for (const box of walkBoxes(u8, dv, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/** Reads a null-terminated string, returning the value and the next offset. */
function readCString(u8: Uint8Array, p: number, limit: number): { value: string; next: number } {
  let end = p;
  while (end < limit && u8[end] !== 0) end++;
  return { value: new TextDecoder().decode(u8.subarray(p, end)), next: Math.min(end + 1, limit) };
}

interface ItemInfo {
  id: number;
  type: string;
  /** Only meaningful when type is `mime` */
  contentType: string;
}

/** Parses the `iinf` box into the list of items the file declares. */
function parseItemInfo(u8: Uint8Array, dv: DataView, iinf: Box): ItemInfo[] {
  const version = u8[iinf.start];
  let p = iinf.start + 4; // version + flags
  p += version === 0 ? 2 : 4; // entry_count

  const items: ItemInfo[] = [];
  for (const entry of walkBoxes(u8, dv, p, iinf.end)) {
    if (entry.type !== 'infe') continue;

    const infeVersion = u8[entry.start];
    // item_type only exists from infe v2 onwards; v0/v1 are MIME-typed only.
    if (infeVersion < 2) continue;

    let q = entry.start + 4;
    let id: number;
    if (infeVersion === 2) {
      id = dv.getUint16(q);
      q += 2;
    } else {
      id = dv.getUint32(q);
      q += 4;
    }
    q += 2; // item_protection_index

    if (q + 4 > entry.end) continue;
    const type = readType(u8, q);
    q += 4;

    let contentType = '';
    if (type === 'mime') {
      // item_name comes first, then content_type.
      const name = readCString(u8, q, entry.end);
      contentType = readCString(u8, name.next, entry.end).value;
    }

    items.push({ id, type, contentType });
  }
  return items;
}

interface Extent {
  offset: number;
  length: number;
}

/** Byte ranges for a given item ID, per the `iloc` box. */
function locateItem(u8: Uint8Array, dv: DataView, iloc: Box, wantedId: number): Extent[] | null {
  const version = u8[iloc.start];
  let p = iloc.start + 4; // version + flags

  const offsetSize = u8[p] >> 4;
  const lengthSize = u8[p] & 0x0f;
  const baseOffsetSize = u8[p + 1] >> 4;
  const indexSize = version === 1 || version === 2 ? u8[p + 1] & 0x0f : 0;
  p += 2;

  let itemCount: number;
  if (version < 2) {
    itemCount = dv.getUint16(p);
    p += 2;
  } else {
    itemCount = dv.getUint32(p);
    p += 4;
  }

  const readInt = (at: number, size: number): number => {
    switch (size) {
      case 0:
        return 0;
      case 1:
        return u8[at];
      case 2:
        return dv.getUint16(at);
      case 4:
        return dv.getUint32(at);
      case 8:
        return Number(dv.getBigUint64(at));
      default:
        return 0;
    }
  };

  for (let i = 0; i < itemCount; i++) {
    if (p + 2 > iloc.end) return null;

    let itemId: number;
    if (version < 2) {
      itemId = dv.getUint16(p);
      p += 2;
    } else {
      itemId = dv.getUint32(p);
      p += 4;
    }

    let constructionMethod = 0;
    if (version === 1 || version === 2) {
      constructionMethod = dv.getUint16(p) & 0x0f;
      p += 2;
    }

    p += 2; // data_reference_index
    const baseOffset = readInt(p, baseOffsetSize);
    p += baseOffsetSize;

    const extentCount = dv.getUint16(p);
    p += 2;

    const extents: Extent[] = [];
    for (let e = 0; e < extentCount; e++) {
      p += indexSize;
      const offset = readInt(p, offsetSize);
      p += offsetSize;
      const length = readInt(p, lengthSize);
      p += lengthSize;
      extents.push({ offset: baseOffset + offset, length });
    }

    if (itemId === wantedId) {
      // Only construction_method 0 (a plain file offset) is supported; 1 (idat)
      // and 2 (item) are vanishingly rare for metadata.
      return constructionMethod === 0 ? extents : null;
    }
  }
  return null;
}

function isTiffHeader(u8: Uint8Array, p: number): boolean {
  if (p + 4 > u8.length) return false;
  const le = u8[p] === 0x49 && u8[p + 1] === 0x49 && u8[p + 2] === 0x2a && u8[p + 3] === 0x00;
  const be = u8[p] === 0x4d && u8[p + 1] === 0x4d && u8[p + 2] === 0x00 && u8[p + 3] === 0x2a;
  return le || be;
}

/**
 * Pulls the ICC profile out of a `colr` box.
 *
 * `colr` comes in two flavours: `nclx` (just a set of enum coefficients, which
 * we cannot turn into a profile) and `prof`/`rICC` (an embedded ICC profile,
 * which is what we want).
 */
function findIccProfile(u8: Uint8Array, dv: DataView, meta: Box): Uint8Array | null {
  const iprp = findBox(u8, dv, meta.start + 4, meta.end, 'iprp');
  if (!iprp) return null;
  const ipco = findBox(u8, dv, iprp.start, iprp.end, 'ipco');
  if (!ipco) return null;

  for (const prop of walkBoxes(u8, dv, ipco.start, ipco.end)) {
    if (prop.type !== 'colr') continue;
    if (prop.start + 4 > prop.end) continue;

    const colourType = readType(u8, prop.start);
    if (colourType !== 'prof' && colourType !== 'rICC') continue;

    const profile = u8.slice(prop.start + 4, prop.end);
    // An ICC profile begins with its own big-endian size field; sanity-check it.
    if (profile.length < 132) continue;
    return profile;
  }
  return null;
}

export interface HeifMetadata {
  /** Raw TIFF block, ready to wrap in a JPEG APP1 segment */
  exif: Uint8Array | null;
  /** ICC colour profile bytes */
  icc: Uint8Array | null;
  /** XMP packet (UTF-8 XML) */
  xmp: Uint8Array | null;
}

/** Reads every piece of metadata we know how to carry forward. */
export function extractHeifMetadata(buffer: ArrayBuffer): HeifMetadata {
  const result: HeifMetadata = { exif: null, icc: null, xmp: null };
  try {
    const u8 = new Uint8Array(buffer);
    const dv = new DataView(buffer);

    const meta = findBox(u8, dv, 0, u8.length, 'meta');
    if (!meta) return result;

    result.icc = findIccProfile(u8, dv, meta);

    // `meta` is a FullBox: skip its version + flags before reading children.
    const metaStart = meta.start + 4;
    const iinf = findBox(u8, dv, metaStart, meta.end, 'iinf');
    const iloc = findBox(u8, dv, metaStart, meta.end, 'iloc');
    if (!iinf || !iloc) return result;

    const items = parseItemInfo(u8, dv, iinf);

    for (const item of items) {
      const isExif = item.type === 'Exif';
      const isXmp = item.type === 'mime' && item.contentType === 'application/rdf+xml';
      if (!isExif && !isXmp) continue;
      if (isExif && result.exif) continue;
      if (isXmp && result.xmp) continue;

      const extents = locateItem(u8, dv, iloc, item.id);
      if (!extents || extents.length === 0) continue;

      const { offset, length } = extents[0];
      if (offset < 0 || length <= 0 || offset + length > u8.length) continue;

      if (isXmp) {
        result.xmp = u8.slice(offset, offset + length);
        continue;
      }

      // ExifDataBlock starts with a 32-bit offset to the TIFF header.
      if (length <= 4) continue;
      const headerOffset = dv.getUint32(offset);
      let tiffStart = offset + 4 + headerOffset;

      if (!isTiffHeader(u8, tiffStart)) {
        // Some encoders write a bogus prefix length; scan a short window instead.
        const limit = Math.min(offset + 64, offset + length - 4);
        let found = -1;
        for (let p = offset; p <= limit; p++) {
          if (isTiffHeader(u8, p)) {
            found = p;
            break;
          }
        }
        if (found < 0) continue;
        tiffStart = found;
      }

      const tiffEnd = offset + length;
      if (tiffEnd > tiffStart) result.exif = u8.slice(tiffStart, tiffEnd);
    }

    return result;
  } catch {
    return result;
  }
}

const HEIF_BRANDS = new Set([
  'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs',
  'mif1', 'msf1', 'miaf', 'avif', 'avis',
]);

/** Sniffs the ftyp box so we can reject non-HEIF files before decoding. */
export function looksLikeHeif(buffer: ArrayBuffer): boolean {
  const u8 = new Uint8Array(buffer);
  if (u8.length < 16) return false;
  if (readType(u8, 4) !== 'ftyp') return false;

  const dv = new DataView(buffer);
  const size = Math.min(dv.getUint32(0), u8.length);
  if (HEIF_BRANDS.has(readType(u8, 8))) return true;

  // Fall back to the compatible-brands list.
  for (let p = 16; p + 4 <= size; p += 4) {
    if (HEIF_BRANDS.has(readType(u8, p))) return true;
  }
  return false;
}
