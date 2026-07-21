"""Agent command bridge for the Renderline desktop plugin.

Routes are mounted below ``/api/plugins/renderline`` by Hermes.
"""

from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
import secrets
import stat
from collections import deque
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect, status as http_status
from fastapi.responses import JSONResponse

router = APIRouter()

_COMMAND_OPS = {
    "status", "set-target", "link", "capture", "inspect", "page-checks",
    "midjourney-probe", "midjourney-control", "higgsfield-control", "set-check",
    "score-candidate", "select-candidate", "import-qc",
}
_COMMAND_QUEUE: deque[dict[str, Any]] = deque(maxlen=200)
_RESULTS: dict[str, dict[str, Any]] = {}
_RESULT_IDS: deque[str] = deque(maxlen=200)
_LATEST_STATE: dict[str, Any] | None = None
_COMMAND_CLIENTS: set[WebSocket] = set()
_COMMAND_LOCK = asyncio.Lock()
_BILLABLE_LEDGER_LOCK = asyncio.Lock()
_BILLABLE_ACTIONS = {"upscale", "vary", "reroll", "pan", "zoom"}
_BILLABLE_LEDGER_FILE = "midjourney-billable-ledger.json"
_BILLABLE_LEDGER_LOCK_FILE = ".midjourney-billable-ledger.lock"
_BILLABLE_LEDGER_LIMIT = 256


class _BillableLedgerError(Exception):
    """Internal error whose public response must not expose local details."""


class LedgerUnavailableError(_BillableLedgerError):
    """The durable ledger cannot safely participate in a billable request."""


def _canonical_plugin_dir() -> Path:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME", "~/.hermes"))
    return home.expanduser().resolve(strict=False) / "plugins" / "renderline"


def _safe_ledger_file(plugin_dir: Path) -> Path:
    try:
        plugin_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory_info = plugin_dir.lstat()
    except OSError as exc:
        raise _BillableLedgerError() from exc
    if stat.S_ISLNK(directory_info.st_mode) or not stat.S_ISDIR(directory_info.st_mode):
        raise _BillableLedgerError()
    # Resolve after rejecting the configured plugin directory itself; its canonical target must also be a directory.
    canonical = Path(os.path.realpath(os.fspath(plugin_dir)))
    try:
        canonical_info = canonical.lstat()
    except OSError as exc:
        raise _BillableLedgerError() from exc
    if stat.S_ISLNK(canonical_info.st_mode) or not stat.S_ISDIR(canonical_info.st_mode):
        raise _BillableLedgerError()
    return canonical / _BILLABLE_LEDGER_FILE


def _ledger_entry_valid(entry: dict[str, Any]) -> bool:
    fields = {
        "operationId", "action", "scope", "idempotencyKeyHash", "requestFingerprint",
        "targetFingerprint", "createdAt", "updatedAt", "status",
    }
    return (
        isinstance(entry, dict) and set(entry) == fields
        and all(isinstance(entry[key], str) for key in fields)
        and entry["action"] in {"submit", "higgsfield-generate", *_BILLABLE_ACTIONS}
        and entry["status"] in {"reserved", "acknowledged"}
        and all(len(entry[key]) == 64 for key in ("operationId", "idempotencyKeyHash", "requestFingerprint", "targetFingerprint"))
    )


def _v2_payload_valid(payload: dict[str, Any]) -> bool:
    if set(payload) != {"version", "entries", "receiptContexts", "contextSummaries"} or payload["version"] != 2:
        return False
    contexts, summaries = payload["receiptContexts"], payload["contextSummaries"]
    return (
        isinstance(payload["entries"], list) and all(_ledger_entry_valid(entry) for entry in payload["entries"])
        and isinstance(contexts, dict) and isinstance(summaries, dict)
        and all(isinstance(key, str) and len(key) == 64 and isinstance(value, dict)
                and set(value) == {"batchContextId", "expiresAt"}
                and isinstance(value["batchContextId"], str) and isinstance(value["expiresAt"], str)
                for key, value in contexts.items())
        and all(isinstance(key, str) and isinstance(value, dict)
                and set(value) == {"batchFingerprint", "consumedCount"}
                and isinstance(value["batchFingerprint"], str) and len(value["batchFingerprint"]) == 64
                and isinstance(value["consumedCount"], int) and 0 <= value["consumedCount"] <= 3
                for key, value in summaries.items())
    )


