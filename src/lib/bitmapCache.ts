/**
 * Decoded bitmaps are kept so that changing a setting re-encodes instantly
 * instead of re-running the (much slower) HEIC decode. A 12MP photo costs ~48MB
 * as RGBA, so the cache is bounded and evicts least-recently-used entries.
 * Evicted files are decoded again on demand — the original `File` objects stay
 * on disk and cost nothing to hold.
 */
interface Entry {
  bitmap: ImageBitmap;
  bytes: number;
}

export class BitmapCache {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;

  constructor(private budget: number) {}

  get size(): number {
    return this.bytes;
  }

  get(id: string): ImageBitmap | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    // Re-insert to mark as most recently used.
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.bitmap;
  }

  set(id: string, bitmap: ImageBitmap): void {
    this.delete(id);
    const bytes = bitmap.width * bitmap.height * 4;
    this.entries.set(id, { bitmap, bytes });
    this.bytes += bytes;
    this.evict(this.budget);
  }

  delete(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.bitmap.close();
    this.bytes -= entry.bytes;
    this.entries.delete(id);
  }

  clear(): void {
    for (const entry of this.entries.values()) entry.bitmap.close();
    this.entries.clear();
    this.bytes = 0;
  }

  /**
   * Releases memory under pressure — used when the tab is backgrounded, where
   * holding hundreds of megabytes is the fastest way to get the tab killed on
   * a phone.
   */
  trim(factor: number): void {
    this.evict(this.budget * Math.max(0, Math.min(1, factor)));
  }

  private evict(limit: number): void {
    // Always keep at least one entry, even if a single image blows the budget.
    while (this.bytes > limit && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.delete(oldest);
    }
  }
}
