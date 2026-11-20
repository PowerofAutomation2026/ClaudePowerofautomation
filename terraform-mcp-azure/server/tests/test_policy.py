import json
import pathlib

import pytest

from tfmcp.policy import PolicyEngine, PolicyError, action_kind, extract

POLICY = pathlib.Path(__file__).resolve().parent.parent / "policies" / "default.json"
engine = PolicyEngine.from_file(POLICY)
TAGS = {"managedBy": "azure-terraform-mcp", "environment": "dev", "owner": "alice", "deployment": "demo", "costCenter": "CC1"}


def rc(rtype, after=None, actions=("create",), before=None, name="this", unknown=None):
    return {"address": f"{rtype}.{name}", "mode": "managed", "type": rtype, "name": name,
            "change": {"actions": list(actions), "before": before, "after": after, "after_unknown": unknown or {}}}


def storage(**over):
    base = {"name": "st1", "location": "eastus2", "min_tls_version": "TLS1_2", "https_traffic_only_enabled": True,
            "allow_nested_items_to_be_public": False, "shared_access_key_enabled": False,
            "public_network_access_enabled": False, "tags": dict(TAGS)}
    base.update(over)
    return base


def run(changes, profile="standard", locations=("eastus2",), **kw):
    return engine.evaluate({"resource_changes": changes}, profile=profile, allowed_locations=list(locations), **kw)


def rules(result, kind="violations"):
    return sorted({f["rule"] for f in getattr(result, kind)})


def test_policy_file_is_valid_and_documented():
    doc = json.loads(POLICY.read_text())
    assert set(doc["profiles"]) == {"standard", "strict"}
    for rule in doc["rules"]:
        assert rule["description"], rule["id"]
    assert len(engine.describe("strict")) > len(engine.describe("standard")) - 1


def test_compliant_plan_passes_both_profiles():
    for profile in ("standard", "strict"):
        result = run([rc("azurerm_storage_account", storage())], profile)
        assert result.allowed and not result.violations and not result.warnings, result.as_dict()


def test_region_not_allowed():
    result = run([rc("azurerm_storage_account", storage(location="West Europe"))])
    assert rules(result) == ["allowed-regions"] and not result.allowed
    assert "not allowed in this environment" in result.violations[0]["message"]
    assert run([rc("azurerm_storage_account", storage(location="East US 2"))]).allowed   # display names are normalised


def test_mandatory_tags_differ_by_profile():
    tags = {k: v for k, v in TAGS.items() if k != "costCenter"}
    assert run([rc("azurerm_storage_account", storage(tags=tags))], "standard").allowed
    strict = run([rc("azurerm_storage_account", storage(tags=tags))], "strict")
    assert rules(strict) == ["mandatory-tags"] and "costCenter" in strict.violations[0]["message"]
    assert rules(run([rc("azurerm_storage_account", storage(tags=None))])) == ["mandatory-tags"]
    # resources without a tags attribute (subnets) and computed tags are not judged
    assert run([rc("azurerm_subnet", {"name": "s"})]).allowed
    assert run([rc("azurerm_storage_account", storage(tags=None), unknown={"tags": True})]).allowed


def test_public_blob_and_http_are_always_denied():
    result = run([rc("azurerm_storage_account", storage(allow_nested_items_to_be_public=True, https_traffic_only_enabled=False))])
    assert rules(result) == ["no-public-blob-access"] and len(result.violations) == 2
    assert "anonymous public access" in result.violations[0]["message"]


def test_tls_minimum():
    assert rules(run([rc("azurerm_storage_account", storage(min_tls_version="TLS1_0"))])) == ["minimum-tls-1-2"]
    web = {"name": "app", "location": "eastus2", "https_only": True, "public_network_access_enabled": False, "tags": TAGS,
           "site_config": [{"minimum_tls_version": "1.0"}]}
    result = run([rc("azurerm_linux_web_app", web)])
    assert rules(result) == ["minimum-tls-1-2"] and "site_config.minimum_tls_version" in result.violations[0]["message"]
    web["site_config"] = [{"minimum_tls_version": "1.3"}]
    assert run([rc("azurerm_linux_web_app", web)]).allowed


