---
id: E19-S4-ts-receiver-parity
epic: E19-NODE-ingest-receiver-persistence
status: ready-for-dev
area: node
touches: [adapters, capture]
depends_on: [E19-S1-neutral-receiver-core]
api_impact: additive
---

# E19-S4-ts-receiver-parity — TS receiver mounts (Express / Next-route / plain-handler) over the same neutral core

## Why

Bar A/parity demands the TS ecosystem receive the node batch envelope with zero consumer server logic,
at capability parity with Python. This slice ships the TS framework mounts — Express / Next-route /
plain-handler — as thin wrappers over the SAME S1 neutral receiver core. This is the medium-risk mount
surface (the framework request/response shapes differ most in the TS ecosystem).

## Scope

### In

- Ship **TS receiver mounts: Express, Next-route, and plain-handler**, each a thin wrapper over the S1
  neutral core, mirroring the Python mount set's role (framework SET differs by ecosystem — capability at
  parity). Home: alongside the S1 receiver core (`ts/packages/node/src/receiver/`); pin the layout.
  - **plain-handler** — the framework-free base: a `(req-ish) => response-ish` handler over the standard
    Node `IncomingMessage`/`ServerResponse` (or a minimal neutral request/response contract) that reads
    raw body + headers, calls the S1 core, and writes the response. Imports no framework. This is the TS
    analog of Python's framework-free ASGI receiver — the base every other TS mount reduces to.
  - **Express** — an Express middleware/handler `(req, res, next) => ...` that reads `req` body + headers,
    calls the S1 core, and responds via `res`. Express is an OPTIONAL peer-dep / typed against a minimal
    structural request/response shape so importing the receiver module does NOT require Express installed
    (mirror the `pg` optional-peer-dep posture from E17-S3; do NOT add a hard Express dependency to the
    node package).
  - **Next-route** — a Next.js route-handler factory (App-Router `Request → Response`, and/or a
    Pages-API `(req, res)` handler) that reads the request body + headers, calls the S1 core, and returns
    a `Response`. Next typed structurally / behind an optional peer-dep so the base package imports
    without Next.
- **Each mount does ONLY: read raw body (Buffer/bytes) + headers, call the S1 core, translate the neutral
  outcome → the framework response** (2xx accept / 4xx neutral parse error; a DB failure → a neutral
  5xx-class response, never a leaked driver/framework exception). NO parse, NO decompress, NO SQL — all
  in S1. Framework request/response types stay confined to the mount module; the core surface is
  framework-free.
- **Body-read is the mount's real work.** Node frameworks expose the body differently (Express with
  `express.raw()`/a raw-body middleware vs a parsed body; Next App-Router `await request.arrayBuffer()`;
  Pages-API a stream). The gzipped/raw body MUST reach the S1 core as raw BYTES — document that the mount
  must read the RAW body (not a framework-JSON-parsed body, which would break gzip detection + the S1
  decompress step). Normalize headers to a case-insensitive lookup for the core.
- **Optional peer-dep posture** for Express/Next (mirror E17-S3's `pg` optional peer-dep +
  `peerDependenciesMeta.<name>.optional: true` in `ts/packages/node/package.json`); the plain-handler
  needs no peer-dep. Role-named exports (never a vendor). Add the mount exports to
  `ts/packages/node/src/index.ts` following the existing export posture.
- **Capability parity with the Python mounts (S2), NOT framework-for-framework.** Same thin-wrapper
  contract, same body/header-read → core-call → response-translate shape, same neutral outcome mapping.
  The Express/Next/plain SET is the TS-ecosystem analog of Django/FastAPI/ASGI — parity is that a TS
  consumer can mount the receiver as easily as a Python one, on their ecosystem's frameworks.

### Out

