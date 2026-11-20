"""'Explain this plan': a structured, plain-English summary an agent can read to a human."""
from __future__ import annotations

from typing import Any

from .policy import action_kind, managed_changes

FRIENDLY = {
    "azurerm_storage_account": "storage account", "azurerm_virtual_network": "virtual network", "azurerm_subnet": "subnet",
    "azurerm_log_analytics_workspace": "Log Analytics workspace", "azurerm_key_vault": "Key Vault",
    "azurerm_service_plan": "App Service plan", "azurerm_linux_web_app": "web app", "azurerm_mssql_server": "SQL server",
    "azurerm_mssql_database": "SQL database", "azurerm_postgresql_flexible_server": "PostgreSQL server",
    "azurerm_kubernetes_cluster": "AKS cluster", "azurerm_container_registry": "container registry",
    "azurerm_private_endpoint": "private endpoint", "azurerm_network_security_group": "network security group",
    "azurerm_network_security_rule": "firewall rule", "azurerm_linux_virtual_machine": "Linux virtual machine",
    "azurerm_network_interface": "network interface", "azurerm_cosmosdb_account": "Cosmos DB account",
    "azurerm_cosmosdb_sql_database": "Cosmos DB database", "azurerm_servicebus_namespace": "Service Bus namespace",
    "azurerm_servicebus_queue": "Service Bus queue", "azurerm_subnet_network_security_group_association": "subnet firewall link",
    "azurerm_virtual_machine_extension": "VM extension", "random_string": "random name suffix",
    "azurerm_postgresql_flexible_server_active_directory_administrator": "PostgreSQL Entra administrator",
}
DATA_BEARING = {"azurerm_storage_account", "azurerm_key_vault", "azurerm_mssql_server", "azurerm_mssql_database",
                "azurerm_postgresql_flexible_server", "azurerm_cosmosdb_account", "azurerm_cosmosdb_sql_database",
                "azurerm_kubernetes_cluster", "azurerm_log_analytics_workspace", "azurerm_linux_virtual_machine"}
VERB = {"create": "Create", "update": "Change", "delete": "DELETE", "replace": "DESTROY AND RE-CREATE"}
RISK_ORDER = ["low", "medium", "high", "critical"]
_IGNORED_DIFF = {"id", "tags_all", "timeouts"}


def friendly(rtype: str) -> str:
    return FRIENDLY.get(rtype, rtype.replace("azurerm_", "").replace("_", " "))


def changed_attributes(before: Any, after: Any, unknown: Any = None) -> list[str]:
    if not isinstance(before, dict) or not isinstance(after, dict):
        return []
    keys = set(before) | set(after)
    unknown = unknown if isinstance(unknown, dict) else {}
    return sorted(k for k in keys if k not in _IGNORED_DIFF and before.get(k) != after.get(k) and not
                  (k not in after and unknown.get(k)))


def summarize_changes(plan: dict) -> tuple[dict, list[dict]]:
    counts = {"create": 0, "update": 0, "delete": 0, "replace": 0}
    lines: list[dict] = []
    for rc in managed_changes(plan):
        ch = rc.get("change") or {}
        kind = action_kind(ch.get("actions"))
        if kind not in counts:
            continue
        counts[kind] += 1
        before, after = ch.get("before") or {}, ch.get("after") or {}
        name = after.get("name") or before.get("name") or rc.get("name")
        location = after.get("location") or before.get("location")
        text = f"{VERB[kind]} {friendly(rc['type'])} '{name}'"
        if location and kind == "create":
            text += f" in {location}"
        entry = {"action": kind, "resource": rc["address"], "type": rc["type"], "text": text}
        if kind == "update":
            attrs = changed_attributes(before, after, ch.get("after_unknown"))
            entry["changed_settings"] = attrs
            if attrs:
                entry["text"] = text + f" (settings: {', '.join(attrs[:6])}{'...' if len(attrs) > 6 else ''})"
        if kind == "replace":
            paths = [".".join(str(p) for p in path) for path in ch.get("replace_paths") or []]
            if paths:
                entry["text"] = text + f" because {', '.join(paths[:4])} cannot be changed in place"
            entry["forces_replacement"] = paths
        lines.append(entry)
    order = {"delete": 0, "replace": 1, "update": 2, "create": 3}
    lines.sort(key=lambda e: (order[e["action"]], e["resource"]))
    return counts, lines


