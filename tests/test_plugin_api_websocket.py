from __future__ import annotations

import asyncio
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"
SPEC = importlib.util.spec_from_file_location("visual_workbench_plugin_api_websocket", MODULE_PATH)
plugin_api = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(plugin_api)


class Socket:
    def __init__(self):
        self.closed = []
        self.accepted = False
    async def close(self, code): self.closed.append(code)
    async def accept(self): self.accepted = True
    async def receive_text(self): raise plugin_api.WebSocketDisconnect()


def modules(token_ok):
    package = types.ModuleType("hermes_cli")
    package.__version__ = "0.18.2"
    web_server = types.ModuleType("hermes_cli.web_server")
    web_server._ws_auth_ok = token_ok
    package.web_server = web_server
    return {"hermes_cli": package, "hermes_cli.web_server": web_server}


class WebsocketAuthTests(unittest.TestCase):
    def test_unsupported_host_closes_before_accept(self):
        socket = Socket()
        with patch.dict(sys.modules, {}, clear=True):
            asyncio.run(plugin_api.stream_commands(socket))
        self.assertEqual(socket.closed, [1008])
        self.assertFalse(socket.accepted)

    def test_supported_host_calls_auth_only_during_upgrade(self):
        calls = []
        socket = Socket()
        with patch.dict(sys.modules, modules(lambda ws: calls.append(ws) or True), clear=False):
            self.assertTrue(plugin_api._host_auth_supported())
            self.assertEqual(calls, [])
            asyncio.run(plugin_api.stream_commands(socket))
        self.assertTrue(socket.accepted)
        self.assertEqual(calls, [socket])


if __name__ == "__main__":
    unittest.main()
