/**
 * EXIF parsing, editing and re-serialisation.
 *
 * The canvas throws away metadata during encoding, so EXIF has to be lifted out
 * of the HEIC and written back into the output by hand. Rather than patching
 * bytes in place, this module parses the TIFF structure into a model, lets the
 * caller filter it, and writes a fresh TIFF back out. That makes selective tag
 * removal (strip GPS, drop an oversized MakerNote) straightforward, which
 * in-place patching cannot do without breaking every offset in the file.
 */

export const TAG = {
  ORIENTATION: 0x0112,
  EXIF_IFD_POINTER: 0x8769,
  GPS_IFD_POINTER: 0x8825,
  INTEROP_IFD_POINTER: 0xa005,
  MAKER_NOTE: 0x927c,
  PIXEL_X_DIMENSION: 0xa002,
  PIXEL_Y_DIMENSION: 0xa003,
} as const;

/** Byte width of each TIFF value type, indexed by type id. */
const TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

const TYPE_BYTE = 1;
const TYPE_ASCII = 2;
const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_UNDEFINED = 7;
const TYPE_SLONG = 9;
const TYPE_SRATIONAL = 10;

export type IfdName = 'IFD0' | 'Exif' | 'GPS';

export interface ExifEntry {
  tag: number;
  type: number;
  count: number;
  /** Exact value bytes, so re-serialisation is lossless */
  raw: Uint8Array;
}

export interface ExifIfd {
  name: IfdName;
  entries: ExifEntry[];
}

export interface ExifData {
  littleEndian: boolean;
  ifds: ExifIfd[];
}

/* ------------------------------------------------------------------ parsing */

function readEntries(
  dv: DataView,
  u8: Uint8Array,
  ifdOffset: number,
  le: boolean,
): { entries: ExifEntry[]; next: number } {
  const entries: ExifEntry[] = [];
  if (ifdOffset + 2 > u8.length) return { entries, next: 0 };

  const count = dv.getUint16(ifdOffset, le);
  for (let i = 0; i < count; i++) {
    const at = ifdOffset + 2 + i * 12;
    if (at + 12 > u8.length) break;

    const tag = dv.getUint16(at, le);
    const type = dv.getUint16(at + 2, le);
    const valueCount = dv.getUint32(at + 4, le);
    const unitSize = TYPE_SIZES[type] ?? 0;
    if (unitSize === 0) continue;

    const byteLength = unitSize * valueCount;
    // Guard against absurd counts in corrupt files.
    if (byteLength > u8.length) continue;

    let raw: Uint8Array;
    if (byteLength <= 4) {
      raw = u8.slice(at + 8, at + 8 + byteLength);
    } else {
      const valueOffset = dv.getUint32(at + 8, le);
      if (valueOffset + byteLength > u8.length) continue;
      raw = u8.slice(valueOffset, valueOffset + byteLength);
    }

    entries.push({ tag, type, count: valueCount, raw });
  }

  const nextAt = ifdOffset + 2 + count * 12;
  const next = nextAt + 4 <= u8.length ? dv.getUint32(nextAt, le) : 0;
  return { entries, next };
}

function pointerValue(entry: ExifEntry | undefined, le: boolean): number {
  if (!entry || entry.raw.length < 4) return 0;
  const dv = new DataView(entry.raw.buffer, entry.raw.byteOffset, entry.raw.byteLength);
  return dv.getUint32(0, le);
}

