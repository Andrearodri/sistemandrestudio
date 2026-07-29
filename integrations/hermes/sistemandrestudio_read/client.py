"""Deterministic read-only client for the private sistemandrestudio API."""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Callable, Dict, Mapping, Optional, Protocol, Tuple
from urllib.parse import quote

BASE_URL = "http://127.0.0.1:4317"
TIMEOUT_SECONDS = 5.0
MAX_RESPONSE_BYTES = 256 * 1024
MAX_ITEMS = 100
TOKEN_ENVIRONMENT_VARIABLE = "EDITORIAL_READ_API_SECRET"
TOOL_NAME = "sistemandrestudio_read"
TOOLSET_NAME = "sistemandrestudio_readonly"

EDITORIAL_STATES = (
    "RECEIVED",
    "NORMALIZED",
    "DUPLICATE",
    "SCORED",
    "DISCARDED_LOW_RELEVANCE",
    "PENDING_VERIFICATION",
    "VERIFIED",
    "VERIFICATION_REJECTED",
    "DRAFT_CREATED",
    "PENDING_APPROVAL",
    "CHANGES_REQUESTED",
    "APPROVED",
    "REJECTED",
    "READY_FOR_PUBLICATION",
    "PUBLISHED",
)

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_CURSOR = re.compile(r"^(0|[1-9][0-9]{0,6})$")


