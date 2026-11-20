import hashlib
import json
import threading

import pytest

from conftest import ALICE, BOB, CAROL, ENVIRONMENTS, World, storage_plan
from tfmcp.config import ConfigError, Settings
from tfmcp.identity import ANONYMOUS, Identity, system_identity
from tfmcp.service import Denied, Invalid

REAPER = system_identity("ttl-reaper")
VM_PRICE = {"retailPrice": 1.0, "unitOfMeasure": "1 Hour", "productName": "Virtual Machines Dsv5 Series", "skuName": "D2s v5",
            "meterName": "D2s v5", "armSkuName": "Standard_D2s_v5", "type": "Consumption"}
PROD_TAGS = {"costCenter": "CC-42"}


# ------------------------------------------------------------------ discovery / validation
def test_list_templates_and_describe(world):
    listing = world.svc.list_templates()
    names = [t["name"] for t in listing["templates"]]
    assert "aks-cluster" in names and len(names) == 15 and listing["allowed_locations"] == ["eastus2", "westus2"]
    sig = next(t for t in listing["templates"] if t["name"] == "storage-account")["variables"]["replication_type"]
    assert "one of LRS, ZRS" in sig and 'default "ZRS"' in sig
    assert "REQUIRED" in next(t for t in listing["templates"] if t["name"] == "sql-database")["variables"]["entra_admin_object_id"]
    assert world.svc.describe_template("key-vault")["variables"]["sku_name"]["enum"] == ["standard", "premium"]
    assert [t["name"] for t in world.svc.list_templates(category="data")["templates"]] == ["cosmos-db", "postgres-flexible", "sql-database"]


def test_list_environments_hides_approver_ids(world):
    envs = {e["name"]: e for e in world.svc.list_environments()["environments"]}
    assert envs["prod"]["require_approval"] and envs["prod"]["policy_profile"] == "strict" and not envs["test"]["enable_apply"]
    assert "approver_object_ids" not in envs["prod"] and envs["prod"]["plan_ttl_minutes"] == 480
    assert any(r["id"] == "protected-resources" and r["enforcement"] == "deny" for r in envs["prod"]["policy_rules"])


@pytest.mark.parametrize("kwargs,match", [
    (dict(template="nope"), "Unknown template"),
    (dict(name="Bad_Name"), "deployment_name must be"),
    (dict(variables={"replication_type": "XXL"}), "must be one of"),
    (dict(variables={"hack": 1}), "not a supported setting"),
    (dict(location="westeurope"), "not allowed in environment 'dev'"),
    (dict(environment="staging"), "Unknown environment"),
    (dict(tags={"bad key": "x"}), "tag name"),
    (dict(ttl_hours=-1), "positive"),
    (dict(ttl_hours=1000), "at most 72"),
])
def test_invalid_requests_never_reach_terraform(world, kwargs, match):
    args = dict(template="storage-account", name="demo", variables=None, environment="dev")
    args.update(kwargs)
    with pytest.raises(Invalid, match=match):
        world.svc.plan_deployment(ALICE, args.pop("template"), args.pop("name"), args.pop("variables"), args.pop("environment"), **args)
    assert world.tf.calls == []


def test_environment_template_allowlist():
    envs = json.loads(json.dumps(ENVIRONMENTS))
    envs["dev"]["allowed_templates"] = ["storage-account"]
    w = World(envs)
    assert [t["name"] for t in w.svc.list_templates("dev")["templates"]] == ["storage-account"]
    with pytest.raises(Denied, match="not offered"):
        w.svc.plan_deployment(ALICE, "key-vault", "demo", None, "dev")


# ------------------------------------------------------------------ plan
def test_plan_injects_environment_scope_tags_and_separate_state(world):
    plan = world.plan(variables={"replication_type": "GRS"}, tags={"costCenter": "CC1"}, location="westus2")
    tfvars = world.data.get_json(f"plans/{plan['plan_id']}/meta.json")["tfvars"]
    assert tfvars["resource_group_name"] == "rg-x-dev" and tfvars["subscription_id"] == "11111111-1111-1111-1111-111111111111"
    assert tfvars["location"] == "westus2" and tfvars["replication_type"] == "GRS" and tfvars["account_tier"] == "Standard"
    assert tfvars["tags"] == {"costCenter": "CC1", "managedBy": "azure-terraform-mcp", "environment": "dev",
                              "deployment": "demo", "owner": "alice@contoso.com"}
    init = next(c for c in world.tf.calls if c[0] == "init")
    assert "-backend-config=key=dev/demo.tfstate" in init and "-backend-config=use_msi=true" in init
    # the prod environment is another resource group AND another subscription, with its own state key
    world.tf.calls.clear()
    prod = world.plan(environment="prod", tags=PROD_TAGS)
    tfvars = world.data.get_json(f"plans/{prod['plan_id']}/meta.json")["tfvars"]
    assert tfvars["resource_group_name"] == "rg-x-prod" and tfvars["subscription_id"] == "33333333-3333-3333-3333-333333333333"
    assert "-backend-config=key=prod/demo.tfstate" in next(c for c in world.tf.calls if c[0] == "init")


