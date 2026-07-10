"""The typed taxonomy — the library's OWN full-fidelity typing surface.

A taxonomy is one declaration that does two jobs. :func:`define_taxonomy` returns a
:class:`Taxonomy` whose ``.decl`` is the walkable registry that both drives
:func:`derive_allowlist_from_taxonomy` (the allowlist convenience) and powers runtime
prop-type validation at capture time. The declaration types what the consumer declares;
anything undeclared is out-of-taxonomy and passes through untouched.

This surface has zero vendor analogue — it is ported from the TypeScript
``taxonomy.ts``/``allowlist.ts`` seam, not de-branded from any SDK. It ships no event names:
the vocabulary is entirely consumer-supplied.
"""

from __future__ import annotations

import datetime
from typing import Literal, TypedDict

from .allowlist import ViolationPolicy, emit_violation
from .neutral_event import NeutralProperties

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
