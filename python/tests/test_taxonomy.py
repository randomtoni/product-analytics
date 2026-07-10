"""Taxonomy-registry tests — the runtime registry, derive helper, prop-type validator, wiring.

These pin the library's OWN typed-taxonomy surface (ported from the TS ``taxonomy.ts`` /
``allowlist.ts`` seam, no vendor analogue): ``define_taxonomy`` returns a walkable ``.decl``
registry that reserves NOTHING; ``derive_allowlist_from_taxonomy`` is a consumer-invoked
convenience that leaks no event/group NAMES; the capture-scoped prop-type validator honors
the same ``ViolationPolicy`` as the allowlist (with the ``bool``-is-``int`` gotcha) and has
two explicit pass-through branches; and — the R1 regression guard — supplying a taxonomy
NEVER auto-activates the allowlist.
"""

from __future__ import annotations

import logging

import pytest
from pydantic import ValidationError

from analytics_kit import (
    Analytics,
    AnalyticsConfig,
    ConsentState,
    NeutralEvent,
    NeutralResponse,
    Taxonomy,
    create_analytics,
    define_taxonomy,
    derive_allowlist_from_taxonomy,
)

_LOGGER_NAME = "analytics_kit"


class _RecordingAdapter:
    """Capture-only adapter that records every minted event and lifecycle call."""

    def __init__(self) -> None:
        self.captured: list[NeutralEvent] = []
        self.flushed = 0
        self.shut_down = 0
        self._consent: ConsentState = "granted"

    def capture(self, event: NeutralEvent) -> None:
        self.captured.append(event)

    def flush(self) -> None:
        self.flushed += 1

    def shutdown(self) -> None:
        self.shut_down += 1

    def send(
        self,
        url: str,
        method: str,
        headers: dict[str, str],
        body: str | None = None,
    ) -> NeutralResponse:
        return NeutralResponse(status=200, body="")

    def get_consent_state(self) -> ConsentState:
        return self._consent

    def set_consent_state(self, state: ConsentState) -> None:
        self._consent = state

    def get_library_id(self) -> str:
        return "analytics-kit"

    def get_library_version(self) -> str:
        return "0.0.0"


_FIXTURE = define_taxonomy(
    {
        "events": {
            "signed_up": {"plan": "string", "seats": "number"},
            "checkout": {"plan": "string", "total": "number"},  # 'plan' repeats across events
            "logged_out": {},
        },
        "traits": {"role": "string", "tenure": "number"},
        "groups": {
            "workspace": {"tier": "string", "seats": "number"},  # 'seats' repeats event vs group
            "team": {"size": "number"},
        },
    }
)


# --- define_taxonomy: the runtime registry ---------------------------------------------


def test_define_taxonomy_returns_taxonomy_exposing_decl() -> None:
    tax = define_taxonomy({"events": {"e": {"x": "string"}}})

    assert isinstance(tax, Taxonomy)
    assert tax.decl["events"]["e"] == {"x": "string"}


def test_define_taxonomy_reserves_nothing() -> None:
    # a consumer may declare an event named after an internal verb — no reservation server-side
    tax = define_taxonomy(
        {
            "events": {
                "set_traits": {"a": "string"},
                "set_group_traits": {"b": "string"},
                "group_identify": {"c": "string"},
            }
        }
    )

    assert set(tax.decl["events"]) == {"set_traits", "set_group_traits", "group_identify"}


def test_define_taxonomy_untyped_missing_events_raises_clear_error() -> None:
    # events is required (a typed `define_taxonomy({})` is a mypy typeddict-item error); the
    # runtime guard catches the untyped-caller path with a clear boundary error, not a bare
    # KeyError surfacing deep inside derive/validate
    with pytest.raises(ValueError, match=r'must include an "events" mapping'):
        define_taxonomy({})  # type: ignore[typeddict-item]


def test_taxonomy_decl_has_no_page_slot() -> None:
    # the TS TaxonomyDecl carries page?; the server omits it deliberately — passing page is
    # rejected by TypedDict-total=False's key set at type-check time; at runtime an extra key
    # is simply not part of the walked decl. Assert the declared slots are the three we expose.
    tax = define_taxonomy({"events": {"e": {}}, "traits": {"r": "string"}})

    assert "page" not in tax.decl


# --- derive_allowlist_from_taxonomy: keys-only, no name leak ----------------------------


def test_derive_returns_deduped_union_of_event_trait_and_group_prop_keys() -> None:
    derived = derive_allowlist_from_taxonomy(_FIXTURE)

    assert set(derived) == {"plan", "seats", "total", "role", "tenure", "tier", "size"}
    # deduped: 'plan' (two events) and 'seats' (event + group) each appear once
    assert len(derived) == len(set(derived))
    assert derived.count("plan") == 1
    assert derived.count("seats") == 1


def test_derive_leaks_no_event_names() -> None:
    derived = derive_allowlist_from_taxonomy(_FIXTURE)

    for event_name in ("signed_up", "checkout", "logged_out"):
        assert event_name not in derived


