# Terraform MCP → Copilot Studio on Azure (zero-touch)

`Deploy-TerraformMcp.ps1` stands up HashiCorp's **Terraform MCP server** on **Azure Container Apps**,
locks it behind **Entra ID**, and generates the **custom connector** that lets a **Copilot Studio agent**
call it as an MCP tool.

```
Copilot Studio agent ──OAuth (Entra)──> Container App (Easy Auth, 401 on anon)
                                         └─ hashicorp/terraform-mcp-server  (streamable-http, /mcp)
                                              └─ HCP Terraform / TFE API (TFE_TOKEN)  → workspaces, runs → Azure
```

## Run
```powershell
$env:TFE_TOKEN = '<HCP Terraform team token>'
./Deploy-TerraformMcp.ps1 -SubscriptionId <guid>               # read/plan-oriented (default)
./Deploy-TerraformMcp.ps1 -SubscriptionId <guid> -EnableOperations   # let the agent create/apply/destroy runs
./Deploy-TerraformMcp.ps1 -SubscriptionId <guid> -Destroy      # remove everything
```
Re-running is safe (updates image/env/secret in place). Output goes to `out/` (git-ignored; contains the connector secret).

## How "provision / update / delete Azure infrastructure" actually works
The Terraform MCP server does **not** call Azure itself. The agent drives **HCP Terraform workspaces**
(create workspace, set variables, queue plan/apply/destroy run); HCP Terraform runs use their own Azure
credentials (OIDC dynamic credentials recommended). So:
1. Create HCP Terraform workspaces connected to your Azure Terraform repos, with Azure OIDC credentials.
2. Give the team token access only to those workspaces.
3. Deploy with `-EnableOperations` only where the agent should be allowed to change infrastructure.

## Guardrails (recommended for a regulated environment)
- Keep `-EnableOperations` off in prod; require HCP Terraform **run approval** (manual apply) so a human confirms.
- Least-privilege Azure role on the workspace's identity; separate workspaces per environment.
- Pin `-Image` to a version tag; restrict Entra app to a security group ("Assignment required").
- Optionally add Microsoft's **Azure MCP server** as a second tool for read-only live-resource questions.

## Not covered / caveats
- Written and reviewed but **not executed against a live tenant** — run once in a sandbox subscription first.
- Env var names (`TRANSPORT_MODE`, `ENABLE_TF_OPERATIONS`, `MCP_ENDPOINT` …) follow HashiCorp's docs at time of writing; verify against the image tag you pin.
- `az containerapp auth` flags and the Copilot Studio connector schema change between releases.
- Self-hosted Terraform Enterprise works with this setup; HashiCorp's hosted `mcp.terraform.io` does not support it.
