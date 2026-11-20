# "Can you spin up a database?" - giving a Copilot Studio agent Terraform without giving it the keys

Platform teams answer the same question all day: *can you create X for me?* An agent that can do it sounds
great until you picture what "an LLM with Contributor rights" means. This post describes a pattern - and a
working package - for letting a Copilot Studio agent provision Azure infrastructure with Terraform while the
decisions that matter stay with policy and with people.

The short version: **the agent proposes; a server it cannot argue with decides.**

## The idea

Model Context Protocol lets Copilot Studio call tools. The obvious tool, "run Terraform", is the dangerous
one. So the server in this package does not expose Terraform. It exposes a *process*:

```
 ask ──> plan ──> [ schema ] ──> [ policy gate ] ──> [ cost + budget ] ──> explain ──> confirm ──> apply
                                                                               │
                                                     prod: request approval ──> a second person approves
```

```
 Copilot Studio agent                        Azure Container Apps (1..N replicas)
 (user signs in with Entra ID) ──OAuth──>    Easy Auth ──> azure-terraform-mcp ──> terraform ──> Azure
                                                              │        (managed identity: Contributor on
                                                              │         the environment resource groups only)
                                                              ├── blob storage: state, plans, operations, audit
                                                              ├── Azure Retail Prices API (public list prices)
                                                              └── scheduled jobs: TTL reaper, drift scan
```

Terraform runs inside the Container App with a managed identity. There is no HCP Terraform account, no
service principal secret and no pipeline to maintain. One PowerShell script deploys the lot and writes the
values you paste into Copilot Studio.

## What the agent can and cannot do

**It can only use templates you ship.** Fifteen are included - storage, Key Vault, Azure SQL, PostgreSQL,
Cosmos DB, App Service, AKS, container registry, Linux VM, networks, NSGs, private endpoints, Service Bus,
Log Analytics - each with a typed schema. "Give it a public IP" is not something the model can talk its way
into, because there is no variable for it. Values are validated (types, allowed values, ranges, resource-ID
formats) before Terraform starts, and they enter Terraform as data, never as code.

**The templates are opinionated.** Databases are Entra-only: no administrator password is ever generated, so
there is nothing to leak into a chat. Storage has no account keys and no public blobs. The VM has no public
IP. Where a private-only setup needs a premium SKU (registry, Service Bus) or the thing is normally
internet-facing (a web app), that is an explicit variable - and the production policy forces the safe choice.

**Every plan goes through a policy gate.** The server reads Terraform's JSON plan and applies rules from a
readable JSON file: allowed regions, mandatory tags, no public network access, TLS 1.2, approved VM sizes,
*protected* resources that may not be deleted, and a blast-radius limit on how much one plan may change.
A violation blocks apply and comes back as a sentence a person can understand:

> `azurerm_storage_account.this would be reachable from the public internet (public_network_access_enabled
> = True). Turn public network access off and use a private endpoint.`

Rules have a profile: the same rule can warn in dev and deny in prod. The gate runs again at apply time.

**Every plan has a price tag.** Before anyone says "go", the plan carries a monthly estimate from Azure's
public Retail Prices API, and an environment can set a cap. This is deliberately modest: list prices, fixed
charges only, labelled as an estimate, with each line marked as priced, usage-based or not estimated. It
still changes the conversation - "that's about 730 dollars a month, shall I continue?" is a better question
than none.

**Production needs two people.** In an approval environment the person who planned a change cannot approve
it. The server knows who is who because every user signs in to the connector with their own Entra account,
and the server validates that token itself. Approvals are tied to the checksum of the exact plan. The agent
cannot approve "on behalf of" anyone, however nicely it is asked.

**Everything is attributable.** Each tool call is one structured log line: who, which tool, a hash of the
arguments, the outcome. Applies record who planned, who approved and who applied. A workbook and alert rules
come with the package; one of the supplied queries exists purely to prove the two-person rule held.

## Three things that turned out to be the interesting part

### 1. "Explain this plan"
Terraform plans are written for engineers. The server turns the plan into a short structured explanation -
what is created, changed, destroyed and *why* a replacement is forced; a risk level with reasons (data-bearing
resources being destroyed is high risk, more so in production); the cost change; the policy result; what has
to happen next. The agent reads that to the user instead of improvising its own summary of a JSON blob.

```
Deploy 'payments-db' (postgres-flexible) in prod: 3 to create.
- Create PostgreSQL server 'psql-payments-db-x7k2q' in eastus2
- ...
Risk: MEDIUM - Target is the 'prod' environment, which uses the strict (production) policy profile.
Policy check passed.
This environment needs a second person to approve. ...
```

