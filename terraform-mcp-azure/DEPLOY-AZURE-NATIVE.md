# Deploy guide: Azure Terraform MCP (v2)

Not validated against a live tenant (see README "What was tested"). Use a sandbox subscription first.

## Prerequisites
* Azure subscription: **Owner**, or Contributor + User Access Administrator (the script assigns roles).
* Rights to create Entra app registrations and (ideally) grant admin consent.
* Azure CLI 2.60+ with the `containerapp` extension (installed by the script), **PowerShell 7**.
* Copilot Studio with a Power Platform environment. No Docker, no HCP Terraform account.

## 1. Deploy

```powershell
az login
# safe first run: one "dev" environment, plan-only
./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <sub-guid>
```
The script prints nine steps and ends with the endpoint URL. Everything it creates lives in `rg-<prefix>`
(default prefix `aztfmcp`); workloads go to one resource group per environment.

Typical production-shaped run:
```powershell
./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <sub-guid> `
    -Environments dev,test,prod -AllowedLocations "eastus2,westus2" `
    -EnableApply -EnableDestroy `
    -ApproverGroupId <entra-group-object-id> `
    -MonthlyBudgetUsd 2000 `
    -EnableScheduledJobs -EnableMonitoring -AlertEmail ops@contoso.com `
    -SecurityGroupId <entra-group-allowed-to-use-the-agent>
```

### Parameters

| Parameter | Meaning |
|---|---|
| `-Environments dev,test,prod` | Simple mode. One resource group `rg-<prefix>-<env>` per name. |
| `-ApprovalEnvironments prod` | Simple mode. These environments get the **strict** policy profile, **two-person approval**, and no time-boxed deployments. Default: `prod`. |
| `-EnableApply` / `-EnableDestroy` | Simple mode. Without them the server is plan-only. |
| `-AllowedLocations`, `-MonthlyBudgetUsd` | Simple mode. Regions and per-deployment monthly cap for all environments. |
| `-ApproverGroupId` | Only members of this Entra group may approve (uses the `groups` claim of the token; users in more than 200 groups get no such claim and cannot approve). Without it, any signed-in user other than the requester may approve. |
| `-EnvironmentsFile ./environments.json` | Full control instead of simple mode: per-environment subscription, resource group, regions, policy profile, flags, budget, approvers, allowed templates. See [environments.example.json](environments.example.json). |
| `-EnableScheduledJobs`, `-DriftCron` | Creates two scheduled Container Apps Jobs: TTL reaper (every 15 min) and drift scan (default 03:00 UTC). **Without the reaper, time-boxed deployments are never destroyed.** |
| `-EnableMonitoring -AlertEmail` | Deploys `monitoring/monitoring.json`: an audit workbook, an e-mail action group and 8 log alert rules. |
| `-NotifyWebhookUrl` | The server POSTs `{"text": ..., "event": ...}` there for approval requests/decisions and TTL notices (for example a Teams workflow webhook). |
| `-MinReplicas`, `-MaxReplicas` | Replica range (default 1-3). Operations are safe across replicas. |
| `-PrivateNetworking` | VNet-integrated Container Apps environment, private endpoint + private DNS for the state storage account, storage public access disabled. Only for a **new** deployment (an existing environment cannot be moved into a VNet). |
| `-InternalIngress` | With `-PrivateNetworking`: no public endpoint at all. See "Private networking" below - you must publish it yourself. |
| `-SecurityGroupId`, `-AllowedCidrs` | Only members of a group may obtain a token; ingress IP allow-list. |
| `-AuthMode jwt\|easyauth` | `jwt` (default): the server validates the bearer token itself in addition to Easy Auth. `easyauth`: trust the Easy Auth identity headers only. |
| `-RotateConnectorSecret` | Issue a new connector client secret (otherwise the existing one is kept across re-runs). |
| `-Destroy` | Remove the server, state storage, logs and app registrations. Workload resource groups are not deleted. |

Re-running the script is the upgrade path: it rebuilds the image and updates the app and its configuration
in place. Changing policy rules or templates = edit the files, re-run.

## 2. Smoke test
```powershell
./Test-TerraformMcp.ps1 -SubscriptionId <sub-guid> -Prefix aztfmcp
```
Expected: anonymous POST -> 401; initialize, tools/list, whoami, list_environments, list_templates -> PASS.
If every authenticated call returns 401 with `missing bearer token` in the logs, your platform is not
forwarding the Authorization header to the app: re-run with `-AuthMode easyauth`.

## 3. Copilot Studio
1. Open `out/copilot-studio-wizard-values.md`. In Copilot Studio: Agent > Tools > Add a tool > New tool >
   Model Context Protocol, choose **OAuth 2.0 > Manual** and paste the values (the client secret is in
   `out/connector-client-secret.txt`, which is git-ignored).
2. If the wizard shows a redirect URL other than `https://global.consent.azure-apim.net/redirect`, add it to
   the `<prefix>-connector` app registration.
3. Create the connection, sign in, add to the agent. **Use end-user authentication** (each user signs in):
   approvals and audit depend on the real user. A shared maker connection would make everyone the same person
   and defeat the two-person rule.
