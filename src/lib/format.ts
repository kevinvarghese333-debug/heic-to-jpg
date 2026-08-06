export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 KB';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

/** Strips the HEIC-family extension, leaving the bare stem. */
export function baseName(filename: string): string {
  return filename.replace(/\.(heic|heif|hif|avif)$/i, '');
}

export interface NameContext {
  original: string;
  /** 1-based position in the batch */
  index: number;
  width: number;
  height: number;
}

/**
 * Expands a batch rename pattern.
 *
 * Supported tokens: {name} {n} {n:3} {date} {w} {h}. An empty pattern keeps the
 * original stem.
 */
export function applyNamePattern(pattern: string, context: NameContext): string {
  const stem = baseName(context.original);
  if (!pattern.trim()) return stem;

  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const expanded = pattern.replace(/\{(name|n|date|w|h)(?::(\d+))?\}/gi, (_match, token: string, pad?: string) => {
    switch (token.toLowerCase()) {
      case 'name':
        return stem;
      case 'n':
        return pad ? String(context.index).padStart(Number(pad), '0') : String(context.index);
      case 'date':
        return date;
      case 'w':
        return String(context.width);
      case 'h':
        return String(context.height);
      default:
        return '';
    }
  });

  // Strip characters that are illegal in filenames on common platforms.
  const cleaned = expanded.replace(/[/\\?%*:|"<>]/g, '-').trim();
  return cleaned || stem;
}

/** Appends " (2)", " (3)" … so an archive never contains duplicate entry names. */
export function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const key = name.toLowerCase();
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    if (count === 0) return name;

    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${base} (${count + 1})${ext}`;
  });
}

export function percentChange(from: number, to: number): string {
  if (from <= 0) return '';
  const delta = Math.round(((to - from) / from) * 100);
  if (delta === 0) return 'same size';
  return delta < 0 ? `${Math.abs(delta)}% smaller` : `${delta}% larger`;
}

/** Parses "500kb", "2 MB", "1.5m" into bytes. Returns 0 when unparseable. */
export function parseSize(input: string): number {
  const match = input.trim().match(/^([\d.]+)\s*(k|kb|m|mb|b)?$/i);
  if (!match) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 0;

  const unit = (match[2] ?? 'kb').toLowerCase();
  if (unit === 'b') return Math.round(value);
  if (unit === 'm' || unit === 'mb') return Math.round(value * 1024 * 1024);
  return Math.round(value * 1024);
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