class ReadonlyToolError(Exception):
    """Stable, sanitized failure exposed by the restricted tool."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class ReadTransport(Protocol):
    def get(
        self,
        path: str,
        parameters: Mapping[str, str],
        token: str,
    ) -> Any:
        """Execute one fixed-origin GET and return decoded JSON."""


class HttpxReadTransport:
    """HTTP transport with a fixed origin and defensive response handling."""

    def __init__(self, client_factory: Optional[Callable[..., Any]] = None) -> None:
        self._client_factory = client_factory

    def get(
        self,
        path: str,
        parameters: Mapping[str, str],
        token: str,
    ) -> Any:
        if not path.startswith("/") or "://" in path or path.startswith("//"):
            raise ReadonlyToolError(
                "READ_TOOL_CONFIGURATION_ERROR",
                "The configured API path is invalid.",
            )
        factory = self._client_factory
        timeout_exception: Tuple[type, ...] = (TimeoutError,)
        if factory is None:
            try:
                import httpx
            except ImportError as error:
                raise ReadonlyToolError(
                    "READ_TOOL_DEPENDENCY_MISSING",
                    "The local HTTP dependency is unavailable.",
                ) from error
            factory = httpx.Client
            timeout_exception = (TimeoutError, httpx.TimeoutException)

        try:
            with factory(
                base_url=BASE_URL,
                timeout=TIMEOUT_SECONDS,
                follow_redirects=False,
                trust_env=False,
            ) as client:
                with client.stream(
                    "GET",
                    path,
                    params=dict(parameters),
                    headers={"authorization": "Bearer " + token},
                ) as response:
                    if 300 <= response.status_code < 400:
                        raise ReadonlyToolError(
                            "READ_TOOL_REDIRECT_BLOCKED",
                            "The private API returned a blocked redirect.",
                        )
                    if response.status_code == 404:
                        raise ReadonlyToolError(
                            "READ_TOOL_NOT_FOUND",
                            "The requested private API resource was not found.",
                        )
                    if response.status_code != 200:
                        raise ReadonlyToolError(
                            "READ_TOOL_UPSTREAM_ERROR",
                            "The private API rejected the read request.",
                        )
                    content_type = response.headers.get("content-type", "")
                    if not content_type.lower().startswith("application/json"):
                        raise ReadonlyToolError(
                            "READ_TOOL_INVALID_RESPONSE",
                            "The private API returned an invalid response.",
                        )
                    declared_size = response.headers.get("content-length")
                    if declared_size is not None:
                        try:
                            if int(declared_size) > MAX_RESPONSE_BYTES:
                                _response_too_large()
                        except ValueError as error:
                            raise ReadonlyToolError(
                                "READ_TOOL_INVALID_RESPONSE",
                                "The private API returned an invalid response.",
                            ) from error
                    chunks = []
                    received = 0
                    for chunk in response.iter_bytes():
                        received += len(chunk)
                        if received > MAX_RESPONSE_BYTES:
                            _response_too_large()
                        chunks.append(chunk)
        except ReadonlyToolError:
            raise
        except timeout_exception as error:
            raise ReadonlyToolError(
                "READ_TOOL_TIMEOUT",
                "The private API read timed out.",
            ) from error
        except Exception as error:
            raise ReadonlyToolError(
                "READ_TOOL_UNAVAILABLE",
                "The private API is unavailable.",
            ) from error

        try:
            return json.loads(b"".join(chunks).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ReadonlyToolError(
                "READ_TOOL_INVALID_RESPONSE",
                "The private API returned an invalid response.",
            ) from error


@dataclass(frozen=True)
class BuiltReadRequest:
    path: str
    parameters: Mapping[str, str]


class SistemandrestudioReadClient:
    """Allowlisted operation dispatcher without arbitrary HTTP primitives."""

    def __init__(
        self,
        token: str,
        transport: Optional[ReadTransport] = None,
        logger: Optional[Callable[[str], None]] = None,
    ) -> None:
        if not isinstance(token, str) or not token.strip():
            raise ReadonlyToolError(
                "READ_TOOL_CREDENTIAL_MISSING",
                "The read-only API credential is not configured.",
            )
        self._token = token
        self._transport = transport or HttpxReadTransport()
        self._logger = logger

    def execute(self, arguments: Mapping[str, Any]) -> Any:
        operation = arguments.get("operation") if isinstance(arguments, Mapping) else None
        try:
            request = build_read_request(arguments)
            result = self._transport.get(
                request.path,
                request.parameters,
                self._token,
            )
            self._log(operation, "allowed")
            return result
        except ReadonlyToolError as error:
            self._log(operation, "failed", error.code)
            raise

    def _log(
        self,
        operation: Any,
        outcome: str,
        code: Optional[str] = None,
    ) -> None:
        if self._logger is None:
            return
        safe_operation = operation if operation in ALLOWED_OPERATIONS else "invalid"
        suffix = "" if code is None else " code=" + code
        self._logger(
            "sistemandrestudio_read operation="
            + str(safe_operation)
            + " outcome="
            + outcome
            + suffix
        )


ALLOWED_OPERATIONS = (
    "health",
    "system_status",
    "list_pending_decisions",
    "get_run",
    "list_editorial_items",
    "get_editorial_item",
    "get_item_evidence",
    "get_editorial_draft",
)


def build_read_request(arguments: Mapping[str, Any]) -> BuiltReadRequest:
    if not isinstance(arguments, Mapping):
        _invalid_parameters()
    operation = arguments.get("operation")
    if operation not in ALLOWED_OPERATIONS:
        raise ReadonlyToolError(
            "READ_TOOL_OPERATION_FORBIDDEN",
            "The requested read operation is not allowed.",
        )

    if operation == "health":
        _require_keys(arguments, {"operation"}, set())
        return BuiltReadRequest("/internal/health", {})
    if operation == "system_status":
        _require_keys(arguments, {"operation"}, set())
        return BuiltReadRequest("/internal/system/status", {})
    if operation == "list_pending_decisions":
        _require_keys(arguments, {"operation"}, set())
        return BuiltReadRequest("/internal/orchestration/pending-decisions", {})
    if operation == "get_run":
        _require_keys(arguments, {"operation", "run_id"}, set())
        return BuiltReadRequest(
            "/internal/orchestration/runs/" + _encoded_identifier(arguments["run_id"]),
            {},
        )
    if operation == "list_editorial_items":
        _require_keys(
            arguments,
            {"operation"},
            {"state", "limit", "cursor"},
        )
        parameters: Dict[str, str] = {}
        if "state" in arguments:
            state = arguments["state"]
            if state not in EDITORIAL_STATES:
                _invalid_parameters()
            parameters["state"] = str(state)
        _add_pagination(arguments, parameters)
        return BuiltReadRequest("/internal/editorial/items", parameters)
    if operation == "get_editorial_item":
        _require_keys(arguments, {"operation", "news_id"}, set())
        return BuiltReadRequest(
            "/internal/editorial/items/"
            + _encoded_identifier(arguments["news_id"]),
            {},
        )
    if operation == "get_item_evidence":
        _require_keys(
            arguments,
            {"operation", "news_id"},
            {"limit", "cursor"},
        )
        parameters = {}
        _add_pagination(arguments, parameters)
        return BuiltReadRequest(
            "/internal/editorial/items/"
            + _encoded_identifier(arguments["news_id"])
            + "/evidence",
            parameters,
        )
    if operation == "get_editorial_draft":
        _require_keys(
            arguments,
            {"operation", "draft_id"},
            {"version"},
        )
        parameters = {}
        if "version" in arguments:
            parameters["version"] = str(
                _bounded_integer(arguments["version"], 1, 1_000_000)
            )
        return BuiltReadRequest(
            "/internal/editorial/drafts/"
            + _encoded_identifier(arguments["draft_id"]),
            parameters,
        )

    raise ReadonlyToolError(
        "READ_TOOL_OPERATION_FORBIDDEN",
        "The requested read operation is not allowed.",
    )


def execute_from_environment(
    arguments: Mapping[str, Any],
    environment: Optional[Mapping[str, str]] = None,
) -> str:
    source = os.environ if environment is None else environment
    token = source.get(TOKEN_ENVIRONMENT_VARIABLE, "")
    try:
        result = SistemandrestudioReadClient(token).execute(arguments)
        return json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    except ReadonlyToolError as error:
        return json.dumps(
            {
                "ok": False,
                "error": {"code": error.code, "message": error.message},
            },
            ensure_ascii=False,
            separators=(",", ":"),
        )


def _require_keys(
    arguments: Mapping[str, Any],
    required: set,
    optional: set,
) -> None:
    keys = set(arguments.keys())
    if not required.issubset(keys) or not keys.issubset(required | optional):
        _invalid_parameters()


def _encoded_identifier(value: Any) -> str:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        _invalid_parameters()
    return quote(value, safe="")


def _add_pagination(
    arguments: Mapping[str, Any],
    parameters: Dict[str, str],
) -> None:
    if "limit" in arguments:
        parameters["limit"] = str(_bounded_integer(arguments["limit"], 1, MAX_ITEMS))
    if "cursor" in arguments:
        cursor = arguments["cursor"]
        if not isinstance(cursor, str) or _CURSOR.fullmatch(cursor) is None:
            _invalid_parameters()
        parameters["cursor"] = cursor


def _bounded_integer(value: Any, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        _invalid_parameters()
    if value < minimum or value > maximum:
        _invalid_parameters()
    return value


def _invalid_parameters() -> None:
    raise ReadonlyToolError(
        "READ_TOOL_PARAMETER_INVALID",
        "The read operation parameters are invalid.",
    )


def _response_too_large() -> None:
    raise ReadonlyToolError(
        "READ_TOOL_RESPONSE_TOO_LARGE",
        "The private API response exceeds 256 KiB.",
    )
