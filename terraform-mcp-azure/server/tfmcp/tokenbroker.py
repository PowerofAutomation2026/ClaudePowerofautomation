"""Local managed-identity token broker.

Azure Container Apps (like App Service) exposes managed identity through ``IDENTITY_ENDPOINT`` +
``X-IDENTITY-HEADER``, not through the VM metadata address 169.254.169.254. The Terraform azurerm
backend (Terraform 1.9) and the azurerm provider only speak the VM metadata (IMDS) protocol, but both
accept a custom endpoint via ``ARM_MSI_ENDPOINT``.

This module serves the IMDS token protocol on 127.0.0.1 and answers with tokens obtained through
``azure-identity`` (which does support Container Apps). Terraform is then started with
``ARM_USE_MSI=true`` and ``ARM_MSI_ENDPOINT=http://127.0.0.1:<port>/metadata/identity/oauth2/token``.

It listens on loopback only and requires the ``Metadata: true`` header, exactly like IMDS. Any
process inside the container could already call IDENTITY_ENDPOINT, so this adds no new privilege.
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable
from urllib.parse import parse_qs, urlparse

TOKEN_PATH = "/metadata/identity/oauth2/token"


class TokenBroker:
    def __init__(self, get_token: Callable[[str], tuple[str, int]], host: str = "127.0.0.1", port: int = 0,
                 on_error: Callable[[str], None] | None = None) -> None:
        """``get_token(scope)`` returns ``(access_token, expires_on_epoch)``."""
        self._get_token = get_token
        self._on_error = on_error or (lambda msg: None)
        broker = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):  # keep tokens and noise out of the logs
                return

            def _reply(self, status: int, body: dict) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def _handle(self) -> None:
                url = urlparse(self.path)
                params = {k: v[0] for k, v in parse_qs(url.query).items()}
                length = int(self.headers.get("Content-Length") or 0)
                if length:
                    params.update({k: v[0] for k, v in parse_qs(self.rfile.read(length).decode()).items()})
                if url.path.rstrip("/") != TOKEN_PATH:
                    return self._reply(404, {"error": "not_found"})
                if str(self.headers.get("Metadata", "")).lower() != "true":
                    return self._reply(400, {"error": "invalid_request", "error_description": "Required metadata header not specified"})
                resource = params.get("resource", "")
                if not resource.startswith("https://"):
                    return self._reply(400, {"error": "invalid_resource", "error_description": "resource must be an https URI"})
                try:
                    token, expires_on = broker._get_token(resource.rstrip("/") + "/.default")
                except Exception as e:  # noqa: BLE001
                    broker._on_error(f"token request for {resource} failed: {e}")
                    return self._reply(500, {"error": "token_error", "error_description": str(e)[:300]})
                now = int(time.time())
                self._reply(200, {"access_token": token, "client_id": params.get("client_id", ""),
                                  "expires_in": str(max(0, int(expires_on) - now)), "expires_on": str(int(expires_on)),
                                  "ext_expires_in": str(max(0, int(expires_on) - now)), "not_before": str(now - 60),
                                  "resource": resource, "token_type": "Bearer"})

            do_GET = _handle
            do_POST = _handle

        self._server = ThreadingHTTPServer((host, port), Handler)
        self._server.daemon_threads = True
        self.url = f"http://{host}:{self._server.server_address[1]}{TOKEN_PATH}"

    def start(self) -> str:
        threading.Thread(target=self._server.serve_forever, name="token-broker", daemon=True).start()
        return self.url

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