def _decode_v1_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if set(payload) != {"version", "entries"} or payload["version"] != 1 or not isinstance(payload["entries"], list):
        raise _BillableLedgerError()
    converted = {"version": 2, "entries": payload["entries"], "receiptContexts": {}, "contextSummaries": {}}
    if not _v2_payload_valid(converted):
        raise _BillableLedgerError()
    return converted


def _load_billable_ledger_payload() -> dict[str, Any]:
    ledger_path = _safe_ledger_file(_canonical_plugin_dir())
    try:
        info = ledger_path.lstat()
    except FileNotFoundError:
        return {"version": 2, "entries": [], "receiptContexts": {}, "contextSummaries": {}}
    except OSError as exc:
        raise _BillableLedgerError() from exc
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise _BillableLedgerError()
    try:
        fd = os.open(ledger_path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "r", encoding="utf-8") as source:
            raw = json.load(source)
    except (OSError, ValueError, TypeError) as exc:
        raise _BillableLedgerError() from exc
    if not isinstance(raw, dict):
        raise _BillableLedgerError()
    payload = _decode_v1_payload(raw) if raw.get("version") == 1 else raw
    if not _v2_payload_valid(payload):
        raise _BillableLedgerError()
    return payload


def _load_billable_ledger() -> tuple[Path, list[dict[str, Any]]]:
    return _safe_ledger_file(_canonical_plugin_dir()), _load_billable_ledger_payload()["entries"]


def _write_billable_ledger_payload(ledger_path: Path, payload: dict[str, Any]) -> None:
    if not _v2_payload_valid(payload):
        raise _BillableLedgerError()
    directory, temporary = ledger_path.parent, None
    try:
        try:
            info = ledger_path.lstat()
        except FileNotFoundError:
            pass
        else:
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
                raise _BillableLedgerError()
        encoded = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        temporary = directory / f".{_BILLABLE_LEDGER_FILE}.{secrets.token_hex(16)}.tmp"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
        with os.fdopen(fd, "wb") as destination:
            destination.write(encoded)
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temporary, ledger_path)
        temporary = None
        os.chmod(ledger_path, 0o600)
        directory_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except _BillableLedgerError:
        raise
    except OSError as exc:
        raise _BillableLedgerError() from exc
    finally:
        if temporary is not None:
            try:
                temporary.unlink()
            except OSError:
                pass




@contextmanager
def _ledger_transaction() -> Iterator[tuple[Path, dict[str, Any]]]:
    ledger_path = _safe_ledger_file(_canonical_plugin_dir())
    lock_path = ledger_path.parent / _BILLABLE_LEDGER_LOCK_FILE
    try:
        fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            os.close(fd)
            raise LedgerUnavailableError()
        fcntl.flock(fd, fcntl.LOCK_EX)
    except LedgerUnavailableError:
        raise
    except OSError as exc:
        raise LedgerUnavailableError() from exc
    try:
        yield ledger_path, _load_billable_ledger_payload()
    finally:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
        except OSError:
            pass
        os.close(fd)


