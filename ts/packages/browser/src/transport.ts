import type { NeutralFetchResponse } from '@randomtoni/analytics-kit';

// Adapter-internal transport primitives, de-branded from the reference request.ts.
// A pure utility layer: runtime feature-detection of each transport, the keepalive
// size threshold, an XHR POST that resolves the neutral response shape, and a
// best-effort sendBeacon. It knows nothing about the wire envelope, the ingest URL,
// or the neutral surface — the adapter orchestrates which transport runs and what
// body each consumes. Transport selection never reaches the neutral surface.

// fetch keepalive errors when the body exceeds 64KB, so the threshold sits below
// that (64*1024*0.8 ≈ 52KB) to leave headroom for request overhead. Keepalive is an
// opportunistic best-effort flag that helps delivery while a page is closing; it is
// only ever set on a POST whose encoded body is under this cap.
export const KEEPALIVE_THRESHOLD_BYTES = 64 * 1024 * 0.8;

// Runtime feature-detects. The symbols are typed under lib:["ES2022","DOM"], but they
// may be absent at runtime (SSR, React Native, an old browser) — so presence is a
// runtime concern, probed here rather than type-guarded.
export function hasFetch(): boolean {
  return typeof fetch !== 'undefined';
}

export function hasXhr(): boolean {
  return typeof XMLHttpRequest !== 'undefined';
}

export function hasSendBeacon(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function';
}

export interface XhrRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string | ArrayBuffer;
}

// POST via XMLHttpRequest, resolving the neutral response shape so the adapter's
// retry wrapper reads the same `status`/`text()`/`json()` surface it gets from the
// fetch SPI. A network-level failure (status 0) resolves rather than rejects — the
// retry decision is the adapter's, keyed off the status, exactly as the fetch path.
export function postViaXhr(url: string, request: XhrRequest): Promise<NeutralFetchResponse> {
  return new Promise((resolve) => {
    const req = new XMLHttpRequest();
    req.open('POST', url, true);
    for (const [name, value] of Object.entries(request.headers)) {
      req.setRequestHeader(name, value);
    }
    req.onreadystatechange = () => {
      if (req.readyState !== 4) {
        return;
      }
      const text = req.responseText;
      resolve({
        status: req.status,
        text: async () => text,
        json: async () => JSON.parse(text) as unknown,
      });
    };
    req.send(request.body);
  });
}

// Best-effort, fire-and-forget beacon send for the unload window. sendBeacon takes a
// Blob so the Content-Type is set correctly (a bare string/ArrayBuffer can arrive with
// no type, which some proxies reject); the caller supplies the already-encoded body and
// its [WIRE] content type. Never throws — a failed beacon on a closing page is swallowed.
export function beaconSend(url: string, body: string | Uint8Array, contentType: string): boolean {
  try {
    if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
      return false;
    }
    // Copy binary bytes into a fresh (non-shared) ArrayBuffer so the BlobPart is a plain
    // buffer; a string is a BlobPart as-is.
    const part: BlobPart = typeof body === 'string' ? body : (body.slice().buffer as ArrayBuffer);
    const blob = new Blob([part], { type: contentType });
    return navigator.sendBeacon(url, blob);
  } catch {
    return false;
  }
}
