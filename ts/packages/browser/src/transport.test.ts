import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  beaconSend,
  hasFetch,
  hasSendBeacon,
  hasXhr,
  KEEPALIVE_THRESHOLD_BYTES,
  postViaXhr,
} from './transport';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('feature detection', () => {
  test('hasFetch reflects the runtime presence of fetch', () => {
    // jsdom provides fetch by default.
    expect(hasFetch()).toBe(true);
    vi.stubGlobal('fetch', undefined);
    expect(hasFetch()).toBe(false);
  });

  test('hasXhr reflects the runtime presence of XMLHttpRequest', () => {
    expect(hasXhr()).toBe(true);
    vi.stubGlobal('XMLHttpRequest', undefined);
    expect(hasXhr()).toBe(false);
  });

  test('hasSendBeacon reflects navigator.sendBeacon being a function', () => {
    vi.stubGlobal('navigator', { sendBeacon: () => true });
    expect(hasSendBeacon()).toBe(true);

    vi.stubGlobal('navigator', {});
    expect(hasSendBeacon()).toBe(false);

    vi.stubGlobal('navigator', undefined);
    expect(hasSendBeacon()).toBe(false);
  });
});

describe('keepalive threshold', () => {
  test('is 64*1024*0.8 (~52 KB)', () => {
    expect(KEEPALIVE_THRESHOLD_BYTES).toBe(64 * 1024 * 0.8);
  });
});

describe('postViaXhr', () => {
  // A minimal fake XHR that captures the request and lets the test drive readyState.
  class FakeXhr {
    static last: FakeXhr | undefined;
    method = '';
    url = '';
    readonly requestHeaders: Record<string, string> = {};
    body: string | ArrayBuffer | undefined;
    readyState = 0;
    status = 0;
    responseText = '';
    onreadystatechange: (() => void) | null = null;

    constructor() {
      FakeXhr.last = this;
    }
    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string): void {
      this.requestHeaders[name] = value;
    }
    send(body: string | ArrayBuffer): void {
      this.body = body;
    }
    complete(status: number, responseText: string): void {
      this.status = status;
      this.responseText = responseText;
      this.readyState = 4;
      this.onreadystatechange?.();
    }
  }

  test('POSTs the body with headers and resolves the neutral response on readyState 4', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const promise = postViaXhr('https://x.example/batch/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"data":[]}',
    });

    const req = FakeXhr.last!;
    expect(req.method).toBe('POST');
    expect(req.url).toBe('https://x.example/batch/');
    expect(req.requestHeaders['Content-Type']).toBe('application/json');
    expect(req.body).toBe('{"data":[]}');

    req.complete(200, '{"ok":true}');
    const response = await promise;
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(await response.json()).toEqual({ ok: true });
  });

  test('resolves (not rejects) a status-0 network failure so the adapter reads the status', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const promise = postViaXhr('https://x.example/batch/', {
      method: 'POST',
      headers: {},
      body: '{}',
    });
    FakeXhr.last!.complete(0, '');
    const response = await promise;
    expect(response.status).toBe(0);
  });
});

describe('beaconSend', () => {
  test('sends a Blob with the [WIRE] content type for a string body and returns true', () => {
    const sent: { url: string; blob: Blob }[] = [];
    vi.stubGlobal('navigator', {
      sendBeacon: (url: string, blob: Blob) => {
        sent.push({ url, blob });
        return true;
      },
    });

    const ok = beaconSend('https://x.example/batch/', '{"data":[]}', 'application/json');

    expect(ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe('https://x.example/batch/');
    expect(sent[0].blob).toBeInstanceOf(Blob);
    expect(sent[0].blob.type).toBe('application/json');
  });

  test('wraps a Uint8Array (gzip) body in a Blob with the gzip content type', async () => {
    const sent: Blob[] = [];
    vi.stubGlobal('navigator', {
      sendBeacon: (_url: string, blob: Blob) => {
        sent.push(blob);
        return true;
      },
    });

    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    beaconSend('https://x.example/batch/', bytes, 'text/plain');

    // The binary body rides as a Blob with the gzip [WIRE] content type. jsdom's Blob
    // does not round-trip binary bytes reliably, so assert on the observable Blob
    // metadata: the gzip byte length is preserved and the content type is text/plain.
    expect(sent[0].type).toBe('text/plain');
    expect(sent[0].size).toBe(bytes.byteLength);
  });

  test('returns false (does not throw) when sendBeacon is absent', () => {
    vi.stubGlobal('navigator', {});
    expect(beaconSend('https://x.example/batch/', '{}', 'application/json')).toBe(false);
  });

  test('swallows a sendBeacon throw and returns false (best-effort on a closing page)', () => {
    vi.stubGlobal('navigator', {
      sendBeacon: () => {
        throw new Error('beacon rejected');
      },
    });
    expect(beaconSend('https://x.example/batch/', '{}', 'application/json')).toBe(false);
  });
});
