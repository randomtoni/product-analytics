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

// One flag's declaration: an optional set of variant strings (the values a variant flag can
// resolve to) and an optional flat-`PropDecl` payload. Both optional — a bare `{}` declares a
// known-but-untyped flag. Payload nesting stays flat for v1 (nested ⇒ `unknown`, the same
// ceiling `PropsOf` already carries).
export type FlagDecl = { variants?: readonly string[]; payload?: PropDecl };

export type TaxonomyDecl = {
  events: Record<string, PropDecl> & {
    [K in typeof RESERVED_PAGE_EVENT | typeof RESERVED_PAGELEAVE_EVENT]?: never;
  };
  traits?: PropDecl;
  groups?: Record<string, PropDecl>;
  page?: PropDecl;
  flags?: Record<string, FlagDecl>;
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

// The resolved shape of one flag: its variant value type (the declared variant union, or
// `never` when no variants are declared — a boolean-only flag) and its resolved payload type
// (`PropsOf` of the flat payload decl, or `unknown` when none is declared). The port's
// `getFlag`/`getPayload` reads project out of this per-flag shape.
export type FlagShape<D extends FlagDecl> = {
  variants: D extends { variants: readonly string[] } ? D['variants'][number] : never;
  payload: D extends { payload: PropDecl } ? PropsOf<D['payload']> : unknown;
};

export type ShapeOf<T extends TaxonomyDecl> = {
  events: { [E in keyof T['events']]: PropsOf<T['events'][E]> };
  traits: T extends { traits: PropDecl } ? PropsOf<T['traits']> : NeutralTraits;
  groups: T extends { groups: Record<string, PropDecl> }
    ? { [G in keyof T['groups']]: PropsOf<T['groups'][G]> }
    : Record<string, NeutralTraits>;
  page: T extends { page: PropDecl } ? PropsOf<T['page']> : NeutralProperties;
  flags: T extends { flags: Record<string, FlagDecl> }
    ? { [F in keyof T['flags']]: FlagShape<T['flags'][F]> }
    : Record<string, FlagShape<FlagDecl>>;
};

export type TaxonomyShape = {
  events: Record<string, NeutralProperties>;
  traits: NeutralTraits;
  groups: Record<string, NeutralTraits>;
  page: NeutralProperties;
  flags: Record<string, FlagShape<FlagDecl>>;
};

export type DefaultTaxonomyShape = TaxonomyShape;

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type EmptyObject = {};

export type PropsParam<P> = EmptyObject extends P ? [props?: P] : [props: P];
