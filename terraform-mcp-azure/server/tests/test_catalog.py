import json
import pathlib
import re

import pytest

from tfmcp.catalog import (RESERVED_VARIABLES, Catalog, CatalogError, ValidationError, check_schema,
                           validate_deployment_name, validate_tags)

TEMPLATES = pathlib.Path(__file__).resolve().parent.parent / "templates"
SUBNET = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/v1/subnets/app"
catalog = Catalog(TEMPLATES)
EXPECTED = {"storage-account", "virtual-network", "hub-network", "log-analytics", "app-service", "key-vault", "sql-database",
            "postgres-flexible", "aks-cluster", "container-registry", "private-endpoint", "network-security-group",
            "linux-vm", "cosmos-db", "service-bus"}


def errors(template, variables):
    with pytest.raises(ValidationError) as e:
        catalog.validate_variables(template, variables)
    return " | ".join(e.value.errors)


def test_catalog_contains_the_enterprise_templates():
    assert set(catalog.names()) == EXPECTED


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_schema_matches_terraform_variables(name):
    """Every schema variable is declared in main.tf and every main.tf variable is in the schema."""
    spec = catalog.get(name)
    declared = set(re.findall(r'^variable "([a-z0-9_]+)"', (TEMPLATES / name / "main.tf").read_text(), re.M))
    assert declared == set(spec["variables"]), f"{name}: schema and main.tf disagree"
    assert not declared & RESERVED_VARIABLES
    assert spec["title"] and spec["description"] and spec["category"]
    for var, schema in spec["variables"].items():
        assert schema.get("description"), f"{name}.{var} needs a description"


@pytest.mark.parametrize("name", sorted(EXPECTED))
def test_schema_defaults_match_terraform_defaults(name):
    """A default in template.json must equal the default in main.tf (simple literals), so the plan the user
    is told about is the plan Terraform builds."""
    text = (TEMPLATES / name / "main.tf").read_text()
    for var, schema in catalog.get(name)["variables"].items():
        block = re.search(r'^variable "%s" \{(.*?)^\}' % var, text, re.M | re.S).group(1)
        m = re.search(r"^\s*default\s*=\s*(.+)$", block, re.M)
        if schema.get("required"):
            assert m is None, f"{name}.{var}: required in schema but has a Terraform default"
            continue
        assert m is not None, f"{name}.{var}: optional variables need a Terraform default"
        literal = m.group(1).strip()
        if literal in ("null",) or literal.startswith(("[", "{")):
            continue
        assert json.loads(literal) == schema.get("default"), f"{name}.{var}: default differs between schema and main.tf"


def test_common_file_declares_injected_variables():
    declared = set(re.findall(r'^variable "([a-z0-9_]+)"', (TEMPLATES / "_common" / "common.tf").read_text(), re.M))
    assert declared == RESERVED_VARIABLES
    text = (TEMPLATES / "_common" / "common.tf").read_text()
    assert 'resource_provider_registrations = "none"' in text and "use_msi" in text


def test_defaults_are_applied_and_types_kept():
    out = catalog.validate_variables("storage-account", {"replication_type": "GRS"})
    assert out["replication_type"] == "GRS" and out["account_tier"] == "Standard"
    assert out["public_network_access_enabled"] is False and out["soft_delete_days"] == 14


def test_unknown_variable_is_rejected():
    assert "is not a supported setting" in errors("storage-account", {"allow_blob_public_access": True})


def test_enum_is_enforced():
    assert "must be one of" in errors("storage-account", {"replication_type": "SUPER"})


def test_types_are_enforced_strictly():
    assert "must be true or false" in errors("storage-account", {"versioning_enabled": "yes"})
    assert "must be a whole number" in errors("storage-account", {"soft_delete_days": "14"})
    assert "must be a whole number" in errors("storage-account", {"soft_delete_days": True})
    assert "must be a whole number" in errors("storage-account", {"soft_delete_days": 1.5})
    assert "must be a list" in errors("storage-account", {"containers": "data"})


def test_ranges_are_enforced():
    assert ">= 30" in errors("log-analytics", {"retention_days": 7})
    assert "<= 730" in errors("log-analytics", {"retention_days": 9999})
    assert "<= 5" in errors("aks-cluster", {"admin_group_object_ids": ["11111111-1111-1111-1111-111111111111"], "node_count": 50})


def test_required_variables():
    msg = errors("sql-database", {})
    assert "entra_admin_login: is required" in msg and "entra_admin_object_id: is required" in msg


