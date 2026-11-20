import base64
import json
import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa

from tfmcp.identity import (ANONYMOUS, AuthError, Authenticator, IdentityMiddleware, JwtValidator, current_identity,
                            identity_from_easyauth, system_identity)

TENANT = "22222222-2222-2222-2222-222222222222"
AUD = "api://33333333-3333-3333-3333-333333333333"
OID = "AAAAAAAA-0000-0000-0000-000000000001"


def principal(claims):
    return base64.b64encode(json.dumps({"auth_typ": "aad", "claims": [{"typ": t, "val": v} for t, v in claims]}).encode()).decode()


def test_easyauth_headers():
    ident = identity_from_easyauth({"x-ms-client-principal-id": OID, "x-ms-client-principal-name": "alice@contoso.com",
                                    "x-ms-client-principal": principal([("groups", "g1"), ("groups", "g2"), ("roles", "Approver")])})
    assert ident.oid == OID.lower() and ident.name == "alice@contoso.com"
    assert ident.groups == ("g1", "g2") and ident.roles == ("Approver",) and ident.authenticated


def test_easyauth_oid_claim_wins_and_name_falls_back():
    ident = identity_from_easyauth({"x-ms-client-principal-id": "something-else",
                                    "x-ms-client-principal": principal([
                                        ("http://schemas.microsoft.com/identity/claims/objectidentifier", OID),
                                        ("preferred_username", "bob@contoso.com")])})
    assert ident.oid == OID.lower() and ident.name == "bob@contoso.com"


def test_easyauth_missing_or_malformed():
    with pytest.raises(AuthError):
        identity_from_easyauth({})
    with pytest.raises(AuthError):
        identity_from_easyauth({"x-ms-client-principal-id": OID, "x-ms-client-principal": "%%%not-base64%%%"})


@pytest.fixture(scope="module")
def keys():
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
    jwk.update(kid="k1", use="sig")
    return key, other, {"keys": [jwk]}


def token(key, kid="k1", **over):
    claims = {"aud": AUD, "iss": f"https://login.microsoftonline.com/{TENANT}/v2.0", "tid": TENANT, "oid": OID,
              "preferred_username": "alice@contoso.com", "exp": int(time.time()) + 600, "groups": ["g1"], "azp": "client-1"}
    claims.update(over)
    claims = {k: v for k, v in claims.items() if v is not None}
    return jwt.encode(claims, key, algorithm="RS256", headers={"kid": kid})


def test_jwt_valid_v2_and_v1(keys):
    key, _, jwks = keys
    v = JwtValidator(TENANT, [AUD, "33333333-3333-3333-3333-333333333333"], fetch_jwks=lambda: jwks)
    ident = v.validate(token(key))
    assert ident.oid == OID.lower() and ident.name == "alice@contoso.com" and ident.groups == ("g1",) and ident.source == "jwt"
    v1 = v.validate(token(key, iss=f"https://sts.windows.net/{TENANT}/", preferred_username=None, upn="alice@contoso.com",
                          aud="33333333-3333-3333-3333-333333333333"))
    assert v1.name == "alice@contoso.com"


def test_jwt_app_only_token_is_marked(keys):
    key, _, jwks = keys
    ident = JwtValidator(TENANT, [AUD], fetch_jwks=lambda: jwks).validate(token(key, preferred_username=None))
    assert ident.name == "app:client-1"


@pytest.mark.parametrize("over,why", [
    ({"aud": "api://someone-else"}, "invalid token"),
    ({"exp": int(time.time()) - 3600}, "invalid token"),
    ({"tid": "99999999-9999-9999-9999-999999999999"}, "another tenant"),
    ({"iss": "https://login.microsoftonline.com/99999999-9999-9999-9999-999999999999/v2.0"}, "issuer"),
    ({"oid": None, "sub": None}, "no object id"),
])
def test_jwt_rejections(keys, over, why):
    key, _, jwks = keys
    with pytest.raises(AuthError, match=why):
        JwtValidator(TENANT, [AUD], fetch_jwks=lambda: jwks).validate(token(key, **over))


def test_jwt_wrong_signature_unknown_kid_and_alg_none(keys):
    key, other, jwks = keys
    v = JwtValidator(TENANT, [AUD], fetch_jwks=lambda: jwks)
    with pytest.raises(AuthError):
        v.validate(token(other))                       # signed by a different key with a known kid
    with pytest.raises(AuthError, match="unknown key"):
        v.validate(token(key, kid="k9"))
    b64 = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()  # noqa: E731
    forged = b64({"alg": "none", "typ": "JWT"}) + "." + b64({"aud": AUD, "oid": OID, "tid": TENANT}) + "."
    with pytest.raises(AuthError):
        v.validate(forged)
    with pytest.raises(AuthError):
        v.validate("not-a-token")


def test_jwks_cached_refresh_rate_limited_and_survives_outage(keys):
    key, _, jwks = keys
    now = [1000.0]
    calls = []

    def fetch():
        calls.append(now[0])
        if len(calls) > 1:
            raise ConnectionError("down")
        return jwks
    v = JwtValidator(TENANT, [AUD], fetch_jwks=fetch, clock=lambda: now[0])
    v.validate(token(key))
    v.validate(token(key))
    assert len(calls) == 1
    with pytest.raises(AuthError):
        v.validate(token(key, kid="rolled"))           # within 60s: no refetch
    assert len(calls) == 1
    now[0] += 13 * 3600                                # cache stale, refresh fails -> old keys still work
    v.validate(token(key))
    assert len(calls) == 2


def test_authenticator_modes(keys):
    key, _, jwks = keys
    assert Authenticator("none").authenticate({}) is ANONYMOUS
    jwt_auth = Authenticator("jwt", JwtValidator(TENANT, [AUD], fetch_jwks=lambda: jwks))
    with pytest.raises(AuthError, match="missing bearer"):
        jwt_auth.authenticate({"x-ms-client-principal-id": OID})       # forged Easy Auth header is ignored in jwt mode
    assert jwt_auth.authenticate({"authorization": "Bearer " + token(key)}).oid == OID.lower()
    assert system_identity("ttl-reaper").is_system and not system_identity("x").name.startswith("app:")


@pytest.mark.anyio
async def test_middleware_publishes_identity_and_rejects():
    seen = {}

    async def app(scope, receive, send):
        seen["identity"] = current_identity()
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})
    rejected = []
    mw = IdentityMiddleware(app, Authenticator("easyauth"), on_reject=lambda p, w: rejected.append((p, w)))
    sent = []

    async def send(msg):
        sent.append(msg)
    await mw({"type": "http", "path": "/mcp", "headers": [(b"X-MS-CLIENT-PRINCIPAL-ID", OID.encode()),
                                                           (b"x-ms-client-principal-name", b"alice@contoso.com")]}, None, send)
    assert seen["identity"].name == "alice@contoso.com" and sent[0]["status"] == 200
    assert current_identity() is ANONYMOUS             # reset after the request
    sent.clear()
    await mw({"type": "http", "path": "/mcp", "headers": []}, None, send)
    assert sent[0]["status"] == 401 and rejected and rejected[0][0] == "/mcp"
    sent.clear()
    await mw({"type": "http", "path": "/healthz", "headers": []}, None, send)
    assert sent[0]["status"] == 200


@pytest.fixture
def anyio_backend():
    return "asyncio"
