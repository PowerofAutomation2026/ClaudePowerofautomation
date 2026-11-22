"""Best-effort monthly cost ESTIMATE for the resources in a plan, from the public Azure Retail
Prices API (https://prices.azure.com/api/retail/prices - no key, list prices in USD).

What this is: list price x 730 hours for the fixed, always-on part of each resource (compute,
plan, registry unit, provisioned throughput ...).
What this is not: a quote. Usage-based charges (storage GB, requests, egress, log ingestion,
serverless compute), reservations, savings plans, dev/test and negotiated discounts are NOT included.

Every line carries a ``status``:
  priced        a list price was found
  free          the resource type has no direct charge
  usage_based   billed purely on usage; not estimated
  unpriced      no matching meter found, or the price service was unreachable
"""
from __future__ import annotations

import hashlib
import json
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

from .policy import action_kind, extract, managed_changes, norm_location
from .storage import NotFound, Store

API_URL = "https://prices.azure.com/api/retail/prices"
HOURS_PER_MONTH = 730
DISCLAIMER = ("Estimate only: Azure public list prices (USD, pay-as-you-go) for the always-on part of each resource. "
              "Usage-based charges (data stored, requests, egress, log ingestion), reservations and negotiated "
              "discounts are not included.")

FREE_TYPES = {
    "azurerm_resource_group", "azurerm_virtual_network", "azurerm_subnet", "azurerm_network_security_group",
    "azurerm_network_security_rule", "azurerm_subnet_network_security_group_association", "azurerm_network_interface",
    "azurerm_route_table", "azurerm_user_assigned_identity", "azurerm_role_assignment", "random_string", "random_id",
    "random_password", "azurerm_virtual_machine_extension", "azurerm_mssql_server",
    "azurerm_postgresql_flexible_server_active_directory_administrator", "azurerm_cosmosdb_sql_database",
    "azurerm_servicebus_queue", "azurerm_servicebus_topic", "azurerm_linux_web_app", "azurerm_windows_web_app",
    "azurerm_private_dns_zone_virtual_network_link", "azurerm_monitor_diagnostic_setting",
    "azurerm_postgresql_flexible_server_database", "azurerm_storage_container", "azurerm_management_lock",
}
USAGE_TYPES = {
    "azurerm_storage_account": "billed per GB stored and per operation",
    "azurerm_log_analytics_workspace": "billed per GB ingested and retained",
    "azurerm_key_vault": "billed per operation",
    "azurerm_private_dns_zone": "about USD 0.50 per zone per month plus queries",
}


@dataclass
class Meter:
    """One priced component of a resource: an API filter, a way to pick the row, and a quantity."""
    label: str
    filter: dict[str, str]
    pick: Callable[[dict], bool]
    quantity: float = 1.0


def _is_price_api(url: str) -> bool:
    from urllib.parse import urlsplit
    try:
        u = urlsplit(url)
    except ValueError:
        return False
    return u.scheme == "https" and u.hostname == "prices.azure.com" and u.port in (None, 443) \
        and u.username is None and u.path == "/api/retail/prices"