def test_user_cannot_override_injected_tags_or_variables(world):
    plan = world.plan(tags={"managedBy": "me", "environment": "prod", "deployment": "other"})
    tags = world.data.get_json(f"plans/{plan['plan_id']}/meta.json")["tfvars"]["tags"]
    assert tags["managedBy"] == "azure-terraform-mcp" and tags["environment"] == "dev" and tags["deployment"] == "demo"
    with pytest.raises(Invalid, match="not a supported setting"):
        world.svc.plan_deployment(ALICE, "storage-account", "demo", {"resource_group_name": "rg-other"}, "dev")
    with pytest.raises(Invalid, match="not a supported setting"):
        world.svc.plan_deployment(ALICE, "storage-account", "demo", {"subscription_id": "x"}, "dev")


def test_plan_result_has_explanation_policy_cost_and_next_step(world):
    plan = world.plan()
    assert plan["has_changes"] and plan["can_apply"] and plan["policy"]["allowed"] and plan["blockers"] == []
    exp = plan["explanation"]
    assert exp["counts"] == {"create": 2, "update": 0, "delete": 0, "replace": 0} and exp["risk_level"] == "low"
    assert "Create storage account 'stdemo123456' in eastus2" in exp["read_to_user"]
    assert "Deploy 'demo' (storage-account) in dev: 2 to create." == exp["headline"]
    assert "explicitly confirm" in exp["next_step"] and plan["cost"]["disclaimer"].startswith("Estimate only")
    assert plan["approval"] == {"required": False, "status": "not_required"} and plan["requested_by"] == "alice@contoso.com"
    stored = world.data.get(f"plans/{plan['plan_id']}/tfplan")[0]
    meta = world.data.get_json(f"plans/{plan['plan_id']}/meta.json")
    assert hashlib.sha256(stored).hexdigest() == meta["tfplan_sha256"]
    event = world.events("plan")[0]
    assert event["user"] == "alice@contoso.com" and event["policy_allowed"] is True and event["risk"] == "low"


def test_sensitive_values_never_stored_in_plan_json(world):
    world.tf.plan_builder = lambda tfvars, destroy: storage_plan(tfvars, destroy, primary_access_key="TOPSECRET")
    plan = world.plan()
    text = world.data.get(f"plans/{plan['plan_id']}/plan.json")[0].decode()
    assert "TOPSECRET" not in text and "(sensitive)" in text
    assert "TOPSECRET" not in json.dumps(plan)


def test_no_changes_plan_saves_nothing(world):
    world.tf.no_changes = True
    plan = world.plan()
    assert plan["plan_id"] is None and not plan["has_changes"] and not plan["can_apply"]
    assert world.data.list("plans/") == [] and plan["explanation"]["next_step"] == "Nothing to apply."


def test_terraform_failure_is_reported_cleanly(world):
    world.tf.fail["plan"] = "Insufficient quota for Standard_D2s_v5"
    op = world.svc.plan_deployment(ALICE, "storage-account", "demo", None, "dev")
    assert op["status"] == "failed" and "Insufficient quota" in op["error"] and "Traceback" not in op["error"]
    assert world.svc.get_operation(op["operation_id"])["status"] == "failed"
    with pytest.raises(Invalid):
        world.svc.get_operation("../../etc/passwd")


def test_policy_violation_blocks_apply_in_plain_language(world):
    world.tf.plan_builder = lambda tfvars, destroy: storage_plan(tfvars, destroy, allow_nested_items_to_be_public=True, min_tls_version="TLS1_0")
    plan = world.plan()
    assert not plan["policy"]["allowed"] and not plan["can_apply"] and plan["explanation"]["risk_level"] == "critical"
    assert any("anonymous public access" in b for b in plan["blockers"])
    assert "BLOCKED" in plan["explanation"]["read_to_user"]
    with pytest.raises(Denied, match="anonymous public access"):
        world.svc.apply_plan(ALICE, plan["plan_id"])
    assert "apply" not in world.tf.commands()


