"""Single source of truth for the library version.

Isolated in its own module so both the package root and the target modules can read it
without an import-ordering cycle through the root ``__init__``.
"""

from __future__ import annotations

__version__ = "0.0.0"
