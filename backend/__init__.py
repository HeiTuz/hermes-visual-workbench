"""Renderline local bearer-token provider for its bounded control API."""
from __future__ import annotations

import hmac
import os
import secrets
import stat
from pathlib import Path
from typing import Optional

from hermes_cli.dashboard_auth.base import (
    DashboardAuthProvider,
    LoginStart,
    Session,
    TokenPrincipal,
)

_PLUGIN_NAME = "renderline"
_TOKEN_FILE = "control.token"
_TOKEN_ROUTES = (
    "/api/plugins/renderline/command",
    "/api/plugins/renderline/control/result",
)


def _plugin_dir() -> Path:
    from hermes_constants import get_hermes_home

    return Path(get_hermes_home()) / "plugins" / _PLUGIN_NAME


def _read_or_create_token() -> str:
    directory = _plugin_dir()
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    token_path = directory / _TOKEN_FILE
    try:
        fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        info = token_path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
            raise RuntimeError(f"Renderline control token must be a regular file: {token_path}")
        if info.st_mode & 0o077:
            raise RuntimeError(f"Renderline control token permissions are too broad: {token_path}")
        token = token_path.read_text(encoding="utf-8").strip()
        if len(token) < 43:
            raise RuntimeError("Renderline control token is missing or too short")
        return token

    try:
        token = secrets.token_urlsafe(48)
        os.write(fd, f"{token}\n".encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    return token


class VisualWorkbenchTokenProvider(DashboardAuthProvider):
    name = "renderline-local"
    display_name = "Renderline local control"
    supports_token = True
    supports_session = False

    def __init__(self, token: str) -> None:
        if len(token) < 43:
            raise ValueError("Renderline control token must contain at least 256 bits")
        self._token = token

    def verify_token(self, *, token: str) -> Optional[TokenPrincipal]:
        if token and hmac.compare_digest(token.encode("utf-8"), self._token.encode("utf-8")):
            return TokenPrincipal(
                principal="renderline-local-control",
                provider=self.name,
                scopes=("renderline-control",),
            )
        return None

    def start_login(self, *, redirect_uri: str) -> LoginStart:
        raise NotImplementedError("Renderline local control has no interactive login flow")

    def complete_login(
        self, *, code: str, state: str, code_verifier: str, redirect_uri: str
    ) -> Session:
        raise NotImplementedError("Renderline local control has no interactive login flow")

    def verify_session(self, *, access_token: str) -> Optional[Session]:
        return None

    def refresh_session(self, *, refresh_token: str) -> Session:
        raise NotImplementedError("Renderline local control has no interactive login flow")

    def revoke_session(self, *, refresh_token: str) -> None:
        return None


def _host_auth_supported() -> bool:
    try:
        from hermes_cli import __version__
        from hermes_cli import web_server
        parts = tuple(int(part) for part in __version__.split(".")[:3])
    except Exception:
        return False
    # Capability-gated: no hard upper bound. Support any host at or above the floor
    # that still exposes a callable token-auth capability; a missing capability or a
    # below-floor host fails closed so a breaking version bump is caught, not assumed.
    return parts >= (0, 18, 2) and callable(getattr(web_server, "_ws_auth_ok", None))

def register(ctx) -> None:
    if not _host_auth_supported():
        return
    token = _read_or_create_token()
    ctx.register_dashboard_auth_provider(VisualWorkbenchTokenProvider(token))

    from hermes_cli.dashboard_auth.token_auth import register_token_route

    for path in _TOKEN_ROUTES:
        register_token_route(path)
