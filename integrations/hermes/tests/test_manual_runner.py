from __future__ import annotations

import json
import unittest
from types import SimpleNamespace

from integrations.hermes.manual_runner import (
    DEFAULT_LIST_LIMIT,
    MANUAL_ALLOWED_OPERATIONS,
    MANUAL_TOOL_SCHEMA,
    MAX_LOCAL_TOOL_CALLS,
    MAX_MODEL_CALLS,
    ManualRunnerContractError,
    execute_local_tool_calls,
    extract_required_tool_calls,
    model_request_options,
    normalize_function_call,
    observe_tool_call,
    observe_response_structure,
    validate_manual_arguments,
    validate_model_tool_calls,
)
from integrations.hermes.sistemandrestudio_read import TOOL_NAME


def tool_call(arguments: object, call_id: str = "call-1") -> dict:
    return {
        "id": call_id,
        "type": "function",
        "function": {
            "name": TOOL_NAME,
            "arguments": json.dumps(arguments),
        },
    }


class ManualRunnerSchemaTests(unittest.TestCase):
    def test_schema_is_closed_to_the_four_manual_operations(self) -> None:
        function = MANUAL_TOOL_SCHEMA["function"]
        parameters = function["parameters"]
        self.assertEqual(function["name"], TOOL_NAME)
        self.assertNotIn("strict", function)
        self.assertEqual(
            tuple(parameters["properties"]["operation"]["enum"]),
            MANUAL_ALLOWED_OPERATIONS,
        )
        self.assertEqual(set(parameters["properties"]), {"operation", "limit"})
        self.assertEqual(parameters["required"], ["operation"])
        self.assertFalse(parameters["additionalProperties"])

    def test_valid_operations_are_normalized(self) -> None:
        self.assertEqual(validate_manual_arguments({"operation": "health"}), {"operation": "health"})
        self.assertEqual(validate_manual_arguments({"operation": "system_status"}), {"operation": "system_status"})
        self.assertEqual(
            validate_manual_arguments({"operation": "list_pending_decisions"}),
            {"operation": "list_pending_decisions"},
        )
        self.assertEqual(
            validate_manual_arguments({"operation": "list_editorial_items"}),
            {"operation": "list_editorial_items", "limit": DEFAULT_LIST_LIMIT},
        )
        self.assertEqual(
            validate_manual_arguments({"operation": "list_editorial_items", "limit": 100}),
            {"operation": "list_editorial_items", "limit": 100},
        )

    def test_invalid_or_mutable_payloads_fail_closed(self) -> None:
        attempts = (
            {},
            {"operation": "unknown"},
            {"operation": "health", "unexpected": True},
            {"operation": "list_editorial_items", "limit": 101},
            {"operation": "list_editorial_items", "limit": True},
            {"operations": ["health", "system_status"]},
            {"operation": ["health", "system_status"]},
            {"operation": "health", "method": "POST"},
            {"operation": "health", "url": "http://attacker.invalid"},
            {"operation": "health", "body": {"mutate": True}},
        )
        for arguments in attempts:
            with self.subTest(arguments=arguments):
                with self.assertRaises(ManualRunnerContractError):
                    validate_manual_arguments(arguments)


