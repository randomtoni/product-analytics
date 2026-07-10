"""The pure, synchronous in-process flag evaluator.

Ported in behavior from the TS-node ``evaluator.ts`` (the de-branded neutral seam), which ports the
reference ``compute_flag_value``/``match_feature_flag_properties``/``is_condition_match``/
``get_matching_variant``/``variant_lookup_table`` + the bucketing-value resolution. No I/O, no timers,
no HTTP: a pure function of ``(definition, bucketing value, properties, cohort map)``. Returns a
resolved ``FlagValue`` (``str | bool``) or RAISES one of the two inconclusive signals for the
resolution layer to catch.
"""

# De-branded from posthog's feature_flags.py compute_flag_value / match_feature_flag_properties /
# is_condition_match / get_matching_variant / variant_lookup_table / get_bucketing_value_for_flag.

from __future__ import annotations

from typing import NamedTuple

from ...ports import FlagContext, FlagValue
from .definition_types import (
    DefinitionSnapshot,
    FlagCondition,
    FlagDefinition,
    PropertyBag,
    PropertyGroup,
)
from .errors import InconclusiveMatchError, RequiresServerEvaluation
from .hash import bucket_hash
from .match_cohort import match_cohort
from .match_property import match_property

# The salt appended to the bucketing value when banding variants (with NO separator). Rollout
# bucketing uses no salt.
_VARIANT_SALT = "variant"


def evaluate_flag_locally(
    definition: FlagDefinition,
    bucketing_value: str,
    person_properties: PropertyBag,
    cohorts: dict[str, PropertyGroup],
) -> FlagValue:
    """Match a definition against a KNOWN bucketing value and the actor's properties, resolving to a
    ``FlagValue`` or raising an inconclusive signal. The pure matching engine — it never resolves the
    bucketing value itself (that's :func:`resolve_bucketing_value`)."""
    # An inactive flag is always False, regardless of continuity. Order matters: checking continuity
    # first would return inconclusive for a disabled-but-continuity flag instead of the correct False.
    if not definition.get("active"):
        return False
    if definition.get("ensure_experience_continuity"):
        raise InconclusiveMatchError("Flag has experience continuity enabled")

    filters = definition.get("filters")
    conditions = _as_list(_as_dict(filters).get("groups"))
    is_inconclusive = False

    # The reference's `early_exit` short-circuit is intentionally NOT ported: every group is
    # evaluated. This is strictly more conservative — an early rollout-excluded group followed by an
    # inconclusive one goes inconclusive (-> remote fallback) where the reference would return False.
    # Never wrong; the reference only sets early_exit on all-locally-evaluable flags.
    for condition in conditions:
        try:
            if _is_condition_match(definition, bucketing_value, _as_dict(condition), person_properties, cohorts):
                variant_override = condition.get("variant") if isinstance(condition, dict) else None
                variants = _variants(definition)
                if isinstance(variant_override, str) and any(
                    v.get("key") == variant_override for v in variants
                ):
                    return variant_override
                return _get_matching_variant(definition, bucketing_value) or True
        except RequiresServerEvaluation:
            # Static cohort / server-only data — propagate immediately.
            raise
        except InconclusiveMatchError:
            # Remember, but let other OR groups try — an inconclusive group must not poison the rest.
            is_inconclusive = True

    if is_inconclusive:
        raise InconclusiveMatchError(
            "Can't determine whether the flag is enabled with the given properties"
        )
    # Only False when every condition was False.
    return False


def _is_condition_match(
    definition: FlagDefinition,
    bucketing_value: str,
    condition: FlagCondition,
    properties: PropertyBag,
    cohorts: dict[str, PropertyGroup],
) -> bool:
    """True iff the actor satisfies a single condition group: all property filters match (AND), then
    the rollout gate admits the bucketing value. Empty properties skip the filter block and fall
    straight to the rollout gate. Raises an inconclusive signal for an undecidable leaf."""
    rollout_percentage = condition.get("rollout_percentage")
    filters = _as_list(condition.get("properties"))

    if len(filters) > 0:
        for prop in filters:
            prop_type = prop.get("type")
            if prop_type == "cohort":
                in_cohort = match_cohort(prop, properties, cohorts)
                # A flag-level cohort condition carries a membership operator ('in' | 'not_in');
                # match_cohort reports raw membership, so 'not_in' inverts it here.
                matches = not in_cohort if prop.get("operator") == "not_in" else in_cohort
            elif prop_type == "flag":
                raise InconclusiveMatchError(
                    f"Flag dependency '{prop.get('key')}' cannot be evaluated locally"
                )
            else:
                matches = match_property(prop, properties)
            if not matches:
                return False
        if rollout_percentage is None:
            return True

    # Property filters (if any) matched; apply the rollout gate. Inclusion is `hash <= rollout/100`;
    # divide by 100.0 (float). 0% admits effectively no one; 100% admits everyone incl. the 1.0 edge.
    if rollout_percentage is not None:
        rollout = float(rollout_percentage)  # type: ignore[arg-type]
        if bucket_hash(str(definition.get("key")), bucketing_value) > rollout / 100.0:
            return False
    return True


