# Let a Copilot Studio agent run your Terraform: a secure, zero-touch Terraform MCP server on Azure

Platform teams spend a lot of time answering "can you spin up X?" What if a Copilot Studio agent could look up the right
provider docs, find the right workspace, and queue a plan for a human to approve - all from chat?

HashiCorp's **Terraform MCP server** makes that possible, and Copilot Studio can call any MCP server as a tool. The missing piece
was a safe, repeatable way to host it on Azure. This post (and the accompanying package) gives you exactly that, in one script.

## The architecture
```
Copilot Studio agent ─ OAuth (Entra) ─> Azure Container Apps (Entra auth, 401 for anonymous)
                                         └─ terraform-mcp-server (streamable HTTP, /mcp)
                                              └─ HCP Terraform API ─> workspace runs ─> Azure (OIDC)
```
One detail worth being upfront about: the MCP server doesn't talk to Azure directly. It drives **HCP Terraform workspaces** - the
agent creates workspaces, sets variables and queues runs - and those runs authenticate to Azure with short-lived OIDC credentials.
That is the point: Terraform stays the single path to change infrastructure, so you keep state, policy checks and approvals.

## What the script gives you
- **One command** - resource group, Container Apps environment, logging, the server, Entra app registrations and the Copilot Studio connector files.
- **Entra authentication** with admin consent pre-granted, so users just click *Sign in* once.
- **Safe by default** - plan/apply/destroy tools are off unless you pass `-EnableOperations`. Keep manual apply approval on in HCP Terraform.
- **Key Vault option** - the HCP token is read through a managed identity and never sits in app config.
- **Group-only access** - `-SecurityGroupId` limits the agent to members of one Entra group.
- **IP allow-list option, autoscaling, pinned image support, and audit queries** for Log Analytics.
- **Smoke test** - verifies anonymous calls get 401 and an authenticated MCP session lists its tools.
- **A sample Terraform module** for an HCP workspace that authenticates to Azure with OIDC.
- **Paste-ready Copilot Studio values**, and teardown with `-Destroy`.

## A note on "dynamic discovery"
Copilot Studio's OAuth *Dynamic discovery* depends on dynamic client registration, and Microsoft Entra ID doesn't publish a registration
endpoint. So for Entra-protected servers you use the manual OAuth option. The package makes that a one-time paste: the app is pre-created and pre-consented,
and the values are written to a file. If you want a fully fieldless wizard, front the server with a gateway (for example API Management) that serves the discovery metadata.

## Deploy it
```powershell
$env:TFE_TOKEN = '<HCP Terraform team token>'
./Deploy-TerraformMcp.ps1 -SubscriptionId <guid> -UseKeyVault -SecurityGroupId <group-id>
./Test-TerraformMcp.ps1   -SubscriptionId <guid>
```
Then paste the generated values into Copilot Studio (Agent > Tools > Add a tool > Model Context Protocol). Full steps are in `DEPLOY.md`.

## Guardrails we recommend for regulated environments
1. Operations off in production; humans approve every apply.
2. One workspace and one least-privilege Azure identity per environment.
3. Pin the image tag, restrict by Entra group, review the audit log weekly.
4. Treat agent prompts like change requests: the audit trail should show who asked for what.

## Honest limitations
The package hasn't been validated against a live tenant by its author - run it in a sandbox subscription first. Environment variable names and
`az containerapp auth` flags follow current docs and can change between releases.
