import { detectCapabilities, formatExtension, type Capabilities, type OutputFormat } from './lib/capabilities';
import { BitmapCache } from './lib/bitmapCache';
import { detectKind, kindLabel, type SourceKind } from './lib/detect';
import { encodeImage, encodeThumbnail } from './lib/encode';
import { cloneExif, parseExif, removeIfd, removeTags, type ExifData, type IfdName } from './lib/exif';
import { applyNamePattern } from './lib/format';
import { extractHeifMetadata } from './lib/isobmff';
import { extractJpegMetadata } from './lib/jpegMeta';
import { buildPdf, type PdfOptions, type PdfPageImage } from './lib/pdf';
import { readPngMetadata } from './lib/pngChunks';
import { DecodePool } from './lib/pool';
import type { BatchProgress, CropRect, ItemOverride, QueueItem, Settings } from './types';

/** Caps how many encodes run at once so the UI stays responsive. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiting.shift()?.();
    };
  }
}

/**
 * `cancel()` mutates status from outside the async pipeline, which TypeScript's
 * narrowing cannot see — reading it through a function keeps the check honest.
 */
function isCancelled(item: QueueItem): boolean {
  return item.status === 'cancelled';
}

export const DEFAULT_SETTINGS: Settings = {
  tool: 'compress',
  format: 'image/jpeg',
  quality: 0.85,
  resize: { mode: 'none', longest: 1920, width: 1920, height: 1080, keepAspect: true, percent: 50 },
  targetBytes: 0,
  rotate: 0,
  flipHorizontal: false,
  keepExif: true,
  keepGps: true,
  keepIcc: true,
  keepXmp: true,
  namePattern: '',
};

export interface ConverterEvents {
  onItemAdded(item: QueueItem): void;
  onItemChanged(item: QueueItem): void;
  onItemRemoved(item: QueueItem): void;
  onQueueChanged(): void;
}

export class Converter {
  readonly items: QueueItem[] = [];
  readonly capabilities: Capabilities;
  settings: Settings = { ...DEFAULT_SETTINGS };

  private pool: DecodePool;
  private readonly cache: BitmapCache;
  private readonly encodeLimit = new Semaphore(2);
  private readonly inFlightDecodes = new Map<string, Promise<ImageBitmap>>();
  /** Bumped on every settings change so stale encodes can be discarded. */
  private settingsVersion = 0;
  /** Bumped only by cancel(), which needs different clean-up to a settings change. */
  private generation = 0;
  private nextId = 1;

  private batchStartedAt = 0;
  private completedSinceStart = 0;