class PriceClient:
    """Fetches and caches price rows. ``fetch(url, params) -> dict`` is injectable for tests."""

    def __init__(self, cache: Store | None = None, fetch: Callable[[str, dict], dict] | None = None,
                 ttl_hours: float = 24.0, clock: Callable[[], float] = time.time, max_pages: int = 5) -> None:
        self.cache = cache
        self._fetch = fetch or self._http_fetch
        self.ttl = ttl_hours * 3600
        self.clock = clock
        self.max_pages = max_pages
        self._mem: dict[str, tuple[float, list[dict]]] = {}
        self._lock = threading.Lock()
        self._down_until = 0.0

    @staticmethod
    def _http_fetch(url: str, params: dict) -> dict:
        import httpx

        r = httpx.get(url, params=params or None, timeout=8.0, follow_redirects=False)
        r.raise_for_status()
        return r.json()

    @staticmethod
    def build_filter(conditions: dict[str, str]) -> str:
        return " and ".join(f"{k} eq '{str(v).replace(chr(39), chr(39) * 2)}'" for k, v in sorted(conditions.items()))

    def query(self, conditions: dict[str, str]) -> tuple[list[dict] | None, str]:
        """Returns (rows, source) where source is live | cache | stale-cache | unavailable."""
        flt = self.build_filter(conditions)
        key = "cache/prices/" + hashlib.sha256(flt.encode()).hexdigest()[:32] + ".json"
        now = self.clock()
        with self._lock:
            hit = self._mem.get(key)
        if hit is None and self.cache is not None:
            try:
                doc = self.cache.get_json(key)
                hit = (doc["fetched_at"], doc["items"])
                with self._lock:
                    self._mem[key] = hit
            except (NotFound, ValueError, KeyError):
                hit = None
        if hit and now - hit[0] < self.ttl:
            return hit[1], "cache"
        if now < self._down_until:  # circuit breaker: do not hammer / wait on an unreachable API
            return (hit[1], "stale-cache") if hit else (None, "unavailable")
        try:
            items: list[dict] = []
            page = self._fetch(API_URL, {"$filter": flt})
            for _ in range(self.max_pages):
                items.extend(page.get("Items") or [])
                nxt = page.get("NextPageLink")
                if not nxt or not _is_price_api(str(nxt)):
                    break       # never follow a link anywhere else (SSRF guard); redirects are off as well
                page = self._fetch(nxt, {})
        except Exception:
            self._down_until = now + 300
            return (hit[1], "stale-cache") if hit else (None, "unavailable")
        slim = [{k: i.get(k) for k in ("retailPrice", "unitOfMeasure", "productName", "skuName", "meterName",
                                       "armSkuName", "type", "currencyCode", "effectiveStartDate")} for i in items]
        with self._lock:
            self._mem[key] = (now, slim)
        if self.cache is not None:
            try:
                self.cache.put_json(key, {"fetched_at": now, "filter": flt, "items": slim})
            except Exception:
                pass
        return slim, "live"


def monthly_factor(unit: str) -> float | None:
    """Convert a price's unit of measure into a multiplier for one always-on month."""
    u = (unit or "").lower().replace(" ", "")
    if "hour" in u:
        qty = u.split("hour")[0].strip("/") or "1"
        try:
            return HOURS_PER_MONTH / float(qty)
        except ValueError:
            return HOURS_PER_MONTH
    if "day" in u:
        return HOURS_PER_MONTH / 24
    if "month" in u:
        return 1.0
    return None


def _norm(s: Any) -> str:
    return str(s or "").replace(" ", "").replace("_", "").lower()


def _consumption(row: dict) -> bool:
    name = f"{row.get('skuName', '')} {row.get('meterName', '')} {row.get('productName', '')}".lower()
    return row.get("type", "Consumption") == "Consumption" and "spot" not in name and "low priority" not in name


def _vm_meter(label: str, size: str, region: str, quantity: float = 1.0) -> Meter:
    return Meter(label, {"serviceName": "Virtual Machines", "armRegionName": region, "armSkuName": size,
                         "priceType": "Consumption"},
                 lambda r: _consumption(r) and "windows" not in str(r.get("productName", "")).lower(), quantity)


def _first(after: dict, path: str, default: Any = None) -> Any:
    vals = [v for v in extract(after, path) if v is not None]
    return vals[0] if vals else default


