"""Business logic behind the MCP tools. No MCP, HTTP or Azure SDK imports here: storage, the
Terraform runner, the price client and the clock are injected, so all of this is unit-tested."""
from __future__ import annotations

import hashlib
import json
import pathlib
import re
import tempfile
import time
import uuid
from typing import Any, Callable

from .approvals import ApprovalError, ApprovalService, changes_digest, count_deletes
from .audit import AuditLog
from .catalog import Catalog, ValidationError, validate_deployment_name, validate_tags
from .config import ROLES, ConfigError, EnvironmentConfig, Settings
from .cost import CostEstimator, budget_check
from .explain import changed_attributes, explain
from .guard import Guard, GuardError
from .identity import Identity
from .sanitize import clean_error
from .operations import Busy, OpContext, OperationEngine, OperationFailed, iso, short_etag
from .policy import PolicyEngine, action_kind, norm_location
from .storage import Conflict, NotFound, Store, iter_json
from .terraform import (Cancelled, TerraformRunner, backend_args, prepare_workdir, public_outputs, slim_plan,
                        state_resources)

ID_RE = re.compile(r"^[0-9a-f]{12}$")
MANAGED_BY = "azure-terraform-mcp"


class ToolError(Exception):
    """A user-facing refusal or problem. ``kind`` is used as the audit outcome."""
    kind = "error"


class Denied(ToolError):
    kind = "denied"


class Invalid(ToolError):
    kind = "invalid"


def parse_json_output(output: str) -> Any:
    """Terraform prints one JSON document; tolerate warning lines around it."""
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("{"):
            try:
                return json.loads(line)
            except ValueError:
                continue
    start = output.find("{")
    if start >= 0:
        return json.JSONDecoder().raw_decode(output[start:])[0]
    raise OperationFailed("Terraform returned no JSON output:\n" + output[-1500:])


def clean_tf_error(output: str) -> str:
    """Terraform/Azure text is untrusted and may contain secrets: one line, redacted, capped."""
    return clean_error(output)


