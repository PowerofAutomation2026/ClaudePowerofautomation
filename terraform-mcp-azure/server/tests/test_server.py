"""End-to-end through the real MCP streamable-HTTP app (in process): auth -> identity -> tool -> audit."""
import io
import json

import pytest
from starlette.testclient import TestClient

import server
from conftest import FakeTerraform, make_settings
from tfmcp.audit import AuditLog
from tfmcp.storage import MemoryStore

HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
ALICE = {"X-MS-CLIENT-PRINCIPAL-ID": "aaaaaaaa-0000-0000-0000-000000000001", "X-MS-CLIENT-PRINCIPAL-NAME": "alice@contoso.com"}
BOB = {"X-MS-CLIENT-PRINCIPAL-ID": "bbbbbbbb-0000-0000-0000-000000000002", "X-MS-CLIENT-PRINCIPAL-NAME": "bob@contoso.com"}
EXPECTED_TOOLS = {"whoami", "list_environments", "list_templates", "describe_template", "plan_deployment", "plan_destroy",
                  "plan_rollback", "explain_plan", "request_approval", "approve_plan", "reject_plan", "list_pending_approvals",
                  "apply_plan", "get_operation", "list_deployments", "get_deployment", "detect_drift", "extend_ttl"}


@pytest.fixture
def app_ctx():
    settings = make_settings()
    data, state, audit_store = MemoryStore(), MemoryStore(), MemoryStore()
    svc, engine, audit = server.build(settings, data=data, state=state, audit_store=audit_store, tf=FakeTerraform(),
                                      price_fetch=lambda url, params: {"Items": []})
    log = io.StringIO()
    audit.stream = log
    app = server.create_app(svc, audit, settings)
    with TestClient(app) as client:
        yield client, log, audit_store


def rpc(client, method, params=None, who=ALICE, id_=1):
    body = {"jsonrpc": "2.0", "id": id_, "method": method}
    if params is not None:
        body["params"] = params
    return client.post("/mcp", headers={**HEADERS, **who}, json=body)


def call(client, tool, arguments=None, who=ALICE):
    r = rpc(client, "tools/call", {"name": tool, "arguments": arguments or {}}, who)
    assert r.status_code == 200, r.text
    result = r.json()["result"]
    text = result["content"][0]["text"]
    return result.get("isError", False), (json.loads(text) if not result.get("isError") else text)


def test_unauthenticated_requests_get_401(app_ctx):
    client, log, _ = app_ctx
    r = client.post("/mcp", headers=HEADERS, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert r.status_code == 401 and r.json()["error"] == "unauthorized"
    assert '"type": "auth_rejected"' in log.getvalue()
    assert client.get("/healthz").status_code == 200


def test_initialize_and_tools_list(app_ctx):
    client, _, _ = app_ctx
    r = rpc(client, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
    assert r.status_code == 200 and r.json()["result"]["serverInfo"]["name"] == "azure-terraform"
    tools = {t["name"]: t for t in rpc(client, "tools/list").json()["result"]["tools"]}
    assert set(tools) == EXPECTED_TOOLS
    schema = tools["plan_deployment"]["inputSchema"]
    assert schema["required"] == ["template", "deployment_name"] and "ttl_hours" in schema["properties"]
    assert all(t["description"] for t in tools.values())


def test_identity_reaches_tools_and_every_call_is_audited(app_ctx):
    client, log, audit_store = app_ctx
    err, me = call(client, "whoami", who=BOB)
    assert not err and me["name"] == "bob@contoso.com" and me["object_id"].startswith("bbbbbbbb")
    err, op = call(client, "plan_deployment", {"template": "storage-account", "deployment_name": "demo"})
    assert not err and op["status"] == "succeeded" and op["requested_by"] == "alice@contoso.com"
    plan_id = op["result"]["plan_id"]
    err, text = call(client, "plan_deployment", {"template": "storage-account", "deployment_name": "demo", "variables": {"x": 1}})
    assert err and "not a supported setting" in text
    err, applied = call(client, "apply_plan", {"plan_id": plan_id}, who=BOB)
    assert not err and applied["result"]["applied"] is True
    err, dep = call(client, "get_deployment", {"deployment_name": "demo"})
    assert dep["applied_by"] == "bob@contoso.com" and dep["history"][0]["planned_by"] == "alice@contoso.com"

    events = [json.loads(line) for line in log.getvalue().splitlines()]
    audits = [e for e in events if e["type"] == "audit"]
    assert [(a["tool"], a["user"], a["outcome"]) for a in audits] == [
        ("whoami", "bob@contoso.com", "ok"), ("plan_deployment", "alice@contoso.com", "ok"),
        ("plan_deployment", "alice@contoso.com", "invalid"), ("apply_plan", "bob@contoso.com", "ok"),
        ("get_deployment", "alice@contoso.com", "ok")]
    assert audits[1]["result_plan_id"] == plan_id and audits[1]["args"]["deployment_name"] == "demo"
    assert len(audits[1]["args_sha256"]) == 64 and len(audit_store.list("")) == 5


def test_two_person_rule_over_http(app_ctx):
    client, _, _ = app_ctx
    _, op = call(client, "plan_deployment", {"template": "storage-account", "deployment_name": "pay", "environment": "prod",
                                             "tags": {"costCenter": "CC-1"}})
    plan_id = op["result"]["plan_id"]
    assert call(client, "request_approval", {"plan_id": plan_id, "justification": "Storage for payments, CHG-1"})[0] is False
    err, text = call(client, "approve_plan", {"plan_id": plan_id})
    assert err and "Two-person rule" in text
    err, ok = call(client, "approve_plan", {"plan_id": plan_id, "comment": "ok"}, who=BOB)
    assert not err and ok["approval"]["decided_by"] == "bob@contoso.com"
    err, applied = call(client, "apply_plan", {"plan_id": plan_id})
    assert not err and applied["status"] == "succeeded"


def test_unexpected_errors_are_not_leaked(app_ctx, monkeypatch):
    client, log, _ = app_ctx
    import tfmcp.service as service_module
    monkeypatch.setattr(service_module.Service, "list_deployments", lambda self, env=None: 1 / 0)
    err, text = call(client, "list_deployments")
    assert err and "Internal error" in text and "ZeroDivisionError" not in text
    assert '"outcome": "error"' in log.getvalue() and "ZeroDivisionError" in log.getvalue()


def test_jobs_run_against_the_same_stores(capsys):
    settings = make_settings()
    svc, engine, audit = server.build(settings, data=MemoryStore(), state=MemoryStore(), audit_store=MemoryStore(), tf=FakeTerraform())
    audit.stream = io.StringIO()
    assert server.run_job("reaper", svc, engine) == 0
    assert server.run_job("drift", svc, engine) == 0
    assert server.run_job("recover", svc, engine) == 0
    assert server.run_job("nope", svc, engine) == 2
    reports = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.startswith("{")]
    assert [r["job"] for r in reports] == ["reaper", "drift", "recover"]
