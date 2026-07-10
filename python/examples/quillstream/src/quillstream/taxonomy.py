"""Quillstream's product taxonomy — every event name, trait, and group is Quillstream's own.

Authored via the public ``analytics_kit`` API only. The library ships zero vocabulary; the
product supplies all of it here.
"""

from __future__ import annotations

from analytics_kit import Taxonomy, define_taxonomy

quillstream_taxonomy: Taxonomy = define_taxonomy(
    {
        "events": {
            "workspace_created": {"plan": "string", "seats": "number"},
            "document_created": {"document_id": "string", "template": "string"},
            "draft_saved": {"document_id": "string", "word_count": "number"},
            "collaborator_invited": {"document_id": "string", "role": "string"},
            "comment_posted": {"document_id": "string", "resolved": "boolean"},
            "document_published": {"document_id": "string", "public": "boolean"},
            "plan_upgraded": {"from_plan": "string", "to_plan": "string"},
        },
        "traits": {
            "role": "string",
            "plan": "string",
            "email": "string",
        },
        "groups": {
            "workspace": {"name": "string", "seats": "number"},
            "team": {"name": "string"},
        },
    }
)
