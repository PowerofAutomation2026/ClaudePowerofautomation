"""Who is calling? Per-request Entra identity for audit and the two-person rule.

Three modes (``AUTH_MODE``):

* ``jwt`` (default when deployed): the bearer token that Container Apps Easy Auth already
  accepted is validated AGAIN here (signature against the tenant's signing keys, audience,
  issuer, tenant, expiry). Identity comes from the validated token, so a forged
  ``X-MS-CLIENT-PRINCIPAL-*`` header cannot change who you are.
* ``easyauth``: trust the ``X-MS-CLIENT-PRINCIPAL*`` headers injected by Easy Auth.
* ``none``: local testing only. Everyone is "anonymous" and cannot approve anything.

The identity is published in a context variable by an ASGI middleware, so MCP tools (which run
in the request's task / worker thread) can read it with ``current_identity()``.
"""
from __future__ import annotations

import base64
import contextvars
import json
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping


class AuthError(Exception):
    pass


@dataclass(frozen=True)
class Identity:
    oid: str
    name: str
    groups: tuple[str, ...] = ()
    roles: tuple[str, ...] = ()
    authenticated: bool = True
    source: str = "jwt"
    app_id: str = ""
    scopes: tuple[str, ...] = ()
    issued_at: float = 0.0       # iat of the access token
    auth_time: float = 0.0       # when the user last signed in interactively (optional claim)
    amr: tuple[str, ...] = ()    # authentication methods (v1 tokens) / "acrs" auth contexts

    def has_role(self, *names: str) -> bool:
        mine = {r.lower() for r in self.roles}
        return any(n in mine for n in names)

    def with_roles(self, extra) -> "Identity":
        import dataclasses
        return dataclasses.replace(self, roles=tuple(sorted({r.lower() for r in self.roles} | set(extra))))

    def public(self) -> dict:
        return {"oid": self.oid, "name": self.name}

    @property
    def is_system(self) -> bool:
        return self.source == "system"


ANONYMOUS = Identity(oid="anonymous", name="anonymous", authenticated=False, source="none")


def system_identity(name: str) -> Identity:
    return Identity(oid=f"system:{name}", name=f"system:{name}", source="system")


_current: contextvars.ContextVar[Identity] = contextvars.ContextVar("tfmcp_identity", default=ANONYMOUS)


def current_identity() -> Identity:
    return _current.get()


def set_identity(identity: Identity):
    return _current.set(identity)


def reset_identity(token) -> None:
    _current.reset(token)


# ---------------------------------------------------------------------------------------------
def _b64json(value: str) -> Any:
    padded = value + "=" * (-len(value) % 4)
    return json.loads(base64.b64decode(padded.replace("-", "+").replace("_", "/")))


_OID_CLAIMS = ("http://schemas.microsoft.com/identity/claims/objectidentifier", "oid")
_NAME_CLAIMS = ("preferred_username", "upn", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
                "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name", "name", "unique_name", "email")


def identity_from_easyauth(headers: Mapping[str, str]) -> Identity:
    """Build an identity from Easy Auth headers (header names are case-insensitive: pass lowercase keys)."""
    oid = headers.get("x-ms-client-principal-id", "").strip()
    name = headers.get("x-ms-client-principal-name", "").strip()
    groups: list[str] = []
    roles: list[str] = []
    blob = headers.get("x-ms-client-principal", "")
    if blob:
        try:
            principal = _b64json(blob)
            for claim in principal.get("claims", []):
                typ, val = claim.get("typ", ""), claim.get("val", "")
                if typ in _OID_CLAIMS:
                    oid = val or oid
                elif typ in _NAME_CLAIMS and not name:
                    name = val
                elif typ == "groups":
                    groups.append(val)
                elif typ in ("roles", "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"):
                    roles.append(val)
        except (ValueError, AttributeError, TypeError) as e:
            raise AuthError("malformed X-MS-CLIENT-PRINCIPAL header") from e
    if not oid:
        raise AuthError("no Entra identity on the request (Easy Auth headers missing)")
    return Identity(oid=oid.lower(), name=name or oid, groups=tuple(groups), roles=tuple(roles), source="easyauth")


