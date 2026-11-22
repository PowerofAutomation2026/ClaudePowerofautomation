# Azure Terraform MCP (v2.2) - Terraform for Copilot Studio agents that stays safe when the agent is not

A Copilot Studio agent can plan Azure infrastructure from approved Terraform templates. **It cannot change or
destroy anything on its own** - not when it is prompt-injected, not with a stolen user token, not when the
model is jailbroken. Every apply and every destroy needs a human decision on a separate approval page that the
agent has no way to reach, and the process the agent talks to has no write access to Azure at all.

v2.1 was designed for one threat model: *the agent is hostile*. It may call every tool with any arguments as
the signed-in user and lie about what the user said. Controls are enforced server-side or by the Azure
platform; agent instructions are never a control. We do not claim it cannot be attacked - see
[THREAT-MODEL.md](THREAT-MODEL.md) for what stops which attack and what is left.

```
 Copilot Studio agent  --connector token (audience: MCP API)-->  ca-<prefix>            MCP FRONT-END
 (untrusted)                                                       8 tools, no approve/admin tool
                                                                   identity id-<prefix>-plan: READ-ONLY in Azure,
                                                                   read-only on state + on the control container
                                                                   runs: terraform plan / drift, policy, cost, explain
                                                                        |  queues "apply" (cannot run it)
                                                                        v
 Human approver  --fresh sign-in, token (audience: APPROVAL app)--> ca-<prefix>-approval   APPROVAL + EXECUTOR
 (browser, optional MFA / Conditional Access)                       approval page + JSON API, kill switch
                                                                   identity id-<prefix>-apply: custom role without
                                                                   Microsoft.Authorization/*, RG delete, (prod) data deletes
                                                                   re-derives what the plan file really does, re-checks policy,
                                                                   consumes the single-use approval, enforces quotas, applies
 Azure platform (independent of our code):
   CanNotDelete locks: MCP resource group + production resource groups | deny-delete policy for protected=true
   state: versioning + soft delete | audit container: immutable (WORM) | Key Vault purge protection
```

## What it gives you

| | |
|---|---|
| **Out-of-band approval for every apply and destroy** | `request_approval` only creates a request and a link. The decision happens on the approval page: separate Entra app and audience, fresh sign-in (optional MFA claim), approval bound to the plan file's checksum *and* to a digest of the changes the approver was shown, valid 30 minutes, single use. Production: a different person than the requester. Dev can allow self-approval - still only on that page. |
| **Split identities** | Front-end: custom read-only role. Executor: custom apply role (no role assignments, locks, policy changes, resource-group deletion; no data-resource deletion in locked environments). No built-in Contributor anywhere. Role JSON is in the deploy script and written to `out/role-*.json`. |
| **Platform destroy protection** | Resource locks, optional Azure Policy `denyAction` on `protected=true`, protected deployments that can never be destroyed through MCP, state versioning/soft delete, WORM audit, Key Vault purge protection (not configurable in the template). |
| **Kill switch, quotas, anomaly freeze** | Admin freeze (out-of-band), auto-freeze on denied-call bursts / repeated destroy attempts / plan bursts, change windows, per-user rate limits, global applies-per-hour and deletions-per-day quotas counted by the executor. |
| **RBAC and per-user visibility** | Roles viewer / requester / approver / admin from Entra app roles (or groups). Users see and touch only their own deployments unless viewer/admin. Destroy: owner or admin, plus approval. |
| **Injection hardening** | Typed, pattern-validated inputs that reach Terraform only as JSON data; strict ids (no path traversal); every string returned to the agent is stripped of control characters, secret-like values and instruction-like text and is length-capped; audit logs are redacted the same way. |
| **Token and supply-chain checks** | JWT signature/audience/issuer/tenant/expiry, client-app allow-list (`azp`), required scope, token age for writes. Base image pinned by digest, Terraform and providers checksum-verified, provider lock file, integrity manifest for templates and policies (server refuses to start on mismatch). |
| **Small token footprint** | 8 tools (was 18), compact JSON, no duplicated structured output, one-line catalog, paging, `fields`, etag polling. Numbers below. |
| **Still there from v2.0** | 15 secure-by-default templates, policy gate on the plan, cost estimate and budget cap, environments, explain-this-plan, time-boxed deployments, drift detection, rollback, durable operations. |

