#!/usr/bin/env bash
# Parse-checks every PowerShell script and EXECUTES Deploy-AzureTerraformMcp.ps1 end to end against
# the fake az CLI in ci/fake-az (no Azure involved). Verifies control flow, quoting, the az argument
# lists and the generated connector files. Needs PowerShell 7 (pwsh) and python3.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
PWSH="${PWSH:-pwsh}"
export POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off AZTFMCP_RETRY_SECONDS=0
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
cp -r "$root"/*.ps1 "$root/server" "$root/monitoring" "$work/" 2>/dev/null
mkdir -p "$work/bin"; cp "$root/ci/fake-az/az" "$work/bin/az"; chmod +x "$work/bin/az"
export PATH="$work/bin:$PATH"
SUB=11111111-1111-1111-1111-111111111111

echo "== parse check"
"$PWSH" -NoLogo -NoProfile -File "$root/ci/Test-ScriptSyntax.ps1" -Path "$work"
"$PWSH" -NoLogo -NoProfile -File "$root/ci/Test-ScriptSyntax.ps1" -Path "$root/ci"

run() {  # run <name> <deploy args...>
  local name="$1"; shift
  export FAKE_AZ_LOG="$work/$name.log" FAKE_AZ_STATE="$work/$name.state.json"
  : > "$FAKE_AZ_LOG"; rm -rf "$FAKE_AZ_STATE" "$work/out"      # every scenario starts from an empty subscription
  echo "== scenario: $name"
  (cd "$work" && "$PWSH" -NoLogo -NoProfile -File ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId $SUB "$@" > "$work/$name.out" 2>&1) \
    || { echo "FAILED: $name"; tail -30 "$work/$name.out"; exit 1; }
}
check() { python3 "$root/ci/check_deploy_run.py" "$@"; }

run default
check "$work" default
run full -Environments dev,test,prod -EnableApply -EnableDestroy -ApproverGroupId 99999999-0000-0000-0000-000000000009 \
    -MonthlyBudgetUsd 2000 -EnableScheduledJobs -EnableMonitoring -AlertEmail ops@contoso.com -PrivateNetworking \
    -SecurityGroupId 88888888-0000-0000-0000-000000000008 -AllowedCidrs 203.0.113.0/24,198.51.100.7/32 -MaxReplicas 4
check "$work" full
# second run on the same state = in-place upgrade path; the connector secret must be kept
export FAKE_AZ_STATE="$work/full.state.json" FAKE_AZ_LOG="$work/rerun.log"
cp "$work/out/connector-client-secret.txt" "$work/secret.before"
: > "$FAKE_AZ_LOG"; echo "== scenario: rerun (in-place upgrade)"
(cd "$work" && "$PWSH" -NoLogo -NoProfile -File ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId $SUB -Environments dev,prod -EnableApply > "$work/rerun.out" 2>&1) \
    || { echo "FAILED: rerun"; tail -30 "$work/rerun.out"; exit 1; }
check "$work" rerun
cat > "$work/envs.json" <<JSON
{"sandbox": {"resource_group": "rg-custom-sbx", "allowed_locations": ["westeurope"], "enable_apply": true, "enable_destroy": true, "allow_ephemeral": true, "max_ttl_hours": 48},
 "prod": {"resource_group": "rg-custom-prod", "subscription_id": "33333333-3333-3333-3333-333333333333", "allowed_locations": ["westeurope", "northeurope"],
          "policy_profile": "strict", "enable_apply": true, "require_approval": true, "monthly_budget_usd": 5000}}
JSON
run file -EnvironmentsFile ./envs.json -Prefix custom1
check "$work" file
# a failing az command must stop the script with a clear error (no silent continue)
export FAKE_AZ_FAIL="acr build" FAKE_AZ_LOG="$work/fail.log" FAKE_AZ_STATE="$work/fail.state.json"; rm -rf "$work/out"
if (cd "$work" && "$PWSH" -NoLogo -NoProfile -File ./Deploy-AzureTerraformMcp.ps1 -SubscriptionId $SUB > "$work/fail.out" 2>&1); then
  echo "FAILED: script continued after az acr build failed"; exit 1
fi
grep -q "simulated failure" "$work/fail.out" && ! grep -q "DONE" "$work/fail.out" && echo "OK   failure of az stops the script with the az error"
unset FAKE_AZ_FAIL
run destroy -Destroy
check "$work" destroy
# the older HCP Terraform variant: must at least run to completion against the fake CLI
export FAKE_AZ_LOG="$work/hcp.log" FAKE_AZ_STATE="$work/hcp.state.json"; rm -rf "$work/out"; : > "$FAKE_AZ_LOG"
(cd "$work" && TFE_TOKEN=dummy-token-for-test "$PWSH" -NoLogo -NoProfile -File ./Deploy-TerraformMcp.ps1 -SubscriptionId $SUB -EnableOperations > "$work/hcp.out" 2>&1) \
  || { echo "FAILED: hcp variant"; tail -30 "$work/hcp.out"; exit 1; }
grep -q "================ DONE ================" "$work/hcp.out" && grep -q '"containerapp", "create"' "$work/hcp.log" \
  && echo "OK   Deploy-TerraformMcp.ps1 (HCP variant) runs to completion: $(wc -l < "$work/hcp.log") az calls"
echo "ALL DEPLOY-SCRIPT CHECKS PASSED"