def meters_for(rtype: str, after: dict) -> list[Meter] | str:
    """Meters for a resource, or a string explaining why it is not priced."""
    region = norm_location(after.get("location") or "")
    if rtype == "azurerm_linux_virtual_machine":
        return [_vm_meter(f"VM {after.get('size')}", after.get("size"), region)]
    if rtype == "azurerm_kubernetes_cluster":
        size = _first(after, "default_node_pool.vm_size")
        count = _first(after, "default_node_pool.node_count") or _first(after, "default_node_pool.min_count") or 1
        out = [_vm_meter(f"{count} x node {size}", size, region, float(count))]
        if str(after.get("sku_tier", "Free")).lower() == "standard":
            out.append(Meter("AKS Standard tier (uptime SLA)", {"serviceName": "Azure Kubernetes Service", "armRegionName": region},
                             lambda r: _consumption(r) and "uptime sla" in str(r.get("meterName", "")).lower()))
        return out
    if rtype == "azurerm_service_plan":
        sku = _norm(after.get("sku_name"))
        os_type = str(after.get("os_type", "Linux")).lower()
        return [Meter(f"App Service plan {after.get('sku_name')} x{after.get('worker_count') or 1}",
                      {"serviceName": "Azure App Service", "armRegionName": region, "priceType": "Consumption"},
                      lambda r: _consumption(r) and _norm(r.get("skuName")) == sku
                      and (("linux" in str(r.get("productName", "")).lower()) == (os_type == "linux")),
                      float(after.get("worker_count") or 1))]
    if rtype == "azurerm_container_registry":
        sku = _norm(after.get("sku"))
        return [Meter(f"Container Registry {after.get('sku')}", {"serviceName": "Container Registry", "armRegionName": region},
                      lambda r: _consumption(r) and _norm(r.get("skuName")) == sku
                      and "registry unit" in str(r.get("meterName", "")).lower())]
    if rtype == "azurerm_mssql_database":
        sku = str(after.get("sku_name") or "")
        if sku in ("Basic", "S0", "S1", "S2", "S3"):
            want = "b" if sku == "Basic" else sku.lower()
            return [Meter(f"SQL Database {sku}", {"serviceName": "SQL Database", "armRegionName": region, "priceType": "Consumption"},
                          lambda r: _consumption(r) and _norm(r.get("skuName")) == want
                          and "dtu" in str(r.get("meterName", "")).lower()
                          and "single" in str(r.get("productName", "")).lower())]
        return f"SQL SKU {sku or '(inherited)'} is billed per vCore-second/storage; not estimated"
    if rtype == "azurerm_postgresql_flexible_server":
        sku = str(after.get("sku_name") or "")            # e.g. B_Standard_B1ms, GP_Standard_D2ds_v5
        parts = sku.split("_", 2)
        if len(parts) != 3:
            return "PostgreSQL SKU not recognised; not estimated"
        tier = {"B": "burstable", "GP": "general purpose", "MO": "memory optimized"}.get(parts[0], "")
        size = _norm(parts[2])
        return [Meter(f"PostgreSQL Flexible Server {sku} (compute)",
                      {"serviceName": "Azure Database for PostgreSQL", "armRegionName": region, "priceType": "Consumption"},
                      lambda r: _consumption(r) and "flexible server" in str(r.get("productName", "")).lower()
                      and tier in str(r.get("productName", "")).lower()
                      and _norm(r.get("skuName")).replace("vcore", "") in (size, size.replace("standard", ""))
                      and "storage" not in str(r.get("meterName", "")).lower())]
    if rtype == "azurerm_cosmosdb_account":
        caps = [str(c).lower() for c in extract(after, "capabilities.name")]
        if "enableserverless" in caps:
            return "Cosmos DB serverless is billed per request unit consumed; not estimated"
        return "Cosmos DB provisioned throughput is priced on its databases/containers; not estimated on the account"
    if rtype == "azurerm_servicebus_namespace":
        sku = str(after.get("sku") or "").lower()
        if sku == "basic":
            return "Service Bus Basic is billed per million operations; not estimated"
        if sku == "standard":
            return [Meter("Service Bus Standard base charge", {"serviceName": "Service Bus", "armRegionName": region},
                          lambda r: _consumption(r) and "standard" in _norm(r.get("skuName"))
                          and "base unit" in str(r.get("meterName", "")).lower())]
        return [Meter(f"Service Bus Premium x{after.get('capacity') or 1} messaging unit(s)",
                      {"serviceName": "Service Bus", "armRegionName": region},
                      lambda r: _consumption(r) and "premium" in _norm(r.get("skuName"))
                      and "messaging unit" in str(r.get("meterName", "")).lower(), float(after.get("capacity") or 1))]
    if rtype == "azurerm_private_endpoint":
        return [Meter("Private endpoint", {"serviceName": "Virtual Network", "armRegionName": region,
                                           "meterName": "Standard Private Endpoint"}, _consumption)]
    return "no price mapping for this resource type; not estimated"