  constructor(private readonly events: ConverterEvents) {
    this.capabilities = detectCapabilities();
    this.pool = new DecodePool(this.capabilities.workerCount);
    this.cache = new BitmapCache(this.capabilities.bitmapBudgetBytes);

    // Holding hundreds of megabytes in a backgrounded tab is the quickest way
    // to get killed by the OS on a phone.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.cache.trim(0.25);
    });
  }

  get readyItems(): QueueItem[] {
    return this.items.filter((item) => item.status === 'ready' && item.outBlob);
  }

  get totalOutputSize(): number {
    return this.readyItems.reduce((sum, item) => sum + item.outSize, 0);
  }

  get isBusy(): boolean {
    return this.items.some((item) => item.status === 'decoding' || item.status === 'queued' || item.encoding);
  }

  get progress(): BatchProgress {
    const total = this.items.length;
    const ready = this.readyItems.length;
    const failed = this.items.filter((item) => item.status === 'error' || item.status === 'cancelled').length;
    const busy = this.isBusy;

    let etaMs: number | null = null;
    if (busy && this.completedSinceStart > 0) {
      const elapsed = performance.now() - this.batchStartedAt;
      const perItem = elapsed / this.completedSinceStart;
      const remaining = total - ready - failed;
      if (remaining > 0) etaMs = perItem * remaining;
    }

    return { total, ready, failed, busy, etaMs };
  }

  /* ------------------------------------------------------------- queueing */

  addFiles(files: File[]): void {
    if (!this.isBusy) {
      this.batchStartedAt = performance.now();
      this.completedSinceStart = 0;
    }

    const fresh: QueueItem[] = [];
    for (const file of files) {
      const item: QueueItem = {
        id: `item-${this.nextId++}`,
        file,
        kind: 'unknown',
        crop: null,
        outName: file.name,
        status: 'queued',
        srcWidth: 0,
        srcHeight: 0,
        outWidth: 0,
        outHeight: 0,
        outSize: 0,
        encoding: false,
        metadata: { exif: null, icc: null, xmp: null },
        strippedKeys: new Set(),
        notes: [],
        override: null,
        qualityUsed: 0,
      };
      this.items.push(item);
      fresh.push(item);
      this.events.onItemAdded(item);
    }

    this.refreshNames();
    this.events.onQueueChanged();
    for (const item of fresh) void this.process(item);
  }

  remove(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = this.items.splice(index, 1);
    this.cache.delete(item.id);
    if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
    this.events.onItemRemoved(item);
    this.refreshNames();
    this.events.onQueueChanged();
  }

  clear(): void {
    for (const item of [...this.items]) this.remove(item.id);
    this.cache.clear();
  }

  /**
   * Stops everything in flight. Terminating the workers is the only way to
   * interrupt a decode already running inside wasm, so the pool is torn down
   * and rebuilt.
   */
  cancel(): void {
    this.settingsVersion++;
    this.generation++;
    this.pool.cancel();
    this.pool = new DecodePool(this.capabilities.workerCount);
    this.inFlightDecodes.clear();

    for (const item of this.items) {
      const unfinished =
        item.status === 'queued' || item.status === 'decoding' || (item.status === 'ready' && !item.outBlob);

      if (unfinished) {
        item.status = 'cancelled';
        item.error = 'Cancelled';
      }
      // Nothing is going to finish these, so the spinner has to be cleared here
      // rather than by an encode that will now bail out.
      item.encoding = false;
      if (unfinished || !item.outBlob) this.events.onItemChanged(item);
    }
    this.events.onQueueChanged();
  }

  /* ------------------------------------------------------------- settings */

  updateSettings(patch: Partial<Settings>): void {
    const formatChanged = patch.format !== undefined && patch.format !== this.settings.format;
    const patternChanged = patch.namePattern !== undefined && patch.namePattern !== this.settings.namePattern;

    this.settings = { ...this.settings, ...patch };
    this.settingsVersion++;

    if (formatChanged || patternChanged) this.refreshNames();

    for (const item of this.items) {
      if (item.status === 'ready') void this.encode(item);
    }
    this.events.onQueueChanged();
  }

  setOverride(id: string, override: ItemOverride | null): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    item.override = override;
    this.settingsVersion++;
    this.refreshNames();
    if (item.status === 'ready') void this.encode(item);
    this.events.onQueueChanged();
  }

  /** Sets or clears the per-image crop rectangle. */
  setCrop(id: string, crop: CropRect | null): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    item.crop = crop;
    this.settingsVersion++;
    if (item.status === 'ready') void this.encode(item);
    this.events.onQueueChanged();
  }

  setStrippedKeys(id: string, keys: Set<string>): void {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) return;
    item.strippedKeys = keys;
    this.settingsVersion++;
    if (item.status === 'ready') void this.encode(item);
    this.events.onQueueChanged();
  }

  private effectiveFormat(item: QueueItem): OutputFormat {
    return item.override?.format ?? this.settings.format;
  }

  private refreshNames(): void {
    this.items.forEach((item, index) => {
      const stem = applyNamePattern(this.settings.namePattern, {
        original: item.file.name,
        index: index + 1,
        width: item.outWidth || item.srcWidth,
        height: item.outHeight || item.srcHeight,
      });
      item.outName = `${stem}.${formatExtension(this.effectiveFormat(item))}`;
    });
  }

  /* ------------------------------------------------------------ pipeline */

  private fail(item: QueueItem, message: string): void {
    item.status = 'error';
    item.error = message;
    item.encoding = false;
    this.events.onItemChanged(item);
    this.events.onQueueChanged();
  }

  private async process(item: QueueItem): Promise<void> {
    item.status = 'decoding';
    this.events.onItemChanged(item);

    try {
      const buffer = await item.file.arrayBuffer();
      const kind = detectKind(buffer);
      item.kind = kind;

      if (kind === 'unknown') {
        this.fail(item, 'Unsupported file — try HEIC, JPG, PNG or WebP');
        return;
      }

      // Must happen before the buffer is transferred to the worker, which
      // detaches it.
      item.metadata = this.readMetadata(kind, buffer);

      // Only HEIC needs the WASM decoder; the browser already knows the rest,
      // which is faster and avoids loading the decoder at all.
      const bitmap =
        kind === 'heif'
          ? await this.decodeBuffer(item.id, buffer)
          : await this.decodeNatively(item.id, item.file, kind);
      if (isCancelled(item)) return;

      item.srcWidth = bitmap.width;
      item.srcHeight = bitmap.height;
      item.status = 'ready';

      const thumb = await encodeThumbnail(bitmap);
      item.thumbUrl = URL.createObjectURL(thumb);
      this.events.onItemChanged(item);

      // Cancellation can land while the thumbnail is being made; starting an
      // encode now would leave the card spinning forever.
      if (isCancelled(item)) return;
      await this.encode(item);
    } catch (error) {
      if (isCancelled(item)) return;
      this.fail(item, (error as Error).message || 'Could not convert this file');
    }
  }

  private readMetadata(kind: SourceKind, buffer: ArrayBuffer): QueueItem['metadata'] {
    let raw: { exif: Uint8Array | null; icc: Uint8Array | null; xmp: Uint8Array | null };

    if (kind === 'heif') raw = extractHeifMetadata(buffer);
    else if (kind === 'jpeg') raw = extractJpegMetadata(buffer);
    else if (kind === 'png') {
      const png = readPngMetadata(buffer);
      raw = { exif: png.exif, icc: png.icc, xmp: null };
    } else {
      // WebP/GIF/BMP metadata is not read; nothing is claimed that isn't there.
      raw = { exif: null, icc: null, xmp: null };
    }

    return { exif: raw.exif ? parseExif(raw.exif) : null, icc: raw.icc, xmp: raw.xmp };
  }

  private async decodeBuffer(id: string, buffer: ArrayBuffer): Promise<ImageBitmap> {
    const response = await this.pool.decode(buffer);
    if (!response.ok) throw new Error(response.error);
    this.cache.set(id, response.bitmap);
    return response.bitmap;
  }

  /**
   * Browser-native decode for everything except HEIC. `from-image` makes the
   * browser apply the file's own EXIF rotation, matching what libheif does, so
   * both paths hand back upright pixels.
   */
  private async decodeNatively(id: string, file: File, kind: SourceKind): Promise<ImageBitmap> {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      this.cache.set(id, bitmap);
      return bitmap;
    } catch {
      throw new Error(`This ${kindLabel(kind)} file could not be decoded`);
    }
  }

  /** Returns a decoded bitmap, re-decoding from disk if it was evicted. */
  private async getBitmap(item: QueueItem): Promise<ImageBitmap> {
    const cached = this.cache.get(item.id);
    if (cached) return cached;

    const existing = this.inFlightDecodes.get(item.id);
    if (existing) return existing;

    const pending = (async () => {
      if (item.kind !== 'heif') return this.decodeNatively(item.id, item.file, item.kind);
      const buffer = await item.file.arrayBuffer();
      return this.decodeBuffer(item.id, buffer);
    })();

    this.inFlightDecodes.set(item.id, pending);
    try {
      return await pending;
    } finally {
      this.inFlightDecodes.delete(item.id);
    }
  }

  /** Applies the user's metadata choices to a private copy of the EXIF model. */
  private buildExif(item: QueueItem): ExifData | null {
    if (!this.settings.keepExif || !item.metadata.exif) return null;

    const model = cloneExif(item.metadata.exif);
    if (!this.settings.keepGps) removeIfd(model, 'GPS');

    const byIfd = new Map<IfdName, Set<number>>();
    for (const key of item.strippedKeys) {
      const [ifd, tag] = key.split(':');
      const set = byIfd.get(ifd as IfdName) ?? new Set<number>();
      set.add(Number(tag));
      byIfd.set(ifd as IfdName, set);
    }
    for (const [ifd, tags] of byIfd) removeTags(model, ifd, tags);

    return model;
  }

  private async encode(item: QueueItem): Promise<void> {
    if (isCancelled(item)) return;

    const version = this.settingsVersion;
    const generation = this.generation;
    item.encoding = true;
    this.events.onItemChanged(item);

    const release = await this.encodeLimit.acquire();
    try {
      // Settings moved on, or the item was removed or cancelled, while queued.
      if (version !== this.settingsVersion || !this.items.includes(item) || item.status !== 'ready') return;

      const bitmap = await this.getBitmap(item);
      const override = item.override ?? {};

      const result = await encodeImage(bitmap, {
        format: override.format ?? this.settings.format,
        quality: override.quality ?? this.settings.quality,
        resize: this.settings.resize,
        crop: item.crop,
        rotate: this.settings.rotate,
        flipHorizontal: this.settings.flipHorizontal,
        targetBytes: override.targetBytes ?? this.settings.targetBytes,
        metadata: {
          exif: this.buildExif(item),
          icc: this.settings.keepIcc ? item.metadata.icc : null,
          xmp: this.settings.keepXmp ? item.metadata.xmp : null,
        },
      });

      if (version !== this.settingsVersion || !this.items.includes(item)) return;

      item.outBlob = result.blob;
      item.outSize = result.blob.size;
      item.outWidth = result.width;
      item.outHeight = result.height;
      item.qualityUsed = result.qualityUsed;
      item.notes = result.notes;
      this.completedSinceStart++;
    } catch (error) {
      if (item.status === 'ready') this.fail(item, (error as Error).message || 'Encoding failed');
      return;
    } finally {
      release();
      // A superseded encode must not clear the flag — the newer one that
      // replaced it owns the item's state. After a cancel there is no such
      // replacement, so this encode has to clear it itself.
      const superseded = version !== this.settingsVersion;
      const cancelled = generation !== this.generation;
      if ((!superseded || cancelled) && item.status === 'ready') {
        item.encoding = false;
        this.events.onItemChanged(item);
        this.events.onQueueChanged();
      }
    }
  }

  /**
   * Near-lossless render of the source, for the before/after comparison. The
   * grid thumbnail is too compressed to judge quality against.
   */
  async renderSourcePreview(id: string, maxEdge = 1400): Promise<string> {
    const item = this.items.find((entry) => entry.id === id);
    if (!item) throw new Error('File is no longer in the queue');
    const bitmap = await this.getBitmap(item);
    const blob = await encodeThumbnail(bitmap, maxEdge, 0.97);
    return URL.createObjectURL(blob);
  }

  /* ----------------------------------------------------------------- PDF */

  /**
   * PDF embeds JPEG data directly via DCTDecode, so anything currently encoded
   * as PNG or WebP is re-encoded to JPEG for the document.
   */
  async buildPdfDocument(options: PdfOptions): Promise<Blob> {
    const ready = this.readyItems;
    if (ready.length === 0) throw new Error('Nothing to put in the PDF');

    const pages: PdfPageImage[] = [];
    for (const item of ready) {
      let blob = item.outBlob!;
      let width = item.outWidth;
      let height = item.outHeight;

      if (blob.type !== 'image/jpeg') {
        const bitmap = await this.getBitmap(item);
        const override = item.override ?? {};
        const jpeg = await encodeImage(bitmap, {
          format: 'image/jpeg',
          quality: override.quality ?? this.settings.quality,
          resize: this.settings.resize,
          crop: item.crop,
          rotate: this.settings.rotate,
          flipHorizontal: this.settings.flipHorizontal,
          targetBytes: override.targetBytes ?? this.settings.targetBytes,
          metadata: { exif: null, icc: null, xmp: null },
        });
        blob = jpeg.blob;
        width = jpeg.width;
        height = jpeg.height;
      }

      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width, height });
    }

    return buildPdf(pages, options);
  }
}