### 2. Environments that delete themselves
Half of the "can you create" requests are experiments. `ttl_hours=8` on a new deployment makes it time-boxed:
a scheduled job gives notice, then plans and applies the destroy when time is up. Someone who still needs it
says "extend it by a day". The rules are narrow on purpose: only deployments *created* as time-boxed are ever
touched, never in environments that require approval, and the destroy goes through the same policy gate.

### 3. Chat has timeouts; Terraform does not care
A Copilot Studio tool call cannot wait ten minutes for an AKS cluster. Every plan and apply is an *operation*
that returns an id within seconds and is polled. Making that robust was most of the engineering: operations,
per-deployment locks and approvals live in blob storage and change only by compare-and-swap, a worker holds
a lease it must keep renewing, and if a replica dies another one notices. Plans are simply retried. An
interrupted **apply is never retried automatically** - it is reported, the stale Terraform state lock is
released, and the user is asked to plan again so Terraform can show what is left. On scale-in the server
passes the signal on so Terraform can stop cleanly.

Two smaller ones that earn their keep: **drift detection** ("has anyone changed this in the portal?") on
demand and on a schedule, and **rollback** - a plan back to the inputs of the previous successful apply.

## A detail that would have cost you an afternoon

Azure Container Apps hands out managed identity tokens through an endpoint that the Terraform azurerm backend
and provider do not speak - they expect the VM metadata service. We checked the binaries rather than assume.
The server therefore runs a tiny loopback token broker that speaks the metadata protocol and gets tokens
through the Azure SDK; Terraform is pointed at it with `ARM_MSI_ENDPOINT`. We verified that the real
Terraform 1.9.8 backend and the real azurerm 4.81.0 provider both request and accept tokens from it.

## How it compares

| | Plain Terraform MCP server (CLI wrapper) | HashiCorp Terraform MCP + HCP Terraform | This package |
|---|---|---|---|
| Where Terraform runs | Wherever the server runs, with its credentials | HCP Terraform workspaces | Azure Container Apps, managed identity |
| What the agent may deploy | Whatever configuration it is given | Whatever the workspaces/modules allow | Only shipped templates, schema-validated inputs |
| Policy on the plan | Not built in | Sentinel / OPA policy sets in HCP Terraform (limits depend on plan) | Built-in JSON rules, per environment profile, re-checked at apply |
| Cost before apply | Not built in | HCP Terraform cost estimation | Azure list-price estimate + budget cap (best effort) |
| Approval | Not built in | Run approval per workspace | Two-person rule with Entra identity, enforced by the server |
| Per-user identity in the audit | Depends on hosting | HCP audit trail; runs started through a shared API token carry that token's identity | Entra user of the chat, on every tool call |
| Time-boxed environments | No | Ephemeral workspaces / auto-destroy (plan dependent) | `ttl_hours`, notice, auto-destroy |
| Plain-English plan explanation | Model improvises | Model improvises | Generated by the server from the plan |
| Extra services to run / buy | None | HCP Terraform | None beyond Azure |
| Maturity | Varies | Vendor-supported product | New, small, **not yet proven on a live tenant** |

The HCP Terraform column reflects our understanding of the product at the time of writing; check HashiCorp's
documentation for your plan. Be clear about the last row. HCP Terraform is a mature platform with far richer policy (Sentinel/OPA), a
module registry, run tasks and support; if you already run it, its MCP server is the natural choice and this
package still ships a deploy script for that route. What this package offers is a self-contained,
Azure-native alternative in which the guardrails are part of the tool surface the agent sees.

## Honest limitations

* Built and tested without an Azure tenant. 176 automated tests, `terraform validate` on every template, the
  deploy script executed end-to-end against a fake `az`, and the token broker checked against the real
  Terraform binaries - but **no plan or apply has run against Azure, and no real Copilot Studio agent has
  called it**. Expect to fix small things on first contact.
* In environments without approval, "the user confirmed" is an instruction to the agent, not something the
  server can verify. That is why plan-only is the default and approval exists.
* The cost estimate covers fixed charges of common resource types. It is a prompt for a conversation, not a bill.
* The identity is Contributor on resource groups and cannot assign roles, so data-plane access (who may read
  the Key Vault) stays a human task.
* Everyone who can use one server can see all its deployments.

## Try it

```powershell
az login
./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid>                      # plan-only sandbox
./Test-TerraformMcp.ps1 -SubscriptionId <guid> -Prefix aztfmcp
# then paste out/copilot-studio-wizard-values.md into Copilot Studio and agent-instructions.md into the agent
```
When you trust it:
```powershell
./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -Environments dev,test,prod -EnableApply -EnableDestroy `
    -ApproverGroupId <group> -EnableScheduledJobs -EnableMonitoring -AlertEmail ops@contoso.com
```
Details are in `DEPLOY-AZURE-NATIVE.md`; the security reasoning is in `THREAT-MODEL.md`.

The pattern matters more than the package: give the agent a *process* instead of a *power*, and put every
rule you care about on the server side of the tool boundary.
