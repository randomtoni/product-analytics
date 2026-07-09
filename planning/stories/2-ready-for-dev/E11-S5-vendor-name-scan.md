---
id: E11-S5-vendor-name-scan
epic: E11-CORE-adoption-audit
status: ready-for-dev
area: core
touches: [observability]
depends_on: []
api_impact: additive
---

# E11-S5-vendor-name-scan — CI-able vendor/product-name scan (the critical gate)

## Why

The whole reason the library exists is that no vendor name leaks into its surface. This slice makes that a durable, re-runnable, exit-nonzero gate — not a one-time grep — so the neutrality guarantee holds as new code and adapters land. It ships FIRST because its confinement rule (describe-by-role, never by vendor) constrains what the docs stories (S1/S2) may write.

## Scope

### In

- A CI-runnable scan (a vitest test or a `scripts/` node script wired into a package's `test`/a root `turbo` task) that **exits nonzero on any match** across the library's SURFACE and passes on the correctly-shipped code.
- **Scan by DIMENSION, not by raw text** (architect-locked — see Technical notes). A forbidden token is a FAILURE only when it lands in a consumer-observable dimension:
  - exported / public identifiers, type + interface names, enum members, public const names (checked against each package's built `dist/**/*.d.ts` — that IS the public surface by construction);
  - `package.json` `name` fields + file/dir names under `packages/`;
  - consumer-reachable strings (thrown error messages, log output, JSDoc that lands in the published `.d.ts`);
  - every occurrence in a shipped doc (root `README.md` + the S1 matrix + the S2 guide — docs have NO internal exemption).
- Forbidden tokens: case-insensitive `posthog`; `ph_` prefixes; region/vendor hostnames (e.g. `i.posthog.com`, `us.i.`, `eu.i.`); the invented product name `fernly`.
- **`$`-prefixed wire literals: gated by a CONFINEMENT RULE, not a whitelist** (architect-locked). A `$`-prefixed string literal is PERMITTED only as the value of a const whose exported identifier matches `/_WIRE_(EVENT|KEY)$/` (or lives in a `[WIRE]`-tagged region); it FAILS anywhere else in code (an escaped-confinement leak) and always FAILS in docs. The exported identifier itself is still scanned and must carry zero vendor token.
- **Exempt paths (skipped entirely):** `examples/**`, `planning/**`, `.claude/**`, `CLAUDE.md`, `posthog-js/**`, and `*.test.ts` port fixtures. Non-doc `//` comments in `packages/**/src` are skipped for the `posthog` token (port-provenance citations are dev-facing audit evidence, not surface — see Technical notes).

### Out

- Fixing any hit the scan surfaces. Per the epic's audit-not-patch rule, a real leak routes to a bug against the epic that owns it — E11 gates, it does not patch.
- Whitelisting individual `$`-literal values (rejected — see Technical notes; the confinement RULE replaces the list).
- Scrubbing the port-citation comments from `packages/**` (rejected — see Technical notes).

## Acceptance criteria

- [ ] The scan runs as an exit-nonzero CI check (a test or `turbo`/`scripts` task), not a manual grep; a planted `posthog` in a `dist` `.d.ts` identifier, a planted `fernly` in the README, or a `$pageview` moved OUT of a `_WIRE_` const each make it FAIL.
- [ ] On the current shipped tree the scan PASSES: the port-citation `// De-branded from posthog's …` comments in `packages/**/src`, and the four `$`-literal `_WIRE_(EVENT|KEY)` consts in `browser/src/persistence-keys.ts`, do NOT trip it.
- [ ] The identifier/type/package dimensions are checked against the built `dist/**/*.d.ts` (what actually ships), not raw `src` — proving the neutral surface a consumer imports carries zero vendor token.
- [ ] The scan is documented so a future adapter passes the SAME gate with zero scan edits: a new wire token passes iff it obeys the `_WIRE_`-confinement convention (upholds the epic's "scan gains no exceptions").
- [ ] Bar-neutral proof: the exported identifier `PAGEVIEW_WIRE_EVENT` passes while its value `'$pageview'` is permitted only inside the confined const — the vendor shape never crosses into the consumer's type space.

## Technical notes

Scan boundary — architect-locked (2026-07-09):

- **Scan by dimension, not path.** "Surface" = what a consumer can observe. The BRIEF (§Zero vendor references, lines 27–28) enumerates the protected dimensions: public API, type names, package names, file names, docs, plus exported source identifiers (epic Note line 43). A match FAILS only in those dimensions. The cleanest implementation is to run the identifier/type/package match against the emitted `dist/**/*.d.ts` (comments and non-exported internals simply aren't in it → precise + cheap), and a strip-comments / AST (ts-morph) classification pass over `src` for the `$`-literal confinement rule. **A raw `grep` over `packages/**` is the wrong tool and would false-fail** on the two categories below — say so in the code so nobody reaches for it.
- **Port-citation `//` comments in `packages/**/src` are SKIPPED for `posthog`** (architect-locked): they are dev-facing provenance (`// De-branded from posthog's event-utils.ts:45-54`), identical in kind to the `planning/`/`CLAUDE.md` citations the epic already exempts. They are load-bearing audit evidence that the port was DE-BRANDED, not copied — the very thing this epic reviews. Scrubbing them is REJECTED; leave an explicit "rejected, and why" line in the scan code so it doesn't resurface.
- **`$`-wire literals — confinement RULE, not whitelist** (architect-locked): permitted ONLY as the value of a const whose exported identifier matches `/_WIRE_(EVENT|KEY)$/` (or a `[WIRE]`-tagged region). This is strictly STRONGER than a gate: it FAILS the build if a `$`-literal escapes that confinement (e.g. someone inlines `'$pageview'` in `browser-adapter.ts` instead of importing the const), so the scan actively defends the neutral seam rather than carving a hole in it. A per-value whitelist is REJECTED (it becomes a vendor-token registry shipped in-repo and violates "scan gains no exceptions").
- Prior art to build ALONGSIDE: `packages/browser/src/wire-scan.test-helper.ts` (`containsInsertId` — a deep-shape scan the S5 scan can generalize). The confined `$`-literal consts are `PAGEVIEW_WIRE_EVENT` / `PAGELEAVE_WIRE_EVENT` / `AUTOCAPTURE_WIRE_EVENT` / `GEOIP_DISABLE_WIRE_KEY` in `browser/src/persistence-keys.ts` (lines 40–52); their exported names carry zero vendor token.
- Concrete match/skip matrix (from the architect consult): FAIL = exported identifiers/type names/`.d.ts` · package + file/dir names · consumer-reachable strings (errors, logs, published JSDoc) · ALL shipped docs · a `$`-literal escaped from a `_WIRE_` const. SKIP = non-doc `//` comments in `src` · `$`-literal inside a `_WIRE_` const/`[WIRE]` region · `examples/`, `planning/`, `.claude/`, `CLAUDE.md`, `posthog-js/`, `*.test.ts` port fixtures.
- This is a GATED CHECK (executable), not prose — the epic's "executable-over-prose where possible" applies fully here; the scan is the whole point of the epic.

## Shipped