def test_derive_leaks_no_group_type_names() -> None:
    derived = derive_allowlist_from_taxonomy(_FIXTURE)

    for group_type in ("workspace", "team"):
        assert group_type not in derived


def test_derive_keyless_taxonomy_returns_empty() -> None:
    derived = derive_allowlist_from_taxonomy(define_taxonomy({"events": {"ping": {}, "pong": {}}}))

    assert derived == []


def test_derive_traits_only_or_groups_only() -> None:
    traits_only = derive_allowlist_from_taxonomy(
        define_taxonomy({"events": {"e": {}}, "traits": {"role": "string"}})
    )
    assert set(traits_only) == {"role"}

    groups_only = derive_allowlist_from_taxonomy(
        define_taxonomy({"events": {"e": {}}, "groups": {"workspace": {"tier": "string"}}})
    )
    assert set(groups_only) == {"tier"}


def test_derive_empty_list_spread_activates_allow_nothing() -> None:
    # empty derive → [] → spread yields allowlist=[] which is ACTIVE (allow-nothing) under
    # S1's `is not None` activation. The [] ≠ None interaction, made visible.
    empty = define_taxonomy({"events": {"ping": {}, "pong": {}}})
    derived = derive_allowlist_from_taxonomy(empty)
    assert derived == []

    adapter = _RecordingAdapter()
    provider = create_analytics({"allowlist": [*derived]}, adapter)

    with pytest.raises(ValueError, match="anything"):
        provider.capture("u1", "ping", {"anything": 1})
    assert adapter.captured == []


def test_composition_is_consumer_side_spread() -> None:
    adapter = _RecordingAdapter()
    provider = create_analytics(
        {"allowlist": [*derive_allowlist_from_taxonomy(_FIXTURE), "app_version"]}, adapter
    )

    # a taxonomy-derived key passes without the consumer restating it
    provider.capture("u1", "signed_up", {"plan": "pro"})
    # a super-prop present ONLY in the explicit spread (in no event's taxonomy) also passes
    provider.capture("u1", "signed_up", {"app_version": "1.2.3"})

    assert len(adapter.captured) == 2
    assert adapter.captured[0].properties == {"plan": "pro"}
    assert adapter.captured[1].properties == {"app_version": "1.2.3"}

    # and an off-list key is still rejected — the guard is genuinely active
    with pytest.raises(ValueError, match="secret"):
        provider.capture("u1", "signed_up", {"secret": 1})


# --- runtime prop-type validator: type map + ViolationPolicy ---------------------------


def test_validator_accepts_correctly_typed_declared_props() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, taxonomy=_FIXTURE, on_violation="throw")

    provider.capture("u1", "signed_up", {"plan": "pro", "seats": 3})

    assert len(adapter.captured) == 1
    assert adapter.captured[0].properties == {"plan": "pro", "seats": 3}


def test_validator_accepts_float_and_int_for_number() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, taxonomy=_FIXTURE, on_violation="throw")

    provider.capture("u1", "signed_up", {"seats": 3})
    provider.capture("u1", "checkout", {"total": 4.5})

    assert [e.properties for e in adapter.captured] == [{"seats": 3}, {"total": 4.5}]


def test_validator_accepts_datetime_for_date() -> None:
    import datetime

    adapter = _RecordingAdapter()
    tax = define_taxonomy({"events": {"scheduled": {"at": "date"}}})
    provider = Analytics(adapter, taxonomy=tax, on_violation="throw")

    provider.capture("u1", "scheduled", {"at": datetime.datetime(2026, 7, 10)})

    assert len(adapter.captured) == 1


def test_validator_wrong_typed_declared_prop_throws() -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, taxonomy=_FIXTURE, on_violation="throw")

    with pytest.raises(ValueError, match=r'property "seats" for event "signed_up"'):
        provider.capture("u1", "signed_up", {"plan": "pro", "seats": "three"})

    assert adapter.captured == []  # never minted


def test_validator_bool_is_not_accepted_as_number() -> None:
    # bool is a subclass of int — active=True must NOT satisfy a `number`-declared prop
    adapter = _RecordingAdapter()
    tax = define_taxonomy({"events": {"pinged": {"count": "number"}}})
    provider = Analytics(adapter, taxonomy=tax, on_violation="throw")

    with pytest.raises(ValueError, match=r'property "count"'):
        provider.capture("u1", "pinged", {"count": True})

    assert adapter.captured == []


def test_validator_bool_is_accepted_as_boolean() -> None:
    adapter = _RecordingAdapter()
    tax = define_taxonomy({"events": {"toggled": {"active": "boolean"}}})
    provider = Analytics(adapter, taxonomy=tax, on_violation="throw")

    provider.capture("u1", "toggled", {"active": True})

    assert len(adapter.captured) == 1


def test_validator_drop_policy_logs_once_and_never_mints(
    caplog: pytest.LogCaptureFixture,
) -> None:
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, taxonomy=_FIXTURE, on_violation="drop-and-error-log")

    with caplog.at_level(logging.ERROR, logger=_LOGGER_NAME):
        provider.capture("u1", "signed_up", {"seats": "three"})  # wrong type → drop

    assert adapter.captured == []
    assert len([r for r in caplog.records if r.name == _LOGGER_NAME]) == 1