def test_public_network_access_warns_in_standard_and_blocks_in_strict():
    change = [rc("azurerm_key_vault", {"name": "kv", "location": "eastus2", "tags": TAGS, "public_network_access_enabled": True,
                                       "purge_protection_enabled": True, "rbac_authorization_enabled": True})]
    standard, strict = run(change, "standard"), run(change, "strict")
    assert standard.allowed and rules(standard, "warnings") == ["no-public-network-access"]
    assert not strict.allowed and rules(strict) == ["no-public-network-access"]


def test_protected_resources_cannot_be_deleted_or_replaced_in_strict():
    before = {"name": "sqldb", "tags": TAGS}
    delete = [rc("azurerm_mssql_database", None, ["delete"], before)]
    replace = [rc("azurerm_key_vault", {"name": "kv", "location": "eastus2", "tags": TAGS, "public_network_access_enabled": False,
                                        "purge_protection_enabled": True, "rbac_authorization_enabled": True}, ["delete", "create"], before)]
    assert rules(run(delete, "strict", is_destroy=True)) == ["protected-resources"]
    assert "would be deleted" in run(delete, "strict").violations[0]["message"]
    assert "destroyed and re-created" in run(replace, "strict").violations[0]["message"]
    assert run(delete, "standard").allowed and rules(run(delete, "standard"), "warnings") == ["protected-resources"]
    # unprotected types and in-place updates are fine
    assert run([rc("azurerm_subnet", None, ["delete"], {"name": "s"})], "strict").allowed
    assert run([rc("azurerm_mssql_database", {"name": "sqldb", "tags": TAGS}, ["update"], before)], "strict").allowed


def test_blast_radius_limit():
    many = [rc("azurerm_subnet", {"name": f"s{i}"}, name=f"s{i}") for i in range(31)]
    result = run(many)
    assert rules(result) == ["blast-radius"] and "31 resources" in result.violations[0]["message"]
    assert run(many[:30]).allowed
    assert rules(run(many[:16], "strict")) == ["blast-radius"]            # strict limit is 15
    assert rules(run(many[:5], max_changes_override=3)) == ["blast-radius"]   # per-environment override
    assert run(many, is_destroy=True).allowed                              # a full destroy is not a blast-radius case
    noop = [rc("azurerm_subnet", {"name": f"s{i}"}, ["no-op"], {"name": f"s{i}"}, name=f"s{i}") for i in range(50)]
    assert run(noop).allowed


def test_open_management_ports():
    def rule(**kw):
        base = {"name": "r", "direction": "Inbound", "access": "Allow", "source_address_prefix": "*",
                "destination_port_range": "22", "source_address_prefixes": None, "destination_port_ranges": None}
        base.update(kw)
        return base
    assert rules(run([rc("azurerm_network_security_rule", rule())])) == ["no-open-management-ports"]
    assert rules(run([rc("azurerm_network_security_rule", rule(destination_port_range="3000-4000", source_address_prefix="Internet"))])) == ["no-open-management-ports"]
    assert rules(run([rc("azurerm_network_security_rule", rule(destination_port_range="*", source_address_prefix="0.0.0.0/0"))])) == ["no-open-management-ports"]
    assert rules(run([rc("azurerm_network_security_rule", rule(destination_port_range=None, destination_port_ranges=["80", "3389"]))])) == ["no-open-management-ports"]
    inline = {"name": "nsg", "location": "eastus2", "tags": TAGS, "security_rule": [rule()]}
    assert rules(run([rc("azurerm_network_security_group", inline)])) == ["no-open-management-ports"]
    for safe in (rule(source_address_prefix="10.0.0.0/8"), rule(destination_port_range="443"), rule(access="Deny"),
                 rule(direction="Outbound")):
        assert run([rc("azurerm_network_security_rule", safe)]).allowed


