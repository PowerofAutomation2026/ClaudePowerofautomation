"""End to end through the real ASGI apps (in process) with real signed tokens:
MCP channel (connector audience) and the separate approval channel (approval audience)."""
import io
import json

import pytest
from starlette.testclient import TestClient

import server
from conftest import (ADMIN, ALICE, APPROVAL_AUD, APPROVAL_SPA, BOB, CAROL, NOBODY, FakeTerraform, jwt_settings, mint,
                      signing_key)
from tfmcp.storage import MemoryStore

HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
EXPECTED_TOOLS = {"whoami", "catalog", "plan", "plan_info", "request_approval", "apply", "status", "deployments"}
PROD = {"action": "deploy", "template": "storage-account", "name": "pay", "env": "prod", "tags": {"costCenter": "CC-1"}}


class Ctx:
    def __init__(self, role="all", **over):
        self.settings = jwt_settings(TFMCP_ROLE=role, **over)
        self.stores = dict(data=MemoryStore(), state=MemoryStore(), audit_store=MemoryStore(), control=MemoryStore())
        self.rt = server.build(self.settings, tf=FakeTerraform(), price_fetch=lambda url, params: {"Items": []}, **self.stores)
        self.log = io.StringIO()
        self.rt.audit.stream = self.log
        self.app = server.create_app(self.rt, fetch_jwks=lambda: signing_key()[1])

    def events(self, type_=None):
        out = [json.loads(line) for line in self.log.getvalue().splitlines()]
        return [e for e in out if type_ is None or e["type"] == type_]


@pytest.fixture
def ctx():
    c = Ctx()
    with TestClient(c.app) as client:
        c.client = client
        yield c


