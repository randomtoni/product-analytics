import { defineTaxonomy } from 'analytics-kit';
import type { NeutralEvent } from 'analytics-kit';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NodeAnalyticsClient, type SendBatch } from './node-analytics';

const taxonomy = defineTaxonomy({
  events: {
    order_placed: { amount: 'number' },
    logged_out: {},
  },
});

// The delivery seam observed by tests: a spy that flattens every delivered batch into
// a single stream of events. The size-triggered flush is deferred (a 0ms timer), so a
// test advances timers after a capture to observe the delivered events.
function collectingSend() {
  const batches: NeutralEvent[][] = [];
  const send: SendBatch = async (batch) => {
    batches.push(batch);
  };
  return {
    send,
    batches,
    get delivered(): NeutralEvent[] {
      return batches.flat();
    },
  };
}

// flushAt: 1 so each capture size-triggers immediately; the content of the minted event
// is what these client-level tests assert (queue timing is covered in batch-queue.test.ts).
function keyedClient(overrides = {}) {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 1, ...overrides },
    sink.send
  );
  return { client, sink };
}

// Drive the deferred size-flush to completion so `sink.delivered` reflects the captures.
function flush(): void {
  vi.advanceTimersByTime(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('capture with props mints a NeutralEvent stamped with distinctId/event/properties/timestamp', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 42 });
  flush();

  const [event] = sink.delivered;
  expect(event.distinctId).toBe('user-1');
  expect(event.event).toBe('order_placed');
  expect(event.properties).toEqual({ amount: 42 });
  expect(event.timestamp).toBeInstanceOf(Date);
});

test('a no-props event captures with no properties bag', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'logged_out');
  flush();

  const [event] = sink.delivered;
  expect(event.event).toBe('logged_out');
  expect(event.properties).toBeUndefined();
});

// --- dedupeId: mint vs caller-supplied ---

test('no caller dedupeId → NeutralEvent.dedupeId is populated (minted)', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 });
  flush();

  const [event] = sink.delivered;
  expect(typeof event.dedupeId).toBe('string');
  expect(event.dedupeId.length).toBeGreaterThan(0);
});

test('two minted dedupeIds are distinct (retry substrate)', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 });
  client.capture('user-1', 'order_placed', { amount: 2 });
  flush();

  const [a, b] = sink.delivered;
  expect(a.dedupeId).not.toBe(b.dedupeId);
});

test('caller dedupeId with props → carried onto NeutralEvent.dedupeId verbatim', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 }, { dedupeId: 'dd-props' });
  flush();

  const [event] = sink.delivered;
  expect(event.dedupeId).toBe('dd-props');
});

test('caller dedupeId on a no-props event → carried verbatim (arg3 is the options bag)', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'logged_out', { dedupeId: 'dd-noprops' });
  flush();

  const [event] = sink.delivered;
  expect(event.event).toBe('logged_out');
  expect(event.dedupeId).toBe('dd-noprops');
  expect(event.properties).toBeUndefined();
});

test('a no-props event with no options still mints a dedupeId', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'logged_out');
  flush();

  const [event] = sink.delivered;
  expect(typeof event.dedupeId).toBe('string');
  expect(event.dedupeId.length).toBeGreaterThan(0);
});

// --- distinctId required (runtime is enforced by the type; assert it lands verbatim) ---

test('distinctId is the exact first-arg value on the minted event', () => {
  const { client, sink } = keyedClient();

  client.capture('acct-server-actor', 'order_placed', { amount: 1 });
  flush();

  const [event] = sink.delivered;
  expect(event.distinctId).toBe('acct-server-actor');
});

// --- server-side allowlist gate (bar A) ---

// The off-list bag is assembled behind a widening so the runtime guard — not the compiler —
// is what rejects it (the compile-time rejection is pinned in typing.test.ts).
const offListProps = { amount: 1, rogue: 'x' } as { amount: number };

