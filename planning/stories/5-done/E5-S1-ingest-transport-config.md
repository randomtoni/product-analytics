---
id: E5-S1-ingest-transport-config
epic: E5-CAP-transport
status: ready-for-dev
area: capture
touches: [browser, adapters]
depends_on: []
api_impact: additive
---

# E5-S1-ingest-transport-config — Neutral ingest host/path config

## Why

The one clear neutral-surface touch of the whole transport layer: a consumer points the library at a first-party reverse-proxy ingest endpoint by config alone (bar B). Everything downstream (batch queue, retry, compression) POSTs to the URL this story resolves.

## Scope

### In

- Add `ingestHost` (required-ish for real delivery; a bare origin, e.g. `https://analytics.example.com`) and optional `ingestPath` to the neutral `AnalyticsConfig` in `packages/analytics-kit/src/create-analytics.ts`, both optional at the type level (an unkeyed / no-op client needs neither).
- Thread both through `resolveAdapter` in `packages/browser/src/create-analytics.ts` into `BrowserAdapterOptions` on `packages/browser/src/browser-adapter.ts`.
- Add an internal URL resolver in the browser adapter: given `ingestHost` (+ optional `ingestPath`), produce the ingest URL the transport POSTs to. The adapter appends its own wire path (the `[WIRE]` capture path, e.g. `/batch/`) when `ingestPath` is not overridden. Trailing-slash normalization on the host.
- No delivery yet — this story only resolves and stores the target URL; S2 consumes it. `capture()` still drops post-pipeline.

### Out

- The actual POST / batch envelope / query params — S2 + S5 (`[WIRE]`).
- Any region classification, vendor-host default, or `i.posthog.com` fallback — explicitly rejected (see Technical notes).
- `dedupeId` → `uuid` wire mapping — E5-S8.

## Acceptance criteria

- [ ] `AnalyticsConfig` exposes `ingestHost?: string` and `ingestPath?: string`; both are optional and carry no default host value.
- [ ] Pointing `ingestHost` at any first-party origin requires zero library-source change — verified by a test constructing the adapter with two different hosts and asserting the resolved URL differs accordingly (bar B).
- [ ] No vendor hostname, region string, or `i.posthog.com`-style default appears anywhere in library source (grep-clean).
- [ ] The resolved ingest URL is adapter-internal: the neutral surface exposes only `ingestHost`/`ingestPath` on config — no wire path, envelope, or query param leaks onto the neutral types (bar A).
- [ ] Host trailing-slash + path joining is normalized (no `//` or missing `/` in the resolved URL); unit-tested.

## Technical notes

- **The one neutral-surface touch.** Transport is otherwise adapter-internal; only `ingestHost`/`ingestPath` (this story) and the per-event `dedupeId` (E5-S8) are neutral. — architect (2026-07-07): §E5 neutral-seam note.
- **No region/vendor-host defaulting.** PostHog resolves everything off `config.api_host` via `request-router.ts` (region classification + `endpointFor`, analytics path `/e/`). De-brand to an explicit `ingestHost` (+ optional `ingestPath`) with **no** region or `i.posthog.com` defaulting (`posthog-js/packages/browser/src/utils/request-router.ts:18,29-35` is `[WIRE]`) — a bare host the consumer points at their first-party reverse proxy; the adapter appends its wire path internally. — architect (2026-07-07): §E5.9.
- Reference for the URL-building shape (path append, query params): `posthog-js/packages/browser/src/request.ts` (the `compression=`/`ver=`/`_=` query params there are `[WIRE]` and belong to S5, not this story).
- Storage: the resolved URL lives on the `BrowserAdapter` instance (constructor-time), not in the property store — it is config, not persisted state.
- **Shape-pin test must be extended (applies to every E5 config-touching story).** `AnalyticsConfig` is pinned by an exact `expectTypeOf<AnalyticsConfig>().toEqualTypeOf<{...}>()` literal in `packages/analytics-kit/src/create-analytics.test.ts:167-182`. It is NOT open-ended — adding `ingestHost`/`ingestPath` here (and `flushInterval`/`flushAt` in S2, `compression` in S5, the bot-filter fields in S7) will FAIL that assertion until the literal is extended in lockstep. Each config-touching story must add its new field(s) to that `toEqualTypeOf` literal in the same change, or the seam-package typecheck gate goes red. Keep every field optional (`?`) so the `const empty: AnalyticsConfig = {}` line at `:180` still holds.
- **Resolver signature note.** `resolveAdapter` in `packages/browser/src/create-analytics.ts` currently passes an explicit whitelist of fields into `BrowserAdapterOptions` (it does not spread `config`), so thread `ingestHost`/`ingestPath` through both the `AnalyticsConfig` type AND the explicit `resolveAdapter` construction — a config field added to the type alone never reaches the adapter.

## Shipped
- > Reviewer suggestion (2026-07-08, improvement-pass candidate): `resolveIngestUrl` accepts an empty/whitespace-only `ingestHost` → returns a relative `/batch/` URL. Add a `if (host === '') return undefined;` guard after trim (+ test) so a blank host resolves to no-target like an omitted one.
- > Reviewer suggestion (2026-07-08): `ingestPath` override isn't trailing-slash-normalized (default `/batch/` has one, override `/ingest` doesn't). Fine (S2 owns the POST), but document `ingestPath` is passed verbatim (leading slash guaranteed) or normalize both for a uniform resolved shape.

## Shipped

> Captured by `implement-epics` on 2026-07-08.

- **Files changed (seam):** `create-analytics.ts` (+`AnalyticsConfig.ingestHost?`/`ingestPath?`) + shape-pin extended
- **Files added (browser):** `ingest-url.ts` (`resolveIngestUrl` — host+path→URL|undefined, trailing-slash norm, appends `[WIRE]` `/batch/` when no `ingestPath`) + test; **changed:** `browser-adapter.ts` (resolve URL at construction, `@internal ingestUrl()`), `browser/create-analytics.ts` (thread through whitelist)
- **New public API:** `AnalyticsConfig.ingestHost?: string` + `ingestPath?: string` (additive, no default host)
- **Tests added:** browser +12 (ingest-url 9 normalization + config 3: two-hosts bar-B, ingestPath override, no-host→undefined) → 190; seam 128 (shape-pin extended)
- **Commit:** `E5-S1-ingest-transport-config — Neutral ingest host/path config` on `core-cycle`
- **Reviewer notes:** 0 critical, 2 suggestions (edge-case hardening) → see Technical notes
- **Cross-story seams exposed:** **S2** reads `BrowserAdapter.ingestUrl(): string | undefined` (`@internal`) for the POST — `undefined` = no delivery target (skip/drop, don't default). `capture()` still drops post-pipeline (S2 flips to enqueue). **S5** appends `[WIRE]` query params (`compression=`/`ver=`/`_=`) to the string `ingestUrl()` returns. Default wire path is the module-private `DEFAULT_WIRE_CAPTURE_PATH='/batch/'` (adapter-internal — the single adjust point).

## Follow-up

> E5 post-close improvement pass, 2026-07-08 (commit follows). Reviewer-verified, no regression (browser 402 / seam 128 green).

- **Blank-host guard** — `resolveIngestUrl` now returns `undefined` for a blank/whitespace-only `ingestHost` (after trim), instead of a relative `/batch/` URL — a blank host is a no-target like an omitted one. Test added (blank + whitespace + whitespace-host-with-path → `undefined`). (Addresses the S1 reviewer suggestion.)
