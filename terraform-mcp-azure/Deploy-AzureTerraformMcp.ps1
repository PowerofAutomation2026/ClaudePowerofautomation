<#
.SYNOPSIS
  Zero-touch deploy of the Azure Terraform MCP server (v2): a governed Terraform control plane for
  agents. Terraform runs inside Azure Container Apps with a managed identity; every plan passes a
  policy gate, gets a cost estimate, and production applies need a second person's approval.

.EXAMPLE
  # plan-only sandbox with one environment (safe default)
  ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid>

.EXAMPLE
  # dev + test + prod, changes allowed, prod needs two-person approval, jobs and alerts on
  ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -Environments dev,test,prod -EnableApply -EnableDestroy `
      -ApproverGroupId <entra-group-id> -MonthlyBudgetUsd 2000 -EnableScheduledJobs -EnableMonitoring -AlertEmail ops@contoso.com

.EXAMPLE
  # full control per environment (own subscription, regions, policy profile, budget, approvers)
  ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -EnvironmentsFile ./environments.json -EnableScheduledJobs

.EXAMPLE
  ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId <guid> -Destroy      # remove the MCP itself (not the workloads)

.NOTES
  Guardrails: the managed identity is Contributor ONLY on each environment's resource group; only
  curated templates can be deployed; inputs are schema-validated; plans are policy-checked.
  Re-running is safe: it updates in place. The connector client secret is created once and kept
  (use -RotateConnectorSecret to replace it).
  This script was parse-checked and executed end-to-end against a FAKE az CLI (ci/fake-az).
  It has NOT been run against a live Azure tenant: try it in a sandbox subscription first.
#>
#Requires -Version 7.0
[CmdletBinding()]
param(
  [Parameter(Mandatory)] [string] $SubscriptionId,
  [string] $Location = 'eastus2',
  [ValidatePattern('^[a-z][a-z0-9]{2,11}$')] [string] $Prefix = 'aztfmcp',

  # --- environments ---------------------------------------------------------
  [string[]] $Environments = @('dev'),            # simple mode: one resource group rg-<prefix>-<env> each
  [string] $EnvironmentsFile,                     # full control: JSON file (see environments.example.json)
  [string] $AllowedLocations = 'eastus2',         # simple mode: comma separated regions the agent may deploy to
  [switch] $EnableApply,                          # simple mode: allow create/update after a confirmed plan
  [switch] $EnableDestroy,                        # simple mode: allow destroy plans to be applied
  [string[]] $ApprovalEnvironments = @('prod'),   # simple mode: environments that need two-person approval (strict policy)
  [string] $ApproverGroupId,                      # Entra group -> app role "approver" on the approval app
  [string] $RequesterGroupId,                     # Entra group -> app role "requester" (may plan / request / apply their own)
  [string] $ViewerGroupId,                        # Entra group -> app role "viewer" (read everything)
  [string] $AdminGroupId,                         # Entra group -> app role "admin" (both apps: all deployments, kill switch)
  [string[]] $SelfApprovalEnvironments = @(),     # simple mode: non-approval environments where self-approval is NOT wanted are all others
  [string[]] $LockEnvironments = @('prod'),       # CanNotDelete lock on these environments' resource groups + protected apply role
  [switch] $NoResourceLocks,                      # do not lock the MCP's own resource group
  [switch] $EnableDenyDeletePolicy,               # Azure Policy (denyAction) blocking deletion of resources tagged protected=true
  [string] $ApprovalRequireAmr,                   # e.g. 'mfa' (v1 tokens) or an authentication-context id; see docs
  [string[]] $ApprovalAllowedCidrs,               # IP allow-list for the approval page (e.g. corporate egress)
  [int] $AuditRetentionDays = 365,                # time-based immutability (WORM) on the audit container
  [string[]] $PlanRoleExtraActions = @(),         # extra actions for the read-only plan role if a refresh needs them
  [switch] $AllowAzureCliClient,                  # also accept tokens issued to the Azure CLI (needed by Test-TerraformMcp.ps1)
  [double] $MonthlyBudgetUsd = 0,                 # simple mode: per-deployment monthly cap (0 = none)

  # --- runtime --------------------------------------------------------------
  [ValidateRange(1, 10)] [int] $MinReplicas = 1,
  [ValidateRange(1, 10)] [int] $MaxReplicas = 3,
  [switch] $EnableScheduledJobs,                  # TTL reaper (every 15 min) + drift scan (-DriftCron)
  [string] $DriftCron = '0 3 * * *',
  [string] $NotifyWebhookUrl,                     # optional webhook for approval requests and TTL notices
  [switch] $EnableMonitoring,                     # Azure Monitor workbook + alert rules
  [string] $AlertEmail,
  [string] $StateStorageSku = 'Standard_ZRS',     # use Standard_LRS in regions without availability zones

  # --- network / access hardening -------------------------------------------
  [switch] $PrivateNetworking,                    # VNet-integrated environment + private endpoint for state storage
  [switch] $InternalIngress,                      # with -PrivateNetworking: no public endpoint at all (see DEPLOY-AZURE-NATIVE.md)
  [string] $VnetAddressSpace = '10.90.0.0/22',
  [string] $ContainerAppsSubnet = '10.90.0.0/23',
  [string] $PrivateEndpointSubnet = '10.90.2.0/27',
  [string] $SecurityGroupId,                      # only members of this Entra group may call the server
  [ValidateSet('jwt', 'easyauth')] [string] $AuthMode = 'jwt',   # jwt: the server re-validates the token itself; easyauth: trust Easy Auth headers
  [string[]] $AllowedCidrs,                       # ingress IP allow-list
  [switch] $RotateConnectorSecret,
  [switch] $SkipPacConnector,                     # the installer creates the connector itself (inside a solution)
  [switch] $Destroy
)
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------------------------
# az wrapper. NOTE: it must NOT be called "Az" - PowerShell command names are case-insensitive and a
# function wins over an executable, so `function Az { & az ... }` calls itself forever.
$script:AzExe = $null
function Invoke-AzCli {
  # Runs az, throws on a non-zero exit code, returns stdout only (warnings on stderr never end up in values).
  if (-not $script:AzExe) { $script:AzExe = (Get-Command az -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source }
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { $all = & $script:AzExe @args 2>&1 } finally { $ErrorActionPreference = $previous }
  $code = $LASTEXITCODE
  $stdout = @($all | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] }) -join "`n"
  if ($code -ne 0) {
    $stderr = @($all | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] } | ForEach-Object { "$_" }) -join "`n"
    throw "az $($args[0..([Math]::Min(3, $args.Count - 1))] -join ' ') ... failed (exit $code):`n$stderr`n$stdout"
  }
  $stdout.Trim()
}
function Test-AzCli {
  # $true when the az command succeeds (used for "does it exist?" checks). Never throws.
  try { Invoke-AzCli @args | Out-Null; $true } catch { $false }
}
function Invoke-WithRetry([scriptblock] $Action, [string] $What, [int] $Attempts = 8, [int] $DelaySeconds = 30) {
  for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
    try { return (& $Action) }
    catch {
      if ($attempt -eq $Attempts) { throw }
      Write-Host "   waiting for Azure ($What, attempt $attempt of $Attempts): $(("$_" -split "`n")[0])" -ForegroundColor DarkGray
      Start-Sleep -Seconds $DelaySeconds
    }
  }
}
function Write-JsonFile([string] $Path, $Value, [int] $Depth = 12) {
  Set-Content -Path $Path -Value ($Value | ConvertTo-Json -Depth $Depth) -Encoding utf8
}

# ---------------------------------------------------------------------------------------------
# Accept both PowerShell arrays (-Environments dev,prod) and one comma-separated string (pwsh -File ... "dev,prod")
function Split-List($Values) { @($Values | Where-Object { $_ } | ForEach-Object { "$_" -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ }) }
$Environments = Split-List $Environments
$LockEnvironments = Split-List $LockEnvironments
$ApprovalAllowedCidrs = Split-List $ApprovalAllowedCidrs
$PlanRoleExtraActions = Split-List $PlanRoleExtraActions
$ApprovalEnvironments = Split-List $ApprovalEnvironments
$AllowedCidrs = Split-List $AllowedCidrs

$rg = "rg-$Prefix"; $envName = "cae-$Prefix"; $app = "ca-$Prefix"; $approvalApp = "ca-$Prefix-approval"; $law = "log-$Prefix"
$planIdentityName = "id-$Prefix-plan"; $applyIdentityName = "id-$Prefix-apply"; $lockName = 'tfmcp-do-not-delete' 
$outDir = Join-Path $PSScriptRoot 'out'
$retrySeconds = if ($env:AZTFMCP_RETRY_SECONDS) { [int]$env:AZTFMCP_RETRY_SECONDS } else { 30 }   # tests set this to 0

if (-not (Get-Command az -CommandType Application -ErrorAction SilentlyContinue)) {
  if ($IsWindows) {
    winget install -e --id Microsoft.AzureCLI --accept-source-agreements --accept-package-agreements
    $env:Path += ";$env:ProgramFiles\Microsoft SDKs\Azure\CLI2\wbin"
  } else { throw 'Install Azure CLI first: https://aka.ms/installazurecli' }
}
Invoke-AzCli extension add --name containerapp --upgrade --only-show-errors | Out-Null
if (-not (Test-AzCli account show)) { Invoke-AzCli login | Out-Null }
Invoke-AzCli account set --subscription $SubscriptionId | Out-Null
$tenantId = Invoke-AzCli account show --query tenantId -o tsv

if ($Destroy) {
  Write-Host "Deleting $rg (MCP, state storage, logs) and the app registrations. Workload resource groups are NOT deleted." -ForegroundColor Yellow
  if (Test-AzCli lock show --name $lockName --resource-group $rg) { Invoke-AzCli lock delete --name $lockName --resource-group $rg | Out-Null }
  Invoke-AzCli group delete -n $rg --yes --no-wait | Out-Null
  Write-Host 'Not removed: locks/policies on workload resource groups and the custom role definitions (remove them deliberately).' -ForegroundColor Yellow
  foreach ($n in "$Prefix-api", "$Prefix-connector", "$Prefix-approval") {
    $id = Invoke-AzCli ad app list --display-name $n --query '[0].appId' -o tsv
    if ($id) { Invoke-AzCli ad app delete --id $id | Out-Null }
  }
  return
}
if ($InternalIngress -and -not $PrivateNetworking) { throw '-InternalIngress needs -PrivateNetworking.' }
if ($EnableMonitoring -and -not $AlertEmail) { throw '-EnableMonitoring needs -AlertEmail.' }
if ($MaxReplicas -lt $MinReplicas) { throw '-MaxReplicas must be >= -MinReplicas.' }

# --- environment configuration ---------------------------------------------------------------
if ($EnvironmentsFile) {
  $envConfig = Get-Content -Raw -Path $EnvironmentsFile | ConvertFrom-Json -AsHashtable
} else {
  $locations = @($AllowedLocations -split ',' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
  $envConfig = [ordered]@{}
  foreach ($e in $Environments) {
    $needsApproval = $ApprovalEnvironments -contains $e
    $cfg = [ordered]@{
      resource_group    = "rg-$Prefix-$e"
      subscription_id   = $SubscriptionId
      allowed_locations = $locations
      policy_profile    = $(if ($needsApproval -or $e -eq 'prod') { 'strict' } else { 'standard' })
      enable_apply      = [bool]$EnableApply
      enable_destroy    = [bool]$EnableDestroy
      require_approval  = [bool]$needsApproval
      allow_ephemeral   = -not $needsApproval          # time-boxed deployments only where no approval is needed
      allow_self_approval = -not $needsApproval        # still only on the approval page, never through the agent
    }
    if ($MonthlyBudgetUsd -gt 0) { $cfg.monthly_budget_usd = $MonthlyBudgetUsd }
    $envConfig[$e] = $cfg
  }
}
if ($envConfig.Count -eq 0) { throw 'No environments configured.' }
foreach ($e in @($envConfig.Keys)) {
  if ($e -cnotmatch '^[a-z][a-z0-9]{1,11}$') { throw "Environment name '$e' must be 2-12 lowercase letters/digits, starting with a letter." }
  if (-not $envConfig[$e].resource_group) { throw "Environment '$e' needs a resource_group." }
  if (-not $envConfig[$e].Contains('subscription_id')) { $envConfig[$e].subscription_id = $SubscriptionId }
  if (-not $envConfig[$e].allowed_locations) { throw "Environment '$e' needs allowed_locations." }
}
$envJson = $envConfig | ConvertTo-Json -Depth 8 -Compress
$envB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($envJson))   # base64: no quoting problems through az
$defaultEnv = if ($envConfig.Contains('dev')) { 'dev' } else { @($envConfig.Keys)[0] }

# --- 1. core resources -----------------------------------------------------------------------
Write-Host '1/9 Resource group, state storage, registry, identity, logs' -ForegroundColor Cyan
foreach ($ns in 'Microsoft.App', 'Microsoft.OperationalInsights', 'Microsoft.ContainerRegistry', 'Microsoft.Storage', 'Microsoft.ManagedIdentity', 'Microsoft.Insights', 'Microsoft.Network') {
  Invoke-AzCli provider register --namespace $ns | Out-Null
}
Invoke-AzCli group create -n $rg -l $Location | Out-Null
$sub6 = $SubscriptionId.Replace('-', '').Substring(0, 6).ToLower()
$sa = "st$Prefix$sub6"; if ($sa.Length -gt 24) { $sa = $sa.Substring(0, 24) }
$acr = "acr$Prefix$sub6"
if (-not (Test-AzCli storage account show -g $rg -n $sa)) {
  Invoke-AzCli storage account create -g $rg -n $sa -l $Location --sku $StateStorageSku --kind StorageV2 --min-tls-version TLS1_2 `
    --allow-blob-public-access false --allow-shared-key-access false --https-only true | Out-Null
}
$saId = Invoke-AzCli storage account show -g $rg -n $sa --query id -o tsv
# containers are created through ARM (no data-plane role or firewall opening needed for the person deploying)
foreach ($c in 'tfstate', 'plans', 'audit', 'control') {
  if (-not (Test-AzCli storage container-rm show --storage-account $sa -g $rg -n $c)) {
    Invoke-AzCli storage container-rm create --storage-account $sa -g $rg -n $c | Out-Null
  }
}
# state is precious: keep versions and soft-deleted blobs for 30 days
Invoke-AzCli storage account blob-service-properties update -g $rg --account-name $sa --enable-versioning true `
  --enable-delete-retention true --delete-retention-days 30 --enable-container-delete-retention true --container-delete-retention-days 30 | Out-Null
$lifecycle = @{ rules = @(@{ enabled = $true; name = 'expire-working-data'; type = 'Lifecycle'; definition = @{
        filters = @{ blobTypes = @('blockBlob'); prefixMatch = @('plans/plans/', 'plans/ops/', 'plans/cache/', 'plans/limits/') }
        actions = @{ baseBlob = @{ delete = @{ daysAfterModificationGreaterThan = 30 } }; version = @{ delete = @{ daysAfterCreationGreaterThan = 30 } } } } }) }
$tmpPolicy = New-TemporaryFile
Write-JsonFile $tmpPolicy.FullName $lifecycle
try { Invoke-AzCli storage account management-policy create --account-name $sa -g $rg --policy "@$($tmpPolicy.FullName)" | Out-Null }
catch { Write-Warning "Storage lifecycle policy not set (old plans and operation records will not be cleaned up automatically): $(("$_" -split "`n")[0])" }
finally { Remove-Item $tmpPolicy -ErrorAction SilentlyContinue }

