from __future__ import annotations

import json
import unittest

from integrations.hermes.manual_runner import (
    DEFAULT_LIST_LIMIT,
    MANUAL_ALLOWED_OPERATIONS,
    MANUAL_TOOL_SCHEMA,
    MAX_LOCAL_TOOL_CALLS,
    MAX_MODEL_CALLS,
    ManualRunnerContractError,
    execute_local_tool_calls,
    model_request_options,
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
        self.assertEqual(raised.exception.code, "MANUAL_MULTIPLE_OPERATIONS")
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


if __name__ == "__main__":
    unittest.main()
