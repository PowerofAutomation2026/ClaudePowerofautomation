"""OAuth facade for "Dynamic discovery": an MCP client that knows only the server URL must be able to
discover, register, authorize and get a token - and nothing here may become an open redirect, a secret
leak, or a way around token validation."""
import base64
import hashlib
import io
import json
from urllib.parse import parse_qs, urlsplit

import pytest
from starlette.testclient import TestClient

import server
from conftest import ALICE, CONNECTOR, FakeTerraform, jwt_settings, mint, signing_key
from tfmcp.config import ConfigError
from tfmcp.storage import MemoryStore

BASE = "https://mcp.contoso.example"
REDIRECT = "https://global.consent.azure-apim.net/redirect"
SECRET = "s3cr3t~Connector.Value-0123456789"
SCOPE = "api://mcp-api/access_as_user"
HEAD = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
TENANT_URL = "https://login.microsoftonline.com/22222222-2222-2222-2222-222222222222/oauth2/v2.0"
DYN = dict(CONNECTOR_AUTH="dynamic", PUBLIC_BASE_URL=BASE, CONNECTOR_CLIENT_ID=CONNECTOR, CONNECTOR_CLIENT_SECRET=SECRET, OAUTH_SCOPE=SCOPE)


class Entra:
    """Stands in for Entra's token endpoint."""

    def __init__(self):
        self.calls, self.answer, self.down = [], None, False

    def __call__(self, url, form):
        if self.down:
            raise TimeoutError(f"timeout talking to idp with {form['client_secret']}")
        self.calls.append((url, dict(form)))
        if self.answer:
            return self.answer
        return 200, {"token_type": "Bearer", "expires_in": 3599, "access_token": mint(ALICE), "refresh_token": "rt-abc",
                     "scope": SCOPE, "client_secret": "must-not-pass", "foo": "bar"}


@pytest.fixture
def c():
    class C:
        pass
    x = C()
    x.settings = jwt_settings(TFMCP_ROLE="frontend", **DYN)
    x.rt = server.build(x.settings, data=MemoryStore(), state=MemoryStore(), audit_store=MemoryStore(), control=MemoryStore(),
                        tf=FakeTerraform(), price_fetch=lambda u, p: {"Items": []})
    x.log = io.StringIO()
    x.rt.audit.stream = x.log
    x.entra = Entra()
    with TestClient(server.create_app(x.rt, fetch_jwks=lambda: signing_key()[1], oauth_post=x.entra), follow_redirects=False) as client:
        x.http = client
        yield x


def pkce():
    verifier = "v" * 64
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()


def auth_params(**over):
    p = {"client_id": CONNECTOR, "redirect_uri": REDIRECT, "response_type": "code", "state": "st-123",
         "code_challenge": pkce()[1], "code_challenge_method": "S256"}
    p.update(over)
    return {k: v for k, v in p.items() if v is not None}


def token_form(**over):
    f = {"grant_type": "authorization_code", "client_id": CONNECTOR, "code": "code-xyz", "redirect_uri": REDIRECT, "code_verifier": pkce()[0]}
    f.update(over)
    return {k: v for k, v in f.items() if v is not None}


