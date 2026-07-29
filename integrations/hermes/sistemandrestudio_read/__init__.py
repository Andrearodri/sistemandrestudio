"""Hermes plugin exposing exactly one restricted sistemandrestudio tool."""

from __future__ import annotations

import os
from typing import Any, Mapping

from .client import (
    ALLOWED_OPERATIONS,
    EDITORIAL_STATES,
    TOKEN_ENVIRONMENT_VARIABLE,
    TOOL_NAME,
    TOOLSET_NAME,
    execute_from_environment,
)

TOOL_SCHEMA = {
    "name": TOOL_NAME,
    "description": (
        "Read allowlisted editorial and orchestration data from the private "
        "sistemandrestudio API. This tool cannot mutate data or select a URL, "
        "HTTP method, headers, or request body."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "operation": {
                "type": "string",
                "enum": list(ALLOWED_OPERATIONS),
            },
            "run_id": {"type": "string", "maxLength": 128},
            "news_id": {"type": "string", "maxLength": 128},
            "draft_id": {"type": "string", "maxLength": 128},
            "state": {
                "type": "string",
                "enum": list(EDITORIAL_STATES),
            },
            "limit": {
                "type": "integer",
                "minimum": 1,
                "maximum": 100,
            },
            "cursor": {
                "type": "string",
                "pattern": "^(0|[1-9][0-9]{0,6})$",
            },
            "version": {
                "type": "integer",
                "minimum": 1,
                "maximum": 1000000,
            },
        },
        "required": ["operation"],
        "additionalProperties": False,
    },
}


def check_requirements() -> bool:
    return bool(os.environ.get(TOKEN_ENVIRONMENT_VARIABLE, "").strip())


def handle_tool(arguments: Mapping[str, Any], **_: Any) -> str:
    return execute_from_environment(arguments)


def register(context: Any) -> None:
    """Register the sole tool provided by this plugin."""

    context.register_tool(
        name=TOOL_NAME,
        toolset=TOOLSET_NAME,
        schema=TOOL_SCHEMA,
        handler=handle_tool,
        check_fn=check_requirements,
        requires_env=[TOKEN_ENVIRONMENT_VARIABLE],
    )
