from __future__ import annotations

import json
import unittest
from typing import Any, Dict, Iterable, Mapping, Optional

from integrations.hermes.restricted_toolset import (
    EXPECTED_TOOL_NAMES,
    FORBIDDEN_TOOL_NAMES,
    PINNED_HERMES_VERSION,
    RestrictedToolsetError,
    assert_pinned_hermes_version,
    create_restricted_agent,
    resolve_model_visible_tools,
)
from integrations.hermes.sistemandrestudio_read import (
    ALLOWED_OPERATIONS,
    TOOL_NAME,
    TOOL_SCHEMA,
    TOOLSET_NAME,
    register,
)
from integrations.hermes.sistemandrestudio_read.client import (
    BASE_URL,
    MAX_RESPONSE_BYTES,
    TIMEOUT_SECONDS,
    HttpxReadTransport,
    ReadonlyToolError,
    SistemandrestudioReadClient,
    build_read_request,
)

TEST_TOKEN = "test-read-token-that-must-never-be-logged"


class RecordingTransport:
    def __init__(
        self,
        result: Any = None,
        error: Optional[ReadonlyToolError] = None,
    ) -> None:
        self.result = {"ok": True} if result is None else result
        self.error = error
        self.calls = []

    def get(
        self,
        path: str,
        parameters: Mapping[str, str],
        token: str,
    ) -> Any:
        self.calls.append((path, dict(parameters), token))
        if self.error is not None:
            raise self.error
        return self.result


class FakeResponse:
    def __init__(
        self,
        chunks: Iterable[bytes],
        status_code: int = 200,
        headers: Optional[Mapping[str, str]] = None,
    ) -> None:
        self.status_code = status_code
        self.headers = dict(headers or {"content-type": "application/json"})
        self._chunks = list(chunks)

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def iter_bytes(self) -> Iterable[bytes]:
        return iter(self._chunks)


class FakeHttpxClient:
    def __init__(
        self,
        response: Optional[FakeResponse] = None,
        timeout: bool = False,
    ) -> None:
        self.response = response or FakeResponse([b'{"ok":true}'])
        self.timeout = timeout
        self.calls = []

    def __enter__(self) -> "FakeHttpxClient":
        return self

    def __exit__(self, *_: Any) -> None:
        return None

    def stream(self, method: str, path: str, **options: Any) -> FakeResponse:
        self.calls.append((method, path, options))
        if self.timeout:
            raise TimeoutError("sensitive timeout detail")
        return self.response


class RecordingClientFactory:
    def __init__(self, client: FakeHttpxClient) -> None:
        self.client = client
        self.options: Dict[str, Any] = {}

    def __call__(self, **options: Any) -> FakeHttpxClient:
        self.options = options
        return self.client


class FakePluginContext:
    def __init__(self) -> None:
        self.registrations = []

    def register_tool(self, **registration: Any) -> None:
        self.registrations.append(registration)


