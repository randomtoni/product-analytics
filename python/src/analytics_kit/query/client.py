"""The query read seam — the neutral ``AnalyticsQueryClient`` and the shapes it speaks.

This is the read-side counterpart to the capture seam: four business primitives
(funnel / retention / trend / unique-count) plus a ``raw_query`` escape hatch, each returning
one flat :class:`QueryResult`. The primitives are the highest-neutrality-risk surface in the
library — no query-dialect vocabulary (query kinds, a wire query language, an endpoint path)
may appear here or on the specs. ``raw_query`` is the ONE place a dialect surfaces, and it
surfaces as a VALUE (the string), never as a type — exactly like a DB driver's ``.query(sql)``.

The specs are library-built OUTBOUND descriptions, trusted-by-construction, so they are plain
``@dataclass``\\ es. :class:`QueryResult`/:class:`QueryColumn` decode external untrusted wire
JSON — the ONE genuine inbound-wire boundary in the query path — so they are Pydantic models.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Generic, Literal, Protocol, runtime_checkable

from pydantic import BaseModel, ConfigDict
from typing_extensions import TypeVar

from ..adapter import NeutralResponse


@dataclass
class Duration:
    """A neutral time span — a value plus a unit. Role-named; no vendor/dialect vocabulary."""

    value: int
    unit: Literal["minute", "hour", "day", "week", "month"]


Granularity = Literal["day", "week", "month"]
"""The retention bucket size — one neutral period grain."""

Aggregation = Literal["total", "unique", "dau"]
"""How a trend counts: raw ``total``, distinct actors (``unique``), or daily-active (``dau``)."""


@dataclass
class FunnelSpec:
    """A funnel across an ordered list of event steps within one window."""

    steps: list[str]
    within: Duration
    breakdown: str | None = None


@dataclass
class RetentionSpec:
    """A retention query: a cohort event, a return event, and a bucketed horizon."""

    cohort_event: str
    return_event: str
    periods: int
    granularity: Granularity
    breakdown: str | None = None


@dataclass
class TrendSpec:
    """A trend over one event, aggregated and windowed."""

    event: str
    aggregation: Aggregation
    window: Duration
    breakdown: str | None = None


@dataclass
class UniqueCountSpec:
    """A unique-actor count over one event within a window."""

    event: str
    window: Duration
    breakdown: str | None = None


@dataclass(frozen=True)
class TrendRow:
    """One trend data point — a time-bucket label and its numeric measure.

    Frozen and library-built (from already-parsed wire), so an engine-internal key can never be
    constructed onto it — the row-level neutrality proof. ``breakdown`` is present-as-null when
    the query was not broken down.
    """

    bucket: str
    value: float
    breakdown: str | None = None


@dataclass(frozen=True)
class UniqueCountRow:
    """One unique-count data point — same field set as :class:`TrendRow`, its own named concept.

    A distinct declared type, NOT an alias of :class:`TrendRow`: unique-count keeps its own row
    identity even though the fields coincide.
    """

    bucket: str
    value: float
    breakdown: str | None = None


@dataclass(frozen=True)
class FunnelStepRow:
    """One funnel step — its zero-based index, resolved event identity, count, and conversion.

    ``conversion_rate`` is this step's count over the first step's count (per breakdown group when
    broken down), guarded so a zero first step yields ``0``.
    """

    step: int
    event: str
    count: int
    conversion_rate: float
    breakdown: str | None = None


@dataclass(frozen=True)
class RetentionRow:
    """One retention cohort×period cell — cohort label, period offset, and retained measure.

    ``period_index`` ``0`` is the cohort's own period.
    """

    cohort: str
    period_index: int
    value: float
    breakdown: str | None = None


TRow = TypeVar("TRow", default="Mapping[str, object]")
"""The per-primitive row type carried by :class:`QueryResult`.

Unbounded with a PEP-696 default of ``Mapping[str, object]`` — the four structured primitives
narrow it to their row type; ``raw_query`` keeps the default. The default is a fallback type, NOT
a constraint (the row types are frozen dataclasses, not ``Mapping`` subtypes), so no ``bound=``.
"""


class QueryColumn(BaseModel):
    """One result column — a name and an optional engine-reported type.

    A Pydantic model because it is decoded from the untrusted wire response alongside
    :class:`QueryResult`. ``type`` is optional: the wire carries it only when the engine
    reports it.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    type: str | None = None


class QueryResult(BaseModel, Generic[TRow]):
    """The generic flat result all five primitives return — the inbound-wire boundary.

    One flat shape serves funnel/retention/trend/unique-count AND ``raw_query``; ``rows`` carries
    the per-primitive row type (``TRow``) — a narrowed neutral row for the four structured
    primitives, the ``Mapping[str, object]`` default for ``raw_query``'s column-keyed pass-through.
    ``columns`` is a DISTINCT ordered list, so an empty result still carries its schema.
    ``generated_at`` is the result's stamp; ``from_cache`` is optional because the wire flag is
    present only on cached responses (read defensively). A Pydantic model because the wire JSON is
    external and untrusted — a malformed response fails HERE, at the boundary, not deep in a
    consumer.
    """

    model_config = ConfigDict(extra="forbid")

    rows: Sequence[TRow]
    columns: list[QueryColumn]
    generated_at: str
    from_cache: bool | None = None


@runtime_checkable
class QueryTransport(Protocol):
    """The adapter-owned HTTP send seam for the query path — the injectable transport hook.

    Mirrors the neutral SPI ``send`` signature exactly (same verb, same arg order) so one
    vocabulary covers every HTTP send in the library. A single ``method``-carrying call serves
    both the query submit (POST) and the sync-blocking poll (GET) — the submit-vs-poll
    semantics are the HTTP adapter's concern (PY5-S2), above this hook. Returns the neutral
    :class:`~analytics_kit.NeutralResponse` (``status`` + ``body``), so no vendor or
    third-party client handle crosses the seam; the adapter reads ``.status``/``.body`` and
    decodes the body itself. Sync by posture — no coroutine.

    ``runtime_checkable`` so ``QueryClientConfig`` can hold it opaque under
    ``arbitrary_types_allowed`` (Pydantic ``isinstance``-guards an arbitrary-typed field) —
    the same posture the ingest ``Taxonomy`` field uses, here on a structural hook.
    """

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        """Send an HTTP request and return the neutral response."""
        ...


class AnalyticsQueryClient(Protocol):
    """The neutral read seam — four business primitives plus the ``raw_query`` escape hatch.

    A structural ``Protocol`` (matching the seam's convention): an adapter satisfies it by
    shape, never by subclassing. Every member returns a :class:`QueryResult` SYNCHRONOUSLY (no
    coroutine — the sync-client posture; the HTTP adapter's poll is a blocking ``time.sleep``,
    never asyncio). The specs are taxonomy-typed by consumer convention (best-effort static, per
    the taxonomy recipe); at the type level event names are plain ``str``. ``raw_query`` takes
    the dialect as a VALUE — the escape hatch is for the query LANGUAGE, never the result
    CONTRACT (it returns the same flat :class:`QueryResult`).
    """

    def funnel(self, spec: FunnelSpec) -> QueryResult[FunnelStepRow]: ...

    def retention(self, spec: RetentionSpec) -> QueryResult[RetentionRow]: ...

    def trend(self, spec: TrendSpec) -> QueryResult[TrendRow]: ...

    def unique_count(self, spec: UniqueCountSpec) -> QueryResult[UniqueCountRow]: ...

    def raw_query(self, expr: str) -> QueryResult: ...
