from conftest import Clock
from tfmcp.cost import API_URL, CostEstimator, PriceClient, budget_check, monthly_factor
from tfmcp.storage import MemoryStore


def rc(rtype, after=None, before=None, actions=("create",), name="this"):
    return {"address": f"{rtype}.{name}", "mode": "managed", "type": rtype, "name": name,
            "change": {"actions": list(actions), "before": before, "after": after}}


VM_ROWS = [
    {"retailPrice": 0.0416, "unitOfMeasure": "1 Hour", "productName": "Virtual Machines BS Series", "skuName": "B2s",
     "meterName": "B2s", "armSkuName": "Standard_B2s", "type": "Consumption"},
    {"retailPrice": 0.0096, "unitOfMeasure": "1 Hour", "productName": "Virtual Machines BS Series", "skuName": "B2s Spot",
     "meterName": "B2s Spot", "armSkuName": "Standard_B2s", "type": "Consumption"},
    {"retailPrice": 0.0496, "unitOfMeasure": "1 Hour", "productName": "Virtual Machines BS Series Windows", "skuName": "B2s",
     "meterName": "B2s", "armSkuName": "Standard_B2s", "type": "Consumption"},
    {"retailPrice": 0.02, "unitOfMeasure": "1 Hour", "productName": "Virtual Machines BS Series", "skuName": "B2s",
     "meterName": "B2s", "armSkuName": "Standard_B2s", "type": "Reservation"},
]
PLAN_ROWS = [
    {"retailPrice": 0.169, "unitOfMeasure": "1 Hour", "productName": "Azure App Service Premium v3 Plan - Linux", "skuName": "P1 v3",
     "meterName": "P1 v3 App", "type": "Consumption"},
    {"retailPrice": 0.30, "unitOfMeasure": "1 Hour", "productName": "Azure App Service Premium v3 Plan", "skuName": "P1 v3",
     "meterName": "P1 v3 App", "type": "Consumption"},
]
ACR_ROWS = [{"retailPrice": 0.667, "unitOfMeasure": "1/Day", "productName": "Container Registry", "skuName": "Standard",
             "meterName": "Standard Registry Unit", "type": "Consumption"}]


class FakeApi:
    def __init__(self, fail=False):
        self.calls, self.fail = [], fail

    def __call__(self, url, params):
        self.calls.append((url, params))
        if self.fail:
            raise ConnectionError("offline")
        flt = params.get("$filter", "")
        if url != API_URL:                      # second page
            return {"Items": VM_ROWS[2:], "NextPageLink": None}
        if "Virtual Machines" in flt and "Standard_B2s" in flt:
            return {"Items": VM_ROWS[:2], "NextPageLink": API_URL + "?$skip=100"}
        if "Azure App Service" in flt:
            return {"Items": PLAN_ROWS}
        if "Container Registry" in flt:
            return {"Items": ACR_ROWS}
        return {"Items": []}


def estimator(api, store=None, clock=None):
    return CostEstimator(PriceClient(cache=store, fetch=api, clock=clock or Clock()))


VM = {"name": "vm", "location": "East US 2", "size": "Standard_B2s"}


def test_vm_price_picks_linux_payg_and_follows_pages():
    api = FakeApi()
    est = estimator(api).estimate({"resource_changes": [rc("azurerm_linux_virtual_machine", VM)]})
    assert est["status"] == "estimated" and est["monthly_total_usd"] == round(0.0416 * 730, 2) == est["monthly_delta_usd"]
    assert len(api.calls) == 2                                           # followed NextPageLink once
    flt = api.calls[0][1]["$filter"]
    assert "armRegionName eq 'eastus2'" in flt and "armSkuName eq 'Standard_B2s'" in flt and "priceType eq 'Consumption'" in flt
    assert "Estimate only" in est["disclaimer"] and est["items"][0]["components"][0]["unit"] == "1 Hour"


def test_units_quantities_and_delta():
    plan = {"resource_changes": [
        rc("azurerm_service_plan", {"location": "eastus2", "sku_name": "P1v3", "os_type": "Linux", "worker_count": 2},
           before={"location": "eastus2", "sku_name": "P1v3", "os_type": "Linux", "worker_count": 1}, actions=["update"]),
        rc("azurerm_container_registry", {"location": "eastus2", "sku": "Standard"}),
        rc("azurerm_virtual_network", {"location": "eastus2"}),
        rc("azurerm_storage_account", {"location": "eastus2"}),
        rc("azurerm_linux_virtual_machine", None, before=VM, actions=["delete"], name="old"),
    ]}
    est = estimator(FakeApi()).estimate(plan)
    plan_cost, acr = round(0.169 * 730 * 2, 2), round(0.667 * 730 / 24, 2)
    assert est["monthly_total_usd"] == round(plan_cost + acr, 2)
    assert est["monthly_delta_usd"] == round(plan_cost + acr - 0.169 * 730 - 0.0416 * 730, 2)   # was 1 worker + a VM
    by = {i["resource"]: i for i in est["items"]}
    assert by["azurerm_storage_account.this"]["status"] == "usage_based"
    assert "azurerm_virtual_network.this" not in by                       # free resources are not listed
    assert by["azurerm_linux_virtual_machine.old"]["monthly_usd"] == 0.0
    assert est["coverage"] == {"priced": 2, "free": 1, "usage_based": 1, "unpriced": 0}


