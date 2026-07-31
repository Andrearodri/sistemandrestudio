"""Deterministic contract for the supervised two-call Hermes model runner.

This module performs no network access and does not load credentials.  It
defines the only schema that a future manual model invocation may receive and
validates every requested tool call before any local dispatch occurs.
"""

from __future__ import annotations

import hashlib
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


def extract_required_tool_calls(response: Any) -> Tuple[Any, ...]:
    """Extract a mandatory tool-call collection from an OpenAI/Hermes reply.

    This is intentionally separate from validation and dispatch.  It gives a
    future runner a stable, fail-closed reason when the provider returns prose
    instead of a tool request; prose is never interpreted as API data.
    """

    if not _is_wrapper(response):
        _fail("INVALID_RESPONSE_WRAPPER", "The provider response wrapper is invalid.")
    if not _has_field(response, "message"):
        _fail("MISSING_MESSAGE", "The provider response has no message.")
    message = _field(response, "message")
    if not _is_wrapper(message):
        _fail("INVALID_MESSAGE_WRAPPER", "The provider message wrapper is invalid.")
    if not _has_field(message, "tool_calls") or _field(message, "tool_calls") is None:
        if _field(message, "content"):
            _fail("TEXT_WHEN_TOOL_REQUIRED", "A tool call is required; text is not accepted.")
        _fail("NO_TOOL_CALL", "The provider did not request a tool call.")
    tool_calls = _field(message, "tool_calls")
    if not isinstance(tool_calls, (list, tuple)):
        _fail("INVALID_TOOL_CALLS_TYPE", "The tool-call collection has an invalid type.")
    return tuple(tool_calls)


def normalize_function_call(function: Any) -> Tuple[str, Mapping[str, Any]]:
    """Normalize the Hermes/OpenAI function representation without coercion.

    Hermes 0.19.0 receives an OpenAI-compatible ``function`` object and, in
    its conversation loop, accepts either JSON text or an already decoded
    mapping in ``function.arguments``.  The manual runner mirrors only that
    narrow representation.  It deliberately does not parse Markdown, YAML,
    Python literals, or JSON embedded in surrounding text.
    """

    if not _is_wrapper(function):
        _fail("MISSING_FUNCTION", "The tool call has no function wrapper.")
    if not _has_field(function, "name"):
        _fail("MISSING_TOOL_NAME", "The tool call has no tool name.")
    name = _field(function, "name")
    if name != TOOL_NAME:
        _fail("INVALID_TOOL_NAME", "The requested tool is not allowlisted.")
    if not _has_field(function, "arguments"):
        _fail("MISSING_ARGUMENTS", "The tool call has no arguments.")
    return name, normalize_tool_arguments(_field(function, "arguments"))


def normalize_tool_arguments(arguments: Any) -> Mapping[str, Any]:
    """Accept one JSON object or one already-decoded mapping, fail closed."""

    if isinstance(arguments, str):
        try:
            decoded = json.loads(arguments)
        except json.JSONDecodeError as error:
            raise ManualRunnerContractError("INVALID_ARGUMENTS_JSON", "Tool arguments are not valid JSON.") from error
    elif isinstance(arguments, Mapping):
        decoded = dict(arguments)
    else:
        _fail("INVALID_ARGUMENTS_TYPE", "Tool arguments must be one JSON object.")

    if not isinstance(decoded, Mapping):
        _fail("INVALID_ARGUMENTS_TYPE", "Tool arguments must be one JSON object.")
    return dict(decoded)


def observe_tool_call(
    tool_call: Any,
    validation: str,
) -> Mapping[str, Any]:
    """Return safe future-runner diagnostics without retaining payload values."""

    function = _field(tool_call, "function")
    raw_arguments = _field(function, "arguments") if _is_wrapper(function) else None
    payload = _payload_bytes(raw_arguments)
    keys = _argument_keys(raw_arguments)
    name = _field(function, "name") if _is_wrapper(function) else None
    return {
        "tool_name": name if name == TOOL_NAME else None,
        "tool_name_allowed": name == TOOL_NAME,
        "arguments_type": _arguments_type(raw_arguments),
        "argument_keys": keys,
        "payload_sha256": hashlib.sha256(payload).hexdigest(),
        "payload_size": len(payload),
        "validation": validation,
    }