- The neutral parse/decompress/upsert core — **S1** (S4 wraps it; it does not re-implement any of it).
- Building the `DbExecute` from a `warehouse_dsn` + the receiver config field — **S3** (S4's mounts take
  a `DbExecute`; S3's from-config factory wires DSN → driver → these mounts). Until S3 wires it, the
  mount takes a `DbExecute` parameter.
- The Python mounts — **S2** (the other ecosystem half).
- Consumer-side api_key auth enforcement — out (per S1's auth note; the mount does not enforce it this
  cycle).
- Any change to the S1 core, the `events` schema, or the `DbExecute` seam — out (S4 consumes them).

## Acceptance criteria

- [ ] TS receiver mounts — Express, Next-route, and plain-handler — exist, each a thin wrapper over the
      S1 neutral core, at capability parity with the Python mount set.
- [ ] plain-handler imports no framework and works over the standard Node request/response (or a minimal
      neutral contract); it is the base the other mounts reduce to.
- [ ] Express and Next are OPTIONAL peer-deps (typed structurally / `peerDependenciesMeta.optional`) —
      importing the receiver module does not require Express or Next installed (mirror the `pg`
      optional-peer-dep posture); the node package imports clean without them.
- [ ] Each mount reads the RAW body (bytes/Buffer) + headers and passes them to the S1 core — documented
      that a framework-JSON-parsed body must NOT be used (it breaks gzip detection + decompression). It
      does only body/header read + core call + response translation — no parse/decompress/SQL.
- [ ] Neutral outcome maps to the framework response: 2xx accept / 4xx neutral parse error / neutral
      5xx-class on a DB failure — no leaked driver/framework exception. Framework types stay in the mount
      module; the core surface is framework-free. Neutrality scan green.
- [ ] Bar B: a consumer adopts by mounting the shipped handler on a route — no library edit, no server
      component authored. Bar A: swapping to self-host adds this mount, changes no consumer
      capture/identity/taxonomy code.
- [ ] Mount exports are added to `index.ts` (role-named). Tests exercise each mount against a fake
      request (canned raw body + headers) and the S1 fake `DbExecute` — no real Postgres, no real
      Express/Next server. TS/Python capability parity; all gates green in both trees.

## Technical notes

**Wrap the S1 core; mirror the Python mount set's role (S2).** The mount owns ONLY the framework
request/response glue; S1 owns parse + decompress + upsert. Read S1 and S2 before writing — the TS mounts
are the ecosystem analog of the Python Django/FastAPI/ASGI mounts, at capability (not framework-for-
framework) parity.

**Pre-resolved decisions (locked by the epic Notes):**

- **The LIBRARY ships the receiver; the CONSUMER mounts it.** The receiver is the INBOUND analog of the
  request-context middlewares. REJECTED: a consumer-built receiver / handing the consumer the raw
  `data:[]`/`$`-payload — both break bar A. — architect (2026-07-13)
- **Framework set differs by ecosystem; capability at parity. Medium risk lives in the TS mount surface.**
  TS mounts = Express / Next-route / plain-handler; Python = Django + FastAPI/ASGI. Capability parity,
  not framework-for-framework. The TS mount surface is the medium-risk part of this epic (the framework
  request/response shapes differ most here). — architect (2026-07-13)
- **Reuse the existing node batch envelope; no new wire.** S4's mounts hand the S1 core the RAW body of
  the SAME node batch envelope the transport POSTs — `{ api_key, batch, sent_at }`, gzipped by default.
  The mount must NOT let a framework JSON-body-parser consume the body first (that both breaks gzip
  detection and mis-parses the wire). — architect (2026-07-13) + PM grounding

**Optional-peer-dep posture — mirror E17-S3's `pg`.** E17-S3 added `pg` as an optional peer-dep
(`peerDependencies` + `peerDependenciesMeta.pg.optional: true`) to `ts/packages/node/package.json`, lazily
imported. Express/Next follow the same optional-peer-dep posture so the base package imports without them;
the plain-handler needs no peer-dep. Type the mount against a minimal structural request/response shape
(the same way `NodeFetch` in `send-batch.ts:17-20` is a minimal structural `fetch` contract, not the DOM
`fetch` type) so the framework's own types are not a hard import. The exact peer-dep + meta mechanics
settle at implement time; the optional-peer-dep CONCEPT is pinned.

**Body-read caution (the medium risk).** Each TS framework surfaces the request body differently, and the
receiver needs the RAW bytes (the body may be gzipped):
- Express: use a raw-body path (`express.raw({ type: '*/*' })` or read the stream) — NOT `express.json()`,
  which would JSON-parse (and fail on) a gzipped body.
- Next App-Router: `await request.arrayBuffer()` → `Buffer`.
- Next Pages-API / plain Node: read the `IncomingMessage` stream to a Buffer (disable any auto-body-parse).
Document this prominently — it is the single most likely mount bug.

**Overlap heads-up (see epic dependency graph):** S4 (TS mounts) is TS-only and can run independently of
S2 (Python) after S1. S3's from-config factory wraps S4's TS mounts (the TS receiver from-config wiring),
so S3 and S4 touch overlapping TS receiver files — run S3 after (or coordinated with) S4 for the TS
factory wiring, per the epic dependency graph. S4 also edits `index.ts` (exports) — coordinate the export
add with S3's factory export.

**Test posture.** Drive each mount with a fake/minimal request (canned raw body bytes + headers,
gzipped and raw variants) and the S1 `createFakeDbExecute` — assert the core is called with the raw body
+ headers and the response maps from the neutral outcome. No real Express/Next server, no real Postgres.
Mirror how S1 asserts the upsert against the fake and how the send-side tests use the minimal structural
`NodeFetch` rather than a real server.

## Shipped

<!-- Empty at draft. /implement-epics fills this on move to stories/5-done/. Do not hand-edit. -->