class JwtValidator:
    """Validates Entra ID access tokens (v1 and v2 issuers) for one tenant and a set of audiences."""

    def __init__(self, tenant_id: str, audiences: list[str], fetch_jwks: Callable[[], dict] | None = None,
                 clock: Callable[[], float] = time.time, jwks_ttl: float = 12 * 3600,
                 allowed_client_ids: list[str] | None = None, required_scope: str = "") -> None:
        self.tenant_id = tenant_id.lower()
        self.audiences = list(audiences)
        self.allowed_client_ids = {c.lower() for c in (allowed_client_ids or [])}
        self.required_scope = required_scope
        self.issuers = [f"https://login.microsoftonline.com/{self.tenant_id}/v2.0",
                        f"https://sts.windows.net/{self.tenant_id}/"]
        self._fetch = fetch_jwks or self._download_jwks
        self._clock = clock
        self._ttl = jwks_ttl
        self._keys: dict[str, Any] = {}
        self._loaded_at = 0.0
        self._last_refresh_attempt = 0.0
        self._lock = threading.Lock()

    def _download_jwks(self) -> dict:
        import httpx

        url = f"https://login.microsoftonline.com/{self.tenant_id}/discovery/v2.0/keys"
        r = httpx.get(url, timeout=10)
        r.raise_for_status()
        return r.json()

    def _key(self, kid: str):
        import jwt

        with self._lock:
            now = self._clock()
            stale = now - self._loaded_at > self._ttl
            # refresh on an unknown key id (key rollover), but at most once a minute
            if (kid not in self._keys or stale) and now - self._last_refresh_attempt > 60:
                self._last_refresh_attempt = now
                try:
                    jwks = self._fetch()
                    self._keys = {k["kid"]: jwt.PyJWK.from_dict(k).key for k in jwks.get("keys", [])
                                  if k.get("kty") == "RSA" and k.get("kid")}
                    self._loaded_at = now
                except Exception as e:  # keep the old keys if the refresh failed
                    if not self._keys:
                        raise AuthError(f"cannot load Entra signing keys: {e}") from e
            if kid not in self._keys:
                raise AuthError("token signed with an unknown key")
            return self._keys[kid]

    def validate(self, token: str) -> Identity:
        import jwt

        try:
            header = jwt.get_unverified_header(token)
            if header.get("alg") != "RS256":
                raise AuthError("unsupported token algorithm")
            claims = jwt.decode(token, self._key(header.get("kid", "")), algorithms=["RS256"],
                                audience=self.audiences, options={"require": ["exp", "iss", "aud"]}, leeway=120)
        except AuthError:
            raise
        except jwt.PyJWTError as e:
            raise AuthError(f"invalid token: {e}") from e
        if claims.get("iss") not in self.issuers:
            raise AuthError("token issuer is not this tenant")
        if str(claims.get("tid", "")).lower() != self.tenant_id:
            raise AuthError("token is from another tenant")
        oid = str(claims.get("oid") or claims.get("sub") or "").lower()
        if not oid:
            raise AuthError("token has no object id")
        name = next((str(claims[c]) for c in ("preferred_username", "upn", "unique_name", "email", "name") if claims.get(c)), "")
        app_id = str(claims.get("azp") or claims.get("appid") or "")
        if not name:  # app-only token (client credentials): no user
            name = f"app:{app_id or oid}"
        scopes = tuple(str(claims.get("scp") or "").split())
        # Only the expected client application (the Copilot Studio connector, or the approval page) may call.
        if self.allowed_client_ids and app_id.lower() not in self.allowed_client_ids:
            raise AuthError("token was issued to a client application that is not allowed here")
        # Delegated (user) tokens only: an app-only token has no scp claim.
        if self.required_scope and self.required_scope not in scopes:
            raise AuthError(f"token lacks the required scope '{self.required_scope}'")
        groups = tuple(claims.get("groups") or ())
        roles = tuple(str(r).lower() for r in (claims.get("roles") or ()))
        amr = tuple(claims.get("amr") or ()) + tuple(claims.get("acrs") or ())
        return Identity(oid=oid, name=name, groups=groups, roles=roles, source="jwt", app_id=app_id, scopes=scopes,
                        issued_at=float(claims.get("iat") or 0), auth_time=float(claims.get("auth_time") or 0), amr=amr)


@dataclass
class Authenticator:
    mode: str
    jwt_validator: JwtValidator | None = None
    exempt_paths: tuple[str, ...] = field(default=("/healthz",))

    def authenticate(self, headers: Mapping[str, str]) -> Identity:
        if self.mode == "none":
            return ANONYMOUS
        if self.mode == "easyauth":
            return identity_from_easyauth(headers)
        auth = headers.get("authorization", "")
        if not auth.lower().startswith("bearer "):
            raise AuthError("missing bearer token")
        assert self.jwt_validator is not None
        return self.jwt_validator.validate(auth[7:].strip())


class IdentityMiddleware:
    """Pure ASGI middleware: authenticate, publish the identity, or answer 401."""

    def __init__(self, app, authenticator: Authenticator, on_reject: Callable[[str, str], None] | None = None) -> None:
        self.app = app
        self.auth = authenticator
        self.on_reject = on_reject

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        path = scope.get("path", "")
        if path in self.auth.exempt_paths:
            body = b'{"status":"ok"}'
            await send({"type": "http.response.start", "status": 200,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
            await send({"type": "http.response.body", "body": body})
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        try:
            identity = self.auth.authenticate(headers)
        except AuthError as e:
            if self.on_reject:
                self.on_reject(path, str(e))
            body = json.dumps({"error": "unauthorized", "detail": str(e)}).encode()
            await send({"type": "http.response.start", "status": 401,
                        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
                                    (b"www-authenticate", b"Bearer")]})
            await send({"type": "http.response.body", "body": body})
            return
        token = set_identity(identity)
        try:
            await self.app(scope, receive, send)
        finally:
            reset_identity(token)
