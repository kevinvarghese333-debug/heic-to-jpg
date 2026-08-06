import { Zip, ZipPassThrough } from 'fflate';

export interface ZipEntry {
  name: string;
  blob: Blob;
}

export type ZipProgress = (done: number, total: number) => void;

interface SaveFilePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: Array<{ description: string; accept: Record<string, string[]> }>;
  }) => Promise<FileSystemFileHandle>;
}

export function canStreamToDisk(): boolean {
  return typeof (window as SaveFilePickerWindow).showSaveFilePicker === 'function';
}

/**
 * Feeds entries into a streaming ZIP writer one at a time, so only a single
 * source blob is ever held in memory alongside the output.
 */
async function pump(
  entries: ZipEntry[],
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  onProgress?: ZipProgress,
): Promise<void> {
  const pending: Array<Uint8Array> = [];
  let failure: Error | null = null;
  let finished = false;

  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure = error;
      return;
    }
    if (chunk && chunk.length > 0) pending.push(chunk);
    if (final) finished = true;
  });

  const drain = async (): Promise<void> => {
    while (pending.length > 0) {
      const chunk = pending.shift()!;
      await onChunk(chunk);
    }
  };

  for (let i = 0; i < entries.length; i++) {
    if (failure) throw failure;

    const entry = entries[i];
    // ZipPassThrough stores bytes verbatim — exactly what we want, since JPEG
    // data is already compressed and deflating it wastes seconds for nothing.
    const file = new ZipPassThrough(entry.name);
    zip.add(file);

    // Read in slices so a very large image never lands in memory whole.
    const CHUNK = 4 * 1024 * 1024;
    const size = entry.blob.size;
    for (let offset = 0; offset < size; offset += CHUNK) {
      const slice = entry.blob.slice(offset, Math.min(offset + CHUNK, size));
      const bytes = new Uint8Array(await slice.arrayBuffer());
      file.push(bytes, false);
      await drain();
    }
    file.push(new Uint8Array(0), true);
    await drain();

    onProgress?.(i + 1, entries.length);
  }

  zip.end();
  await drain();

  if (failure) throw failure;
  if (!finished) await drain();
}

/**
 * Outcome of a streamed save. `cancelled` and `unsupported` are deliberately
 * distinct: dismissing the save dialog means the user does not want the file,
 * so falling back to a normal download would be the wrong thing to do.
 */
export type StreamOutcome = 'saved' | 'cancelled' | 'unsupported';

/**
 * Writes the archive straight to a file the user picks, so a very large batch
 * never has to fit in memory.
 */
export async function streamZipToDisk(
  entries: ZipEntry[],
  suggestedName: string,
  onProgress?: ZipProgress,
): Promise<StreamOutcome> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (!picker) return 'unsupported';

  let handle: FileSystemFileHandle;
  try {
    handle = await picker({
      suggestedName,
      types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
    });
  } catch (error) {
    // AbortError means the user dismissed the dialog. Anything else (a
    // SecurityError inside an iframe, a missing user gesture) means the API is
    // unusable here and the caller should fall back.
    return (error as DOMException)?.name === 'AbortError' ? 'cancelled' : 'unsupported';
  }

  const writable = await handle.createWritable();
  try {
    await pump(entries, (chunk) => writable.write(chunk as unknown as FileSystemWriteChunkType), onProgress);
    await writable.close();
    return 'saved';
  } catch (error) {
    await writable.abort().catch(() => undefined);
    throw error;
  }
}

/** In-memory fallback for browsers without the File System Access API. */
export async function buildZip(entries: ZipEntry[], onProgress?: ZipProgress): Promise<Blob> {
  const chunks: Uint8Array[] = [];
  await pump(entries, (chunk) => void chunks.push(chunk), onProgress);
  return new Blob(chunks as unknown as BlobPart[], { type: 'application/zip' });
}
