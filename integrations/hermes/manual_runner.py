"""Deterministic contract for the supervised two-call Hermes model runner.

This module performs no network access and does not load credentials.  It
defines the only schema that a future manual model invocation may receive and
validates every requested tool call before any local dispatch occurs.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Sequence, Tuple

from .sistemandrestudio_read import TOOL_NAME

MANUAL_ALLOWED_OPERATIONS = (
    "health",
    "system_status",
    "list_pending_decisions",
    "list_editorial_items",
)
DEFAULT_LIST_LIMIT = 25
MAX_LIST_LIMIT = 100
MAX_LOCAL_TOOL_CALLS = 4
MAX_MODEL_CALLS = 2
MAX_OUTPUT_TOKENS = 300
MODEL_TIMEOUT_SECONDS = 15

MANUAL_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": TOOL_NAME,
        "description": (
            "Execute exactly one allowlisted read-only operation against the "
            "local sistemandrestudio API. Use one tool call per operation. "
            "For a complete overview, system_status contains API/database "
            "health, editorial counts by state, and pending human decisions."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "operation": {
                    "type": "string",
                    "enum": list(MANUAL_ALLOWED_OPERATIONS),
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_LIST_LIMIT,
                    "description": (
                        "Optional only for list_editorial_items; defaults to 25."
                    ),
                },
            },
            "required": ["operation"],
            "additionalProperties": False,
        },
    },
}


class ManualRunnerContractError(RuntimeError):
    """Stable fail-closed error raised before a local tool is dispatched."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ValidatedToolCall:
    call_id: str
    arguments: Mapping[str, Any]


def validate_manual_arguments(arguments: Any) -> Mapping[str, Any]:
    """Validate and normalize one operation payload for the manual runner."""

    if not isinstance(arguments, Mapping):
        raise ManualRunnerContractError(
            "MANUAL_ARGUMENTS_INVALID",
            "Tool arguments must be one JSON object.",
        )
    keys = set(arguments)
    if "operations" in keys or isinstance(arguments.get("operation"), (list, tuple)):
        raise ManualRunnerContractError(
            "MANUAL_MULTIPLE_OPERATIONS",
            "Only one operation may be requested per tool call.",
        )
    operation = arguments.get("operation")
    if operation not in MANUAL_ALLOWED_OPERATIONS:
        raise ManualRunnerContractError(
            "MANUAL_OPERATION_FORBIDDEN",
            "The requested operation is not allowed by the manual runner.",
        )

    allowed_keys = {"operation", "limit"} if operation == "list_editorial_items" else {"operation"}
    if keys != {"operation"} and not keys.issubset(allowed_keys):
        raise ManualRunnerContractError(
            "MANUAL_ARGUMENTS_INVALID",
            "The tool call contains unknown or irrelevant arguments.",
        )

    if operation != "list_editorial_items":
        if keys != {"operation"}:
            raise ManualRunnerContractError(
                "MANUAL_ARGUMENTS_INVALID",
                "Only list_editorial_items accepts a limit.",
            )
        return {"operation": operation}

    limit = arguments.get("limit", DEFAULT_LIST_LIMIT)
    if isinstance(limit, bool) or not isinstance(limit, int):
        raise ManualRunnerContractError(
            "MANUAL_ARGUMENTS_INVALID",
            "The list limit must be an integer.",
        )
    if limit < 1 or limit > MAX_LIST_LIMIT:
        raise ManualRunnerContractError(
            "MANUAL_ARGUMENTS_INVALID",
            "The list limit is outside the allowed range.",
        )
    return {"operation": operation, "limit": limit}


def validate_model_tool_calls(
    tool_calls: Any,
) -> Tuple[ValidatedToolCall, ...]:
    """Validate all model tool calls before allowing any local execution."""

    if not isinstance(tool_calls, Sequence) or isinstance(tool_calls, (str, bytes)):
        raise ManualRunnerContractError(
            "MANUAL_TOOL_CALLS_INVALID",
            "The model returned an invalid tool-call collection.",
        )
    if not 1 <= len(tool_calls) <= MAX_LOCAL_TOOL_CALLS:
        raise ManualRunnerContractError(
            "MANUAL_TOOL_CALL_COUNT",
            "The model may request between one and four local tool calls.",
        )

    validated = []
    seen_operations = set()
    for tool_call in tool_calls:
        if not isinstance(tool_call, Mapping):
            _invalid_tool_call()
        call_id = tool_call.get("id")
        function = tool_call.get("function")
        if (
            not isinstance(call_id, str)
            or not call_id
            or not isinstance(function, Mapping)
            or function.get("name") != TOOL_NAME
        ):
            _invalid_tool_call()
        raw_arguments = function.get("arguments")
        if not isinstance(raw_arguments, str):
            _invalid_tool_call()
        try:
            parsed = json.loads(raw_arguments)
        except json.JSONDecodeError as error:
            raise ManualRunnerContractError(
                "MANUAL_ARGUMENTS_INVALID",
                "Tool arguments are not valid JSON.",
            ) from error
        normalized = validate_manual_arguments(parsed)
        operation = normalized["operation"]
        if operation in seen_operations:
            raise ManualRunnerContractError(
                "MANUAL_DUPLICATE_OPERATION",
                "Each operation may be requested at most once.",
            )
        seen_operations.add(operation)
        validated.append(ValidatedToolCall(call_id, normalized))
    return tuple(validated)


def execute_local_tool_calls(
    tool_calls: Any,
    dispatcher: Callable[[str, Mapping[str, Any]], str],
) -> Tuple[Tuple[str, str], ...]:
    """Validate the complete batch, then dispatch it sequentially."""

    validated = validate_model_tool_calls(tool_calls)
    return tuple(
        (call.call_id, dispatcher(TOOL_NAME, call.arguments))
        for call in validated
    )


def model_request_options() -> Mapping[str, Any]:
    """Return immutable security limits shared by both future model calls."""

    return {
        "tools": [MANUAL_TOOL_SCHEMA],
        "parallel_tool_calls": False,
        "max_tokens": MAX_OUTPUT_TOKENS,
        "stream": False,
        "timeout_seconds": MODEL_TIMEOUT_SECONDS,
        "max_model_calls": MAX_MODEL_CALLS,
        "retry": False,
        "fallback": False,
    }


def _invalid_tool_call() -> None:
    raise ManualRunnerContractError(
        "MANUAL_TOOL_CALL_INVALID",
        "The model returned an invalid or unauthorized tool call.",
    )
