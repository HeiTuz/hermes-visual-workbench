from __future__ import annotations

import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient

MODULE_PATH = Path(__file__).resolve().parents[1] / "sidecar" / "app.py"


def load_sidecar():
    spec = importlib.util.spec_from_file_location("renderline_sidecar_compat", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


class SidecarCompatibilityTests(unittest.TestCase):
    def test_auth_capability_is_owned_by_sidecar_not_hermes_version(self):
        sidecar = load_sidecar()
        with tempfile.TemporaryDirectory() as root:
            previous = os.environ.get("RENDERLINE_HOME")
            os.environ["RENDERLINE_HOME"] = root
            try:
                self.assertFalse(sidecar._host_auth_supported())
                token = Path(root) / "control.token"
                token.write_text("t" * 43, encoding="utf-8")
                token.chmod(0o600)
                self.assertTrue(sidecar._host_auth_supported())
            finally:
                if previous is None: os.environ.pop("RENDERLINE_HOME", None)
                else: os.environ["RENDERLINE_HOME"] = previous

    def test_request_body_is_bounded_to_64_kib(self):
        sidecar = load_sidecar()
        with tempfile.TemporaryDirectory() as root:
            previous = os.environ.get("RENDERLINE_HOME")
            os.environ["RENDERLINE_HOME"] = root
            try:
                token = Path(root) / "control.token"
                token.write_text("t" * 43, encoding="utf-8")
                token.chmod(0o600)
                response = TestClient(sidecar.app).post(
                    "/command",
                    content=b'{"padding":"' + (b"x" * 65536) + b'"}',
                    headers={"Authorization": f"Bearer {token.read_text()}"},
                )
                self.assertEqual(response.status_code, 413)
            finally:
                if previous is None: os.environ.pop("RENDERLINE_HOME", None)
                else: os.environ["RENDERLINE_HOME"] = previous
    def test_selection_ack_accepts_and_persists_blocked_delivery(self):
        sidecar = load_sidecar()
        with tempfile.TemporaryDirectory() as root:
            previous_renderline_home = os.environ.get("RENDERLINE_HOME")
            previous_hermes_home = os.environ.get("HERMES_HOME")
            os.environ["RENDERLINE_HOME"] = root
            os.environ["HERMES_HOME"] = str(Path(root) / "hermes")
            try:
                token = Path(root) / "control.token"
                token.write_text("t" * 43, encoding="utf-8")
                token.chmod(0o600)
                body = {
                    "version": 1,
                    "request_id": "blocked-delivery-request",
                    "ok": False,
                    "error": "DELIVERY_BLOCKED",
                }
                client = TestClient(sidecar.app)
                response = client.post(
                    "/selection-ack",
                    json=body,
                    headers={"Authorization": f"Bearer {token.read_text()}"},
                )
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), {"stored": True, "request_id": body["request_id"]})
                ack_path = Path(os.environ["HERMES_HOME"]) / "plugins" / "renderline-telegram" / "selection-ack.json"
                self.assertEqual(json.loads(ack_path.read_text(encoding="utf-8")), body)

                invalid_response = client.post(
                    "/selection-ack",
                    json={**body, "state": "blocked"},
                    headers={"Authorization": f"Bearer {token.read_text()}"},
                )
                self.assertEqual(invalid_response.status_code, 400)
            finally:
                if previous_renderline_home is None: os.environ.pop("RENDERLINE_HOME", None)
                else: os.environ["RENDERLINE_HOME"] = previous_renderline_home
                if previous_hermes_home is None: os.environ.pop("HERMES_HOME", None)
                else: os.environ["HERMES_HOME"] = previous_hermes_home


if __name__ == "__main__":
    unittest.main()