def test_full_discovery_flow_like_an_mcp_client(c):
    # 1. the client knows only the URL
    r = c.http.post("/mcp", headers=HEAD, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 401
    www = r.headers["www-authenticate"]
    assert www == f'Bearer resource_metadata="{BASE}/.well-known/oauth-protected-resource", scope="{SCOPE}"'
    # 2. protected-resource metadata -> authorization server
    prm = c.http.get("/.well-known/oauth-protected-resource").json()
    assert prm == c.http.get("/.well-known/oauth-protected-resource/mcp").json()
    assert prm["resource"] == f"{BASE}/mcp" and prm["authorization_servers"] == [BASE] and prm["bearer_methods_supported"] == ["header"]
    # 3. authorization-server metadata (both discovery styles + OIDC name)
    meta = c.http.get("/.well-known/oauth-authorization-server").json()
    assert meta == c.http.get("/.well-known/openid-configuration").json() == c.http.get("/.well-known/oauth-authorization-server/mcp").json()
    assert meta["issuer"] == BASE and meta["authorization_endpoint"] == f"{BASE}/authorize" and meta["token_endpoint"] == f"{BASE}/token"
    assert meta["registration_endpoint"] == f"{BASE}/register" and meta["code_challenge_methods_supported"] == ["S256"]
    assert meta["token_endpoint_auth_methods_supported"] == ["none"] and meta["response_types_supported"] == ["code"]
    assert meta["grant_types_supported"] == ["authorization_code", "refresh_token"]
    # 4. dynamic client registration
    reg = c.http.post("/register", json={"client_name": "Copilot Studio", "redirect_uris": [REDIRECT], "token_endpoint_auth_method": "client_secret_post"})
    assert reg.status_code == 201 and reg.headers["cache-control"] == "no-store"
    body = reg.json()
    assert body["client_id"] == CONNECTOR and body["token_endpoint_auth_method"] == "none" and body["redirect_uris"] == [REDIRECT]
    assert "client_secret" not in body and SECRET not in reg.text
    # 5. authorize -> redirect to Entra for OUR tenant with forced scope, PKCE and state; 'resource' dropped
    r = c.http.get("/authorize", params=auth_params(scope="https://graph.microsoft.com/.default openid", resource=f"{BASE}/mcp"))
    assert r.status_code == 302
    loc = urlsplit(r.headers["location"])
    q = {k: v[0] for k, v in parse_qs(loc.query).items()}
    assert f"{loc.scheme}://{loc.netloc}{loc.path}" == f"{TENANT_URL}/authorize"
    assert q == {"client_id": CONNECTOR, "response_type": "code", "redirect_uri": REDIRECT, "response_mode": "query",
                 "scope": f"{SCOPE} offline_access", "state": "st-123", "code_challenge": pkce()[1], "code_challenge_method": "S256"}
    # 6. token: proxied to the fixed Entra URL with the secret added server-side
    r = c.http.post("/token", data=token_form(resource=f"{BASE}/mcp", client_secret="client-supplied", scope="https://graph.microsoft.com/.default"))
    assert r.status_code == 200 and r.headers["cache-control"] == "no-store"
    tok = r.json()
    assert set(tok) == {"access_token", "token_type", "expires_in", "refresh_token", "scope"}       # unknown fields are not passed on
    url, sent = c.entra.calls[0]
    assert url == f"{TENANT_URL}/token"
    assert sent == {"client_id": CONNECTOR, "client_secret": SECRET, "grant_type": "authorization_code", "code": "code-xyz",
                    "redirect_uri": REDIRECT, "code_verifier": pkce()[0], "scope": f"{SCOPE} offline_access"}
    # 7. the token works on /mcp
    r = c.http.post("/mcp", headers={**HEAD, "Authorization": "Bearer " + tok["access_token"]}, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 200 and len(r.json()["result"]["tools"]) == 8
    # refresh
    r = c.http.post("/token", data={"grant_type": "refresh_token", "client_id": CONNECTOR, "refresh_token": "rt-abc", "scope": "anything"})
    assert r.status_code == 200 and c.entra.calls[1][1] == {"client_id": CONNECTOR, "client_secret": SECRET, "grant_type": "refresh_token",
                                                            "refresh_token": "rt-abc", "scope": f"{SCOPE} offline_access"}


def test_no_tool_is_reachable_without_a_valid_token(c):
    for headers in ({}, {"Authorization": "Bearer not-a-jwt"}, {"Authorization": "Bearer " + mint(ALICE, aud="api://other")},
                    {"Authorization": "Bearer " + mint(ALICE, azp="another-client")}, {"X-MS-CLIENT-PRINCIPAL-ID": ALICE.oid, "X-MS-CLIENT-PRINCIPAL-NAME": "alice"}):
        for method, params in (("tools/list", None), ("tools/call", {"name": "whoami", "arguments": {}}), ("initialize", {})):
            body = {"jsonrpc": "2.0", "id": 1, "method": method, **({"params": params} if params is not None else {})}
            r = c.http.post("/mcp", headers={**HEAD, **headers}, json=body)
            assert r.status_code == 401 and "resource_metadata=" in r.headers["www-authenticate"]
            assert ('error="invalid_token"' in r.headers["www-authenticate"]) == ("Authorization" in headers)
    assert c.http.get("/mcp").status_code == 401 and c.http.delete("/mcp").status_code == 401


@pytest.mark.parametrize("uri", ["https://evil.example/redirect", "https://global.consent.azure-apim.net/redirect/../evil",
                                 "https://global.consent.azure-apim.net/redirect?x=1", "https://global.consent.azure-apim.net/redirect#frag",
                                 "https://global.consent.azure-apim.net.evil.example/redirect", "http://global.consent.azure-apim.net/redirect",
                                 "https://GLOBAL.consent.azure-apim.net/redirect", "https://global.consent.azure-apim.net/redirect/",
                                 "javascript:alert(1)", "//evil.example", ""])
def test_redirect_uri_must_match_exactly_everywhere(c, uri):
    r = c.http.post("/register", json={"redirect_uris": [REDIRECT, uri]})
    assert r.status_code == 400 and r.json()["error"] == "invalid_redirect_uri"
    r = c.http.get("/authorize", params=auth_params(redirect_uri=uri))
    assert r.status_code == 400 and "location" not in r.headers            # never redirects to an unknown place
    r = c.http.post("/token", data=token_form(redirect_uri=uri))
    assert r.status_code == 400 and r.json()["error"] == "invalid_grant" and c.entra.calls == []


@pytest.mark.parametrize("over,error", [
    (dict(client_id="someone-else"), "invalid_client"),
    (dict(response_type="token"), "unsupported_response_type"),
    (dict(code_challenge=None), "invalid_request"),
    (dict(code_challenge_method="plain"), "invalid_request"),
    (dict(code_challenge_method=None), "invalid_request"),
    (dict(code_challenge="short"), "invalid_request"),
    (dict(state=None), "invalid_request"),
])
def test_authorize_rejects_bad_requests_without_redirecting(c, over, error):
    r = c.http.get("/authorize", params=auth_params(**over))
    assert r.status_code == 400 and r.json()["error"] == error and "location" not in r.headers


def test_authorize_never_redirects_anywhere_but_entra(c):
    two = c.http.get(f"/authorize?client_id={CONNECTOR}&redirect_uri={REDIRECT}&redirect_uri=https://evil.example&response_type=code"
                     f"&state=s&code_challenge={pkce()[1]}&code_challenge_method=S256")
    assert two.status_code == 400
    for extra in ({"authorization_endpoint": "https://evil.example"}, {"tenant": "common"}, {"domain_hint": "evil.example"},
                  {"client_secret": "x"}, {"response_mode": "form_post"}, {"prompt": "<script>"}, {"nonce": "n"}):
        r = c.http.get("/authorize", params={**auth_params(), **extra})
        assert r.status_code == 302 and r.headers["location"].startswith(f"{TENANT_URL}/authorize?")
        assert not set(extra) & set(parse_qs(urlsplit(r.headers["location"]).query)) - {"response_mode"}
        assert "evil.example" not in r.headers["location"] and "script" not in r.headers["location"]
    ok = c.http.get("/authorize", params={**auth_params(), "prompt": "login", "login_hint": "alice@contoso.com"})
    assert "prompt=login" in ok.headers["location"] and "login_hint=alice%40contoso.com" in ok.headers["location"]


def test_urls_come_from_configuration_not_from_the_host_header(c):
    spoof = {"Host": "evil.example", "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "http", "Forwarded": "host=evil.example"}
    texts = [c.http.get("/.well-known/oauth-protected-resource", headers=spoof).text,
             c.http.get("/.well-known/oauth-authorization-server", headers=spoof).text,
             c.http.post("/mcp", headers={**HEAD, **spoof}, json={}).headers["www-authenticate"],
             c.http.get("/authorize", params=auth_params(), headers=spoof).headers["location"]]
    assert all("evil.example" not in t for t in texts) and BASE in texts[0] and BASE in texts[2]


def test_token_endpoint_input_handling(c):
    assert c.http.post("/token", json=token_form()).status_code == 415                               # wrong content type
    assert c.http.post("/token", data=token_form(client_id="other")).json()["error"] == "invalid_client"
    assert c.http.post("/token", data=token_form(grant_type="client_credentials")).json()["error"] == "unsupported_grant_type"
    assert c.http.post("/token", data=token_form(grant_type="password", username="a", password="b")).json()["error"] == "unsupported_grant_type"
    assert c.http.post("/token", data=token_form(code_verifier=None)).json()["error"] == "invalid_request"
    assert c.http.post("/token", data=token_form(code=None)).json()["error"] == "invalid_request"
    assert c.http.post("/token", data={"grant_type": "refresh_token", "client_id": CONNECTOR}).json()["error"] == "invalid_request"
    big = c.http.post("/token", data=token_form(code="A" * 9000))
    assert big.status_code == 413 and c.entra.calls == []
    assert c.http.post("/register", content=b"x" * 9000, headers={"Content-Type": "application/json"}).status_code == 413
    assert c.http.post("/register", data={"redirect_uris": REDIRECT}).status_code == 415
    assert c.http.post("/register", json=["not", "an", "object"]).status_code == 400
    assert c.http.get("/token").status_code == 405 and c.http.get("/register").status_code == 405 and c.http.post("/authorize").status_code == 405


def test_entra_errors_and_outages_are_mapped_without_leaking(c):
    c.entra.answer = (400, {"error": "invalid_grant", "error_description": "AADSTS70008: The provided authorization code has expired.", "trace_id": "t", "correlation_id": "x"})
    r = c.http.post("/token", data=token_form())
    assert r.status_code == 400 and r.json() == {"error": "invalid_grant", "error_description": "AADSTS70008: The provided authorization code has expired."}
    c.entra.answer = (500, {"unexpected": True})
    assert c.http.post("/token", data=token_form()).json()["error"] == "server_error"
    c.entra.answer = (200, {"token_type": "Bearer"})                       # 200 without a token is not success
    assert c.http.post("/token", data=token_form()).status_code == 400
    c.entra.down = True
    r = c.http.post("/token", data=token_form())
    assert r.status_code == 503 and r.json()["error"] == "temporarily_unavailable" and SECRET not in r.text
    assert SECRET not in c.log.getvalue()


def test_secret_codes_and_tokens_never_appear_in_responses_logs_or_audit(c):
    responses = [c.http.get(p).text for p in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/.well-known/openid-configuration")]
    responses.append(c.http.post("/register", json={"redirect_uris": [REDIRECT]}).text)
    responses.append(c.http.get("/authorize", params=auth_params()).headers["location"])
    t = c.http.post("/token", data=token_form(code="super-secret-code", code_verifier="V" * 50))
    responses.append(t.text)
    responses.append(c.http.post("/token", data=token_form(client_id="x", code="super-secret-code")).text)
    c.entra.answer = (400, {"error": "invalid_client", "error_description": f"bad secret {SECRET}"})    # even if the IdP echoed it
    c.rt.audit.emit({"type": "x", "note": f"someone logged {SECRET}"})
    log = c.log.getvalue()
    blobs = "".join(v[0].decode() for v in c.rt.audit.store._data.values())
    for text in responses + [log, blobs]:
        assert SECRET not in text
    for text in (log, blobs):
        assert "super-secret-code" not in text and "rt-abc" not in text and t.json()["access_token"] not in text and "V" * 50 not in text
    events = [json.loads(line) for line in log.splitlines()]
    assert {"oauth_client_registered", "oauth_token", "oauth_rejected"} <= {e["type"] for e in events}
    assert "repr" not in repr(c.settings) or SECRET not in repr(c.settings)
    assert SECRET not in repr(c.settings)


def test_rate_limits_per_client_address(c):
    codes = [c.http.post("/register", json={"redirect_uris": [REDIRECT]}, headers={"X-Forwarded-For": "203.0.113.9"}).status_code for _ in range(12)]
    assert codes[:10] == [201] * 10 and codes[10:] == [429, 429]
    assert c.http.post("/register", json={"redirect_uris": [REDIRECT]}, headers={"X-Forwarded-For": "203.0.113.10"}).status_code == 201
    codes = [c.http.post("/token", data=token_form(), headers={"X-Forwarded-For": "203.0.113.9"}).status_code for _ in range(32)]
    assert codes.count(200) == 30 and codes[-1] == 429
    assert any(json.loads(line)["type"] == "oauth_rate_limited" for line in c.log.getvalue().splitlines())


def test_manual_mode_exposes_none_of_this_and_approval_service_is_unaffected():
    manual = server.build(jwt_settings(TFMCP_ROLE="frontend"), data=MemoryStore(), state=MemoryStore(), audit_store=MemoryStore(),
                          control=MemoryStore(), tf=FakeTerraform())
    manual.audit.stream = io.StringIO()
    with TestClient(server.create_app(manual, fetch_jwks=lambda: signing_key()[1])) as http:
        for path in ("/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server", "/authorize"):
            assert http.get(path).status_code == 401
        assert http.post("/register", json={}).status_code == 401 and http.post("/token", data={}).status_code == 401
        assert http.post("/mcp", json={}).headers["www-authenticate"] == "Bearer"
    back = server.build(jwt_settings(TFMCP_ROLE="approval", **DYN), data=MemoryStore(), state=MemoryStore(), audit_store=MemoryStore(),
                        control=MemoryStore(), tf=FakeTerraform())
    back.audit.stream = io.StringIO()
    with TestClient(server.create_app(back, fetch_jwks=lambda: signing_key()[1])) as http:
        assert http.get("/.well-known/oauth-authorization-server").status_code == 404 and http.post("/token", data={}).status_code == 404
        assert http.get("/api/pending", headers={"Authorization": "Bearer " + mint(ALICE)}).status_code == 401     # MCP-audience token still useless here


def test_dynamic_mode_configuration_is_validated():
    for bad in (dict(PUBLIC_BASE_URL="http://mcp.contoso.example"), dict(PUBLIC_BASE_URL="https://mcp.contoso.example/path"),
                dict(PUBLIC_BASE_URL=""), dict(CONNECTOR_CLIENT_SECRET=""), dict(OAUTH_SCOPE=""), dict(AUTH_MODE="easyauth"),
                dict(REDIRECT_URIS="https://*.example.com/cb"), dict(REDIRECT_URIS="http://example.com/cb"),
                dict(REDIRECT_URIS="https://example.com/cb#x"), dict(REDIRECT_URIS="https://example.com/cb?a=1"), dict(CONNECTOR_AUTH="magic")):
        with pytest.raises(ConfigError):
            jwt_settings(**{**DYN, **bad})
    s = jwt_settings(**{**DYN, "REDIRECT_URIS": "https://a.example/cb, https://b.example/cb", "PUBLIC_BASE_URL": ""},
                     CONTAINER_APP_NAME="ca-x", CONTAINER_APP_ENV_DNS_SUFFIX="happy.eastus2.azurecontainerapps.io")
    assert s.redirect_uris == ["https://a.example/cb", "https://b.example/cb"] and s.public_base_url == "https://ca-x.happy.eastus2.azurecontainerapps.io"
