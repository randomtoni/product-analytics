"""The single-property operator engine — a pure, synchronous function of ``(property filter, actor
property bag)``.

Ported in behavior from the TS-node ``match-property.ts`` (the de-branded neutral seam), which
itself ports the reference ``match_property`` + its semver / relative-date helpers. Returns whether
the actor's value satisfies the filter, or RAISES ``InconclusiveMatchError`` when it can't be decided
locally (a genuinely-absent property under a value operator, a bad regex/date/semver, an unknown
operator). All comparisons are string-folded / numeric exactly as the seam does, so a local decision
matches a remote one for the same inputs.
"""

# De-branded from posthog's feature_flags.py match_property / parse_semver / relative-date helpers.

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone

from .definition_types import FlagProperty, PropertyBag
from .errors import InconclusiveMatchError

# Operators whose branch must still run when the actor's value is None: `is_not` may legitimately
# compare against None; `is_set` only cares about key presence.
_NULL_VALUES_ALLOWED_OPERATORS = ("is_not", "is_set")


def match_property(prop: FlagProperty, property_values: PropertyBag) -> bool:
    key = str(prop.get("key"))
    value = prop.get("value")
    operator = prop.get("operator") or "exact"

    if key not in property_values:
        # A genuinely-absent property answers `is_not_set` locally (True) — no need to bail as
        # inconclusive. Any other operator on an absent property IS inconclusive.
        if operator == "is_not_set":
            return True
        raise InconclusiveMatchError(f"Property {key} not found in the given properties")
    if operator == "is_not_set":
        return False

    override_value = property_values[key]
    if override_value is None and operator not in _NULL_VALUES_ALLOWED_OPERATORS:
        # The property was provided but is None: fail the comparison. NOT inconclusive — a value was
        # present, it just doesn't satisfy the operator.
        return False

    if operator == "exact":
        return _compute_exact_match(value, override_value)
    if operator == "is_not":
        return not _compute_exact_match(value, override_value)
    if operator == "is_set":
        return key in property_values
    if operator == "icontains":
        return str(value).lower() in str(override_value).lower()
    if operator == "not_icontains":
        return str(value).lower() not in str(override_value).lower()
    if operator == "regex":
        return _is_valid_regex(str(value)) and re.search(str(value), str(override_value)) is not None
    if operator == "not_regex":
        return _is_valid_regex(str(value)) and re.search(str(value), str(override_value)) is None
    if operator in ("gt", "gte", "lt", "lte"):
        return _compare_numeric_then_lexicographic(value, override_value, operator)
    if operator in ("is_date_before", "is_date_after"):
        return _match_date(value, override_value, operator)
    if operator in _SEMVER_COMPARISON_OPERATORS:
        return _match_semver_comparison(value, override_value, operator)
    if operator in _SEMVER_RANGE_OPERATORS:
        return _match_semver_range(value, override_value, operator)
    raise InconclusiveMatchError(f"Unknown operator: {operator}")


def _compute_exact_match(value: object, override_value: object) -> bool:
    if isinstance(value, list):
        return str(override_value).lower() in [str(v).lower() for v in value]
    return str(value).lower() == str(override_value).lower()


def _compare_numeric_then_lexicographic(value: object, override_value: object, operator: str) -> bool:
    # Numeric comparison first; fall back to lexicographic only when a side genuinely isn't a number.
    # A NaN from a non-numeric string must not slip into `nan > 5`, so a failed parse falls through
    # to the string comparison. The string "10" compares as `10 > 9` (True), not lexically.
    parsed_value = _to_finite_float(value)
    parsed_override = _to_finite_float(override_value)
    if parsed_value is not None and parsed_override is not None:
        return _compare(parsed_override, parsed_value, operator)
    return _compare(str(override_value), str(value), operator)


