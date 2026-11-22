# Deploy guide: Azure Terraform MCP (v2.1)

Not validated against a live tenant (README: "What was tested"). Use a sandbox subscription first.

## 0. Recommended: the installer

```
Install.cmd                                                  (double-click; interactive wizard)
Install.cmd -PreflightOnly                                   (checks only - changes nothing)
pwsh ./Install-AzureTerraformMcp.ps1 -Unattended -ConfigFile ./install.config.json     (pipelines)
Install.cmd -Uninstall
```
`Install-AzureTerraformMcp.ps1` wraps everything below: prerequisites (winget: Azure CLI, Power Platform CLI),
sign-in, subscription and Power Platform environment pickers, **preflight checks** (subscription role, Entra
permissions, provider registration, region support, storage/registry name availability, Power Platform
environment, DLP hint), the four **Entra groups**, `Deploy-AzureTerraformMcp.ps1`, the **Power Platform solution
and custom connector**, the smoke test, and `out/install-summary.md|json`, `out/agent-setup.md`,
`out/what-users-do-now.md`. It keeps a transcript in `.deploy-logs/` and resumes after a failure.

Power Platform, precisely:
* **Automated:** publisher `aztfmcp` + unmanaged solution `AzureTerraformMcp` (Dataverse Web API, token from
  `az`), connector via `pac connector create --solution-unique-name` (or `pac connector update` on re-runs).
  Sharing with the requester/viewer/admin groups via `Set-AdminPowerAppConnectorRoleAssignment` **only if** the
  module `Microsoft.PowerApps.Administration.PowerShell` is installed; the DLP check uses `Get-DlpPolicy` from
  the same module, otherwise it prints what to check by hand.
* **Not automated:** the connector's OAuth client secret (paste once in the maker portal), creating and
  publishing the agent (the installer can run `pac copilot create` from a template **you** exported with
  `pac copilot extract-template`; generating an agent definition from scratch is not a documented, supported
  path, so we do not pretend to), sharing the agent, each user's first sign-in, licensing.
* **Unverified:** all of it against a real environment. `pac` argument names and JSON output shapes follow the
  CLI's documentation as we know it; if a step fails the Azure installation still completes and the manual
  instructions are written to `out/agent-setup.md`.

The rest of this document is the manual route and the reference for every parameter.

## Prerequisites
* **Owner** on the subscription(s): the script creates custom role definitions, role assignments, locks and,
  optionally, policy definitions/assignments. (Without Owner you need Contributor + User Access Administrator +
  Resource Policy Contributor.)
* Rights to create Entra app registrations, app roles and (ideally) grant admin consent.
* Azure CLI 2.60+ (`containerapp` extension is installed by the script), **PowerShell 7**.
* Entra groups for requesters, approvers, viewers, admins. Copilot Studio with a Power Platform environment.

## 1. Deploy
```powershell
az login
./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <sub> -Environments dev,test,prod -AllowedLocations "eastus2,westus2" `
    -EnableApply -EnableDestroy `
    -RequesterGroupId <g> -ApproverGroupId <g> -ViewerGroupId <g> -AdminGroupId <g> `
    -MonthlyBudgetUsd 2000 -EnableDenyDeletePolicy `
    -EnableScheduledJobs -EnableMonitoring -AlertEmail ops@contoso.com -PrivateNetworking
```
Leave out `-EnableApply -EnableDestroy` for a plan-only first run. Re-running is the upgrade path.

What gets created in `rg-<prefix>`:

| Resource | Purpose |
|---|---|
| `ca-<prefix>` | MCP front-end (Easy Auth 401 + own token validation). Identity `id-<prefix>-plan`. |
| `ca-<prefix>-approval` | Approval page/API, kill switch, privileged executor. Identity `id-<prefix>-apply`. |
| storage account | containers `tfstate`, `plans`, `control` (approvals, freeze, quotas, protection flags), `audit` (WORM) |
| registry, Log Analytics, Container Apps environment | as before |
| jobs (`-EnableScheduledJobs`) | `caj-<prefix>-reaper` (apply identity), `caj-<prefix>-drift` (plan identity) |
| CanNotDelete lock | on `rg-<prefix>` (skip with `-NoResourceLocks`) and on each `-LockEnvironments` resource group (default `prod`) |