if (-not (Test-AzCli acr show -g $rg -n $acr)) { Invoke-AzCli acr create -g $rg -n $acr -l $Location --sku Basic --admin-enabled false | Out-Null }
$acrId = Invoke-AzCli acr show -g $rg -n $acr --query id -o tsv

# WORM for the audit trail: records can be added, not changed or deleted, for the retention period.
try {
  Invoke-AzCli storage container immutability-policy create -g $rg --account-name $sa --container-name audit `
    --period $AuditRetentionDays --allow-protected-append-writes false | Out-Null
} catch { Write-Warning "Audit immutability policy not set: $(("$_" -split "`n")[0])" }

# Two identities: the MCP front-end can only READ Azure; only the approval/executor service can change it.
foreach ($n in $planIdentityName, $applyIdentityName) {
  if (-not (Test-AzCli identity show -g $rg -n $n)) { Invoke-AzCli identity create -g $rg -n $n -l $Location | Out-Null }
}
$planMi = @{ id = (Invoke-AzCli identity show -g $rg -n $planIdentityName --query id -o tsv)
  clientId = (Invoke-AzCli identity show -g $rg -n $planIdentityName --query clientId -o tsv)
  principalId = (Invoke-AzCli identity show -g $rg -n $planIdentityName --query principalId -o tsv) }