def test_policy_is_re_evaluated_at_apply_time(world):
    plan = world.plan()
    # someone tampers with the stored plan JSON after planning, or the policy got stricter: apply re-checks
    doc = world.data.get_json(f"plans/{plan['plan_id']}/plan.json")
    doc["resource_changes"][1]["change"]["after"]["location"] = "southafricanorth"
    world.data.put_json(f"plans/{plan['plan_id']}/plan.json", doc)
    with pytest.raises(Denied, match="not allowed in this environment"):
        world.svc.apply_plan(ALICE, plan["plan_id"])


def test_strict_profile_applies_to_prod_only(world):
    builder = lambda tfvars, destroy: storage_plan(tfvars, destroy, public_network_access_enabled=True)  # noqa: E731
    world.tf.plan_builder = builder
    dev = world.plan(name="pub")
    assert dev["policy"]["allowed"] and [w["rule"] for w in dev["policy"]["warnings"]] == ["no-public-network-access"]
    assert dev["explanation"]["risk_level"] == "medium"
    prod = world.plan(name="pub", environment="prod", tags=PROD_TAGS)
    assert not prod["policy"]["allowed"] and prod["policy"]["profile"] == "strict"
    missing_tag = world.plan(name="notag", environment="prod")
    assert any("costCenter" in v["message"] for v in missing_tag["policy"]["violations"])


# ------------------------------------------------------------------ apply
def test_apply_records_deployment_outputs_history_and_consumes_plan(world):
    plan = world.plan()
    result = world.apply(ALICE, plan["plan_id"])
    assert result["applied"] and result["outputs"] == {"storage_account_name": "stdemo", "secret": "(sensitive)"}
    assert result["resources"][0]["type"] == "azurerm_storage_account" and "primary_access_key" not in json.dumps(result)
    dep = world.svc.get_deployment("demo", "dev")
    assert dep["status"] == "active" and dep["owner"] == "alice@contoso.com" and dep["applied_by"] == "alice@contoso.com"
    assert dep["history"][0]["action"] == "apply" and dep["history"][0]["plan_id"] == plan["plan_id"]
    assert world.svc.list_deployments()["count"] == 1 and world.svc.list_deployments("prod")["count"] == 0
    assert not world.data.exists(f"plans/{plan['plan_id']}/tfplan")              # plan file removed after use
    with pytest.raises(Denied, match="already used"):
        world.svc.apply_plan(ALICE, plan["plan_id"])
    assert world.tf.commands().count("apply") == 1
    assert world.events("apply")[0]["planned_by"] == "alice@contoso.com"


def test_apply_disabled_environment_is_plan_only(world):
    plan = world.plan(environment="test")
    assert not plan["can_apply"] and "switched off" in plan["blockers"][0]
    with pytest.raises(Denied, match="Apply is switched off"):
        world.svc.apply_plan(ALICE, plan["plan_id"])


def test_plan_expires(world):
    plan = world.plan()
    world.clock.advance(61 * 60)
    with pytest.raises(Denied, match="expired"):
        world.svc.apply_plan(ALICE, plan["plan_id"])
    assert world.svc.explain_plan(plan["plan_id"])["can_apply"] is False


def test_tampered_plan_file_is_refused(world):
    plan = world.plan()
    world.data.put(f"plans/{plan['plan_id']}/tfplan", b"malicious plan")
    op = world.svc.apply_plan(ALICE, plan["plan_id"])
    assert op["status"] == "failed" and "checksum" in op["error"] and "apply" not in world.tf.commands()


def test_concurrent_apply_of_one_plan_runs_once(world):
    plan = world.plan()
    world.tf.block["apply"] = threading.Event()
    world.tf.entered["apply"] = threading.Event()
    first = world.svc.apply_plan(ALICE, plan["plan_id"], wait=0)
    assert world.tf.entered["apply"].wait(5)
    with pytest.raises(Denied, match="already used|busy"):
        world.svc.apply_plan(BOB, plan["plan_id"], wait=0)
    with pytest.raises(Denied, match="busy"):
        world.svc.plan_deployment(BOB, "storage-account", "demo", None, "dev")
    assert world.svc.get_deployment  # still responsive while the apply runs
    world.tf.block["apply"].set()
    for _ in range(500):
        if world.svc.get_operation(first["operation_id"])["status"] == "succeeded":
            break
        threading.Event().wait(0.01)
    assert world.svc.get_operation(first["operation_id"])["status"] == "succeeded"
    assert world.tf.commands().count("apply") == 1