Entra: `<prefix>-api` (MCP audience; app roles viewer/requester/admin), `<prefix>-connector` (Copilot Studio
client), `<prefix>-approval` (approval audience + the page's own client id; app roles approver/admin; scope
`approve`; optional claim `auth_time`).

### Role definitions (exact JSON is written to `out/role-plan.json`, `role-apply.json`, `role-applyProtected.json`)
* **Plan** - `Actions: ["*/read"]`, nothing else. Assigned to the front-end identity on each environment
  resource group. If a provider refresh needs a list action (for example storage `listKeys`), add it
  consciously with `-PlanRoleExtraActions`; none is granted by default.
* **Apply** - `Actions: ["*"]`, `NotActions`: `Microsoft.Authorization/*/Write`, `Microsoft.Authorization/*/Delete`
  (role assignments, locks, policy assignments and exemptions), `elevateAccess`, blueprint assignments, deny
  settings, `Microsoft.Resources/subscriptions/resourceGroups/delete`, Key Vault purge.
* **Apply protected** (locked environments) - additionally no `delete` on Key Vault, SQL servers/databases,
  PostgreSQL flexible servers, Cosmos DB accounts, storage accounts, AKS clusters, Log Analytics workspaces,
  Service Bus namespaces, container registries.

Storage data roles: front-end = Blob Data **Reader** on `tfstate` and `control`, Contributor on `plans` and
`audit`; executor = Blob Data Contributor on the account.

### Parameters (new in v2.1 marked *)
| Parameter | Meaning |
|---|---|
| `-Environments`, `-ApprovalEnvironments`, `-AllowedLocations`, `-EnableApply`, `-EnableDestroy`, `-MonthlyBudgetUsd` | simple mode, as in v2.0. Approval environments need a second person; the others allow self-approval **on the approval page**. |
| `-EnvironmentsFile` | full control; see [environments.example.json](environments.example.json). New keys: `allow_self_approval`, `change_windows`. |
| `-RequesterGroupId`* `-ViewerGroupId`* `-AdminGroupId`* `-ApproverGroupId` | Entra groups mapped to app roles. |
| `-LockEnvironments`* (default `prod`), `-NoResourceLocks`* | CanNotDelete locks + protected apply role. In a locked resource group nothing can be deleted, so Terraform changes that must replace or remove a resource fail there until an Owner lifts the lock - intended. |
| `-EnableDenyDeletePolicy`* | Azure Policy `denyAction` (delete) for resources tagged `protected=true`, assigned to each environment resource group. |
| `-ApprovalRequireAmr`* | claim the approver's token must carry (e.g. `mfa`, or an authentication-context id). See SECURITY.md. |
| `-ApprovalAllowedCidrs`* | IP allow-list for the approval page. |
| `-AuditRetentionDays`* (365) | immutability period of the audit container (created unlocked). |
| `-PlanRoleExtraActions`* | extra actions for the read-only role. |
| `-AllowAzureCliClient`* | also accept tokens issued to the Azure CLI - needed for `Test-TerraformMcp.ps1`; leave off in production. |
| `-EnableScheduledJobs`, `-DriftCron`, `-EnableMonitoring -AlertEmail`, `-NotifyWebhookUrl`, `-MinReplicas`, `-MaxReplicas`, `-PrivateNetworking`, `-InternalIngress`, `-SecurityGroupId`, `-AllowedCidrs`, `-AuthMode`, `-RotateConnectorSecret`, `-Destroy` | as in v2.0. The webhook URL is now stored as a Container Apps secret. `-Destroy` removes the lock on `rg-<prefix>` first; locks, policies and role definitions on workload scopes are left for you to remove. |

## 2. Smoke test
```powershell
./Deploy-AzureTerraformMcp.ps1 ... -AllowAzureCliClient     # only where you want to run the test
./Test-TerraformMcp.ps1 -SubscriptionId <sub> -Prefix aztfmcp
```
Expected: MCP anonymous -> 401; approval API anonymous -> 401 and with the MCP token -> 401; initialize,
tools/list (8 tools, none for approving), whoami, catalog -> PASS (your account needs a role).

