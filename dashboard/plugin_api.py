"""Thin Hermes adapter for the independent Renderline sidecar."""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import stat
import time
from pathlib import Path
from typing import Any

import httpx
import websockets
from fastapi import APIRouter, HTTPException, Request, WebSocket, status as http_status
from fastapi.responses import Response

router = APIRouter()
_SIDECAR_HTTP = os.environ.get("RENDERLINE_SIDECAR_HTTP", "http://127.0.0.1:47821").rstrip("/")
_SIDECAR_WS = os.environ.get("RENDERLINE_SIDECAR_WS", "ws://127.0.0.1:47821").rstrip("/")
_SELECTION_MAX_AGE = 120


def _relay_file(name: str) -> Path:
    return Path(os.environ.get("HERMES_HOME", "~/.hermes")).expanduser().resolve() / "plugins" / "renderline-telegram" / name


def _read_selection_request() -> dict[str, Any] | None:
    """Preserve the local relay guard seam while HTTP handling moves to the sidecar."""
    path = _relay_file("selection-request.json")
    try:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 4096:
            return None
        with path.open(encoding="utf-8") as source:
            value = json.load(source)
    except (OSError, ValueError, TypeError):
        return None
    if not isinstance(value, dict) or value.get("version") != 1 or value.get("candidate_id") not in {"A", "B", "C", "D"}:
        return None
    for field in ("request_id", "run_id", "scope"):
        if not isinstance(value.get(field), str) or not value[field] or len(value[field]) > 128:
            return None
    if not isinstance(value.get("revision"), int) or isinstance(value["revision"], bool) or not isinstance(value.get("created_at"), (int, float)):
        return None
    if time.time() - value["created_at"] > _SELECTION_MAX_AGE:
        return None
    return value


def _write_selection_ack(value: dict[str, Any]) -> None:
    """Keep legacy relay acknowledgements atomic and owner-only."""
    path = _relay_file("selection-ack.json")
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{secrets.token_hex(8)}.tmp")
    temporary.write_text(json.dumps(value, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)


def _renderline_home() -> Path:
    return Path(os.environ.get("RENDERLINE_HOME", "~/Library/Application Support/Renderline")).expanduser().resolve(strict=False)


def _token() -> str:
    path = _renderline_home() / "control.token"
    try:
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            return ""
        value = path.read_text(encoding="utf-8").strip()
        return value if len(value) >= 43 else ""
    except OSError:
        return ""


def _headers() -> dict[str, str]:
    token = _token()
    if not token:
        raise HTTPException(status_code=503, detail="Renderline sidecar token is unavailable")
    return {"Authorization": f"Bearer {token}"}


async def _proxy(method: str, path: str, request: Request | None = None) -> Response:
    body = await request.body() if request is not None else None
    params = request.query_params if request is not None else None
    headers = _headers()
    if request is not None and request.headers.get("content-type"):
        headers["Content-Type"] = request.headers["content-type"]
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.request(method, f"{_SIDECAR_HTTP}{path}", content=body, params=params, headers=headers)
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=503, detail="Renderline sidecar is unavailable") from exc
    return Response(content=response.content, status_code=response.status_code, media_type=response.headers.get("content-type", "application/json"))


@router.get("/health")
async def health():
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            response = await client.get(f"{_SIDECAR_HTTP}/health")
        return response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(status_code=503, detail="Renderline sidecar is unavailable") from exc


@router.post("/command")
async def post_command(request: Request): return await _proxy("POST", "/command", request)
@router.post("/result")
async def post_result(request: Request): return await _proxy("POST", "/result", request)
@router.get("/result")
async def list_results(request: Request): return await _proxy("GET", "/result", request)
@router.get("/control/result")
async def list_control_results(request: Request): return await _proxy("GET", "/control/result", request)
@router.get("/result/{command_id}")
async def get_result(command_id: str, request: Request): return await _proxy("GET", f"/result/{command_id}", request)
@router.get("/state")
async def get_state(request: Request): return await _proxy("GET", "/state", request)
@router.get("/selection-request")
async def get_selection_request(request: Request): return await _proxy("GET", "/selection-request", request)
@router.post("/selection-ack")
async def post_selection_ack(request: Request): return await _proxy("POST", "/selection-ack", request)


def _host_ws_authorized(ws: WebSocket) -> bool:
    try:
        from hermes_cli import web_server
        return bool(web_server._ws_auth_ok(ws))
    except Exception:
        return False


@router.websocket("/commands")
async def stream_commands(ws: WebSocket):
    if not _host_ws_authorized(ws):
        await ws.close(code=http_status.WS_1008_POLICY_VIOLATION)
        return
    token = _token()
    if not token:
        await ws.close(code=http_status.WS_1011_INTERNAL_ERROR)
        return
    await ws.accept()
    try:
        async with websockets.connect(f"{_SIDECAR_WS}/commands?token={token}", open_timeout=5, close_timeout=2) as upstream:
            async def upstream_to_client():
                async for message in upstream:
                    await ws.send_json(json.loads(message))
            async def client_keepalive():
                while True:
                    await ws.receive_text()
            tasks = {asyncio.create_task(upstream_to_client()), asyncio.create_task(client_keepalive())}
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                error = task.exception()
                if error is not None:
                    raise error
    except Exception:
        await ws.close(code=http_status.WS_1011_INTERNAL_ERROR)