def test_failed_apply_marks_deployment_for_attention(world):
    plan = world.plan()
    world.tf.fail["apply"] = "StorageAccountAlreadyTaken"
    op = world.svc.apply_plan(ALICE, plan["plan_id"])
    assert op["status"] == "failed" and "StorageAccountAlreadyTaken" in op["error"] and "run a new plan" in op["error"]
    assert world.svc.get_deployment("demo", "dev")["status"] == "needs_attention"
    world.tf.fail.clear()
    world.apply(ALICE, world.plan()["plan_id"])                       # re-plan and apply recovers it
    assert world.svc.get_deployment("demo", "dev")["status"] == "active"


def test_name_reuse_with_other_template_or_region_is_refused(world):
    world.apply(ALICE, world.plan()["plan_id"])
    with pytest.raises(Invalid, match="already exists"):
        world.svc.plan_deployment(ALICE, "key-vault", "demo", None, "dev")
    with pytest.raises(Invalid, match="cannot be moved"):
        world.svc.plan_deployment(ALICE, "storage-account", "demo", None, "dev", location="westus2")


def test_update_shows_what_changed_since_last_apply(world):
    world.apply(ALICE, world.plan(variables={"replication_type": "LRS"})["plan_id"])
    plan = world.plan(BOB, variables={"replication_type": "GRS"})
    since = plan["explanation"]["since_last_apply"]
    assert since["inputs_changed"] == {"replication_type": {"from": "LRS", "to": "GRS"}}
    assert since["last_applied_by"] == "alice@contoso.com" and "replication_type ('LRS' -> 'GRS')" in plan["explanation"]["read_to_user"]
    # ownership stays with the original owner even when someone else updates
    assert world.data.get_json(f"plans/{plan['plan_id']}/meta.json")["tfvars"]["tags"]["owner"] == "alice@contoso.com"


def test_rollback_plans_previous_inputs(world):
    with pytest.raises(Invalid):
        world.svc.plan_rollback(ALICE, "demo", "dev")
    world.apply(ALICE, world.plan(variables={"replication_type": "LRS"})["plan_id"])
    with pytest.raises(Invalid, match="no earlier applied version"):
        world.svc.plan_rollback(ALICE, "demo", "dev")
    world.clock.advance(60)
    world.apply(ALICE, world.plan(variables={"replication_type": "GRS"})["plan_id"])
    world.clock.advance(60)
    op = world.svc.plan_rollback(BOB, "demo", "dev")
    meta = world.data.get_json(f"plans/{op['result']['plan_id']}/meta.json")
    assert meta["tfvars"]["replication_type"] == "LRS" and meta["origin"] == "rollback" and op["rollback_to"]["applied_by"] == "alice@contoso.com"


# ------------------------------------------------------------------ destroy
def test_destroy_flow_and_flag(world):
    world.apply(ALICE, world.plan()["plan_id"])
    world.state.put("dev/demo.tfstate", b"{}")
    op = world.svc.plan_destroy(ALICE, "demo", "dev")
    plan = op["result"]
    assert plan["destroy"] and plan["explanation"]["headline"].startswith("Destroy 'demo'")
    assert plan["explanation"]["risk_level"] in ("medium", "high") and "DELETE storage account" in plan["explanation"]["read_to_user"]
    assert plan["policy"]["warnings"][0]["rule"] == "protected-resources"   # standard profile: warning only
    result = world.apply(ALICE, plan["plan_id"])
    assert result["destroyed"] and world.svc.list_deployments()["count"] == 0
    assert not world.state.exists("dev/demo.tfstate")
    with pytest.raises(Invalid, match="No deployment named"):
        world.svc.get_deployment("demo", "dev")
    world.apply(ALICE, world.plan()["plan_id"])                             # the name can be used again


def test_destroy_disabled_and_protected_in_prod():
    envs = json.loads(json.dumps(ENVIRONMENTS))
    envs["dev"]["enable_destroy"] = False
    envs["prod"]["require_approval"] = False
    w = World(envs)
    w.apply(ALICE, w.plan()["plan_id"])
    with pytest.raises(Denied, match="Destroy is switched off"):
        w.svc.plan_destroy(ALICE, "demo", "dev")
    w.apply(ALICE, w.plan(environment="prod", tags=PROD_TAGS)["plan_id"])
    plan = w.svc.plan_destroy(ALICE, "demo", "prod")["result"]
    assert not plan["policy"]["allowed"] and "protected, data-bearing resource" in plan["blockers"][0]
    with pytest.raises(Denied, match="protected"):
        w.svc.apply_plan(ALICE, plan["plan_id"])


# ------------------------------------------------------------------ two-person approval
def prod_plan(world, who=ALICE):
    return world.plan(who, environment="prod", tags=PROD_TAGS)


