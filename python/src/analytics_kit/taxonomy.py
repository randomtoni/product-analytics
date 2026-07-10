"""The typed taxonomy — the library's OWN full-fidelity typing surface.

A taxonomy is one declaration that does two jobs. :func:`define_taxonomy` returns a
:class:`Taxonomy` whose ``.decl`` is the walkable registry that both drives
:func:`derive_allowlist_from_taxonomy` (the allowlist convenience) and powers runtime
prop-type validation at capture time. The declaration types what the consumer declares;
anything undeclared is out-of-taxonomy and passes through untouched.

This surface has zero vendor analogue — it is ported from the TypeScript
``taxonomy.ts``/``allowlist.ts`` seam, not de-branded from any SDK. It ships no event names:
the vocabulary is entirely consumer-supplied.

The guarantee (state it, don't hide it)
---------------------------------------
This library promises **runtime-registry parity + best-effort static typing — NOT
compile-time parity with the TypeScript surface.** The runtime registry
(:func:`define_taxonomy` + :func:`validate_event_props`) is full fidelity: at capture time
the event name selects its declared prop shape and a wrong-typed prop is caught. The static
layer is best-effort: Python has no const generics, so the library cannot infer a
per-event-name → prop-shape map from a single ``define_taxonomy(...)`` value the way the TS
mapped types (``ShapeOf``/``PropsOf``) do. Static event-name and prop-shape checking exists
**only where the consumer hand-declares it** — that hand-mirroring is the honest gap.

Best-effort static typing recipe
--------------------------------
The consumer authors a typed **view** ``Protocol`` (one ``@overload`` of ``capture`` per
declared event, each pinning ``event: Literal["<name>"]`` and ``properties`` to a per-event
``TypedDict``) and applies it with :func:`cast` — a runtime no-op. Because it is a ``cast``,
not a subclass, there is no LSP / ``[override]`` conflict, and the PY-runtime provider
signature is untouched (adding a taxonomy is config-only).

Import ``TypedDict``/``Protocol``/``cast`` from this module (re-exported for convenience) and
``overload``/``Literal`` from ``typing`` directly — linters (ruff/flake8) only recognize the
``@overload`` decorator and the ``Literal[...]`` special form when imported from ``typing``,
so taking those two from ``typing`` keeps the pattern lint-clean::

    from typing import Literal, overload
    from analytics_kit.taxonomy import Protocol, TypedDict, cast
    from analytics_kit import create_analytics

    class SignedUp(TypedDict):
        plan: str
        seats: int

    class Checkout(TypedDict):
        total: int

    class TypedAnalytics(Protocol):
        @overload
        def capture(
            self, distinct_id: str, event: Literal["signed_up"],
            properties: SignedUp, *, dedupe_id: str | None = ...,
        ) -> None: ...
        @overload
        def capture(
            self, distinct_id: str, event: Literal["checkout"],
            properties: Checkout, *, dedupe_id: str | None = ...,
        ) -> None: ...

    analytics = cast(TypedAnalytics, create_analytics(config, adapter))
    analytics.capture("u1", "signed_up", {"plan": "pro", "seats": 3})  # checked

Author the view with **two or more overloads**: at ≥2 overloads every static violation (bad
event name / wrong prop type / missing required prop) surfaces uniformly as
``[call-overload]``; a single-overload view splits the codes and adds a ``[misc]`` warning.
The ``Literal`` name union and per-event ``TypedDict``\\ s are consumer-authored — the library
cannot generate them (the const-generic wall). The runtime ``.decl`` is the source of truth
the consumer mirrors by hand. A consumer who declares no view keeps the loose runtime
surface (``event: str``, ``properties: dict[str, object]``) and still type-checks.
"""

from __future__ import annotations

import datetime
from typing import Literal, Protocol, TypedDict, TypeVar, cast

from .allowlist import ViolationPolicy, emit_violation
from .neutral_event import NeutralProperties

