import { gunzipSync } from 'node:zlib';
import type { NeutralProperties } from '@randomtoni/analytics-kit';
import type { DbExecute } from '../query/db-execute';
import { EVENTS_TABLE } from '../query/warehouse-schema';
import type { WireBatchEnvelope, WireEvent } from '../wire-mapper';

// The framework-agnostic receiver core — the WRITE peer of the E18 warehouse-query adapter.
// It is the INBOUND counterpart of the node transport: the transport gzips + POSTs the
// `{ api_key, batch, sent_at }` envelope (see `send-batch.ts` / `wire-mapper.ts`), and this
// core reads that exact envelope back off the wire and upserts each `WireEvent` into the
// library-owned `events` table (E17) through the injected `DbExecute` seam. It imports NO web
// framework and holds NO DSN/driver handle — only the injected seam. The S2/S4 framework mounts
// and the S3 from-config factory wrap this core; they live inside this same `receiver/` package.

// The neutral request-header bag — a structural mirror of Node's `IncomingHttpHeaders`, NOT an
// import of it (mirrors `NodeFetch` in `send-batch.ts`, which re-declares a minimal `fetch`
// signature rather than importing DOM/undici types). Express `req.headers`, a raw
// `IncomingMessage.headers`, and a Fetch-`Headers`-derived bag all satisfy this structurally.
export interface ReceiverHeaders {
  [name: string]: string | string[] | undefined;
}

// The neutral outcome the core returns — NOT an HTTP response (that is the mount's concern, S2/S4).
// A string-tagged discriminated union (the house style: `NeutralEvent.internalKind`, `FlagReason`),
// so a mount switches on `outcome` and maps it to a status exhaustively. Carries zero HTTP and zero
// vendor vocabulary: `'malformed_body'` is transport-agnostic, and no status code is baked in.
export type ReceiveOutcome =
  | { outcome: 'accepted'; accepted: number }
  | { outcome: 'malformed_body' };

// The receiver core. A single `receive` method so the `receiver/` package can grow (S3's
// from-config factory, future helpers) behind a nameable type the mounts hold.
export interface Receiver {
  // `now` is the server-receipt instant, mirroring the send-side `assembleBatchEnvelope(apiKey,
  // events, now)` param pattern — the impure caller defaults it to `new Date()`, a test passes a
  // FIXED instant for a deterministic `timestamp`-default assertion. NOT a clock-hook.
  receive(body: Buffer, headers: ReceiverHeaders, now?: Date): Promise<ReceiveOutcome>;
}

// The fixed column order the INSERT binds against — matches the frozen E17 contract
// (`warehouse-schema.ts` / `WAREHOUSE-SCHEMA-CONTRACT.md`). `api_key`/`sent_at` are envelope-level
// batch metadata and are never persisted.
const COLUMNS = ['distinct_id', 'event', 'timestamp', 'uuid', 'properties'] as const;
const PARAMS_PER_ROW = COLUMNS.length;

const CONTENT_ENCODING = 'content-encoding';
const GZIP = 'gzip';

// Case-insensitive single-header lookup done INSIDE the core — the caller is not trusted to have
// lowercased keys (Node lowercases, but a Fetch-`Headers`-derived bag may not). Reads exactly one
// header (`Content-Encoding`), so a small scan is the whole requirement.
function readHeader(headers: ReceiverHeaders, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

// Decompress conditionally, mirroring the send-side gzip/raw-fallback (`send-batch.ts` sets
// `Content-Encoding: gzip` on gzipped bodies and OMITS it on the raw-JSON fallback): header
// present ⇒ gunzip, header absent ⇒ raw UTF-8.
function decodeBody(body: Buffer, headers: ReceiverHeaders): string {
  const encoding = readHeader(headers, CONTENT_ENCODING);
  const bytes = encoding !== undefined && encoding.toLowerCase() === GZIP ? gunzipSync(body) : body;
  return bytes.toString('utf8');
}

// One event's five positional params, in the fixed column order. `properties` is JSON-serialized
// (the driver casts the string to `jsonb`); an absent bag binds `'{}'` explicitly — never NULL,
// which would violate the `jsonb NOT NULL DEFAULT '{}'` column. `timestamp`-absent takes the
// per-batch receipt instant. Trait/group keys already nest inside `properties` (node wire-mapper),
// so this is a straight verbatim serialize — no key is lifted to its own column.
function bindEvent(event: WireEvent, receiptTimestamp: string): unknown[] {
  const properties: NeutralProperties = event.properties ?? {};
  return [
    event.distinct_id,
    event.event,
    event.timestamp ?? receiptTimestamp,
    event.uuid,
    JSON.stringify(properties),
  ];
}

// Build the single multi-row upsert: one statement per batch (architect 2026-07-14). One receipt
// instant, one write — the batch reads as one arrival. `ON CONFLICT (uuid) DO NOTHING` makes it
// idempotent (a client/server retry or double-delivery collapses to one stored row) AND tolerates
// an intra-batch duplicate `uuid` without a pre-dedupe pass (the "cannot affect row a second time"
// error is `DO UPDATE`-only). Placeholders are generated in lockstep with the flat params, five per
// event (`$1..$5`, `$6..$10`, …), so the SQL is byte-identical across trees and asserts as one
// `RecordedExec`. Never string-interpolate a value — all bind as `$N` params (no injection surface).
function buildUpsert(batch: WireEvent[], receiptTimestamp: string): {
  sql: string;
  params: unknown[];
} {
  const params: unknown[] = [];
  const valueRows = batch.map((event, rowIndex) => {
    params.push(...bindEvent(event, receiptTimestamp));
    const base = rowIndex * PARAMS_PER_ROW;
    const placeholders = Array.from({ length: PARAMS_PER_ROW }, (_, i) => `$${base + i + 1}`);
    return `(${placeholders.join(', ')})`;
  });
  const sql =
    `INSERT INTO ${EVENTS_TABLE} (${COLUMNS.join(', ')}) VALUES ` +
    `${valueRows.join(', ')} ON CONFLICT (uuid) DO NOTHING`;
  return { sql, params };
}

// A structural check that the decoded body is the node batch envelope. We do not import a runtime
// schema for this internal wire (Zod is for genuine external boundaries); `batch` an array is the
// one shape the upsert depends on. `api_key`/`sent_at` are read-through metadata, never validated.
function isBatchEnvelope(value: unknown): value is WireBatchEnvelope {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { batch?: unknown }).batch)
  );
}

export function createReceiver(dbExecute: DbExecute): Receiver {
  return {
    async receive(body, headers, now = new Date()): Promise<ReceiveOutcome> {
      let envelope: unknown;
      try {
        envelope = JSON.parse(decodeBody(body, headers));
      } catch {
        return { outcome: 'malformed_body' };
      }
      if (!isBatchEnvelope(envelope)) {
        return { outcome: 'malformed_body' };
      }

      const batch = envelope.batch;
      // Empty batch is a no-op success — no zero-row INSERT (invalid SQL) and no DB call at all.
      if (batch.length === 0) {
        return { outcome: 'accepted', accepted: 0 };
      }

      // One server-receipt instant captured once per batch (the `timestamp`-absent default the E17
      // contract leaves to E19), applied to every event omitting `timestamp`.
      const receiptTimestamp = now.toISOString();
      const { sql, params } = buildUpsert(batch, receiptTimestamp);
      // The write reuses the READ-designed seam; its result is OPAQUE — a non-RETURNING write
      // resolves to an empty `DbExecuteResult`. We neither read rows nor require a result set.
      await dbExecute(sql, params);
      return { outcome: 'accepted', accepted: batch.length };
    },
  };
}