def _hash_value(value: Any) -> str:
    encoded = json.dumps(value, separators=(",", ":"), sort_keys=True, ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _receipt_hash(receipt: str) -> str:
    return hashlib.sha256(receipt.encode("utf-8")).hexdigest()


_REDACTED_VALUE = "<redacted>"


def _sanitize_sensitive_urls(value: Any, depth: int = 0) -> Any:
    """Return a bounded copy with credential-like HTTP(S) query parameters removed."""
    if depth >= 12:
        return _REDACTED_VALUE
    if isinstance(value, str):
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in {"http", "https"} or not parsed.netloc:
            return value
        query = [(key, item) for key, item in parse_qsl(parsed.query, keep_blank_values=True)
                 if not any(marker in key.lower() for marker in ("token", "sig", "signature", "expires", "key", "auth"))]
        hostname = parsed.hostname or ""
        return urlunsplit((parsed.scheme, hostname, parsed.path, urlencode(query, doseq=True), ""))
    if isinstance(value, dict):
        return {
            _sanitize_sensitive_urls(key, depth + 1) if isinstance(key, str) else key:
            _sanitize_sensitive_urls(item, depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [_sanitize_sensitive_urls(item, depth + 1) for item in value]
    if isinstance(value, tuple):
        return tuple(_sanitize_sensitive_urls(item, depth + 1) for item in value)
    return value


def _billable_command(command: dict[str, Any]) -> tuple[str, str] | None:
    payload = command.get("payload")
    if not isinstance(payload, dict):
        return None
    if command.get("op") == "higgsfield-control" and payload.get("action") == "generate":
        scope = "higgsfield-generate"
        approved, key = payload.get("billableConfirmed"), payload.get("idempotencyKey")
    elif command.get("op") == "midjourney-control":
        action = payload.get("action")
        scope = action if action == "submit" else payload.get("name") if action == "action" else None
        if scope not in {"submit", *_BILLABLE_ACTIONS}:
            return None
        approved, key = payload.get("approved"), payload.get("idempotencyKey")
    else:
        return None
    if approved is not True or not isinstance(key, str) or not 8 <= len(key) <= 128 or any(ord(c) < 33 or ord(c) > 126 for c in key):
        raise HTTPException(status_code=400, detail="Billable command requires current approval and idempotency key")
    return str(scope), key


def _sanitized_scope(value: Any) -> str:
    if isinstance(value, str) and 0 < len(value) <= 64 and all(c.isascii() and (c.isalnum() or c in "._-") for c in value):
        return value
    return _hash_value(value)


def _billable_record(command: dict[str, Any], scope: str, idempotency_key: str) -> dict[str, Any]:
    payload = dict(command["payload"])
    payload["idempotencyKey"] = "<redacted>"
    if "validateReceipt" in payload:
        payload["validateReceipt"] = "<redacted>"
    request = {key: value for key, value in command.items() if key != "id"}
    request["payload"] = payload
    target = {key: value for key, value in {"panelId": command.get("panelId"), "targetId": command.get("targetId", payload.get("targetId")), "url": command.get("url", payload.get("url"))}.items() if isinstance(value, str)}
    now = datetime.now(timezone.utc).isoformat()
    return {"operationId": _hash_value(command["id"]), "action": scope, "scope": _sanitized_scope(command.get("panelId")), "idempotencyKeyHash": _hash_value(idempotency_key), "requestFingerprint": _hash_value(request), "targetFingerprint": _hash_value(target), "createdAt": now, "updatedAt": now, "status": "reserved"}


def _prune_terminal_entries(entries: list[dict[str, Any]]) -> None:
    while len(entries) >= _BILLABLE_LEDGER_LIMIT:
        terminal = next((index for index, entry in enumerate(entries) if entry["status"] != "reserved"), None)
        if terminal is None:
            raise _BillableLedgerError()
        entries.pop(terminal)


def _consume_submit_batch(payload: dict[str, Any], ledger: dict[str, Any]) -> None:
    receipt = payload.get("validateReceipt")
    fingerprint = payload.get("batchFingerprint")
    if not isinstance(receipt, str) or not receipt or not isinstance(fingerprint, str) or len(fingerprint) != 64:
        raise HTTPException(status_code=400, detail="Billable submit requires a valid batch identity")
    try:
        int(fingerprint, 16)
    except ValueError as exc:
        raise HTTPException(status_code=409, detail="Billable submit batch context is invalid") from exc
    context = ledger["receiptContexts"].get(_receipt_hash(receipt))
    if context is None:
        raise HTTPException(status_code=409, detail="Billable submit batch context is invalid")
    try:
        expired = datetime.fromisoformat(context["expiresAt"].replace("Z", "+00:00")) <= datetime.now(timezone.utc)
    except ValueError:
        expired = True
    summary = ledger["contextSummaries"].get(context["batchContextId"])
    if expired or summary is None or summary["batchFingerprint"] != fingerprint or summary["consumedCount"] >= 3:
        raise HTTPException(status_code=409, detail="Billable submit batch quota is unavailable")
    summary["consumedCount"] += 1

def _reserve_in_ledger(command: dict[str, Any], scope: str, idempotency_key: str, ledger: dict[str, Any]) -> tuple[dict[str, Any], bool]:
    candidate = _billable_record(command, scope, idempotency_key)
    for entry in ledger["entries"]:
        if entry["idempotencyKeyHash"] == candidate["idempotencyKeyHash"]:
            if entry["requestFingerprint"] != candidate["requestFingerprint"]:
                raise HTTPException(status_code=409, detail="Idempotency key is already reserved for a different billable command")
            return entry, True
    if scope == "submit":
        _consume_submit_batch(command["payload"], ledger)
    _prune_terminal_entries(ledger["entries"])
    ledger["entries"].append(candidate)
    return candidate, False


def _reserve_billable_command(command: dict[str, Any], scope: str, idempotency_key: str) -> tuple[dict[str, Any], bool]:
    with _ledger_transaction() as (ledger_path, ledger):
        reservation, existing = _reserve_in_ledger(command, scope, idempotency_key, ledger)
        if not existing:
            _write_billable_ledger_payload(ledger_path, ledger)
        return reservation, existing


def _acknowledge_in_ledger(result_id: str, ledger: dict[str, Any]) -> None:
    operation_id = _hash_value(result_id)
    for entry in ledger["entries"]:
        if entry["operationId"] == operation_id:
            entry["status"] = "acknowledged"
            entry["updatedAt"] = datetime.now(timezone.utc).isoformat()
            return


def _acknowledge_billable_result(result_id: str) -> None:
    with _ledger_transaction() as (ledger_path, ledger):
        _acknowledge_in_ledger(result_id, ledger)
        _write_billable_ledger_payload(ledger_path, ledger)


def _host_auth_supported() -> bool:
    try:
        from hermes_cli import __version__
        from hermes_cli import web_server as ws
        parts = tuple(int(part) for part in __version__.split(".")[:3])
    except Exception:
        return False
    # Capability-gated: no hard upper bound. Support any host at or above the floor
    # that still exposes a callable token-auth capability; genuinely missing capability
    # (or a below-floor host) fails closed so a breaking version bump is caught, not assumed.
    return parts >= (0, 18, 2) and callable(getattr(ws, "_ws_auth_ok", None))


def _ws_upgrade_authorized(ws: WebSocket) -> bool:
    if not _host_auth_supported():
        return False
    from hermes_cli import web_server as _ws
    return bool(_ws._ws_auth_ok(ws))


def _validate_acknowledged_link(command: dict[str, Any]) -> None:
    if command.get("op") != "midjourney-control":
        return
    payload = command.get("payload")
    if not isinstance(payload, dict) or payload.get("action") != "link":
        return
    operation_id = payload.get("operationId")
    if not isinstance(operation_id, str) or len(operation_id) != 64:
        raise HTTPException(status_code=400, detail="Result linkage requires an acknowledged operation")
    try:
        int(operation_id, 16)
        _path, entries = _load_billable_ledger()
    except (ValueError, _BillableLedgerError) as exc:
        raise HTTPException(status_code=503, detail="Billable command ledger is unavailable") from exc
    matched = next((entry for entry in entries if entry["operationId"] == operation_id and entry["action"] == "submit" and entry["status"] == "acknowledged"), None)
    if matched is None:
        raise HTTPException(status_code=409, detail="Result linkage operation is not an acknowledged submit")
    payload["acknowledged"] = True
    payload["ledgerCreatedAt"] = matched["createdAt"]

def _register_receipt_context(result: dict[str, Any], ledger: dict[str, Any]) -> None:
    context = result.get("receiptContext")
    if context is None:
        return
    if not isinstance(context, dict) or set(context) != {"receiptHash", "batchContextId", "expiresAt", "batchFingerprint"}:
        raise HTTPException(status_code=409, detail="Billable receipt context is invalid")
    receipt_hash = context["receiptHash"]
    batch_context_id = context["batchContextId"]
    expires_at = context["expiresAt"]
    fingerprint = context["batchFingerprint"]
    if not all(isinstance(value, str) for value in (receipt_hash, batch_context_id, expires_at, fingerprint)) or len(receipt_hash) != 64 or len(fingerprint) != 64:
        raise HTTPException(status_code=409, detail="Billable receipt context is invalid")
    try:
        if datetime.fromisoformat(expires_at.replace("Z", "+00:00")) <= datetime.now(timezone.utc):
            raise ValueError()
    except ValueError as exc:
        raise HTTPException(status_code=409, detail="Billable receipt context is invalid") from exc
    existing_context = ledger["receiptContexts"].get(receipt_hash)
    existing_summary = ledger["contextSummaries"].get(batch_context_id)
    if (existing_context is not None and existing_context != {"batchContextId": batch_context_id, "expiresAt": expires_at}) or (existing_summary is not None and existing_summary["batchFingerprint"] != fingerprint):
        raise HTTPException(status_code=409, detail="Billable receipt context is invalid")
    ledger["receiptContexts"][receipt_hash] = {"batchContextId": batch_context_id, "expiresAt": expires_at}
    ledger["contextSummaries"].setdefault(batch_context_id, {"batchFingerprint": fingerprint, "consumedCount": 0})

async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Request body must be JSON") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    return body


def _valid_higgsfield_command(command: dict[str, Any]) -> bool:
    payload = command.get("payload")
    if not isinstance(payload, dict) or command.get("op") != "higgsfield-control":
        return True
    action = payload.get("action")
    if action in {"capabilities", "state", "validate", "results", "observe", "qc"}:
        return set(payload) == {"action"}
    if action == "navigate":
        return set(payload) == {"action", "url"} and isinstance(payload["url"], str) and payload["url"].startswith("https://")
    if action == "draft":
        return (
            set(payload) == {"action", "prompt", "aspect", "model"}
            and isinstance(payload["prompt"], str) and bool(payload["prompt"].strip())
            and payload["aspect"] in {"1:1", "16:9", "9:16"}
            and payload["model"] in {"Seedream 5.0 Lite", "Nano Banana 2", "Seedream 4.5"}
        )
    if action == "link":
        return (
            set(payload) == {"action", "observationReceipt"}
            and isinstance(payload["observationReceipt"], str)
            and bool(payload["observationReceipt"])
            and len(payload["observationReceipt"]) <= 80
        )
    if action == "repair":
        return set(payload) == {"action", "approved"} and payload["approved"] is True
    if action == "generate":
        fingerprint = payload.get("batchFingerprint")
        return (
            set(payload) == {"action", "billableConfirmed", "idempotencyKey", "validateReceipt", "batchFingerprint"}
            and payload["billableConfirmed"] is True
            and isinstance(payload["idempotencyKey"], str) and 8 <= len(payload["idempotencyKey"]) <= 128
            and isinstance(payload["validateReceipt"], str) and bool(payload["validateReceipt"])
            and isinstance(fingerprint, str) and len(fingerprint) == 64
            and all(char in "0123456789abcdef" for char in fingerprint.lower())
        )
    return False


def _validate_command(command: dict[str, Any]) -> None:
    command_id = command.get("id")
    if not isinstance(command_id, str) or not command_id or len(command_id) > 64:
        raise HTTPException(status_code=400, detail="Command id must be a non-empty string of at most 64 characters")
    if command.get("op") not in _COMMAND_OPS:
        raise HTTPException(status_code=400, detail="Command op is not supported")
    if command.get("op") == "set-target":
        payload = command.get("payload")
        if not isinstance(payload, dict) or not set(payload).issubset({"url", "preset", "width", "height"}) or "url" not in payload:
            raise HTTPException(status_code=400, detail="Set-target command must use the typed target contract")
        if not isinstance(payload["url"], str) or not payload["url"]:
            raise HTTPException(status_code=400, detail="Set-target URL must be a non-empty string")
        if "preset" in payload and not isinstance(payload["preset"], str):
            raise HTTPException(status_code=400, detail="Set-target preset must be a string")
        for dimension in ("width", "height"):
            if dimension in payload and (not isinstance(payload[dimension], int) or isinstance(payload[dimension], bool) or payload[dimension] < 240):
                raise HTTPException(status_code=400, detail=f"Set-target {dimension} must be an integer of at least 240")
    if not _valid_higgsfield_command(command):
        raise HTTPException(status_code=400, detail="Higgsfield command must use the typed lifecycle contract")


async def _broadcast_command(command: dict[str, Any]) -> int:
    delivered = 0
    stale: list[WebSocket] = []
    for client in list(_COMMAND_CLIENTS):
        try:
            await client.send_json(command)
            delivered += 1
        except Exception:
            stale.append(client)
    for client in stale:
        _COMMAND_CLIENTS.discard(client)
    return delivered


@router.post("/command", status_code=202)
async def post_command(request: Request):
    command = await _json_body(request)
    _validate_command(command)
    _validate_acknowledged_link(command)
    billable = _billable_command(command)
    reservation = None
    if billable is not None:
        if not _host_auth_supported():
            raise HTTPException(status_code=503, detail="Billable command host authentication is unavailable")
        scope, idempotency_key = billable
        async with _BILLABLE_LEDGER_LOCK:
            try:
                reservation, existing = _reserve_billable_command(command, scope, idempotency_key)
            except _BillableLedgerError as exc:
                raise HTTPException(status_code=503, detail="Billable command ledger is unavailable") from exc
        if existing:
            return {"queued": False, "existing": True, "id": command["id"], "operationId": reservation["operationId"], "status": reservation["status"]}
    async with _COMMAND_LOCK:
        if not await _broadcast_command(command):
            _COMMAND_QUEUE.append(command)
    return {
        "queued": True,
        "id": command["id"],
        **({"operationId": reservation["operationId"], "status": reservation["status"]} if reservation else {}),
    }


@router.websocket("/commands")
async def stream_commands(ws: WebSocket):
    if not _ws_upgrade_authorized(ws):
        await ws.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return

    await ws.accept()
    try:
        async with _COMMAND_LOCK:
            _COMMAND_CLIENTS.add(ws)
            while _COMMAND_QUEUE:
                command = _COMMAND_QUEUE[0]
                await ws.send_json(command)
                _COMMAND_QUEUE.popleft()
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _COMMAND_CLIENTS.discard(ws)


@router.post("/result")
async def post_result(request: Request):
    global _LATEST_STATE

    result = await _json_body(request)
    result_id = result.get("id")
    if not isinstance(result_id, str) or not result_id or len(result_id) > 64:
        raise HTTPException(status_code=400, detail="Result id must be a non-empty string of at most 64 characters")

    if not _host_auth_supported():
        raise HTTPException(status_code=503, detail="Billable command host authentication is unavailable")
    async with _BILLABLE_LEDGER_LOCK:
        try:
            with _ledger_transaction() as (ledger_path, ledger):
                _register_receipt_context(result, ledger)
                _acknowledge_in_ledger(result_id, ledger)
                _write_billable_ledger_payload(ledger_path, ledger)
        except _BillableLedgerError as exc:
            raise HTTPException(status_code=503, detail="Billable command ledger is unavailable") from exc
    if result_id in _RESULTS:
        _RESULT_IDS.remove(result_id)
    elif len(_RESULT_IDS) == _RESULT_IDS.maxlen:
        _RESULTS.pop(_RESULT_IDS.popleft(), None)
    _RESULT_IDS.append(result_id)
    sanitized_result = _sanitize_sensitive_urls(result)
    _RESULTS[result_id] = sanitized_result
    state = sanitized_result.get("state")
    if isinstance(state, dict):
        _LATEST_STATE = state
    return {"stored": True, "id": result_id}


@router.get("/result")
async def list_results(cursor: int = 0):
    """Return bounded result receipts after *cursor* for local CLI polling."""
    if cursor < 0:
        raise HTTPException(status_code=400, detail="Result cursor must be non-negative")
    ids = list(_RESULT_IDS)
    start = min(cursor, len(ids))
    return {
        "results": [_sanitize_sensitive_urls(_RESULTS[result_id]) for result_id in ids[start:]],
        "nextCursor": len(ids),
    }


@router.get("/control/result")
async def list_control_results(cursor: int = 0):
    """Token-authenticated local-control view of bounded result receipts."""
    return await list_results(cursor)


@router.get("/result/{command_id}")
async def get_result(command_id: str):
    result = _RESULTS.get(command_id)
    if result is None:
        return JSONResponse(status_code=202, content={"pending": True})
    return _sanitize_sensitive_urls(result)


@router.get("/state")
async def get_state():
    if _LATEST_STATE is None:
        return JSONResponse(status_code=404, content={"reported": False})
    return _sanitize_sensitive_urls(_LATEST_STATE)