__all__ = [
    "PropType",
    "PropDecl",
    "TaxonomyDecl",
    "Taxonomy",
    "define_taxonomy",
    "validate_event_props",
    "derive_allowlist_from_taxonomy",
    "SingleEventCapture",
    # Typing re-exports for the best-effort static-typing recipe (see module docstring).
    # Only the three that re-export lint-cleanly are surfaced here; `overload` and `Literal`
    # are imported from `typing` directly in the recipe (linters special-case those two).
    "TypedDict",
    "Protocol",
    "cast",
]

PropType = Literal["string", "number", "boolean", "date"]
"""The per-prop type-witness vocabulary (pure data), ported from TS."""

PropDecl = dict[str, PropType]
"""A prop-name → type-tag map for one event / trait bag / group."""


class _TaxonomyDeclBase(TypedDict):
    events: dict[str, PropDecl]


class TaxonomyDecl(_TaxonomyDeclBase, total=False):
    """The runtime-walkable declaration :func:`define_taxonomy` wraps.

    ``events`` is required (declared on the ``total=True`` base, matching the TS
    ``TaxonomyDecl`` where ``events`` has no ``?``); ``traits`` and ``groups`` are optional.
    There is deliberately no ``page`` slot: the TS ``TaxonomyDecl`` carries an optional
    ``page`` for browser pageview typing, but the server has no pageview surface (``page`` is
    N-A by platform, see ``provider.py``), so the slot is a server omission by design, not a
    port miss — the derive helper accordingly has no page branch to exclude.
    """

    traits: PropDecl
    groups: dict[str, PropDecl]


class Taxonomy:
    """The runtime registry returned by :func:`define_taxonomy`.

    A concrete class exposing ``.decl`` — concreteness is load-bearing: Pydantic holds the
    object on ``AnalyticsConfig.taxonomy`` via an ``isinstance(value, Taxonomy)`` guard under
    ``arbitrary_types_allowed``, so a real runtime class (not a ``Protocol``, not a bare
    object) is required for a raw-dict ``taxonomy`` to fail at the config boundary. A plain
    class (not a dataclass) keeps Pydantic from introspecting it as a schema-bearing model —
    it is held opaque and untouched. ``.decl`` is what :func:`derive_allowlist_from_taxonomy`
    walks and the static layer brands off.
    """

    def __init__(self, decl: TaxonomyDecl) -> None:
        self.decl = decl


def define_taxonomy(decl: TaxonomyDecl) -> Taxonomy:
    """Wrap a taxonomy declaration into a runtime :class:`Taxonomy` registry.

    Reserves NOTHING — no reserved event-name set, no reserved-key prefix. Deliberate server
    omission: the TS ``page``/``pageleave`` reservation exists only for browser nameless-
    fallback / unload paths the server lacks, and internal events are recognized by the
    structural ``internal_kind`` discriminant, not by name — so a consumer may freely declare
    an event named ``set_traits``. The ``__ak_`` reserved prefix is browser-persistence
    substrate guarding a shared super-prop store the server does not have.

    ``events`` is required by the type layer; the runtime guard here catches an untyped
    caller who omits it, failing loudly at the boundary instead of surfacing a bare
    ``KeyError`` deep inside the derive helper or the validator.
    """
    if "events" not in decl:
        raise ValueError('analytics-kit: taxonomy declaration must include an "events" mapping')
    return Taxonomy(decl=decl)


_TYPE_MAP: dict[PropType, tuple[type, ...]] = {
    "string": (str,),
    "number": (int, float),
    "boolean": (bool,),
    "date": (datetime.datetime,),
}


def _matches(tag: PropType, value: object) -> bool:
    # bool is a subclass of int: a `boolean`-tagged bool must not satisfy `number`, and a
    # `number`-tagged bool must be rejected — so `number` excludes bool explicitly rather
    # than relying on isinstance(True, int).
    if tag == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    return isinstance(value, _TYPE_MAP[tag])


