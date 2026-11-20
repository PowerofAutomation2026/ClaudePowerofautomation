# Azure Terraform MCP (v2) - governed Terraform for Copilot Studio agents

Let a Copilot Studio agent provision Azure infrastructure **safely**: it can only use approved templates,
every plan is checked against policy and priced before anyone can apply it, production changes need a
second person, and every call is logged with the caller's Entra identity.

Terraform runs inside **Azure Container Apps** with a **managed identity** - no HCP Terraform, no stored
cloud credentials. One PowerShell command deploys everything, including the Copilot Studio connector files.

```
 Copilot Studio agent                       Azure Container Apps (1..N replicas)
 (each user signs in) --OAuth, Entra ID-->  Easy Auth (401 for anonymous)
                                             |
                                             v
                               +-------------------------------+
                               |  azure-terraform-mcp  (/mcp)  |
                               |  token re-validation -> who   |
                               |  schema validation of inputs  |      Azure Retail Prices API
                               |  POLICY GATE on plan JSON     | ---> (public list prices, cached)
                               |  cost estimate + budget cap   |
                               |  two-person approval          |
                               |  explain-this-plan            |
                               |  durable operations + leases  |
                               +---------------+---------------+
                 terraform (pinned, in image)  |   managed identity (Contributor on the
                                               |   environment resource groups ONLY)
        +--------------------+-----------------+------------------+
        v                    v                                    v
  rg-<prefix>-dev      rg-<prefix>-test                   rg-<prefix>-prod        <- workloads
  (standard policy)    (standard policy)                  (strict policy, approval)

  Storage account: tfstate/<env>/<deployment>.tfstate | plans, operations, locks, approvals | audit
  Scheduled Container Apps Jobs: TTL reaper (every 15 min), drift scan (nightly)
  Log Analytics: structured audit lines -> workbook + alert rules
```

## What it does

| | |
|---|---|
| **Template catalog** | 15 secure-by-default templates with a typed schema: storage-account, key-vault, sql-database, postgres-flexible, cosmos-db, app-service, aks-cluster, container-registry, linux-vm, virtual-network, hub-network, network-security-group, private-endpoint, service-bus, log-analytics. Inputs are validated (types, allowed values, ranges, formats) before Terraform runs. |
| **Policy gate** | Rules in [`server/policies/default.json`](server/policies/default.json) are evaluated on `terraform show -json` of every plan: allowed regions, mandatory tags, no public blobs / public network access, TLS 1.2+, Entra-only auth, approved SKUs, protected resources cannot be deleted, blast-radius limit. Violations block apply and are explained in plain language. Checked again at apply time. |
| **Cost before apply** | Monthly estimate from the public Azure Retail Prices API (no key), cached, clearly labelled, with an optional per-deployment budget cap that blocks apply. |
| **Environments** | dev / test / prod (any names): each has its own resource group, optionally its own subscription, regions, policy profile, apply/destroy switches, budget and approval rule - and its own Terraform state prefix. |
| **Two-person approval** | In approval environments the person who planned (or requested approval) cannot approve. Approvals are bound to the plan's checksum and recorded with Entra identity. |
| **Explain this plan** | Structured plain-English summary: what changes, risk level and why, cost change, policy result, what must happen next. |
| **Time-boxed environments** | `ttl_hours` on a new deployment makes it self-destruct: a scheduled job sends a notice, then plans and applies the destroy. Only deployments created that way are ever touched. `extend_ttl` postpones. |
| **Drift detection** | `detect_drift` for one or all deployments (`terraform plan -refresh-only`), plus a scheduled scan. |
| **Rollback** | `plan_rollback` plans a return to the inputs of the previous successful apply; plans also show what changed since the last apply. |
| **Per-user audit** | Every tool call: who (Entra object id + UPN), tool, argument hash, outcome - to Log Analytics and to blob. KQL queries, a workbook and alert rules are included. |
| **Durable operations** | Plans and applies are pollable operations stored in blob storage with leases. Replicas can restart or scale: plans are retried, interrupted applies are detected and reported, orphaned Terraform state locks are released. |

## Quick start

```powershell
# 1. plan-only sandbox (nothing can be changed yet)
./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid>

# 2. three environments, changes allowed, prod needs approval, jobs + alerts
./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -Environments dev,test,prod -EnableApply -EnableDestroy `
    -ApproverGroupId <entra-group-id> -EnableScheduledJobs -EnableMonitoring -AlertEmail ops@contoso.com

