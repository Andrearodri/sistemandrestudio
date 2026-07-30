"""Official Hermes plugin entry point for the restricted integration."""

from __future__ import annotations

from typing import Any

from .sistemandrestudio_read import register as register_restricted_tool


def register(context: Any) -> None:
    """Register the sole allowlisted tool through Hermes' PluginManager."""

    register_restricted_tool(context)
