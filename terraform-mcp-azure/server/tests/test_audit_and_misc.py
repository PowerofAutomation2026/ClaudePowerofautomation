import io
import json
import urllib.request

import pytest

from conftest import ALICE, Clock
from tfmcp.audit import AuditLog, args_hash
from tfmcp.explain import assess_risk, changed_attributes, summarize_changes
from tfmcp.service import parse_json_output
from tfmcp.storage import MemoryStore
from tfmcp.terraform import public_outputs, slim_plan, state_resources
from tfmcp.tokenbroker import TokenBroker


def test_audit_record_goes_to_stdout_and_blob_without_argument_values():
    store, stream, clock = MemoryStore(), io.StringIO(), Clock(1_800_000_000)
    audit = AuditLog(store, stream=stream, clock=clock)
    args = {"template": "sql-database", "deployment_name": "payments", "environment": "prod",
            "variables": {"entra_admin_login": "dba-team", "note": "do-not-log-me"}}
    event = audit.record(ALICE, "plan_deployment", args, "ok", duration_ms=12.34, extra={"result_operation_id": "abc"})
    line = json.loads(stream.getvalue())
    assert line["type"] == "audit" and line["user"] == "alice@contoso.com" and line["user_oid"] == ALICE.oid
    assert line["tool"] == "plan_deployment" and line["outcome"] == "ok" and line["args_sha256"] == args_hash(args)
    assert line["args"] == {"template": "sql-database", "deployment_name": "payments", "environment": "prod"}
    assert "do-not-log-me" not in stream.getvalue() and line["result_operation_id"] == "abc"
    keys = store.list("")
    assert len(keys) == 1 and keys[0].startswith("2027/01/15/") and store.get_json(keys[0])["audit_id"] == event["audit_id"]
    assert args_hash({"b": 1, "a": 2}) == args_hash({"a": 2, "b": 1})


def test_audit_blob_failure_never_breaks_the_call():
    class Broken(MemoryStore):
        def put(self, *a, **k):
            raise OSError("storage down")
    stream = io.StringIO()
    AuditLog(Broken(), stream=stream).record(ALICE, "apply_plan", {"plan_id": "x"}, "denied", error="nope")
    lines = [json.loads(line) for line in stream.getvalue().splitlines()]
    assert [e["type"] for e in lines] == ["audit", "audit_write_failed"] and lines[0]["error"] == "nope"


def test_slim_plan_redacts_sensitive_and_drops_bulk():
    plan = {"format_version": "1.2", "prior_state": {"huge": True}, "configuration": {"huge": True},
            "variables": {"x": {"value": "v"}},
            "resource_changes": [{"address": "a.b", "type": "a", "name": "b", "change": {
                "actions": ["update"], "before": {"password": "old", "nested": [{"key": "k1", "ok": 1}], "plain": 1},
                "after": {"password": "new", "nested": [{"key": "k2", "ok": 1}], "plain": 2},
                "before_sensitive": {"password": True, "nested": [{"key": True}]},
                "after_sensitive": {"password": True, "nested": [{"key": True}]}}}],
            "output_changes": {"o": {"actions": ["create"], "after": "secret-output"}}}
    slim = slim_plan(plan)
    text = json.dumps(slim)
    assert "prior_state" not in slim and "configuration" not in slim and "variables" not in slim
    for secret in ("old", "new", "k1", "k2", "secret-output"):
        assert f'"{secret}"' not in text
    after = slim["resource_changes"][0]["change"]["after"]
    assert after == {"password": "(sensitive)", "nested": [{"key": "(sensitive)", "ok": 1}], "plain": 2}


def test_state_resources_and_outputs():
    state = {"values": {"root_module": {"resources": [{"address": "a.b", "mode": "managed", "type": "a", "name": "b", "values": {"id": "/x", "secret": "s"}},
                                                      {"address": "data.c.d", "mode": "data", "type": "c", "name": "d", "values": {}}],
                                        "child_modules": [{"resources": [{"address": "module.m.e.f", "type": "e", "name": "f", "values": {"id": "/y"}}]}]}}}
    assert state_resources(state) == [{"address": "a.b", "type": "a", "name": "b", "id": "/x"},
                                      {"address": "module.m.e.f", "type": "e", "name": "f", "id": "/y"}]
    assert public_outputs({"a": {"value": 1, "sensitive": False}, "b": {"value": "x", "sensitive": True}}) == {"a": 1, "b": "(sensitive)"}
    assert parse_json_output('Warning: x\n{"a": 1}\n') == {"a": 1}
    assert parse_json_output('noise {\n "a": 2\n}') == {"a": 2}


def test_explain_risk_levels():
    def plan(*changes):
        return {"resource_changes": [{"address": f"{t}.x{i}", "mode": "managed", "type": t, "name": f"x{i}",
                                      "change": {"actions": a, "before": {"name": "n", "sku": "a"}, "after": {"name": "n", "sku": "b"},
                                                 "replace_paths": [["location"]]}}
                                     for i, (t, a) in enumerate(changes)]}
    ok = {"violations": [], "warnings": []}

    def risk(p, strict=False, policy=ok, destroy=False):
        counts, _ = summarize_changes(p)
        return assess_risk(p, counts, environment="prod" if strict else "dev", strict=strict, policy=policy, is_destroy=destroy)[0]
    assert risk(plan(("azurerm_subnet", ["create"]))) == "low"
    assert risk(plan(("azurerm_subnet", ["update"]))) == "medium"
    assert risk(plan(("azurerm_subnet", ["delete"]))) == "medium"
    assert risk(plan(("azurerm_mssql_database", ["delete", "create"]))) == "high"
    assert risk(plan(("azurerm_mssql_database", ["delete", "create"])), strict=True) == "critical"
    assert risk(plan(("azurerm_subnet", ["create"])), policy={"violations": [{"message": "x"}], "warnings": []}) == "critical"
    assert risk(plan(*[("azurerm_subnet", ["create"])] * 15)) == "high"
    counts, lines = summarize_changes(plan(("azurerm_mssql_database", ["delete", "create"]), ("azurerm_subnet", ["update"])))
    assert "DESTROY AND RE-CREATE SQL database 'n' because location cannot be changed in place" == lines[0]["text"]
    assert lines[1]["changed_settings"] == ["sku"]
    assert changed_attributes({"a": 1, "id": 1}, {"a": 2, "id": 2}) == ["a"]


def test_token_broker_speaks_the_imds_protocol():
    seen = []

    def get_token(scope):
        seen.append(scope)
        if "vault" in scope:
            raise RuntimeError("identity not allowed")
        return "tok-123", 1_900_000_000
    broker = TokenBroker(get_token)
    url = broker.start()
    try:
        assert url.startswith("http://127.0.0.1:")
        req = urllib.request.Request(url + "?api-version=2018-02-01&resource=https%3A%2F%2Fmanagement.azure.com%2F", headers={"Metadata": "true"})
        body = json.loads(urllib.request.urlopen(req, timeout=5).read())
        assert body["access_token"] == "tok-123" and body["expires_on"] == "1900000000" and body["token_type"] == "Bearer"
        assert seen == ["https://management.azure.com/.default"]
        for bad_url, headers, code in ((url + "?resource=https://management.azure.com/", {}, 400),          # no Metadata header
                                       (url + "?resource=file:///etc/passwd", {"Metadata": "true"}, 400),
                                       (url.replace("/token", "/other") + "?resource=https://x/", {"Metadata": "true"}, 404),
                                       (url + "?resource=https://vault.azure.net", {"Metadata": "true"}, 500)):
            with pytest.raises(urllib.error.HTTPError) as e:
                urllib.request.urlopen(urllib.request.Request(bad_url, headers=headers), timeout=5)
            assert e.value.code == code
    finally:
        broker.stop()


def test_image_bakes_exactly_the_provider_versions_the_templates_pin():
    import pathlib
    import re

    root = pathlib.Path(__file__).resolve().parent.parent
    docker = (root / "Dockerfile").read_text()
    common = (root / "templates" / "_common" / "common.tf").read_text()
    for name, arg in (("azurerm", "AZURERM_VERSION"), ("random", "RANDOM_VERSION")):
        pinned = re.search(r'%s\s*=\s*\{[^}]*version\s*=\s*"([0-9.]+)"' % name, common).group(1)
        baked = re.search(r"ARG %s=([0-9.]+)" % arg, docker).group(1)
        assert pinned == baked, f"{name}: common.tf pins {pinned} but the image bakes {baked}"
    assert len(re.findall(r"sha256sum -c", docker)) == 3 and "USER app" in docker
    reqs = (root / "requirements.txt").read_text().splitlines()
    assert all("==" in line for line in reqs if line.strip()), "runtime requirements must be exact pins"
    assert not any(line.lower().startswith("pytest") for line in reqs)


def test_shipped_example_and_monitoring_files_are_consistent():
    import pathlib

    from tfmcp.config import parse_environments
    from tfmcp.policy import PolicyEngine

    pkg = pathlib.Path(__file__).resolve().parent.parent.parent
    envs = parse_environments(json.loads((pkg / "environments.example.json").read_text()), "11111111-1111-1111-1111-111111111111")
    policy = PolicyEngine.from_file(pkg / "server" / "policies" / "default.json")
    templates = {p.name for p in (pkg / "server" / "templates").iterdir() if p.is_dir() and not p.name.startswith("_")}
    assert set(envs) == {"dev", "test", "prod"} and envs["prod"].require_approval and not envs["prod"].allow_ephemeral
    for env in envs.values():
        assert policy.has_profile(env.policy_profile) and set(env.allowed_templates or []) <= templates
    monitoring = json.loads((pkg / "monitoring" / "monitoring.json").read_text())
    rules = [r for r in monitoring["resources"] if r["type"].endswith("scheduledQueryRules")]
    assert len(rules) == 8 and all(r["properties"]["skipQueryValidation"] for r in rules)
    # every event type an alert or the KQL file filters on is one the server really emits
    source = "".join(p.read_text() for p in (pkg / "server").rglob("*.py") if "tests" not in p.parts)
    kql = (pkg / "audit-queries.kql").read_text() + json.dumps(monitoring)
    import re
    for event_type in set(re.findall(r'type\)? == \\?"([a-z_]+)\\?"', kql)) | {"ttl_notice", "ttl_reaped", "ttl_reap_failed", "approval_decided"}:
        assert f'"type": "{event_type}"' in source, f"monitoring refers to event type '{event_type}' that the server never emits"


def test_terraform_runner_runs_cancels_and_times_out(tmp_path):
    """The real subprocess wrapper, with a shell script standing in for the terraform binary."""
    import threading
    import time

    from tfmcp.terraform import Cancelled, TerraformRunner, prepare_workdir

    fake = tmp_path / "terraform"
    fake.write_text('#!/bin/sh\nif [ "$1" = "slow" ]; then sleep 30 & pid=$!; trap "kill $pid; echo Interrupt received; exit 1" INT; wait; fi\n'
                    'echo "args=$* input=$TF_INPUT extra=$EXTRA"; echo "to stderr" >&2; exit 3\n')
    fake.chmod(0o755)
    runner = TerraformRunner(str(fake), {"EXTRA": "base"})
    code, out = runner.run(["plan", "-no-color"], tmp_path)
    assert code == 3 and "args=plan -no-color input=0 extra=base" in out and "to stderr" in out
    cancel = threading.Event()
    threading.Timer(0.3, cancel.set).start()
    started = time.monotonic()
    with pytest.raises(Cancelled, match="cancelled"):
        runner.run(["slow"], tmp_path, cancel=cancel)
    assert time.monotonic() - started < 10                      # SIGINT was delivered and honoured
    with pytest.raises(Cancelled, match="timed out"):
        runner.run(["slow"], tmp_path, timeout=0.3)
    template = tmp_path / "tpl"
    template.mkdir()
    (template / "main.tf").write_text("# t")
    (template / "template.json").write_text("{}")
    common = tmp_path / "common.tf"
    common.write_text("# c")
    work = tmp_path / "work"
    work.mkdir()
    prepare_workdir(work, template, common, {"a": 1})
    assert sorted(p.name for p in work.iterdir()) == ["common.tf", "main.tf", "terraform.tfvars.json"]