## Token footprint (estimate: characters / 4)

| | v2.0 | v2.1 |
|---|---|---|
| `tools/list` (what every conversation pays) | ~2117 (18 tools) | **~902** (8 tools) |
| template catalog | ~4981 | **~300** (one line each; `catalog(what="template")` on demand ~484) |
| environments | ~2921 | **~93** |
| plan result | ~906 | **~277** |
| plan summary (`plan_info`) | ~773 | **~257** (`detail=true` ~362) |
| apply result | ~238 | **~51** |
| poll while running | ~238 | **~26**, unchanged-since-etag **~21** |
| list deployments (1) / get | ~142 / ~447 | **~43 / ~146** |
| agent instructions | ~952 | **~231** |

Measured by `server/tests/test_tokens.py`, which also enforces a budget per item (for example `tools/list`
<= 1100) so the surface cannot grow unnoticed. Results over 6000 characters are cut with `truncated: true`
and a hint how to narrow the request.

## MCP tools (v2.1)

| Tool | Purpose |
|---|---|
| `whoami` | account, roles, frozen flag |
| `catalog(what, name, env)` | environments, templates (one line each), or one template's variables |
| `plan(action, name, ...)` | `deploy` / `destroy` / `rollback`; nothing changes |
| `plan_info(plan_id, detail)` | summary, risk, cost, policy, approval state |
| `request_approval(plan_id, reason)` | creates the request, returns the approval-page link |
| `apply(plan_id)` | queues an approved plan for the executor |
| `status(op_id, etag)` | poll |
| `deployments(action, ...)` | `list` / `get` / `drift` / `extend` |

**Breaking changes from v2.0:** `approve_plan`, `reject_plan` and `list_pending_approvals` are gone from MCP
(approval is out of band). The other tools were merged and renamed (`list_templates`/`describe_template`/
`list_environments` -> `catalog`; `plan_deployment`/`plan_destroy`/`plan_rollback` -> `plan`; `explain_plan`
-> `plan_info`; `apply_plan` -> `apply`; `get_operation` -> `status`; `list_deployments`/`get_deployment`/
`detect_drift`/`extend_ttl` -> `deployments`). Result fields are shorter. Every environment now needs an
approval for apply (there is no "user confirmed in chat" path). Users need a role or every call is refused.
Deployments created by v2.0 have no owner id and are visible to viewers/admins only. Update the agent's
instructions from [agent-instructions.md](agent-instructions.md).

## Quick start

**Double-click `Install.cmd`** (Windows admin workstation). It installs prerequisites, signs you in, runs
preflight checks, creates the Entra groups, deploys to Azure, creates the Power Platform solution + connector,
runs the smoke test and writes `out/install-summary.md`. `Install.cmd -PreflightOnly` changes nothing;
`-Unattended -ConfigFile install.config.json` is for pipelines; `-Uninstall` removes the server.
What it cannot do for you (Microsoft requires a person): paste the connector secret once, create/publish the
agent in Copilot Studio, each user's first sign-in, licensing - see `out/agent-setup.md` after the run.
A designed overview of the whole thing: [blog/index.html](blog/index.html).

Manual route:

```powershell
az login
# plan-only sandbox (one "dev" environment)
./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -RequesterGroupId <group> -ApproverGroupId <group> -AdminGroupId <group>

# production-shaped
./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -Environments dev,test,prod -EnableApply -EnableDestroy `
    -RequesterGroupId <g> -ApproverGroupId <g> -ViewerGroupId <g> -AdminGroupId <g> `
    -EnableDenyDeletePolicy -EnableScheduledJobs -EnableMonitoring -AlertEmail ops@contoso.com -PrivateNetworking
```
Then paste `out/copilot-studio-wizard-values.md` into Copilot Studio and [agent-instructions.md](agent-instructions.md)
into the agent. Approvers use the approval page URL the script prints. Guide: [DEPLOY-AZURE-NATIVE.md](DEPLOY-AZURE-NATIVE.md).
Security: [SECURITY.md](SECURITY.md), [THREAT-MODEL.md](THREAT-MODEL.md). Background: [BLOG.md](BLOG.md).

