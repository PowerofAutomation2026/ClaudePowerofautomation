"""Configuration: server settings and per-environment guardrails (dev / test / prod ...)."""
from __future__ import annotations

import base64
import json
import os
import pathlib
import re
from dataclasses import asdict, dataclass, field
from typing import Any, Mapping

ENV_NAME_RE = re.compile(r"^[a-z][a-z0-9]{1,11}$")
GUID_RE = re.compile(r"^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
LOCATION_RE = re.compile(r"^[a-z0-9]{3,30}$")
RG_RE = re.compile(r"^[-\w.()]{1,90}$")
WEEKDAYS = ("mon", "tue", "wed", "thu", "fri", "sat", "sun")
ROLES = ("viewer", "requester", "approver", "admin")


class ConfigError(ValueError):
    pass


def _bool(value: Any, default: bool = False) -> bool:
    if value is None or value == "":
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("1", "true", "yes", "on")


@dataclass
class EnvironmentConfig:
    """Guardrails for one target environment. Each environment is its own resource group
    (optionally in its own subscription) and its own Terraform state prefix."""

    name: str
    resource_group: str
    subscription_id: str
    allowed_locations: list[str]
    policy_profile: str = "standard"
    enable_apply: bool = False
    enable_destroy: bool = False
    require_approval: bool = False
    approver_group_ids: list[str] = field(default_factory=list)
    approver_object_ids: list[str] = field(default_factory=list)
    monthly_budget_usd: float | None = None
    budget_block_if_unknown: bool = False
    max_resource_changes: int | None = None
    allow_ephemeral: bool = False
    max_ttl_hours: int = 168
    plan_ttl_minutes: int | None = None
    allowed_templates: list[str] | None = None
    default_tags: dict[str, str] = field(default_factory=dict)
    # Every apply / destroy needs an OUT-OF-BAND approval. require_approval=True: by a different person.
    # allow_self_approval=True (only without require_approval): the requester may approve their own plan,
    # but still only on the approval page after a fresh sign-in - never through the agent.
    allow_self_approval: bool | None = None
    # Change windows (UTC). Empty = any time. Example: [{"days": ["mon","tue","wed","thu"], "start": "08:00", "end": "16:00"}]
    change_windows: list[dict] = field(default_factory=list)

    def __post_init__(self) -> None:
        if not ENV_NAME_RE.match(self.name):
            raise ConfigError(f"environment name '{self.name}' must match {ENV_NAME_RE.pattern}")
        if not RG_RE.match(self.resource_group or ""):
            raise ConfigError(f"environment '{self.name}': invalid resource_group")
        if not GUID_RE.match(self.subscription_id or ""):
            raise ConfigError(f"environment '{self.name}': subscription_id must be a GUID")
        if not self.allowed_locations or not all(LOCATION_RE.match(x) for x in self.allowed_locations):
            raise ConfigError(f"environment '{self.name}': allowed_locations must be a non-empty list of region names")
        if self.require_approval and self.allow_ephemeral:
            raise ConfigError(
                f"environment '{self.name}': allow_ephemeral and require_approval cannot both be true "
                "(the TTL reaper destroys without a human approval)")
        if self.allow_self_approval is None:
            self.allow_self_approval = not self.require_approval
        if self.require_approval and self.allow_self_approval:
            raise ConfigError(f"environment '{self.name}': require_approval (two-person) and allow_self_approval exclude each other")
        for w in self.change_windows:
            days = w.get("days") or list(WEEKDAYS)
            if not isinstance(w, dict) or set(w) - {"days", "start", "end"} or not set(days) <= set(WEEKDAYS) \
                    or not all(re.fullmatch(r"([01]\d|2[0-3]):[0-5]\d", str(w.get(k, ""))) for k in ("start", "end")) \
                    or w["start"] >= w["end"]:
                raise ConfigError(f"environment '{self.name}': invalid change window {w} "
                                  '(use {"days": ["mon",...], "start": "08:00", "end": "17:00"}, UTC, start < end)')
        if self.plan_ttl_minutes is None:
            # approvals take time: give approval environments a longer plan lifetime
            self.plan_ttl_minutes = 480 if self.require_approval else 60
        if not 5 <= int(self.plan_ttl_minutes) <= 1440:
            raise ConfigError(f"environment '{self.name}': plan_ttl_minutes must be 5-1440")
        if self.monthly_budget_usd is not None and float(self.monthly_budget_usd) < 0:
            raise ConfigError(f"environment '{self.name}': monthly_budget_usd must be >= 0")
        if not 1 <= int(self.max_ttl_hours) <= 24 * 90:
            raise ConfigError(f"environment '{self.name}': max_ttl_hours must be 1-2160")

    def public(self) -> dict:
        """What an agent may see about the environment."""
        d = asdict(self)
        d.pop("approver_object_ids")
        d.pop("approver_group_ids")
        d["approvers_restricted"] = bool(self.approver_group_ids or self.approver_object_ids)
        return d


_ENV_FIELDS = set(EnvironmentConfig.__dataclass_fields__)  # type: ignore[attr-defined]


def parse_environments(raw: Mapping[str, Any], default_subscription: str) -> dict[str, EnvironmentConfig]:
    if not isinstance(raw, Mapping) or not raw:
        raise ConfigError("environments must be a non-empty object of name -> settings")
    out: dict[str, EnvironmentConfig] = {}
    for name, cfg in raw.items():
        if not isinstance(cfg, Mapping):
            raise ConfigError(f"environment '{name}' must be an object")
        unknown = set(cfg) - _ENV_FIELDS
        if unknown:
            raise ConfigError(f"environment '{name}': unknown settings {sorted(unknown)}")
        data = dict(cfg)
        data.setdefault("subscription_id", default_subscription)
        data["name"] = name
        out[name] = EnvironmentConfig(**data)
    return out


@dataclass
class Settings:
    subscription_id: str            # subscription that holds the state storage account
    tenant_id: str
    state_account: str
    environments: dict[str, EnvironmentConfig]
    default_environment: str
    template_dir: pathlib.Path
    policy_file: pathlib.Path
    auth_mode: str = "jwt"          # jwt | easyauth | none
    api_audiences: list[str] = field(default_factory=list)
    sync_wait_seconds: float = 20.0
    max_concurrent_ops: int = 2
    lease_seconds: int = 120
    heartbeat_seconds: int = 20
    max_plan_attempts: int = 3
    ttl_notice_hours: float = 24.0
    ttl_min_notice_minutes: float = 30.0
    notify_webhook_url: str = ""
    cost_enabled: bool = True
    price_cache_hours: float = 24.0
    store_mode: str = "blob"        # blob | memory
    host: str = "0.0.0.0"
    port: int = 8080
    # --- process role: which half of the system this process is --------------------------------
    process_role: str = "all"       # frontend (MCP, read-only identity) | approval (approval page + executor) | all (local)
    # --- caller checks for the MCP endpoint ----------------------------------------------------
    rbac: str = "enforce"           # enforce | off (off: every authenticated caller is requester+viewer; local testing)
    role_groups: dict[str, list[str]] = field(default_factory=dict)   # role -> Entra group ids (alternative to app roles)
    allowed_client_ids: list[str] = field(default_factory=list)       # azp/appid allow-list (the connector app)
    required_scope: str = ""
    write_max_token_age_minutes: float = 75.0
    # --- out-of-band approval channel ----------------------------------------------------------
    approval_audiences: list[str] = field(default_factory=list)
    approval_client_ids: list[str] = field(default_factory=list)
    approval_scope: str = "approve"
    approval_max_auth_age_seconds: float = 600.0     # the approver must have signed in this recently
    approval_valid_minutes: float = 30.0             # an approval must be used within this time
    approval_require_amr: str = ""                   # e.g. "mfa" (v1 tokens) or an auth-context id such as "c1"
    approval_base_url: str = ""
    # --- limits, quotas, anomaly detection -----------------------------------------------------
    user_calls_per_minute: int = 60
    user_plans_per_hour: int = 30
    global_applies_per_hour: int = 20
    global_deletes_per_day: int = 25                 # resources deleted/replaced by applied plans, all users
    anomaly_denied_per_10min: int = 15               # per user -> auto-freeze
    anomaly_destroy_plans_per_hour: int = 6          # per user -> auto-freeze
    anomaly_plans_per_10min: int = 80                # all users -> auto-freeze
    integrity_check: bool = True
    # --- OAuth facade for Copilot Studio "Dynamic discovery" (front-end only) ---------------------
    connector_auth: str = "manual"          # dynamic: serve discovery metadata, /register, /authorize, /token
    public_base_url: str = ""               # https://<host> - URLs are built from this, never from the Host header
    connector_client_id: str = ""           # the pre-registered Entra connector app
    connector_client_secret: str = field(default="", repr=False)   # injected server-side at /token; never returned or logged
    redirect_uris: list[str] = field(default_factory=list)          # exact-match allow-list
    oauth_scope: str = ""                   # api://<api-app-id>/access_as_user
    entra_base_url: str = "https://login.microsoftonline.com"       # fixed; override only for local tests

    def env(self, name: str | None) -> EnvironmentConfig:
        name = name or self.default_environment
        if name not in self.environments:
            raise ConfigError(f"Unknown environment '{name}'. Choose from: {sorted(self.environments)}")
        return self.environments[name]

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        sub = env.get("SUBSCRIPTION_ID", "")
        if not GUID_RE.match(sub):
            raise ConfigError("SUBSCRIPTION_ID must be set to a subscription GUID")
        if not env.get("STATE_SA"):
            raise ConfigError("STATE_SA (state storage account name) must be set")

        raw: Any = None
        if env.get("ENVIRONMENTS_B64"):
            raw = json.loads(base64.b64decode(env["ENVIRONMENTS_B64"]).decode("utf-8-sig"))
        elif env.get("ENVIRONMENTS_JSON"):
            raw = json.loads(env["ENVIRONMENTS_JSON"])
        elif env.get("ENVIRONMENTS_FILE"):
            raw = json.loads(pathlib.Path(env["ENVIRONMENTS_FILE"]).read_text(encoding="utf-8-sig"))
        if raw is None:
            # v1-compatible single environment built from the old variables
            if not env.get("WORKLOAD_RG"):
                raise ConfigError("Set ENVIRONMENTS_B64 / ENVIRONMENTS_JSON / ENVIRONMENTS_FILE, or the v1 variable WORKLOAD_RG")
            raw = {"dev": {
                "resource_group": env["WORKLOAD_RG"],
                "allowed_locations": [x.strip() for x in env.get("ALLOWED_LOCATIONS", "eastus2").split(",") if x.strip()],
                "enable_apply": _bool(env.get("ENABLE_APPLY")),
                "enable_destroy": _bool(env.get("ENABLE_DESTROY")),
                "allow_ephemeral": _bool(env.get("ALLOW_EPHEMERAL")),
            }}
        environments = parse_environments(raw, sub)
        default_env = env.get("DEFAULT_ENVIRONMENT") or ("dev" if "dev" in environments else next(iter(environments)))
        if default_env not in environments:
            raise ConfigError(f"DEFAULT_ENVIRONMENT '{default_env}' is not a configured environment")

        auth_mode = env.get("AUTH_MODE", "jwt").lower()
        if auth_mode not in ("jwt", "easyauth", "none"):
            raise ConfigError("AUTH_MODE must be jwt, easyauth or none")
        audiences = [a.strip() for a in env.get("API_AUDIENCES", "").split(",") if a.strip()]
        tenant = env.get("TENANT_ID", "")
        if auth_mode == "jwt" and (not audiences or not GUID_RE.match(tenant)):
            raise ConfigError("AUTH_MODE=jwt needs TENANT_ID and API_AUDIENCES (use AUTH_MODE=none only for local testing)")

        def csv(name: str) -> list[str]:
            return [a.strip() for a in env.get(name, "").split(",") if a.strip()]

        role = env.get("TFMCP_ROLE", "all").lower()
        if role not in ("frontend", "approval", "all"):
            raise ConfigError("TFMCP_ROLE must be frontend, approval or all")
        role_groups: dict[str, list[str]] = {}
        if env.get("ROLE_GROUPS_B64"):
            role_groups = json.loads(base64.b64decode(env["ROLE_GROUPS_B64"]).decode("utf-8-sig"))
            if set(role_groups) - set(ROLES):
                raise ConfigError(f"ROLE_GROUPS_B64: roles must be among {ROLES}")
        if auth_mode == "jwt" and role in ("approval", "all") and env.get("APPROVAL_AUDIENCES") is None and role == "approval":
            raise ConfigError("TFMCP_ROLE=approval needs APPROVAL_AUDIENCES")
        connector_auth = env.get("CONNECTOR_AUTH", "manual").lower()
        if connector_auth not in ("dynamic", "manual"):
            raise ConfigError("CONNECTOR_AUTH must be dynamic or manual")
        base = env.get("PUBLIC_BASE_URL", "").rstrip("/")
        if not base and env.get("CONTAINER_APP_NAME") and env.get("CONTAINER_APP_ENV_DNS_SUFFIX"):
            base = f"https://{env['CONTAINER_APP_NAME']}.{env['CONTAINER_APP_ENV_DNS_SUFFIX']}"   # set by Container Apps
        redirects = csv("REDIRECT_URIS") or ["https://global.consent.azure-apim.net/redirect"]
        entra = env.get("ENTRA_BASE_URL", "https://login.microsoftonline.com").rstrip("/")
        if connector_auth == "dynamic" and role in ("frontend", "all"):
            local = re.match(r"^http://(127\.0\.0\.1|localhost)(:\d+)?$", base)
            if auth_mode != "jwt":
                raise ConfigError("CONNECTOR_AUTH=dynamic needs AUTH_MODE=jwt (the server itself must validate tokens)")
            if not (re.match(r"^https://[A-Za-z0-9.-]+(:\d+)?$", base) or local):
                raise ConfigError("CONNECTOR_AUTH=dynamic needs PUBLIC_BASE_URL=https://<public host> (no path)")
            for key in ("CONNECTOR_CLIENT_ID", "CONNECTOR_CLIENT_SECRET", "OAUTH_SCOPE"):
                if not env.get(key):
                    raise ConfigError(f"CONNECTOR_AUTH=dynamic needs {key}")
            for uri in redirects:
                if not re.match(r"^https://[A-Za-z0-9.-]+(:\d+)?(/[A-Za-z0-9._~/-]*)?$", uri) and not (local and uri.startswith("http://127.0.0.1")):
                    raise ConfigError(f"REDIRECT_URIS: '{uri}' must be an exact https URL without wildcard, query or fragment")
        here = pathlib.Path(__file__).resolve().parent.parent
        return cls(
            connector_auth=connector_auth, public_base_url=base, connector_client_id=env.get("CONNECTOR_CLIENT_ID", ""),
            connector_client_secret=env.get("CONNECTOR_CLIENT_SECRET", ""), redirect_uris=redirects,
            oauth_scope=env.get("OAUTH_SCOPE", ""), entra_base_url=entra,
            process_role=role,
            rbac=env.get("RBAC", "enforce").lower(),
            role_groups={k: [g.lower() for g in v] for k, v in role_groups.items()},
            allowed_client_ids=csv("ALLOWED_CLIENT_IDS"),
            required_scope=env.get("REQUIRED_SCOPE", ""),
            write_max_token_age_minutes=float(env.get("WRITE_MAX_TOKEN_AGE_MINUTES", "75")),
            approval_audiences=csv("APPROVAL_AUDIENCES"),
            approval_client_ids=csv("APPROVAL_CLIENT_IDS"),
            approval_scope=env.get("APPROVAL_SCOPE", "approve"),
            approval_max_auth_age_seconds=float(env.get("APPROVAL_MAX_AUTH_AGE_SECONDS", "600")),
            approval_valid_minutes=float(env.get("APPROVAL_VALID_MINUTES", "30")),
            approval_require_amr=env.get("APPROVAL_REQUIRE_AMR", ""),
            approval_base_url=env.get("APPROVAL_BASE_URL", "").rstrip("/"),
            user_calls_per_minute=int(env.get("USER_CALLS_PER_MINUTE", "60")),
            user_plans_per_hour=int(env.get("USER_PLANS_PER_HOUR", "30")),
            global_applies_per_hour=int(env.get("GLOBAL_APPLIES_PER_HOUR", "20")),
            global_deletes_per_day=int(env.get("GLOBAL_DELETES_PER_DAY", "25")),
            anomaly_denied_per_10min=int(env.get("ANOMALY_DENIED_PER_10MIN", "15")),
            anomaly_destroy_plans_per_hour=int(env.get("ANOMALY_DESTROY_PLANS_PER_HOUR", "6")),
            anomaly_plans_per_10min=int(env.get("ANOMALY_PLANS_PER_10MIN", "80")),
            integrity_check=_bool(env.get("INTEGRITY_CHECK", "true"), True),
            subscription_id=sub,
            tenant_id=tenant,
            state_account=env["STATE_SA"],
            environments=environments,
            default_environment=default_env,
            template_dir=pathlib.Path(env.get("TEMPLATE_DIR", str(here / "templates"))),
            policy_file=pathlib.Path(env.get("POLICY_FILE", str(here / "policies" / "default.json"))),
            auth_mode=auth_mode,
            api_audiences=audiences,
            sync_wait_seconds=float(env.get("SYNC_WAIT_SECONDS", "20")),
            max_concurrent_ops=int(env.get("MAX_CONCURRENT_OPS", "2")),
            lease_seconds=int(env.get("LEASE_SECONDS", "120")),
            heartbeat_seconds=int(env.get("HEARTBEAT_SECONDS", "20")),
            ttl_notice_hours=float(env.get("TTL_NOTICE_HOURS", "24")),
            ttl_min_notice_minutes=float(env.get("TTL_MIN_NOTICE_MINUTES", "30")),
            notify_webhook_url=env.get("NOTIFY_WEBHOOK_URL", ""),
            cost_enabled=_bool(env.get("COST_ESTIMATES", "true"), True),
            price_cache_hours=float(env.get("PRICE_CACHE_HOURS", "24")),
            store_mode=env.get("STORE_MODE", "blob").lower(),
            host=env.get("HOST", "0.0.0.0"),
            port=int(env.get("PORT", "8080")),
        )
