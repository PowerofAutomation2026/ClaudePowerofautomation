# Terraform MCP → Copilot Studio on Azure (zero-touch)

**Two options in this package**
| | `Deploy-AzureTerraformMcp.ps1` (**Azure-native, direct**) | `Deploy-TerraformMcp.ps1` (HCP Terraform) |
|---|---|---|
| Provisions Azure resources | **Yes, itself** - Terraform runs in the container with a managed identity | Indirectly, via HCP Terraform workspace runs |
| Needs HCP Terraform | No | Yes |
| Guardrails | Curated templates, one resource group, plan-then-confirm apply | HCP approvals/policies |
| Guide | `DEPLOY-AZURE-NATIVE.md` | `DEPLOY.md` |

The rest of this README describes the HCP Terraform option.


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

## Copilot Studio sign-in experience
Entra ID doesn't publish a dynamic client registration (RFC 7591) endpoint, so the wizard's
**Dynamic discovery** option can't self-register against it. Instead the script pre-creates the Entra app,
pre-grants admin consent (users never see a consent screen) and writes `out/copilot-studio-wizard-values.md`:
paste once in the MCP wizard (OAuth 2.0 > Manual), then each user just clicks **Sign in** once.
If your tenant has the discovery wizard enabled and you want zero fields, put a DCR shim / gateway
(e.g. Azure API Management) in front that serves `/.well-known/oauth-protected-resource` and returns the pre-registered client.

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
