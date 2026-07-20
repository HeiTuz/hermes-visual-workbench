from __future__ import annotations

import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"


def load_dashboard():
    spec = importlib.util.spec_from_file_location("visual_workbench_plugin_api_compat", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def host(version: str, helper):
    package = types.ModuleType("hermes_cli")
    package.__version__ = version
    web_server = types.ModuleType("hermes_cli.web_server")
    web_server._ws_auth_ok = helper
    package.web_server = web_server
    return {"hermes_cli": package, "hermes_cli.web_server": web_server}


class HostCompatibilityTests(unittest.TestCase):
    def test_capability_predicate_is_side_effect_free_and_fail_closed(self):
        dashboard = load_dashboard()
        calls = []
        supported = lambda ws: calls.append(ws) or True
        matrix = [
            ({}, False),
            (host("0.18.1", supported), False),
            (host("0.18.2", supported), True),
            (host("0.19.0", supported), True),
            (host("0.25.7", supported), True),
            (host("0.19.0", object()), False),
            (host("0.18.2", object()), False),
        ]
        for modules, expected in matrix:
            with patch.dict(sys.modules, modules, clear=False):
                self.assertEqual(dashboard._host_auth_supported(), expected)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
