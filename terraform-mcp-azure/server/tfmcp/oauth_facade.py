"""OAuth facade so MCP clients (Copilot Studio "Dynamic discovery") can connect by pasting only the server URL.

Microsoft Entra ID has no Dynamic Client Registration endpoint, and Easy Auth answers 401 without a
``WWW-Authenticate`` challenge. This module makes the MCP front-end look like a small authorization server
*in front of* Entra, without ever issuing or seeing a token of its own design:

  /.well-known/oauth-protected-resource      RFC 9728: where is the authorization server
  /.well-known/oauth-authorization-server    RFC 8414 (and /.well-known/openid-configuration for compatibility)
  POST /register                             RFC 7591: always answers with the ONE pre-registered Entra connector app
  GET  /authorize                            validates, then redirects to Entra's authorize endpoint for our tenant
  POST /token                                thin proxy to Entra's token endpoint; adds the client secret server-side

Rules that make this safe to expose without authentication:
* every URL is built from the configured PUBLIC_BASE_URL - never from the request's Host header;
* redirect_uri must exactly match a configured allow-list (https, no wildcards) - no open redirect;
* the only client is our connector app; PKCE S256 and ``state`` are required; scopes are forced, never taken
  from the request; the ``resource`` parameter is dropped;
* /authorize redirects only to the fixed Entra host; /token posts only to the fixed Entra token URL;
* the client secret is never returned, logged or audited; codes and tokens are never logged;
* per-IP rate limits, small body limit, ``Cache-Control: no-store``.
Tokens are issued by Entra and validated by the MCP endpoint exactly as before (signature, audience, client
allow-list, scope, age). Getting a token still requires a real Entra sign-in by a user of the tenant."""
from __future__ import annotations

import threading
import time
from typing import Callable
from urllib.parse import parse_qsl, urlencode

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from .audit import AuditLog
from .config import Settings

MAX_BODY = 8192
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache", "X-Content-Type-Options": "nosniff"}
LIMITS = {"register": 10, "authorize": 60, "token": 30, "metadata": 120}     # per IP per minute
PASS_THROUGH = ("access_token", "token_type", "expires_in", "ext_expires_in", "refresh_token", "scope", "id_token",
                "error", "error_description", "error_codes", "error_uri")


def challenge_header(settings: Settings, had_token: bool) -> str:
    value = (f'Bearer resource_metadata="{settings.public_base_url}/.well-known/oauth-protected-resource", '
             f'scope="{settings.oauth_scope}"')
    return value + (', error="invalid_token"' if had_token else "")


