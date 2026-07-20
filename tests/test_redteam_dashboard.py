from __future__ import annotations

import asyncio
import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

MODULE_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"
SPEC = importlib.util.spec_from_file_location("visual_workbench_plugin_api_redteam", MODULE_PATH)
assert SPEC and SPEC.loader
plugin_api = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(plugin_api)


class Socket:
    def __init__(self):
        self.closed = []
        self.accepted = False

    async def close(self, code):
        self.closed.append(code)

    async def accept(self):
        self.accepted = True

    async def receive_text(self):
        raise plugin_api.WebSocketDisconnect()


def host_modules(version: str, auth):
    package = types.ModuleType("hermes_cli")
    package.__version__ = version
    web_server = types.ModuleType("hermes_cli.web_server")
    web_server._ws_auth_ok = auth
    package.web_server = web_server
    return {"hermes_cli": package, "hermes_cli.web_server": web_server}


class RedTeamDashboardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = self.temp.name
        plugin_api._COMMAND_QUEUE.clear()
        plugin_api._COMMAND_CLIENTS.clear()
        plugin_api._RESULTS.clear()
        plugin_api._RESULT_IDS.clear()
        plugin_api._LATEST_STATE = None

    def tearDown(self):
        if self.previous_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self.previous_home
        self.temp.cleanup()

    @staticmethod
    def command(command_id, key, receipt):
        return {"id": command_id, "op": "midjourney-control", "panelId": "result", "payload": {
            "action": "submit", "approved": True, "idempotencyKey": key,
            "promptFingerprint": "red-team", "validateReceipt": receipt, "batchFingerprint": "b" * 64,
        }}

    def test_post_command_submit_quota_is_durable_and_fail_closed(self):
        receipt = "red-team-receipt"
        batch_fingerprint = "b" * 64
        ledger_path = plugin_api._safe_ledger_file(plugin_api._canonical_plugin_dir())
        plugin_api._write_billable_ledger_payload(ledger_path, {
            "version": 2,
            "entries": [],
            "receiptContexts": {
                plugin_api._receipt_hash(receipt): {
                    "batchContextId": "red-team-batch",
                    "expiresAt": "2999-01-01T00:00:00+00:00",
                },
            },
            "contextSummaries": {
                "red-team-batch": {
                    "batchFingerprint": batch_fingerprint,
                    "consumedCount": 0,
                },
            },
        })
        app = FastAPI()
        app.include_router(plugin_api.router)
        client = TestClient(app)

        non_submit = {
            "id": "upscale-reservation",
            "op": "midjourney-control",
            "panelId": "result",
            "payload": {
                "action": "action",
                "name": "upscale",
                "approved": True,
                "idempotencyKey": "upscale-key",
            },
        }
        with patch.object(plugin_api, "_host_auth_supported", return_value=True):
            self.assertEqual(client.post("/command", json=non_submit).status_code, 202)
            self.assertEqual(
                plugin_api._load_billable_ledger_payload()["contextSummaries"]["red-team-batch"]["consumedCount"],
                0,
            )

            statuses = [
                client.post("/command", json=self.command(f"job-{index}", f"submit-key-{index}", receipt)).status_code
                for index in range(4)
            ]
            self.assertEqual(statuses, [202, 202, 202, 409])

            for command_id, key, operation_id in (
                ("alternate-job-id", "submit-key-four", "0" * 64),
                ("alternate-operation-id", "submit-key-five", "f" * 64),
            ):
                command = self.command(command_id, key, receipt)
                command["payload"]["operationId"] = operation_id
                self.assertEqual(client.post("/command", json=command).status_code, 409)

            reloaded = plugin_api._load_billable_ledger_payload()
            self.assertEqual(reloaded["contextSummaries"]["red-team-batch"]["consumedCount"], 3)
            self.assertEqual(
                client.post("/command", json=self.command("after-ledger-reload", "submit-key-six", receipt)).status_code,
                409,
            )

            missing_batch = self.command("missing-batch", "submit-key-seven", receipt)
            del missing_batch["payload"]["batchFingerprint"]
            self.assertEqual(client.post("/command", json=missing_batch).status_code, 400)

        entries = plugin_api._load_billable_ledger_payload()["entries"]
        self.assertEqual(len(entries), 4)
        self.assertEqual(entries[0]["action"], "upscale")
        self.assertEqual(
            plugin_api._load_billable_ledger_payload()["contextSummaries"]["red-team-batch"]["consumedCount"],
            3,
        )

    def test_ws_auth_fail_closed_before_accept_for_bad_host_conditions(self):
        cases = [
            ({}, "import failure"),
            (host_modules("0.18.1", lambda _: True), "below floor host"),
            (host_modules("0.18.2", None), "non-callable auth"),
            (host_modules("0.20.5", None), "future host missing capability"),
            (host_modules("0.18.2", lambda _: False), "wrong token"),
        ]
        for modules, label in cases:
            with self.subTest(label=label):
                socket = Socket()
                with patch.dict(sys.modules, modules, clear=not bool(modules)):
                    asyncio.run(plugin_api.stream_commands(socket))
                self.assertEqual(socket.closed, [1008])
                self.assertFalse(socket.accepted)
        for version in ("0.18.2", "0.19.0", "0.20.5"):
            with self.subTest(accepted=version):
                socket = Socket()
                with patch.dict(sys.modules, host_modules(version, lambda _: True), clear=False):
                    asyncio.run(plugin_api.stream_commands(socket))
                self.assertTrue(socket.accepted)
                self.assertEqual(socket.closed, [])

    def test_result_read_sinks_never_return_signed_query_secrets(self):
        raw = "https://cdn.example.test/image.png?token=raw-token&sig=raw-sig&signature=raw-signature&expires=raw-expires&key=raw-key&auth=raw-auth"
        result = {"id": "redteam-result", "url": raw, "state": {"url": raw, "nested": {"download": raw}}}
        plugin_api._RESULTS.clear()
        plugin_api._RESULT_IDS.clear()
        plugin_api._LATEST_STATE = None
        with patch.object(plugin_api, "_host_auth_supported", return_value=True):
            client = TestClient(plugin_api.router)
            self.assertEqual(client.post("/result", json=result).status_code, 200)
            for path in ("/result", "/control/result", "/state", "/result/redteam-result"):
                with self.subTest(path=path):
                    response = client.get(path)
                    self.assertEqual(response.status_code, 200)
                    body = response.text
                    for secret in ("raw-token", "raw-sig", "raw-signature", "raw-expires", "raw-key", "raw-auth"):
                        self.assertNotIn(secret, body, f"{path} leaked {secret}")
    def test_result_read_sinks_fail_closed_for_over_budget_values_and_url_keys(self):
        secrets = ("deep-token", "deep-sig", "key-token", "key-auth")
        signed_value = "https://cdn.example.test/deep.png?token=deep-token&sig=deep-sig"
        signed_key = "https://cdn.example.test/key.png?token=key-token&auth=key-auth"
        deep = signed_value
        for _ in range(13):
            deep = {"nested": deep}
        result = {
            "id": "redteam-over-budget",
            "state": {"deep": deep, signed_key: "present"},
        }
        with patch.object(plugin_api, "_host_auth_supported", return_value=True):
            client = TestClient(plugin_api.router)
            self.assertEqual(client.post("/result", json=result).status_code, 200)
            for path in ("/result", "/control/result", "/state", "/result/redteam-over-budget"):
                with self.subTest(path=path):
                    response = client.get(path)
                    self.assertEqual(response.status_code, 200)
                    for secret in secrets:
                        self.assertNotIn(secret, response.text, f"{path} leaked {secret}")
            self.assertIn("<redacted>", client.get("/state").text)


if __name__ == "__main__":
    unittest.main()
