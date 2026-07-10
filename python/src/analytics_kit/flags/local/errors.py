"""The two distinct inconclusive signals the local evaluator raises when it holds a definition but
cannot decide the outcome in-process.

Both propagate OUT of the evaluator unhandled — the resolution layer catches them to drive the
local -> remote fallback ladder. Neutral names/messages: no vendor token. The two are distinguished
by ``isinstance``, so they are separate classes (not one with a flag).
"""

# De-branded from posthog's feature_flags.py InconclusiveMatchError / RequiresServerEvaluation.

from __future__ import annotations


class InconclusiveMatchError(Exception):
    """"Have the definition, can't decide with the properties given" — a missing person property
    under a value operator, a bad regex/date/semver, or a flag dependency (deferred to remote).
    Retry remotely if the adapter config allows it."""


class RequiresServerEvaluation(Exception):
    """"Definition references server-only data" — a cohort referenced by a filter absent from the
    locally-fetched cohort map (a static cohort). Distinct from ``InconclusiveMatchError``: the
    definition itself needs the server, not that the given properties were insufficient."""
