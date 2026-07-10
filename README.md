# analytics-kit

App-agnostic, **vendor-neutral analytics abstraction library**, shipped in two languages at
capability parity. Consuming apps depend on it like a vendored SDK and code against its own neutral
interfaces — never a vendor SDK directly.

| Language | Location | Status |
|---|---|---|
| **TypeScript** | [`ts/`](ts/) | Shipped — R1 complete (seam + browser/node/react targets + example consumer + adoption audit) |
| **Python** | [`python/`](python/) | Scaffolded — built next, at capability parity with `ts/` |

The two implementations share **one contract, not one codebase**: the same vendor-neutral seam and
the same capability set, each expressed idiomatically (Python is server-shaped — a plain client +
framework bindings, no browser/DOM target). Neither tree imports the other.

## Layout

```
ts/         # TypeScript implementation (pnpm/turbo workspace) — see ts/README.md
python/     # Python implementation (uv) — see python/README.md
planning/   # roadmap · epics · stories — governs both languages
.claude/    # the agent team + skills — governs both languages
```

## The commitments (both languages)

- **Vendor-neutral seam** — the backend sits behind an adapter; no vendor type leaks to consumers.
- **Zero vendor references in the surface** — the reference SDKs (`posthog-js` / `posthog-python`)
  are adapted-from and de-branded, never imported; enforced by a neutrality scan.
- **Two acceptance bars** — provider-swap = one adapter + zero consumer change; new-app adoption =
  config only + zero library change.
- **Primitives, not products**, and **privacy = a consumer-supplied payload allowlist** the library
  enforces.

See [`CLAUDE.md`](CLAUDE.md) for the full architecture and
[`planning/ROADMAP.md`](planning/ROADMAP.md) for what's next.

## Working on it

- **TypeScript:** `cd ts && pnpm install && pnpm turbo run build test typecheck lint` (+ `pnpm neutrality-scan`).
- **Python:** `cd python && uv run pytest` (+ `uv run ruff check`, `uv run mypy`).