## 3. Copilot Studio (default: Dynamic discovery)
1. Copilot Studio: Agent > Tools > Add a tool > New tool > **Model Context Protocol**
2. Server URL: `https://<mcp-host>/mcp`
3. Authentication: **OAuth 2.0 > Dynamic discovery**
4. Create
5. Create new connection > sign in with your own account
6. Add to agent, paste `agent-instructions.md` into Instructions

`-ConnectorAuth dynamic` (default) makes the front-end serve the OAuth discovery + registration facade, stores the
connector secret as a Container Apps secret for the `/token` proxy, sets `PUBLIC_BASE_URL`, registers the redirect
URIs on the connector app (`-ExtraRedirectUris` adds more, exact https URLs only) and sets Easy Auth to allow
anonymous (the server validates tokens itself). **Fallback** - if the wizard has no Dynamic discovery option or it
fails - is the Manual section of `out/copilot-studio-wizard-values.md`; it works against the same deployment.
`-ConnectorAuth manual` restores the v2.2 behaviour exactly (Easy Auth returns 401, no facade, no secret in the app).
The pre-built custom connector from the installer always uses the manual OAuth settings.
Not verified against a real Copilot Studio wizard; see SECURITY.md for the trade-off.

## 4. Approving
The requester gets a link from the agent (`https://<approval-host>/?plan=<id>`) and passes it on - or
approvers open `https://<approval-host>/` and see what is waiting. The page forces a new sign-in, shows the
server-computed summary, risk, cost and policy result, and offers Approve / Reject. In two-person environments
the requester cannot approve. An approval is valid for 30 minutes and for one apply. Then the requester tells
the agent to apply. Put a Conditional Access policy on the `<prefix>-approval` app (SECURITY.md).

## 5. Operating it
* **Freeze:** `POST https://<approval-host>/api/freeze {"frozen": true, "reason": "..."}` as an admin. The
  server also freezes itself on anomalies (alert rule "KILL SWITCH"). Lift with `false`.
* **Limits** (env vars on both apps): `USER_CALLS_PER_MINUTE` 60, `USER_PLANS_PER_HOUR` 30,
  `GLOBAL_APPLIES_PER_HOUR` 20, `GLOBAL_DELETES_PER_DAY` 25, `ANOMALY_DENIED_PER_10MIN` 15,
  `ANOMALY_DESTROY_PLANS_PER_HOUR` 6, `ANOMALY_PLANS_PER_10MIN` 80, `WRITE_MAX_TOKEN_AGE_MINUTES` 75,
  `APPROVAL_MAX_AUTH_AGE_SECONDS` 600, `APPROVAL_VALID_MINUTES` 30.
* **Change windows:** per environment, e.g. `"change_windows": [{"days": ["mon","tue","wed","thu"], "start": "08:00", "end": "16:00"}]` (UTC).
* **Protected deployments:** `plan(action="deploy", protect=true)` at creation. They can be updated but never
  destroyed through MCP; their resources carry `protected=true` for the deny-delete policy.
* **Audit:** [audit-queries.kql](audit-queries.kql) (queries 14-20 are new), workbook, alerts; blobs in the
  `audit` container.
* **Templates / policies changed?** `cd server && python -m tfmcp.integrity write`, commit, redeploy.

## Private networking
`-PrivateNetworking`: VNet-integrated environment, private endpoint + private DNS for the storage account,
storage public access off. `-InternalIngress`: both apps internal-only; the gateway Copilot Studio and
approvers would then need (Application Gateway / API Management) is **not** created by the script.

## Known limits
* Not run against a live tenant; `az` flags follow current documentation. Most likely to need a tweak:
  `az role definition update`, `az lock create`, `az policy definition create` (denyAction rule),
  `az storage container immutability-policy create`, `az containerapp job update`, the VNet flags.
* The read-only plan role may be insufficient for the refresh of some resource types; the plan then fails
  with an authorization error naming the missing action (add it with `-PlanRoleExtraActions` if acceptable).
* The approval page's browser sign-in (MSAL redirect) has not been tested in a browser.
* The TTL reaper destroys time-boxed deployments without a new approval (it runs with the apply identity and
  records a system approval). Do not allow time-boxed deployments where that is not acceptable.
* AKS creates its own node resource group outside the plan, the locks and the policy gate.