test('off-list props key throws under the default throw policy — nothing minted', () => {
  const { client, sink } = keyedClient();

  expect(() => client.capture('user-1', 'order_placed', offListProps)).toThrow(
    /not on the payload allowlist/
  );
  flush();
  expect(sink.delivered).toHaveLength(0);
});

test('off-list props key under drop-and-error-log drops the event and logs — nothing minted', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { client, sink } = keyedClient({ onViolation: 'drop-and-error-log' });

  client.capture('user-1', 'order_placed', offListProps);
  flush();

  expect(sink.delivered).toHaveLength(0);
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('not on the payload allowlist'));
});

test('an on-list props key passes the gate and is minted', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 99 });
  flush();

  expect(sink.delivered).toHaveLength(1);
});

test('an explicit consumer allowlist gates server capture too', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', allowlist: ['amount'], flushAt: 1 }, sink.send);

  client.capture('user-1', 'order_placed', { amount: 1 });
  flush();
  expect(sink.delivered).toHaveLength(1);

  expect(() => client.capture('user-1', 'order_placed', { rogue: 'x' })).toThrow(
    /not on the payload allowlist/
  );
});

test('with no taxonomy and no allowlist, every prop is allowed (undefined allowlist)', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', flushAt: 1 }, sink.send);

  client.capture('user-1', 'anything', { whatever: true });
  flush();
  expect(sink.delivered).toHaveLength(1);
});

// --- browser-only NeutralEvent fields stay unset ---

test('server-minted NeutralEvent leaves isPageView/sessionId/enrichmentProfile unset', () => {
  const { client, sink } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 });
  flush();

  const [event] = sink.delivered;
  expect(event.isPageView).toBeUndefined();
  expect(event.sessionId).toBeUndefined();
  expect(event.enrichmentProfile).toBeUndefined();
});

// --- config threads the queue knobs into the client ---

test('config.flushAt threads into the queue: a flushAt-sized burst delivers, sub-flushAt does not', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient({ key: 'k', taxonomy, flushAt: 3 }, sink.send);

  client.capture('u', 'order_placed', { amount: 1 });
  client.capture('u', 'order_placed', { amount: 2 });
  flush();
  expect(sink.batches).toHaveLength(0);

  client.capture('u', 'order_placed', { amount: 3 });
  flush();
  expect(sink.batches).toHaveLength(1);
  expect(sink.delivered).toHaveLength(3);
});

test('config.flushInterval threads into the queue: a sub-flushAt buffer delivers after the interval', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 20, flushInterval: 500 },
    sink.send
  );

  client.capture('u', 'order_placed', { amount: 1 });
  expect(sink.batches).toHaveLength(0);

  vi.advanceTimersByTime(500);
  expect(sink.batches).toHaveLength(1);
  expect(sink.delivered).toHaveLength(1);
});

test('config.maxBatchSize threads into the queue: a deep buffer slices per delivery', () => {
  const sink = collectingSend();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, flushAt: 5, maxBatchSize: 2 },
    sink.send
  );

  for (let i = 0; i < 5; i++) {
    client.capture('u', 'order_placed', { amount: i });
  }
  flush();

  expect(sink.batches.map((b) => b.length)).toEqual([2, 2, 1]);
});

// --- lifecycle skeletons resolve (real bodies E7-S6) ---

test('flush() and shutdown() are async no-op skeletons that resolve', async () => {
  const { client } = keyedClient();

  await expect(client.flush()).resolves.toBeUndefined();
  await expect(client.shutdown()).resolves.toBeUndefined();
});

// --- zero browser coupling ---

test('node source imports nothing from @analytics-kit/browser', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const browserPkg = ['@analytics-kit', 'browser'].join('/');
  const files = readdirSync(__dirname).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts')
  );
  for (const file of files) {
    const contents = readFileSync(join(__dirname, file), 'utf8');
    expect(contents).not.toContain(browserPkg);
  }
});