def _get_matching_variant(definition: FlagDefinition, bucketing_value: str) -> str | None:
    """The variant, if any, the bucketing value lands in. Uses the 'variant' salt (an independent
    hash from the rollout gate). Bands are contiguous half-open ``[value_min, value_max)``, first
    match wins; a hash in a gap (variant percentages sum < 100) returns ``None`` and the flag
    resolves to bare ``True``."""
    hash_value = bucket_hash(str(definition.get("key")), bucketing_value, _VARIANT_SALT)
    for band in _variant_lookup_table(definition):
        if band.value_min <= hash_value < band.value_max:
            return band.key
    return None


class _VariantBand(NamedTuple):
    value_min: float
    value_max: float
    key: str


def _variant_lookup_table(definition: FlagDefinition) -> list[_VariantBand]:
    """Build the contiguous variant bands: cumulative running sums of ``rollout_percentage / 100`` in
    DECLARED array order (never sorted)."""
    table: list[_VariantBand] = []
    value_min = 0.0
    for variant in _variants(definition):
        value_max = value_min + float(variant["rollout_percentage"]) / 100.0  # type: ignore[arg-type]
        table.append(_VariantBand(value_min, value_max, str(variant.get("key"))))
        value_min = value_max
    return table


def _variants(definition: FlagDefinition) -> list[dict[str, object]]:
    multivariate = _as_dict(_as_dict(definition.get("filters")).get("multivariate"))
    variants = multivariate.get("variants")
    return [v for v in variants if isinstance(v, dict)] if isinstance(variants, list) else []


def resolve_bucketing_value(
    definition: FlagDefinition,
    context: FlagContext,
    group_type_mapping: dict[str, str],
) -> tuple[str, PropertyBag] | None:
    """Resolve the bucketing value for a flag from the neutral ``FlagContext`` + the group-type
    mapping. A group-aggregated flag buckets by the group key (from ``context["groups"][group_name]``);
    a person flag buckets by ``distinct_id``. Returns ``None`` when a group-aggregated flag's group
    isn't supplied (the reference resolves such a flag to bare False). Raises
    ``InconclusiveMatchError`` when the flag's group-type index isn't in the mapping."""
    aggregation_index = _as_dict(definition.get("filters")).get("aggregation_group_type_index")
    if aggregation_index is not None:
        group_name = group_type_mapping.get(str(aggregation_index))
        if not group_name:
            raise InconclusiveMatchError(
                f"Flag '{definition.get('key')}' references an unknown group type index"
            )
        groups = context.get("groups") or {}
        if group_name not in groups:
            return None
        group_properties = (context.get("group_properties") or {}).get(group_name) or {}
        return groups[group_name], dict(group_properties)

    distinct_id = context.get("distinct_id")
    if not distinct_id:
        raise InconclusiveMatchError(
            f"Flag '{definition.get('key')}' cannot be evaluated locally without a distinct_id"
        )
    return distinct_id, dict(context.get("person_properties") or {})


def compute_flag_locally(
    definition: FlagDefinition,
    context: FlagContext,
    snapshot: DefinitionSnapshot,
) -> FlagValue:
    """The higher-level entrypoint the resolution layer binds to: resolve the bucketing value from the
    neutral ``FlagContext`` + the poller's snapshot, then run the pure matcher. Returns a
    ``FlagValue`` or raises an inconclusive signal."""
    if not definition.get("active"):
        return False
    resolved = resolve_bucketing_value(definition, context, snapshot.group_type_mapping)
    if resolved is None:
        return False
    bucketing_value, properties = resolved
    return evaluate_flag_locally(definition, bucketing_value, properties, snapshot.cohorts)


def _as_dict(value: object) -> dict[str, object]:
    return value if isinstance(value, dict) else {}


def _as_list(value: object) -> list[dict[str, object]]:
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []
