"""Token budgets. Tokens are estimated as characters / 4 (a common rule of thumb for English + JSON).
If a change makes the tool surface or a typical answer bigger than its budget, these tests fail."""
import json
import pathlib

import pytest
from starlette.testclient import TestClient

from conftest import ALICE, BOB
from test_server import PROD, Ctx, approve, call, rpc

BUDGET = {                       # tokens (chars / 4)
    "tools/list": 1100,          # v2.0 was ~2117 for 18 tools
    "catalog templates": 380,    # v2.0 list_templates ~4981
    "catalog environments": 130, # v2.0 list_environments ~2921
    "catalog template": 600,
    "plan result": 350,          # v2.0 ~906
    "plan_info": 330,            # v2.0 explain_plan ~773
    "plan_info detail": 460,
    "request_approval": 100,
    "apply result": 80,         # v2.0 ~238
    "status (running)": 40,
    "status (unchanged)": 30,
    "deployments list (1)": 60,  # v2.0 ~142
    "deployments get": 200,      # v2.0 ~447
    "agent-instructions.md": 250,
}


def tokens(text: str) -> int:
    return (len(text) + 3) // 4


@pytest.fixture(scope="module")
def sizes():
    c = Ctx()
    out = {}
    with TestClient(c.app) as client:
        c.client = client

        def measure(name, tool, args=None, who=ALICE):
            r = rpc(c, "tools/call", {"name": tool, "arguments": args or {}}, who).json()["result"]
            assert not r.get("isError"), r
            text = r["content"][0]["text"]
            assert text == json.dumps(json.loads(text), separators=(",", ":"), ensure_ascii=False)   # compact, not pretty-printed
            out[name] = tokens(text)
            return json.loads(text)
        out["tools/list"] = tokens(json.dumps(rpc(c, "tools/list").json()["result"], separators=(",", ":")))
        measure("catalog templates", "catalog")
        measure("catalog environments", "catalog", {"what": "environments"})
        measure("catalog template", "catalog", {"what": "template", "name": "aks-cluster"})
        op = measure("plan result", "plan", PROD)
        plan_id = op["result"]["plan"]
        measure("plan_info", "plan_info", {"plan_id": plan_id})
        measure("plan_info detail", "plan_info", {"plan_id": plan_id, "detail": True})
        measure("request_approval", "request_approval", {"plan_id": plan_id, "reason": "Storage for payments, CHG-1"})
        assert approve(c, plan_id, BOB).status_code == 200
        done = measure("apply result", "apply", {"plan_id": plan_id})
        measure("deployments list (1)", "deployments")
        measure("deployments get", "deployments", {"action": "get", "name": "pay", "env": "prod"})
        # polling: a running operation, then the etag shortcut
        import threading
        c.rt.service.tf.block["plan"] = threading.Event()
        c.rt.settings.sync_wait_seconds = 0.2
        running = measure("status (running)", "plan", {"action": "deploy", "template": "storage-account", "name": "slow"})
        assert running["st"] == "running" and running["poll_s"] == 20
        again = measure("status (unchanged)", "status", {"op_id": running["op"], "etag": running["etag"]})
        assert again == {"op": running["op"], "st": "running", "unchanged": True, "etag": running["etag"], "poll_s": 20}
        c.rt.service.tf.block["plan"].set()
        out["_done"] = done
    out["agent-instructions.md"] = tokens((pathlib.Path(__file__).resolve().parents[2] / "agent-instructions.md").read_text())
    return out


@pytest.mark.parametrize("name", sorted(BUDGET))
def test_token_budget(sizes, name):
    assert sizes[name] <= BUDGET[name], f"{name}: ~{sizes[name]} tokens, budget {BUDGET[name]}"


def test_report_sizes(sizes, capsys):
    with capsys.disabled():
        print("\n  token estimate (chars/4): " + ", ".join(f"{k}={v}" for k, v in sizes.items() if not k.startswith("_")))


def test_results_omit_empty_fields_and_cap_size():
    from tfmcp import compact
    text = compact.finish({"a": None, "b": "", "c": [], "items": [{"n": i, "pad": "x" * 200} for i in range(100)], "ok": True})
    doc = json.loads(text)
    assert len(text) <= compact.MAX_RESULT_CHARS and doc["truncated"] is True and "more" in doc and 0 < len(doc["items"]) < 100
    assert set(doc) == {"items", "ok", "truncated", "more"}
    assert compact.finish({"x": 1}) == '{"x":1}'


def test_list_is_paged_and_fields_can_be_selected():
    c = Ctx()
    with TestClient(c.app) as client:
        c.client = client
        svc, rt = c.rt.service, c.rt
        for i in range(23):
            rt.service.data.put_json(f"deployments/dev/app-{i:02d}.json", {"deployment": f"app-{i:02d}", "environment": "dev", "status": "active",
                                                                   "template": "storage-account", "owner_oid": ALICE.oid, "owner": "alice"})
        _, page1 = call(c, "deployments")
        assert len(page1["items"]) == 20 and page1["count"] == 23 and page1["truncated"] is True and "page=2" in page1["more"]
        _, page2 = call(c, "deployments", {"page": 2, "fields": ["st"]})
        assert len(page2["items"]) == 3 and "truncated" not in page2 and page2["items"][0] == {"name": "app-20", "env": "dev", "st": "active"}
        assert svc.list_deployments(BOB)["count"] == 0