def observe_response_structure(
    response: Any,
    stage: str,
    failure_code: str | None = None,
) -> Mapping[str, Any]:
    """Create a hashable diagnostic from shape only, never provider values."""

    has_message = _has_field(response, "message")
    message = _field(response, "message") if has_message else None
    has_tool_calls = _is_wrapper(message) and _has_field(message, "tool_calls")
    tool_calls = _field(message, "tool_calls") if has_tool_calls else None
    first = tool_calls[0] if isinstance(tool_calls, (list, tuple)) and tool_calls else None
    function = _field(first, "function") if _is_wrapper(first) else None
    raw_arguments = _field(function, "arguments") if _is_wrapper(function) and _has_field(function, "arguments") else None
    name = _field(function, "name") if _is_wrapper(function) else None
    shape = {
        "response_type": type(response).__name__,
        "message_present": has_message,
        "tool_calls_present": has_tool_calls,
        "tool_calls_type": _arguments_type(tool_calls),
        "tool_calls_count": len(tool_calls) if isinstance(tool_calls, (list, tuple)) else None,
        "function_present": _is_wrapper(function),
        "tool_name_allowed": name == TOOL_NAME,
        "arguments_type": _arguments_type(raw_arguments),
        "argument_keys": _argument_keys(raw_arguments),
    }
    fragment = json.dumps(shape, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return {
        "stage": stage,
        "failure_code": failure_code,
        **shape,
        "fragment_size": len(fragment),
        "fragment_sha256": hashlib.sha256(fragment).hexdigest(),
    }


def validate_manual_arguments(arguments: Any) -> Mapping[str, Any]:
    """Validate and normalize one operation payload for the manual runner."""

    if not isinstance(arguments, Mapping):
        _fail("INVALID_ARGUMENTS_TYPE", "Tool arguments must be one JSON object.")
    keys = set(arguments)
    if "operations" in keys or isinstance(arguments.get("operation"), (list, tuple)):
        _fail("MULTIPLE_OPERATIONS", "Only one operation may be requested per tool call.")
    operation = arguments.get("operation")
    if operation is None:
        _fail("MISSING_OPERATION", "The tool call has no operation.")
    if operation not in MANUAL_ALLOWED_OPERATIONS:
        _fail("UNAUTHORIZED_OPERATION", "The requested operation is not allowlisted.")

    allowed_keys = {"operation", "limit"} if operation == "list_editorial_items" else {"operation"}
    if keys != {"operation"} and not keys.issubset(allowed_keys):
        _fail("INVALID_ARGUMENT_KEYS", "The tool call contains unknown or irrelevant arguments.")

    if operation != "list_editorial_items":
        if keys != {"operation"}:
            _fail("INVALID_ARGUMENT_KEYS", "Only list_editorial_items accepts a limit.")
        return {"operation": operation}

    limit = arguments.get("limit", DEFAULT_LIST_LIMIT)
    if isinstance(limit, bool) or not isinstance(limit, int):
        _fail("INVALID_LIMIT", "The list limit must be an integer.")
    if limit < 1 or limit > MAX_LIST_LIMIT:
        _fail("INVALID_LIMIT", "The list limit is outside the allowed range.")
    return {"operation": operation, "limit": limit}


def validate_model_tool_calls(
    tool_calls: Any,
) -> Tuple[ValidatedToolCall, ...]:
    """Validate all model tool calls before allowing any local execution."""

    if not isinstance(tool_calls, (list, tuple)):
        _fail("INVALID_TOOL_CALLS_TYPE", "The tool-call collection has an invalid type.")
    if not 1 <= len(tool_calls) <= MAX_LOCAL_TOOL_CALLS:
        _fail("INVALID_TOOL_CALL_COUNT", "The model may request between one and four local tool calls.")

    validated = []
    seen_operations = set()
    for tool_call in tool_calls:
        if not _is_wrapper(tool_call):
            _fail("UNRECOGNIZED_WRAPPER", "The tool-call wrapper is invalid.")
        call_id = _field(tool_call, "id") or _field(tool_call, "call_id")
        if not isinstance(call_id, str) or not call_id:
            _fail("MISSING_TOOL_CALL_ID", "The tool call has no identifier.")
        if not _has_field(tool_call, "function"):
            _fail("MISSING_FUNCTION", "The tool call has no function.")
        _, parsed = normalize_function_call(_field(tool_call, "function"))
        normalized = validate_manual_arguments(parsed)
        operation = normalized["operation"]
        if operation in seen_operations:
            _fail("DUPLICATE_OPERATION", "Each operation may be requested at most once.")
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


def _fail(code: str, message: str) -> None:
    raise ManualRunnerContractError(code, message)


def _field(value: Any, name: str) -> Any:
    if isinstance(value, Mapping):
        return value.get(name)
    return getattr(value, name, None)


def _has_field(value: Any, name: str) -> bool:
    if isinstance(value, Mapping):
        return name in value
    return hasattr(value, name)


def _is_wrapper(value: Any) -> bool:
    return isinstance(value, Mapping) or hasattr(value, "__dict__")


def _arguments_type(value: Any) -> str:
    if isinstance(value, str):
        return "str"
    if isinstance(value, Mapping):
        return "object"
    return type(value).__name__


def _payload_bytes(value: Any) -> bytes:
    if isinstance(value, str):
        return value.encode("utf-8", errors="surrogatepass")
    if isinstance(value, Mapping):
        return json.dumps(
            dict(value), sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode("utf-8")
    return repr(value).encode("utf-8", errors="backslashreplace")


def _argument_keys(value: Any) -> list[str]:
    candidate = value
    if isinstance(value, str):
        try:
            candidate = json.loads(value)
        except json.JSONDecodeError:
            return []
    if not isinstance(candidate, Mapping):
        return []
    return sorted(key for key in candidate if isinstance(key, str))
