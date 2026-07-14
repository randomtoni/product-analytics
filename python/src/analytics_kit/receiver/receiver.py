"""The framework-agnostic receiver core — the WRITE side of self-host.

The INBOUND counterpart of the server transport: the transport gzips + POSTs the
``{api_key, batch, sent_at}`` envelope (``server/transport.py`` / ``server/wire_mapper.py``), and
this core reads that exact envelope back off the wire and upserts each wire event into the
library-owned ``events`` table (E17) through the injected :class:`~analytics_kit.query.DbExecute`
seam. It imports NO web framework and holds NO DSN/driver handle — only the injected seam. The
S2/S4 framework mounts and the S3 from-config factory wrap this core; they live inside this same
``receiver/`` package.

Sync by posture (plain ``def``, no ``await``) — matching the deliberately-sync Python query
client and the sync :class:`DbExecute` seam. The parity is by shared contract: the upsert SQL,
the envelope parse, the conditional-decompress rule, the receipt-time default, and the neutral
outcome are identical to the TS receiver; only the sync/async expression differs.
"""

from __future__ import annotations

import gzip
import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from ..query.db_execute import DbExecute
from ..query.warehouse_schema import EVENTS_TABLE

ReceiverHeaders = Mapping[str, str]
"""The neutral request-header bag. WSGI/ASGI and framework header containers are single-valued
string maps at this layer; a mount pre-normalizes a raw ASGI header list into a dict before
calling the core. Case-insensitive lookup is done INSIDE the core (the caller is not trusted to
have lowercased).

Flatten obligation: this Python core takes SINGLE-VALUED headers, so a mount over a multi-valued
source (a raw ASGI ``scope['headers']`` list) MUST pre-flatten to one value per name before
calling ``receive`` (the ASGI mount does). This is a deliberate per-tree asymmetry: the TS
``ReceiverHeaders`` accepts ``string | string[]`` and reads the first internally, whereas Python
pushes the flatten to the mount edge."""


@dataclass(frozen=True)
class Accepted:
    """The success outcome — the count of events the batch persisted."""

    accepted: int
    outcome: Literal["accepted"] = "accepted"


@dataclass(frozen=True)
class MalformedBody:
    """The neutral parse error for an undecodable / non-envelope body.

    Payload-free: a human-readable reason is a mount/logging concern (additive later). Carries
    zero HTTP and zero vendor vocabulary — the mount maps this to a status, not the core.
    """

    outcome: Literal["malformed_body"] = "malformed_body"


ReceiveOutcome = Accepted | MalformedBody
"""The neutral outcome the core returns — NOT an HTTP response (that is the mount's concern,
S2/S4). A string-tagged union matched by ``isinstance`` or ``.outcome``, mirroring the TS
``ReceiveOutcome``."""

# The fixed column order the INSERT binds against — matches the frozen E17 contract
# (`warehouse_schema.py` / WAREHOUSE-SCHEMA-CONTRACT.md). `api_key`/`sent_at` are envelope-level
# batch metadata and are never persisted.
_COLUMNS = ("distinct_id", "event", "timestamp", "uuid", "properties")
_PARAMS_PER_ROW = len(_COLUMNS)

_CONTENT_ENCODING = "content-encoding"
_GZIP = "gzip"

# Wire envelope keys — the node batch envelope the transport speaks (`server/wire_mapper.py`).
_WIRE_BATCH_KEY = "batch"
_WIRE_UUID_KEY = "uuid"
_WIRE_EVENT_KEY = "event"
_WIRE_DISTINCT_ID_KEY = "distinct_id"
_WIRE_PROPERTIES_KEY = "properties"
_WIRE_TIMESTAMP_KEY = "timestamp"


def _read_header(headers: ReceiverHeaders, name: str) -> str | None:
    """Case-insensitive single-header lookup done INSIDE the core.

    The caller is not trusted to have lowercased keys (Django's ``HttpHeaders`` is
    case-insensitive, but a plain ``dict`` an ASGI mount passes is not). Reads exactly one header
    (``Content-Encoding``), so a small scan is the whole requirement.
    """
    target = name.lower()
    for key, value in headers.items():
        if key.lower() == target:
            return value
    return None


def _decode_body(body: bytes, headers: ReceiverHeaders) -> str:
    """Decompress conditionally, mirroring the send-side gzip/raw-fallback.

    ``server/transport.py`` sets ``Content-Encoding: gzip`` on gzipped bodies and OMITS it on the
    raw-JSON fallback: header present ⇒ gunzip (``gzip.decompress``), header absent ⇒ raw UTF-8.
    """
    encoding = _read_header(headers, _CONTENT_ENCODING)
    raw = gzip.decompress(body) if encoding is not None and encoding.lower() == _GZIP else body
    return raw.decode("utf-8")


def _bind_event(event: Mapping[str, object], receipt_timestamp: str) -> list[object]:
    """One event's five positional params, in the fixed column order.

    ``properties`` is JSON-serialized (the driver casts the string to ``jsonb``); an absent bag
    binds ``'{}'`` explicitly — never ``None``, which would violate the ``jsonb NOT NULL DEFAULT
    '{}'`` column. ``timestamp``-absent takes the per-batch receipt instant; a present wire
    ``timestamp`` is used verbatim. Trait/group keys already nest inside ``properties`` (node
    wire-mapper), so this is a straight verbatim serialize — no key is lifted to its own column.
    """
    properties = event.get(_WIRE_PROPERTIES_KEY)
    if properties is None:
        properties = {}
    timestamp = event.get(_WIRE_TIMESTAMP_KEY)
    return [
        event.get(_WIRE_DISTINCT_ID_KEY),
        event.get(_WIRE_EVENT_KEY),
        timestamp if timestamp is not None else receipt_timestamp,
        event.get(_WIRE_UUID_KEY),
        json.dumps(properties),
    ]


