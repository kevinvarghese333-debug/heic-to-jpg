/**
 * Runtime capability detection.
 *
 * Two jobs: refuse to show a broken page on a browser that cannot run the
 * decoder, and size the worker pool and bitmap cache to the actual device
 * rather than assuming a laptop.
 */

export type OutputFormat = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/avif';

export interface Capabilities {
  supported: boolean;
  /** Human-readable names of the missing features, for the fallback message */
  missing: string[];
  isMobile: boolean;
  deviceMemoryGb: number | null;
  workerCount: number;
  bitmapBudgetBytes: number;
}

interface DeviceMemoryNavigator extends Navigator {
  deviceMemory?: number;
}

function detectMobile(): boolean {
  if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) {
    // A coarse pointer plus a narrow screen is a phone or small tablet.
    return Math.min(screen.width, screen.height) < 820;
  }
  return navigator.maxTouchPoints > 1 && Math.min(screen.width, screen.height) < 820;
}

export function detectCapabilities(): Capabilities {
  const missing: string[] = [];

  if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
  if (typeof Worker === 'undefined') missing.push('Web Workers');
  if (typeof createImageBitmap !== 'function') missing.push('createImageBitmap');
  if (typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') {
    missing.push('Blob URLs');
  }

  // Note: OffscreenCanvas is deliberately not required — encode.ts falls back
  // to a regular canvas element, which keeps Safari 15 working.

  const isMobile = detectMobile();
  const deviceMemoryGb = (navigator as DeviceMemoryNavigator).deviceMemory ?? null;

  // deviceMemory is Chromium-only and absent on iOS Safari — the single most
  // likely device to be holding HEIC files — so there is always a fallback.
  const assumedGb = deviceMemoryGb ?? (isMobile ? 3 : 8);

  // Roughly a fifth of RAM, so the tab has room for everything else.
  const rawBudget = assumedGb * 1024 * 1024 * 1024 * 0.2;
  const ceiling = isMobile ? 260 * 1024 * 1024 : 700 * 1024 * 1024;
  const bitmapBudgetBytes = Math.max(120 * 1024 * 1024, Math.min(rawBudget, ceiling));

  const cores = navigator.hardwareConcurrency || 4;
  const workerCount = Math.max(1, Math.min(isMobile ? 2 : 4, cores - 1));

  return {
    supported: missing.length === 0,
    missing,
    isMobile,
    deviceMemoryGb,
    workerCount,
    bitmapBudgetBytes,
  };
}

const FORMAT_LABELS: Record<OutputFormat, string> = {
  'image/jpeg': 'JPG',
  'image/png': 'PNG',
  'image/webp': 'WebP',
  'image/avif': 'AVIF',
};

export function formatLabel(format: OutputFormat): string {
  return FORMAT_LABELS[format];
}

export function formatExtension(format: OutputFormat): string {
  return format === 'image/jpeg' ? 'jpg' : format.slice('image/'.length);
}

/**
 * Asks the browser which formats it can actually *encode*. Support is uneven —
 * notably AVIF encoding is Chromium-only — and a silent fallback to PNG would
 * be worse than not offering the option.
 */
export async function detectEncodableFormats(): Promise<Set<OutputFormat>> {
  const candidates: OutputFormat[] = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  const supported = new Set<OutputFormat>();

  for (const format of candidates) {
    try {
      let blob: Blob | null = null;
      if (typeof OffscreenCanvas !== 'undefined') {
        const canvas = new OffscreenCanvas(4, 4);
        canvas.getContext('2d');
        blob = await canvas.convertToBlob({ type: format });
      } else {
        const canvas = document.createElement('canvas');
        canvas.width = 4;
        canvas.height = 4;
        canvas.getContext('2d');
        blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format));
      }
      // Browsers silently substitute PNG when they can't honour the request.
      if (blob && blob.type === format) supported.add(format);
    } catch {
      /* unsupported */
    }
  }

  supported.add('image/jpeg');
  supported.add('image/png');
  return supported;
}