4. Paste [agent-instructions.md](agent-instructions.md) into the agent's Instructions.

Entra ID has no dynamic client registration, so the wizard's "Dynamic discovery" option cannot be used;
the app registration is pre-created and pre-consented instead.

## 4. Try it
* "What can you build here?" -> `list_environments`, `list_templates`
* "Plan a storage account called demo-data in dev" -> plan, explanation, policy and cost
* "Go ahead" -> `apply_plan`
* "Give me a sandbox Postgres for 8 hours" -> `plan_deployment(..., ttl_hours=8)`
* In prod: plan -> "request approval" -> a second user: "show pending approvals", "approve plan ..." -> apply
* "Has anything drifted in dev?" -> `detect_drift`

## Environments in detail
Each environment in `environments.json` (generated into `out/environments.json`, passed to the server as
`ENVIRONMENTS_B64`):

| Setting | Default | Meaning |
|---|---|---|
| `resource_group` | required | The only place this environment's resources go. The script creates it and grants the identity Contributor on it. |
| `subscription_id` | deploy subscription | Another subscription is fine if you can assign roles there. |
| `allowed_locations` | required | Regions; the first is the default. Enforced on input **and** by policy on the plan. |
| `policy_profile` | `standard` | `standard` or `strict` (see the policy file). |
| `enable_apply` / `enable_destroy` | `false` | Plan-only unless set. |
| `require_approval` | `false` | Two-person approval for apply and destroy. |
| `approver_group_ids` / `approver_object_ids` | none | Who may approve. |
| `monthly_budget_usd` | none | Per-deployment cap on the estimate; over budget blocks apply. `budget_block_if_unknown` also blocks when the estimate is incomplete. |
| `max_resource_changes` | from policy | Overrides the blast-radius limit. |
| `allow_ephemeral`, `max_ttl_hours` | `false`, 168 | Time-boxed deployments. Cannot be combined with `require_approval`. |
| `plan_ttl_minutes` | 60 (480 with approval) | How long a plan may wait before it must be re-created. |
| `allowed_templates` | all | Restrict the catalog per environment. |
| `default_tags` | none | Extra tags on everything (for example `costCenter`, which the strict profile requires). |

## Private networking
* `-PrivateNetworking` (implemented): the Container Apps environment is injected into `vnet-<prefix>`
  (`snet-containerapps`, delegated), the state storage account gets a private endpoint and private DNS zone
  and its public network access is turned off. The MCP endpoint itself stays public (HTTPS + Entra ID),
  because Copilot Studio is a public cloud service that must reach it. The registry stays public (Entra-only).
* `-InternalIngress` (partially implemented): the environment is created internal-only, so the endpoint has
  no public address. **The script does not create the gateway that Copilot Studio would then need**
  (Application Gateway or API Management with a public listener, certificate, and DNS for the internal
  environment domain). Treat this flag as a starting point for a network team, not a finished feature.
* Templates can target your networks (subnet IDs for VMs, AKS, private endpoints). If a subnet is in another
  resource group, grant the identity `Network Contributor` (or a narrower join role) on it yourself.

## Operations
* **Logs / audit**: Log Analytics workspace `log-<prefix>`; queries in [audit-queries.kql](audit-queries.kql);
  audit blobs in container `audit` (`YYYY/MM/DD/...json`). For tamper-evidence add a time-based immutability
  policy to that container (not configured by the script).
* **State**: container `tfstate`, key `<environment>/<deployment>.tfstate`, versioning and 30-day soft delete on.
* **Stuck deployment**: `get_deployment` shows `busy_with_operation`. A dead worker is detected after
  `LEASE_SECONDS` (120) and cleared automatically by any replica; `python server.py job recover` forces a pass.
* **Interrupted apply**: reported as `interrupted`; run a new plan - Terraform shows what is left.
* **Secret rotation**: `-RotateConnectorSecret`, then update the secret in the Copilot Studio connection.
* **Server settings** (env vars on the Container App): `SYNC_WAIT_SECONDS` (20), `MAX_CONCURRENT_OPS` (2),
  `LEASE_SECONDS` (120), `TTL_NOTICE_HOURS` (24), `TTL_MIN_NOTICE_MINUTES` (30), `COST_ESTIMATES` (true),
  `PRICE_CACHE_HOURS` (24).

## Known limits
* Not run against a live tenant. `az` flag names follow current documentation; the most likely places to need
  a tweak are `az containerapp env create` (VNet flags), `az containerapp job create` and
  `az containerapp update --termination-grace-period` (the last one only warns if it fails).
* The managed identity is Contributor on resource groups only: templates cannot assign roles. Grant data-plane
  roles (Key Vault, storage, Cosmos DB, AKS) yourself, or extend the identity deliberately.
* AKS creates its own node resource group and an outbound public IP that are outside the plan and the policy gate.
* Cost estimates cover fixed charges of the common resource types only; anything else is listed as not estimated.
* The reaper destroys with the same policy gate as users: in a `strict` environment protected resource types
  block the automatic destroy (reported, not forced).
* One deployment = one template instance; there is no cross-deployment dependency tracking. Pass outputs of
  one deployment (IDs) as inputs to another.
