import { expect, test } from 'vitest';
import { hasDocument, hasLocalStorage } from './dom';

test('hasDocument is true under the jsdom runtime DOM', () => {
  expect(hasDocument()).toBe(true);
});

test('hasLocalStorage is true under the jsdom runtime DOM', () => {
  expect(hasLocalStorage()).toBe(true);
});

test('the DOM globals the persistence store (S2) needs are present in the test env', () => {
  expect(typeof document).toBe('object');
  expect(typeof localStorage).toBe('object');
  expect(typeof window).toBe('object');
});
