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

## Install (consumers)

The TypeScript packages are published **privately to GitHub Packages** under the `@randomtoni`
scope. Consumers point the scope at the GitHub registry and authenticate with a GitHub token that
has the `read:packages` scope. Add a project `.npmrc`:

```ini
@randomtoni:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

and export `GITHUB_PACKAGES_TOKEN` (a PAT with `read:packages`) in the environment. Then install
only the target(s) you need:

```bash
# the seam (contracts, taxonomy, allowlist, factory) — a transitive dep of the targets below,
# install it directly when you import its types/taxonomy helpers
npm install @randomtoni/analytics-kit

# browser app (createAnalytics + capture, optional session replay)
npm install @randomtoni/analytics-kit-browser

# server app (server-side capture + the query client)
npm install @randomtoni/analytics-kit-node

# optional React binding (provider + hooks) — pairs with the browser target
npm install @randomtoni/analytics-kit-react
```

A typical browser + React consumer installs both targets in one line (the seam comes along as a
dependency):

```bash
npm install @randomtoni/analytics-kit-browser @randomtoni/analytics-kit-react
```

All four ship at the same version, expose dual ESM + CJS builds with bundled types, and carry no
vendor references. See [`ts/README.md`](ts/README.md) for the API surface.

## Working on it

- **TypeScript:** `cd ts && pnpm install && pnpm turbo run build test typecheck lint` (+ `pnpm neutrality-scan`).
- **Python:** `cd python && uv run pytest` (+ `uv run ruff check`, `uv run mypy`).
