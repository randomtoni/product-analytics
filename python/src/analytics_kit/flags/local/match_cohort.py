"""The recursive cohort sub-engine — a cohort is a nested AND/OR boolean tree over leaf property
filters; a leaf may itself reference another cohort.

Ported in behavior from the TS-node ``match-cohort.ts`` (the de-branded neutral seam), which ports
the reference ``match_cohort`` / ``match_property_group``. All synchronous, pure functions.
"""

# De-branded from posthog's feature_flags.py match_cohort / match_property_group.

from __future__ import annotations

from .definition_types import FlagProperty, PropertyBag, PropertyGroup
from .errors import InconclusiveMatchError, RequiresServerEvaluation
from .match_property import match_property


def match_cohort(
    prop: FlagProperty,
    property_values: PropertyBag,
    cohorts: dict[str, PropertyGroup],
) -> bool:
    """True iff the actor is in the referenced cohort. Raises ``RequiresServerEvaluation`` when the
    cohort id is absent from the locally-fetched map (a static cohort — server-only data), and
    ``InconclusiveMatchError`` when a leaf property can't be decided locally."""
    cohort_id = str(prop.get("value"))
    if cohort_id not in cohorts:
        raise RequiresServerEvaluation(
            f"cohort {cohort_id} is not in the local cohort map — a static cohort that "
            "requires server evaluation"
        )
    return match_property_group(cohorts[cohort_id], property_values, cohorts)


def match_property_group(
    property_group: PropertyGroup,
    property_values: PropertyBag,
    cohorts: dict[str, PropertyGroup],
) -> bool:
    """Walk one AND/OR property group. A ``RequiresServerEvaluation`` from any leaf propagates
    immediately (server-only data). An ``InconclusiveMatchError`` is remembered but doesn't abort the
    walk — only if no branch resolves the group AND something was inconclusive does the group raise
    inconclusive."""
    if not property_group:
        return True
    group_type = property_group.get("type")
    properties = property_group.get("values")
    if not isinstance(properties, list) or len(properties) == 0:
        # Empty groups are no-ops — always match.
        return True

    error_matching_locally = False

    if isinstance(properties[0], dict) and "values" in properties[0]:
        # Nested property groups.
        for nested in properties:
            try:
                matches = match_property_group(nested, property_values, cohorts)
                if group_type == "AND":
                    if not matches:
                        return False
                elif matches:
                    return True
            except RequiresServerEvaluation:
                raise
            except InconclusiveMatchError:
                error_matching_locally = True
    else:
        # Leaf property filters.
        for leaf in properties:
            try:
                if leaf.get("type") == "cohort":
                    matches = match_cohort(leaf, property_values, cohorts)
                elif leaf.get("type") == "flag":
                    # Flag-dependency chains are deferred (remote handles them): any flag-typed
                    # property inside a cohort is inconclusive locally.
                    raise InconclusiveMatchError(
                        f"Flag dependency '{leaf.get('key')}' cannot be evaluated locally"
                    )
                else:
                    matches = match_property(leaf, property_values)

                negation = bool(leaf.get("negation", False))
                if group_type == "AND":
                    if not matches and not negation:
                        return False
                    if matches and negation:
                        return False
                else:
                    if matches and not negation:
                        return True
                    if not matches and negation:
                        return True
            except RequiresServerEvaluation:
                raise
            except InconclusiveMatchError:
                error_matching_locally = True

    if error_matching_locally:
        raise InconclusiveMatchError("Cannot match cohort without the required property value")
    # All matched in the AND case, or none matched in the OR case.
    return group_type == "AND"