def _to_finite_float(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        parsed = float(str(value))
    except (ValueError, TypeError):
        return None
    return parsed if parsed == parsed and parsed not in (float("inf"), float("-inf")) else None  # noqa: PLR0124 — NaN self-check.


def _compare(lhs: float | str, rhs: float | str, operator: str) -> bool:
    if operator == "gt":
        return lhs > rhs  # type: ignore[operator]
    if operator == "gte":
        return lhs >= rhs  # type: ignore[operator]
    if operator == "lt":
        return lhs < rhs  # type: ignore[operator]
    if operator == "lte":
        return lhs <= rhs  # type: ignore[operator]
    raise InconclusiveMatchError(f"Invalid operator: {operator}")


def _is_valid_regex(pattern: str) -> bool:
    try:
        re.compile(pattern)
    except re.error:
        return False
    return True


# --- date operators -----------------------------------------------------------------------------


def _match_date(value: object, override_value: object, operator: str) -> bool:
    if isinstance(value, bool):
        raise InconclusiveMatchError("Date operations cannot be performed on boolean values")
    parsed_date = _relative_date_parse(str(value))
    if parsed_date is None:
        parsed_date = _convert_to_date(value)
    if parsed_date is None:
        raise InconclusiveMatchError(f"Invalid date: {value}")
    override_date = _convert_to_date(override_value)
    if override_date is None:
        raise InconclusiveMatchError(f"Invalid date: {override_value}")
    if operator == "is_date_before":
        return override_date < parsed_date
    return override_date > parsed_date


def _convert_to_date(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo is not None else value.replace(tzinfo=timezone.utc)
    if isinstance(value, bool):
        return None
    if isinstance(value, (str, int, float)):
        try:
            text = str(value).strip()
            if text.endswith("Z"):
                text = text[:-1] + "+00:00"
            parsed = datetime.fromisoformat(text)
        except (ValueError, TypeError):
            return None
        return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=timezone.utc)
    return None


def _relative_date_parse(value: str) -> datetime | None:
    """A relative-date filter like ``-30d`` / ``-6h`` / ``-2w`` / ``-3m`` / ``-1y``, resolved against
    now (UTC). ``None`` when the string isn't a relative-date form (the caller then tries an absolute
    date)."""
    match = re.fullmatch(r"-?(?P<number>[0-9]+)(?P<interval>[a-z])", value)
    if match is None:
        return None
    number = int(match.group("number"))
    if number >= 10_000:
        return None
    now = datetime.now(timezone.utc)
    interval = match.group("interval")
    if interval == "h":
        return now - timedelta(hours=number)
    if interval == "d":
        return now - timedelta(days=number)
    if interval == "w":
        return now - timedelta(weeks=number)
    if interval == "m":
        return _subtract_months(now, number)
    if interval == "y":
        return now.replace(year=now.year - number)
    return None


def _subtract_months(dt: datetime, months: int) -> datetime | None:
    month_index = dt.year * 12 + dt.month - 1 - months
    year = month_index // 12
    month = month_index % 12 + 1
    if not 1 <= year <= 9999:
        return None
    day = min(dt.day, _month_end(year, month))
    return dt.replace(year=year, month=month, day=day)


def _month_end(year: int, month: int) -> int:
    import calendar

    return calendar.monthrange(year, month)[1]


# --- semver operators ---------------------------------------------------------------------------

_SEMVER_COMPARISON_OPERATORS = (
    "semver_eq",
    "semver_neq",
    "semver_gt",
    "semver_gte",
    "semver_lt",
    "semver_lte",
)
_SEMVER_RANGE_OPERATORS = ("semver_tilde", "semver_caret", "semver_wildcard")

SemverTuple = tuple[int, int, int]


def _match_semver_comparison(value: object, override_value: object, operator: str) -> bool:
    parsed = _parse_semver(str(override_value))
    flag = _parse_semver(str(value))
    if operator == "semver_eq":
        return parsed == flag
    if operator == "semver_neq":
        return parsed != flag
    if operator == "semver_gt":
        return parsed > flag
    if operator == "semver_gte":
        return parsed >= flag
    if operator == "semver_lt":
        return parsed < flag
    return parsed <= flag


def _match_semver_range(value: object, override_value: object, operator: str) -> bool:
    parsed = _parse_semver(str(override_value))
    if operator == "semver_tilde":
        lower, upper = _tilde_bounds(str(value))
    elif operator == "semver_caret":
        lower, upper = _caret_bounds(str(value))
    else:
        lower, upper = _wildcard_bounds(str(value))
    return lower <= parsed < upper


def _semver_numeric_identifier(part: str) -> int:
    if not part or not part.isdigit():
        raise InconclusiveMatchError(f"Invalid semver numeric identifier: '{part}'")
    if len(part) > 1 and part[0] == "0":
        raise InconclusiveMatchError(f"Semver numeric identifier has leading zero: '{part}'")
    return int(part)


def _parse_semver(value: str) -> SemverTuple:
    text = str(value).strip().lstrip("vV")
    text = text.split("-")[0].split("+")[0]
    parts = text.split(".")
    if not parts or not parts[0]:
        raise InconclusiveMatchError(f"Invalid semver: {value}")
    major = _semver_numeric_identifier(parts[0])
    minor = _semver_numeric_identifier(parts[1]) if len(parts) > 1 and parts[1] else 0
    patch = _semver_numeric_identifier(parts[2]) if len(parts) > 2 and parts[2] else 0
    return (major, minor, patch)


def _tilde_bounds(value: str) -> tuple[SemverTuple, SemverTuple]:
    major, minor, patch = _parse_semver(value)
    return (major, minor, patch), (major, minor + 1, 0)


def _caret_bounds(value: str) -> tuple[SemverTuple, SemverTuple]:
    major, minor, patch = _parse_semver(value)
    lower = (major, minor, patch)
    if major > 0:
        upper = (major + 1, 0, 0)
    elif minor > 0:
        upper = (0, minor + 1, 0)
    else:
        upper = (0, 0, patch + 1)
    return lower, upper


def _wildcard_bounds(value: str) -> tuple[SemverTuple, SemverTuple]:
    cleaned = str(value).strip().lstrip("vV").replace("*", "").rstrip(".")
    parts = [p for p in cleaned.split(".") if p]
    if not parts:
        raise InconclusiveMatchError(f"Invalid wildcard semver: {value}")
    major = _semver_numeric_identifier(parts[0])
    if len(parts) == 1:
        return (major, 0, 0), (major + 1, 0, 0)
    minor = _semver_numeric_identifier(parts[1])
    return (major, minor, 0), (major, minor + 1, 0)
