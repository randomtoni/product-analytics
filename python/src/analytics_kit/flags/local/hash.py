"""The consistent-hash bucketing primitive shared by rollout gating and variant banding.

Ported VERBATIM in algorithm from the TS-node local evaluator (``hash.ts``), which is itself the
de-branded reference arithmetic — only the naming is neutral. The constant, the SHA-1 concat shape,
and the 15-hex-nibble slice are the load-bearing CROSS-TREE parity invariant: the same
``(flag_key, bucketing_value, salt)`` MUST produce the same float here, in the TS node port, in a
remote eval, and at the backend — bit-identical — or local and remote disagree for the same actor.
Do NOT "improve" any of it.
"""

# De-branded from posthog's feature_flags.py `_hash`/`__LONG_SCALE__`.

from __future__ import annotations

import hashlib

# The divisor: 0xFFFFFFFFFFFFFFF — exactly FIFTEEN f's = 2**60 - 1 = 1152921504606846975, kept a
# FLOAT so the division is float64. The 60-bit numerator is exact as a Python int, but the reference
# does `int / float(...)`, yielding a float64 — matching the TS `parseInt / LONG_SCALE`. A `Decimal`
# or integer-division port would silently drift; keep the float divisor and the plain `/`.
_LONG_SCALE = float(0xFFFFFFFFFFFFFFF)


def hash_sha1(text: str) -> str:
    """A 40-char lowercase-hex SHA-1 digest of ``text`` (UTF-8). Synchronous by construction."""
    return hashlib.sha1(text.encode("utf-8")).hexdigest()  # noqa: S324 — non-crypto bucketing hash, not security.


def bucket_hash(key: str, bucketing_value: str, salt: str = "") -> float:
    """Map a ``(key, bucketing_value, salt)`` triple to a deterministic ``[0, 1]`` float, uniformly
    distributed, TOP-INCLUSIVE: an all-``f`` slice yields exactly ``1.0`` (do NOT renormalize to
    ``[0, 1)``) — the 100%-rollout gate depends on ``1.0 <= 1.0``. The ``.`` separator sits between
    key and bucketing value ONLY; ``salt`` is a suffix on the bucketing value with NO separator.
    Rollout bucketing passes no salt (``""``); variant banding passes the literal ``"variant"``.
    """
    digest = hash_sha1(f"{key}.{bucketing_value}{salt}")
    return int(digest[:15], 16) / _LONG_SCALE
