"""Agent command bridge for the Visual Workbench desktop plugin.

Routes are mounted below ``/api/plugins/visual-workbench`` by Hermes.
"""

from __future__ import annotations

import asyncio
from collections import deque
from typing import Any

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect, status as http_status
from fastapi.responses import JSONResponse

router = APIRouter()

_COMMAND_OPS = {
    "status",
    "set-target",
    "link",
    "capture",
    "inspect",
    "page-checks",
    "set-check",
    "score-candidate",
    "select-candidate",
    "import-qc",
}
_COMMAND_QUEUE: deque[dict[str, Any]] = deque(maxlen=200)
_RESULTS: dict[str, dict[str, Any]] = {}
_RESULT_IDS: deque[str] = deque(maxlen=200)
_LATEST_STATE: dict[str, Any] | None = None
_COMMAND_CLIENTS: set[WebSocket] = set()
_COMMAND_LOCK = asyncio.Lock()


def _ws_upgrade_authorized(ws: WebSocket) -> bool:
    """Delegate WebSocket authentication to Hermes' canonical auth gate."""
    try:
        from hermes_cli import web_server as _ws
    except Exception:
        return True
    return bool(_ws._ws_auth_ok(ws))


async def _json_body(request: Request) -> dict[str, Any]:
    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Request body must be JSON") from exc
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    return body


def _validate_command(command: dict[str, Any]) -> None:
    command_id = command.get("id")
    if not isinstance(command_id, str) or not command_id or len(command_id) > 64:
        raise HTTPException(status_code=400, detail="Command id must be a non-empty string of at most 64 characters")
    if command.get("op") not in _COMMAND_OPS:
        raise HTTPException(status_code=400, detail="Command op is not supported")


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
    async with _COMMAND_LOCK:
        if not await _broadcast_command(command):
            _COMMAND_QUEUE.append(command)
    return {"queued": True, "id": command["id"]}


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

    if result_id in _RESULTS:
        _RESULT_IDS.remove(result_id)
    elif len(_RESULT_IDS) == _RESULT_IDS.maxlen:
        _RESULTS.pop(_RESULT_IDS.popleft(), None)
    _RESULT_IDS.append(result_id)
    _RESULTS[result_id] = result
    state = result.get("state")
    if isinstance(state, dict):
        _LATEST_STATE = state
    return {"stored": True, "id": result_id}


@router.get("/result/{command_id}")
async def get_result(command_id: str):
    result = _RESULTS.get(command_id)
    if result is None:
        return JSONResponse(status_code=202, content={"pending": True})
    return result


@router.get("/state")
async def get_state():
    if _LATEST_STATE is None:
        return JSONResponse(status_code=404, content={"reported": False})
    return _LATEST_STATE
