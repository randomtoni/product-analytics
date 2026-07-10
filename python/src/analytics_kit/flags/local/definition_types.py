"""The adapter-internal flag-DEFINITION vocabulary: the shape the definitions endpoint speaks, which
the poller fetches and the evaluator matches against.

None of it appears on the neutral surface — the resolution layer reads a resolved ``FlagSet``, never
these types. A future backend adapter negotiating a different definition wire supplies its own. The
definitions arrive as plain JSON dicts, so the evaluator reads them with ``.get(...)`` rather than
attribute access; these ``TypedDict``\\ s document the shape without forcing a parse step.
"""

# De-branded from posthog's node PostHogFeatureFlag / FeatureFlagCondition / FlagProperty /
# PropertyGroup and the FlagDefinitionCacheData snapshot.

from __future__ import annotations

from dataclasses import dataclass, field

# A property comparison value: a scalar, a list (membership), or a boolean. The evaluator reads these
# untyped off JSON dicts, so this alias is documentation, not a runtime bound.
FlagPropertyValue = object

# The property bag an actor is described by (person or a focused group's properties).
PropertyBag = dict[str, object]

# A single definition / condition / property is a raw JSON dict — read with `.get(...)`. Aliased so
# the evaluator signatures read intentionally rather than as bare `dict[str, object]`.
FlagDefinition = dict[str, object]
FlagCondition = dict[str, object]
FlagProperty = dict[str, object]
FlagVariant = dict[str, object]
PropertyGroup = dict[str, object]


@dataclass(frozen=True)
class DefinitionSnapshot:
    """The parsed, in-memory definition snapshot the poller holds and the evaluator reads.

    Replaced atomically on each successful poll so an evaluation pass reads one consistent
    generation. ``flags_by_key`` is the O(1) lookup built alongside ``flags``; ``group_type_mapping``
    resolves a flag's aggregation index to a group name; ``cohorts`` is the locally-fetched cohort
    map. Frozen so a read never observes a half-updated snapshot.
    """

    flags: tuple[FlagDefinition, ...] = ()
    flags_by_key: dict[str, FlagDefinition] = field(default_factory=dict)
    group_type_mapping: dict[str, str] = field(default_factory=dict)
    cohorts: dict[str, PropertyGroup] = field(default_factory=dict)


EMPTY_SNAPSHOT = DefinitionSnapshot()
"""The frozen empty snapshot the poller holds before the first successful load — never ``None``, so a
read before readiness never crashes."""