class Service:
    def __init__(self, settings: Settings, *, data: Store, state: Store, audit: AuditLog, catalog: Catalog,
                 policy: PolicyEngine, cost: CostEstimator, tf: TerraformRunner, engine: OperationEngine,
                 control: Store, guard: Guard, approvals: ApprovalService | None = None,
                 clock: Callable[[], float] = time.time, notify: Callable[[dict], None] | None = None) -> None:
        self.s = settings
        self.data = data
        self.state = state
        self.audit = audit
        self.catalog = catalog
        self.policy = policy
        self.cost = cost
        self.tf = tf
        self.engine = engine
        self.control = control          # trusted store: approvals, protection flags, admin freeze, quotas
        self.guard = guard
        self.approvals = approvals      # only in the privileged (approval/executor) process
        self.clock = clock
        self._notify_hook = notify
        for env in settings.environments.values():
            if not policy.has_profile(env.policy_profile):
                raise ConfigError(f"environment '{env.name}': policy profile '{env.policy_profile}' is not defined in the "
                                  f"policy file (profiles: {policy.profiles})")
            for t in env.allowed_templates or []:
                if t not in catalog.names():
                    raise ConfigError(f"environment '{env.name}': allowed_templates names unknown template '{t}'")
        if settings.process_role in ("frontend", "all"):
            engine.register("plan", self._op_plan, retryable=True)
            engine.register("drift", self._op_drift, retryable=True)
        if settings.process_role in ("approval", "all"):
            if approvals is None:
                raise ConfigError("the approval/executor process needs an ApprovalService")
            engine.register("apply", self._op_apply, retryable=False)   # ONLY the privileged process applies
            if settings.process_role == "approval":
                # the TTL reaper (a privileged job) plans its own destroys; user plans are never adopted here
                engine.register("plan", self._op_plan, retryable=True, adopt=False)
        engine.accept("plan", "drift", "apply")

    # ================================================================== access control (server-side, per call)
    def roles_of(self, identity: Identity) -> set[str]:
        if identity.is_system:
            return set(ROLES)
        roles = {r.lower() for r in identity.roles} & set(ROLES)
        groups = {g.lower() for g in identity.groups}
        for role, gids in self.s.role_groups.items():
            if groups & set(gids):
                roles.add(role)
        if self.s.rbac == "off":
            roles |= {"viewer", "requester"}
        return roles

    def _need(self, identity: Identity, *any_of: str) -> set[str]:
        roles = self.roles_of(identity)
        if not roles & set(any_of):
            raise Denied(f"Not permitted: this needs the role {' or '.join(any_of)}. Your roles: {sorted(roles) or 'none'}.")
        return roles

    def _sees(self, identity: Identity, owner_oid: str | None) -> bool:
        return bool(self.roles_of(identity) & {"viewer", "admin"}) or (owner_oid is not None and owner_oid == identity.oid)

    def _owns(self, identity: Identity, owner_oid: str | None) -> bool:
        return "admin" in self.roles_of(identity) or (owner_oid is not None and owner_oid == identity.oid)

    def _write_gate(self, identity: Identity) -> None:
        """Common gate of every state-changing tool: not frozen, and the token is not old."""
        try:
            self.guard.require_unfrozen()
        except GuardError as e:
            raise Denied(str(e)) from None
        if identity.source == "jwt" and identity.issued_at and \
                self.clock() - identity.issued_at > self.s.write_max_token_age_minutes * 60:
            raise Denied("Your sign-in token is too old for a change. Sign in again and retry.")

    def is_protected(self, env: str, deployment: str) -> bool:
        return self.control.exists(f"protected/{env}/{deployment}.json")

    # ================================================================== helpers
    def _env(self, name: str | None) -> EnvironmentConfig:
        if name is not None and not isinstance(name, str):
            raise Invalid("environment must be a name such as dev")
        try:
            return self.s.env(name)
        except ConfigError as e:
            raise Invalid(str(e)) from None

    @staticmethod
    def _state_key(env: str, deployment: str) -> str:
        return f"{env}/{deployment}.tfstate"

    @staticmethod
    def _dep_key(env: str, deployment: str) -> str:
        return f"deployments/{env}/{deployment}.json"

    def _deployment(self, env: str, deployment: str, *, must_exist: bool = True, viewer: Identity | None = None) -> dict | None:
        try:
            rec = self.data.get_json(self._dep_key(env, deployment))
        except NotFound:
            rec = None
        if rec is not None and rec.get("status") == "destroyed":
            rec = None
        if rec is not None and viewer is not None and not self._sees(viewer, rec.get("owner_oid")):
            rec = None      # same answer as "does not exist": do not reveal other people's deployments
        if rec is None and must_exist:
            raise Invalid(f"No deployment named '{deployment}' in environment '{env}' (or it is not yours).")
        return rec

    def _plan_meta(self, plan_id: str, viewer: Identity | None = None) -> dict:
        if not isinstance(plan_id, str) or not ID_RE.match(plan_id):
            raise Invalid("plan_id must be the 12-character id returned by plan")
        try:
            meta = self.data.get_json(f"plans/{plan_id}/meta.json")
        except NotFound:
            meta = None
        if meta is None or (viewer is not None and not self._sees(viewer, (meta.get("requested_by") or {}).get("oid"))):
            raise Invalid(f"No plan with id {plan_id} (expired, or not yours).")
        return meta

    def notify(self, event: dict) -> None:
        self.audit.emit(event)
        if self._notify_hook:
            try:
                self._notify_hook(event)
            except Exception as e:  # noqa: BLE001 - notifications are best effort
                self.audit.emit({"type": "notify_failed", "error": str(e)[:300]})

    def _init(self, wd: pathlib.Path, template: str, env: EnvironmentConfig, deployment: str, tfvars: dict, ctx: OpContext) -> None:
        prepare_workdir(wd, self.catalog.path(template), self.catalog.common_file(), tfvars)
        ctx.progress("terraform init")
        code, out = self.tf.run(["init", "-input=false", "-no-color", "-reconfigure", "-lockfile=readonly",
                                 *backend_args(self.s.state_account, self._state_key(env.name, deployment), self.s.subscription_id)],
                                wd, cancel=ctx.cancel, timeout=600)
        if code:
            raise OperationFailed("terraform init failed:\n" + clean_tf_error(out))

    def _evaluate(self, plan: dict, env: EnvironmentConfig, destroy: bool) -> tuple[dict, dict, dict]:
        pol = self.policy.evaluate(plan, profile=env.policy_profile, allowed_locations=env.allowed_locations,
                                   is_destroy=destroy, max_changes_override=env.max_resource_changes).as_dict()
        cost = self.cost.estimate(plan)
        budget = {"status": "not_applicable", "allowed": True} if destroy else \
            budget_check(cost, env.monthly_budget_usd, env.budget_block_if_unknown)
        return pol, cost, budget

    # ================================================================== discovery tools
    def whoami(self, identity: Identity) -> dict:
        return {"name": identity.name, "object_id": identity.oid, "authenticated": identity.authenticated,
                "roles": sorted(self.roles_of(identity)), "frozen": bool(self.guard.frozen())}

    def list_environments(self) -> dict:
        envs = []
        for env in self.s.environments.values():
            d = env.public()
            d["policy_rules"] = self.policy.describe(env.policy_profile)
            envs.append(d)
        return {"default_environment": self.s.default_environment, "environments": envs}

    @staticmethod
    def _signature(schema: dict) -> str:
        bits = [schema["type"]]
        if "enum" in schema:
            bits.append("one of " + ", ".join(map(str, schema["enum"])))
        if "minimum" in schema or "maximum" in schema:
            bits.append(f"{schema.get('minimum', '')}..{schema.get('maximum', '')}")
        if schema.get("format"):
            bits.append(schema["format"])
        bits.append("REQUIRED" if schema.get("required") else f"default {json.dumps(schema.get('default'))}")
        return "; ".join(bits) + (" - " + schema["description"] if schema.get("description") else "")

    def list_templates(self, environment: str | None = None, category: str | None = None) -> dict:
        env = self._env(environment)
        items = []
        for spec in self.catalog.describe(allowed=env.allowed_templates):
            if category and spec["category"] != category:
                continue
            items.append({"name": spec["name"], "version": spec["version"], "title": spec["title"],
                          "category": spec["category"], "description": spec["description"],
                          "variables": {k: self._signature(v) for k, v in spec["variables"].items()}})
        return {"environment": env.name, "allowed_locations": env.allowed_locations, "templates": items,
                "note": "Call describe_template(name) for the full typed schema. Every template also accepts: location, tags, ttl_hours."}

    def describe_template(self, template: str, environment: str | None = None) -> dict:
        env = self._env(environment)
        spec = self.catalog.describe(name=self.catalog.get(template)["name"])[0]
        if env.allowed_templates is not None and template not in env.allowed_templates:
            raise Denied(f"Template '{template}' is not offered in environment '{env.name}'.")
        return spec

    # ================================================================== planning
    def plan_deployment(self, identity: Identity, template: str, deployment_name: str, variables: dict | None = None,
                        environment: str | None = None, location: str | None = None, tags: dict | None = None,
                        ttl_hours: float | None = None, wait: float | None = None, origin: str = "user",
                        protect: bool | None = None) -> dict:
        self._need(identity, "requester", "admin")
        self._write_gate(identity)
        env = self._env(environment)
        try:
            spec = self.catalog.get(template)
            if env.allowed_templates is not None and template not in env.allowed_templates:
                raise Denied(f"Template '{template}' is not offered in environment '{env.name}'.")
            validate_deployment_name(deployment_name)
            user_vars = self.catalog.validate_variables(template, variables)
            user_tags = validate_tags(tags)
        except ValidationError as e:
            raise Invalid(str(e)) from None
        loc = norm_location(location or env.allowed_locations[0])
        if loc not in [norm_location(x) for x in env.allowed_locations]:
            raise Invalid(f"location '{location}' is not allowed in environment '{env.name}'. Allowed: {env.allowed_locations}")

        existing = self._deployment(env.name, deployment_name, must_exist=False)
        if existing and not self._owns(identity, existing.get("owner_oid")):
            raise Denied(f"The name '{deployment_name}' is in use by a deployment you do not own. Only its owner or an "
                         "administrator can change it.")
        protected = bool(existing) and self.is_protected(env.name, deployment_name)
        if protect and ttl_hours is not None:
            raise Invalid("A deployment cannot be both protected and time-boxed.")
        if protect and existing and not protected:
            raise Denied("Protection can only be set when a deployment is created.")
        if existing and existing["template"] != template:
            raise Invalid(f"Deployment '{deployment_name}' already exists in '{env.name}' and was built from template "
                          f"'{existing['template']}'. Pick another name, or destroy it first.")
        if existing and norm_location(existing.get("location", loc)) != loc and location:
            raise Invalid(f"Deployment '{deployment_name}' lives in {existing['location']}; a deployment cannot be moved to another region.")
        if existing and not location:
            loc = norm_location(existing.get("location", loc))

        ephemeral = None
        if ttl_hours is not None:
            if isinstance(ttl_hours, bool) or not isinstance(ttl_hours, (int, float)) or ttl_hours <= 0:
                raise Invalid("ttl_hours must be a positive number of hours")
            if not env.allow_ephemeral:
                raise Denied(f"Time-boxed (self-destructing) deployments are not allowed in environment '{env.name}'.")
            if ttl_hours > env.max_ttl_hours:
                raise Invalid(f"ttl_hours can be at most {env.max_ttl_hours} in environment '{env.name}'")
            if existing and not existing.get("ephemeral"):
                raise Denied(f"'{deployment_name}' was created as a permanent deployment; it cannot be turned into a "
                             "self-destructing one. Create a new deployment with ttl_hours instead.")
            ephemeral = {"ttl_hours": float(ttl_hours)}

        owner = user_tags.get("owner") or (existing or {}).get("owner") or identity.name
        all_tags = {**env.default_tags, **user_tags, "managedBy": MANAGED_BY, "environment": env.name,
                    "deployment": deployment_name, "owner": owner}
        if ephemeral or (existing or {}).get("ephemeral"):
            all_tags["ephemeral"] = "true"
        if protect or protected:
            all_tags["protected"] = "true"      # also the hook for the platform deny-delete policy
        tfvars = {**user_vars, "subscription_id": env.subscription_id, "tenant_id": self.s.tenant_id,
                  "deployment_name": deployment_name, "resource_group_name": env.resource_group, "location": loc,
                  "environment": env.name, "tags": all_tags}
        params = {"plan_id": uuid.uuid4().hex[:12], "template": template, "template_version": spec["version"],
                  "template_hash": spec["content_hash"], "environment": env.name, "deployment": deployment_name,
                  "location": loc, "tfvars": tfvars, "user_variables": user_vars, "user_tags": user_tags,
                  "owner": owner, "owner_oid": (existing or {}).get("owner_oid") or identity.oid, "destroy": False,
                  "ephemeral": ephemeral, "origin": origin, "protect": bool(protect) and not existing}
        return self._submit_plan(identity, env, params, wait)

    def plan_destroy(self, identity: Identity, deployment_name: str, environment: str | None = None,
                     wait: float | None = None, origin: str = "user", inline: bool = False) -> dict:
        self._need(identity, "requester", "admin")
        self._write_gate(identity)
        env = self._env(environment)
        reaper = origin == "ttl-reaper" and identity.is_system
        if not reaper and not env.enable_destroy:
            raise Denied(f"Destroy is switched off for environment '{env.name}'. A platform administrator must enable it.")
        rec = self._deployment(env.name, deployment_name, viewer=identity)
        if not self._owns(identity, rec.get("owner_oid")):
            raise Denied("Only the owner of a deployment or an administrator can plan its destruction.")
        if self.is_protected(env.name, deployment_name):
            raise Denied(f"'{deployment_name}' is a PROTECTED deployment. It can never be destroyed through this system; "
                         "a platform administrator must do it in Azure.")
        params = {"plan_id": uuid.uuid4().hex[:12], "template": rec["template"], "template_version": rec.get("template_version"),
                  "template_hash": rec.get("template_hash"), "environment": env.name, "deployment": deployment_name,
                  "location": rec.get("location"), "tfvars": rec["tfvars"], "user_variables": rec.get("user_variables", {}),
                  "user_tags": rec.get("user_tags", {}), "owner": rec.get("owner"), "owner_oid": rec.get("owner_oid"),
                  "destroy": True, "ephemeral": None, "origin": "ttl-reaper" if reaper else "user", "protect": False}
        return self._submit_plan(identity, env, params, wait, inline=inline)

    def plan_rollback(self, identity: Identity, deployment_name: str, environment: str | None = None,
                      wait: float | None = None) -> dict:
        """Plan a return to the inputs of the previous successful apply."""
        env = self._env(environment)
        self._deployment(env.name, deployment_name, viewer=identity)
        history = self._history(env.name, deployment_name)
        applies = [h for h in history if h.get("action") == "apply"]
        if len(applies) < 2:
            raise Invalid(f"'{deployment_name}' has no earlier applied version to roll back to.")
        previous = applies[1]   # newest first: [0] is what is live now
        result = self.plan_deployment(identity, previous["template"], deployment_name, previous.get("user_variables") or {},
                                      env.name, None, previous.get("user_tags") or {}, None, wait, origin="rollback")
        result["rollback_to"] = {"applied_at": previous.get("at"), "applied_by": previous.get("by"),
                                 "template_version": previous.get("template_version")}
        return result

    def _submit_plan(self, identity: Identity, env: EnvironmentConfig, params: dict, wait: float | None, inline: bool = False) -> dict:
        try:
            self.guard.plan_started(identity, params["destroy"])
            return self.engine.submit("plan", params, actor=identity.public(), environment=env.name,
                                      deployment=params["deployment"], lock=f"{env.name}/{params['deployment']}",
                                      state_key=self._state_key(env.name, params["deployment"]),
                                      wait=self.s.sync_wait_seconds if wait is None else wait, inline=inline)
        except (Busy, GuardError) as e:
            raise Denied(str(e)) from None

    def _since_last_apply(self, env: str, p: dict) -> dict | None:
        rec = self._deployment(env, p["deployment"], must_exist=False)
        if not rec:
            return None
        old, new = rec.get("user_variables") or {}, p.get("user_variables") or {}
        changed = {k: {"from": old.get(k), "to": new.get(k)} for k in sorted(set(old) | set(new)) if old.get(k) != new.get(k)}
        out = {"last_applied_at": rec.get("applied_at"), "last_applied_by": (rec.get("applied_by") or {}).get("name"),
               "inputs_changed": changed,
               "template_version": {"from": rec.get("template_version"), "to": p.get("template_version")},
               "template_changed": rec.get("template_hash") != p.get("template_hash")}
        bits = []
        if changed:
            bits.append("inputs changed: " + ", ".join(f"{k} ({v['from']!r} -> {v['to']!r})" for k, v in list(changed.items())[:6]))
        if out["template_changed"]:
            bits.append(f"the template itself was updated ({rec.get('template_version')} -> {p.get('template_version')})")
        out["summary"] = ("Compared with what is live (applied " + str(rec.get("applied_at")) + "): " +
                          ("; ".join(bits) if bits else "same inputs and template - any change shown is drift or a provider default")) + "."
        return out

    def _op_plan(self, op: dict, ctx: OpContext) -> dict:
        p = op["params"]
        env = self._env(p["environment"])
        plan_id = p["plan_id"]
        with tempfile.TemporaryDirectory(prefix="tfmcp-") as d:
            wd = pathlib.Path(d)
            self._init(wd, p["template"], env, p["deployment"], p["tfvars"], ctx)
            ctx.progress("terraform plan")
            args = ["plan", "-input=false", "-no-color", "-lock=false", "-out=tfplan", "-detailed-exitcode"]
            code, out = self.tf.run(args + (["-destroy"] if p["destroy"] else []), wd, cancel=ctx.cancel)
            if code == 1:
                raise OperationFailed("terraform plan failed:\n" + clean_tf_error(out))
            has_changes = code == 2
            code, shown = self.tf.run(["show", "-json", "tfplan"], wd, cancel=ctx.cancel, timeout=300)
            if code:
                raise OperationFailed("terraform show failed:\n" + clean_tf_error(shown))
            plan = slim_plan(parse_json_output(shown))
            tfplan_bytes = (wd / "tfplan").read_bytes()
        ctx.progress("policy and cost checks")
        pol, cost, budget = self._evaluate(plan, env, p["destroy"])
        now = self.clock()
        approval = {"required": True, "two_person": bool(env.require_approval), "status": "not_requested"}
        meta = {"plan_id": plan_id, "status": "planned", "environment": env.name, "deployment": p["deployment"],
                "template": p["template"], "template_version": p.get("template_version"), "template_hash": p.get("template_hash"),
                "location": p.get("location"), "destroy": p["destroy"], "tfvars": p["tfvars"],
                "user_variables": p.get("user_variables"), "user_tags": p.get("user_tags"), "owner": p.get("owner"),
                "ephemeral": p.get("ephemeral"), "origin": p.get("origin", "user"), "requested_by": op["actor"],
                "owner_oid": p.get("owner_oid"), "protect": bool(p.get("protect")),
                "created_at": now, "expires_at": now + env.plan_ttl_minutes * 60,
                "tfplan_sha256": hashlib.sha256(tfplan_bytes).hexdigest(), "has_changes": has_changes,
                "policy": pol, "cost": cost, "budget": budget, "approval": approval,
                "since_last_apply": None if p["destroy"] else self._since_last_apply(env.name, p)}
        explanation = explain(plan, meta=meta, policy=pol, cost=cost, budget=budget, approval=approval,
                              strict=env.policy_profile == "strict", since_last_apply=meta["since_last_apply"])
        if has_changes:
            self.data.put(f"plans/{plan_id}/tfplan", tfplan_bytes)
            self.data.put_json(f"plans/{plan_id}/plan.json", plan)
            self.data.put_json(f"plans/{plan_id}/meta.json", meta)   # plain overwrite: a retried plan re-writes its own files
        self.audit.emit({"type": "plan", "plan_id": plan_id, "environment": env.name, "deployment": p["deployment"],
                         "template": p["template"], "destroy": p["destroy"], "user": op["actor"].get("name"),
                         "user_oid": op["actor"].get("oid"), "has_changes": has_changes, "policy_allowed": pol["allowed"],
                         "policy_violations": [v["rule"] for v in pol["violations"]], "risk": explanation["risk_level"],
                         "monthly_delta_usd": cost.get("monthly_delta_usd"), "counts": explanation["counts"]})
        return self._plan_view(meta, explanation, has_changes)

    def approval_state(self, meta: dict) -> dict:
        """Approval status from the TRUSTED control store (never from the plan's own metadata)."""
        env = self._env(meta["environment"])
        out = {"two_person": bool(env.require_approval), "status": (meta.get("approval") or {}).get("status", "not_requested")}
        if out["status"] not in ("not_requested", "pending"):
            out["status"] = "pending"
        try:
            rec = self.control.get_json(f"approvals/{meta['plan_id']}.json")
            out["status"] = rec["status"]
            out["decided_by"] = (rec.get("decided_by") or {}).get("name")
            if rec["status"] == "approved":
                if rec.get("used_by"):
                    out["status"] = "used"
                elif self.clock() > rec.get("expires_at", 0):
                    out["status"] = "expired"
                else:
                    out["valid_until"] = iso(rec["expires_at"])
        except NotFound:
            pass
        if out["status"] in ("not_requested", "pending") and self.s.approval_base_url:
            out["approve_at"] = f"{self.s.approval_base_url}/?plan={meta['plan_id']}"
        return out

    def _plan_view(self, meta: dict, explanation: dict, has_changes: bool = True) -> dict:
        cost = meta["cost"]
        approval = self.approval_state(meta) if has_changes else {"status": "not_needed"}
        blockers = self._apply_blockers(meta, with_approval=False) if has_changes else []
        if has_changes and approval["status"] != "approved":
            who = "a DIFFERENT person with the approver role" if approval.get("two_person") else "you (or an approver)"
            explanation = {**explanation, "next_step": (
                "Blocked - fix the issues and plan again." if blockers else
                f"A human must approve this on the approval page (not in this chat): {who}. Call request_approval, give the "
                "user the link, then call apply after it is approved.")}
        return {"plan_id": meta["plan_id"] if has_changes else None, "plan_status": meta.get("status"),
                "has_changes": has_changes, "environment": meta["environment"],
                "deployment": meta["deployment"], "template": meta["template"], "template_version": meta.get("template_version"),
                "destroy": meta["destroy"], "requested_by": (meta.get("requested_by") or {}).get("name"),
                "expires_at": iso(meta["expires_at"]), "ephemeral": meta.get("ephemeral"), "protect": bool(meta.get("protect")),
                "explanation": explanation,
                "policy": {k: meta["policy"][k] for k in ("profile", "allowed", "violations", "warnings")},
                "cost": {"status": cost.get("status"), "monthly_total_usd": cost.get("monthly_total_usd"),
                         "monthly_delta_usd": cost.get("monthly_delta_usd"), "currency": "USD",
                         "items": (cost.get("items") or [])[:25], "disclaimer": cost.get("disclaimer")},
                "budget": meta["budget"], "approval": approval,
                "can_apply": has_changes and not blockers and approval["status"] == "approved" and meta.get("status") == "planned",
                "blockers": blockers}

    def explain_plan(self, identity: Identity, plan_id: str) -> dict:
        self._need(identity, *ROLES)
        meta = self._plan_meta(plan_id, viewer=identity)
        env = self._env(meta["environment"])
        plan = self.data.get_json(f"plans/{plan_id}/plan.json")
        explanation = explain(plan, meta=meta, policy=meta["policy"], cost=meta["cost"], budget=meta["budget"],
                              approval=meta["approval"], strict=env.policy_profile == "strict",
                              since_last_apply=meta.get("since_last_apply"))
        return self._plan_view(meta, explanation)

    # ================================================================== approvals
    @staticmethod
    def _require_person(identity: Identity, action: str) -> None:
        if not identity.authenticated or identity.is_system or identity.name.startswith("app:"):
            raise Denied(f"Only a signed-in person can {action}. This call has no user identity.")

    def request_approval(self, identity: Identity, plan_id: str, justification: str = "") -> dict:
        """Ask for approval. This only creates a pending request and a link: the decision itself can NOT be
        made through any MCP tool - it happens on the separate approval page."""
        self._need(identity, "requester", "admin")
        self._write_gate(identity)
        self._require_person(identity, "request an approval")
        meta = self._plan_meta(plan_id, viewer=identity)
        env = self._env(meta["environment"])
        if not self._owns(identity, (meta.get("requested_by") or {}).get("oid")):
            raise Denied("Only the person who created the plan (or an administrator) can request its approval.")
        if meta["status"] != "planned" or self.clock() > meta["expires_at"]:
            raise Invalid("This plan is no longer open (applied, failed or expired). Create a new plan.")
        blockers = self._apply_blockers(meta, with_approval=False)
        if blockers:
            raise Denied("This plan is blocked and cannot be sent for approval: " + " | ".join(blockers))
        if not isinstance(justification, str) or len(justification.strip()) < 10:
            raise Invalid("Give a reason of at least 10 characters (what is changing and why).")

        def mutate(doc):
            if doc["approval"].get("status") == "pending":
                raise Invalid("Approval was already requested for this plan.")
            doc["approval"].update(status="pending", requested_by=identity.public(), requested_at=self.clock(),
                                   justification=justification.strip()[:500])
            return doc
        meta = self.data.update_json(f"plans/{plan_id}/meta.json", mutate)
        self.data.put_json(f"approvals-pending/{env.name}/{plan_id}", {"plan_id": plan_id, "requested_at": self.clock()})
        state = self.approval_state(meta)
        self.notify({"type": "approval_requested", "plan_id": plan_id, "environment": env.name, "destroy": meta["destroy"],
                     "deployment": meta["deployment"], "user": identity.name, "user_oid": identity.oid,
                     "justification": justification.strip()[:300], "approve_at": state.get("approve_at"),
                     "text": f"Approval needed: {identity.name} wants to {'DESTROY' if meta['destroy'] else 'apply'} "
                             f"'{meta['deployment']}' in {env.name} (plan {plan_id}). Review: {state.get('approve_at', 'approval page')}"})
        return {"plan_id": plan_id, "status": "pending", "approve_at": state.get("approve_at"),
                "who": "a different person with the approver role" if env.require_approval else "you or an approver",
                "next": "The decision is made on the approval page after a fresh sign-in, never in this chat. "
                        "When it is approved, call apply."}

    # ================================================================== apply
    def _apply_blockers(self, meta: dict, system: bool = False, with_approval: bool = True) -> list[str]:
        env = self._env(meta["environment"])
        reasons = []
        reaper = system and meta.get("origin") == "ttl-reaper" and meta["destroy"]
        frozen = self.guard.frozen()
        if frozen:
            reasons.append(f"The server is frozen ({frozen['reason'] or 'no reason given'}).")
        if meta["destroy"]:
            if not env.enable_destroy and not reaper:
                reasons.append(f"Destroy is switched off for environment '{env.name}'.")
            if self.is_protected(env.name, meta["deployment"]):
                reasons.append("This deployment is PROTECTED and can never be destroyed through this system.")
        elif not env.enable_apply:
            reasons.append(f"Apply is switched off for environment '{env.name}' (plan-only).")
        if meta["status"] != "planned":
            reasons.append(f"This plan was already used (status: {meta['status']}). Create a new plan.")
        if self.clock() > meta["expires_at"]:
            reasons.append("This plan has expired. Create a new plan.")
        if not reaper:
            try:
                self.guard.check_window(env)
            except GuardError as e:
                reasons.append(str(e))
        try:
            plan = self.data.get_json(f"plans/{meta['plan_id']}/plan.json")
        except NotFound:
            return reasons + ["The saved plan is missing. Create a new plan."]
        pol, _cost, _ = self._evaluate(plan, env, meta["destroy"])   # with the policy in force NOW
        if not pol["allowed"]:
            reasons += [f"Policy: {v['message']}" for v in pol["violations"]]
        if not meta["destroy"]:
            budget = budget_check(meta["cost"], env.monthly_budget_usd, env.budget_block_if_unknown)
            if not budget["allowed"]:
                reasons.append(budget["message"])
        if with_approval:
            state = self.approval_state(meta)
            if state["status"] != "approved":
                reasons.append(f"Not approved (approval status: {state['status']}). A human decision on the approval page is "
                               "required; it cannot be approved in the chat.")
        return reasons

    def apply_plan(self, identity: Identity, plan_id: str, wait: float | None = None, inline: bool = False) -> dict:
        """Queue an approved plan for the privileged executor. This process may have no rights to change Azure."""
        self._need(identity, "requester", "admin")
        self._write_gate(identity)
        meta = self._plan_meta(plan_id, viewer=identity)
        env = self._env(meta["environment"])
        if not identity.is_system:
            self._require_person(identity, "apply a plan")
            if not self._owns(identity, (meta.get("requested_by") or {}).get("oid")):
                raise Denied("Only the person who created the plan (or an administrator) can apply it.")
        blockers = self._apply_blockers(meta, identity.is_system)
        if blockers:
            raise Denied("Cannot apply: " + " | ".join(blockers))
        try:
            return self.engine.submit("apply", {"plan_id": plan_id}, actor=identity.public(), environment=env.name,
                                      deployment=meta["deployment"], lock=f"{env.name}/{meta['deployment']}",
                                      state_key=self._state_key(env.name, meta["deployment"]),
                                      wait=self.s.sync_wait_seconds if wait is None else wait, inline=inline)
        except Busy as e:
            raise Denied(str(e)) from None

    def _op_apply(self, op: dict, ctx: OpContext) -> dict:
        """Runs ONLY in the privileged executor process. It trusts nothing the front-end wrote: the approval
        comes from the control store, and policy and the change digest are recomputed from the binary plan."""
        plan_id = op["params"]["plan_id"]
        meta_key = f"plans/{plan_id}/meta.json"
        actor = op["actor"]
        system = str(actor.get("oid", "")).startswith("system:")
        meta = self.data.get_json(meta_key)
        blockers = self._apply_blockers(meta, system, with_approval=False)
        if blockers:
            raise OperationFailed("Cannot apply: " + " | ".join(blockers))

        def take(doc):
            if doc["status"] != "planned":
                raise OperationFailed(f"This plan was already used (status: {doc['status']}).")
            doc.update(status="applying", applying_operation=op["operation_id"], applied_by=actor)
            return doc
        meta = self.data.update_json(meta_key, take)   # compare-and-swap: a plan is applied at most once
        env = self._env(meta["environment"])
        name = meta["deployment"]

        def set_status(status: str, **extra) -> None:
            def mutate(doc):
                doc.update(status=status, **extra)
                return doc
            try:
                self.data.update_json(meta_key, mutate)
            except (Conflict, NotFound):
                pass

        approval_record: dict = {}
        try:
            tfplan = self.data.get(f"plans/{plan_id}/tfplan")[0]
            if hashlib.sha256(tfplan).hexdigest() != meta["tfplan_sha256"]:
                raise OperationFailed("The saved plan file does not match its recorded checksum. Refusing to apply; plan again.")
            with tempfile.TemporaryDirectory(prefix="tfmcp-") as d:
                wd = pathlib.Path(d)
                self._init(wd, meta["template"], env, name, meta["tfvars"], ctx)
                (wd / "tfplan").write_bytes(tfplan)
                # 1. what does this plan file REALLY do? (never trust the JSON stored next to it)
                c0, shown = self.tf.run(["show", "-json", "tfplan"], wd, cancel=ctx.cancel, timeout=300)
                if c0:
                    raise OperationFailed("terraform show failed:\n" + clean_tf_error(shown))
                real = slim_plan(parse_json_output(shown))
                pol = self.policy.evaluate(real, profile=env.policy_profile, allowed_locations=env.allowed_locations,
                                           is_destroy=meta["destroy"], max_changes_override=env.max_resource_changes).as_dict()
                if not pol["allowed"]:
                    raise OperationFailed("Policy blocks this plan file: " + " | ".join(v["message"] for v in pol["violations"]))
                if meta["destroy"] and self.is_protected(env.name, name):
                    raise OperationFailed("This deployment is PROTECTED and cannot be destroyed through this system.")
                # 2. out-of-band approval for exactly this file and these changes; single use
                try:
                    approval_record = self.approvals.consume(meta, tfplan, real, op["operation_id"], system=system)
                    self.guard.require_unfrozen()
                    self.guard.reserve_apply(count_deletes(real))    # 3. global damage quotas
                except (ApprovalError, GuardError) as e:
                    self.audit.emit({"type": "apply_refused", "plan_id": plan_id, "environment": env.name, "deployment": name,
                                     "destroy": meta["destroy"], "user": actor.get("name"), "user_oid": actor.get("oid"),
                                     "reason": str(e)[:300]})
                    raise OperationFailed("Cannot apply: " + str(e)) from None
                ctx.progress("terraform apply")
                code, out = self.tf.run(["apply", "-input=false", "-no-color", "-lock-timeout=120s", "tfplan"], wd, cancel=ctx.cancel)
                outputs, resources = {}, []
                if not meta["destroy"] or code:
                    c2, shown = self.tf.run(["show", "-json"], wd, timeout=300)
                    if not c2:
                        resources = state_resources(parse_json_output(shown))
                if code == 0 and not meta["destroy"]:
                    c3, raw = self.tf.run(["output", "-json"], wd, timeout=300)
                    if not c3:
                        outputs = public_outputs(parse_json_output(raw))
        except Cancelled:
            set_status("interrupted")
            self._record_after_apply(meta, actor, [], {}, ok=False, note="apply was interrupted")
            raise
        except OperationFailed:
            set_status("failed")
            raise
        now = self.clock()
        approver = (approval_record.get("decided_by") or {}).get("name")
        meta["approved_by"] = approver
        self._record_after_apply(meta, actor, resources, outputs, ok=code == 0,
                                 note=None if code == 0 else "apply failed part-way")
        if code == 0 and meta.get("protect") and not meta["destroy"]:
            self.control.put_json(f"protected/{env.name}/{name}.json", {"at": now, "by": actor, "plan_id": plan_id})
        self.data.delete(f"plans/{plan_id}/tfplan")
        self.data.delete(f"approvals-pending/{env.name}/{plan_id}")
        set_status("applied" if code == 0 else "failed", finished_at=now)
        self.audit.emit({"type": "apply", "plan_id": plan_id, "environment": env.name, "deployment": name,
                         "destroy": meta["destroy"], "outcome": "succeeded" if code == 0 else "failed",
                         "user": actor.get("name"), "user_oid": actor.get("oid"),
                         "planned_by": (meta.get("requested_by") or {}).get("name"), "approved_by": approver,
                         "self_approved": bool(approval_record.get("self_approved")), "deleted": count_deletes(real),
                         "origin": meta.get("origin")})
        if code:
            raise OperationFailed("terraform apply failed. Some resources may have been created; run a new plan for this "
                                  "deployment to see what is left.\n" + clean_tf_error(out))
        result = {"applied": True, "destroyed": meta["destroy"], "environment": env.name, "deployment": name,
                  "resources": resources[:60], "outputs": outputs}
        rec = self._deployment(env.name, name, must_exist=False)
        if rec and rec.get("ephemeral"):
            result["expires_at"] = iso(rec["expires_at"])
            result["note"] = (f"This deployment is time-boxed and will be destroyed automatically after {result['expires_at']} "
                              "unless extend is called.")
        return result

    def _record_after_apply(self, meta: dict, actor: dict, resources: list, outputs: dict, *, ok: bool, note: str | None) -> None:
        env, name, now = meta["environment"], meta["deployment"], self.clock()
        key = self._dep_key(env, name)
        try:
            rec = self.data.get_json(key)
            if rec.get("status") == "destroyed":
                rec = None
        except NotFound:
            rec = None
        entry = {"at": iso(now), "by": actor.get("name"), "by_oid": actor.get("oid"), "plan_id": meta["plan_id"],
                 "action": ("destroy" if meta["destroy"] else "apply") if ok else "failed-" + ("destroy" if meta["destroy"] else "apply"),
                 "template": meta["template"], "template_version": meta.get("template_version"),
                 "user_variables": meta.get("user_variables"), "user_tags": meta.get("user_tags"),
                 "planned_by": (meta.get("requested_by") or {}).get("name"),
                 "approved_by": meta.get("approved_by"),
                 "origin": meta.get("origin"), "note": note}
        self.data.put_json(f"history/{env}/{name}/{int(now * 1000)}-{meta['plan_id']}.json", entry)
        if meta["destroy"]:
            if ok and rec:
                rec.update(status="destroyed", destroyed_at=iso(now), destroyed_by=actor)
                self.data.put_json(key, rec)
                self.state.delete(self._state_key(env, name))
                self.data.delete(f"drift/{env}/{name}.json")
            elif rec:
                rec.update(status="needs_attention", note=note)
                self.data.put_json(key, rec)
            return
        if not ok:
            if rec is None:
                rec = {"environment": env, "deployment": name, "template": meta["template"], "created_at": iso(now),
                       "created_by": actor, "tfvars": meta["tfvars"], "user_variables": meta.get("user_variables"),
                       "user_tags": meta.get("user_tags"), "owner": meta.get("owner"), "location": meta.get("location"),
                       "owner_oid": meta.get("owner_oid"), "template_version": meta.get("template_version"), "template_hash": meta.get("template_hash")}
            rec.update(status="needs_attention", note=note, resources=resources or rec.get("resources", []))
            self.data.put_json(key, rec)
            return
        new = rec is None
        rec = rec or {"environment": env, "deployment": name, "created_at": iso(now), "created_by": actor,
                      "owner_oid": meta.get("owner_oid") or actor.get("oid")}
        rec.update(status="active", note=None, template=meta["template"], template_version=meta.get("template_version"),
                   template_hash=meta.get("template_hash"), location=meta.get("location"), tfvars=meta["tfvars"],
                   user_variables=meta.get("user_variables"), user_tags=meta.get("user_tags"), owner=meta.get("owner"),
                   applied_at=iso(now), applied_by=actor, last_plan_id=meta["plan_id"], resources=resources,
                   outputs=outputs, monthly_estimate_usd=(meta.get("cost") or {}).get("monthly_total_usd"))
        eph = meta.get("ephemeral")
        if eph and (new or rec.get("ephemeral")):
            rec.update(ephemeral=True, ttl_hours=eph["ttl_hours"], expires_at=now + eph["ttl_hours"] * 3600, notice_sent_at=None)
        elif new:
            rec["ephemeral"] = False
        self.data.put_json(key, rec)

    # ================================================================== reading
    def get_operation(self, identity: Identity, operation_id: str, etag: str | None = None) -> dict:
        self._need(identity, *ROLES)
        if not isinstance(operation_id, str) or not ID_RE.match(operation_id):
            raise Invalid("operation id must be the 12-character id returned by an earlier call")
        try:
            doc, tag = self.data.get_json_etag(f"ops/{operation_id}.json")
        except NotFound:
            doc = None
        if doc is None or not self._sees(identity, (doc.get("actor") or {}).get("oid")):
            raise Invalid(f"No operation with id {operation_id} (or it is not yours).")
        tag = short_etag(tag)
        if etag and etag == tag and doc["status"] not in ("succeeded", "failed", "interrupted"):
            return {"operation_id": operation_id, "unchanged": True, "status": doc["status"], "etag": tag}
        return {**self.engine.public(doc), "etag": tag}

    def _history(self, env: str, deployment: str) -> list[dict]:
        return [doc for _, doc in sorted(iter_json(self.data, f"history/{env}/{deployment}/"), reverse=True)]

    def _dep_view(self, rec: dict, detail: bool = False) -> dict:
        now = self.clock()
        out = {"deployment": rec["deployment"], "environment": rec["environment"], "template": rec.get("template"),
               "template_version": rec.get("template_version"), "status": rec.get("status"), "location": rec.get("location"),
               "owner": rec.get("owner"), "applied_at": rec.get("applied_at"),
               "applied_by": (rec.get("applied_by") or {}).get("name"),
               "resource_count": len(rec.get("resources") or []), "monthly_estimate_usd": rec.get("monthly_estimate_usd"),
               "ephemeral": bool(rec.get("ephemeral"))}
        if rec.get("note"):
            out["note"] = rec["note"]
        if rec.get("ephemeral"):
            out["expires_at"] = iso(rec["expires_at"])
            out["expires_in_hours"] = round((rec["expires_at"] - now) / 3600, 1)
        if rec.get("last_drift"):
            out["drift"] = rec["last_drift"]
        if detail:
            out["variables"] = rec.get("user_variables")
            out["tags"] = (rec.get("tfvars") or {}).get("tags")
            out["outputs"] = rec.get("outputs")
            out["resources"] = rec.get("resources")
            out["created_at"] = rec.get("created_at")
            out["created_by"] = (rec.get("created_by") or {}).get("name")
        return out

    def list_deployments(self, identity: Identity, environment: str | None = None, page: int = 1, page_size: int = 20,
                         fields: list[str] | None = None) -> dict:
        self._need(identity, *ROLES)
        envs = [self._env(environment).name] if environment else list(self.s.environments)
        if not isinstance(page, int) or page < 1 or not isinstance(page_size, int) or not 1 <= page_size <= 50:
            raise Invalid("page must be >= 1 and page_size 1-50")
        rows = []
        for env in envs:
            for _, rec in iter_json(self.data, f"deployments/{env}/"):
                if rec.get("status") != "destroyed" and self._sees(identity, rec.get("owner_oid")):
                    view = self._dep_view(rec)
                    if fields:
                        view = {k: v for k, v in view.items() if k in fields or k in ("deployment", "environment")}
                    rows.append(view)
        start = (page - 1) * page_size
        out = {"deployments": rows[start:start + page_size], "count": len(rows), "page": page}
        if start + page_size < len(rows):
            out["truncated"] = True
            out["more"] = f"call again with page={page + 1}"
        return out

    def get_deployment(self, identity: Identity, deployment_name: str, environment: str | None = None,
                       history: int = 5) -> dict:
        self._need(identity, *ROLES)
        env = self._env(environment)
        rec = self._deployment(env.name, deployment_name, viewer=identity)
        view = self._dep_view(rec, detail=True)
        all_history = self._history(env.name, deployment_name)
        n = max(0, min(int(history), 50))
        view["history"] = [{k: h.get(k) for k in ("at", "by", "action", "plan_id", "template_version", "planned_by",
                                                   "approved_by", "origin", "note")} for h in all_history[:n]]
        if len(all_history) > n:
            view["history_truncated"] = f"{len(all_history) - n} older entries; pass history={min(50, len(all_history))}"
        try:
            view["drift_detail"] = self.data.get_json(f"drift/{env.name}/{deployment_name}.json")
        except NotFound:
            pass
        view["busy_with_operation"] = self.engine.lock_holder(f"{env.name}/{deployment_name}")
        view["protected"] = self.is_protected(env.name, deployment_name)
        return view

    # ================================================================== drift
    def detect_drift(self, identity: Identity, deployment_name: str | None = None, environment: str | None = None,
                     wait: float | None = None, inline: bool = False) -> dict:
        self._need(identity, "requester", "admin")
        self._write_gate(identity)
        env = self._env(environment)
        if deployment_name:
            self._deployment(env.name, deployment_name, viewer=identity)
            names = [deployment_name]
        else:
            names = [rec["deployment"] for _, rec in iter_json(self.data, f"deployments/{env.name}/")
                     if rec.get("status") in ("active", "needs_attention") and self._sees(identity, rec.get("owner_oid"))][:25]
        started, skipped = [], []
        single = len(names) == 1
        for name in names:
            try:
                op = self.engine.submit("drift", {"environment": env.name, "deployment": name}, actor=identity.public(),
                                        environment=env.name, deployment=name, lock=f"{env.name}/{name}",
                                        state_key=self._state_key(env.name, name), inline=inline,
                                        wait=(self.s.sync_wait_seconds if wait is None else wait) if single else 0)
                started.append(op)
            except Busy as e:
                skipped.append({"deployment": name, "reason": str(e)})
        if single and started and deployment_name:
            return started[0]
        return {"environment": env.name, "started": [{"deployment": o["deployment"], "operation_id": o["operation_id"],
                                                      "status": o["status"], **({"result": o["result"]} if o.get("result") else {})}
                                                     for o in started],
                "skipped": skipped, "next": "Poll each operation_id with get_operation, or call list_deployments to see the drift status."}

    def _op_drift(self, op: dict, ctx: OpContext) -> dict:
        p = op["params"]
        env = self._env(p["environment"])
        rec = self._deployment(env.name, p["deployment"])
        with tempfile.TemporaryDirectory(prefix="tfmcp-") as d:
            wd = pathlib.Path(d)
            self._init(wd, rec["template"], env, p["deployment"], rec["tfvars"], ctx)
            ctx.progress("terraform plan -refresh-only")
            code, out = self.tf.run(["plan", "-refresh-only", "-input=false", "-no-color", "-lock=false",
                                     "-out=drift.tfplan", "-detailed-exitcode"], wd, cancel=ctx.cancel)
            if code == 1:
                raise OperationFailed("drift check failed:\n" + clean_tf_error(out))
            code, shown = self.tf.run(["show", "-json", "drift.tfplan"], wd, cancel=ctx.cancel, timeout=300)
            if code:
                raise OperationFailed("terraform show failed:\n" + clean_tf_error(shown))
            plan = slim_plan(parse_json_output(shown))
        changes = []
        for rc in plan.get("resource_drift") or []:
            ch = rc.get("change") or {}
            kind = action_kind(ch.get("actions"))
            if kind in ("no-op", "read"):
                continue
            attrs = changed_attributes(ch.get("before"), ch.get("after"))
            if kind == "update" and not attrs:
                continue
            changes.append({"resource": rc["address"], "type": rc["type"],
                            "what": "deleted outside Terraform" if kind == "delete" else "changed outside Terraform",
                            "changed_settings": attrs[:20]})
        now = self.clock()
        result = {"environment": env.name, "deployment": p["deployment"], "checked_at": iso(now), "drifted": bool(changes),
                  "changes": changes[:50],
                  "summary": (f"{len(changes)} resource(s) no longer match what was deployed." if changes
                              else "No drift: Azure matches the last applied configuration."),
                  "next": ("To put things back, run plan_deployment with the same inputs and review the plan."
                           if changes else None)}
        self.data.put_json(f"drift/{env.name}/{p['deployment']}.json", result)

        def mutate(doc):
            doc["last_drift"] = {"checked_at": result["checked_at"], "drifted": result["drifted"], "resources": len(changes)}
            return doc
        try:
            self.data.update_json(self._dep_key(env.name, p["deployment"]), mutate)
        except (NotFound, Conflict):
            pass
        self.audit.emit({"type": "drift", "environment": env.name, "deployment": p["deployment"], "drifted": bool(changes),
                         "drifted_resources": [c["resource"] for c in changes][:20], "user": op["actor"].get("name")})
        return result

    # ================================================================== time-boxed deployments
    def extend_ttl(self, identity: Identity, deployment_name: str, hours: float, environment: str | None = None) -> dict:
        env = self._env(environment)
        if isinstance(hours, bool) or not isinstance(hours, (int, float)) or hours <= 0:
            raise Invalid("hours must be a positive number")
        self._need(identity, "requester", "admin")
        self._write_gate(identity)
        rec = self._deployment(env.name, deployment_name, viewer=identity)
        if not self._owns(identity, rec.get("owner_oid")):
            raise Denied("Only the owner or an administrator can extend a time-boxed deployment.")
        if not rec.get("ephemeral"):
            raise Invalid(f"'{deployment_name}' is not a time-boxed deployment; it has no expiry.")
        now = self.clock()
        new_expiry = max(now, rec["expires_at"]) + hours * 3600
        if new_expiry > now + env.max_ttl_hours * 3600:
            raise Denied(f"That would keep the deployment alive more than {env.max_ttl_hours} hours from now, the limit for "
                         f"environment '{env.name}'.")

        def mutate(doc):
            doc.update(expires_at=new_expiry, notice_sent_at=None)
            doc.setdefault("ttl_extensions", []).append({"at": iso(now), "by": identity.name, "hours": hours})
            return doc
        rec = self.data.update_json(self._dep_key(env.name, deployment_name), mutate)
        return {"deployment": deployment_name, "environment": env.name, "expires_at": iso(rec["expires_at"]),
                "expires_in_hours": round((rec["expires_at"] - now) / 3600, 1)}

    def run_reaper(self, identity: Identity) -> dict:
        """Send expiry notices and destroy expired time-boxed deployments. Run from a scheduled job.
        Never touches a deployment that was not created with ttl_hours."""
        if self.approvals is None or not identity.is_system:
            raise ToolError("The TTL reaper must run in the privileged (approval/executor) process as a system job.")
        now = self.clock()
        report = {"notified": [], "destroyed": [], "failed": [], "skipped": []}
        for env in self.s.environments.values():
            for _, rec in list(iter_json(self.data, f"deployments/{env.name}/")):
                if not rec.get("ephemeral") or rec.get("status") not in ("active", "needs_attention") or not rec.get("expires_at"):
                    continue
                name, ref = rec["deployment"], f"{env.name}/{rec['deployment']}"
                key = self._dep_key(env.name, name)
                if not env.allow_ephemeral or env.require_approval:
                    report["skipped"].append({"deployment": ref, "reason": "environment no longer allows time-boxed deployments"})
                    self.audit.emit({"type": "ttl_reap_skipped", "environment": env.name, "deployment": name})
                    continue
                if not rec.get("notice_sent_at"):
                    if now >= rec["expires_at"] - self.s.ttl_notice_hours * 3600:
                        def mark(doc):
                            doc["notice_sent_at"] = now
                            return doc
                        self.data.update_json(key, mark)
                        earliest = max(rec["expires_at"], now + self.s.ttl_min_notice_minutes * 60)
                        self.notify({"type": "ttl_notice", "environment": env.name, "deployment": name, "owner": rec.get("owner"),
                                     "expires_at": iso(rec["expires_at"]), "destroy_not_before": iso(earliest),
                                     "text": f"Time-boxed deployment '{name}' in {env.name} (owner {rec.get('owner')}) will be "
                                             f"destroyed after {iso(earliest)}. Call extend_ttl to keep it."})
                        report["notified"].append(ref)
                    continue
                if now < rec["expires_at"] or now - rec["notice_sent_at"] < self.s.ttl_min_notice_minutes * 60:
                    continue
                try:
                    op = self.plan_destroy(identity, name, env.name, origin="ttl-reaper", inline=True)
                    if op["status"] != "succeeded":
                        raise ToolError(op.get("error") or f"destroy plan {op['status']}")
                    plan = op["result"]
                    if plan["has_changes"]:
                        if not plan["policy"]["allowed"]:
                            raise ToolError("policy blocks the destroy: " + "; ".join(v["message"] for v in plan["policy"]["violations"]))
                        meta = self.data.get_json(f"plans/{plan['plan_id']}/meta.json")
                        self.approvals.system_approve(meta, self.data.get_json(f"plans/{plan['plan_id']}/plan.json"), identity)
                        op = self.apply_plan(identity, plan["plan_id"], inline=True)
                        if op["status"] != "succeeded":
                            raise ToolError(op.get("error") or f"destroy {op['status']}")
                    else:   # nothing left in Azure: just close the record
                        def close(doc):
                            doc.update(status="destroyed", destroyed_at=iso(now), destroyed_by=identity.public())
                            return doc
                        self.data.update_json(key, close)
                        self.state.delete(self._state_key(env.name, name))
                    report["destroyed"].append(ref)
                    self.notify({"type": "ttl_reaped", "environment": env.name, "deployment": name, "owner": rec.get("owner"),
                                 "text": f"Time-boxed deployment '{name}' in {env.name} expired and was destroyed."})
                except Exception as e:  # noqa: BLE001 - one bad deployment must not stop the sweep
                    report["failed"].append({"deployment": ref, "error": str(e)[:500]})
                    self.notify({"type": "ttl_reap_failed", "environment": env.name, "deployment": name,
                                 "error": str(e)[:500], "text": f"Could not destroy expired deployment '{name}' in {env.name}: {str(e)[:200]}"})
        self.audit.emit({"type": "ttl_reaper_run", **{k: len(v) for k, v in report.items()}})
        return report

    def run_drift_scan(self, identity: Identity) -> dict:
        """Check every deployment in every environment for drift, one after the other (scheduled job)."""
        report = {"checked": 0, "drifted": [], "failed": []}
        for env in self.s.environments.values():
            for _, rec in list(iter_json(self.data, f"deployments/{env.name}/")):
                if rec.get("status") != "active":
                    continue
                ref = f"{env.name}/{rec['deployment']}"
                try:
                    op = self.detect_drift(identity, rec["deployment"], env.name, inline=True)
                    if op.get("status") != "succeeded":
                        raise ToolError(op.get("error") or str(op.get("status")))
                    report["checked"] += 1
                    if op["result"]["drifted"]:
                        report["drifted"].append(ref)
                except Exception as e:  # noqa: BLE001
                    report["failed"].append({"deployment": ref, "error": str(e)[:300]})
        self.audit.emit({"type": "drift_scan_run", "checked": report["checked"], "drifted": len(report["drifted"]),
                         "failed": len(report["failed"])})
        return report
