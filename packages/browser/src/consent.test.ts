import { afterEach, expect, test } from 'vitest';
import { ConsentStore, platformDoNotTrack } from './consent';
import { createMemoryBackend, localStorageBackend } from './storage-backends';

const DNT_KEYS = ['doNotTrack', 'msDoNotTrack', 'globalPrivacyControl'] as const;

function setDnt(prop: string, value: unknown): void {
  Object.defineProperty(window.navigator, prop, { value, configurable: true });
}

afterEach(() => {
  for (const prop of DNT_KEYS) {
    // Clear any signal a test set so it can't leak into the next test.
    if (prop in window.navigator) {
      Object.defineProperty(window.navigator, prop, { value: undefined, configurable: true });
    }
  }
  delete (window as { doNotTrack?: unknown }).doNotTrack;
});

let seq = 0;
function freshName(): string {
  seq += 1;
  return `consent-${seq}-${Math.random().toString(36).slice(2)}`;
}

test('no platform signal present ⇒ platformDoNotTrack is false', () => {
  expect(platformDoNotTrack()).toBe(false);
});

test("standard navigator.doNotTrack of '1' is a yes-like DNT signal", () => {
  setDnt('doNotTrack', '1');
  expect(platformDoNotTrack()).toBe(true);
});

test('a GPC (globalPrivacyControl) boolean-true is a yes-like signal', () => {
  setDnt('globalPrivacyControl', true);
  expect(platformDoNotTrack()).toBe(true);
});

test('a legacy window.doNotTrack of "yes" is a yes-like signal', () => {
  (window as { doNotTrack?: unknown }).doNotTrack = 'yes';
  expect(platformDoNotTrack()).toBe(true);
});

test("a no-like DNT value ('0') is not treated as a signal", () => {
  setDnt('doNotTrack', '0');
  expect(platformDoNotTrack()).toBe(false);
});

test('a fresh consent store with nothing stored reads pending', () => {
  const store = new ConsentStore(createMemoryBackend(), freshName());
  expect(store.get()).toBe('pending');
});

test('set then get round-trips a tri-state within the same store', () => {
  const store = new ConsentStore(createMemoryBackend(), freshName());

  store.set('granted');
  expect(store.get()).toBe('granted');

  store.set('denied');
  expect(store.get()).toBe('denied');
});

test('a durable backend survives a reconstruct — the decision re-reads', () => {
  const name = freshName();
  new ConsentStore(localStorageBackend, name).set('denied');

  const reloaded = new ConsentStore(localStorageBackend, name);

  expect(reloaded.get()).toBe('denied');
});

test('a DNT signal collapses the resolved state to denied even when granted is stored', () => {
  const store = new ConsentStore(createMemoryBackend(), freshName());
  store.set('granted');

  setDnt('doNotTrack', '1');

  expect(store.get()).toBe('denied');
});

test('an unrecognized stored value falls back to pending (defensive read)', () => {
  const name = freshName();
  const backend = createMemoryBackend();
  backend.set(name, 'sideways'); // not a ConsentState

  expect(new ConsentStore(backend, name).get()).toBe('pending');
});