def rpc(c, method, params=None, who=ALICE, token=None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    return c.client.post("/mcp", headers={**HEADERS, "Authorization": "Bearer " + (token or mint(who))}, json=body)


def call(c, tool, arguments=None, who=ALICE, token=None):
    r = rpc(c, "tools/call", {"name": tool, "arguments": arguments or {}}, who, token)
    assert r.status_code == 200, r.text
    result = r.json()["result"]
    assert "structuredContent" not in result and len(result["content"]) == 1      # one compact text block only
    text = result["content"][0]["text"]
    return result.get("isError", False), (json.loads(text) if not result.get("isError") else text)


def approver_token(who, **kw):
    return mint(who, **{"aud": APPROVAL_AUD, "azp": APPROVAL_SPA, "scp": "approve", **kw})


def approval(c, method, path, who=BOB, token=None, body=None):
    headers = {"Authorization": "Bearer " + (token or approver_token(who))}
    return c.client.request(method, path, headers=headers, json=body)


def approve(c, plan_id, who=BOB):
    view = approval(c, "GET", f"/api/plans/{plan_id}", who).json()
    return approval(c, "POST", f"/api/plans/{plan_id}/decision", who, body={"decision": "approve", "comment": "ok", "digest": view["changes_digest"]})


# ------------------------------------------------------------------ MCP channel
def test_unauthenticated_and_wrong_tokens_get_401(ctx):
    r = ctx.client.post("/mcp", headers=HEADERS, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 401
    for bad, why in ((approver_token(BOB), "invalid token"),                               # approval-audience token on MCP
                     (mint(ALICE, azp="99999999-0000-0000-0000-000000000000"), "not allowed here"),   # some other client app
                     (mint(ALICE, scp="other.scope"), "required scope"),
                     (mint(ALICE, scp=None), "required scope")):                             # app-only token: no scp
        r = rpc(ctx, "tools/list", token=bad)
        assert r.status_code == 401 and why in r.json()["detail"], r.text
    assert len(ctx.events("auth_rejected")) == 5 and ctx.client.get("/healthz").status_code == 200


def test_tool_surface_has_no_approval_or_admin_tools(ctx):
    r = rpc(ctx, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
    assert r.status_code == 200 and r.json()["result"]["serverInfo"]["name"] == "azure-terraform"
    tools = {t["name"]: t for t in rpc(ctx, "tools/list").json()["result"]["tools"]}
    assert set(tools) == EXPECTED_TOOLS
    assert not any(word in name for name in tools for word in ("approve", "reject", "freeze", "unfreeze", "admin"))
    assert all("outputSchema" not in t and t["description"] for t in tools.values())
    assert tools["plan"]["inputSchema"]["required"] == ["action", "name"]
    for name in ("approve_plan", "reject_plan", "approve", "set_freeze"):
        err, text = call(ctx, name, {"plan_id": "0" * 12})
        assert err and "Unknown tool" in text


def test_full_flow_plan_request_out_of_band_approval_apply(ctx):
    err, me = call(ctx, "whoami")
    assert not err and me == {"name": "alice@contoso.com", "object_id": ALICE.oid, "authenticated": True, "roles": ["requester"]}
    err, op = call(ctx, "plan", PROD)
    assert not err and op["st"] == "succeeded"
    plan = op["result"]
    plan_id = plan["plan"]
    assert plan["approval"] == {"st": "not_requested", "two_person": True, "url": f"https://approve.example/?plan={plan_id}"}
    assert "can_apply" not in plan and "approval page" in plan["next"] and plan["say"].startswith("Deploy 'pay'")
    # the agent "confirms" on the user's behalf: refused, nothing was approved by a human
    err, text = call(ctx, "apply", {"plan_id": plan_id})
    assert err and "Not approved" in text and "cannot be approved in the chat" in text
    err, req = call(ctx, "request_approval", {"plan_id": plan_id, "reason": "Storage for payments, CHG-1"})
    assert not err and req["status"] == "pending" and req["approve_at"].endswith(plan_id) and "different person" in req["who"]
    err, text = call(ctx, "apply", {"plan_id": plan_id})
    assert err and "approval status: pending" in text
    # ---- out of band: Alice (requester) cannot approve her own prod plan; Bob (approver) can
    view = approval(ctx, "GET", f"/api/plans/{plan_id}", ALICE).json()
    assert view["you_may_decide"] is False and view["two_person"] is True and view["headline"].startswith("Deploy 'pay'")
    r = approval(ctx, "POST", f"/api/plans/{plan_id}/decision", ALICE, body={"decision": "approve", "digest": view["changes_digest"]})
    assert r.status_code == 403 and "Two-person rule" in r.json()["error"]
    assert [p["plan_id"] for p in approval(ctx, "GET", "/api/pending").json()["pending"]] == [plan_id]
    r = approve(ctx, plan_id, BOB)
    assert r.status_code == 200 and r.json()["status"] == "approved"
    assert approve(ctx, plan_id, CAROL).status_code == 409                    # decided once
    err, info = call(ctx, "plan_info", {"plan_id": plan_id})
    assert info["can_apply"] is True and info["approval"]["st"] == "approved"
    err, done = call(ctx, "apply", {"plan_id": plan_id})
    assert not err and done["st"] == "succeeded" and done["result"]["applied"] is True
    err, text = call(ctx, "apply", {"plan_id": plan_id})                      # replay
    assert err and "already used" in text
    err, dep = call(ctx, "deployments", {"action": "get", "name": "pay", "env": "prod"})
    assert dep["history"][0] == {"at": dep["history"][0]["at"], "act": "apply", "by": "alice@contoso.com",
                                 "planned": "alice@contoso.com", "approved": "bob@contoso.com", "plan": plan_id}
    apply_event = ctx.events("apply")[0]
    assert apply_event["approved_by"] == "bob@contoso.com" and apply_event["planned_by"] == "alice@contoso.com"
    audits = [(a["tool"], a["user"], a["outcome"]) for a in ctx.events("audit")]
    assert ("approval:decide", "alice@contoso.com", "denied") in audits and ("approval:decide", "bob@contoso.com", "ok") in audits
    assert ("apply", "alice@contoso.com", "denied") in audits and ("apply", "alice@contoso.com", "ok") in audits


# ------------------------------------------------------------------ approval channel hardening
def test_approval_channel_rejects_everything_but_fresh_approval_tokens(ctx):
    _, op = call(ctx, "plan", PROD)
    plan_id = op["result"]["plan"]
    call(ctx, "request_approval", {"plan_id": plan_id, "reason": "Storage for payments, CHG-1"})
    path = f"/api/plans/{plan_id}"
    assert ctx.client.get(path).status_code == 401                                            # anonymous
    assert approval(ctx, "GET", path, token=mint(BOB)).status_code == 401                     # the MCP connector's token
    assert approval(ctx, "GET", path, token=approver_token(BOB, azp="c0c0c0c0-0000-0000-0000-00000000c0c0")).status_code == 401
    assert approval(ctx, "GET", path, token=mint(BOB, aud=APPROVAL_AUD, azp=APPROVAL_SPA, scp="access_as_user")).status_code == 401
    stale = approval(ctx, "GET", path, token=approver_token(BOB, age=30, auth_age=3600))      # signed in an hour ago
    assert stale.status_code == 401 and "too old" in stale.json()["error"]
    assert approval(ctx, "GET", path, token=approver_token(BOB, scp=None)).status_code == 401  # app-only
    ok = approval(ctx, "GET", path)
    assert ok.status_code == 200 and ok.headers["x-frame-options"] == "DENY" and "default-src 'none'" in ok.headers["content-security-policy"]
    bad = approval(ctx, "POST", path + "/decision", body={"decision": "approve", "digest": "0" * 64})
    assert bad.status_code == 409 and "changed since you opened it" in bad.json()["error"]    # must approve what was shown
    assert approval(ctx, "POST", path + "/decision", body={"decision": "maybe"}).status_code == 400
    assert approval(ctx, "GET", "/api/plans/..%2F..%2Fx").status_code == 404
    assert approval(ctx, "POST", path + "/decision", NOBODY, body={"decision": "approve", "digest": ok.json()["changes_digest"]}).status_code == 403
    page = ctx.client.get("/")
    assert page.status_code == 200 and APPROVAL_SPA in page.text and "prompt" in ctx.client.get("/app.js").text


def test_mfa_requirement_is_enforced_when_configured():
    c = Ctx(APPROVAL_REQUIRE_AMR="mfa")
    with TestClient(c.app) as client:
        c.client = client
        assert approval(c, "GET", "/api/pending").status_code == 401
        assert approval(c, "GET", "/api/pending", token=approver_token(BOB, amr=["pwd", "mfa"])).status_code == 200


def test_kill_switch_is_admin_only_and_out_of_band(ctx):
    r = approval(ctx, "POST", "/api/freeze", BOB, body={"frozen": True, "reason": "suspicious activity"})
    assert r.status_code == 403
    assert approval(ctx, "POST", "/api/freeze", ADMIN, body={"frozen": True, "reason": "x"}).status_code == 400
    assert approval(ctx, "POST", "/api/freeze", ADMIN, body={"frozen": True, "reason": "suspicious activity"}).status_code == 200
    err, text = call(ctx, "plan", {"action": "deploy", "template": "storage-account", "name": "demo"})
    assert err and "FROZEN" in text and "suspicious activity" in text
    assert call(ctx, "whoami")[1]["frozen"] is True and call(ctx, "catalog")[0] is False        # reads still work
    assert approval(ctx, "GET", "/api/freeze", BOB).json()["frozen"]["source"] == "admin"
    assert approval(ctx, "POST", "/api/freeze", ADMIN, body={"frozen": False, "reason": "all clear"}).status_code == 200
    assert call(ctx, "plan", {"action": "deploy", "template": "storage-account", "name": "demo"})[0] is False
    assert [e["type"] for e in ctx.events() if e["type"].startswith("freeze")] == ["freeze_set", "freeze_lifted"]


def test_unexpected_errors_are_not_leaked(ctx, monkeypatch):
    import tfmcp.service as service_module
    monkeypatch.setattr(service_module.Service, "list_deployments", lambda self, *a, **k: 1 / 0)
    err, text = call(ctx, "deployments")
    assert err and "Internal error" in text and "ZeroDivisionError" not in text
    assert any(a["outcome"] == "error" and "ZeroDivisionError" in a["error"] for a in ctx.events("audit"))


# ------------------------------------------------------------------ split processes
def test_frontend_process_cannot_apply_and_approval_process_has_no_mcp():
    stores = dict(data=MemoryStore(), state=MemoryStore(), audit_store=MemoryStore(), control=MemoryStore())
    tf = FakeTerraform()
    front = server.build(jwt_settings(TFMCP_ROLE="frontend"), tf=tf, price_fetch=lambda u, p: {"Items": []}, **stores)
    back = server.build(jwt_settings(TFMCP_ROLE="approval"), tf=tf, **stores)
    front.audit.stream = back.audit.stream = io.StringIO()
    assert front.approvals is None and "apply" not in front.engine._handlers and set(back.engine._handlers) == {"apply", "plan"}
    plan = front.service.plan_deployment(ALICE, "storage-account", "demo", None, "dev")["result"]
    front.service.request_approval(ALICE, plan["plan_id"], "Needed for the test, CHG-1")
    import dataclasses
    import time
    fresh = dataclasses.replace(ALICE, source="jwt", issued_at=time.time(), auth_time=time.time())
    back.approvals.decide(fresh, plan["plan_id"], True, "", back.approvals.view(fresh, plan["plan_id"])["changes_digest"])
    op = front.service.apply_plan(ALICE, plan["plan_id"], wait=0.2)
    assert op["status"] == "queued" and "apply" not in tf.commands()         # the front-end only queues
    assert front.engine.tick()["adopted"] == 0                                # ...and never adopts an apply
    time.sleep(2.1)
    assert back.engine.tick()["adopted"] == 1                                 # the privileged executor does
    for _ in range(300):
        if front.service.get_operation(ALICE, op["operation_id"])["status"] == "succeeded":
            break
        time.sleep(0.01)
    assert front.service.get_operation(ALICE, op["operation_id"])["status"] == "succeeded" and "apply" in tf.commands()
    # user plans queued by the front-end are never adopted by the privileged process
    tf.block["plan"] = __import__("threading").Event()
    front.engine._slots = __import__("threading").Semaphore(0)               # front-end has no free worker: stays queued
    queued = front.service.plan_deployment(ALICE, "storage-account", "other", None, "dev", wait=0)
    time.sleep(2.1)
    assert queued["status"] == "queued" and back.engine.tick()["adopted"] == 0
    front.engine._slots = __import__("threading").Semaphore(2)
    tf.block.clear()
    # process roles expose different HTTP surfaces
    with TestClient(server.create_app(back, fetch_jwks=lambda: signing_key()[1])) as client:
        assert client.post("/mcp", headers=HEADERS, json={}).status_code in (404, 405)
    with TestClient(server.create_app(front, fetch_jwks=lambda: signing_key()[1])) as client:
        assert client.get("/api/pending", headers={"Authorization": "Bearer " + approver_token(BOB)}).status_code in (401, 404)
    assert server.run_job("reaper", front) == 2 and server.run_job("reaper", back) == 0 and server.run_job("drift", front) == 0
