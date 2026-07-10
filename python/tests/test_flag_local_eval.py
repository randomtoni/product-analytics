"""E13-S3 tests for the Python in-process flag evaluator + definition poller.

The hash tests pin the SAME three-tier cross-tree vector S1 (TS node) asserts — byte-for-byte, so a
wrong f-count, wrong slice length, or int-vs-float division fails a test and a TS/Python divergence
for the same actor is caught here. The operator / rollout / variant / cohort tests pin the matcher
against the frozen seam behavior; the two inconclusive signals are asserted DISTINCT. The poller
tests drive an INJECTED mock transport (never a live backend) and prove the poll thread stops cleanly
with NO leaked thread (the E12-S4 daemon-thread lesson).
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest

from analytics_kit import NeutralResponse
from analytics_kit.flags.local.definition_poller import DefinitionPoller
from analytics_kit.flags.local.definition_types import DefinitionSnapshot
from analytics_kit.flags.local.errors import InconclusiveMatchError, RequiresServerEvaluation
from analytics_kit.flags.local.evaluator import compute_flag_locally, evaluate_flag_locally
from analytics_kit.flags.local.hash import bucket_hash, hash_sha1
from analytics_kit.flags.local.match_property import match_property


# --- Tier 1/2/3: the pinned cross-tree hash vector (byte-for-byte with S1) -----------------------


def test_hash_tier1_sha1_primitive_matches_the_pinned_digest() -> None:
    # The SHA-1 primitive itself, pinned against S1's crypto vector.
    assert hash_sha1("some-flag.some_distinct_id") == "e4ce124e800a818c63099f95fa085dc2b620e173"


def test_hash_tier2_exact_rollout_floats_match_s1() -> None:
    # The exact _hash floats S1 pins — a wrong 15-nibble slice or int-vs-float division fails here.
    assert bucket_hash("simple-flag", "distinct_id_0") == 0.78369637642204315
    assert bucket_hash("simple-flag", "distinct_id_1") == 0.33970699269954008
    assert bucket_hash("simple-flag", "distinct_id_2") == 0.37204343502390519


def test_hash_tier2_exact_variant_salt_float_matches_s1() -> None:
    # The variant-salt hash is an INDEPENDENT hash: the literal 'variant' suffix, no separator.
    assert bucket_hash("multivariate-flag", "distinct_id_0", "variant") == 0.61864545379303792


def test_hash_is_top_inclusive_all_f_slice_is_exactly_one() -> None:
    # An all-`f` 15-nibble slice yields exactly 1.0 (top-inclusive) — the 100%-rollout gate depends
    # on `1.0 <= 1.0`. `fff...` = 2**60 - 1 = the LONG_SCALE, so the ratio is exactly 1.0.
    assert int("f" * 15, 16) / float(0xFFFFFFFFFFFFFFF) == 1.0


def _simple_flag(rollout: int) -> dict[str, Any]:
    return {
        "key": "simple-flag",
        "active": True,
        "filters": {"groups": [{"properties": [], "rollout_percentage": rollout}]},
    }


def test_hash_tier3_end_to_end_rollout_consistency_vector_matches_s1() -> None:
    # The end-to-end consistency vector: simple-flag at 45% over distinct_id_{0..9}. This is the SAME
    # real reference-suite vector S1 asserts — cross-tree parity is locked by the IDENTICAL vector.
    flag = _simple_flag(45)
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"simple-flag": flag})
    result = [compute_flag_locally(flag, {"distinct_id": f"distinct_id_{i}"}, snap) for i in range(10)]
    assert result == [False, True, True, False, True, False, False, True, False, True]


def test_hash_tier3_end_to_end_variant_consistency_vector_matches_s1() -> None:
    # The multivariate consistency vector: group 55%, variants 50/20/20/5/5 over distinct_id_{0..9}.
    flag = {
        "key": "multivariate-flag",
        "active": True,
        "filters": {
            "groups": [{"properties": [], "rollout_percentage": 55}],
            "multivariate": {
                "variants": [
                    {"key": "first-variant", "rollout_percentage": 50},
                    {"key": "second-variant", "rollout_percentage": 20},
                    {"key": "third-variant", "rollout_percentage": 20},
                    {"key": "fourth-variant", "rollout_percentage": 5},
                    {"key": "fifth-variant", "rollout_percentage": 5},
                ]
            },
        },
    }
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"multivariate-flag": flag})
    result = [compute_flag_locally(flag, {"distinct_id": f"distinct_id_{i}"}, snap) for i in range(10)]
    assert result == [
        "second-variant",
        "second-variant",
        "first-variant",
        False,
        False,
        "second-variant",
        "first-variant",
        False,
        False,
        False,
    ]


# --- rollout gate at boundary percentages --------------------------------------------------------


def test_rollout_at_zero_percent_matches_nobody() -> None:
    flag = _simple_flag(0)
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"simple-flag": flag})
    # 0% admits effectively no one (except an exact-0.0 hash, vanishingly rare) — the whole d0..d9
    # cohort is out.
    assert all(compute_flag_locally(flag, {"distinct_id": f"d{i}"}, snap) is False for i in range(10))


def test_rollout_at_hundred_percent_matches_everybody() -> None:
    flag = _simple_flag(100)
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"simple-flag": flag})
    # 100% admits everyone incl. the 1.0 top-inclusive edge.
    assert all(compute_flag_locally(flag, {"distinct_id": f"d{i}"}, snap) is True for i in range(10))


def test_inactive_flag_is_always_false() -> None:
    flag = {"key": "off", "active": False, "filters": {"groups": [{"rollout_percentage": 100}]}}
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"off": flag})
    assert compute_flag_locally(flag, {"distinct_id": "d0"}, snap) is False


# --- variant band selection: gap resolves to bare True -------------------------------------------


def test_variant_gap_resolves_to_bare_true() -> None:
    # Variant percentages sum < 100 (only 1% banded), so most actors land in the gap -> bare True.
    flag = {
        "key": "gappy",
        "active": True,
        "filters": {
            "groups": [{"properties": [], "rollout_percentage": 100}],
            "multivariate": {"variants": [{"key": "only", "rollout_percentage": 1}]},
        },
    }
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"gappy": flag})
    values = [compute_flag_locally(flag, {"distinct_id": f"d{i}"}, snap) for i in range(20)]
    # Every actor either lands in the single 1% band ("only") or the gap (bare True); never False.
    assert all(v == "only" or v is True for v in values)
    assert any(v is True for v in values)


def test_condition_variant_override_wins_when_group_matches() -> None:
    flag = {
        "key": "override",
        "active": True,
        "filters": {
            "groups": [{"properties": [], "rollout_percentage": 100, "variant": "forced"}],
            "multivariate": {"variants": [{"key": "forced", "rollout_percentage": 50}]},
        },
    }
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"override": flag})
    assert compute_flag_locally(flag, {"distinct_id": "anyone"}, snap) == "forced"


# --- property operators: a passing + a failing case each -----------------------------------------


@pytest.mark.parametrize(
    ("operator", "flag_value", "actor_value", "expected"),
    [
        ("exact", "pro", "pro", True),
        ("exact", "pro", "free", False),
        ("exact", ["a", "b"], "B", True),  # array membership, case-insensitive
        ("is_not", "pro", "free", True),
        ("is_not", "pro", "pro", False),
        ("is_set", "x", "anything", True),
        ("icontains", "err", "Server Error", True),
        ("icontains", "zzz", "Server Error", False),
        ("not_icontains", "zzz", "Server Error", True),
        ("regex", r"^v\d+$", "v2", True),
        ("regex", r"^v\d+$", "beta", False),
        ("not_regex", r"^v\d+$", "beta", True),
        ("gt", 5, 10, True),
        ("gt", 5, 3, False),
        ("gte", 5, 5, True),
        ("lt", 5, 3, True),
        ("lte", 5, 5, True),
        ("gt", 9, "10", True),  # numeric-first: "10" compares as 10 > 9
        ("semver_gt", "1.2.0", "1.3.0", True),
        ("semver_gt", "1.2.0", "1.1.0", False),
        ("semver_eq", "1.2.0", "1.2.0", True),
        ("semver_lt", "2.0.0", "1.9.9", True),
        ("semver_tilde", "1.2.0", "1.2.5", True),
        ("semver_tilde", "1.2.0", "1.3.0", False),
        ("semver_caret", "1.2.0", "1.9.0", True),
        ("semver_caret", "1.2.0", "2.0.0", False),
        ("semver_wildcard", "1.*", "1.9.9", True),
        ("semver_wildcard", "1.*", "2.0.0", False),
    ],
)
def test_operator_matches_and_rejects(operator: str, flag_value: object, actor_value: object, expected: bool) -> None:
    prop = {"key": "p", "operator": operator, "value": flag_value}
    assert match_property(prop, {"p": actor_value}) is expected


def test_default_operator_is_exact() -> None:
    prop: dict[str, object] = {"key": "plan", "value": "pro"}
    assert match_property(prop, {"plan": "pro"}) is True
    assert match_property(prop, {"plan": "free"}) is False


def test_is_not_set_resolves_locally_for_an_absent_key() -> None:
    # is_not_set on a genuinely-absent key resolves locally (True) — it must NOT raise inconclusive.
    assert match_property({"key": "gone", "operator": "is_not_set"}, {"other": 1}) is True
    # And is False when the key IS present.
    assert match_property({"key": "here", "operator": "is_not_set"}, {"here": 1}) is False


def test_missing_property_under_a_value_operator_raises_inconclusive() -> None:
    with pytest.raises(InconclusiveMatchError):
        match_property({"key": "absent", "operator": "exact", "value": "x"}, {"other": 1})


def test_provided_but_null_property_fails_the_comparison_not_inconclusive() -> None:
    # A value was PRESENT (None), it just doesn't satisfy exact — False, not inconclusive.
    assert match_property({"key": "p", "operator": "exact", "value": "x"}, {"p": None}) is False


def test_date_operators_relative_and_absolute() -> None:
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(days=1)).isoformat()
    old = (now - timedelta(days=60)).isoformat()
    before: dict[str, object] = {"key": "signed_up", "operator": "is_date_before", "value": "-30d"}
    after: dict[str, object] = {"key": "signed_up", "operator": "is_date_after", "value": "-30d"}
    assert match_property(before, {"signed_up": old}) is True
    assert match_property(after, {"signed_up": recent}) is True


def test_bad_regex_flag_value_does_not_match() -> None:
    # An invalid regex is treated as a non-match (the seam's is_valid_regex guard), not a crash.
    assert match_property({"key": "p", "operator": "regex", "value": "("}, {"p": "x"}) is False


# --- cohort AND / OR matching --------------------------------------------------------------------


def _cohort_flag(cohort_id: str) -> dict[str, Any]:
    return {
        "key": "cohort-flag",
        "active": True,
        "filters": {
            "groups": [
                {
                    "properties": [{"key": "id", "type": "cohort", "value": cohort_id}],
                    "rollout_percentage": 100,
                }
            ]
        },
    }


def test_cohort_and_group_requires_all_leaves() -> None:
    flag = _cohort_flag("1")
    cohorts: dict[str, dict[str, object]] = {
        "1": {
            "type": "AND",
            "values": [
                {"key": "plan", "value": "pro"},
                {"key": "country", "value": "US"},
            ],
        }
    }
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"cohort-flag": flag}, cohorts=cohorts)
    assert compute_flag_locally(flag, {"distinct_id": "u", "person_properties": {"plan": "pro", "country": "US"}}, snap) is True
    assert compute_flag_locally(flag, {"distinct_id": "u", "person_properties": {"plan": "pro", "country": "CA"}}, snap) is False


def test_cohort_or_group_needs_one_leaf() -> None:
    flag = _cohort_flag("2")
    cohorts: dict[str, dict[str, object]] = {
        "2": {
            "type": "OR",
            "values": [
                {"key": "plan", "value": "pro"},
                {"key": "plan", "value": "enterprise"},
            ],
        }
    }
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"cohort-flag": flag}, cohorts=cohorts)
    assert compute_flag_locally(flag, {"distinct_id": "u", "person_properties": {"plan": "enterprise"}}, snap) is True
    assert compute_flag_locally(flag, {"distinct_id": "u", "person_properties": {"plan": "free"}}, snap) is False


# --- the two inconclusive signals are DISTINCT ---------------------------------------------------


def test_static_cohort_raises_requires_server_evaluation() -> None:
    # A cohort id absent from the local cohort map is a static cohort — RequiresServerEvaluation,
    # distinct from InconclusiveMatchError.
    flag = _cohort_flag("999")
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"cohort-flag": flag}, cohorts={})
    with pytest.raises(RequiresServerEvaluation):
        compute_flag_locally(flag, {"distinct_id": "u", "person_properties": {}}, snap)


def test_missing_property_in_condition_raises_inconclusive_not_requires_server() -> None:
    flag = {
        "key": "prop-flag",
        "active": True,
        "filters": {"groups": [{"properties": [{"key": "plan", "value": "pro"}], "rollout_percentage": 100}]},
    }
    snap = DefinitionSnapshot(flags=(flag,), flags_by_key={"prop-flag": flag})
    with pytest.raises(InconclusiveMatchError):
        # plan is absent from person_properties -> inconclusive (retry remotely), NOT server-only.
        evaluate_flag_locally(flag, "u", {}, snap.cohorts)


def test_the_two_inconclusive_signals_are_separate_types() -> None:
    assert not issubclass(RequiresServerEvaluation, InconclusiveMatchError)
    assert not issubclass(InconclusiveMatchError, RequiresServerEvaluation)


def test_experience_continuity_flag_raises_inconclusive() -> None:
    flag = {"key": "cont", "active": True, "ensure_experience_continuity": True, "filters": {"groups": []}}
    with pytest.raises(InconclusiveMatchError):
        evaluate_flag_locally(flag, "u", {}, {})


def test_inconclusive_in_one_or_group_does_not_poison_a_matching_group() -> None:
    # Two condition groups (OR): the first needs an absent property (inconclusive), the second is a
    # plain 100% rollout that matches. The matching group must win — an inconclusive group must not
    # poison the OR.
    flag = {
        "key": "or-flag",
        "active": True,
        "filters": {
            "groups": [
                {"properties": [{"key": "missing", "value": "x"}], "rollout_percentage": 100},
                {"properties": [], "rollout_percentage": 100},
            ]
        },
    }
    assert evaluate_flag_locally(flag, "u", {}, {}) is True


# --- the definition poller: mock transport, no leaked thread -------------------------------------


class _CannedGetTransport:
    """Records every send and replays a canned definitions response. Never touches a network."""

    def __init__(self, response: NeutralResponse) -> None:
        self._response = response
        self.sends: list[tuple[str, str]] = []

    def send(self, url: str, method: str, headers: dict[str, str], body: str | None = None) -> NeutralResponse:
        self.sends.append((url, method))
        return self._response


def _definitions_body() -> str:
    import json

    return json.dumps(
        {
            "flags": [{"key": "simple-flag", "active": True, "filters": {"groups": [{"rollout_percentage": 100}]}}],
            "group_type_mapping": {"0": "org"},
            "cohorts": {},
        }
    )


def test_poller_loads_definitions_on_first_load_and_becomes_ready() -> None:
    transport = _CannedGetTransport(NeutralResponse(status=200, body=_definitions_body()))
    poller = DefinitionPoller(
        definitions_endpoint="https://flags.example",
        definitions_key="privileged-key",
        token="proj-token",
        poll_interval=60.0,
        transport=transport,
    )
    poller.load()  # a synchronous single load, no background thread started
    assert poller.is_ready() is True
    snapshot = poller.get_snapshot()
    assert "simple-flag" in snapshot.flags_by_key
    assert snapshot.group_type_mapping == {"0": "org"}
    # The definitions GET carried the token + send-cohorts query params and the privileged bearer.
    assert len(transport.sends) == 1
    url, method = transport.sends[0]
    assert method == "GET"
    assert "token=proj-token" in url
    assert "/flags/definitions" in url


def test_poller_is_not_ready_before_a_load() -> None:
    transport = _CannedGetTransport(NeutralResponse(status=200, body=_definitions_body()))
    poller = DefinitionPoller(
        definitions_endpoint="https://flags.example",
        definitions_key="k",
        token="t",
        poll_interval=60.0,
        transport=transport,
    )
    # Before any load the snapshot is the frozen empty one — a read never crashes.
    assert poller.is_ready() is False
    assert poller.get_snapshot().flags == ()


def test_poller_failed_load_leaves_the_prior_snapshot() -> None:
    transport = _CannedGetTransport(NeutralResponse(status=500, body="boom"))
    poller = DefinitionPoller(
        definitions_endpoint="https://flags.example",
        definitions_key="k",
        token="t",
        poll_interval=60.0,
        transport=transport,
    )
    poller.load()
    # A non-OK load never overwrites good data with an error; here there was no prior data.
    assert poller.is_ready() is False


def test_poller_start_then_stop_leaks_no_thread() -> None:
    # The E12-S4 daemon-thread lesson: start() spins a background poll thread; stop() SETS the event
    # and JOINS it, so no poll thread leaks past the test.
    before = {t.name for t in threading.enumerate()}
    transport = _CannedGetTransport(NeutralResponse(status=200, body=_definitions_body()))
    poller = DefinitionPoller(
        definitions_endpoint="https://flags.example",
        definitions_key="k",
        token="t",
        poll_interval=60.0,
        transport=transport,
    )
    poller.start()
    assert poller.is_ready() is True
    poller.stop()
    after = {t.name for t in threading.enumerate()}
    assert "analytics-kit-flag-poller" not in (after - before)


def test_poller_stop_is_idempotent() -> None:
    transport = _CannedGetTransport(NeutralResponse(status=200, body=_definitions_body()))
    poller = DefinitionPoller(
        definitions_endpoint="https://flags.example",
        definitions_key="k",
        token="t",
        poll_interval=60.0,
        transport=transport,
    )
    poller.start()
    poller.stop()
    poller.stop()  # a second stop is a sound no-op
    assert not any(t.name == "analytics-kit-flag-poller" for t in threading.enumerate())
