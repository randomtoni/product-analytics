import { expect, test } from 'vitest';
import { version, deriveAllowlistFromTaxonomy, RESERVED_PAGE_EVENT } from './index';

test('exposes the package version', () => {
  expect(version).toBe('0.0.0');
});

test('exposes deriveAllowlistFromTaxonomy from the public entry', () => {
  expect(deriveAllowlistFromTaxonomy).toBeTypeOf('function');
});

test('exposes the reserved page-event name from the public entry (single source of truth for the browser adapter)', () => {
  expect(RESERVED_PAGE_EVENT).toBe('page');
  // The neutral reserved name carries no vendor $-token.
  expect(RESERVED_PAGE_EVENT).not.toContain('$');
});