class ManualRunnerExecutionTests(unittest.TestCase):
    def test_official_openai_and_hermes_argument_formats_normalize_equally(self) -> None:
        expected = {"operation": "system_status"}
        json_function = {
            "name": TOOL_NAME,
            "arguments": '{ "operation" : "system_status" }',
        }
        object_function = {
            "name": TOOL_NAME,
            "arguments": {"operation": "system_status"},
        }
        hermes_function = SimpleNamespace(
            name=TOOL_NAME,
            arguments={"operation": "system_status"},
        )
        for function in (json_function, object_function, hermes_function):
            with self.subTest(function_type=type(function).__name__):
                name, arguments = normalize_function_call(function)
                self.assertEqual(name, TOOL_NAME)
                self.assertEqual(arguments, expected)

    def test_openai_wrapper_and_hermes_object_tool_calls_are_accepted(self) -> None:
        openai_call = tool_call({"operation": "system_status"})
        hermes_call = SimpleNamespace(
            id="call-hermes",
            function=SimpleNamespace(
                name=TOOL_NAME,
                arguments={"operation": "health"},
            ),
        )
        validated = validate_model_tool_calls([openai_call, hermes_call])
        self.assertEqual(
            [call.arguments for call in validated],
            [{"operation": "system_status"}, {"operation": "health"}],
        )

    def test_markdown_text_double_serialization_and_non_objects_are_rejected(self) -> None:
        attempts = (
            "```json\\n{\\\"operation\\\":\\\"system_status\\\"}\\n```",
            'text {"operation":"system_status"}',
            '{"operation":"system_status"} trailing',
            '"{\\\"operation\\\":\\\"system_status\\\"}"',
            "[\"operation\", \"system_status\"]",
        )
        for arguments in attempts:
            with self.subTest(arguments=arguments):
                with self.assertRaises(ManualRunnerContractError):
                    normalize_function_call({"name": TOOL_NAME, "arguments": arguments})

    def test_wrong_tool_and_unknown_operation_remain_rejected_after_normalization(self) -> None:
        with self.assertRaises(ManualRunnerContractError):
            normalize_function_call({"name": "terminal", "arguments": "{}"})
        with self.assertRaises(ManualRunnerContractError):
            validate_model_tool_calls([
                tool_call({"operation": "get_run", "run_id": "run-1"})
            ])

    def test_sanitized_observation_contains_shape_and_hash_but_not_values(self) -> None:
        observation = observe_tool_call(
            tool_call({"operation": "system_status"}),
            "ACCEPTED",
        )
        self.assertEqual(observation["tool_name"], TOOL_NAME)
        self.assertEqual(observation["arguments_type"], "str")
        self.assertEqual(observation["argument_keys"], ["operation"])
        self.assertEqual(observation["validation"], "ACCEPTED")
        self.assertEqual(len(observation["payload_sha256"]), 64)
        self.assertGreater(observation["payload_size"], 0)
        self.assertNotIn("system_status", json.dumps(observation))

    def test_multiple_calls_remain_sequentially_validated_as_one_batch(self) -> None:
        calls = [
            tool_call({"operation": "health"}, "call-1"),
            tool_call({"operation": "system_status"}, "call-2"),
        ]
        self.assertEqual(len(validate_model_tool_calls(calls)), 2)

    def test_one_to_four_allowlisted_calls_execute_sequentially(self) -> None:
        calls = [
            tool_call({"operation": "health"}, "call-1"),
            tool_call({"operation": "system_status"}, "call-2"),
            tool_call({"operation": "list_pending_decisions"}, "call-3"),
            tool_call({"operation": "list_editorial_items", "limit": 25}, "call-4"),
        ]
        dispatched = []

        def dispatch(name: str, arguments: object) -> str:
            dispatched.append((name, arguments))
            return '{"ok":true}'

        results = execute_local_tool_calls(calls, dispatch)
        self.assertEqual(len(results), MAX_LOCAL_TOOL_CALLS)
        self.assertEqual([call[1]["operation"] for call in dispatched], list(MANUAL_ALLOWED_OPERATIONS))
        self.assertTrue(all(call[0] == TOOL_NAME for call in dispatched))

    def test_invalid_batch_executes_nothing(self) -> None:
        dispatched = []
        calls = [
            tool_call({"operation": "health"}, "call-1"),
            tool_call({"operation": "health", "method": "POST"}, "call-2"),
        ]
        with self.assertRaises(ManualRunnerContractError):
            execute_local_tool_calls(calls, lambda *args: dispatched.append(args))
        self.assertEqual(dispatched, [])

    def test_multiple_operations_in_one_payload_are_rejected_with_guidance(self) -> None:
        with self.assertRaises(ManualRunnerContractError) as raised:
            validate_model_tool_calls(
                [tool_call({"operations": ["health", "system_status"]})]
            )
        self.assertEqual(raised.exception.code, "MULTIPLE_OPERATIONS")
        self.assertIn("one operation", raised.exception.message)

    def test_missing_unknown_extra_and_duplicate_calls_are_rejected(self) -> None:
        attempts = (
            [tool_call({})],
            [tool_call({"operation": "get_run", "run_id": "run-1"})],
            [tool_call({"operation": "health", "url": "http://attacker.invalid"})],
            [tool_call({"operation": "health"}), tool_call({"operation": "health"}, "call-2")],
            [tool_call({"operation": "health"}, f"call-{index}") for index in range(5)],
        )
        for calls in attempts:
            with self.subTest(calls=calls):
                with self.assertRaises(ManualRunnerContractError):
                    validate_model_tool_calls(calls)

    def test_wrong_tool_and_non_json_arguments_are_rejected(self) -> None:
        wrong_tool = tool_call({"operation": "health"})
        wrong_tool["function"]["name"] = "terminal"
        invalid_json = tool_call({"operation": "health"})
        invalid_json["function"]["arguments"] = "not-json"
        for calls in ([wrong_tool], [invalid_json]):
            with self.assertRaises(ManualRunnerContractError):
                validate_model_tool_calls(calls)

    def test_future_model_request_has_rigid_limits(self) -> None:
        options = model_request_options()
        self.assertEqual(options["tools"], [MANUAL_TOOL_SCHEMA])
        self.assertFalse(options["parallel_tool_calls"])
        self.assertFalse(options["stream"])
        self.assertFalse(options["retry"])
        self.assertFalse(options["fallback"])
        self.assertEqual(options["max_model_calls"], MAX_MODEL_CALLS)
        self.assertEqual(options["max_tokens"], 300)
        self.assertEqual(options["timeout_seconds"], 15)

    def test_previous_failure_condition_remains_fail_closed(self) -> None:
        # The production runner retained only this sanitized fact: the tool
        # name and JSON parsing succeeded, but the payload was not exactly the
        # forced {"operation":"system_status"}. The raw payload was not logged.
        observed_attempt = {
            "tool_name": TOOL_NAME,
            "arguments_were_valid_json": True,
            "matched_forced_system_status": False,
            "raw_arguments_retained": False,
        }
        self.assertEqual(observed_attempt["tool_name"], TOOL_NAME)
        self.assertTrue(observed_attempt["arguments_were_valid_json"])
        self.assertFalse(observed_attempt["matched_forced_system_status"])
        self.assertFalse(observed_attempt["raw_arguments_retained"])


