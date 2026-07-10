"""The payload allowlist — the library's vendor-neutral privacy contract.

Only consumer-supplied keys are permitted to leave the app; a violation fails loudly. The
guard is a pure key-membership check (not a Pydantic model): it inspects ``dict.keys()``
against a resolved ``frozenset`` and never looks at values. The provider wires it into each
verb's call-boundary before any event is minted.

A ``None`` allowlist means the guard is inactive (every key passes). An explicit empty
``frozenset()`` is ACTIVE (allow-nothing) — the activation predicate is ``allowlist is not
None``, never ``len(allowlist) > 0`` — so a taxonomy-derived allowlist that happens to be
empty still enforces.

Ported 1:1 from the TypeScript ``enforceAllowlist`` (``ts/packages/analytics-kit/src``);
there is no vendor allowlist analogue, so this is the library's own surface, not a
de-branding.
"""

from __future__ import annotations

import logging
from typing import Literal

ViolationPolicy = Literal["throw", "drop-and-error-log"]
"""What happens on an off-list key: raise, or emit one error and drop the event."""

_logger = logging.getLogger("analytics_kit")


def emit_violation(message: str) -> None:
    """Emit a single error-level violation record on the shared library logger.

    Shared by the allowlist gate and the taxonomy prop-type validator so both violation
    guards log identically under the ``drop-and-error-log`` policy.
    """
    _logger.error(message)


def enforce_allowlist(
    allowlist: frozenset[str] | None,
    on_violation: ViolationPolicy,
    *bags: dict[str, object] | None,
) -> bool:
    """Enforce the payload allowlist over one or more property bags (keys only).

    ``None`` allowlist ⇒ inactive: every key passes and ``True`` is returned. Otherwise each
    non-``None`` bag is scanned; a ``None`` bag is skipped. The first key not in ``allowlist``
    is a violation: ``throw`` raises naming the key; ``drop-and-error-log`` emits one error and
    returns ``False`` (the drop signal), short-circuiting on that first off-list key. With every
    key on-list, returns ``True``.
    """
    # Top-level keys only (by design): a nested {"user": {"ssn": ...}} with "user" on-list
    # passes "ssn" through — deep-key allowlisting is a future extension, not enforced here.
    if allowlist is None:
        return True
    for bag in bags:
        if bag is None:
            continue
        for key in bag:
            if key in allowlist:
                continue
            message = f'analytics-kit: property "{key}" is not on the payload allowlist'
            if on_violation == "throw":
                raise ValueError(message)
            emit_violation(message)
            return False
    return True
