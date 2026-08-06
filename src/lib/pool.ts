import type { DecodeResponse } from '../types';

interface PendingTask {
  buffer: ArrayBuffer;
  resolve: (value: DecodeResponse) => void;
}

/**
 * A pool of decode workers. Each worker handles one file at a time; spinning up
 * more than a handful is counterproductive because libheif is CPU-bound and
 * each instance carries its own ~1.4MB wasm heap.
 *
 * Workers are created lazily, so a visitor who never converts anything never
 * pays to instantiate the wasm module at all.
 */
export class DecodePool {
  private readonly workers = new Set<Worker>();
  private readonly idle: Worker[] = [];
  private readonly queue: PendingTask[] = [];
  /** Tasks handed to a worker but not yet answered, so cancel() can settle them. */
  private readonly inFlight = new Map<Worker, PendingTask>();
  private nextId = 1;

  constructor(private readonly size: number) {}

  /** Transfers `buffer` to a worker — the caller must not reuse it afterwards. */
  decode(buffer: ArrayBuffer): Promise<DecodeResponse> {
    return new Promise((resolve) => {
      this.queue.push({ buffer, resolve });
      this.pump();
    });
  }

  private spawn(): Worker {
    // Vite requires these options to be statically analyzable — no template
    // literals or computed values in here.
    const worker = new Worker(new URL('../worker/decode.worker.ts', import.meta.url), {
      type: 'module',
      name: 'heic-decode',
    });
    this.workers.add(worker);
    return worker;
  }

  /** An idle worker, a newly spawned one, or null when the pool is saturated. */
  private take(): Worker | null {
    if (this.idle.length > 0) return this.idle.pop()!;
    if (this.workers.size < this.size) return this.spawn();
    return null;
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const worker = this.take();
      if (!worker) return;

      const task = this.queue.shift()!;
      const id = this.nextId++;

      const cleanup = () => {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        this.inFlight.delete(worker);
        // A worker killed by cancel() must not be handed out again.
        if (this.workers.has(worker)) this.idle.push(worker);
        this.pump();
      };

      const onMessage = (event: MessageEvent<DecodeResponse>) => {
        if (event.data.id !== id) return;
        cleanup();
        task.resolve(event.data);
      };

      const onError = (event: ErrorEvent) => {
        cleanup();
        task.resolve({ id, ok: false, error: event.message || 'Decode worker crashed' });
      };

      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      this.inFlight.set(worker, task);
      worker.postMessage({ id, buffer: task.buffer }, [task.buffer]);
    }
  }

  /**
   * Abandons everything in flight. Terminating is the only way to interrupt a
   * decode already running inside the wasm module, so queued work is rejected
   * and the workers are torn down; the pool respawns lazily afterwards.
   */
  cancel(): void {
    for (const task of this.queue.splice(0)) {
      task.resolve({ id: -1, ok: false, error: 'Cancelled' });
    }
    // A terminated worker never answers, so anything already dispatched has to
    // be settled here or its promise would hang forever, pinning the buffer.
    for (const task of this.inFlight.values()) {
      task.resolve({ id: -1, ok: false, error: 'Cancelled' });
    }
    this.inFlight.clear();

    for (const worker of this.workers) worker.terminate();
    this.workers.clear();
    this.idle.length = 0;
  }

  terminate(): void {
    this.cancel();
  }
}