def assess_risk(plan: dict, counts: dict, *, environment: str, strict: bool, policy: dict, is_destroy: bool) -> tuple[str, list[str]]:
    level, reasons = 0, []

    def bump(to: int, why: str) -> None:
        nonlocal level
        level = max(level, to)
        reasons.append(why)

    destructive = [rc for rc in managed_changes(plan)
                   if action_kind((rc.get("change") or {}).get("actions")) in ("delete", "replace")]
    data_hits = [rc["address"] for rc in destructive if rc["type"] in DATA_BEARING]
    if data_hits:
        bump(3 if strict else 2, f"Data-bearing resource(s) would be destroyed: {', '.join(data_hits[:5])}. Data in them is lost.")
    elif destructive:
        bump(2 if strict else 1, f"{len(destructive)} resource(s) would be deleted or re-created.")
    if is_destroy:
        bump(2, "This plan removes the whole deployment.")
    if counts["update"]:
        bump(1, f"{counts['update']} existing resource(s) are modified in place.")
    total = sum(counts.values())
    if total >= 15:
        bump(2, f"Large change: {total} resources.")
    if strict and total:
        bump(1, f"Target is the '{environment}' environment, which uses the strict (production) policy profile.")
    if policy.get("violations"):
        bump(3, f"{len(policy['violations'])} policy violation(s) block this plan.")
    elif policy.get("warnings"):
        bump(1, f"{len(policy['warnings'])} policy warning(s).")
    if not reasons:
        reasons.append("Only new resources are created; nothing existing is touched." if total else "No changes.")
    return RISK_ORDER[level], reasons


def explain(plan: dict, *, meta: dict, policy: dict, cost: dict, budget: dict, approval: dict, strict: bool,
            since_last_apply: dict | None = None) -> dict:
    counts, lines = summarize_changes(plan)
    is_destroy = bool(meta.get("destroy"))
    risk, reasons = assess_risk(plan, counts, environment=meta["environment"], strict=strict, policy=policy, is_destroy=is_destroy)
    total = sum(counts.values())
    parts = [f"{counts[k]} to {label}" for k, label in
             (("create", "create"), ("update", "change"), ("replace", "replace"), ("delete", "delete")) if counts[k]]
    what = ("Destroy" if is_destroy else "Deploy") + f" '{meta['deployment']}' ({meta['template']}) in {meta['environment']}"
    headline = f"{what}: {', '.join(parts) if parts else 'no changes'}."

    delta = cost.get("monthly_delta_usd")
    coverage = cost.get("coverage") or {}
    if cost.get("status") == "estimated" and not coverage.get("priced") and not delta:
        usage = coverage.get("usage_based", 0)
        cost_text = ("No fixed monthly charge." + (f" {usage} resource(s) are billed purely by usage, which is not estimated." if usage else ""))
    elif cost.get("status") in ("estimated", "partial") and delta is not None:
        sign = "+" if delta >= 0 else "-"
        cost_text = (f"Estimated cost change: {sign}USD {abs(delta):,.2f} per month "
                     f"(deployment total about USD {cost.get('monthly_total_usd', 0):,.2f}/month, list prices"
                     f"{', partial - some items could not be priced' if cost.get('status') == 'partial' else ''}; usage charges excluded).")
    elif cost.get("status") == "disabled":
        cost_text = "Cost estimation is switched off."
    else:
        cost_text = "Cost could not be estimated for this plan."

    blockers: list[str] = [v["message"] for v in policy.get("violations", [])]
    if budget.get("allowed") is False:
        blockers.append(budget.get("message", "Over budget."))

    if not total:
        next_step = "Nothing to apply."
    elif blockers:
        next_step = "This plan cannot be applied. Fix the blocking issues (change the request) and plan again."
    elif approval.get("required") and approval.get("status") != "approved":
        next_step = ("This environment needs a second person to approve. Call request_approval, then a DIFFERENT person "
                     "calls approve_plan; after that apply_plan can run.")
    else:
        next_step = "Show this summary to the user. Only after they explicitly confirm, call apply_plan."

    speak = [headline] + [f"- {entry['text']}" for entry in lines[:12]]
    if len(lines) > 12:
        speak.append(f"- ...and {len(lines) - 12} more.")
    speak.append(f"Risk: {risk.upper()} - {' '.join(reasons)}")
    speak.append(cost_text)
    if blockers:
        speak.append("BLOCKED: " + " ".join(blockers[:5]))
    elif policy.get("warnings"):
        speak.append("Policy warnings: " + " ".join(w["message"] for w in policy["warnings"][:5]))
    else:
        speak.append("Policy check passed.")
    if since_last_apply and since_last_apply.get("summary"):
        speak.append(since_last_apply["summary"])
    speak.append(next_step)

    return {"headline": headline, "counts": counts, "changes": lines[:60], "changes_truncated": len(lines) > 60,
            "risk_level": risk, "risk_reasons": reasons, "cost_summary": cost_text, "blocked": bool(blockers),
            "blockers": blockers, "policy_warnings": [w["message"] for w in policy.get("warnings", [])],
            "since_last_apply": since_last_apply, "next_step": next_step, "read_to_user": "\n".join(speak)}