def test_prod_apply_needs_approval_by_a_different_person(world):
    plan = prod_plan(world)
    assert plan["approval"] == {"required": True, "status": "not_requested"} and not plan["can_apply"]
    assert "request_approval" in plan["explanation"]["next_step"]
    with pytest.raises(Denied, match="second person's approval"):
        world.svc.apply_plan(ALICE, plan["plan_id"])
    with pytest.raises(Invalid, match="justification"):
        world.svc.request_approval(ALICE, plan["plan_id"], "pls")
    req = world.svc.request_approval(ALICE, plan["plan_id"], "New storage for the payments service, ticket CHG-1234")
    assert req["approval"]["status"] == "pending" and req["approval"]["requested_by"] == "alice@contoso.com"
    assert [p["plan_id"] for p in world.svc.list_pending_approvals("prod")["pending"]] == [plan["plan_id"]]
    assert world.notifications[-1]["type"] == "approval_requested"
    with pytest.raises(Denied, match="Two-person rule"):
        world.svc.approve_plan(ALICE, plan["plan_id"], "lgtm")           # requester cannot approve their own plan
    with pytest.raises(Denied, match="second person's approval"):
        world.svc.apply_plan(ALICE, plan["plan_id"])
    ok = world.svc.approve_plan(BOB, plan["plan_id"], "reviewed")
    assert ok["approval"]["status"] == "approved" and ok["approval"]["decided_by"] == "bob@contoso.com"
    assert world.svc.list_pending_approvals()["pending"] == []
    assert world.svc.explain_plan(plan["plan_id"])["can_apply"] is True
    world.apply(ALICE, plan["plan_id"])
    entry = world.svc.get_deployment("demo", "prod")["history"][0]
    assert entry["planned_by"] == "alice@contoso.com" and entry["approved_by"] == "bob@contoso.com"
    apply_event = world.events("apply")[0]
    assert apply_event["approved_by"] == "bob@contoso.com" and apply_event["user_oid"] == ALICE.oid
    with pytest.raises(Invalid, match="no pending approval"):
        world.svc.approve_plan(CAROL, plan["plan_id"])


def test_approval_requested_by_someone_else_still_excludes_planner_and_requester(world):
    plan = prod_plan(world, ALICE)
    world.svc.request_approval(BOB, plan["plan_id"], "Requesting on behalf of Alice, CHG-99")
    for person in (ALICE, BOB):
        with pytest.raises(Denied, match="Two-person rule"):
            world.svc.approve_plan(person, plan["plan_id"])
    world.svc.approve_plan(CAROL, plan["plan_id"])


def test_anonymous_system_and_app_identities_cannot_approve_or_apply_in_prod(world):
    plan = prod_plan(world)
    world.svc.request_approval(ALICE, plan["plan_id"], "A real justification here")
    app = Identity(oid="dddddddd-0000-0000-0000-000000000004", name="app:some-client", source="jwt")
    for nobody in (ANONYMOUS, REAPER, app):
        with pytest.raises(Denied, match="Only a signed-in person"):
            world.svc.approve_plan(nobody, plan["plan_id"])
    world.svc.approve_plan(BOB, plan["plan_id"])
    with pytest.raises(Denied, match="Only a signed-in person"):
        world.svc.apply_plan(ANONYMOUS, plan["plan_id"])


def test_rejection_and_withdrawal(world):
    plan = prod_plan(world)
    world.svc.request_approval(ALICE, plan["plan_id"], "A real justification here")
    out = world.svc.reject_plan(BOB, plan["plan_id"], "wrong region")
    assert out["approval"]["status"] == "rejected"
    with pytest.raises(Denied, match="status: rejected"):
        world.svc.apply_plan(ALICE, plan["plan_id"])
    second = prod_plan(world)
    world.svc.request_approval(ALICE, second["plan_id"], "A real justification here")
    assert world.svc.reject_plan(ALICE, second["plan_id"], "changed my mind")["approval"]["status"] == "rejected"   # withdraw own


def test_approver_allow_list_by_group_or_object_id():
    envs = json.loads(json.dumps(ENVIRONMENTS))
    envs["prod"]["approver_group_ids"] = ["99999999-0000-0000-0000-000000000009"]
    w = World(envs)
    plan = prod_plan(w)
    w.svc.request_approval(ALICE, plan["plan_id"], "A real justification here")
    with pytest.raises(Denied, match="not in the approver list"):
        w.svc.approve_plan(BOB, plan["plan_id"])
    with pytest.raises(Denied, match="not in the approver list"):
        w.svc.reject_plan(BOB, plan["plan_id"])
    assert w.svc.approve_plan(CAROL, plan["plan_id"])["approval"]["status"] == "approved"   # Carol is in the group


