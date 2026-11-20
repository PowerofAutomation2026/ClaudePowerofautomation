"""Policy-as-code gate. Evaluates the JSON form of a Terraform plan (``terraform show -json``)
against the rules in ``policies/default.json`` before the plan may be applied.

Rule types
----------
``allowed_locations``  every resource with a ``location`` must be in the environment's allowed regions
``required_tags``      every taggable resource must carry the listed tags
``attribute``          one or more ``checks`` of an attribute on given resource types
                       (ops: equals, not_equals, in, not_in, gte, lte)
``deny_actions``       forbid create / delete / replace of given resource types
``max_changes``        blast-radius limit: maximum number of resources one plan may change
``nsg_inbound``        no inbound Allow rule from the internet to management ports

Each rule has an ``enforcement`` of ``deny`` | ``warn`` | ``off`` - either one value or a value
per policy profile (``{"standard": "warn", "strict": "deny"}``). ``deny`` findings block apply.
"""
from __future__ import annotations

import json
import pathlib
from dataclasses import dataclass, field
from typing import Any

CHANGE_ACTIONS = {"create", "update", "delete"}
_RULE_TYPES = {"allowed_locations", "required_tags", "attribute", "deny_actions", "max_changes", "nsg_inbound"}
_OPS = {"equals", "not_equals", "in", "not_in", "gte", "lte"}
_ANY_SOURCE = {"*", "0.0.0.0/0", "internet", "any", "::/0"}


class PolicyError(RuntimeError):
    """The policy file itself is invalid."""


@dataclass
class Finding:
    rule: str
    severity: str           # deny | warn
    message: str
    address: str = ""

    def as_dict(self) -> dict:
        return {"rule": self.rule, "severity": self.severity, "resource": self.address, "message": self.message}


@dataclass
class PolicyResult:
    profile: str
    allowed: bool
    violations: list[dict] = field(default_factory=list)
    warnings: list[dict] = field(default_factory=list)
    rules_evaluated: int = 0
    policy_version: str = ""

    def as_dict(self) -> dict:
        return {"profile": self.profile, "allowed": self.allowed, "policy_version": self.policy_version,
                "rules_evaluated": self.rules_evaluated, "violations": self.violations, "warnings": self.warnings}


def norm_location(value: Any) -> str:
    return str(value).replace(" ", "").lower()


def action_kind(actions: list[str]) -> str:
    """Collapse Terraform's action list into create | update | delete | replace | read | no-op."""
    s = set(actions or [])
    if {"create", "delete"} <= s:
        return "replace"
    for a in ("create", "update", "delete", "read"):
        if a in s:
            return a
    return "no-op"


def managed_changes(plan: dict) -> list[dict]:
    return [rc for rc in plan.get("resource_changes", []) or [] if rc.get("mode", "managed") == "managed"]


def extract(obj: Any, path: str) -> list[Any]:
    """Values at a dotted path. Lists (Terraform nested blocks) are flattened automatically:
    ``site_config.minimum_tls_version`` works whether site_config is an object or a list of one."""
    current = [obj]
    for part in path.split("."):
        nxt: list[Any] = []
        for item in current:
            if isinstance(item, list):
                candidates = item
            else:
                candidates = [item]
            for c in candidates:
                if isinstance(c, dict) and part in c:
                    nxt.append(c[part])
        current = nxt
    flat: list[Any] = []
    for v in current:
        if isinstance(v, list) and v and all(isinstance(x, dict) for x in v):
            flat.extend(v)
        else:
            flat.append(v)
    return flat


def _is_unknown(unknown: Any, path: str) -> bool:
    vals = extract(unknown or {}, path)
    return any(v is True for v in vals)


def _compare(op: str, actual: Any, expected: Any) -> bool:
    if op == "equals":
        return actual == expected
    if op == "not_equals":
        return actual != expected
    if op == "in":
        return actual in expected
    if op == "not_in":
        return actual not in expected
    try:
        if op == "gte":
            return float(actual) >= float(expected)
        if op == "lte":
            return float(actual) <= float(expected)
    except (TypeError, ValueError):
        return False
    raise PolicyError(f"unknown op {op}")


def _port_matches(spec: Any, ports: set[int]) -> bool:
    spec = str(spec).strip()
    if spec == "*":
        return True
    try:
        if "-" in spec:
            lo, hi = (int(x) for x in spec.split("-", 1))
            return any(lo <= p <= hi for p in ports)
        return int(spec) in ports
    except ValueError:
        return False


