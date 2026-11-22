"""Out-of-band approval. Nothing in this module is reachable through an MCP tool.

An approval is a record in the ``control`` container, which only the approval service's identity can
write (the MCP front-end identity has read access only). It is created when a human, on the approval
page, with a token for the *approval* audience and a fresh sign-in, approves exactly what they were
shown:

* ``plan_sha256``     checksum of the binary plan file that will be applied,
* ``changes_digest``  digest of the resource changes shown to the approver (the executor recomputes it
                      from the binary plan with ``terraform show`` and refuses on any difference),
* short expiry, single use (the executor consumes it with a compare-and-swap).

The requester's "yes" in a chat is not an input anywhere."""
from __future__ import annotations

import hashlib
import json
import time
from typing import Callable

from .config import Settings
from .cost import budget_check
from .explain import explain
from .guard import Guard, GuardError
from .identity import Identity
from .operations import iso
from .policy import PolicyEngine, action_kind, managed_changes
from .storage import Conflict, NotFound, Store


class ApprovalError(Exception):
    def __init__(self, message: str, status: int = 403) -> None:
        super().__init__(message)
        self.status = status


def changes_digest(plan: dict) -> str:
    """Stable digest of what a plan does: every managed resource change with its action and resulting values."""
    rows = []
    for rc in managed_changes(plan):
        ch = rc.get("change") or {}
        kind = action_kind(ch.get("actions"))
        if kind in ("no-op", "read"):
            continue
        rows.append([rc.get("address"), rc.get("type"), kind, ch.get("after"), sorted(map(str, ch.get("replace_paths") or []))])
    rows.sort(key=lambda r: str(r[0]))
    return hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()


def count_deletes(plan: dict) -> int:
    return sum(1 for rc in managed_changes(plan) if action_kind((rc.get("change") or {}).get("actions")) in ("delete", "replace"))