def test_approval_cannot_be_requested_for_blocked_expired_or_dev_plans(world):
    with pytest.raises(Invalid, match="does not need approval"):
        world.svc.request_approval(ALICE, world.plan()["plan_id"], "A real justification here")
    world.tf.plan_builder = lambda tfvars, destroy: storage_plan(tfvars, destroy, public_network_access_enabled=True)
    blocked = prod_plan(world)
    with pytest.raises(Denied, match="blocked by policy"):
        world.svc.request_approval(ALICE, blocked["plan_id"], "A real justification here")
    world.tf.plan_builder = storage_plan
    plan = prod_plan(world)
    world.svc.request_approval(ALICE, plan["plan_id"], "A real justification here")
    world.clock.advance(9 * 3600)
    with pytest.raises(Invalid, match="no longer open"):
        world.svc.approve_plan(BOB, plan["plan_id"])
    assert world.svc.list_pending_approvals()["pending"] == []


def test_forged_approval_record_is_caught_at_apply(world):
    plan = prod_plan(world)
    key = f"plans/{plan['plan_id']}/meta.json"
    meta = world.data.get_json(key)
    meta["approval"] = {"required": True, "status": "approved", "decided_by": ALICE.public(), "plan_sha256": meta["tfplan_sha256"]}
    world.data.put_json(key, meta)
    with pytest.raises(Denied, match="Two-person rule violated"):
        world.svc.apply_plan(ALICE, plan["plan_id"])
    meta["approval"]["decided_by"] = BOB.public()
    meta["approval"]["plan_sha256"] = "0" * 64
    world.data.put_json(key, meta)
    with pytest.raises(Denied, match="does not match this plan"):
        world.svc.apply_plan(ALICE, plan["plan_id"])


# ------------------------------------------------------------------ cost / budget
def vm_plan(tfvars, destroy=False):
    doc = storage_plan(tfvars, destroy)
    doc["resource_changes"].append({"address": "azurerm_linux_virtual_machine.this", "mode": "managed",
                                    "type": "azurerm_linux_virtual_machine", "name": "this",
                                    "change": {"actions": ["create"], "before": None, "after_unknown": {},
                                               "after": {"name": "vm", "location": tfvars["location"], "size": "Standard_D2s_v5",
                                                         "disable_password_authentication": True, "tags": tfvars["tags"]}}})
    return doc


def test_cost_estimate_is_returned_and_budget_cap_blocks_apply():
    envs = json.loads(json.dumps(ENVIRONMENTS))
    envs["prod"]["require_approval"] = False
    w = World(envs, price_fetch=lambda url, params: {"Items": [VM_PRICE]})
    w.tf.plan_builder = vm_plan
    dev = w.plan(name="vm1")
    assert dev["cost"]["monthly_total_usd"] == 730.0 and dev["cost"]["monthly_delta_usd"] == 730.0 and dev["budget"]["status"] == "no_budget"
    assert "+USD 730.00 per month" in dev["explanation"]["read_to_user"] and dev["can_apply"]
    prod = w.plan(name="vm1", environment="prod", tags=PROD_TAGS)
    assert prod["budget"]["status"] == "over_budget" and not prod["can_apply"]
    assert "over this environment's limit of USD 500.00" in prod["blockers"][0]
    with pytest.raises(Denied, match="over this environment's limit"):
        w.svc.apply_plan(ALICE, prod["plan_id"])
    w.apply(ALICE, dev["plan_id"])
    assert w.svc.list_deployments("dev")["deployments"][0]["monthly_estimate_usd"] == 730.0


def test_price_service_offline_does_not_block_planning(world):
    def offline(url, params):
        raise ConnectionError("no route")
    w = World(price_fetch=offline)
    w.tf.plan_builder = vm_plan
    plan = w.plan(name="vm1")
    assert plan["cost"]["status"] == "unavailable" and plan["can_apply"]
    assert "could not be estimated" in plan["explanation"]["cost_summary"]


# ------------------------------------------------------------------ time-boxed deployments
def test_ttl_only_where_allowed_and_only_at_creation(world):
    with pytest.raises(Denied, match="not allowed in environment 'prod'"):
        world.svc.plan_deployment(ALICE, "storage-account", "tmp", None, "prod", ttl_hours=4)
    world.apply(ALICE, world.plan(name="perm")["plan_id"])
    with pytest.raises(Denied, match="permanent deployment"):
        world.svc.plan_deployment(ALICE, "storage-account", "perm", None, "dev", ttl_hours=4)
    with pytest.raises(Invalid, match="not a time-boxed"):
        world.svc.extend_ttl(ALICE, "perm", 5, "dev")