class RestrictedReadClientTests(unittest.TestCase):
    def test_every_allowed_operation_builds_only_the_expected_get(self) -> None:
        cases = (
            ({"operation": "health"}, "/internal/health", {}),
            ({"operation": "system_status"}, "/internal/system/status", {}),
            (
                {"operation": "list_pending_decisions"},
                "/internal/orchestration/pending-decisions",
                {},
            ),
            (
                {"operation": "get_run", "run_id": "run-1"},
                "/internal/orchestration/runs/run-1",
                {},
            ),
            (
                {
                    "operation": "list_editorial_items",
                    "state": "VERIFIED",
                    "limit": 100,
                    "cursor": "20",
                },
                "/internal/editorial/items",
                {"state": "VERIFIED", "limit": "100", "cursor": "20"},
            ),
            (
                {"operation": "get_editorial_item", "news_id": "news-1"},
                "/internal/editorial/items/news-1",
                {},
            ),
            (
                {
                    "operation": "get_item_evidence",
                    "news_id": "news-1",
                    "limit": 10,
                },
                "/internal/editorial/items/news-1/evidence",
                {"limit": "10"},
            ),
            (
                {
                    "operation": "get_editorial_draft",
                    "draft_id": "draft-1",
                    "version": 2,
                },
                "/internal/editorial/drafts/draft-1",
                {"version": "2"},
            ),
        )
        self.assertEqual(tuple(case[0]["operation"] for case in cases), ALLOWED_OPERATIONS)
        for arguments, expected_path, expected_parameters in cases:
            with self.subTest(operation=arguments["operation"]):
                transport = RecordingTransport()
                result = SistemandrestudioReadClient(
                    TEST_TOKEN,
                    transport=transport,
                ).execute(arguments)
                self.assertEqual(result, {"ok": True})
                self.assertEqual(
                    transport.calls,
                    [(expected_path, expected_parameters, TEST_TOKEN)],
                )

    def test_arbitrary_http_primitives_and_unknown_endpoint_are_rejected(self) -> None:
        attempts = (
            {"operation": "health", "url": "http://attacker.invalid"},
            {"operation": "health", "host": "127.0.0.2"},
            {"operation": "health", "port": 80},
            {"operation": "health", "method": "POST"},
            {"operation": "health", "headers": {"x-test": "value"}},
            {"operation": "health", "body": {"mutate": True}},
            {"operation": "/internal/not-allowlisted"},
        )
        for arguments in attempts:
            with self.subTest(arguments=arguments):
                with self.assertRaises(ReadonlyToolError):
                    build_read_request(arguments)

    def test_invalid_identifiers_pagination_and_irrelevant_parameters_fail(self) -> None:
        attempts = (
            {"operation": "get_run", "run_id": "../secret"},
            {"operation": "get_editorial_item", "news_id": ""},
            {"operation": "get_item_evidence", "news_id": "news-1", "limit": 101},
            {"operation": "list_editorial_items", "limit": True},
            {"operation": "list_editorial_items", "cursor": "-1"},
            {"operation": "list_editorial_items", "state": "UNKNOWN"},
            {
                "operation": "get_editorial_draft",
                "draft_id": "draft-1",
                "run_id": "run-1",
            },
        )
        for arguments in attempts:
            with self.subTest(arguments=arguments):
                with self.assertRaises(ReadonlyToolError) as raised:
                    build_read_request(arguments)
                self.assertEqual(raised.exception.code, "READ_TOOL_PARAMETER_INVALID")

    def test_transport_fixes_origin_method_and_http_safety_options(self) -> None:
        fake_client = FakeHttpxClient()
        factory = RecordingClientFactory(fake_client)
        transport = HttpxReadTransport(factory)
        result = transport.get("/internal/health", {}, TEST_TOKEN)

        self.assertEqual(result, {"ok": True})
        self.assertEqual(
            factory.options,
            {
                "base_url": BASE_URL,
                "timeout": TIMEOUT_SECONDS,
                "follow_redirects": False,
                "trust_env": False,
            },
        )
        method, path, options = fake_client.calls[0]
        self.assertEqual(method, "GET")
        self.assertEqual(path, "/internal/health")
        self.assertEqual(options["params"], {})
        self.assertEqual(options["headers"]["authorization"], "Bearer " + TEST_TOKEN)

    def test_response_larger_than_256_kib_is_blocked(self) -> None:
        response = FakeResponse([b"x" * (MAX_RESPONSE_BYTES + 1)])
        factory = RecordingClientFactory(FakeHttpxClient(response=response))
        with self.assertRaises(ReadonlyToolError) as raised:
            HttpxReadTransport(factory).get("/internal/health", {}, TEST_TOKEN)
        self.assertEqual(raised.exception.code, "READ_TOOL_RESPONSE_TOO_LARGE")

    def test_timeout_is_sanitized(self) -> None:
        factory = RecordingClientFactory(FakeHttpxClient(timeout=True))
        with self.assertRaises(ReadonlyToolError) as raised:
            HttpxReadTransport(factory).get("/internal/health", {}, TEST_TOKEN)
        self.assertEqual(raised.exception.code, "READ_TOOL_TIMEOUT")
        self.assertNotIn("sensitive", raised.exception.message)

    def test_token_never_appears_in_logs_or_sanitized_errors(self) -> None:
        logs = []
        transport = RecordingTransport(
            error=ReadonlyToolError("READ_TOOL_TIMEOUT", "The private API read timed out.")
        )
        client = SistemandrestudioReadClient(
            TEST_TOKEN,
            transport=transport,
            logger=logs.append,
        )
        with self.assertRaises(ReadonlyToolError) as raised:
            client.execute({"operation": "health"})
        output = json.dumps(
            {"logs": logs, "code": raised.exception.code, "message": raised.exception.message}
        )
        self.assertNotIn(TEST_TOKEN, output)
        self.assertNotIn("Bearer", output)


