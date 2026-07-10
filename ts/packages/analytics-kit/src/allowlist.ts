import type { ViolationPolicy } from './analytics-provider';
import type { NeutralProperties } from './neutral-event';
import type { Taxonomy, TaxonomyDecl } from './taxonomy';

type ConsoleLike = { error(...args: unknown[]): void };

function emitViolation(message: string): void {
  (globalThis as { console?: ConsoleLike }).console?.error?.(message);
}

export function enforceAllowlist(
  allowlist: ReadonlySet<string> | undefined,
  onViolation: ViolationPolicy,
  ...bags: Array<NeutralProperties | undefined>
): boolean {
  if (allowlist === undefined) return true;
  for (const bag of bags) {
    if (bag === undefined) continue;
    for (const key of Object.keys(bag)) {
      if (allowlist.has(key)) continue;
      const message = `analytics-kit: property "${key}" is not on the payload allowlist`;
      if (onViolation === 'throw') {
        throw new Error(message);
      }
      emitViolation(message);
      return false;
    }
  }
  return true;
}

export function deriveAllowlistFromTaxonomy(taxonomy: Taxonomy<TaxonomyDecl>): string[] {
  const keys = new Set<string>();
  const { events, traits, groups } = taxonomy.decl;

  for (const propDecl of Object.values(events)) {
    for (const key of Object.keys(propDecl)) {
      keys.add(key);
    }
  }

  if (traits) {
    for (const key of Object.keys(traits)) {
      keys.add(key);
    }
  }

  if (groups) {
    for (const propDecl of Object.values(groups)) {
      for (const key of Object.keys(propDecl)) {
        keys.add(key);
      }
    }
  }

  return [...keys];
}