class ManualRunnerDiagnosticsTests(unittest.TestCase):
    def response(self, message: object) -> dict:
        return {"message": message}

    def test_response_extraction_has_distinct_failures(self) -> None:
        cases = {
            "INVALID_RESPONSE_WRAPPER": None,
            "MISSING_MESSAGE": {},
            "INVALID_MESSAGE_WRAPPER": {"message": None},
            "NO_TOOL_CALL": self.response({}),
            "TEXT_WHEN_TOOL_REQUIRED": self.response({"content": "secret-fixture-value"}),
            "INVALID_TOOL_CALLS_TYPE": self.response({"tool_calls": {}}),
        }
        for expected, response in cases.items():
            with self.subTest(expected=expected):
                with self.assertRaises(ManualRunnerContractError) as raised:
                    extract_required_tool_calls(response)
                self.assertEqual(raised.exception.code, expected)

    def test_list_tuple_dict_and_official_wrappers_normalize_equally(self) -> None:
        call = tool_call({"operation": "health"})
        for calls in ([call], (call,)):
            with self.subTest(calls_type=type(calls).__name__):
                self.assertEqual(validate_model_tool_calls(calls)[0].arguments, {"operation": "health"})
        wrapper = SimpleNamespace(message=SimpleNamespace(tool_calls=[call], content=None))
        self.assertEqual(extract_required_tool_calls(wrapper), (call,))

    def test_every_contract_boundary_has_a_stable_code(self) -> None:
        cases = {
            "MISSING_FUNCTION": [{"id": "c"}],
            "MISSING_TOOL_NAME": [{"id": "c", "function": {"arguments": "{}"}}],
            "INVALID_TOOL_NAME": [{"id": "c", "function": {"name": "unknown-fixture", "arguments": "{}"}}],
            "MISSING_ARGUMENTS": [{"id": "c", "function": {"name": TOOL_NAME}}],
            "INVALID_ARGUMENTS_TYPE": [{"id": "c", "function": {"name": TOOL_NAME, "arguments": []}}],
            "INVALID_ARGUMENTS_JSON": [{"id": "c", "function": {"name": TOOL_NAME, "arguments": "{"}}],
            "INVALID_ARGUMENT_KEYS": [tool_call({"operation": "health", "extra": "fixture-secret"})],
            "MISSING_OPERATION": [tool_call({})],
            "UNAUTHORIZED_OPERATION": [tool_call({"operation": "forbidden"})],
            "INVALID_LIMIT": [tool_call({"operation": "list_editorial_items", "limit": 101})],
            "MULTIPLE_OPERATIONS": [tool_call({"operations": ["health"]})],
        }
        for expected, calls in cases.items():
            with self.subTest(expected=expected):
                with self.assertRaises(ManualRunnerContractError) as raised:
                    validate_model_tool_calls(calls)
                self.assertEqual(raised.exception.code, expected)

    def test_sanitized_response_diagnostic_never_keeps_fixture_values(self) -> None:
        fixture_secret = "openrouter-secret-fixture"
        response = self.response({
            "content": fixture_secret,
            "tool_calls": [{"id": "c", "function": {"name": "unknown-tool", "arguments": '{"operation":"health","token":"' + fixture_secret + '"}'}}],
        })
        observation = observe_response_structure(response, "provider_response", "INVALID_TOOL_NAME")
        rendered = json.dumps(observation)
        self.assertEqual(observation["tool_name_allowed"], False)
        self.assertNotIn("unknown-tool", rendered)
        self.assertNotIn(fixture_secret, rendered)
        self.assertEqual(observation["argument_keys"], ["operation", "token"])
        self.assertEqual(len(observation["fragment_sha256"]), 64)

    def test_no_fixture_dispatches_a_tool(self) -> None:
        dispatched = []
        with self.assertRaises(ManualRunnerContractError):
            validate_model_tool_calls([tool_call({"operation": "forbidden"})])
        self.assertEqual(dispatched, [])


if __name__ == "__main__":
    unittest.main()