def test_formats():
    assert "not a valid CIDR" in errors("virtual-network", {"address_space": ["10.0.0.0"]})
    assert "not a valid CIDR" in errors("virtual-network", {"subnets": {"app": "10.0.0.1/24"}})   # host bits set
    assert "must be a GUID" in errors("sql-database", {"entra_admin_login": "dba", "entra_admin_object_id": "not-a-guid"})
    assert "full Azure resource ID" in errors("private-endpoint", {"target_resource_id": "kv1", "subresource": "vault", "subnet_id": SUBNET})
    wrong_type = SUBNET.replace("virtualNetworks/v1/subnets/app", "networkSecurityGroups/n1")
    assert "must be the resource ID of a Microsoft.Network/virtualNetworks/subnets" in errors(
        "linux-vm", {"subnet_id": wrong_type, "admin_ssh_public_key": "ssh-ed25519 " + "A" * 68})
    assert "SSH PUBLIC key" in errors("linux-vm", {"subnet_id": SUBNET, "admin_ssh_public_key": "-----BEGIN OPENSSH " + "PRIVATE KEY-----"})
    ok = catalog.validate_variables("linux-vm", {"subnet_id": SUBNET, "admin_ssh_public_key": "ssh-ed25519 " + "A" * 68 + " me@host"})
    assert ok["size"] == "Standard_B2s"


def test_pattern_blocks_injection_in_names():
    assert "does not match" in errors("storage-account", {"containers": ["Bad Name; rm -rf"]})
    assert "does not match" in errors("sql-database", {"entra_admin_login": "dba", "entra_admin_object_id": "11111111-1111-1111-1111-111111111111",
                                                       "database_name": "x\"; drop"})


def test_nested_object_list_validation_and_defaults():
    rule = {"name": "allow-https", "priority": 200, "direction": "Inbound", "access": "Allow",
            "source_address_prefix": "10.0.0.0/8", "destination_port_range": "443"}
    out = catalog.validate_variables("network-security-group", {"rules": [rule]})
    assert out["rules"][0]["protocol"] == "Tcp" and out["rules"][0]["destination_address_prefix"] == "*"
    msg = errors("network-security-group", {"rules": [{**rule, "priority": 5, "bogus": 1}]})
    assert "rules[0].priority: must be >= 100" in msg and "rules[0].bogus" in msg
    assert "rules[0].name: is required" in errors("network-security-group", {"rules": [{k: v for k, v in rule.items() if k != "name"}]})


def test_map_keys_and_limits():
    assert "key 'bad name!'" in errors("virtual-network", {"subnets": {"bad name!": "10.20.0.0/24"}})
    many = {f"s{i}": f"10.20.{i}.0/24" for i in range(30)}
    assert "at most 20" in errors("virtual-network", {"subnets": many})


def test_variables_must_be_an_object():
    with pytest.raises(ValidationError):
        catalog.validate_variables("storage-account", ["a"])
    with pytest.raises(ValidationError):
        catalog.get("no-such-template")


@pytest.mark.parametrize("name", ["ab", "Demo", "demo_1", "-demo", "demo-", "a" * 21, "de--mo", "1demo", 5, None])
def test_bad_deployment_names(name):
    with pytest.raises(ValidationError):
        validate_deployment_name(name)


def test_good_deployment_names_and_tags():
    assert validate_deployment_name("payments-api-01") == "payments-api-01"
    assert validate_tags({"costCenter": "CC-1234"}) == {"costCenter": "CC-1234"}
    with pytest.raises(ValidationError):
        validate_tags({"bad key!": "x"})
    with pytest.raises(ValidationError):
        validate_tags({"k": "<script>"})


def test_schema_checker_rejects_bad_schemas():
    with pytest.raises(CatalogError):
        check_schema({"type": "strnig"}, "x")
    with pytest.raises(CatalogError):
        check_schema({"type": "integer", "minimum": 5, "default": 1}, "x")
    with pytest.raises(CatalogError):
        check_schema({"type": "string", "required": True, "default": "a"}, "x")
    with pytest.raises(CatalogError):
        check_schema({"type": "string", "colour": "red"}, "x")


def test_reserved_variable_in_schema_is_rejected(tmp_path):
    t = tmp_path / "bad"
    t.mkdir()
    (t / "template.json").write_text(json.dumps({"version": "1.0.0", "title": "t", "description": "d", "category": "c",
                                                 "variables": {"location": {"type": "string"}}}))
    with pytest.raises(CatalogError):
        Catalog(tmp_path)


def test_summary_and_describe_expose_schema():
    full = catalog.describe("key-vault")[0]
    assert full["variables"]["sku_name"]["enum"] == ["standard", "premium"]
    assert "security_defaults" in full and "content_hash" not in full
    summary = {s["name"]: s for s in catalog.summary()}
    assert summary["sql-database"]["required_variables"] == ["entra_admin_login", "entra_admin_object_id"]