## What was tested, and what was not

No Azure tenant and no Copilot Studio environment were available. Tested locally:

* **239 unit/integration tests** (`pytest`; 3 more run against the Azurite storage emulator): RBAC matrix,
  per-user visibility, out-of-band approval (two-person, self, replay, expiry, stale sign-in, MFA claim,
  wrong audience, changed plan, forged approval, swapped plan file, plan JSON that lies about the file),
  freeze / anomaly auto-freeze / rate limits / quotas / change windows, protected deployments, injection and
  path-traversal inputs, redaction, integrity manifest, token budgets, split front-end/executor processes -
  plus everything from v2.0 (policy, cost, durability, drift, TTL).
* **Both HTTP channels with real signed tokens** (in-process and a live local server): anonymous, wrong
  audience, wrong client app, missing scope, stale sign-in are rejected; plan -> request -> approver decides
  on the approval API -> apply works; replay is refused.
* **`terraform validate` + `fmt`** for all 15 templates (Terraform 1.9.8, azurerm 4.81.0, random 3.9.1);
  `terraform init -lockfile=readonly` with the shipped provider lock file against a local provider mirror.
* **PowerShell 7.4**: all scripts parse; the deploy script was executed end to end against a fake `az` CLI in
  five scenarios with assertions on roles, scopes, identities, locks, policy, app registrations and env vars;
  the smoke-test script was run against a local server.

* **Installer (v2.2)**: `Install-AzureTerraformMcp.ps1` executed in PowerShell 7 against fake `az` and `pac`
  CLIs in 12 runs (preflight, what-if, unattended install, re-run, failure and resume, failed preflight,
  Power Platform failure, interactive wizard with typed answers, uninstall). `blog/index.html` rendered with
  headless Chromium at desktop and phone widths, light and dark: no console errors, no horizontal scroll.

**Not tested (v2.2 additions):** `Install.cmd` (reviewed only - no Windows), winget installs, and every Power
Platform call (`pac connector`, Dataverse solution creation, connector sharing, DLP read, `pac copilot create`).

**Not tested:** anything against live Azure or Entra ID - no real `terraform plan/apply`, no real custom-role
or lock behaviour, no real token from Entra (claims such as `auth_time`/`amr` follow documentation), the
approval page's browser sign-in (MSAL) flow, whether the read-only role is sufficient for every provider
refresh, the Docker image build, the Azure Monitor template, `az` flag names, the live price API.
**Run it in a sandbox subscription first and expect to adjust.**

## Repository layout

```
Install.cmd, Install-AzureTerraformMcp.ps1, install.config.example.json   one-click installer (wizard / unattended)
blog/index.html                designed overview page (self-contained) + blog/screens/
Deploy-AzureTerraformMcp.ps1   deploy (two container apps, two identities, custom roles, locks, Entra apps)
Test-TerraformMcp.ps1          smoke test (MCP + approval channel)
server/server.py, server/tfmcp/   the server: service, approvals, approval_app, guard, sanitize, compact, integrity, ...
server/templates/, server/policies/, server/integrity.json
server/tests/                  pytest suite (security: test_security.py, tokens: test_tokens.py)
monitoring/monitoring.json     workbook, 15 log alerts, 5 activity-log alerts
audit-queries.kql, environments.example.json, ci/
Deploy-TerraformMcp.ps1, DEPLOY.md, terraform/hcp-azure-workspace/   older HCP Terraform variant (unchanged)
```

## Run the tests

```bash
python3 -m venv .venv && .venv/bin/pip install -r server/requirements-dev.txt
(cd server && ../.venv/bin/python -m pytest)
ci/validate-templates.sh        # terraform + providers
ci/run-azurite-tests.sh         # Node.js
ci/test-deploy-script.sh        # pwsh
ci/test-installer.sh            # pwsh (installer against fake az + pac)
```

## Changing templates or policies

Edit, then `cd server && python -m tfmcp.integrity write` and commit `integrity.json` with the change (that
file is the reviewed list of hashes; the image build and every start verify it). Then re-run the deploy script.
