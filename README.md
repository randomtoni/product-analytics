# product-analytics

An **app-agnostic, vendor-neutral analytics abstraction library** for TypeScript. Your app codes
against one small set of neutral interfaces; the analytics backend sits behind a swappable adapter,
selected by configuration. **No vendor name appears in the library's surface.**

## Why

Most apps wire analytics calls to a specific vendor's SDK, scattered across the codebase. Swapping
vendors, or adopting the same conventions in a new app, then means touching everything.
`product-analytics` puts a neutral seam in between:

- **Provider-swap = one adapter, zero consumer change.** Change the backend by writing one
  adapter — no consumer code changes.
- **New-app adoption = config only, zero library change.** A new app adopts by configuration
  alone.
- **Primitives, not products.** Capture an event, identify a user, evaluate a flag — not
  opinionated product features baked in.
- **Privacy by allowlist.** You supply the allowlist of properties permitted to leave your app;
  the library enforces it.
- **Vendor-neutral to the core.** The library's own code and public API carry no vendor
  references; the backend is configuration, not a branded dependency.

## Two layers

| Layer | Owns |
|---|---|
| **Library** (this repo) | the vendor-neutral interfaces, the enforcement (payload allowlist, batching seam), and the backend adapters |
| **Consumer app** | configuration (which backend, which properties are allowed) + calling the primitives |

The library is split `core → browser → node` (with optional React bindings) so the browser and
server stories stay honest.

## Status

Early / greenfield. The public API is not yet stable. The first supported backend is configured by
endpoint + write key; a self-hosted backend is planned.

## Install

```sh
# package names are TBD / illustrative
pnpm add @product-analytics/browser   # browser target
pnpm add @product-analytics/node      # server-side target
```

## Usage (sketch)

```ts
import { createAnalytics } from "@product-analytics/browser";

const analytics = createAnalytics({
  // the backend is configuration — no vendor name in the API
  backend: {
    writeKey: process.env.ANALYTICS_WRITE_KEY!,
    endpoint: process.env.ANALYTICS_ENDPOINT, // point at any compatible backend
  },
  // only these properties may leave the app:
  allowlist: ["plan", "route", "experiment_variant"],
});

analytics.capture("checkout_completed", { plan: "pro", total_cents: 4200 });
analytics.identify("user_123", { plan: "pro" });
if (analytics.isFeatureEnabled("new-nav")) {
  // …
}
```

> API shown is illustrative and will change. See `CLAUDE.md` for the architecture.

## Development

Quality gates (see `CLAUDE.md`): **typecheck · lint · test · build**, all green. Package manager:
`pnpm`; tests: `vitest`.