class ApprovalService:
    def __init__(self, settings: Settings, *, data: Store, control: Store, policy: PolicyEngine, guard: Guard,
                 clock: Callable[[], float] = time.time, notify: Callable[[dict], None] | None = None) -> None:
        self.s = settings
        self.data = data
        self.control = control
        self.policy = policy
        self.guard = guard
        self.clock = clock
        self.notify = notify or (lambda e: None)

    # ------------------------------------------------------------------ who may approve
    def _roles(self, identity: Identity) -> set[str]:
        roles = {r.lower() for r in identity.roles}
        groups = {g.lower() for g in identity.groups}
        for role, gids in self.s.role_groups.items():
            if groups & set(gids):
                roles.add(role)
        return roles

    def check_caller(self, identity: Identity) -> None:
        """Token-level requirements of the approval channel (audience / client / scope were validated before)."""
        if not identity.authenticated or identity.is_system or identity.name.startswith("app:"):
            raise ApprovalError("Only a signed-in person can use the approval page.", 401)
        reference = identity.auth_time or identity.issued_at
        if not reference or self.clock() - reference > self.s.approval_max_auth_age_seconds:
            raise ApprovalError("Your sign-in is too old for an approval. Sign in again (a fresh sign-in is required "
                                f"every {int(self.s.approval_max_auth_age_seconds // 60)} minutes).", 401)
        if self.s.approval_require_amr and self.s.approval_require_amr not in identity.amr:
            raise ApprovalError(f"This approval needs a stronger sign-in ({self.s.approval_require_amr}). Sign in with multi-factor authentication.", 401)

    # ------------------------------------------------------------------ reading
    def _meta(self, plan_id: str) -> dict:
        if not isinstance(plan_id, str) or len(plan_id) != 12 or not all(c in "0123456789abcdef" for c in plan_id):
            raise ApprovalError("Unknown plan.", 404)
        try:
            return self.data.get_json(f"plans/{plan_id}/meta.json")
        except NotFound:
            raise ApprovalError("Unknown plan.", 404) from None

    def record(self, plan_id: str) -> dict | None:
        try:
            return self.control.get_json(f"approvals/{plan_id}.json")
        except NotFound:
            return None

    def is_protected(self, env: str, deployment: str) -> bool:
        return self.control.exists(f"protected/{env}/{deployment}.json")

    def view(self, identity: Identity, plan_id: str) -> dict:
        """Everything the approver must see, computed here (trusted side) from the stored plan."""
        self.check_caller(identity)
        meta = self._meta(plan_id)
        env = self.s.env(meta["environment"])
        plan = self.data.get_json(f"plans/{plan_id}/plan.json")
        pol = self.policy.evaluate(plan, profile=env.policy_profile, allowed_locations=env.allowed_locations,
                                   is_destroy=meta["destroy"], max_changes_override=env.max_resource_changes).as_dict()
        budget = {"status": "not_applicable", "allowed": True} if meta["destroy"] else \
            budget_check(meta["cost"], env.monthly_budget_usd, env.budget_block_if_unknown)
        exp = explain(plan, meta=meta, policy=pol, cost=meta["cost"], budget=budget, approval=meta["approval"],
                      strict=env.policy_profile == "strict", since_last_apply=meta.get("since_last_apply"))
        rec = self.record(plan_id)
        return {"plan_id": plan_id, "environment": env.name, "deployment": meta["deployment"], "template": meta["template"],
                "destroy": meta["destroy"], "requested_by": (meta.get("requested_by") or {}).get("name"),
                "justification": (meta["approval"] or {}).get("justification"),
                "plan_expires_at": iso(meta["expires_at"]), "status": (rec or {}).get("status") or meta["approval"].get("status"),
                "two_person": bool(env.require_approval), "headline": exp["headline"], "changes": exp["changes"],
                "risk_level": exp["risk_level"], "risk_reasons": exp["risk_reasons"], "cost_summary": exp["cost_summary"],
                "policy_allowed": pol["allowed"], "policy_violations": [v["message"] for v in pol["violations"]],
                "policy_warnings": [w["message"] for w in pol["warnings"]], "budget": budget,
                "ephemeral": meta.get("ephemeral"), "protect": bool(meta.get("protect")),
                "changes_digest": changes_digest(plan), "counts": exp["counts"],
                "you": identity.name, "you_may_decide": self._may_decide(identity, meta, env, True)[0]}

    def pending(self, identity: Identity) -> list[dict]:
        self.check_caller(identity)
        out = []
        for key in self.data.list("approvals-pending/"):
            plan_id = key.rsplit("/", 1)[-1]
            try:
                meta = self._meta(plan_id)
            except ApprovalError:
                continue
            if meta["status"] != "planned" or self.clock() > meta["expires_at"] or self.record(plan_id):
                continue
            out.append({"plan_id": plan_id, "environment": meta["environment"], "deployment": meta["deployment"],
                        "destroy": meta["destroy"], "requested_by": (meta.get("requested_by") or {}).get("name"),
                        "requested_at": iso((meta["approval"] or {}).get("requested_at"))})
        return out

    # ------------------------------------------------------------------ deciding
    def _may_decide(self, identity: Identity, meta: dict, env, approve: bool) -> tuple[bool, str]:
        roles = self._roles(identity)
        involved = {(meta.get("requested_by") or {}).get("oid"), ((meta.get("approval") or {}).get("requested_by") or {}).get("oid")}
        is_requester = identity.oid in involved
        if not approve and is_requester:
            return True, ""                      # withdrawing your own request is always fine
        listed = identity.oid in [x.lower() for x in env.approver_object_ids] or \
            bool({g.lower() for g in identity.groups} & {g.lower() for g in env.approver_group_ids})
        is_approver = bool(roles & {"approver", "admin"}) or listed
        if env.require_approval:
            if is_requester:
                return False, "Two-person rule: you planned or requested this change, so you cannot approve it."
            if not is_approver:
                return False, f"You do not have the approver role for environment '{env.name}'."
            return True, ""
        if is_requester and env.allow_self_approval:
            return True, ""
        if is_approver:
            return True, ""
        return False, "Only the requester or an approver can decide this plan."

    def decide(self, identity: Identity, plan_id: str, approve: bool, comment: str, seen_digest: str) -> dict:
        self.check_caller(identity)
        try:
            self.guard.require_unfrozen()
        except GuardError as e:
            raise ApprovalError(str(e), 423) from None
        meta = self._meta(plan_id)
        env = self.s.env(meta["environment"])
        if self.record(plan_id):
            raise ApprovalError("This plan was already decided.", 409)
        if (meta.get("approval") or {}).get("status") != "pending":
            raise ApprovalError("No approval was requested for this plan.", 409)
        ok, why = self._may_decide(identity, meta, env, approve)
        if not ok:
            self.notify({"type": "approval_refused", "plan_id": plan_id, "environment": env.name, "user": identity.name,
                         "user_oid": identity.oid, "reason": why})
            raise ApprovalError(why, 403)
        now = self.clock()
        digest = ""
        if approve:
            if meta["status"] != "planned" or now > meta["expires_at"]:
                raise ApprovalError("This plan is no longer open (used or expired).", 409)
            if meta["destroy"] and self.is_protected(env.name, meta["deployment"]):
                raise ApprovalError("This deployment is PROTECTED and cannot be destroyed through this system.", 403)
            view = self.view(identity, plan_id)
            digest = view["changes_digest"]
            if not view["policy_allowed"] or view["budget"].get("allowed") is False:
                raise ApprovalError("This plan violates policy or budget and cannot be approved.", 409)
            if seen_digest != digest:
                raise ApprovalError("The plan changed since you opened it. Reload and review it again.", 409)
        record = {"plan_id": plan_id, "status": "approved" if approve else "rejected", "decided_by": identity.public(),
                  "decided_at": now, "expires_at": now + self.s.approval_valid_minutes * 60, "comment": str(comment or "")[:500],
                  "plan_sha256": meta["tfplan_sha256"], "changes_digest": digest, "environment": env.name,
                  "deployment": meta["deployment"], "destroy": meta["destroy"],
                  "self_approved": identity.oid == (meta.get("requested_by") or {}).get("oid"),
                  "auth_time": identity.auth_time or identity.issued_at, "amr": list(identity.amr), "used_by": None}
        try:
            self.control.put_json(f"approvals/{plan_id}.json", record, if_none_match=True)
        except Conflict:
            raise ApprovalError("This plan was decided by someone else just now.", 409) from None
        self.data.delete(f"approvals-pending/{env.name}/{plan_id}")
        try:   # informational mirror for the requester; the executor trusts only the control record
            def mirror(doc):
                doc["approval"].update(status=record["status"], decided_by=identity.public(), decided_at=now)
                return doc
            self.data.update_json(f"plans/{plan_id}/meta.json", mirror)
        except (Conflict, NotFound):
            pass
        self.notify({"type": "approval_decided", "plan_id": plan_id, "environment": env.name, "deployment": meta["deployment"],
                     "decision": record["status"], "destroy": meta["destroy"], "user": identity.name, "user_oid": identity.oid,
                     "requested_by": (meta.get("requested_by") or {}).get("name"), "self_approved": record["self_approved"],
                     "hour_utc": time.gmtime(now).tm_hour,
                     "text": f"Plan {plan_id} for '{meta['deployment']}' in {env.name} was {record['status']} by {identity.name}."})
        return {"plan_id": plan_id, "status": record["status"], "valid_until": iso(record["expires_at"]) if approve else None}

    # ------------------------------------------------------------------ executor side
    def consume(self, meta: dict, tfplan: bytes, real_plan: dict, operation_id: str, system: bool = False) -> dict:
        """Verify and use up the approval for exactly this plan file. Raises ApprovalError otherwise."""
        env = self.s.env(meta["environment"])
        key = f"approvals/{meta['plan_id']}.json"
        try:
            rec, etag = self.control.get_json_etag(key)
        except NotFound:
            raise ApprovalError("No out-of-band approval exists for this plan.") from None
        now = self.clock()
        if rec.get("status") != "approved":
            raise ApprovalError(f"The plan was {rec.get('status')}, not approved.")
        if rec.get("used_by"):
            raise ApprovalError("This approval was already used (an approval is valid for one apply).")
        if now > rec.get("expires_at", 0):
            raise ApprovalError("The approval has expired. Request a new approval.")
        if rec.get("plan_sha256") != hashlib.sha256(tfplan).hexdigest():
            raise ApprovalError("The plan file is not the one that was approved.")
        if rec.get("changes_digest") != changes_digest(real_plan):
            raise ApprovalError("The plan file does not do what the approver was shown. Refusing to apply.")
        decider = (rec.get("decided_by") or {}).get("oid")
        if not system:
            planner = (meta.get("requested_by") or {}).get("oid")
            if env.require_approval and (not decider or decider == planner):
                raise ApprovalError("Two-person rule violated: approver and requester are the same.")
            if decider == planner and not env.allow_self_approval:
                raise ApprovalError("Self-approval is not allowed in this environment.")
        rec["used_by"] = operation_id
        rec["used_at"] = now
        try:
            self.control.put_json(key, rec, if_match=etag)
        except Conflict:
            raise ApprovalError("This approval was used by another apply just now.") from None
        return rec

    def system_approve(self, meta: dict, plan: dict, who: Identity) -> None:
        """TTL reaper only (runs in the privileged process): approval for a destroy that was agreed at creation."""
        now = self.clock()
        self.control.put_json(f"approvals/{meta['plan_id']}.json", {
            "plan_id": meta["plan_id"], "status": "approved", "decided_by": who.public(), "decided_at": now,
            "expires_at": now + 900, "plan_sha256": meta["tfplan_sha256"], "changes_digest": changes_digest(plan),
            "environment": meta["environment"], "deployment": meta["deployment"], "destroy": True, "used_by": None,
            "comment": "time-box expired (agreed when the deployment was created)"})