class HermesToolsetTests(unittest.TestCase):
    def test_plugin_registers_exactly_one_tool(self) -> None:
        context = FakePluginContext()
        register(context)
        self.assertEqual(len(context.registrations), 1)
        registration = context.registrations[0]
        self.assertEqual(registration["name"], TOOL_NAME)
        self.assertEqual(registration["toolset"], TOOLSET_NAME)
        self.assertEqual(registration["schema"], TOOL_SCHEMA)
        self.assertFalse(registration.get("override", False))

    def test_schema_exposes_no_arbitrary_network_or_mutation_arguments(self) -> None:
        properties = set(TOOL_SCHEMA["parameters"]["properties"])
        self.assertTrue(
            properties.isdisjoint(
                {"url", "host", "port", "method", "headers", "body", "endpoint"}
            )
        )
        self.assertEqual(
            tuple(TOOL_SCHEMA["parameters"]["properties"]["operation"]["enum"]),
            ALLOWED_OPERATIONS,
        )

    def test_model_visible_tool_resolution_uses_only_explicit_plugin_toolset(self) -> None:
        calls = []

        def resolver(**options: Any) -> list:
            calls.append(options)
            return [{"type": "function", "function": {"name": TOOL_NAME}}]

        definitions = resolve_model_visible_tools(resolver)
        self.assertEqual(
            definitions,
            [{"type": "function", "function": {"name": TOOL_NAME}}],
        )
        self.assertEqual(
            calls,
            [
                {
                    "enabled_toolsets": [TOOLSET_NAME],
                    "disabled_toolsets": [],
                    "quiet_mode": True,
                }
            ],
        )

    def test_wrapper_builds_agent_with_only_one_registered_and_visible_tool(self) -> None:
        calls = []

        class Agent:
            tools = [{"type": "function", "function": {"name": TOOL_NAME}}]
            valid_tool_names = [TOOL_NAME]

        def factory(**options: Any) -> Agent:
            calls.append(options)
            return Agent()

        agent = create_restricted_agent(factory, model="unused-test-model")
        self.assertEqual(agent.valid_tool_names, list(EXPECTED_TOOL_NAMES))
        self.assertEqual(calls[0]["enabled_toolsets"], [TOOLSET_NAME])
        self.assertEqual(calls[0]["disabled_toolsets"], [])
        self.assertTrue(calls[0]["skip_context_files"])
        self.assertTrue(calls[0]["skip_memory"])
        self.assertFalse(calls[0]["load_soul_identity"])
        self.assertFalse(calls[0]["checkpoints_enabled"])

    def test_wrapper_fails_closed_for_extra_missing_or_unverifiable_tools(self) -> None:
        invalid_tool_lists = (
            [],
            [
                {"type": "function", "function": {"name": TOOL_NAME}},
                {"type": "function", "function": {"name": "terminal"}},
            ],
            None,
        )
        for tools in invalid_tool_lists:
            with self.subTest(tools=tools):
                class Agent:
                    valid_tool_names = [] if tools is None else [
                        item["function"]["name"] for item in tools
                    ]

                Agent.tools = tools
                with self.assertRaises(RestrictedToolsetError):
                    create_restricted_agent(lambda **_: Agent())

    def test_security_options_cannot_be_overridden(self) -> None:
        with self.assertRaises(RestrictedToolsetError):
            create_restricted_agent(lambda **_: object(), enabled_toolsets=["terminal"])

    def test_forbidden_capabilities_are_absent(self) -> None:
        self.assertEqual(EXPECTED_TOOL_NAMES, ("sistemandrestudio_read",))
        self.assertTrue(set(EXPECTED_TOOL_NAMES).isdisjoint(FORBIDDEN_TOOL_NAMES))
        schema_text = json.dumps(TOOL_SCHEMA).lower()
        for name in (
            "terminal",
            "read_file",
            "write_file",
            "browser",
            "execute_code",
            "cron",
            "skill_manage",
            "delegate_task",
            "docker",
            "ssh",
            "aws",
        ):
            self.assertNotIn('"' + name + '"', schema_text)

    def test_compatibility_is_explicitly_pinned(self) -> None:
        self.assertEqual(PINNED_HERMES_VERSION, "0.19.0")
        assert_pinned_hermes_version(lambda _: "0.19.0")
        with self.assertRaises(RestrictedToolsetError):
            assert_pinned_hermes_version(lambda _: "0.20.0")


if __name__ == "__main__":
    unittest.main()
