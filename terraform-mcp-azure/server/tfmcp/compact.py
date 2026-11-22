"""Token-frugal views of results for the agent. The service layer keeps full, readable structures (used by
the approval page, the audit trail and tests); what goes back through MCP is the minimum an agent needs,
as compact JSON without nulls / empty values, with explicit truncation markers."""
from __future__ import annotations

import json
from typing import Any

from .sanitize import deep_clean, prune

MAX_RESULT_CHARS = 6000
POLL_SECONDS = 20


def dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)


def fit(value: Any, limit: int = MAX_RESULT_CHARS) -> Any:
    """Shrink the largest list until the result fits; mark it so the agent knows there is more."""
    for _ in range(40):
        if len(dumps(value)) <= limit or not isinstance(value, dict):
            return value
        best, best_size = None, 0

        def scan(node, holder=None, key=None):
            nonlocal best, best_size
            if isinstance(node, list) and len(node) > 1 and holder is not None:
                size = len(dumps(node))
                if size > best_size:
                    best, best_size = (holder, key), size
            if isinstance(node, dict):
                for k, v in node.items():
                    scan(v, node, k)
            elif isinstance(node, list):
                for item in node:
                    scan(item)
        scan(value)
        if best is None:
            return {"truncated": True, "note": "result too large", "partial": dumps(value)[:limit - 200]}
        holder, key = best
        holder[key] = holder[key][:max(1, len(holder[key]) // 2)]
        holder["truncated"] = True
        value.setdefault("more", "ask for a narrower result (name, page, fields, detail)")
    return value


def finish(value: Any) -> str:
    return dumps(fit(prune(deep_clean(value))))


def plan(view: dict, detail: bool = False) -> dict:
    if not view.get("has_changes"):
        return {"changes": "none", "env": view["environment"], "name": view["deployment"], "say": "No changes: Azure already matches."}
    exp, cost, appr = view["explanation"], view["cost"], view["approval"]
    out = {"plan": view["plan_id"], "env": view["environment"], "name": view["deployment"], "tpl": view["template"],
           "destroy": view["destroy"], "chg": {k: v for k, v in exp["counts"].items() if v}, "risk": exp["risk_level"],
           "cost": {"st": cost.get("status"), "mo_usd": cost.get("monthly_total_usd"), "delta_usd": cost.get("monthly_delta_usd")},
           "deny": [v["message"] for v in view["policy"]["violations"]][:5],
           "warn": len(view["policy"]["warnings"]),
           "approval": {"st": appr.get("status"), "two_person": appr.get("two_person"), "url": appr.get("approve_at"),
                        "until": appr.get("valid_until")},
           "can_apply": view["can_apply"], "blockers": view["blockers"][:5], "expires": view["expires_at"],
           "ttl_h": (view.get("ephemeral") or {}).get("ttl_hours"), "protect": view.get("protect"),
           "say": "\n".join(exp["read_to_user"].split("\n")[:11])}
    if not view["can_apply"] and not view["blockers"]:
        out["next"] = exp["next_step"]
    if detail:
        out["changes"] = [{"a": c["action"], "r": c["resource"], "t": c["text"], "set": c.get("changed_settings")} for c in exp["changes"][:30]]
        out["warnings"] = [w["message"] for w in view["policy"]["warnings"]][:10]
        out["cost_items"] = [{"r": i["resource"], "st": i["status"], "mo_usd": i.get("monthly_usd"), "note": i.get("note")}
                             for i in (cost.get("items") or [])[:10]]
        out["since"] = (exp.get("since_last_apply") or {}).get("summary")
        out["risk_why"] = exp["risk_reasons"]
    return out


def operation(op: dict, detail: bool = False) -> dict:
    if op.get("unchanged"):
        return {"op": op["operation_id"], "st": op["status"], "unchanged": True, "etag": op.get("etag"), "poll_s": POLL_SECONDS}
    out = {"op": op["operation_id"], "st": op["status"], "kind": op.get("kind"), "etag": op.get("etag")}
    if op["status"] in ("queued", "running"):
        out["prog"] = op.get("progress")
        out["poll_s"] = POLL_SECONDS
        return out
    if op.get("error"):
        out["err"] = op["error"]
    res = op.get("result")
    if isinstance(res, dict):
        if "has_changes" in res:
            out["result"] = plan(res, detail)
        elif "applied" in res:
            out["result"] = {"applied": True, "destroyed": res.get("destroyed"), "env": res["environment"], "name": res["deployment"],
                             "outputs": res.get("outputs"), "resources": len(res.get("resources") or []),
                             "expires": res.get("expires_at")}
        elif "drifted" in res:
            out["result"] = {"name": res["deployment"], "drifted": res["drifted"], "n": len(res.get("changes") or []),
                             "changes": [{"r": c["resource"], "what": c["what"], "set": c.get("changed_settings", [])[:6]}
                                         for c in (res.get("changes") or [])[:10]], "checked": res.get("checked_at")}
        else:
            out["result"] = res
    return out


def deployment_row(d: dict) -> dict:
    return {"name": d["deployment"], "env": d["environment"], "tpl": d.get("template"), "st": d.get("status"),
            "owner": d.get("owner"), "applied": d.get("applied_at"), "mo_usd": d.get("monthly_estimate_usd"),
            "exp_h": d.get("expires_in_hours"), "drift": (d.get("drift") or {}).get("drifted"), "note": d.get("note")}


def deployment(d: dict) -> dict:
    out = deployment_row(d)
    out.update(vars=d.get("variables"), outputs=d.get("outputs"), protected=d.get("protected"),
               resources=[r.get("id") or r.get("address") for r in (d.get("resources") or [])][:25],
               busy=d.get("busy_with_operation"), expires=d.get("expires_at"),
               history=[{"at": h.get("at"), "act": h.get("action"), "by": h.get("by"), "planned": h.get("planned_by"),
                         "approved": h.get("approved_by"), "plan": h.get("plan_id")} for h in d.get("history") or []],
               history_more=d.get("history_truncated"),
               drift_changes=[c["resource"] for c in ((d.get("drift_detail") or {}).get("changes") or [])][:10])
    return out


def environments(listing: dict) -> dict:
    envs = {}
    for e in listing["environments"]:
        envs[e["name"]] = {"regions": e["allowed_locations"], "apply": e["enable_apply"], "destroy": e["enable_destroy"],
                           "approval": "two-person" if e["require_approval"] else "self (on approval page)",
                           "policy": e["policy_profile"], "budget_usd": e.get("monthly_budget_usd"),
                           "ttl_max_h": e["max_ttl_hours"] if e.get("allow_ephemeral") else None,
                           "windows_utc": [f"{','.join(w.get('days') or ['daily'])} {w['start']}-{w['end']}" for w in e.get("change_windows") or []],
                           "templates": e.get("allowed_templates")}
    return {"default": listing["default_environment"], "envs": envs}


def templates(listing: dict) -> dict:
    """One line per template: 'category | title | needs: required vars'."""
    out = {}
    for t in listing["templates"]:
        required = [k for k, sig in t["variables"].items() if "REQUIRED" in sig]
        out[t["name"]] = f"{t['category']} | {t['title']}" + (f" | needs: {', '.join(required)}" if required else "")
    return {"env": listing["environment"], "regions": listing["allowed_locations"], "templates": out,
            "more": "catalog(what='template', name=...) for variables"}


def template(spec: dict, signature) -> dict:
    return {"name": spec["name"], "v": spec["version"], "about": spec["description"],
            "vars": {k: signature(v) for k, v in spec["variables"].items()},
            "also": "location, tags, ttl_hours, protect", "outputs": list((spec.get("outputs") or {}).keys()),
            "notes": spec.get("notes")}