def validate_event_props(
    taxonomy: Taxonomy | None,
    on_violation: ViolationPolicy,
    event: str,
    props: NeutralProperties | None,
) -> bool:
    """Validate a capture's supplied props against the event's declared prop types.

    Capture-scoped only: ``capture`` is the one verb where a runtime value (the event name)
    selects the prop shape, which is exactly the gap static typing leaves. ``set`` /
    ``set_group_traits`` trait shapes are not name-selected at runtime and are NOT validated
    here (they are already key-gated by the allowlist).

    Two explicit pass-through branches (neither raises nor drops): (1) no ``taxonomy`` ⇒
    inert; (2) an ``event`` not declared in ``decl.events`` ⇒ out-of-taxonomy, unvalidated.
    When the event is declared, each supplied prop that is ALSO declared is type-checked; a
    prop absent from the decl (or a declared-but-absent prop) is not a type error here —
    presence/completeness is the static layer's concern. A wrong-typed declared prop raises
    (``throw``) or drops-and-error-logs (returns ``False``) per ``on_violation`` — the same
    policy instance the allowlist honors.
    """
    if taxonomy is None:
        return True
    prop_decl = taxonomy.decl["events"].get(event)
    if prop_decl is None:
        return True
    if props is None:
        return True
    for key, value in props.items():
        tag = prop_decl.get(key)
        if tag is None:
            continue
        if _matches(tag, value):
            continue
        message = (
            f'analytics-kit: property "{key}" for event "{event}" expected type '
            f'"{tag}" but got {type(value).__name__}'
        )
        if on_violation == "throw":
            raise ValueError(message)
        emit_violation(message)
        return False
    return True


def derive_allowlist_from_taxonomy(taxonomy: Taxonomy) -> list[str]:
    """Derive a deduped allowlist from a taxonomy's declared prop keys — consumer-invoked.

    Walks ``decl.events`` prop keys + ``decl.traits`` keys + ``decl.groups`` prop keys (the
    VALUES' keys) — so no event NAMES and no group-TYPE names leak. Returns a deduped list;
    ordering is not part of the contract. A keyless taxonomy derives ``[]``.

    This is a standalone convenience the consumer composes into ``config.allowlist`` by
    spread (``allowlist=[*derive_allowlist_from_taxonomy(tax), "super_prop"]``). Supplying a
    taxonomy NEVER auto-derives or activates the allowlist guard — a taxonomy is a typing
    decision, not a privacy decision.
    """
    decl = taxonomy.decl
    keys: set[str] = set()
    for prop_decl in decl["events"].values():
        keys.update(prop_decl)
    traits = decl.get("traits")
    if traits:
        keys.update(traits)
    groups = decl.get("groups")
    if groups:
        for prop_decl in groups.values():
            keys.update(prop_decl)
    return list(keys)


_EventName = TypeVar("_EventName", bound=str, contravariant=True)
_Props = TypeVar("_Props", contravariant=True)


class SingleEventCapture(Protocol[_EventName, _Props]):
    """Optional boilerplate convenience for a ONE-event typed view — NOT the mechanism.

    Parametrizing this binds ``capture`` to a single ``event`` name and its prop shape:
    ``cast(SingleEventCapture[Literal["signed_up"], SignedUp], create_analytics(...))``. It
    saves writing one ``@overload`` by hand but expresses only ONE event per parametrization —
    it cannot carry the whole name→shape map (the const-generic wall). For more than one typed
    event, author the multi-``@overload`` view ``Protocol`` in the module-docstring recipe;
    that recipe is the mechanism, this is a shorthand for the single-event case.
    """

    def capture(
        self,
        distinct_id: str,
        event: _EventName,
        properties: _Props,
        *,
        dedupe_id: str | None = ...,
    ) -> None: ...
