"""Shared fixtures: an in-memory store, a controllable clock and a fake Terraform runner.
No test needs Azure, the network or the terraform binary."""
from __future__ import annotations

import io
import json
import pathlib
import sys
import threading

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from tfmcp.approvals import ApprovalService  # noqa: E402
from tfmcp.audit import AuditLog  # noqa: E402
from tfmcp.guard import Guard  # noqa: E402
from tfmcp.catalog import Catalog  # noqa: E402
from tfmcp.config import Settings  # noqa: E402
from tfmcp.cost import CostEstimator, PriceClient  # noqa: E402
from tfmcp.identity import Identity  # noqa: E402
from tfmcp.operations import OperationEngine  # noqa: E402
from tfmcp.policy import PolicyEngine  # noqa: E402
from tfmcp.service import Service  # noqa: E402
from tfmcp.storage import MemoryStore  # noqa: E402
from tfmcp.terraform import Cancelled  # noqa: E402

SUB = "11111111-1111-1111-1111-111111111111"
TENANT = "22222222-2222-2222-2222-222222222222"
ALICE = Identity(oid="aaaaaaaa-0000-0000-0000-000000000001", name="alice@contoso.com", source="easyauth", roles=("requester",))
BOB = Identity(oid="bbbbbbbb-0000-0000-0000-000000000002", name="bob@contoso.com", source="easyauth", roles=("requester", "approver"))
CAROL = Identity(oid="cccccccc-0000-0000-0000-000000000003", name="carol@contoso.com", source="easyauth", roles=("approver",),
                 groups=("99999999-0000-0000-0000-000000000009",))
ADMIN = Identity(oid="dddddddd-0000-0000-0000-00000000000d", name="admin@contoso.com", source="easyauth", roles=("admin",))
VIEWER = Identity(oid="eeeeeeee-0000-0000-0000-00000000000e", name="viewer@contoso.com", source="easyauth", roles=("viewer",))
NOBODY = Identity(oid="ffffffff-0000-0000-0000-00000000000f", name="nobody@contoso.com", source="easyauth")

ENVIRONMENTS = {
    "dev": {"resource_group": "rg-x-dev", "allowed_locations": ["eastus2", "westus2"], "enable_apply": True,
            "enable_destroy": True, "allow_ephemeral": True, "max_ttl_hours": 72},
    "test": {"resource_group": "rg-x-test", "allowed_locations": ["eastus2"], "enable_apply": False},
    "prod": {"resource_group": "rg-x-prod", "allowed_locations": ["eastus2"], "policy_profile": "strict",
             "enable_apply": True, "enable_destroy": True, "require_approval": True, "monthly_budget_usd": 500,
             "subscription_id": "33333333-3333-3333-3333-333333333333"},
}


