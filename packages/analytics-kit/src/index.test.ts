import { expectTypeOf, expect, test } from 'vitest';
import {
  version,
  deriveAllowlistFromTaxonomy,
  enforceAllowlist,
  RESERVED_PAGE_EVENT,
  RESERVED_PAGELEAVE_EVENT,
} from './index';
import type { PropsParam } from './index';

test('exposes the package version', () => {
  expect(version).toBe('0.0.0');
});

test('exposes deriveAllowlistFromTaxonomy from the public entry', () => {
  expect(deriveAllowlistFromTaxonomy).toBeTypeOf('function');
});

test('exposes the standalone enforceAllowlist guard from the public entry (bar A: one privacy path for browser + node)', () => {
  expect(enforceAllowlist).toBeTypeOf('function');
});

test('re-exports the PropsParam taxonomy type from the public entry so a downstream target can import it', () => {
  // Present-optional prop ⇒ [props?: P]; required prop ⇒ [props: P].
  expectTypeOf<PropsParam<Record<string, never>>>().toEqualTypeOf<[props?: Record<string, never>]>();
  expectTypeOf<PropsParam<{ plan: string }>>().toEqualTypeOf<[props: { plan: string }]>();
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