def test_validator_undeclared_prop_on_declared_event_is_not_a_type_error() -> None:
    # a supplied prop absent from the decl is out-of-scope for the type layer (completeness
    # is the static layer's concern) — it passes through untouched
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, taxonomy=_FIXTURE, on_violation="throw")

    provider.capture("u1", "signed_up", {"plan": "pro", "extra_unlisted": object()})

    assert len(adapter.captured) == 1


def test_validator_runs_after_allowlist_gate() -> None:
    # the coarser allowlist key-membership hard-stop fires first: an off-list key raises the
    # allowlist message, not the type message, even though it is also wrong-typed
    adapter = _RecordingAdapter()
    provider = Analytics(
        adapter,
        taxonomy=_FIXTURE,
        allowlist=frozenset({"plan"}),
        on_violation="throw",
    )

    with pytest.raises(ValueError, match="not on the payload allowlist"):
        provider.capture("u1", "signed_up", {"plan": "pro", "seats": "three"})


# --- validator pass-through branches ---------------------------------------------------


def test_validator_pass_through_no_taxonomy_is_inert() -> None:
    # branch (1): no taxonomy ⇒ validator inert, any-typed prop reaches the adapter
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, on_violation="throw")  # no taxonomy

    provider.capture("u1", "signed_up", {"seats": "definitely-not-a-number"})

    assert len(adapter.captured) == 1
    assert adapter.captured[0].properties == {"seats": "definitely-not-a-number"}


def test_validator_pass_through_undeclared_event() -> None:
    # branch (2): capture with an UNDECLARED event name ⇒ props pass unvalidated
    adapter = _RecordingAdapter()
    provider = Analytics(adapter, taxonomy=_FIXTURE, on_violation="throw")

    provider.capture("u1", "not_in_taxonomy", {"seats": "not-a-number", "whatever": 1})

    assert len(adapter.captured) == 1
    assert adapter.captured[0].properties == {"seats": "not-a-number", "whatever": 1}


def test_validator_is_capture_scoped_set_and_group_not_type_validated() -> None:
    # set / set_group_traits are NOT runtime-type-validated in this story even if the
    # taxonomy declares matching trait/group shapes
    adapter = _RecordingAdapter()
    tax = define_taxonomy(
        {
            "events": {"e": {}},
            "traits": {"role": "string"},
            "groups": {"workspace": {"tier": "string"}},
        }
    )
    provider = Analytics(adapter, taxonomy=tax, on_violation="throw")

    provider.set("u1", {"role": 123})  # wrong type, but set is not validated
    provider.set_group_traits("workspace", "acme", {"tier": 456})  # not validated either

    assert len(adapter.captured) == 2


# --- config wiring: arbitrary_types_allowed + isinstance boundary ----------------------


def test_config_defaults_taxonomy_none() -> None:
    assert AnalyticsConfig().taxonomy is None


def test_config_accepts_taxonomy_object() -> None:
    config = AnalyticsConfig(taxonomy=_FIXTURE)

    assert config.taxonomy is _FIXTURE


def test_config_rejects_raw_dict_taxonomy_at_boundary() -> None:
    # a raw dict is NOT a Taxonomy — the isinstance guard fails at config validation, not with
    # an AttributeError on `.decl` deep in capture
    with pytest.raises(ValidationError):
        AnalyticsConfig(taxonomy={"events": {"e": {}}})  # type: ignore[arg-type]


def test_create_analytics_constructs_with_and_without_taxonomy() -> None:
    adapter = _RecordingAdapter()

    empty = create_analytics({}, adapter)
    with_tax = create_analytics({"taxonomy": _FIXTURE}, adapter)

    assert isinstance(empty, Analytics)
    assert isinstance(with_tax, Analytics)


def test_factory_threads_taxonomy_into_provider() -> None:
    adapter = _RecordingAdapter()
    provider = create_analytics({"taxonomy": _FIXTURE}, adapter)

    # the validator is live: a wrong-typed declared prop raises
    with pytest.raises(ValueError, match=r'property "seats"'):
        provider.capture("u1", "signed_up", {"seats": "three"})
    assert adapter.captured == []


# --- THE R1 regression guard -----------------------------------------------------------


def test_taxonomy_alone_does_not_activate_allowlist() -> None:
    # supplying a taxonomy is a TYPING decision, NOT a privacy decision. With no allowlist,
    # the guard stays INACTIVE: an off-taxonomy key on a declared event reaches the adapter.
    # Isolated from the validator by using a key ABSENT from the decl (the validator passes
    # undeclared keys through) — so this test catches an allowlist re-activation only.
    adapter = _RecordingAdapter()
    provider = create_analytics({"taxonomy": _FIXTURE}, adapter)  # NO allowlist

    provider.capture("u1", "signed_up", {"off_taxonomy_key": 1})

    assert len(adapter.captured) == 1
    assert adapter.captured[0].properties == {"off_taxonomy_key": 1}