class PolicyEngine:
    def __init__(self, document: dict) -> None:
        self.doc = document
        self.version = str(document.get("version", ""))
        self.profiles = list(document.get("profiles", {}))
        self.rules = document.get("rules", [])
        self._check()

    @classmethod
    def from_file(cls, path: pathlib.Path | str) -> "PolicyEngine":
        try:
            return cls(json.loads(pathlib.Path(path).read_text(encoding="utf-8")))
        except (OSError, ValueError) as e:
            raise PolicyError(f"cannot load policy file {path}: {e}") from e

    def _check(self) -> None:
        if not self.profiles:
            raise PolicyError("policy file needs a 'profiles' object")
        seen = set()
        for r in self.rules:
            rid = r.get("id")
            if not rid or rid in seen:
                raise PolicyError(f"rule id missing or duplicated: {rid}")
            seen.add(rid)
            if r.get("type") not in _RULE_TYPES:
                raise PolicyError(f"rule {rid}: unknown type {r.get('type')}")
            enf = r.get("enforcement", "deny")
            values = enf.values() if isinstance(enf, dict) else [enf]
            if isinstance(enf, dict) and set(enf) - set(self.profiles):
                raise PolicyError(f"rule {rid}: enforcement names an unknown profile")
            if any(v not in ("deny", "warn", "off") for v in values):
                raise PolicyError(f"rule {rid}: enforcement must be deny, warn or off")
            if r["type"] == "attribute":
                for c in r.get("checks") or []:
                    if c.get("op") not in _OPS or "attribute" not in c or "value" not in c or not c.get("resource_types"):
                        raise PolicyError(f"rule {rid}: each check needs resource_types, attribute, op, value")
                if not r.get("checks"):
                    raise PolicyError(f"rule {rid}: needs checks")
            if r["type"] in ("deny_actions",) and (not r.get("resource_types") or not r.get("actions")):
                raise PolicyError(f"rule {rid}: needs resource_types and actions")

    def has_profile(self, profile: str) -> bool:
        return profile in self.profiles

    def describe(self, profile: str) -> list[dict]:
        out = []
        for r in self.rules:
            sev = self._severity(r, profile)
            if sev != "off":
                out.append({"id": r["id"], "enforcement": sev, "description": r.get("description", "")})
        return out

    @staticmethod
    def _severity(rule: dict, profile: str) -> str:
        enf = rule.get("enforcement", "deny")
        if isinstance(enf, dict):
            return enf.get(profile, "off")
        return enf

    @staticmethod
    def _param(rule: dict, key: str, profile: str, default: Any = None) -> Any:
        v = rule.get(key, default)
        if isinstance(v, dict) and profile in v:
            return v[profile]
        return v

    # ------------------------------------------------------------------ evaluation
    def evaluate(self, plan: dict, *, profile: str, allowed_locations: list[str], is_destroy: bool = False,
                 max_changes_override: int | None = None) -> PolicyResult:
        if profile not in self.profiles:
            raise PolicyError(f"unknown policy profile '{profile}'")
        changes = managed_changes(plan)
        findings: list[Finding] = []
        evaluated = 0
        for rule in self.rules:
            sev = self._severity(rule, profile)
            if sev == "off":
                continue
            evaluated += 1
            for address, message in self._run(rule, changes, profile, allowed_locations, is_destroy, max_changes_override):
                findings.append(Finding(rule["id"], sev, message, address))
        violations = [f.as_dict() for f in findings if f.severity == "deny"]
        warnings = [f.as_dict() for f in findings if f.severity == "warn"]
        return PolicyResult(profile, not violations, violations, warnings, evaluated, self.version)

    def _run(self, rule, changes, profile, allowed_locations, is_destroy, max_override):
        typ = rule["type"]
        if typ == "allowed_locations":
            allowed = {norm_location(x) for x in allowed_locations}
            for rc in changes:
                after = (rc.get("change") or {}).get("after")
                if action_kind(rc["change"].get("actions")) not in ("create", "update", "replace") or not isinstance(after, dict):
                    continue
                loc = after.get("location")
                if isinstance(loc, str) and norm_location(loc) not in allowed:
                    yield rc["address"], (f"{rc['address']} would be placed in region '{loc}', which is not allowed in this "
                                          f"environment. Allowed regions: {sorted(allowed)}.")
        elif typ == "required_tags":
            required = self._param(rule, "tags", profile, [])
            for rc in changes:
                ch = rc.get("change") or {}
                after = ch.get("after")
                if action_kind(ch.get("actions")) not in ("create", "update", "replace") or not isinstance(after, dict):
                    continue
                if "tags" not in after or _is_unknown(ch.get("after_unknown"), "tags"):
                    continue  # resource type has no tags, or they are computed
                tags = after.get("tags") or {}
                missing = [t for t in required if not str(tags.get(t, "")).strip()]
                if missing:
                    yield rc["address"], f"{rc['address']} is missing mandatory tag(s): {', '.join(missing)}."
        elif typ == "attribute":
            for check in rule["checks"]:
                types = set(check["resource_types"])
                for rc in changes:
                    ch = rc.get("change") or {}
                    after = ch.get("after")
                    if rc.get("type") not in types or not isinstance(after, dict):
                        continue
                    if action_kind(ch.get("actions")) not in ("create", "update", "replace"):
                        continue
                    path = check["attribute"]
                    values = [v for v in extract(after, path) if v is not None]
                    if not values:
                        if _is_unknown(ch.get("after_unknown"), path):
                            continue  # decided by Azure at apply time; cannot be judged from the plan
                        if check.get("if_missing", "pass") == "fail":
                            yield rc["address"], self._msg(rule, check, rc, "(not set)")
                        continue
                    for v in values:
                        if not _compare(check["op"], v, check["value"]):
                            yield rc["address"], self._msg(rule, check, rc, v)
                            break
        elif typ == "deny_actions":
            types = set(rule["resource_types"])
            actions = set(rule["actions"])
            for rc in changes:
                kind = action_kind((rc.get("change") or {}).get("actions"))
                if rc.get("type") in types and kind in actions:
                    verb = {"delete": "deleted", "replace": "destroyed and re-created", "create": "created",
                            "update": "modified"}[kind]
                    yield rc["address"], (rule.get("message") or "{address} ({type}) would be {verb}, which this environment's "
                                          "policy does not allow.").format(address=rc["address"], type=rc["type"], verb=verb)
        elif typ == "max_changes":
            if is_destroy and rule.get("skip_destroy_plans", True):
                return
            limit = max_override if max_override is not None else self._param(rule, "max", profile, 25)
            count = sum(1 for rc in changes if action_kind((rc.get("change") or {}).get("actions")) in
                        ("create", "update", "delete", "replace"))
            if count > int(limit):
                yield "", (f"This plan changes {count} resources, more than the blast-radius limit of {limit} for this "
                           "environment. Split the change into smaller deployments.")
        elif typ == "nsg_inbound":
            ports = {int(p) for p in rule.get("ports", [22, 3389])}
            for rc in changes:
                ch = rc.get("change") or {}
                after = ch.get("after")
                if action_kind(ch.get("actions")) not in ("create", "update", "replace") or not isinstance(after, dict):
                    continue
                if rc.get("type") == "azurerm_network_security_rule":
                    rules = [after]
                elif rc.get("type") == "azurerm_network_security_group":
                    rules = after.get("security_rule") or []
                else:
                    continue
                for sr in rules:
                    if not isinstance(sr, dict):
                        continue
                    if str(sr.get("direction", "")).lower() != "inbound" or str(sr.get("access", "")).lower() != "allow":
                        continue
                    sources = [sr.get("source_address_prefix")] + list(sr.get("source_address_prefixes") or [])
                    if not any(str(s).lower() in _ANY_SOURCE for s in sources if s):
                        continue
                    dports = [sr.get("destination_port_range")] + list(sr.get("destination_port_ranges") or [])
                    hit = sorted(p for p in ports if any(_port_matches(d, {p}) for d in dports if d))
                    if hit:
                        yield rc["address"], (f"{rc['address']} rule '{sr.get('name', '?')}' opens management port(s) "
                                              f"{hit} to the whole internet. Restrict the source to a known range or use Bastion.")

    @staticmethod
    def _msg(rule: dict, check: dict, rc: dict, actual: Any) -> str:
        template = check.get("message") or rule.get("message") or \
            "{address}: {attribute} is {actual}, but policy requires it to be {op} {expected}."
        return template.format(address=rc["address"], type=rc.get("type"), attribute=check["attribute"], actual=actual,
                               op=check["op"].replace("_", " "), expected=check["value"])
