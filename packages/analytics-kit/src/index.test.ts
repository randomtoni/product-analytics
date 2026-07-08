import { expect, test } from 'vitest';
import {
  version,
  deriveAllowlistFromTaxonomy,
  RESERVED_PAGE_EVENT,
  RESERVED_PAGELEAVE_EVENT,
} from './index';

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

test('exposes the reserved pageleave-event name from the public entry (E6-S2)', () => {
  expect(RESERVED_PAGELEAVE_EVENT).toBe('pageleave');
  // The neutral reserved name carries no vendor $-token — the adapter maps it to $pageleave.
  expect(RESERVED_PAGELEAVE_EVENT).not.toContain('$');
});
