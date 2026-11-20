# Deploy: Azure-native Terraform MCP (provisions Azure resources directly, no HCP Terraform)

**Prereqs:** Azure subscription (Owner, or Contributor + User Access Administrator), rights to create Entra app registrations,
Azure CLI 2.60+, PowerShell 7, Copilot Studio + a Power Platform environment. No Docker, no HCP account needed.

1. Unzip, open PowerShell 7 in the folder, `az login`.
2. Deploy plan-only first (safe):
   ```powershell
   ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <sub-guid> -AllowedLocations "eastus2,westus2" -SecurityGroupId <entra-group-id>
   ```
3. Smoke test: `./Test-TerraformMcp.ps1 -SubscriptionId <sub-guid> -Prefix aztfmcp`
4. Copilot Studio: paste values from `out/copilot-studio-wizard-values.md` into Agent > Tools > Add a tool > Model Context Protocol (OAuth 2.0 > Manual),
   then paste `agent-instructions.md` into the agent's Instructions.
5. Try: "What can you build?" -> "Plan a storage account called demo-data in eastus2".
6. When you trust it, enable changes: re-run with `-EnableApply` (and `-EnableDestroy` if wanted). Same command updates in place.
7. Resources land ONLY in `rg-aztfmcp-workloads`. State is in the storage account's `tfstate` container.
8. Add templates: drop a folder in `server/templates/<name>/` (`main.tf` + `template.json`), re-run the deploy script (rebuilds the image).
9. Remove the MCP: `-Destroy` (does not delete the workload resource group or what was built in it).

Known limits: single replica; plans expire after 1 hour; templates can't create resources outside the workload RG or assign roles
(the identity is Contributor on that RG only). Not tested against a live tenant - try in a sandbox subscription first.