export function parseExif(tiff: Uint8Array): ExifData | null {
  try {
    if (tiff.length < 8) return null;
    const le = tiff[0] === 0x49;
    if (!le && tiff[0] !== 0x4d) return null;

    const dv = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const ifd0Offset = dv.getUint32(4, le);
    if (ifd0Offset < 8 || ifd0Offset >= tiff.length) return null;

    const { entries: ifd0 } = readEntries(dv, tiff, ifd0Offset, le);

    const ifds: ExifIfd[] = [{ name: 'IFD0', entries: ifd0 }];

    const exifPointer = pointerValue(ifd0.find((e) => e.tag === TAG.EXIF_IFD_POINTER), le);
    if (exifPointer > 0 && exifPointer < tiff.length) {
      ifds.push({ name: 'Exif', entries: readEntries(dv, tiff, exifPointer, le).entries });
    }

    const gpsPointer = pointerValue(ifd0.find((e) => e.tag === TAG.GPS_IFD_POINTER), le);
    if (gpsPointer > 0 && gpsPointer < tiff.length) {
      ifds.push({ name: 'GPS', entries: readEntries(dv, tiff, gpsPointer, le).entries });
    }

    return { littleEndian: le, ifds };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- manipulation */

export function getIfd(data: ExifData, name: IfdName): ExifIfd | undefined {
  return data.ifds.find((ifd) => ifd.name === name);
}

/**
 * Deep copy. Encoding mutates the model (orientation and pixel dimensions are
 * output-specific), so each encode works on its own clone and the parsed
 * original stays pristine for the metadata panel.
 */
export function cloneExif(data: ExifData): ExifData {
  return {
    littleEndian: data.littleEndian,
    ifds: data.ifds.map((ifd) => ({
      name: ifd.name,
      entries: ifd.entries.map((entry) => ({ ...entry, raw: entry.raw.slice() })),
    })),
  };
}

function setNumericEntry(ifd: ExifIfd, tag: number, value: number, le: boolean): void {
  const existing = ifd.entries.find((e) => e.tag === tag);
  if (existing) {
    // Rewrite in the entry's own type so we don't change its shape.
    const dv = new DataView(existing.raw.buffer, existing.raw.byteOffset, existing.raw.byteLength);
    if (existing.type === TYPE_SHORT && existing.raw.length >= 2) dv.setUint16(0, value, le);
    else if ((existing.type === TYPE_LONG || existing.type === TYPE_SLONG) && existing.raw.length >= 4)
      dv.setUint32(0, value, le);
    return;
  }

  const raw = new Uint8Array(4);
  new DataView(raw.buffer).setUint32(0, value, le);
  ifd.entries.push({ tag, type: TYPE_LONG, count: 1, raw });
}

/**
 * Applies the corrections every converted file needs.
 *
 * Orientation is forced to 1 because libheif already applies the container's
 * rotation while decoding — copying the original value would make viewers
 * rotate the image a second time. Pixel dimensions are rewritten so a resized
 * file doesn't advertise the source's size.
 */
export function applyOutputCorrections(data: ExifData, width: number, height: number): void {
  const le = data.littleEndian;
  const ifd0 = getIfd(data, 'IFD0');
  if (ifd0) setNumericEntry(ifd0, TAG.ORIENTATION, 1, le);

  const exif = getIfd(data, 'Exif');
  if (exif) {
    setNumericEntry(exif, TAG.PIXEL_X_DIMENSION, width, le);
    setNumericEntry(exif, TAG.PIXEL_Y_DIMENSION, height, le);
  }
}

/** Drops whole IFDs (used for "remove GPS"). */
export function removeIfd(data: ExifData, name: IfdName): void {
  data.ifds = data.ifds.filter((ifd) => ifd.name !== name);
}

/** Drops individual tags from a given IFD. */
export function removeTags(data: ExifData, name: IfdName, tags: Set<number>): void {
  const ifd = getIfd(data, name);
  if (!ifd) return;
  ifd.entries = ifd.entries.filter((entry) => !tags.has(entry.tag));
}

/* ------------------------------------------------------------ serialisation */

function ifdByteSize(entries: ExifEntry[]): number {
  return 2 + entries.length * 12 + 4;
}

function externalDataSize(entries: ExifEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    if (entry.raw.length > 4) total += entry.raw.length + (entry.raw.length % 2);
  }
  return total;
}

/**
 * Writes the model back out as a standalone TIFF block.
 *
 * Sub-IFD pointers are recomputed from scratch, and pointers to IFDs we are not
 * emitting (Interop, the IFD1 thumbnail) are removed rather than left dangling.
 */
export function serializeExif(data: ExifData): Uint8Array {
  const le = data.littleEndian;

  const ifd0 = getIfd(data, 'IFD0');
  const exif = getIfd(data, 'Exif');
  const gps = getIfd(data, 'GPS');

  // Work on copies so the caller's model is not mutated by serialisation.
  const ifd0Entries = (ifd0?.entries ?? []).filter(
    (e) =>
      e.tag !== TAG.EXIF_IFD_POINTER &&
      e.tag !== TAG.GPS_IFD_POINTER &&
      e.tag !== TAG.INTEROP_IFD_POINTER,
  );
  const exifEntries = (exif?.entries ?? []).filter((e) => e.tag !== TAG.INTEROP_IFD_POINTER);
  const gpsEntries = gps?.entries ?? [];

  const hasExif = exifEntries.length > 0;
  const hasGps = gpsEntries.length > 0;

  const makePointer = (tag: number): ExifEntry => ({
    tag,
    type: TYPE_LONG,
    count: 1,
    raw: new Uint8Array(4),
  });

  const exifPointer = hasExif ? makePointer(TAG.EXIF_IFD_POINTER) : null;
  const gpsPointer = hasGps ? makePointer(TAG.GPS_IFD_POINTER) : null;
  if (exifPointer) ifd0Entries.push(exifPointer);
  if (gpsPointer) ifd0Entries.push(gpsPointer);

  // TIFF requires entries within an IFD to be ordered by tag.
  ifd0Entries.sort((a, b) => a.tag - b.tag);
  exifEntries.sort((a, b) => a.tag - b.tag);
  gpsEntries.sort((a, b) => a.tag - b.tag);

  const ifd0Start = 8;
  const ifd0DataStart = ifd0Start + ifdByteSize(ifd0Entries);
  const exifStart = ifd0DataStart + externalDataSize(ifd0Entries);
  const exifDataStart = exifStart + (hasExif ? ifdByteSize(exifEntries) : 0);
  const gpsStart = exifDataStart + (hasExif ? externalDataSize(exifEntries) : 0);
  const gpsDataStart = gpsStart + (hasGps ? ifdByteSize(gpsEntries) : 0);
  const total = gpsDataStart + (hasGps ? externalDataSize(gpsEntries) : 0);

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  out[0] = le ? 0x49 : 0x4d;
  out[1] = le ? 0x49 : 0x4d;
  dv.setUint16(2, 0x2a, le);
  dv.setUint32(4, ifd0Start, le);

  if (exifPointer) new DataView(exifPointer.raw.buffer).setUint32(0, exifStart, le);
  if (gpsPointer) new DataView(gpsPointer.raw.buffer).setUint32(0, gpsStart, le);

  const writeIfd = (entries: ExifEntry[], ifdOffset: number, dataOffset: number): void => {
    dv.setUint16(ifdOffset, entries.length, le);
    let cursor = dataOffset;

    entries.forEach((entry, index) => {
      const at = ifdOffset + 2 + index * 12;
      dv.setUint16(at, entry.tag, le);
      dv.setUint16(at + 2, entry.type, le);
      dv.setUint32(at + 4, entry.count, le);

      if (entry.raw.length <= 4) {
        out.set(entry.raw, at + 8);
      } else {
        dv.setUint32(at + 8, cursor, le);
        out.set(entry.raw, cursor);
        cursor += entry.raw.length + (entry.raw.length % 2);
      }
    });

    // No IFD1: the thumbnail is deliberately not carried over.
    dv.setUint32(ifdOffset + 2 + entries.length * 12, 0, le);
  };

  writeIfd(ifd0Entries, ifd0Start, ifd0DataStart);
  if (hasExif) writeIfd(exifEntries, exifStart, exifDataStart);
  if (hasGps) writeIfd(gpsEntries, gpsStart, gpsDataStart);

  return out;
}

/**
 * EXIF must fit in a single JPEG APP1 segment (a 16-bit length field). The
 * usual cause of an oversized block is a bloated MakerNote, so drop that first
 * and only give up if the rest still doesn't fit.
 */
export const MAX_EXIF_PAYLOAD = 0xffff - 2 - 6;

export function fitExifToSegment(data: ExifData): { tiff: Uint8Array | null; droppedMakerNote: boolean } {
  let tiff = serializeExif(data);
  if (tiff.length <= MAX_EXIF_PAYLOAD) return { tiff, droppedMakerNote: false };

  removeTags(data, 'Exif', new Set([TAG.MAKER_NOTE]));
  tiff = serializeExif(data);
  if (tiff.length <= MAX_EXIF_PAYLOAD) return { tiff, droppedMakerNote: true };

  return { tiff: null, droppedMakerNote: true };
}

/* ------------------------------------------------------------ presentation */

interface TagSpec {
  name: string;
  /** Renders the decoded value for display */
  format?: (values: number[] | string) => string;
}

const IFD0_TAGS: Record<number, TagSpec> = {
  0x010f: { name: 'Camera make' },
  0x0110: { name: 'Camera model' },
  0x0112: { name: 'Orientation' },
  0x011a: { name: 'X resolution' },
  0x011b: { name: 'Y resolution' },
  0x0131: { name: 'Software' },
  0x0132: { name: 'Date modified' },
  0x013b: { name: 'Artist' },
  0x8298: { name: 'Copyright' },
  0x010e: { name: 'Description' },
};

const EXIF_TAGS: Record<number, TagSpec> = {
  0x829a: { name: 'Exposure time', format: (v) => (Array.isArray(v) && v[0] ? formatExposure(v[0]) : String(v)) },
  0x829d: { name: 'Aperture', format: (v) => (Array.isArray(v) ? `f/${v[0].toFixed(1)}` : String(v)) },
  0x8827: { name: 'ISO' },
  0x9003: { name: 'Date taken' },
  0x9004: { name: 'Date digitised' },
  0x920a: { name: 'Focal length', format: (v) => (Array.isArray(v) ? `${Math.round(v[0])} mm` : String(v)) },
  0xa405: { name: 'Focal length (35mm)', format: (v) => (Array.isArray(v) ? `${Math.round(v[0])} mm` : String(v)) },
  0x9207: { name: 'Metering mode' },
  0x9209: { name: 'Flash' },
  0xa002: { name: 'Pixel width' },
  0xa003: { name: 'Pixel height' },
  0xa433: { name: 'Lens make' },
  0xa434: { name: 'Lens model' },
  0x927c: { name: 'Maker note (proprietary)' },
  0x9286: { name: 'User comment' },
};

const GPS_TAGS: Record<number, TagSpec> = {
  0x0000: { name: 'GPS version' },
  0x0001: { name: 'Latitude ref' },
  0x0002: { name: 'Latitude' },
  0x0003: { name: 'Longitude ref' },
  0x0004: { name: 'Longitude' },
  0x0005: { name: 'Altitude ref' },
  0x0006: { name: 'Altitude', format: (v) => (Array.isArray(v) ? `${v[0].toFixed(1)} m` : String(v)) },
  0x0007: { name: 'GPS timestamp' },
  0x001d: { name: 'GPS date' },
};

function formatExposure(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(1)} s`;
  return `1/${Math.round(1 / seconds)} s`;
}

function decodeValue(entry: ExifEntry, le: boolean): number[] | string {
  const { type, raw } = entry;
  if (type === TYPE_ASCII) {
    return new TextDecoder().decode(raw).replace(/\0+$/, '');
  }
  if (type === TYPE_UNDEFINED || type === TYPE_BYTE) {
    return [...raw.subarray(0, Math.min(raw.length, 8))];
  }

  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const out: number[] = [];
  const unit = TYPE_SIZES[type] ?? 0;
  if (unit === 0) return out;

  const count = Math.min(entry.count, Math.floor(raw.length / unit));
  for (let i = 0; i < count; i++) {
    const at = i * unit;
    switch (type) {
      case TYPE_SHORT:
        out.push(dv.getUint16(at, le));
        break;
      case TYPE_LONG:
        out.push(dv.getUint32(at, le));
        break;
      case TYPE_SLONG:
        out.push(dv.getInt32(at, le));
        break;
      case TYPE_RATIONAL: {
        const den = dv.getUint32(at + 4, le);
        out.push(den === 0 ? 0 : dv.getUint32(at, le) / den);
        break;
      }
      case TYPE_SRATIONAL: {
        const den = dv.getInt32(at + 4, le);
        out.push(den === 0 ? 0 : dv.getInt32(at, le) / den);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

export interface ExifField {
  ifd: IfdName;
  tag: number;
  label: string;
  display: string;
  /** Bytes this field occupies, so the UI can show what stripping saves */
  bytes: number;
  known: boolean;
}

const ORIENTATION_LABELS: Record<number, string> = {
  1: 'Normal', 2: 'Mirrored', 3: 'Rotated 180°', 4: 'Mirrored, 180°',
  5: 'Mirrored, 270°', 6: 'Rotated 90° CW', 7: 'Mirrored, 90°', 8: 'Rotated 270° CW',
};

/** Flattens the model into rows the metadata panel can render. */
export function describeExif(data: ExifData): ExifField[] {
  const dictionaries: Record<IfdName, Record<number, TagSpec>> = {
    IFD0: IFD0_TAGS,
    Exif: EXIF_TAGS,
    GPS: GPS_TAGS,
  };

  // Sub-IFD pointers are internal structure, not metadata. They are recomputed
  // on every serialise, so showing them (with a Remove button that does
  // nothing meaningful) would only confuse.
  const structural = new Set<number>([
    TAG.EXIF_IFD_POINTER,
    TAG.GPS_IFD_POINTER,
    TAG.INTEROP_IFD_POINTER,
  ]);

  const fields: ExifField[] = [];
  for (const ifd of data.ifds) {
    const dictionary = dictionaries[ifd.name];
    for (const entry of ifd.entries) {
      if (ifd.name === 'IFD0' && structural.has(entry.tag)) continue;
      const spec = dictionary?.[entry.tag];
      const decoded = decodeValue(entry, data.littleEndian);

      let display: string;
      if (spec?.format) {
        display = spec.format(decoded);
      } else if (typeof decoded === 'string') {
        display = decoded;
      } else if (entry.tag === TAG.ORIENTATION && typeof decoded[0] === 'number') {
        display = ORIENTATION_LABELS[decoded[0]] ?? String(decoded[0]);
      } else if (entry.type === TYPE_UNDEFINED || entry.type === TYPE_BYTE) {
        display = `${entry.raw.length} bytes`;
      } else {
        display = decoded.map((n) => (Number.isInteger(n) ? n : n.toFixed(4))).join(', ');
      }

      fields.push({
        ifd: ifd.name,
        tag: entry.tag,
        label: spec?.name ?? `Tag 0x${entry.tag.toString(16).padStart(4, '0')}`,
        display: display || '—',
        bytes: entry.raw.length + 12,
        known: Boolean(spec),
      });
    }
  }
  return fields;
}

export interface GpsPosition {
  latitude: number;
  longitude: number;
}

/** Decodes GPS coordinates to decimal degrees, for the location warning. */
export function readGpsPosition(data: ExifData): GpsPosition | null {
  const gps = getIfd(data, 'GPS');
  if (!gps) return null;

  const get = (tag: number) => gps.entries.find((e) => e.tag === tag);
  const latEntry = get(0x0002);
  const lonEntry = get(0x0004);
  if (!latEntry || !lonEntry) return null;

  const toDegrees = (entry: ExifEntry): number | null => {
    const parts = decodeValue(entry, data.littleEndian);
    if (!Array.isArray(parts) || parts.length < 3) return null;
    return parts[0] + parts[1] / 60 + parts[2] / 3600;
  };

  const latRef = decodeValue(get(0x0001) ?? { tag: 0, type: TYPE_ASCII, count: 0, raw: new Uint8Array() }, data.littleEndian);
  const lonRef = decodeValue(get(0x0003) ?? { tag: 0, type: TYPE_ASCII, count: 0, raw: new Uint8Array() }, data.littleEndian);

  const lat = toDegrees(latEntry);
  const lon = toDegrees(lonEntry);
  if (lat === null || lon === null) return null;

  return {
    latitude: typeof latRef === 'string' && latRef.startsWith('S') ? -lat : lat,
    longitude: typeof lonRef === 'string' && lonRef.startsWith('W') ? -lon : lon,
  };
}
