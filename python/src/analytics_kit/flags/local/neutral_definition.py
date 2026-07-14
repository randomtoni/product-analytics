"""The NEUTRAL, consumer-facing flag-DEFINITION contract — the shape a consumer authors static flag
definitions in, purpose-designed in neutral vocabulary rather than the adapter-internal wire shape
(``filters.groups`` / ``multivariate.variants`` / ``ensure_experience_continuity`` / index-based
aggregation).

The neutral definition is expressed as ``TypedDict``\\ s (the data model, snake_case idiomatic
Python) plus a Pydantic validation layer (:func:`validate_definitions`) that rejects a malformed set
LOUDLY at the seed boundary with the config layer's ``ValidationError`` — the same error type a bad
:class:`~analytics_kit.FlagClientConfig` raises. :func:`lower_definitions` is the pure mapping onto
the wire :class:`~analytics_kit.flags.local.definition_types.DefinitionSnapshot` the evaluator reads.

This type is the stable, versioned additive contract; the wire snapshot churns behind
:func:`lower_definitions`, which is the ONLY thing that knows both shapes. A future backend adapter
negotiating a different definition wire writes its own lowering from this SAME neutral type
(acceptance-bar-1 applied to definitions). Distinct from the frozen ``FeatureFlagPort`` / ``FlagSet``
/ ``FlagContext`` EVAL surface — this is the consumer-INPUT surface.
"""

from __future__ import annotations

import warnings
from typing import Literal, Union

# `typing_extensions.TypedDict` (not `typing.TypedDict`): Pydantic requires it on Python < 3.12 to
# generate a schema for a TypedDict embedded in a model — which the S2 `FlagClientConfig`
# `static_definitions: list[FeatureFlagDefinition]` field does. Behaviourally identical; the field
# shape is unchanged.
from typing_extensions import TypedDict

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from .definition_types import DefinitionSnapshot

# A property-comparison value: a scalar, a boolean, or a list (membership). Mirrors the operator
# engine's string-folding value model.
FlagFilterValue = Union[str, int, float, bool, "list[Union[str, int, float]]"]

# The CLOSED set of property-comparison operators the local operator engine (``match_property``)
# handles — the one place the neutral type diverges from the wire's open ``operator``. A closed union
# IS the consumer contract and what the validator checks. ADDITIVE-ONLY: adding an operator is
# non-breaking, renaming/removing one is breaking. These are exactly the 23 tokens the engine handles
# (cohort-membership ``in``/``not_in`` and flag-dependency ``flag`` are handled elsewhere and are
# scoped OUT of neutral v1, so they correctly do not appear here).
FlagFilterOperator = Literal[
    "exact",
    "is_not",
    "is_set",
    "is_not_set",
    "icontains",
    "not_icontains",
    "regex",
    "not_regex",
    "gt",
    "gte",
    "lt",
    "lte",
    "is_date_before",
    "is_date_after",
    "semver_eq",
    "semver_neq",
    "semver_gt",
    "semver_gte",
    "semver_lt",
    "semver_lte",
    "semver_tilde",
    "semver_caret",
    "semver_wildcard",
]


class PropertyFilter(TypedDict, total=False):
    """One property filter inside a condition. The actor's ``property`` value is compared against
    ``value`` under ``operator`` (default ``exact``); ``negated`` inverts the leaf match. Names the
    concept, not the wire token (``property`` = wire ``key``, ``negated`` = wire ``negation``)."""

    property: str
    operator: FlagFilterOperator
    value: FlagFilterValue
    negated: bool


class FlagCondition(TypedDict, total=False):
    """One targeting condition. ``property_filters`` AND together; the ``rollout_percentage`` gate
    applies after they match (omitted -> admit every matched actor). ``variant_override`` hard-selects
    a declared variant when the condition matches. Conditions across a definition OR together."""

    property_filters: list[PropertyFilter]
    rollout_percentage: float
    variant_override: str


class FlagVariant(TypedDict):
    """One multivariate variant and the share of matched traffic it claims. Bands are cumulative in
    DECLARED list order."""

    key: str
    rollout_percentage: float


