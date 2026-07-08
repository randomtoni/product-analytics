import { expect, test } from 'vitest';
import { version, deriveAllowlistFromTaxonomy } from './index';

test('exposes the package version', () => {
  expect(version).toBe('0.0.0');
});

test('exposes deriveAllowlistFromTaxonomy from the public entry', () => {
  expect(deriveAllowlistFromTaxonomy).toBeTypeOf('function');
});
