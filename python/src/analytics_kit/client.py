"""Server client seam — the public provider entry.

Re-exports the server-shaped :class:`~analytics_kit.provider.Analytics` provider so consuming
apps import the verb surface from a stable entry point. The config-selected factory that
constructs it lands in a later cycle; until then a provider is constructed with an injected
adapter.
"""

from .provider import Analytics

__all__ = ["Analytics"]
