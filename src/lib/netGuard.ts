/**
 * Makes the "nothing is uploaded" claim checkable instead of rhetorical.
 *
 * Every outbound API the page could use is wrapped at startup and the bytes
 * they send are counted. The UI shows that number live, so a sceptical visitor
 * can watch it stay at zero while converting — and can confirm it independently
 * in the network panel.
 *
 * This is instrumentation, not a security control: it reports what this page's
 * own code does. The CSP in vercel.json / netlify.toml is what actually
 * constrains where anything could be sent.
 */

interface NetStats {
  bytesSent: number;
  requests: number;
}

const stats: NetStats = { bytesSent: 0, requests: 0 };
const listeners = new Set<(stats: NetStats) => void>();

function notify(): void {
  for (const listener of listeners) listener({ ...stats });
}

function record(bytes: number): void {
  stats.bytesSent += Math.max(0, bytes);
  stats.requests += 1;
  notify();
}

function sizeOf(body: unknown): number {
  if (!body) return 0;
  if (typeof body === 'string') return new Blob([body]).size;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof FormData) {
    let total = 0;
    for (const [key, value] of body.entries()) {
      total += key.length + (typeof value === 'string' ? value.length : value.size);
    }
    return total;
  }
  if (body instanceof URLSearchParams) return body.toString().length;
  return 0;
}

let installed = false;

export function installNetGuard(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(input: RequestInfo | URL, init?: RequestInit) {
    const body = init?.body ?? (input instanceof Request ? undefined : undefined);
    if (body) record(sizeOf(body));
    return originalFetch.call(this, input as RequestInfo, init);
  };

  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null) {
    if (body) record(sizeOf(body));
    return originalSend.call(this, body as XMLHttpRequestBodyInit);
  };

  if (typeof navigator.sendBeacon === 'function') {
    const originalBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function patchedBeacon(url: string | URL, data?: BodyInit | null) {
      record(sizeOf(data));
      return originalBeacon(url, data);
    };
  }

  if (typeof WebSocket !== 'undefined') {
    const OriginalWebSocket = WebSocket;
    const PatchedWebSocket = function (this: WebSocket, url: string | URL, protocols?: string | string[]) {
      const socket = new OriginalWebSocket(url, protocols);
      const originalSocketSend = socket.send.bind(socket);
      socket.send = (data: string | ArrayBufferLike | Blob | ArrayBufferView) => {
        record(sizeOf(data));
        originalSocketSend(data as string);
      };
      return socket;
    } as unknown as typeof WebSocket;
    PatchedWebSocket.prototype = OriginalWebSocket.prototype;
    Object.assign(PatchedWebSocket, {
      CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3,
    });
    window.WebSocket = PatchedWebSocket;
  }
}

export function subscribeNetStats(listener: (stats: NetStats) => void): () => void {
  listeners.add(listener);
  listener({ ...stats });
  return () => listeners.delete(listener);
}

export function getNetStats(): NetStats {
  return { ...stats };
}