$applyMi = @{ id = (Invoke-AzCli identity show -g $rg -n $applyIdentityName --query id -o tsv)
  clientId = (Invoke-AzCli identity show -g $rg -n $applyIdentityName --query clientId -o tsv)
  principalId = (Invoke-AzCli identity show -g $rg -n $applyIdentityName --query principalId -o tsv) }

Invoke-AzCli monitor log-analytics workspace create -g $rg -n $law -l $Location | Out-Null   # idempotent
$lawCustomerId = Invoke-AzCli monitor log-analytics workspace show -g $rg -n $law --query customerId -o tsv
$lawResourceId = Invoke-AzCli monitor log-analytics workspace show -g $rg -n $law --query id -o tsv
$lawKey = Invoke-AzCli monitor log-analytics workspace get-shared-keys -g $rg -n $law --query primarySharedKey -o tsv

# --- 2. role assignments (least privilege) ---------------------------------------------------
Write-Host '2/9 Environments: resource groups and least-privilege role assignments' -ForegroundColor Cyan
function Grant-Role([string] $PrincipalId, [string] $Role, [string] $Scope) {
  Invoke-WithRetry -What "role $Role" -DelaySeconds $retrySeconds -Action {
    Invoke-AzCli role assignment create --assignee-object-id $PrincipalId --assignee-principal-type ServicePrincipal --role $Role --scope $Scope | Out-Null
  }
}
# ---- custom role definitions (exact JSON is also written to out/role-*.json) --------------------------------
$allSubs = @(@($envConfig.Values | ForEach-Object { $_.subscription_id }) + $SubscriptionId | Sort-Object -Unique)
$scopes = @($allSubs | ForEach-Object { "/subscriptions/$_" })
# Never grantable to the apply identity: anything under Microsoft.Authorization (role assignments, locks, policy
# assignments and exemptions), elevation, blueprints, deny settings, and deleting whole resource groups.
$neverActions = @('Microsoft.Authorization/*/Delete', 'Microsoft.Authorization/*/Write', 'Microsoft.Authorization/elevateAccess/Action',
  'Microsoft.Blueprint/blueprintAssignments/write', 'Microsoft.Blueprint/blueprintAssignments/delete', 'Microsoft.Compute/galleries/share/action',
  'Microsoft.Purview/consents/write', 'Microsoft.Purview/consents/delete', 'Microsoft.Resources/deploymentStacks/manageDenySetting/action',
  'Microsoft.Resources/subscriptions/resourceGroups/delete', 'Microsoft.KeyVault/locations/deletedVaults/purge/action')
# Additionally removed in locked (production) environments: deleting data-bearing resource types.
$protectedDeletes = @('Microsoft.KeyVault/vaults/delete', 'Microsoft.Sql/servers/delete', 'Microsoft.Sql/servers/databases/delete',
  'Microsoft.DBforPostgreSQL/flexibleServers/delete', 'Microsoft.DocumentDB/databaseAccounts/delete', 'Microsoft.Storage/storageAccounts/delete',
  'Microsoft.ContainerService/managedClusters/delete', 'Microsoft.OperationalInsights/workspaces/delete', 'Microsoft.ServiceBus/namespaces/delete',
  'Microsoft.ContainerRegistry/registries/delete')
