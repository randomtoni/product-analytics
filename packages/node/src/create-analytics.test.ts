import { defineTaxonomy } from 'analytics-kit';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createAnalytics } from './create-analytics';
import { NodeNoop } from './node-noop';
import { NodeAnalyticsClient } from './node-analytics';

const taxonomy = defineTaxonomy({
  events: { order_placed: { amount: 'number' }, logged_out: {} },
  traits: { plan: 'string' },
  groups: { company: { name: 'string' } },
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a keyed config yields the real client', () => {
  const client = createAnalytics({ key: 'k', taxonomy, ingestHost: 'https://ingest.example' });
  expect(client).toBeInstanceOf(NodeAnalyticsClient);
});

// --- unkeyed ⇒ whole-stack silent no-op (bar B) ---

test('an unkeyed config yields the NodeNoop null-object client', () => {
  const client = createAnalytics({ taxonomy });
  expect(client).toBeInstanceOf(NodeNoop);
});

test('unkeyed: capture/setTraits/setGroupTraits accept calls and never hit the transport (bar B)', async () => {
  // Inject a fetch spy so we can prove NOTHING reaches transport across the whole stack.
  const fetchSpy = vi.fn(async () => ({ status: 200 }));
  const client = createAnalytics({
    taxonomy,
    ingestHost: 'https://ingest.example',
    fetch: fetchSpy as never,
  });

  client.capture('u', 'order_placed', { amount: 1 });
  client.capture('u', 'logged_out');
  client.setTraits('u', { plan: 'pro' });
  client.setGroupTraits('company', 'acme', { name: 'Acme' });

  // Advance past any conceivable flush interval — a no-op never arms a timer.
  await vi.advanceTimersByTimeAsync(100000);

  expect(fetchSpy).not.toHaveBeenCalled();
});

test('unkeyed: flush() and shutdown() resolve immediately without blocking', async () => {
  const client = createAnalytics({ taxonomy });

  await expect(client.flush()).resolves.toBeUndefined();
  await expect(client.shutdown()).resolves.toBeUndefined();
});

test('unkeyed: an off-list prop does NOT throw — the no-op accepts every call inertly', () => {
  const client = createAnalytics({ taxonomy });

  // The real client would throw here (bar A); the no-op never runs the allowlist gate.
  expect(() =>
    (client.capture as (id: string, e: string, p: object) => void)('u', 'order_placed', {
      rogue: 'x',
    })
  ).not.toThrow();
});
