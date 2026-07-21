from __future__ import annotations

import asyncio
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "sidecar" / "app.py"
SPEC = importlib.util.spec_from_file_location("renderline_sidecar_websocket", MODULE_PATH)
assert SPEC and SPEC.loader
sidecar = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sidecar)


class Socket:
    def __init__(self, token=""):
        self.query_params = {"token": token}
        self.closed = []
        self.accepted = False
    async def close(self, code): self.closed.append(code)
    async def accept(self): self.accepted = True
    async def receive_text(self): raise sidecar.WebSocketDisconnect()


class WebsocketAuthTests(unittest.TestCase):
    def test_sidecar_token_controls_upgrade_without_hermes_imports(self):
        with tempfile.TemporaryDirectory() as root:
            previous = os.environ.get("RENDERLINE_HOME")
            os.environ["RENDERLINE_HOME"] = root
            try:
                denied = Socket("wrong")
                asyncio.run(sidecar.stream_commands(denied))
                self.assertEqual(denied.closed, [1008])
                self.assertFalse(denied.accepted)
                token = Path(root) / "control.token"
                token.write_text("t" * 43, encoding="utf-8")
                token.chmod(0o600)
                accepted = Socket("t" * 43)
                asyncio.run(sidecar.stream_commands(accepted))
                self.assertTrue(accepted.accepted)
            finally:
                if previous is None: os.environ.pop("RENDERLINE_HOME", None)
                else: os.environ["RENDERLINE_HOME"] = previous


if __name__ == "__main__":
    unittest.main()