def test_reaper_notifies_then_destroys_only_expired_ephemeral_deployments(world):
    world.apply(ALICE, world.plan(name="perm")["plan_id"])
    plan = world.plan(name="sandbox", ttl_hours=48)
    assert world.data.get_json(f"plans/{plan['plan_id']}/meta.json")["tfvars"]["tags"]["ephemeral"] == "true"
    result = world.apply(ALICE, plan["plan_id"])
    assert "time-boxed" in result["note"]
    listed = {d["deployment"]: d for d in world.svc.list_deployments("dev")["deployments"]}
    assert listed["sandbox"]["ephemeral"] and listed["sandbox"]["expires_in_hours"] == 48.0 and not listed["perm"]["ephemeral"]

    assert world.svc.run_reaper(REAPER) == {"notified": [], "destroyed": [], "failed": [], "skipped": []}   # too early
    world.clock.advance(25 * 3600)                              # inside the 24h notice window
    report = world.svc.run_reaper(REAPER)
    assert report["notified"] == ["dev/sandbox"] and report["destroyed"] == []
    notice = world.notifications[-1]
    assert notice["type"] == "ttl_notice" and notice["owner"] == "alice@contoso.com" and "extend_ttl" in notice["text"]
    assert world.svc.run_reaper(REAPER)["notified"] == []       # notice is sent once
    world.clock.advance(24 * 3600)                              # past expiry
    report = world.svc.run_reaper(REAPER)
    assert report["destroyed"] == ["dev/sandbox"] and report["failed"] == []
    assert [a["deployment"] for a in world.tf.applied if a["destroy"]] == ["sandbox"]     # 'perm' untouched
    assert [d["deployment"] for d in world.svc.list_deployments("dev")["deployments"]] == ["perm"]
    destroy_event = [e for e in world.events("apply") if e["destroy"]][0]
    assert destroy_event["user"] == "system:ttl-reaper" and destroy_event["origin"] == "ttl-reaper"


def test_reaper_always_gives_notice_first_even_if_it_was_down(world):
    world.apply(ALICE, world.plan(name="sandbox", ttl_hours=1)["plan_id"])
    world.clock.advance(5 * 3600)                               # reaper did not run until long after expiry
    assert world.svc.run_reaper(REAPER)["notified"] == ["dev/sandbox"]
    world.clock.advance(10 * 60)
    assert world.svc.run_reaper(REAPER)["destroyed"] == []      # minimum notice (30 min) not yet over
    world.clock.advance(25 * 60)
    assert world.svc.run_reaper(REAPER)["destroyed"] == ["dev/sandbox"]


def test_extend_ttl_postpones_destruction_within_limit(world):
    world.apply(ALICE, world.plan(name="sandbox", ttl_hours=2)["plan_id"])
    world.clock.advance(1 * 3600)
    world.svc.run_reaper(REAPER)                                # notice sent
    out = world.svc.extend_ttl(BOB, "sandbox", 24, "dev")
    assert out["expires_in_hours"] == 25.0
    world.clock.advance(3 * 3600)                               # past the ORIGINAL expiry
    report = world.svc.run_reaper(REAPER)
    assert report["destroyed"] == [] and report["notified"] == ["dev/sandbox"]   # new expiry is <24h away: fresh notice
    with pytest.raises(Denied, match="more than 72 hours"):
        world.svc.extend_ttl(BOB, "sandbox", 100, "dev")
    with pytest.raises(Invalid):
        world.svc.extend_ttl(BOB, "sandbox", -5, "dev")


def test_reaper_works_even_when_destroy_is_disabled_for_users_but_respects_policy():
    envs = json.loads(json.dumps(ENVIRONMENTS))
    envs["dev"]["enable_destroy"] = False
    envs["dev"]["policy_profile"] = "strict"
    w = World(envs)
    w.apply(ALICE, w.plan(name="sandbox", ttl_hours=1, tags=PROD_TAGS)["plan_id"])
    with pytest.raises(Denied):
        w.svc.plan_destroy(ALICE, "sandbox", "dev")             # users still cannot destroy
    w.clock.advance(2 * 3600)
    w.svc.run_reaper(REAPER)
    w.clock.advance(3600)
    report = w.svc.run_reaper(REAPER)                           # storage accounts are protected under 'strict'
    assert report["destroyed"] == [] and "policy blocks the destroy" in report["failed"][0]["error"]
    assert w.notifications[-1]["type"] == "ttl_reap_failed" and w.svc.list_deployments("dev")["count"] == 1
    # with a template that has no protected resources the reaper may proceed although users cannot destroy
    w.tf.plan_builder = lambda tfvars, destroy: {"resource_changes": storage_plan(tfvars, destroy)["resource_changes"][:1]}
    assert w.svc.run_reaper(REAPER)["destroyed"] == ["dev/sandbox"]