class FeatureFlagDefinition(TypedDict, total=False):
    """A single neutral flag definition. ``enabled: False`` always resolves to False. ``conditions``
    omitted/empty -> nothing matches -> False. ``variants`` present -> multivariate, absent -> boolean.
    ``payloads`` is keyed by the RESOLVED value (a variant key, or ``'true'``); a ``'false'`` key is
    unreachable under local eval (the resolver returns early on a false-resolved flag before any
    payload lookup) but the type stays permissive — reachability is an adapter-internal mechanic, not
    a neutral-contract invariant."""

    key: str
    enabled: bool
    conditions: list[FlagCondition]
    variants: list[FlagVariant]
    payloads: dict[str, object]


# The property-comparison operator when a filter omits ``operator`` — matches the engine's
# ``prop.get("operator") or "exact"``.
_DEFAULT_OPERATOR = "exact"

_ROLLOUT_MIN = 0
_ROLLOUT_MAX = 100


# --- the Pydantic validation layer --------------------------------------------------------------
#
# Modeling the DEFINITION (not just wrapping the TypedDict): field-level constraints (the closed
# operator ``Literal``, the 0..100 rollout bounds, non-empty keys) raise ``ValidationError`` for
# free; a ``model_validator(mode="after")`` covers the cross-field rules no single field can express
# (variant bands summing > 100, ``variant_override`` naming a declared variant). A bad definition set
# thus raises the SAME ``ValidationError`` a bad ``FlagClientConfig`` (``extra="forbid"``) raises.


class _PropertyFilterModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    property: str
    operator: FlagFilterOperator = "exact"
    value: object
    negated: bool | None = None


class _FlagConditionModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    property_filters: list[_PropertyFilterModel] | None = None
    rollout_percentage: float | None = Field(default=None, ge=_ROLLOUT_MIN, le=_ROLLOUT_MAX)
    variant_override: str | None = None


class _FlagVariantModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1)
    rollout_percentage: float = Field(ge=_ROLLOUT_MIN, le=_ROLLOUT_MAX)


class _FeatureFlagDefinitionModel(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1)
    enabled: bool
    conditions: list[_FlagConditionModel] | None = None
    variants: list[_FlagVariantModel] | None = None
    payloads: dict[str, object] | None = None

    @model_validator(mode="after")
    def _check_cross_field(self) -> _FeatureFlagDefinitionModel:
        if self.variants is not None:
            if len(self.variants) == 0:
                raise ValueError("'variants' is present but empty — omit it for a boolean flag")
            band_sum = sum(v.rollout_percentage for v in self.variants)
            if band_sum > _ROLLOUT_MAX:
                raise ValueError(f"variant rollout_percentage bands sum to {band_sum} (> 100)")
        declared_variant_keys = {v.key for v in self.variants} if self.variants is not None else set()
        for condition in self.conditions or []:
            if condition.variant_override is not None and condition.variant_override not in declared_variant_keys:
                raise ValueError(
                    f"variant_override '{condition.variant_override}' names no declared variant"
                )
        return self


class _DefinitionSetModel(BaseModel):
    """The whole authored set — carries the duplicate-key cross-definition check."""

    definitions: list[_FeatureFlagDefinitionModel]

    @model_validator(mode="after")
    def _check_unique_keys(self) -> _DefinitionSetModel:
        seen: set[str] = set()
        for definition in self.definitions:
            if definition.key in seen:
                raise ValueError(f"duplicate key '{definition.key}'")
            seen.add(definition.key)
        return self


def validate_definitions(definitions: list[FeatureFlagDefinition]) -> None:
    """Validate a neutral definition set at the seed boundary, raising Pydantic ``ValidationError``
    (the config-layer error type) when any definition is malformed. Rejects: missing/empty/duplicate
    key; operator outside the closed union; ``rollout_percentage`` (condition or variant) outside
    0..100; multivariate variant bands summing > 100 (< 100 is legal); ``variant_override`` naming no
    declared variant; present-but-empty variants / an empty variant key. Also emits a DEV-TIME warning
    (never a rejection) for a dead ``'false'`` payload key. Call before :func:`lower_definitions`."""
    # model_validate (not the constructor) so the raw TypedDict inputs are coerced/validated by
    # Pydantic — it raises ValidationError on any violation.
    _DefinitionSetModel.model_validate({"definitions": list(definitions)})
    for definition in definitions:
        _warn_dead_false_payload_key(definition)