class OAuthFacade:
    def __init__(self, settings: Settings, audit: AuditLog, post: Callable[[str, dict], tuple[int, dict]] | None = None,
                 clock: Callable[[], float] = time.time) -> None:
        self.s = settings
        self.audit = audit
        self.base = settings.public_base_url
        self.clock = clock
        self._post = post or self._http_post
        self._hits: dict[tuple[str, str], list[float]] = {}
        self._mu = threading.Lock()
        tenant = settings.tenant_id
        self.entra_authorize = f"{settings.entra_base_url}/{tenant}/oauth2/v2.0/authorize"     # fixed, not user-controlled
        self.entra_token = f"{settings.entra_base_url}/{tenant}/oauth2/v2.0/token"
        self.scope = f"{settings.oauth_scope} offline_access"

    # ------------------------------------------------------------------ helpers
    @staticmethod
    def _http_post(url: str, form: dict) -> tuple[int, dict]:
        import httpx

        r = httpx.post(url, data=form, timeout=10.0, follow_redirects=False)
        try:
            return r.status_code, r.json()
        except ValueError:
            return 502, {"error": "server_error", "error_description": "the identity provider returned an unreadable answer"}

    def _ip(self, request: Request) -> str:
        forwarded = request.headers.get("x-forwarded-for", "")
        return (forwarded.split(",")[0].strip() or (request.client.host if request.client else "?"))[:64]

    def _limited(self, request: Request, kind: str) -> bool:
        now, key = self.clock(), (kind, self._ip(request))
        with self._mu:
            recent = [t for t in self._hits.get(key, []) if now - t < 60]
            over = len(recent) >= LIMITS[kind]
            if not over:
                recent.append(now)
            self._hits[key] = recent
            if len(self._hits) > 5000:      # bound memory under a flood of distinct addresses
                self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] < 60}
        return over

    def _error(self, request: Request, kind: str, code: str, description: str, status: int = 400) -> JSONResponse:
        self.audit.emit({"type": "oauth_rejected", "endpoint": kind, "error": code, "detail": description[:200], "ip": self._ip(request)})
        return JSONResponse({"error": code, "error_description": description}, status_code=status, headers=NO_STORE)

    def _too_many(self, request: Request, kind: str) -> JSONResponse:
        self.audit.emit({"type": "oauth_rate_limited", "endpoint": kind, "ip": self._ip(request)})
        return JSONResponse({"error": "slow_down" if kind == "token" else "temporarily_unavailable",
                             "error_description": "too many requests, retry in a minute"}, status_code=429,
                            headers={**NO_STORE, "Retry-After": "60"})

    def _redirect_ok(self, uri) -> bool:
        return isinstance(uri, str) and uri in self.s.redirect_uris       # exact string match only

    # ------------------------------------------------------------------ metadata
    def protected_resource(self) -> dict:
        return {"resource": f"{self.base}/mcp", "authorization_servers": [self.base], "scopes_supported": [self.s.oauth_scope],
                "bearer_methods_supported": ["header"], "resource_name": "Azure Terraform MCP"}

    def authorization_server(self) -> dict:
        return {"issuer": self.base, "authorization_endpoint": f"{self.base}/authorize", "token_endpoint": f"{self.base}/token",
                "registration_endpoint": f"{self.base}/register", "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"], "code_challenge_methods_supported": ["S256"],
                "token_endpoint_auth_methods_supported": ["none"], "scopes_supported": [self.s.oauth_scope, "offline_access"],
                "response_modes_supported": ["query"], "subject_types_supported": ["public"],
                "id_token_signing_alg_values_supported": ["RS256"],
                "jwks_uri": f"{self.s.entra_base_url}/{self.s.tenant_id}/discovery/v2.0/keys"}

    async def h_prm(self, request: Request) -> Response:
        if self._limited(request, "metadata"):
            return self._too_many(request, "metadata")
        return JSONResponse(self.protected_resource(), headers={"Cache-Control": "public, max-age=300"})

    async def h_as(self, request: Request) -> Response:
        if self._limited(request, "metadata"):
            return self._too_many(request, "metadata")
        return JSONResponse(self.authorization_server(), headers={"Cache-Control": "public, max-age=300"})

    # ------------------------------------------------------------------ RFC 7591 registration
    async def h_register(self, request: Request) -> Response:
        if self._limited(request, "register"):
            return self._too_many(request, "register")
        if "application/json" not in request.headers.get("content-type", "").lower():
            return self._error(request, "register", "invalid_client_metadata", "Content-Type must be application/json", 415)
        raw = await request.body()
        if len(raw) > MAX_BODY:
            return self._error(request, "register", "invalid_client_metadata", "request too large", 413)
        try:
            import json
            meta = json.loads(raw)
            uris = meta["redirect_uris"]
            if not isinstance(meta, dict) or not isinstance(uris, list) or not uris:
                raise ValueError
        except (ValueError, KeyError, TypeError):
            return self._error(request, "register", "invalid_client_metadata", "a JSON object with redirect_uris is required")
        bad = [u for u in uris if not self._redirect_ok(u)]
        if bad:
            return self._error(request, "register", "invalid_redirect_uri",
                               "redirect_uris must be on this server's allow-list (ask the platform team to add it)")
        self.audit.emit({"type": "oauth_client_registered", "ip": self._ip(request), "client_name": str(meta.get("client_name", ""))[:80],
                         "redirect_uris": uris[:5]})
        # Not a new client: every registration receives the one pre-registered public client. No secret, ever.
        return JSONResponse({"client_id": self.s.connector_client_id, "client_id_issued_at": int(self.clock()),
                             "redirect_uris": uris, "token_endpoint_auth_method": "none",
                             "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"],
                             "scope": self.scope, "client_name": "Azure Terraform MCP connector"},
                            status_code=201, headers=NO_STORE)

    # ------------------------------------------------------------------ authorize
    async def h_authorize(self, request: Request) -> Response:
        if self._limited(request, "authorize"):
            return self._too_many(request, "authorize")
        q = request.query_params
        # client and redirect first: on any doubt answer here and never redirect anywhere
        if q.get("client_id") != self.s.connector_client_id:
            return self._error(request, "authorize", "invalid_client", "unknown client_id")
        if len(q.getlist("redirect_uri")) != 1 or not self._redirect_ok(q.get("redirect_uri")):
            return self._error(request, "authorize", "invalid_redirect_uri", "redirect_uri is not on the allow-list")
        if q.get("response_type") != "code":
            return self._error(request, "authorize", "unsupported_response_type", "only response_type=code is supported")
        challenge = q.get("code_challenge", "")
        if q.get("code_challenge_method") != "S256" or not (43 <= len(challenge) <= 128) or not all(c.isalnum() or c in "-._~" for c in challenge):
            return self._error(request, "authorize", "invalid_request", "PKCE is required: code_challenge with code_challenge_method=S256")
        state = q.get("state", "")
        if not state or len(state) > 2048:
            return self._error(request, "authorize", "invalid_request", "state is required")
        params = {"client_id": self.s.connector_client_id, "response_type": "code", "redirect_uri": q["redirect_uri"],
                  "response_mode": "query", "scope": self.scope,      # forced: requested scopes and 'resource' are ignored
                  "state": state, "code_challenge": challenge, "code_challenge_method": "S256"}
        if q.get("prompt") in ("login", "select_account", "consent", "none"):
            params["prompt"] = q["prompt"]
        if q.get("login_hint") and len(q["login_hint"]) <= 256:
            params["login_hint"] = q["login_hint"]
        return RedirectResponse(f"{self.entra_authorize}?{urlencode(params)}", status_code=302, headers=NO_STORE)

    # ------------------------------------------------------------------ token
    async def h_token(self, request: Request) -> Response:
        if self._limited(request, "token"):
            return self._too_many(request, "token")
        if "application/x-www-form-urlencoded" not in request.headers.get("content-type", "").lower():
            return self._error(request, "token", "invalid_request", "Content-Type must be application/x-www-form-urlencoded", 415)
        raw = await request.body()
        if len(raw) > MAX_BODY:
            return self._error(request, "token", "invalid_request", "request too large", 413)
        try:
            form = dict(parse_qsl(raw.decode("utf-8"), keep_blank_values=True, strict_parsing=bool(raw)))
        except (ValueError, UnicodeDecodeError):
            return self._error(request, "token", "invalid_request", "malformed form body")
        if form.get("client_id") != self.s.connector_client_id:
            return self._error(request, "token", "invalid_client", "unknown client_id", 401)
        grant = form.get("grant_type")
        out = {"client_id": self.s.connector_client_id, "client_secret": self.s.connector_client_secret, "grant_type": grant}
        if grant == "authorization_code":
            if not self._redirect_ok(form.get("redirect_uri")):
                return self._error(request, "token", "invalid_grant", "redirect_uri is not on the allow-list")
            if not form.get("code") or not form.get("code_verifier"):
                return self._error(request, "token", "invalid_request", "code and code_verifier are required")
            out.update(code=form["code"], redirect_uri=form["redirect_uri"], code_verifier=form["code_verifier"], scope=self.scope)
        elif grant == "refresh_token":
            if not form.get("refresh_token"):
                return self._error(request, "token", "invalid_request", "refresh_token is required")
            out.update(refresh_token=form["refresh_token"], scope=self.scope)       # scope cannot be widened
        else:
            return self._error(request, "token", "unsupported_grant_type", "only authorization_code and refresh_token")
        try:
            status, body = self._post(self.entra_token, out)       # fixed URL; 'resource' and client-supplied secrets are dropped
        except Exception as e:  # noqa: BLE001
            self.audit.emit({"type": "oauth_upstream_error", "error": type(e).__name__})
            return JSONResponse({"error": "temporarily_unavailable", "error_description": "the identity provider did not answer"},
                                status_code=503, headers=NO_STORE)
        body = body if isinstance(body, dict) else {}
        ok = status == 200 and "access_token" in body
        self.audit.emit({"type": "oauth_token", "grant": grant, "outcome": "ok" if ok else "refused", "ip": self._ip(request),
                         "error": None if ok else str(body.get("error", status))[:60]})
        if not ok and "error" not in body:
            body = {"error": "server_error", "error_description": "unexpected answer from the identity provider"}
        return JSONResponse({k: body[k] for k in PASS_THROUGH if k in body}, status_code=200 if ok else (status if 400 <= status < 500 else 400),
                            headers=NO_STORE)

    def app(self) -> Starlette:
        routes = [Route(p, self.h_prm) for p in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp")]
        routes += [Route(p, self.h_as) for p in ("/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp",
                                                  "/.well-known/openid-configuration", "/mcp/.well-known/openid-configuration")]
        routes += [Route("/register", self.h_register, methods=["POST"]), Route("/authorize", self.h_authorize, methods=["GET"]),
                   Route("/token", self.h_token, methods=["POST"])]
        return Starlette(routes=routes)


FACADE_PATHS = ("/.well-known/", "/register", "/authorize", "/token", "/mcp/.well-known/")