def test_a_non_reaper_identity_cannot_use_the_reaper_bypass():
    envs = json.loads(json.dumps(ENVIRONMENTS))
    envs["dev"]["enable_destroy"] = False
    w = World(envs)
    w.apply(ALICE, w.plan(name="sandbox", ttl_hours=1)["plan_id"])
    plan = w.svc.plan_destroy(REAPER, "sandbox", "dev", origin="ttl-reaper", inline=True)["result"]
    with pytest.raises(Denied, match="Destroy is switched off"):
        w.svc.apply_plan(ALICE, plan["plan_id"])                # a user cannot apply the reaper's plan


# ------------------------------------------------------------------ drift
def test_drift_detection_single_and_all(world):
    world.apply(ALICE, world.plan(name="one")["plan_id"])
    world.apply(ALICE, world.plan(name="two")["plan_id"])
    op = world.svc.detect_drift(ALICE, "one", "dev")
    assert op["status"] == "succeeded" and op["result"]["drifted"] is False and "No drift" in op["result"]["summary"]
    world.tf.drift = [
        {"address": "azurerm_storage_account.this", "mode": "managed", "type": "azurerm_storage_account", "name": "this",
         "change": {"actions": ["update"], "before": {"min_tls_version": "TLS1_2", "id": "x", "tags": {"a": "1"}},
                    "after": {"min_tls_version": "TLS1_0", "id": "x", "tags": {"a": "1"}}}},
        {"address": "random_string.suffix", "mode": "managed", "type": "random_string", "name": "suffix",
         "change": {"actions": ["no-op"], "before": {}, "after": {}}}]
    batch = world.svc.detect_drift(BOB, None, "dev")
    assert sorted(s["deployment"] for s in batch["started"]) == ["one", "two"]
    for s in batch["started"]:
        for _ in range(500):
            if world.svc.get_operation(s["operation_id"])["status"] == "succeeded":
                break
            threading.Event().wait(0.01)
    result = world.svc.get_deployment("one", "dev")
    assert result["drift"]["drifted"] is True and result["drift_detail"]["changes"] == [
        {"resource": "azurerm_storage_account.this", "type": "azurerm_storage_account", "what": "changed outside Terraform",
         "changed_settings": ["min_tls_version"]}]
    assert any(c[:2] == ["plan", "-refresh-only"] for c in world.tf.calls) and "apply" not in [c[0] for c in world.tf.calls[-6:]]
    drift_events = world.events("drift")
    assert drift_events[-1]["drifted"] is True and drift_events[0]["drifted"] is False
    scan = world.svc.run_drift_scan(system_identity("drift-scan"))
    assert scan["checked"] == 2 and sorted(scan["drifted"]) == ["dev/one", "dev/two"]


# ------------------------------------------------------------------ configuration
def test_config_validation():
    base = {"SUBSCRIPTION_ID": "11111111-1111-1111-1111-111111111111", "STATE_SA": "st", "AUTH_MODE": "none"}
    v1 = Settings.from_env({**base, "WORKLOAD_RG": "rg-old", "ALLOWED_LOCATIONS": "eastus2, westus2", "ENABLE_APPLY": "true"})
    assert list(v1.environments) == ["dev"] and v1.environments["dev"].enable_apply and v1.environments["dev"].allowed_locations == ["eastus2", "westus2"]
    bad = [
        {"dev": {"resource_group": "rg", "allowed_locations": ["eastus2"], "require_approval": True, "allow_ephemeral": True}},
        {"dev": {"resource_group": "rg", "allowed_locations": []}},
        {"dev": {"resource_group": "rg", "allowed_locations": ["eastus2"], "typo_setting": 1}},
        {"Dev!": {"resource_group": "rg", "allowed_locations": ["eastus2"]}},
        {"dev": {"resource_group": "rg", "allowed_locations": ["eastus2"], "subscription_id": "nope"}},
        {},
    ]
    for envs in bad:
        with pytest.raises(ConfigError):
            Settings.from_env({**base, "ENVIRONMENTS_JSON": json.dumps(envs)})
    with pytest.raises(ConfigError, match="API_AUDIENCES"):
        Settings.from_env({**base, "AUTH_MODE": "jwt", "WORKLOAD_RG": "rg"})
    with pytest.raises(ConfigError):
        Settings.from_env({"STATE_SA": "st"})
    envs = json.loads(json.dumps(ENVIRONMENTS))
    envs["dev"]["policy_profile"] = "relaxed"
    with pytest.raises(ConfigError, match="policy profile 'relaxed'"):
        World(envs)