def test_vm_size_password_and_public_ip_rules():
    vm = {"name": "vm", "location": "eastus2", "tags": TAGS, "size": "Standard_M128ms", "disable_password_authentication": False}
    assert rules(run([rc("azurerm_linux_virtual_machine", vm)])) == ["allowed-vm-sizes", "vm-ssh-keys-only"]
    pip = [rc("azurerm_public_ip", {"name": "pip", "location": "eastus2", "tags": TAGS})]
    assert rules(run(pip, "strict")) == ["no-public-ip"] and rules(run(pip, "standard"), "warnings") == ["no-public-ip"]
    aks = {"name": "aks", "location": "eastus2", "tags": TAGS, "private_cluster_enabled": False, "local_account_disabled": True,
           "default_node_pool": [{"vm_size": "Standard_NC24"}]}
    result = run([rc("azurerm_kubernetes_cluster", aks)], "strict")
    assert rules(result) == ["allowed-vm-sizes", "private-kubernetes-api"]


def test_entra_only_rule_handles_missing_blocks():
    sql = {"name": "sql", "location": "eastus2", "tags": TAGS, "minimum_tls_version": "1.2", "public_network_access_enabled": False,
           "azuread_administrator": []}
    result = run([rc("azurerm_mssql_server", sql)], "strict")
    assert rules(result) == ["entra-only-authentication"]          # no Entra admin block at all -> fail
    sql["azuread_administrator"] = [{"azuread_authentication_only": True}]
    assert run([rc("azurerm_mssql_server", sql)], "strict").allowed


def test_production_app_service_tier():
    plan = {"name": "asp", "location": "eastus2", "tags": TAGS, "sku_name": "B1"}
    assert run([rc("azurerm_service_plan", plan)], "standard").allowed
    assert rules(run([rc("azurerm_service_plan", plan)], "strict")) == ["production-app-service-tier"]
    plan["sku_name"] = "F1"
    assert rules(run([rc("azurerm_service_plan", plan)], "standard")) == ["allowed-app-service-skus"]


def test_unknown_values_are_not_judged_and_deletes_are_not_attribute_checked():
    unknown = [rc("azurerm_storage_account", storage(min_tls_version=None), unknown={"min_tls_version": True})]
    assert run(unknown).allowed
    deleted = [rc("azurerm_virtual_network", None, ["delete"], {"location": "mars"})]
    assert run(deleted).allowed
    data = [{"address": "data.x.y", "mode": "data", "type": "azurerm_storage_account", "name": "y",
             "change": {"actions": ["read"], "after": storage(location="mars")}}]
    assert run(data).allowed


def test_helpers():
    assert action_kind(["delete", "create"]) == "replace" and action_kind(["create", "delete"]) == "replace"
    assert action_kind(["no-op"]) == "no-op" and action_kind(["update"]) == "update"
    doc = {"a": [{"b": 1}, {"b": 2}], "c": {"d": "x"}}
    assert extract(doc, "a.b") == [1, 2] and extract(doc, "c.d") == ["x"] and extract(doc, "c.zzz") == []


def test_invalid_policy_documents_are_rejected():
    for bad in ({"profiles": {}, "rules": []},
                {"profiles": {"p": ""}, "rules": [{"id": "a", "type": "nope"}]},
                {"profiles": {"p": ""}, "rules": [{"id": "a", "type": "max_changes"}, {"id": "a", "type": "max_changes"}]},
                {"profiles": {"p": ""}, "rules": [{"id": "a", "type": "max_changes", "enforcement": "maybe"}]},
                {"profiles": {"p": ""}, "rules": [{"id": "a", "type": "max_changes", "enforcement": {"other": "deny"}}]},
                {"profiles": {"p": ""}, "rules": [{"id": "a", "type": "attribute", "checks": [{"attribute": "x"}]}]}):
        with pytest.raises(PolicyError):
            PolicyEngine(bad)
    with pytest.raises(PolicyError):
        engine.evaluate({"resource_changes": []}, profile="nope", allowed_locations=["eastus2"])
