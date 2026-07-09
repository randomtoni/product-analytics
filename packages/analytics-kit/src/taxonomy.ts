import type { NeutralProperties, NeutralTraits } from './neutral-event';

// The default event NAME for a nameless facade `page()`; a named `page('/x')` uses
// its argument instead. NOT the pageview recognizer — the pipeline keys off the
// neutral `NeutralEvent.isPageView` marker, which the `page()` path stamps for both.
export const RESERVED_PAGE_EVENT = 'page';

// The neutral event NAME of the adapter-internal `pageleave`, minted at unload (never
// via a facade verb — the consumer never types it). Reserved so it can't be redeclared
// as a custom event. Neutral/no-`$`; the adapter maps it to the `[WIRE]` `$pageleave`.
export const RESERVED_PAGELEAVE_EVENT = 'pageleave';

export type PropType = 'string' | 'number' | 'boolean' | 'date';

export type PropDecl = Record<string, PropType>;

export type TaxonomyDecl = {
  events: Record<string, PropDecl> & {
    [K in typeof RESERVED_PAGE_EVENT | typeof RESERVED_PAGELEAVE_EVENT]?: never;
  };
  traits?: PropDecl;
  groups?: Record<string, PropDecl>;
  page?: PropDecl;
};

export type Taxonomy<T extends TaxonomyDecl> = { readonly decl: T };

export function defineTaxonomy<const T extends TaxonomyDecl>(decl: T): Taxonomy<T> {
  return { decl };
}

export type TagToType<Tag extends PropType> = Tag extends 'string'
  ? string
  : Tag extends 'number'
    ? number
    : Tag extends 'boolean'
      ? boolean
      : Tag extends 'date'
        ? Date
        : never;

export type PropsOf<D> = {
  -readonly [K in keyof D]: D[K] extends PropType ? TagToType<D[K]> : unknown;
};

export type ShapeOf<T extends TaxonomyDecl> = {
  events: { [E in keyof T['events']]: PropsOf<T['events'][E]> };
  traits: T extends { traits: PropDecl } ? PropsOf<T['traits']> : NeutralTraits;
  groups: T extends { groups: Record<string, PropDecl> }
    ? { [G in keyof T['groups']]: PropsOf<T['groups'][G]> }
    : Record<string, NeutralTraits>;
  page: T extends { page: PropDecl } ? PropsOf<T['page']> : NeutralProperties;
};

export type TaxonomyShape = {
  events: Record<string, NeutralProperties>;
  traits: NeutralTraits;
  groups: Record<string, NeutralTraits>;
  page: NeutralProperties;
};

export type DefaultTaxonomyShape = TaxonomyShape;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type EmptyObject = {};

export type PropsParam<P> = EmptyObject extends P ? [props?: P] : [props: P];
