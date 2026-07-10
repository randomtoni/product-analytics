# analytics-kit — Python

The Python implementation of the vendor-neutral analytics library. Sibling to the TypeScript
implementation under [`../ts/`](../ts/); the two stay at **capability parity** — every capability the
TS surface exposes must be reachable here, adapted idiomatically (server-shaped: a plain client +
framework bindings; **no browser/DOM target**).

**Status: scaffold.** The vendor-neutral seam is built by the Python roadmap cycle
(architect-consulted, de-branded from `posthog-python`). Nothing here is implemented yet beyond the
package skeleton — the seam design (`Protocol`s for contracts, Pydantic at boundaries, a typed
taxonomy, the consumer-supplied allowlist, a config-selected factory) is deliberately deferred to
that cycle.

## Toolchain

- **uv** — env + dependencies (the `pnpm` analog)
- **pytest** — tests (the `vitest` analog)
- **ruff** — lint (the `eslint` analog)
- **mypy** — type-check, strict (the `tsc --noEmit` analog)

```
cd python
uv run pytest        # tests
uv run ruff check    # lint
uv run mypy          # type-check (strict)
```

## Layout

```
src/analytics_kit/    # the vendor-neutral seam (scaffold — filled by the Python cycle)
tests/
pyproject.toml        # packaging + tool config
```
