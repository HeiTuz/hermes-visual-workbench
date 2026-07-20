from __future__ import annotations

import importlib.util
import os
import stat
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from unittest.mock import patch


MODULE_PATH = Path(__file__).resolve().parents[1] / "dashboard" / "plugin_api.py"
SPEC = importlib.util.spec_from_file_location("visual_workbench_plugin_api_test", MODULE_PATH)
assert SPEC and SPEC.loader
plugin_api = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(plugin_api)


class BillableLedgerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.previous_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = self.temp.name
        self.receipt = "fixture-receipt"
        self.batch_fingerprint = "b" * 64
        ledger_path = plugin_api._safe_ledger_file(plugin_api._canonical_plugin_dir())
        plugin_api._write_billable_ledger_payload(ledger_path, {
            "version": 2,
            "entries": [],
            "receiptContexts": {plugin_api._receipt_hash(self.receipt): {
                "batchContextId": "fixture-batch", "expiresAt": "2999-01-01T00:00:00+00:00",
            }},
            "contextSummaries": {"fixture-batch": {
                "batchFingerprint": self.batch_fingerprint, "consumedCount": 0,
            }},
        })

    def tearDown(self) -> None:
        if self.previous_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self.previous_home
        self.temp.cleanup()

    @staticmethod
    def command(command_id: str, key: str = "fixture-key-1234", prompt: str = "fixture") -> dict:
        return {
            "id": command_id,
            "op": "midjourney-control",
            "panelId": "result",
            "payload": {
                "action": "submit",
                "approved": True,
                "idempotencyKey": key,
                "promptFingerprint": prompt,
                "validateReceipt": "fixture-receipt",
                "batchFingerprint": "b" * 64,
            },
        }
    def test_higgsfield_generate_is_durably_idempotent(self) -> None:
        command = {
            "id": "hf-generate-1",
            "op": "higgsfield-control",
            "panelId": "result",
            "payload": {
                "action": "generate",
                "billableConfirmed": True,
                "idempotencyKey": "hf-fixture-key-1234",
                "validateReceipt": "hfv-fixture",
                "batchFingerprint": "c" * 64,
            },
        }
        self.assertEqual(plugin_api._billable_command(command), ("higgsfield-generate", "hf-fixture-key-1234"))
        first, existing = plugin_api._reserve_billable_command(command, "higgsfield-generate", "hf-fixture-key-1234")
        self.assertFalse(existing)
        replay = {**command, "id": "hf-generate-2"}
        second, existing = plugin_api._reserve_billable_command(replay, "higgsfield-generate", "hf-fixture-key-1234")
        self.assertTrue(existing)
        self.assertEqual(second, first)
    def test_higgsfield_typed_command_rejects_caller_asserted_result_link(self) -> None:
        command = {
            "id": "hf-caller-link",
            "op": "higgsfield-control",
            "panelId": "result",
            "payload": {
                "action": "results",
                "providerJobId": "caller-job",
                "resultUrl": "https://cdn.higgsfield.ai/result.png?token=secret",
            },
        }
        self.assertFalse(plugin_api._valid_higgsfield_command(command))
    def test_higgsfield_observation_link_and_repair_use_typed_payloads(self) -> None:
        base = {"id": "hf-lifecycle", "op": "higgsfield-control", "panelId": "result"}
        self.assertTrue(plugin_api._valid_higgsfield_command({**base, "payload": {"action": "observe"}}))
        self.assertTrue(plugin_api._valid_higgsfield_command({
            **base, "payload": {"action": "link", "observationReceipt": "hfo-fixture"}
        }))
        self.assertTrue(plugin_api._valid_higgsfield_command({
            **base, "payload": {"action": "repair", "approved": True}
        }))
        self.assertFalse(plugin_api._valid_higgsfield_command({
            **base, "payload": {"action": "link", "observationReceipt": "hfo-fixture", "resultUrl": "https://evil.example/result"}
        }))
        self.assertFalse(plugin_api._valid_higgsfield_command({
            **base, "payload": {"action": "repair", "approved": False}
        }))
    def test_set_target_rejects_caller_provenance_at_backend_boundary(self) -> None:
        with self.assertRaises(HTTPException):
            plugin_api._validate_command({
                "id": "hf-set-target",
                "op": "set-target",
                "panelId": "result",
                "payload": {
                    "url": "https://example.com/result.png",
                    "providerEvidence": {"source": "higgsfield-web", "jobId": "caller"},
                },
            })
        plugin_api._validate_command({
            "id": "plain-set-target",
            "op": "set-target",
            "panelId": "result",
            "payload": {"url": "https://example.com/result.png", "width": 1024, "height": 1024},
        })

    def test_higgsfield_result_urls_are_redacted_before_storage(self) -> None:
        result = plugin_api._sanitize_sensitive_urls({
            "provenance": {"resultUrl": "https://cdn.higgsfield.ai/result.png?token=secret&width=1024"},
        })
        self.assertEqual(result["provenance"]["resultUrl"], "https://cdn.higgsfield.ai/result.png?width=1024")
        redacted = plugin_api._sanitize_sensitive_urls(
            "https://user:password@example.com/result.png?token=secret&width=1024#fragment-secret"
        )
        self.assertEqual(redacted, "https://example.com/result.png?width=1024")

    def test_reservation_survives_reload_and_never_rebroadcasts(self) -> None:
        first, existing = plugin_api._reserve_billable_command(self.command("submit-1"), "submit", "fixture-key-1234")
        self.assertFalse(existing)
        second, existing = plugin_api._reserve_billable_command(self.command("submit-2"), "submit", "fixture-key-1234")
        self.assertTrue(existing)
        self.assertEqual(second, first)
        ledger = Path(self.temp.name) / "plugins" / "visual-workbench" / plugin_api._BILLABLE_LEDGER_FILE
        self.assertEqual(stat.S_IMODE(ledger.stat().st_mode), 0o600)

    def test_same_key_with_changed_request_fails_closed(self) -> None:
        plugin_api._reserve_billable_command(self.command("submit-1"), "submit", "fixture-key-1234")
        with self.assertRaises(HTTPException) as caught:
            plugin_api._reserve_billable_command(
                self.command("submit-2", prompt="different"), "submit", "fixture-key-1234"
            )
        self.assertEqual(caught.exception.status_code, 409)

    def test_acknowledgement_is_durable(self) -> None:
        plugin_api._reserve_billable_command(self.command("submit-1"), "submit", "fixture-key-1234")
        plugin_api._acknowledge_billable_result("submit-1")
        _path, entries = plugin_api._load_billable_ledger()
        self.assertEqual(entries[0]["status"], "acknowledged")

    def test_result_link_attestation_comes_from_acknowledged_ledger(self) -> None:
        reservation, _existing = plugin_api._reserve_billable_command(
            self.command("submit-1"), "submit", "fixture-key-1234"
        )
        link = {
            "id": "link-1",
            "op": "midjourney-control",
            "panelId": "result",
            "payload": {
                "action": "link",
                "operationId": reservation["operationId"],
                "prompt": "fixture",
            },
        }
        with self.assertRaises(HTTPException) as caught:
            plugin_api._validate_acknowledged_link(link)
        self.assertEqual(caught.exception.status_code, 409)
        plugin_api._acknowledge_billable_result("submit-1")
        plugin_api._validate_acknowledged_link(link)
        self.assertIs(link["payload"]["acknowledged"], True)
        self.assertEqual(link["payload"]["ledgerCreatedAt"], reservation["createdAt"])

    def test_result_link_rejects_unknown_operation(self) -> None:
        link = {
            "op": "midjourney-control",
            "payload": {"action": "link", "operationId": "0" * 64, "prompt": "fixture"},
        }
        with self.assertRaises(HTTPException) as caught:
            plugin_api._validate_acknowledged_link(link)
        self.assertEqual(caught.exception.status_code, 409)

    def test_unsafe_mode_and_symlink_are_rejected(self) -> None:
        plugin_api._reserve_billable_command(self.command("submit-1"), "submit", "fixture-key-1234")
        ledger, _entries = plugin_api._load_billable_ledger()
        ledger.chmod(0o644)
        with self.assertRaises(plugin_api._BillableLedgerError):
            plugin_api._load_billable_ledger()
        ledger.unlink()
        target = ledger.with_suffix(".target")
        target.write_text('{"version":1,"entries":[]}', encoding="utf-8")
        ledger.symlink_to(target)
        with self.assertRaises(plugin_api._BillableLedgerError):
            plugin_api._load_billable_ledger()


    def test_v1_ledger_decodes_to_v2_shape(self) -> None:
        ledger_dir = Path(self.temp.name) / "plugins" / "visual-workbench"
        ledger_dir.mkdir(parents=True, exist_ok=True)
        entry = plugin_api._billable_record(self.command("submit-1"), "submit", "fixture-key-1234")
        (ledger_dir / plugin_api._BILLABLE_LEDGER_FILE).write_text(
            __import__("json").dumps({"version": 1, "entries": [entry]}), encoding="utf-8"
        )
        (ledger_dir / plugin_api._BILLABLE_LEDGER_FILE).chmod(0o600)
        _path, entries = plugin_api._load_billable_ledger()
        self.assertEqual(entries[0]["operationId"], entry["operationId"])
        self.assertEqual(entries[0]["status"], "reserved")
        self.assertEqual(plugin_api._load_billable_ledger_payload()["version"], 2)
    def test_v1_rejects_extra_or_snake_case_fields(self) -> None:
        entry = plugin_api._billable_record(self.command("submit-1"), "submit", "fixture-key-1234")
        entry["operation_id"] = entry.pop("operationId")
        with self.assertRaises(plugin_api._BillableLedgerError):
            plugin_api._decode_v1_payload({"version": 1, "entries": [entry]})

    def test_submit_batch_context_allows_three_distinct_reservations(self) -> None:
        receipt = "batch-receipt"
        receipt_hash = plugin_api._receipt_hash(receipt)
        ledger = {
            "version": 2, "entries": [],
            "receiptContexts": {receipt_hash: {"batchContextId": "batch", "expiresAt": "2999-01-01T00:00:00+00:00"}},
            "contextSummaries": {"batch": {"batchFingerprint": "b" * 64, "consumedCount": 0}},
        }
        for index in range(3):
            command = self.command(f"submit-{index}", f"fixture-key-{index:04d}")
            command["payload"]["validateReceipt"] = receipt
            plugin_api._reserve_in_ledger(command, "submit", command["payload"]["idempotencyKey"], ledger)
        fourth = self.command("submit-4", "fixture-key-0004")
        fourth["payload"]["validateReceipt"] = receipt
        with self.assertRaises(HTTPException) as caught:
            plugin_api._reserve_in_ledger(fourth, "submit", fourth["payload"]["idempotencyKey"], ledger)
        self.assertEqual(caught.exception.status_code, 409)
        self.assertEqual(ledger["contextSummaries"]["batch"]["consumedCount"], 3)
    def test_non_submit_billable_reservation_does_not_consume_submit_quota(self) -> None:
        command = self.command("upscale-1", "fixture-key-4567")
        command["payload"] = {
            "action": "action",
            "name": "upscale",
            "approved": True,
            "idempotencyKey": "fixture-key-4567",
        }
        _reservation, existing = plugin_api._reserve_billable_command(command, "upscale", "fixture-key-4567")
        self.assertFalse(existing)
        self.assertEqual(plugin_api._load_billable_ledger_payload()["contextSummaries"]["fixture-batch"]["consumedCount"], 0)

    def test_post_submit_quota_is_durable_and_requires_batch_identity(self) -> None:
        app = FastAPI()
        app.include_router(plugin_api.router)
        client = TestClient(app)
        with patch.object(plugin_api, "_host_auth_supported", return_value=True):
            statuses = [
                client.post("/command", json=self.command(f"submit-{index}", f"fixture-key-{index:04d}")).status_code
                for index in range(4)
            ]
            self.assertEqual(statuses, [202, 202, 202, 409])
            for command_id, key in (("alternate-job", "fixture-key-0005"), ("rotated-operation", "fixture-key-0006")):
                self.assertEqual(client.post("/command", json=self.command(command_id, key)).status_code, 409)
            self.assertEqual(client.post("/command", json={
                "id": "missing-batch", "op": "midjourney-control", "panelId": "result",
                "payload": {"action": "submit", "approved": True, "idempotencyKey": "fixture-key-0007"},
            }).status_code, 400)
        reloaded = plugin_api._load_billable_ledger_payload()
        self.assertEqual(reloaded["contextSummaries"]["fixture-batch"]["consumedCount"], 3)
if __name__ == "__main__":
    unittest.main()
