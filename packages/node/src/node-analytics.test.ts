import { defineTaxonomy } from 'analytics-kit';
import { expect, test, vi } from 'vitest';
import { InMemoryEventBuffer } from './event-buffer';
import { NodeAnalyticsClient } from './node-analytics';

const taxonomy = defineTaxonomy({
  events: {
    order_placed: { amount: 'number' },
    logged_out: {},
  },
});

function keyedClient(overrides = {}) {
  const buffer = new InMemoryEventBuffer();
  const client = new NodeAnalyticsClient(
    { key: 'k', taxonomy, ...overrides },
    buffer
  );
  return { client, buffer };
}

test('capture with props mints a NeutralEvent stamped with distinctId/event/properties/timestamp', () => {
  const { client, buffer } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 42 });

  const [event] = buffer.drain();
  expect(event.distinctId).toBe('user-1');
  expect(event.event).toBe('order_placed');
  expect(event.properties).toEqual({ amount: 42 });
  expect(event.timestamp).toBeInstanceOf(Date);
});

test('a no-props event captures with no properties bag', () => {
  const { client, buffer } = keyedClient();

  client.capture('user-1', 'logged_out');

  const [event] = buffer.drain();
  expect(event.event).toBe('logged_out');
  expect(event.properties).toBeUndefined();
});

// --- dedupeId: mint vs caller-supplied ---

test('no caller dedupeId → NeutralEvent.dedupeId is populated (minted)', () => {
  const { client, buffer } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 });

  const [event] = buffer.drain();
  expect(typeof event.dedupeId).toBe('string');
  expect(event.dedupeId.length).toBeGreaterThan(0);
});

test('two minted dedupeIds are distinct (retry substrate)', () => {
  const { client, buffer } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 });
  client.capture('user-1', 'order_placed', { amount: 2 });

  const [a, b] = buffer.drain();
  expect(a.dedupeId).not.toBe(b.dedupeId);
});

test('caller dedupeId with props → carried onto NeutralEvent.dedupeId verbatim', () => {
  const { client, buffer } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 }, { dedupeId: 'dd-props' });

  const [event] = buffer.drain();
  expect(event.dedupeId).toBe('dd-props');
});

test('caller dedupeId on a no-props event → carried verbatim (arg3 is the options bag)', () => {
  const { client, buffer } = keyedClient();

  client.capture('user-1', 'logged_out', { dedupeId: 'dd-noprops' });

  const [event] = buffer.drain();
  expect(event.event).toBe('logged_out');
  expect(event.dedupeId).toBe('dd-noprops');
  expect(event.properties).toBeUndefined();
});

test('a no-props event with no options still mints a dedupeId', () => {
  const { client, buffer } = keyedClient();

  client.capture('user-1', 'logged_out');

  const [event] = buffer.drain();
  expect(typeof event.dedupeId).toBe('string');
  expect(event.dedupeId.length).toBeGreaterThan(0);
});

// --- distinctId required (runtime is enforced by the type; assert it lands verbatim) ---

test('distinctId is the exact first-arg value on the minted event', () => {
  const { client, buffer } = keyedClient();

  client.capture('acct-server-actor', 'order_placed', { amount: 1 });

  const [event] = buffer.drain();
  expect(event.distinctId).toBe('acct-server-actor');
});

// --- server-side allowlist gate (bar A) ---

// The off-list bag is assembled behind a widening so the runtime guard — not the compiler —
// is what rejects it (the compile-time rejection is pinned in typing.test.ts).
const offListProps = { amount: 1, rogue: 'x' } as { amount: number };

test('off-list props key throws under the default throw policy — nothing minted', () => {
  const { client, buffer } = keyedClient();

  expect(() => client.capture('user-1', 'order_placed', offListProps)).toThrow(
    /not on the payload allowlist/
  );
  expect(buffer.drain()).toHaveLength(0);
});

test('off-list props key under drop-and-error-log drops the event and logs — nothing minted', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { client, buffer } = keyedClient({ onViolation: 'drop-and-error-log' });

  client.capture('user-1', 'order_placed', offListProps);

  expect(buffer.drain()).toHaveLength(0);
  expect(spy).toHaveBeenCalledWith(expect.stringContaining('not on the payload allowlist'));
});

test('an on-list props key passes the gate and is minted', () => {
  const { client, buffer } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 99 });

  expect(buffer.drain()).toHaveLength(1);
});

test('an explicit consumer allowlist gates server capture too', () => {
  const buffer = new InMemoryEventBuffer();
  const client = new NodeAnalyticsClient({ key: 'k', allowlist: ['amount'] }, buffer);

  client.capture('user-1', 'order_placed', { amount: 1 });
  expect(buffer.drain()).toHaveLength(1);

  expect(() => client.capture('user-1', 'order_placed', { rogue: 'x' })).toThrow(
    /not on the payload allowlist/
  );
});

test('with no taxonomy and no allowlist, every prop is allowed (undefined allowlist)', () => {
  const buffer = new InMemoryEventBuffer();
  const client = new NodeAnalyticsClient({ key: 'k' }, buffer);

  client.capture('user-1', 'anything', { whatever: true });
  expect(buffer.drain()).toHaveLength(1);
});

// --- browser-only NeutralEvent fields stay unset ---

test('server-minted NeutralEvent leaves isPageView/sessionId/enrichmentProfile unset', () => {
  const { client, buffer } = keyedClient();

  client.capture('user-1', 'order_placed', { amount: 1 });

  const [event] = buffer.drain();
  expect(event.isPageView).toBeUndefined();
  expect(event.sessionId).toBeUndefined();
  expect(event.enrichmentProfile).toBeUndefined();
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
