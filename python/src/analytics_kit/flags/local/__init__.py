"""The adapter-internal local-evaluation machinery: the pure in-process evaluator + the definition
poller.

Nothing here is re-exported from the public ``analytics_kit`` package — it is internal machinery the
resolution branch in :class:`~analytics_kit.flags.adapter.HttpFlagAdapter` consumes. The frozen
``FeatureFlagPort``/``FlagSet``/``FlagContext`` are untouched; local eval slots entirely behind the
unchanged ``evaluate``.
"""

from __future__ import annotations

from .definition_poller import DefinitionPoller
from .definition_types import DefinitionSnapshot, FlagDefinition
from .errors import InconclusiveMatchError, RequiresServerEvaluation
from .evaluator import compute_flag_locally, evaluate_flag_locally, resolve_bucketing_value

__all__ = [
    "DefinitionPoller",
    "DefinitionSnapshot",
    "FlagDefinition",
    "InconclusiveMatchError",
    "RequiresServerEvaluation",
    "compute_flag_locally",
    "evaluate_flag_locally",
    "resolve_bucketing_value",
]
