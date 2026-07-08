import type { Taxonomy, TaxonomyDecl } from './taxonomy';

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