$roleDefinitions = [ordered]@{
  plan = @{ Name = "Azure Terraform MCP Plan ($Prefix)"; IsCustom = $true; AssignableScopes = $scopes
    Description = 'Read-only: lets the MCP front-end run terraform plan / refresh. No write, delete or action permissions.'
    Actions = @('*/read') + $PlanRoleExtraActions; NotActions = @(); DataActions = @(); NotDataActions = @() }
  apply = @{ Name = "Azure Terraform MCP Apply ($Prefix)"; IsCustom = $true; AssignableScopes = $scopes
    Description = 'Contributor-like for approved applies, without Microsoft.Authorization writes (roles, locks, policy) and without resource group deletion.'
    Actions = @('*'); NotActions = $neverActions; DataActions = @(); NotDataActions = @() }
  applyProtected = @{ Name = "Azure Terraform MCP Apply protected ($Prefix)"; IsCustom = $true; AssignableScopes = $scopes
    Description = 'As the Apply role, and additionally cannot delete data-bearing resource types. Used for locked (production) environments.'
    Actions = @('*'); NotActions = $neverActions + $protectedDeletes; DataActions = @(); NotDataActions = @() }
}
New-Item -ItemType Directory -Force $outDir | Out-Null
foreach ($k in @($roleDefinitions.Keys)) {
  $def = $roleDefinitions[$k]
  $file = Join-Path $outDir "role-$k.json"
  Write-JsonFile $file $def 5
  $existing = Invoke-AzCli role definition list --name $def.Name --query '[0].name' -o tsv
  if ($existing) {
    try { Invoke-AzCli role definition update --role-definition "@$file" | Out-Null }
    catch { Write-Warning "Could not update role '$($def.Name)' (keeping the existing definition): $(("$_" -split "`n")[0])" }
  } else { Invoke-AzCli role definition create --role-definition "@$file" | Out-Null }
}
# ---- registry + storage data plane, per container ---------------------------------------------------------
$containerScope = { param($c) "$saId/blobServices/default/containers/$c" }
Grant-Role $planMi.principalId 'AcrPull' $acrId
Grant-Role $applyMi.principalId 'AcrPull' $acrId
Grant-Role $planMi.principalId 'Storage Blob Data Reader' (& $containerScope 'tfstate')        # plans never lock or write state
Grant-Role $planMi.principalId 'Storage Blob Data Reader' (& $containerScope 'control')        # approvals, freeze, quotas: read-only
Grant-Role $planMi.principalId 'Storage Blob Data Contributor' (& $containerScope 'plans')
Grant-Role $planMi.principalId 'Storage Blob Data Contributor' (& $containerScope 'audit')
Grant-Role $applyMi.principalId 'Storage Blob Data Contributor' $saId
$workloadProviders = 'Microsoft.Storage', 'Microsoft.Network', 'Microsoft.KeyVault', 'Microsoft.Web', 'Microsoft.Sql', 'Microsoft.DBforPostgreSQL',
  'Microsoft.ContainerService', 'Microsoft.ContainerRegistry', 'Microsoft.Compute', 'Microsoft.DocumentDB', 'Microsoft.ServiceBus', 'Microsoft.OperationalInsights'
$registeredSubs = @{}
foreach ($e in @($envConfig.Keys)) {
  $cfg = $envConfig[$e]
  $envSub = $cfg.subscription_id
  $envLocation = @($cfg.allowed_locations)[0]
  if (-not $registeredSubs.ContainsKey($envSub)) {
    # Terraform runs with resource_provider_registrations = "none": providers are registered here, once per subscription
    foreach ($ns in $workloadProviders) { Invoke-AzCli provider register --namespace $ns --subscription $envSub | Out-Null }
    $registeredSubs[$envSub] = $true
  }
  Invoke-AzCli group create -n $cfg.resource_group -l $envLocation --subscription $envSub --tags "managedBy=azure-terraform-mcp" "environment=$e" | Out-Null
  $envScope = "/subscriptions/$envSub/resourceGroups/$($cfg.resource_group)"
  $locked = $LockEnvironments -contains $e
  Grant-Role $planMi.principalId $roleDefinitions.plan.Name $envScope
  Grant-Role $applyMi.principalId $(if ($locked) { $roleDefinitions.applyProtected.Name } else { $roleDefinitions.apply.Name }) $envScope
  if ($locked) {
    # Platform-level: nothing in this resource group can be deleted by anyone until an Owner removes the lock.
    # (Terraform changes that need to replace a resource will fail here - that is the point.)
    Invoke-AzCli lock create --name $lockName --lock-type CanNotDelete --resource-group $cfg.resource_group --subscription $envSub `
      --notes 'Azure Terraform MCP: production resources cannot be deleted through automation.' | Out-Null
  }
  if ($EnableDenyDeletePolicy) {
    $policyFile = Join-Path $outDir 'policy-deny-delete-protected.json'
    Write-JsonFile $policyFile @{ if = @{ field = 'tags[protected]'; equals = 'true' }; then = @{ effect = 'denyAction'; details = @{ actionNames = @('delete') } } }
    try {
      Invoke-AzCli policy definition create --name 'tfmcp-deny-delete-protected' --display-name 'Deny deletion of resources tagged protected=true' `
        --mode Indexed --rules "@$policyFile" --subscription $envSub | Out-Null
      Invoke-AzCli policy assignment create --name "tfmcp-deny-delete-$e" --policy 'tfmcp-deny-delete-protected' --scope $envScope --subscription $envSub | Out-Null
    } catch { Write-Warning "Deny-delete policy not assigned for '$e': $(("$_" -split "`n")[0])" }
  }
  Write-Host ("   {0,-6} -> {1} (subscription {2}) apply={3} destroy={4} approval={5} policy={6}" -f $e, $cfg.resource_group, $envSub,
      [bool]$cfg.enable_apply, [bool]$cfg.enable_destroy, [bool]$cfg.require_approval, $(if ($cfg.policy_profile) { $cfg.policy_profile } else { 'standard' }))
  if ($locked) { Write-Host "          resource group locked (CanNotDelete) + protected apply role" -ForegroundColor DarkGray }
}

# --- 3. Entra ID -----------------------------------------------------------------------------
Write-Host '3/9 Entra app registrations (API + Copilot Studio connector client)' -ForegroundColor Cyan
$apiName = "$Prefix-api"; $cliName = "$Prefix-connector"
$apiId = Invoke-AzCli ad app list --display-name $apiName --query '[0].appId' -o tsv
if (-not $apiId) { $apiId = Invoke-AzCli ad app create --display-name $apiName --sign-in-audience AzureADMyOrg --query appId -o tsv }
$apiObj = Invoke-AzCli ad app show --id $apiId --query id -o tsv
$scopeId = Invoke-AzCli ad app show --id $apiId --query "api.oauth2PermissionScopes[?value=='access_as_user'].id | [0]" -o tsv
if (-not $scopeId) { $scopeId = [guid]::NewGuid().ToString() }
function Get-AppRoles([string] $AppId, [string[]] $Names) {
  # keep existing role ids stable across re-runs
  $roles = @()
  foreach ($n in $Names) {
    $id = Invoke-AzCli ad app show --id $AppId --query "appRoles[?value=='$n'].id | [0]" -o tsv
    if (-not $id) { $id = [guid]::NewGuid().ToString() }
    $roles += @{ id = $id; value = $n; displayName = "Azure Terraform MCP $n"; description = "Azure Terraform MCP role: $n"
      isEnabled = $true; allowedMemberTypes = @('User') }
  }
  , $roles
}
function Grant-AppRole([string] $ResourceAppId, [string] $GroupId, [string] $RoleId) {
  if (-not $GroupId) { return }
  $sp = Invoke-AzCli ad sp show --id $ResourceAppId --query id -o tsv
  $tmp = New-TemporaryFile
  Write-JsonFile $tmp.FullName @{ principalId = $GroupId; resourceId = $sp; appRoleId = $RoleId }
  try { Invoke-AzCli rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$sp/appRoleAssignedTo" --headers 'Content-Type=application/json' --body "@$($tmp.FullName)" | Out-Null }
  catch { Write-Host "   app role assignment skipped (probably exists already)" -ForegroundColor DarkGray }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
$apiRoles = Get-AppRoles $apiId @('viewer', 'requester', 'admin')
$apiBody = @{
  appRoles = $apiRoles
  identifierUris = @("api://$apiId")
  api = @{
    requestedAccessTokenVersion = 2
    preAuthorizedApplications   = @(@{ appId = '04b07795-8ddb-461a-bbee-02f9e1bf7b46'; delegatedPermissionIds = @($scopeId) })  # Azure CLI, for the smoke test
    oauth2PermissionScopes      = @(@{ id = $scopeId; value = 'access_as_user'; type = 'User'; isEnabled = $true
        adminConsentDisplayName = 'Use Azure Terraform MCP'; adminConsentDescription = 'Call the Azure Terraform MCP server as the signed-in user'
        userConsentDisplayName = 'Use Azure Terraform MCP'; userConsentDescription = 'Call the Azure Terraform MCP server on your behalf' })
  }
}
# approver groups are checked against the "groups" claim of the caller's access token
$tmpBody = New-TemporaryFile
Write-JsonFile $tmpBody.FullName $apiBody 6
try { Invoke-AzCli rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apiObj" --headers 'Content-Type=application/json' --body "@$($tmpBody.FullName)" | Out-Null }
finally { Remove-Item $tmpBody -ErrorAction SilentlyContinue }
if (-not (Test-AzCli ad sp show --id $apiId)) { Invoke-AzCli ad sp create --id $apiId | Out-Null }
Grant-AppRole $apiId $ViewerGroupId ($apiRoles | Where-Object { $_.value -eq 'viewer' }).id
Grant-AppRole $apiId $RequesterGroupId ($apiRoles | Where-Object { $_.value -eq 'requester' }).id
Grant-AppRole $apiId $AdminGroupId ($apiRoles | Where-Object { $_.value -eq 'admin' }).id
if (-not ($ViewerGroupId -or $RequesterGroupId -or $AdminGroupId)) {
  Write-Warning 'No -RequesterGroupId / -ViewerGroupId / -AdminGroupId given: nobody has a role yet, so every tool call will be refused. Assign the app roles (viewer, requester, admin) of the API app in Entra ID > Enterprise applications, or re-run with the group parameters.'
}

# The approval page is a DIFFERENT application: its own audience, its own client id, its own scope. A token issued
# for the MCP connector is useless here, and the other way round.
$apprName = "$Prefix-approval"
$apprId = Invoke-AzCli ad app list --display-name $apprName --query '[0].appId' -o tsv
if (-not $apprId) { $apprId = Invoke-AzCli ad app create --display-name $apprName --sign-in-audience AzureADMyOrg --query appId -o tsv }
$apprObj = Invoke-AzCli ad app show --id $apprId --query id -o tsv
$apprScopeId = Invoke-AzCli ad app show --id $apprId --query "api.oauth2PermissionScopes[?value=='approve'].id | [0]" -o tsv
if (-not $apprScopeId) { $apprScopeId = [guid]::NewGuid().ToString() }
$apprRoles = Get-AppRoles $apprId @('approver', 'admin')
function Set-ApprovalApp([string[]] $RedirectUris) {
  $body = @{
    appRoles = $apprRoles
    identifierUris = @("api://$apprId")
    spa = @{ redirectUris = $RedirectUris }
    optionalClaims = @{ accessToken = @(@{ name = 'auth_time'; essential = $false }) }     # lets the server check sign-in freshness
    api = @{
      requestedAccessTokenVersion = 2
      preAuthorizedApplications = @(@{ appId = $apprId; delegatedPermissionIds = @($apprScopeId) })
      oauth2PermissionScopes = @(@{ id = $apprScopeId; value = 'approve'; type = 'User'; isEnabled = $true
          adminConsentDisplayName = 'Approve infrastructure changes'; adminConsentDescription = 'Approve or reject Azure Terraform MCP plans as the signed-in user'
          userConsentDisplayName = 'Approve infrastructure changes'; userConsentDescription = 'Approve or reject plans on your behalf' })
    }
  }
  $tmp = New-TemporaryFile
  Write-JsonFile $tmp.FullName $body 6
  try { Invoke-AzCli rest --method PATCH --uri "https://graph.microsoft.com/v1.0/applications/$apprObj" --headers 'Content-Type=application/json' --body "@$($tmp.FullName)" | Out-Null }
  finally { Remove-Item $tmp -ErrorAction SilentlyContinue }
}
Set-ApprovalApp @()
if (-not (Test-AzCli ad sp show --id $apprId)) { Invoke-AzCli ad sp create --id $apprId | Out-Null }
Grant-AppRole $apprId $ApproverGroupId ($apprRoles | Where-Object { $_.value -eq 'approver' }).id
Grant-AppRole $apprId $AdminGroupId ($apprRoles | Where-Object { $_.value -eq 'admin' }).id
if (-not $ApproverGroupId) { Write-Warning 'No -ApproverGroupId: nobody can approve in two-person environments until the "approver" app role of the approval app is assigned.' }

New-Item -ItemType Directory -Force $outDir | Out-Null
$secretFile = Join-Path $outDir 'connector-client-secret.txt'
$cliId = Invoke-AzCli ad app list --display-name $cliName --query '[0].appId' -o tsv
if (-not $cliId) {
  $cliId = Invoke-AzCli ad app create --display-name $cliName --sign-in-audience AzureADMyOrg --web-redirect-uris 'https://global.consent.azure-apim.net/redirect' --query appId -o tsv
}
if ($RotateConnectorSecret -or -not (Test-Path $secretFile)) {
  # written straight to a git-ignored file; never echoed, never placed in the swagger or in app settings
  $newSecret = Invoke-AzCli ad app credential reset --id $cliId --display-name 'copilot-studio' --years 1 --query password -o tsv
  Set-Content -Path $secretFile -Value $newSecret -NoNewline
  $newSecret = $null
  Write-Host '   new connector client secret written to out/connector-client-secret.txt (valid 1 year)' -ForegroundColor DarkGray
} else {
  Write-Host '   keeping the existing connector client secret (use -RotateConnectorSecret to replace it)' -ForegroundColor DarkGray
}
if (-not (Test-AzCli ad sp show --id $cliId)) { Invoke-AzCli ad sp create --id $cliId | Out-Null }
Invoke-AzCli ad app permission add --id $cliId --api $apiId --api-permissions "$scopeId=Scope" | Out-Null
try { Invoke-WithRetry -What 'admin consent' -Attempts 3 -DelaySeconds $retrySeconds -Action { Invoke-AzCli ad app permission grant --id $cliId --api $apiId --scope access_as_user | Out-Null } }
catch { Write-Warning 'Admin consent was not granted automatically. Ask a Global Administrator to grant it for the connector app in Entra ID.' }

# --- 4. image --------------------------------------------------------------------------------
Write-Host '4/9 Building the server image in ACR (no local Docker needed)' -ForegroundColor Cyan
$tag = Get-Date -Format 'yyyyMMddHHmmss'
$image = "$acr.azurecr.io/azure-terraform-mcp:$tag"
Invoke-AzCli acr build -r $acr -g $rg -t "azure-terraform-mcp:$tag" -t 'azure-terraform-mcp:latest' (Join-Path $PSScriptRoot 'server') --no-logs | Out-Null

# --- 5. network (optional) + Container Apps environment --------------------------------------
Write-Host '5/9 Container Apps environment' -ForegroundColor Cyan
$envExists = Test-AzCli containerapp env show -g $rg -n $envName
$envArgs = @('--logs-workspace-id', $lawCustomerId, '--logs-workspace-key', $lawKey)
if ($PrivateNetworking) {
  $vnet = "vnet-$Prefix"
  if (-not (Test-AzCli network vnet show -g $rg -n $vnet)) {
    Invoke-AzCli network vnet create -g $rg -n $vnet -l $Location --address-prefixes $VnetAddressSpace | Out-Null
  }
  if (-not (Test-AzCli network vnet subnet show -g $rg --vnet-name $vnet -n 'snet-containerapps')) {
    Invoke-AzCli network vnet subnet create -g $rg --vnet-name $vnet -n 'snet-containerapps' --address-prefixes $ContainerAppsSubnet --delegations 'Microsoft.App/environments' | Out-Null
  }
  if (-not (Test-AzCli network vnet subnet show -g $rg --vnet-name $vnet -n 'snet-private-endpoints')) {
    Invoke-AzCli network vnet subnet create -g $rg --vnet-name $vnet -n 'snet-private-endpoints' --address-prefixes $PrivateEndpointSubnet | Out-Null
  }
  $caSubnetId = Invoke-AzCli network vnet subnet show -g $rg --vnet-name $vnet -n 'snet-containerapps' --query id -o tsv
  if ($envExists) {
    $currentSubnet = Invoke-AzCli containerapp env show -g $rg -n $envName --query properties.vnetConfiguration.infrastructureSubnetId -o tsv
    if (-not $currentSubnet) { throw "The Container Apps environment $envName already exists WITHOUT a virtual network and cannot be moved into one. Deploy with a new -Prefix, or delete $envName first." }
  }
  $envArgs += @('--enable-workload-profiles', 'true', '--infrastructure-subnet-resource-id', $caSubnetId)
  if ($InternalIngress) { $envArgs += @('--internal-only', 'true') }
}
if (-not $envExists) { Invoke-AzCli containerapp env create -g $rg -n $envName -l $Location @envArgs | Out-Null }

if ($PrivateNetworking) {
  Write-Host '     private endpoint + private DNS for the state storage account; public access off' -ForegroundColor Cyan
  $zone = 'privatelink.blob.core.windows.net'
  if (-not (Test-AzCli network private-dns zone show -g $rg -n $zone)) { Invoke-AzCli network private-dns zone create -g $rg -n $zone | Out-Null }
  if (-not (Test-AzCli network private-dns link vnet show -g $rg -z $zone -n "link-$vnet")) {
    Invoke-AzCli network private-dns link vnet create -g $rg -z $zone -n "link-$vnet" -v $vnet -e false | Out-Null
  }
  if (-not (Test-AzCli network private-endpoint show -g $rg -n "pe-$sa")) {
    Invoke-AzCli network private-endpoint create -g $rg -n "pe-$sa" -l $Location --vnet-name $vnet --subnet 'snet-private-endpoints' `
      --private-connection-resource-id $saId --group-id blob --connection-name 'blob' | Out-Null
    Invoke-AzCli network private-endpoint dns-zone-group create -g $rg --endpoint-name "pe-$sa" -n 'default' --private-dns-zone $zone --zone-name 'blob' | Out-Null
  }
  Invoke-AzCli storage account update -g $rg -n $sa --public-network-access Disabled --default-action Deny | Out-Null
}

# --- 6. the server ---------------------------------------------------------------------------
Write-Host '6/9 Container Apps: approval/executor service (write identity) and MCP front-end (read-only identity)' -ForegroundColor Cyan
$ingress = if ($InternalIngress) { 'internal' } else { 'external' }
$allowedClients = @($cliId); if ($AllowAzureCliClient) { $allowedClients += '04b07795-8ddb-461a-bbee-02f9e1bf7b46' }
$commonVars = @(
  "SUBSCRIPTION_ID=$SubscriptionId", "TENANT_ID=$tenantId", "STATE_SA=$sa", "ENVIRONMENTS_B64=$envB64", "DEFAULT_ENVIRONMENT=$defaultEnv",
  "AUTH_MODE=$AuthMode", "API_AUDIENCES=$apiId,api://$apiId", "ALLOWED_CLIENT_IDS=$($allowedClients -join ',')", 'REQUIRED_SCOPE=access_as_user',
  "APPROVAL_AUDIENCES=$apprId,api://$apprId", "APPROVAL_CLIENT_IDS=$apprId", 'APPROVAL_SCOPE=approve',
  'TOKEN_BROKER=auto', 'SHUTDOWN_GRACE_SECONDS=540'
)
if ($ApprovalRequireAmr) { $commonVars += "APPROVAL_REQUIRE_AMR=$ApprovalRequireAmr" }
function Deploy-ContainerApp([string] $Name, [hashtable] $Identity, [string[]] $EnvVars, [int] $Min, [int] $Max, [string] $WebhookSecret) {
  $vars = $EnvVars + "AZURE_CLIENT_ID=$($Identity.clientId)"
  $secretArgs = @()
  if ($WebhookSecret) {
    # the webhook URL is a credential: stored as a Container Apps secret, referenced from the environment
    $secretArgs = @('--secrets', "notify-webhook=$WebhookSecret")
    $vars += 'NOTIFY_WEBHOOK_URL=secretref:notify-webhook'
  }
  if (-not (Test-AzCli containerapp show -g $rg -n $Name)) {
    Invoke-WithRetry -What 'AcrPull role propagation' -DelaySeconds $retrySeconds -Action {
      Invoke-AzCli containerapp create -g $rg -n $Name --environment $envName --image $image --target-port 8080 --ingress $ingress --transport http `
        --min-replicas $Min --max-replicas $Max --cpu 1 --memory 2Gi --user-assigned $Identity.id `
        --registry-server "$acr.azurecr.io" --registry-identity $Identity.id @secretArgs --env-vars @vars | Out-Null
    }
  } else {
    Invoke-AzCli containerapp identity assign -g $rg -n $Name --user-assigned $Identity.id | Out-Null
    Invoke-WithRetry -What 'AcrPull role propagation' -DelaySeconds $retrySeconds -Action {
      Invoke-AzCli containerapp registry set -g $rg -n $Name --server "$acr.azurecr.io" --identity $Identity.id | Out-Null
    }
    if ($WebhookSecret) { Invoke-AzCli containerapp secret set -g $rg -n $Name @secretArgs | Out-Null }
    Invoke-AzCli containerapp update -g $rg -n $Name --image $image --replace-env-vars @vars --min-replicas $Min --max-replicas $Max --cpu 1 --memory 2Gi | Out-Null
  }
  # Give Terraform time to stop cleanly (write state, release its lock) when a replica is scaled in or replaced.
  try { Invoke-AzCli containerapp update -g $rg -n $Name --termination-grace-period 600 | Out-Null }
  catch { Write-Warning "Could not raise the termination grace period on $Name (needs a recent containerapp CLI extension): $(("$_" -split "`n")[0])" }
  Invoke-AzCli containerapp show -g $rg -n $Name --query properties.configuration.ingress.fqdn -o tsv
}
# 6a. approval page + privileged executor. No Easy Auth here: the page itself is public static HTML; every API call
#     is authenticated by the service with a token for the approval audience and a fresh sign-in.
$approvalVars = $commonVars + 'TFMCP_ROLE=approval'
$approvalFqdn = Deploy-ContainerApp $approvalApp $applyMi $approvalVars 1 2 $NotifyWebhookUrl
Set-ApprovalApp @("https://$approvalFqdn/")
if ($ApprovalAllowedCidrs) {
  $ruleNumber = 0
  foreach ($cidr in $ApprovalAllowedCidrs) {
    $ruleNumber++
    Invoke-AzCli containerapp ingress access-restriction set -g $rg -n $approvalApp --rule-name "allow$ruleNumber" --ip-address $cidr --action Allow | Out-Null
  }
}
# 6b. MCP front-end
$frontVars = $commonVars + 'TFMCP_ROLE=frontend' + "APPROVAL_BASE_URL=https://$approvalFqdn"
$fqdn = Deploy-ContainerApp $app $planMi $frontVars $MinReplicas $MaxReplicas $NotifyWebhookUrl
if (-not $NoResourceLocks) {
  # The MCP's own resource group (state storage, registry, logs, apps) cannot be deleted while this lock exists.
  Invoke-AzCli lock create --name $lockName --lock-type CanNotDelete --resource-group $rg `
    --notes 'Azure Terraform MCP: state, audit and registry must not be deleted. Remove this lock only to decommission.' | Out-Null
}

# --- 7. authentication -----------------------------------------------------------------------
Write-Host '7/9 Container Apps authentication (anonymous calls get 401; the server validates the token again)' -ForegroundColor Cyan
Invoke-AzCli containerapp auth microsoft update -g $rg -n $app --client-id $apiId --tenant-id $tenantId --allowed-audiences "api://$apiId" --yes | Out-Null
Invoke-AzCli containerapp auth update -g $rg -n $app --enabled true --unauthenticated-client-action Return401 --yes | Out-Null

if ($SecurityGroupId) {
  Write-Host '     restricting access to the Entra group (needs Entra ID P1)' -ForegroundColor Cyan
  $apiSp = Invoke-AzCli ad sp show --id $apiId --query id -o tsv
  Invoke-AzCli ad sp update --id $apiSp --set appRoleAssignmentRequired=true | Out-Null
  $tmpAssign = New-TemporaryFile
  Write-JsonFile $tmpAssign.FullName @{ principalId = $SecurityGroupId; resourceId = $apiSp; appRoleId = '00000000-0000-0000-0000-000000000000' }
  try { Invoke-AzCli rest --method POST --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$apiSp/appRoleAssignedTo" --headers 'Content-Type=application/json' --body "@$($tmpAssign.FullName)" | Out-Null }
  catch { Write-Warning "Group assignment skipped (it may already exist): $(("$_" -split "`n")[0])" }
  finally { Remove-Item $tmpAssign -ErrorAction SilentlyContinue }
}
if ($AllowedCidrs) {
  $ruleNumber = 0
  foreach ($cidr in $AllowedCidrs) {
    $ruleNumber++
    Invoke-AzCli containerapp ingress access-restriction set -g $rg -n $app --rule-name "allow$ruleNumber" --ip-address $cidr --action Allow | Out-Null
  }
}

# --- 8. scheduled jobs + monitoring ----------------------------------------------------------
Write-Host '8/9 Scheduled jobs and monitoring' -ForegroundColor Cyan
if ($EnableScheduledJobs) {
  $jobs = @(
    @{ name = "caj-$Prefix-reaper"; job = 'reaper'; cron = '*/15 * * * *'; mi = $applyMi; vars = $approvalVars + "AZURE_CLIENT_ID=$($applyMi.clientId)" },
    @{ name = "caj-$Prefix-drift"; job = 'drift'; cron = $DriftCron; mi = $planMi; vars = $frontVars + "AZURE_CLIENT_ID=$($planMi.clientId)" })
  foreach ($j in $jobs) {
    $jobVars = $j.vars
    if (Test-AzCli containerapp job show -g $rg -n $j.name) {
      Invoke-AzCli containerapp job update -g $rg -n $j.name --image $image --cron-expression $j.cron --replace-env-vars @jobVars | Out-Null
    } else {
      Invoke-AzCli containerapp job create -g $rg -n $j.name --environment $envName --trigger-type Schedule --cron-expression $j.cron `
        --replica-timeout 7200 --replica-retry-limit 0 --parallelism 1 --replica-completion-count 1 --image $image --cpu 1 --memory 2Gi `
        --mi-user-assigned $j.mi.id --registry-server "$acr.azurecr.io" --registry-identity $j.mi.id `
        --command 'python' --args 'server.py' 'job' $j.job --env-vars @jobVars | Out-Null
    }
    Write-Host "     job $($j.name): '$($j.cron)' (UTC)" -ForegroundColor DarkGray
  }
} else { Write-Host '     scheduled jobs not requested (-EnableScheduledJobs): time-boxed deployments will NOT be destroyed automatically' -ForegroundColor Yellow }
if ($EnableMonitoring) {
  Invoke-AzCli deployment group create -g $rg -n "monitoring-$tag" --template-file (Join-Path $PSScriptRoot 'monitoring' 'monitoring.json') `
    --parameters "workspaceResourceId=$lawResourceId" "alertEmail=$AlertEmail" "prefix=$Prefix" "subscriptionScope=/subscriptions/$SubscriptionId" | Out-Null
  Write-Host '     workbook "Azure Terraform MCP - audit" and alert rules deployed' -ForegroundColor DarkGray
}

# --- 9. Copilot Studio connector files -------------------------------------------------------
Write-Host '9/9 Copilot Studio connector files' -ForegroundColor Cyan
$authUrl = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/authorize"
$tokenUrl = "https://login.microsoftonline.com/$tenantId/oauth2/v2.0/token"
$swagger = [ordered]@{
  swagger = '2.0'
  info = [ordered]@{ title = 'Azure Terraform MCP'; description = 'Governed Terraform for Azure: curated templates, policy gate, cost estimate, approvals'; version = '2.0' }
  host = $fqdn; basePath = '/'; schemes = @('https')
  paths = [ordered]@{ '/mcp' = [ordered]@{ post = [ordered]@{
        summary = 'Azure Terraform MCP'; operationId = 'InvokeServer'
        'x-ms-agentic-protocol' = 'mcp-streamable-1.0'
        parameters = @(); responses = @{ default = @{ description = 'default' } } } } }
  securityDefinitions = [ordered]@{ oauth2_auth = [ordered]@{
      type = 'oauth2'; flow = 'accessCode'; authorizationUrl = $authUrl; tokenUrl = $tokenUrl
      scopes = @{ "api://$apiId/access_as_user" = 'Use Azure Terraform MCP' } } }
  security = @(@{ oauth2_auth = @("api://$apiId/access_as_user") })
}
Write-JsonFile (Join-Path $outDir 'terraform-mcp.swagger.json') $swagger
$props = [ordered]@{ properties = [ordered]@{
    connectionParameters = @{ token = [ordered]@{ type = 'oauthSetting'; oAuthSettings = [ordered]@{
          identityProvider = 'oauth2'; clientId = $cliId; scopes = @("api://$apiId/access_as_user")
          redirectMode = 'Global'; redirectUrl = 'https://global.consent.azure-apim.net/redirect'
          properties = @{ IsFirstParty = 'False'; IsOnbehalfofLoginSupported = 'False' }
          customParameters = @{ authorizationUrl = @{ value = $authUrl }; tokenUrl = @{ value = $tokenUrl }; refreshUrl = @{ value = $tokenUrl } } } } }
    iconBrandColor = '#7B42BC'; capabilities = @(); publisher = 'Platform Engineering' } }
Write-JsonFile (Join-Path $outDir 'apiProperties.json') $props
Set-Content -Path (Join-Path $outDir 'environments.json') -Value ($envConfig | ConvertTo-Json -Depth 8) -Encoding utf8

# Entra ID has no dynamic client registration, so the wizard's "Dynamic discovery" cannot self-register;
# the app is pre-created and pre-consented instead, so makers paste these values once.
@"
# Copilot Studio - add Azure Terraform MCP (copy/paste)

Agent > Tools > Add a tool > New tool > Model Context Protocol

| Field | Value |
|---|---|
| Server name | Azure Terraform MCP |
| Server description | Plan, explain, approve and apply Azure infrastructure from approved Terraform templates, with policy checks and cost estimates |
| Server URL | https://$fqdn/mcp |
| Authentication | OAuth 2.0 > Manual |
| Client ID | $cliId |
| Client secret | (the content of out/connector-client-secret.txt) |
| Authorization URL | $authUrl |
| Token URL template | $tokenUrl |
| Refresh URL | $tokenUrl |
| Scopes | api://$apiId/access_as_user offline_access |

Then Create > copy the Redirect URL shown. If it is not
https://global.consent.azure-apim.net/redirect, add it to app $cliName in Entra
(Authentication > Web > Redirect URIs). Then Create new connection > sign in > Add to agent.
Admin consent is already granted, so users get no consent prompt.

Finally paste agent-instructions.md into the agent's Instructions.

Approvals are NOT done in Copilot Studio. Approvers open https://$approvalFqdn/ and sign in again there.
Kill switch (admins): POST https://$approvalFqdn/api/freeze {"frozen": true, "reason": "..."} with an approval-audience token.
Each user signs in with their own account: approvals and the audit trail use that identity.
"@ | Set-Content -Path (Join-Path $outDir 'copilot-studio-wizard-values.md') -Encoding utf8

if (-not $SkipPacConnector -and (Get-Command pac -CommandType Application -ErrorAction SilentlyContinue)) {
  Write-Host '     pac found: creating the connector (select your Power Platform environment first with `pac auth`)' -ForegroundColor Cyan
  & pac connector create --api-definition-file (Join-Path $outDir 'terraform-mcp.swagger.json') --api-properties-file (Join-Path $outDir 'apiProperties.json')
}

$envSummary = (@($envConfig.Keys) | ForEach-Object { "$_ -> $($envConfig[$_].resource_group)" }) -join '; '
@"

================ DONE ================
MCP endpoint      : https://$fqdn/mcp   (ingress: $ingress, read-only identity $planIdentityName)
Approval page     : https://$approvalFqdn/   (separate Entra app $apprId, write identity $applyIdentityName)
Environments      : $envSummary
Entra API app     : $apiId   (scope api://$apiId/access_as_user)
Connector client  : $cliId   (secret in out/connector-client-secret.txt - git-ignored)
Replicas          : $MinReplicas-$MaxReplicas   Scheduled jobs: $([bool]$EnableScheduledJobs)   Monitoring: $([bool]$EnableMonitoring)
Locks             : MCP resource group $(-not $NoResourceLocks); environments: $($LockEnvironments -join ', ')   Deny-delete policy: $([bool]$EnableDenyDeletePolicy)
Roles             : custom role JSON in out/role-*.json; assign people via -RequesterGroupId / -ApproverGroupId / -ViewerGroupId / -AdminGroupId
Private networking: $([bool]$PrivateNetworking)   Group-restricted: $([bool]$SecurityGroupId)   IP allow-list: $([bool]$AllowedCidrs)
Smoke test        : ./Test-TerraformMcp.ps1 -SubscriptionId $SubscriptionId -Prefix $Prefix

Next, in Copilot Studio (about one minute):
  open out/copilot-studio-wizard-values.md and paste its values into
  Agent > Tools > Add a tool > New tool > Model Context Protocol, then paste agent-instructions.md
  into the agent's Instructions.
Check: an anonymous POST to https://$fqdn/mcp must return 401.
"@ | Write-Host
if ($InternalIngress) {
  Write-Warning 'Internal ingress: the endpoint is reachable only from the virtual network. Copilot Studio (a public cloud service) cannot call it until you publish it through your own gateway (Application Gateway / API Management). That gateway is NOT created by this script.'
}