class Clock:
    def __init__(self, now: float = 1_800_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def storage_plan(tfvars: dict, destroy: bool = False, **overrides) -> dict:
    """A realistic `terraform show -json` document for the storage-account template."""
    values = {"name": "stdemo123456", "location": tfvars["location"], "resource_group_name": tfvars["resource_group_name"],
              "account_tier": tfvars.get("account_tier", "Standard"), "account_replication_type": tfvars.get("replication_type", "ZRS"),
              "min_tls_version": "TLS1_2", "https_traffic_only_enabled": True, "allow_nested_items_to_be_public": False,
              "shared_access_key_enabled": tfvars.get("shared_access_key_enabled", False),
              "public_network_access_enabled": tfvars.get("public_network_access_enabled", False), "tags": tfvars["tags"]}
    values.update(overrides)
    change = ({"actions": ["delete"], "before": values, "after": None, "after_unknown": {}, "before_sensitive": {}, "after_sensitive": False}
              if destroy else
              {"actions": ["create"], "before": None, "after": values, "after_unknown": {"id": True, "primary_access_key": True},
               "before_sensitive": False, "after_sensitive": {"primary_access_key": True}})
    return {"format_version": "1.2", "terraform_version": "1.9.8",
            "resource_changes": [
                {"address": "random_string.suffix", "mode": "managed", "type": "random_string", "name": "suffix",
                 "change": {"actions": ["delete" if destroy else "create"], "before": {"length": 6} if destroy else None,
                            "after": None if destroy else {"length": 6}, "after_unknown": {}}},
                {"address": "azurerm_storage_account.this", "mode": "managed", "type": "azurerm_storage_account", "name": "this",
                 "change": change}],
            "output_changes": {"storage_account_name": {"actions": ["create"]}}}


class FakeTerraform:
    """Stands in for the terraform binary. Records every call; plans come from ``plan_builder``."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.plan_builder = storage_plan
        self.drift: list[dict] = []
        self.fail: dict[str, str] = {}            # command -> error text
        self.block: dict[str, threading.Event] = {}   # command -> event that releases it
        self.entered: dict[str, threading.Event] = {}
        self.applied: list[dict] = []
        self.state: dict[str, dict] = {}           # state key is not visible to the fake: keyed by deployment name
        self.no_changes = False

    def run(self, args, cwd, *, env=None, timeout=0, cancel=None):
        cwd = pathlib.Path(cwd)
        cmd = args[0]
        self.calls.append(list(args))
        if cmd in self.entered:
            self.entered[cmd].set()
        if cmd in self.block:
            while not self.block[cmd].wait(0.01):
                if cancel is not None and cancel.is_set():
                    raise Cancelled(f"terraform {cmd} cancelled")
        if cmd in self.fail:
            return 1, "Error: " + self.fail[cmd]
        tfvars = json.loads((cwd / "terraform.tfvars.json").read_text())
        name = tfvars["deployment_name"]
        if cmd == "init":
            assert any(a.startswith("-backend-config=key=") for a in args)
            assert (cwd / "common.tf").exists() and (cwd / "main.tf").exists()
            return 0, "Terraform has been successfully initialized!"
        if cmd == "plan":
            out = next(a.split("=", 1)[1] for a in args if a.startswith("-out="))
            if "-refresh-only" in args:
                doc = {"format_version": "1.2", "resource_changes": [], "resource_drift": self.drift}
                (cwd / out).write_text(json.dumps(doc))
                return (2 if self.drift else 0), "refresh-only plan"
            destroy = "-destroy" in args
            doc = self.plan_builder(tfvars, destroy)
            if self.no_changes:
                doc["resource_changes"] = []
            (cwd / out).write_text(json.dumps(doc))
            return (0 if self.no_changes else 2), "Plan: created"
        if cmd == "show":
            if args[-1] == "-json":   # state
                return 0, json.dumps(self.state.get(name, {"values": {"root_module": {"resources": []}}}))
            return 0, "Warning: something harmless\n" + (cwd / args[-1]).read_text()
        if cmd == "apply":
            doc = json.loads((cwd / args[-1]).read_text())
            destroy = any(rc["change"]["actions"] == ["delete"] for rc in doc["resource_changes"])
            self.applied.append({"deployment": name, "destroy": destroy, "tfvars": tfvars})
            if destroy:
                self.state.pop(name, None)
            else:
                self.state[name] = {"values": {"root_module": {"resources": [
                    {"address": "azurerm_storage_account.this", "mode": "managed", "type": "azurerm_storage_account",
                     "name": "this", "values": {"id": f"/subscriptions/x/resourceGroups/{tfvars['resource_group_name']}/providers/Microsoft.Storage/storageAccounts/st{name}",
                                                "primary_access_key": "SECRET"}}]}}}
            return 0, "Apply complete!"
        if cmd == "output":
            return 0, json.dumps({"storage_account_name": {"value": f"st{name}", "sensitive": False},
                                  "secret": {"value": "hunter2", "sensitive": True}})
        raise AssertionError(f"unexpected terraform command {args}")

    def commands(self) -> list[str]:
        return [c[0] for c in self.calls]


def make_settings(environments=None, **over) -> Settings:
    import base64
    env = {"SUBSCRIPTION_ID": SUB, "TENANT_ID": TENANT, "STATE_SA": "stfake", "AUTH_MODE": "easyauth",
           "ENVIRONMENTS_B64": base64.b64encode(json.dumps(environments or ENVIRONMENTS).encode()).decode(),
           "SYNC_WAIT_SECONDS": "10"}
    env.update(over)
    return Settings.from_env(env)


class World:
    """Everything a service test needs, wired with fakes."""

    def __init__(self, environments=None, price_fetch=None, **settings_over) -> None:
        self.clock = Clock()
        self.data, self.state, self.audit_store, self.control = MemoryStore(), MemoryStore(), MemoryStore(), MemoryStore()
        self.log = io.StringIO()
        self.audit = AuditLog(self.audit_store, stream=self.log, clock=self.clock)
        self.tf = FakeTerraform()
        self.settings = make_settings(environments, **settings_over)
        self.price_calls: list[dict] = []
        self.price_fetch = price_fetch or self._no_prices
        self.engine = OperationEngine(self.data, state_store=self.state, clock=self.clock, lease_seconds=120,
                                      heartbeat_seconds=3600, max_workers=4, log=self.audit.emit, owner="worker-a")
        self.notifications: list[dict] = []
        policy = PolicyEngine.from_file(self.settings.policy_file)
        self.guard = Guard(self.settings, self.data, self.control, clock=self.clock, emit=self.audit.emit)

        def announce(event):
            self.audit.emit(event)
            self.notifications.append(event)
        self.approvals = ApprovalService(self.settings, data=self.data, control=self.control, policy=policy, guard=self.guard,
                                         clock=self.clock, notify=announce)
        self.svc = Service(self.settings, data=self.data, state=self.state, audit=self.audit,
                           catalog=Catalog(self.settings.template_dir), policy=policy,
                           cost=CostEstimator(PriceClient(cache=self.data, fetch=self._fetch, clock=self.clock)),
                           tf=self.tf, engine=self.engine, control=self.control, guard=self.guard, approvals=self.approvals,
                           clock=self.clock, notify=self.notifications.append)

    def _fetch(self, url, params):
        self.price_calls.append(params)
        return self.price_fetch(url, params)

    @staticmethod
    def _no_prices(url, params):
        return {"Items": [], "NextPageLink": None}

    def events(self, type_: str | None = None) -> list[dict]:
        out = [json.loads(line) for line in self.log.getvalue().splitlines() if line.strip()]
        return [e for e in out if type_ is None or e.get("type") == type_]

    def plan(self, who=ALICE, template="storage-account", name="demo", environment="dev", **kw) -> dict:
        op = self.svc.plan_deployment(who, template, name, kw.pop("variables", None), environment, **kw)
        assert op["status"] == "succeeded", op
        return op["result"]

    def fresh(self, who: Identity, age: float = 30.0, **over) -> Identity:
        """The same person as seen by the approval channel: a token for the approval audience, signed in just now."""
        import dataclasses
        return dataclasses.replace(who, source="jwt", issued_at=self.clock() - age, auth_time=self.clock() - age, **over)

    def decide(self, who: Identity, plan_id: str, approve: bool = True, comment: str = "ok", digest: str | None = None) -> dict:
        who = who if who.source == "jwt" else self.fresh(who)
        if digest is None:
            digest = self.approvals.view(who, plan_id)["changes_digest"]
        return self.approvals.decide(who, plan_id, approve, comment, digest)

    def approve(self, requester: Identity, plan_id: str, approver: Identity | None = None) -> dict:
        """request_approval through the agent channel + decision on the out-of-band channel."""
        self.svc.request_approval(requester, plan_id, "Needed for the test scenario, CHG-1")
        return self.decide(approver or requester, plan_id)

    def apply(self, who, plan_id, approver: Identity | None = None) -> dict:
        self.approve(who, plan_id, approver)
        op = self.svc.apply_plan(who, plan_id)
        assert op["status"] == "succeeded", op
        return op["result"]


@pytest.fixture
def world() -> World:
    return World()


@pytest.fixture
def clock() -> Clock:
    return Clock()


# ---------------------------------------------------------------- real signed tokens for the HTTP tests
CONNECTOR = "c0c0c0c0-0000-0000-0000-00000000c0c0"       # the Copilot Studio connector app (client of the MCP API)
APPROVAL_SPA = "a9a9a9a9-0000-0000-0000-00000000a9a9"    # the approval page's own client id
MCP_AUD, APPROVAL_AUD = "api://mcp-api", "api://approval-api"
_KEYS = {}


def signing_key():
    if not _KEYS:
        import jwt
        from cryptography.hazmat.primitives.asymmetric import rsa
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key()))
        jwk.update(kid="test-key", use="sig")
        _KEYS.update(key=key, jwks={"keys": [jwk]})
    return _KEYS["key"], _KEYS["jwks"]


def mint(who: Identity, *, aud=MCP_AUD, azp=CONNECTOR, scp="access_as_user", age=10, auth_age=None, roles=None, **claims) -> str:
    import time

    import jwt
    now = int(time.time())
    body = {"aud": aud, "iss": f"https://login.microsoftonline.com/{TENANT}/v2.0", "tid": TENANT, "oid": who.oid,
            "preferred_username": who.name, "azp": azp, "scp": scp, "iat": now - age, "nbf": now - age, "exp": now + 3600,
            "roles": list(who.roles if roles is None else roles), "auth_time": now - (age if auth_age is None else auth_age)}
    body.update(claims)
    return jwt.encode({k: v for k, v in body.items() if v is not None}, signing_key()[0], algorithm="RS256", headers={"kid": "test-key"})


def jwt_settings(environments=None, **over) -> Settings:
    return make_settings(environments, AUTH_MODE="jwt", API_AUDIENCES=MCP_AUD, ALLOWED_CLIENT_IDS=CONNECTOR,
                         REQUIRED_SCOPE="access_as_user", APPROVAL_AUDIENCES=APPROVAL_AUD, APPROVAL_CLIENT_IDS=APPROVAL_SPA,
                         APPROVAL_BASE_URL="https://approve.example", **over)