def test_offline_degrades_gracefully_and_does_not_hammer_the_api():
    api = FakeApi(fail=True)
    e = estimator(api)
    plan = {"resource_changes": [rc("azurerm_linux_virtual_machine", VM), rc("azurerm_container_registry", {"location": "eastus2", "sku": "Basic"})]}
    est = e.estimate(plan)
    assert est["status"] == "unavailable" and est["monthly_total_usd"] == 0.0
    assert est["items"][0]["status"] == "unpriced" and "unreachable" in est["items"][0]["note"]
    assert len(api.calls) == 1                                            # circuit breaker: second lookup skipped
    assert budget_check(est, 100)["status"] == "unverified" and budget_check(est, 100)["allowed"] is True
    assert budget_check(est, 100, block_if_unknown=True)["allowed"] is False


def test_cache_in_memory_and_in_store_and_stale_fallback():
    store, clock, api = MemoryStore(), Clock(), FakeApi()
    plan = {"resource_changes": [rc("azurerm_container_registry", {"location": "eastus2", "sku": "Standard"})]}
    first = estimator(api, store, clock).estimate(plan)
    assert first["items"][0]["components"][0]["monthly_usd"] > 0 and len(api.calls) == 1
    assert len(store.list("cache/prices/")) == 1
    # a new process (new client) reads the stored cache and does not call the API
    api2 = FakeApi()
    second = estimator(api2, store, clock).estimate(plan)
    assert second["monthly_total_usd"] == first["monthly_total_usd"] and api2.calls == []
    # cache expired + API down -> stale cache is still used
    clock.advance(48 * 3600)
    api3 = FakeApi(fail=True)
    third = estimator(api3, store, clock).estimate(plan)
    assert third["monthly_total_usd"] == first["monthly_total_usd"] and len(api3.calls) == 1


def test_unmapped_and_unknown_sku_are_reported_not_guessed():
    plan = {"resource_changes": [rc("azurerm_firewall", {"location": "eastus2"}),
                                 rc("azurerm_linux_virtual_machine", {"location": "eastus2", "size": "Standard_Nope"}, name="x"),
                                 rc("azurerm_mssql_database", {"sku_name": "GP_S_Gen5_1"}),
                                 rc("azurerm_linux_virtual_machine", {"location": None, "size": "Standard_B2s"}, name="noloc")]}
    est = estimator(FakeApi()).estimate(plan)
    by = {i["resource"]: i for i in est["items"]}
    assert by["azurerm_firewall.this"]["status"] == "unpriced"
    assert "no matching list price" in by["azurerm_linux_virtual_machine.x"]["note"]
    assert by["azurerm_mssql_database.this"]["status"] == "usage_based"
    assert "not known until apply" in by["azurerm_linux_virtual_machine.noloc"]["note"]
    assert est["status"] == "unavailable"


def test_aks_counts_nodes():
    aks = {"location": "eastus2", "sku_tier": "Free", "default_node_pool": [{"vm_size": "Standard_B2s", "node_count": 3}]}
    est = estimator(FakeApi()).estimate({"resource_changes": [rc("azurerm_kubernetes_cluster", aks)]})
    assert est["monthly_total_usd"] == round(0.0416 * 730 * 3, 2)


def test_budget_check():
    est = {"status": "estimated", "monthly_total_usd": 600.0}
    over = budget_check(est, 500)
    assert over["allowed"] is False and over["status"] == "over_budget" and "USD 600.00" in over["message"]
    assert budget_check(est, 700)["status"] == "within_budget"
    assert budget_check(est, None) == {"status": "no_budget", "allowed": True}
    # a partial estimate that is already over budget still blocks
    assert budget_check({"status": "partial", "monthly_total_usd": 900.0}, 500)["allowed"] is False


def test_disabled_and_filter_escaping():
    est = CostEstimator(PriceClient(fetch=FakeApi()), enabled=False).estimate({"resource_changes": [rc("azurerm_linux_virtual_machine", VM)]})
    assert est["status"] == "disabled" and est["monthly_total_usd"] is None
    assert PriceClient.build_filter({"skuName": "O'Brien"}) == "skuName eq 'O''Brien'"
    assert monthly_factor("1 Hour") == 730 and monthly_factor("100 Hours") == 7.3 and monthly_factor("1/Day") == 730 / 24
    assert monthly_factor("1/Month") == 1 and monthly_factor("1 GB") is None


def test_next_page_link_to_another_host_is_not_followed():
    calls = []

    def api(url, params):
        calls.append(url)
        return {"Items": ACR_ROWS, "NextPageLink": "https://evil.example/steal"}
    estimator(api).estimate({"resource_changes": [rc("azurerm_container_registry", {"location": "eastus2", "sku": "Standard"})]})
    assert calls == [API_URL]