class CostEstimator:
    def __init__(self, prices: PriceClient, enabled: bool = True) -> None:
        self.prices = prices
        self.enabled = enabled

    def _price_resource(self, rtype: str, values: dict | None) -> dict:
        if not isinstance(values, dict):
            return {"status": "free", "monthly_usd": 0.0}
        if rtype in FREE_TYPES:
            return {"status": "free", "monthly_usd": 0.0}
        if rtype in USAGE_TYPES:
            return {"status": "usage_based", "monthly_usd": None, "note": USAGE_TYPES[rtype]}
        try:
            meters = meters_for(rtype, values)
        except Exception as e:  # never let the estimator break a plan
            return {"status": "unpriced", "monthly_usd": None, "note": f"estimator error: {e}"}
        if isinstance(meters, str):
            status = "usage_based" if "billed per" in meters else "unpriced"
            return {"status": status, "monthly_usd": None, "note": meters}
        total, parts, sources = 0.0, [], set()
        for m in meters:
            if not m.filter.get("armRegionName") or any(v in (None, "", "None") for v in m.filter.values()):
                return {"status": "unpriced", "monthly_usd": None, "note": f"{m.label}: region or SKU is not known until apply"}
            rows, source = self.prices.query(m.filter)
            sources.add(source)
            if rows is None:
                return {"status": "unpriced", "monthly_usd": None, "note": "price service unreachable", "source": "unavailable"}
            candidates = []
            for r in rows:
                try:
                    if m.pick(r) and float(r.get("retailPrice") or 0) > 0 and monthly_factor(r.get("unitOfMeasure")) is not None:
                        candidates.append(r)
                except Exception:
                    continue
            if not candidates:
                return {"status": "unpriced", "monthly_usd": None, "note": f"{m.label}: no matching list price found"}
            row = min(candidates, key=lambda r: float(r["retailPrice"]))
            monthly = float(row["retailPrice"]) * monthly_factor(row["unitOfMeasure"]) * m.quantity
            total += monthly
            parts.append({"component": m.label, "unit_price_usd": row["retailPrice"], "unit": row["unitOfMeasure"],
                          "meter": row.get("meterName"), "monthly_usd": round(monthly, 2)})
        return {"status": "priced", "monthly_usd": round(total, 2), "components": parts,
                "source": "live" if "live" in sources else sorted(sources)[0]}

    def estimate(self, plan: dict) -> dict:
        """Cost of the deployment after this plan, and the change (delta) the plan causes."""
        if not self.enabled:
            return {"status": "disabled", "monthly_total_usd": None, "monthly_delta_usd": None, "items": [],
                    "disclaimer": "Cost estimates are switched off on this server."}
        items, after_total, before_total = [], 0.0, 0.0
        unknown_after = 0
        counts = {"priced": 0, "free": 0, "usage_based": 0, "unpriced": 0}
        for rc in managed_changes(plan):
            ch = rc.get("change") or {}
            kind = action_kind(ch.get("actions"))
            if kind == "read":
                continue
            before = self._price_resource(rc["type"], ch.get("before")) if ch.get("before") else None
            after = self._price_resource(rc["type"], ch.get("after")) if ch.get("after") else None
            if before and before["monthly_usd"]:
                before_total += before["monthly_usd"]
            if after:
                counts[after["status"]] += 1
                if after["monthly_usd"]:
                    after_total += after["monthly_usd"]
                if after["status"] == "unpriced":
                    unknown_after += 1
            ref = after or before or {}
            if ref.get("status") == "free":
                continue
            item = {"resource": rc["address"], "action": kind, "status": ref.get("status"),
                    "monthly_usd": (after or {}).get("monthly_usd") if after else 0.0,
                    "previous_monthly_usd": (before or {}).get("monthly_usd") if before else None}
            for k in ("note", "components"):
                if ref.get(k):
                    item[k] = ref[k]
            items.append(item)
        if counts["priced"] and not unknown_after:
            status = "estimated"
        elif counts["priced"]:
            status = "partial"
        elif unknown_after:
            status = "unavailable"
        else:
            status = "estimated"  # nothing with a fixed charge
        return {"status": status, "currency": "USD", "monthly_total_usd": round(after_total, 2),
                "monthly_delta_usd": round(after_total - before_total, 2), "coverage": counts, "items": items,
                "disclaimer": DISCLAIMER}


def budget_check(estimate: dict, budget: float | None, block_if_unknown: bool = False) -> dict:
    """Compare the estimated monthly total of the deployment with the environment's per-deployment cap."""
    if budget is None:
        return {"status": "no_budget", "allowed": True}
    total = estimate.get("monthly_total_usd")
    known = estimate.get("status") == "estimated"
    if total is not None and total > budget:
        return {"status": "over_budget", "allowed": False, "budget_usd": budget, "estimate_usd": total,
                "message": f"Estimated cost of about USD {total:,.2f}/month is over this environment's limit of "
                           f"USD {budget:,.2f}/month per deployment."}
    if not known:
        msg = "The cost could not be fully estimated, so the budget cannot be verified."
        return {"status": "unverified", "allowed": not block_if_unknown, "budget_usd": budget, "estimate_usd": total, "message": msg}
    return {"status": "within_budget", "allowed": True, "budget_usd": budget, "estimate_usd": total}
