"""Fail-closed Hermes 0.19.0 agent assembly with exactly one visible tool."""

from __future__ import annotations

from importlib import metadata
from typing import Any, Callable, Dict, Iterable, List, Mapping, Optional

from .sistemandrestudio_read.client import TOOL_NAME, TOOLSET_NAME

PINNED_HERMES_VERSION = "0.19.0"
EXPECTED_TOOL_NAMES = (TOOL_NAME,)

FORBIDDEN_TOOL_NAMES = (
    "terminal",
    "shell",
    "process",
    "read_file",
    "write_file",
    "browser",
    "execute_code",
    "delegate_task",
    "cron",
    "skill_manage",
    "memory",
    "mcp",
    "docker",
    "ssh",
    "aws",
)

_AGENT_SECURITY_OPTIONS: Dict[str, Any] = {
    "enabled_toolsets": [TOOLSET_NAME],
    "disabled_toolsets": [],
    "skip_context_files": True,
    "load_soul_identity": False,
    "skip_memory": True,
    "checkpoints_enabled": False,
    "quiet_mode": True,
}


class RestrictedToolsetError(RuntimeError):
    """Raised when Hermes would expose anything other than the one allowed tool."""


def resolve_model_visible_tools(
    resolver: Optional[Callable[..., List[Mapping[str, Any]]]] = None,
) -> List[Mapping[str, Any]]:
    """Resolve the final tool definitions using Hermes' public model_tools API."""

    if resolver is None:
        assert_pinned_hermes_version()
        from model_tools import get_tool_definitions

        resolver = get_tool_definitions
    definitions = resolver(
        enabled_toolsets=[TOOLSET_NAME],
        disabled_toolsets=[],
        quiet_mode=True,
    )
    assert_exact_tool_names(definitions)
    return definitions


def create_restricted_agent(
    agent_factory: Optional[Callable[..., Any]] = None,
    **agent_options: Any,
) -> Any:
    """Construct AIAgent with an explicit registry and verify its final tools."""

    forbidden_overrides = set(_AGENT_SECURITY_OPTIONS).intersection(agent_options)
    if forbidden_overrides:
        raise RestrictedToolsetError(
            "Restricted Hermes security options cannot be overridden."
        )
    if agent_factory is None:
        assert_pinned_hermes_version()
        from run_agent import AIAgent

        agent_factory = AIAgent

    agent = agent_factory(**_AGENT_SECURITY_OPTIONS, **agent_options)
    definitions = getattr(agent, "tools", None)
    if not isinstance(definitions, list):
        raise RestrictedToolsetError(
            "Hermes did not expose a verifiable final tool list."
        )
    assert_exact_tool_names(definitions)

    valid_names = getattr(agent, "valid_tool_names", None)
    if valid_names is not None and tuple(valid_names) != EXPECTED_TOOL_NAMES:
        raise RestrictedToolsetError(
            "Hermes valid_tool_names differs from the restricted registry."
        )
    return agent


def assert_pinned_hermes_version(
    version_resolver: Optional[Callable[[str], str]] = None,
) -> None:
    """Reject any installed Hermes distribution other than the reviewed pin."""

    resolver = version_resolver or metadata.version
    try:
        installed = resolver("hermes-agent")
    except metadata.PackageNotFoundError as error:
        raise RestrictedToolsetError(
            "The pinned Hermes distribution is not installed."
        ) from error
    if installed != PINNED_HERMES_VERSION:
        raise RestrictedToolsetError(
            "The installed Hermes version differs from the reviewed pin."
        )


def assert_exact_tool_names(definitions: Iterable[Mapping[str, Any]]) -> None:
    names = tuple(_definition_name(definition) for definition in definitions)
    if names != EXPECTED_TOOL_NAMES:
        raise RestrictedToolsetError(
            "Hermes model-visible tools must equal ['sistemandrestudio_read']."
        )


def _definition_name(definition: Mapping[str, Any]) -> str:
    function = definition.get("function")
    if isinstance(function, Mapping):
        name = function.get("name")
    else:
        name = definition.get("name")
    if not isinstance(name, str):
        raise RestrictedToolsetError("Hermes returned an invalid tool definition.")
    return name
