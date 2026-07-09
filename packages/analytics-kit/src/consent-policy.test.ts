import { expect, test } from 'vitest';
import { resolveOptedOut } from './consent-policy';
import { resolveOptedOut as exportedResolveOptedOut } from './index';

test('granted ⇒ NOT opted out, regardless of the consent default', () => {
  expect(resolveOptedOut('granted')).toBe(false);
  expect(resolveOptedOut('granted', 'denied')).toBe(false);
  expect(resolveOptedOut('granted', 'granted')).toBe(false);
});

test('denied ⇒ opted out, regardless of the consent default', () => {
  expect(resolveOptedOut('denied')).toBe(true);
  expect(resolveOptedOut('denied', 'granted')).toBe(true);
  expect(resolveOptedOut('denied', 'denied')).toBe(true);
});

test("pending with consent default 'granted' ⇒ NOT opted out (opt-in-by-default knob)", () => {
  expect(resolveOptedOut('pending', 'granted')).toBe(false);
});

test("pending with consent default 'denied' ⇒ opted out (explicit opt-out-by-default)", () => {
  expect(resolveOptedOut('pending', 'denied')).toBe(true);
});

test('pending with the consent default UNSET ⇒ opted out (the library fail-safe)', () => {
  expect(resolveOptedOut('pending')).toBe(true);
  expect(resolveOptedOut('pending', undefined)).toBe(true);
});

test('resolveOptedOut is exported from the package entrypoint', () => {
  expect(exportedResolveOptedOut).toBe(resolveOptedOut);
});