def _warn_dead_false_payload_key(definition: FeatureFlagDefinition) -> None:
    """Emit a dev-time warning (never a rejection) when a definition carries a ``'false'`` payload
    key: unreachable under local eval (the resolver returns early on a false-resolved flag before any
    payload lookup), so almost always a consumer mistake — but it round-trips harmlessly from a remote
    source, so rejecting would introduce a static-vs-remote asymmetry. The reachability is an
    adapter-internal mechanic of THIS resolver's early-return, not a neutral-contract invariant."""
    payloads = definition.get("payloads")
    if isinstance(payloads, dict) and "false" in payloads:
        key = definition.get("key", "<unknown>")
        warnings.warn(
            f"flag '{key}' has a 'false' payload key, which is never reached under local evaluation "
            "(an off-state flag carries no payload). It will be ignored. Remove it or key the payload "
            "by a variant/'true' value.",
            stacklevel=2,
        )


# --- the pure lowering --------------------------------------------------------------------------


def lower_definitions(definitions: list[FeatureFlagDefinition]) -> DefinitionSnapshot:
    """Lower a neutral definition set to the COMPLETE wire ``DefinitionSnapshot`` the evaluator reads —
    the exact shape the poller's ``_parse_definitions`` builds, so a seeded snapshot is read identically
    by the UNCHANGED adapter: ``flags`` = the lowered tuple, ``flags_by_key`` = indexed by key KEEPING
    disabled flags in (distinguishes known-but-off from unknown), ``group_type_mapping`` = {} (every
    flag person-buckets in v1), ``cohorts`` = {} (no cohort refs in v1). Pure — no I/O, no validation
    (call :func:`validate_definitions` first at the seed boundary)."""
    flags = tuple(_lower_definition(definition) for definition in definitions)
    flags_by_key = {str(flag["key"]): flag for flag in flags}
    return DefinitionSnapshot(
        flags=flags,
        flags_by_key=flags_by_key,
        group_type_mapping={},
        cohorts={},
    )


def _lower_definition(definition: FeatureFlagDefinition) -> dict[str, object]:
    filters: dict[str, object] = {}
    if "conditions" in definition:
        filters["groups"] = [_lower_condition(c) for c in definition["conditions"]]
    if "variants" in definition:
        filters["multivariate"] = {"variants": [_lower_variant(v) for v in definition["variants"]]}
    if "payloads" in definition:
        filters["payloads"] = definition["payloads"]
    return {
        "key": definition["key"],
        "active": definition["enabled"],
        "filters": filters,
    }


def _lower_condition(condition: FlagCondition) -> dict[str, object]:
    group: dict[str, object] = {}
    if "property_filters" in condition:
        group["properties"] = [_lower_property_filter(f) for f in condition["property_filters"]]
    if "rollout_percentage" in condition:
        group["rollout_percentage"] = condition["rollout_percentage"]
    if "variant_override" in condition:
        group["variant"] = condition["variant_override"]
    return group


def _lower_property_filter(filter_: PropertyFilter) -> dict[str, object]:
    # NEVER emits a `type`, so the plain-property `match_property` path runs (a cohort/flag `type` is
    # scoped out of neutral v1).
    wire: dict[str, object] = {
        "key": filter_["property"],
        "operator": filter_.get("operator", _DEFAULT_OPERATOR),
        "value": filter_["value"],
    }
    if "negated" in filter_:
        wire["negation"] = filter_["negated"]
    return wire


def _lower_variant(variant: FlagVariant) -> dict[str, object]:
    return {"key": variant["key"], "rollout_percentage": variant["rollout_percentage"]}


__all__ = [
    "FeatureFlagDefinition",
    "FlagCondition",
    "PropertyFilter",
    "FlagVariant",
    "FlagFilterValue",
    "FlagFilterOperator",
    "lower_definitions",
    "validate_definitions",
    "ValidationError",
]