# 3. smoke test, then paste out/copilot-studio-wizard-values.md into Copilot Studio
./Test-TerraformMcp.ps1 -SubscriptionId <guid> -Prefix aztfmcp
```
Full guide: [DEPLOY-AZURE-NATIVE.md](DEPLOY-AZURE-NATIVE.md). Agent instructions: [agent-instructions.md](agent-instructions.md).
Security: [SECURITY.md](SECURITY.md), [THREAT-MODEL.md](THREAT-MODEL.md). Background: [BLOG.md](BLOG.md).

## MCP tools

| Tool | Purpose |
|---|---|
| `whoami`, `list_environments`, `list_templates`, `describe_template` | Discover identity, environment rules and the typed template schemas |
| `plan_deployment`, `plan_destroy`, `plan_rollback` | Create a plan (nothing changes). Returns explanation, policy, cost, approval need |
| `explain_plan` | Plain-English summary of a saved plan |
| `request_approval`, `approve_plan`, `reject_plan`, `list_pending_approvals` | Two-person approval |
| `apply_plan` | Apply a saved plan (all gates re-checked) |
| `get_operation` | Poll a long-running plan / apply / drift check |
| `list_deployments`, `get_deployment` | Inventory, history (who planned / approved / applied), outputs, drift |
| `detect_drift`, `extend_ttl` | Drift check; postpone a time-boxed deployment's expiry |

Long operations return within about 20 seconds with an `operation_id`; the agent polls `get_operation`.

## How long-running work survives restarts (design choice)

Operations run **inside the server replicas** (not as separate jobs), but nothing lives only in memory:

* the operation record, the per-deployment lock, plans and approvals are blobs; every state change is a
  compare-and-swap on the blob's ETag, so two replicas can never run the same operation or two operations on
  one deployment;
* the running replica renews a lease every 20 s. If it dies, any other replica (or the `recover` job) notices
  the expired lease: **plans and drift checks are re-queued** (max 3 attempts); an **apply is never re-run
  automatically** - it is marked `interrupted`, the user is told to plan again, and the Terraform state-blob
  lease left by the dead process is broken so the deployment is not stuck;
* on SIGTERM (scale-in, new revision) Terraform receives SIGINT so it finishes the current resource, writes
  state and unlocks; the termination grace period is raised to 10 minutes for that.

Why not one Container Apps Job per operation? It would add 20-60 s of cold start to every plan (painful in a
chat), a second identity/permission surface, and the same recovery logic would still be needed for jobs that
die. Jobs are used where they fit: the scheduled TTL reaper and drift scan.

## What was tested, and what was not

Tested in the build environment (no Azure tenant was available):

* **176 unit / integration tests** (`pytest`): schema validation, policy engine, cost estimator (mocked HTTP,
  cache, offline), JWT validation, approvals, TTL reaper, drift, rollback, operation durability (dead worker,
  racing replicas, zombie worker), audit, and the real MCP streamable-HTTP app in process.
* **Storage semantics against the Azurite emulator** (3 tests): ETag compare-and-swap, conditional delete,
  breaking a Terraform-style infinite lease, six racing workers claiming one operation.
* **`terraform validate` + `terraform fmt`** for all 15 templates with Terraform 1.9.8 and the exact pinned
  providers (azurerm 4.81.0, random 3.9.1).
* **Managed identity token broker** against the real Terraform 1.9.8 azurerm backend and the real azurerm
  4.81.0 provider binary: both requested and accepted tokens from it (the calls to Azure itself then failed,
  as expected without a tenant).
* **PowerShell**: all scripts parse with PowerShell 7.4; `Deploy-AzureTerraformMcp.ps1` was *executed* end to
  end against a fake `az` CLI in five scenarios (default, everything on, in-place re-run, environments file,
  destroy) with assertions on every `az` argument list and the generated connector files.
* **Local smoke run** over real HTTP: 401 for anonymous, initialize, tools/list, plan, apply, polling a slow
  operation, graceful shutdown on SIGTERM (with a stub in place of Terraform's Azure calls).

**Not tested:** anything against a live Azure tenant or a real Copilot Studio agent - no `terraform plan/apply`
against Azure, no real Easy Auth, no real `az` behaviour (flag names follow current documentation), not the
Docker image build (no Docker daemon was available), not the Azure Monitor workbook/alert template, and the
price-meter matching was written against the documented API shape but not run against the live price API.
**Run it in a sandbox subscription first.**

## Repository layout

```
Deploy-AzureTerraformMcp.ps1   zero-touch deploy (this product)
Test-TerraformMcp.ps1          smoke test
server/                        the MCP server (server.py + tfmcp/ package), Dockerfile, pinned requirements
server/templates/              the template catalog (main.tf + template.json each, _common/common.tf)
server/policies/default.json   policy rules (edit, rebuild)
server/tests/                  pytest suite
monitoring/monitoring.json     workbook + alert rules (ARM)
audit-queries.kql              audit queries for Log Analytics
environments.example.json      per-environment configuration example
ci/                            CI example and test harnesses (fake az, Azurite, terraform validate)
Deploy-TerraformMcp.ps1, DEPLOY.md, terraform/hcp-azure-workspace/   older HCP Terraform variant (see below)
```

## Run the tests

```bash
python3 -m venv .venv && .venv/bin/pip install -r server/requirements-dev.txt
(cd server && ../.venv/bin/python -m pytest)          # unit tests
ci/validate-templates.sh                               # needs terraform + provider access
ci/run-azurite-tests.sh                                # needs Node.js
ci/test-deploy-script.sh                               # needs pwsh
```

## Adding a template or a policy rule

* Template: create `server/templates/<name>/main.tf` and `template.json` (see any existing one; every
  variable in `main.tf` must be in the schema with the same default - a test enforces it). Never declare the
  injected variables (`subscription_id`, `resource_group_name`, `location`, `tags`, ...). Re-run the deploy
  script to rebuild the image.
* Policy: add a rule to `server/policies/default.json` (types and examples are documented at the top of
  `server/tfmcp/policy.py`). `enforcement` is `deny`, `warn` or `off`, optionally per profile.

## The older HCP Terraform variant

`Deploy-TerraformMcp.ps1` hosts HashiCorp's own Terraform MCP server and drives HCP Terraform workspaces
(guide: [DEPLOY.md](DEPLOY.md)). It is kept working but is not where the features above live.
A bug that made both v1 scripts call their `Az` wrapper function recursively has been fixed in both.

## Upgrading from v1.x

v2 is a new layout: state keys are `<environment>/<deployment>.tfstate` (v1: `<deployment>.tfstate`), the
workload resource group is per environment (v1: `rg-<prefix>-workloads`), and the server uses a user-assigned
identity. The script upgrades the Container App in place, but **v1 deployments are not migrated**: the
resources stay in Azure untouched and their state stays at the old key, but they do not appear in
`list_deployments` and there is no import tool in this version. Keep managing them with Terraform directly,
or re-create them through v2.