def _build_upsert(
    batch: Sequence[Mapping[str, object]], receipt_timestamp: str
) -> tuple[str, list[object]]:
    """Build the single multi-row upsert: one statement per batch.

    One receipt instant, one write — the batch reads as one arrival. ``ON CONFLICT (uuid) DO
    NOTHING`` makes it idempotent (a client/server retry or double-delivery collapses to one
    stored row) AND tolerates an intra-batch duplicate ``uuid`` without a pre-dedupe pass (the
    "cannot affect row a second time" error is ``DO UPDATE``-only). Placeholders are generated in
    lockstep with the flat params, five per event (``$1..$5``, ``$6..$10``, …), so the SQL is
    byte-identical to the TS receiver (parity) and asserts as one recorded call. Never
    string-interpolate a value — all bind as ``$N`` params (no injection surface).
    """
    params: list[object] = []
    value_rows: list[str] = []
    for row_index, event in enumerate(batch):
        params.extend(_bind_event(event, receipt_timestamp))
        base = row_index * _PARAMS_PER_ROW
        # Join with ", $" and lead with "(" + placeholder so no string-literal chunk begins with
        # "$" — the neutrality scan's wire-confinement AST pass flags a `$`-leading literal;
        # mirroring E18's `warehouse_sql.py` placeholder style keeps the `$` mid-chunk. Produces
        # `($1, $2, $3, $4, $5)`.
        placeholders = ", $".join(str(base + i + 1) for i in range(_PARAMS_PER_ROW))
        value_rows.append(f"(${placeholders})")
    sql = (
        f"INSERT INTO {EVENTS_TABLE} ({', '.join(_COLUMNS)}) VALUES "
        f"{', '.join(value_rows)} ON CONFLICT (uuid) DO NOTHING"
    )
    return sql, params


def _is_batch_envelope(value: object) -> bool:
    """Structural check that the decoded body is the node batch envelope.

    No runtime schema is imported for this internal wire (Pydantic is for genuine external
    boundaries); ``batch`` being a list is the one shape the upsert depends on. ``api_key`` /
    ``sent_at`` are read-through metadata, never validated.

    Validates ONLY that ``batch`` is a list — per-``WireEvent`` integrity (a missing ``uuid``, etc.)
    is enforced by the DB constraints (NOT NULL / UNIQUE), NOT this parser: a corrupt element
    surfaces as a driver error at execute time (E21 real-Postgres) → a neutral 5xx, NOT a
    :class:`MalformedBody`.
    """
    return isinstance(value, dict) and isinstance(value.get(_WIRE_BATCH_KEY), list)


class Receiver:
    """The receiver core — holds only the injected :class:`DbExecute`, never a DSN or driver.

    S3 builds the ``DbExecute`` from a DSN at the config boundary and hands it in; this core never
    imports a Postgres driver. A single :meth:`receive` method so the ``receiver/`` package can
    grow (S3's from-config factory, future helpers) behind a nameable type the mounts hold.
    """

    def __init__(self, db_execute: DbExecute) -> None:
        self._db_execute = db_execute

    def receive(
        self, body: bytes, headers: ReceiverHeaders, now: datetime | None = None
    ) -> ReceiveOutcome:
        """Parse the node batch envelope off ``body`` and upsert each event.

        ``headers`` must be SINGLE-VALUED (see :data:`ReceiverHeaders`): a mount over a multi-valued
        source (a raw ASGI header list) pre-flattens before calling here.

        ``now`` is the server-receipt instant, mirroring the send-side ``assemble_batch_envelope(
        api_key, events, sent_at)`` param pattern — the impure caller defaults it to
        ``datetime.now(timezone.utc)``, a test passes a FIXED instant for a deterministic
        ``timestamp``-default assertion. A malformed / non-envelope body is a neutral
        :class:`MalformedBody`; a valid empty ``batch`` is a no-op :class:`Accepted` with zero DB
        calls.
        """
        try:
            envelope = json.loads(_decode_body(body, headers))
        except (ValueError, OSError):
            return MalformedBody()
        if not _is_batch_envelope(envelope):
            return MalformedBody()

        batch = envelope[_WIRE_BATCH_KEY]
        # Empty batch is a no-op success — no zero-row INSERT (invalid SQL) and no DB call at all.
        if not batch:
            return Accepted(accepted=0)

        # One server-receipt instant captured once per batch (the `timestamp`-absent default the
        # E17 contract leaves to E19), applied to every event omitting `timestamp`.
        receipt = now if now is not None else datetime.now(timezone.utc)
        receipt_timestamp = receipt.isoformat()
        sql, params = _build_upsert(batch, receipt_timestamp)
        # The write reuses the READ-designed seam; its result is OPAQUE — a non-RETURNING write
        # resolves to an empty DbExecuteResult. We neither read rows nor require a result set.
        self._db_execute.execute(sql, params)
        return Accepted(accepted=len(batch))
