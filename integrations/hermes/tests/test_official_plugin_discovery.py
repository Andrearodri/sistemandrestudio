from __future__ import annotations

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
PLUGIN_SOURCE = REPOSITORY_ROOT / "integrations" / "hermes"
PLUGIN_NAME = "sistemandrestudio-readonly"
TOOLSET_NAME = "sistemandrestudio_readonly"
TOOL_NAME = "sistemandrestudio_read"


class OfficialPluginDiscoveryTests(unittest.TestCase):
    """Exercise the installed Hermes PluginManager in a fresh process."""

    def test_official_registry_discovers_only_the_restricted_tool(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            hermes_home = Path(temporary_directory)
            plugin_directory = hermes_home / "plugins" / PLUGIN_NAME
            shutil.copytree(
                PLUGIN_SOURCE,
                plugin_directory,
                ignore=shutil.ignore_patterns("__pycache__", "tests"),
            )
            (hermes_home / "config.yaml").write_text(
                "plugins:\n  enabled:\n    - sistemandrestudio-readonly\n",
                encoding="utf-8",
            )

            environment = os.environ.copy()
            environment.update(
                {
                    "HERMES_HOME": str(hermes_home),
                    "EDITORIAL_READ_API_SECRET": "local-test-read-secret",
                    "HERMES_ENABLE_PROJECT_PLUGINS": "0",
                    "HERMES_BUNDLED_PLUGINS": str(hermes_home / "no-bundled-plugins"),
                }
            )
            probe = textwrap.dedent(
                """
                import json
                from importlib import metadata

                from hermes_cli.plugins import discover_plugins, get_plugin_manager
                from model_tools import get_tool_definitions
                from tools.registry import registry

                assert metadata.version("hermes-agent") == "0.19.0"
                discover_plugins()
                manager = get_plugin_manager()
                plugin = manager._plugins["sistemandrestudio-readonly"]
                assert plugin.enabled is True

                registered = registry.get_tool_names_for_toolset("sistemandrestudio_readonly")
                definitions = get_tool_definitions(
                    enabled_toolsets=["sistemandrestudio_readonly"],
                    disabled_toolsets=[],
                    quiet_mode=True,
                )
                visible = [definition["function"]["name"] for definition in definitions]
                assert registered == ["sistemandrestudio_read"], registered
                assert visible == ["sistemandrestudio_read"], visible
                print(json.dumps({"registered": registered, "visible": visible}))
                """
            )
            result = subprocess.run(
                [sys.executable, "-c", probe],
                check=False,
                capture_output=True,
                text=True,
                env=environment,
                cwd=REPOSITORY_ROOT,
                timeout=15,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(
            json.loads(result.stdout),
            {"registered": [TOOL_NAME], "visible": [TOOL_NAME]},
        )


if __name__ == "__main__":
    unittest.main()
