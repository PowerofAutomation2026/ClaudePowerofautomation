# Deploy steps

**Prereqs:** Azure subscription (Owner or Contributor + User Access Administrator), rights to create Entra app registrations,
Azure CLI 2.60+, PowerShell 7, an HCP Terraform org with a **team** API token, Copilot Studio + a Power Platform environment.

1. **Unzip** the package and open PowerShell 7 in the folder.
2. **Sign in:** `az login` (or let the script do it).
3. **Set the token:** `$env:TFE_TOKEN = '<HCP Terraform team token>'`
4. **Deploy (recommended hardened run):**
   ```powershell
   ./Deploy-TerraformMcp.ps1 -SubscriptionId <sub-guid> -UseKeyVault -SecurityGroupId <entra-group-object-id> `
       -Image hashicorp/terraform-mcp-server:<pinned-tag>
   ```
   Add `-EnableOperations` only when the agent should queue plan/apply/destroy runs. Add `-AllowedCidrs 203.0.113.0/24`
   only if you know the egress ranges (Power Platform connector IPs change - leave empty if unsure).
5. **Smoke test:** `./Test-TerraformMcp.ps1 -SubscriptionId <sub-guid>`  (expects 401 anonymous, 200 authenticated, tools listed).
6. **Copilot Studio:** open `out/copilot-studio-wizard-values.md`, then Agent > Tools > Add a tool > New tool > Model Context Protocol,
   paste the values, Create, add the redirect URL it shows to the connector app in Entra if different, Create connection, Add to agent.
7. **Try it:** "List my HCP Terraform workspaces", "Find the azurerm provider docs for azurerm_storage_account", then (if enabled) "Plan workspace X".
8. **Workspaces for the agent to drive (optional):** `terraform/hcp-azure-workspace` creates a workspace with Azure OIDC (no stored secrets).
9. **Monitor:** paste `audit-queries.kql` into the Log Analytics workspace `log-tfmcp`.
10. **Remove:** `./Deploy-TerraformMcp.ps1 -SubscriptionId <sub-guid> -Destroy`

Rotate the connector client secret yearly (`az ad app credential reset --id <connector client id>`) and update it in the connection.
