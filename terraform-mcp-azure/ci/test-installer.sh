#!/usr/bin/env bash
# Runs Install-AzureTerraformMcp.ps1 end to end against the fake az and pac CLIs (ci/fake-az): preflight-only,
# unattended install, re-run (upgrade), failure + resume, interactive wizard, failed preflight, Power Platform
# failure, uninstall. No Azure, Entra or Power Platform is involved; Install.cmd itself is not executed (Windows).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
PWSH="${PWSH:-pwsh}"
export POWERSHELL_TELEMETRY_OPTOUT=1 POWERSHELL_UPDATECHECK=Off AZTFMCP_RETRY_SECONDS=0
work="$(mktemp -d)"; trap '[ -n "${KEEP:-}" ] && echo "kept $work" || rm -rf "$work"' EXIT
cp -r "$root"/*.ps1 "$root"/*.json "$root/server" "$root/monitoring" "$root/agent-instructions.md" "$work/"; rm -rf "$work/server/tests"
mkdir -p "$work/bin"; cp "$root/ci/fake-az/az" "$root/ci/fake-az/pac" "$work/bin/"; chmod +x "$work/bin/"*
export PATH="$work/bin:$PATH"
SUB=11111111-1111-1111-1111-111111111111
python3 - "$work" <<'PY'
import json, sys
w = sys.argv[1]
cfg = json.load(open(f"{w}/install.config.example.json"))
cfg.update(subscriptionId="11111111-1111-1111-1111-111111111111", skipSmokeTest=True, enableApply=True)
cfg["powerPlatform"]["environment"] = "https://platform.crm.dynamics.com"
json.dump(cfg, open(f"{w}/install.config.json", "w"))
PY
run() {  # run <name> <expected exit code> <installer args...>
  local name="$1" want="$2"; shift 2
  export FAKE_AZ_LOG="$work/$name.az.log" FAKE_PAC_LOG="$work/$name.pac.log"; : > "$FAKE_AZ_LOG"; : > "$FAKE_PAC_LOG"
  local code=0
  (cd "$work" && "$PWSH" -NoLogo -NoProfile -File ./Install-AzureTerraformMcp.ps1 "$@" > "$work/$name.out" 2>&1 < "${STDIN:-/dev/null}") || code=$?
  if [ "$code" != "$want" ]; then echo "FAILED: $name exited $code, expected $want"; tail -25 "$work/$name.out" | sed 's/\x1b\[[0-9;]*m//g'; exit 1; fi
  python3 "$root/ci/check_installer_run.py" "$work" "$name"
}
fresh() { rm -rf "$work/out" "$work/.deploy-state" "$work"/state*.json*; export FAKE_AZ_STATE="$work/state-$1.json"; }
CFG=(-Unattended -ConfigFile ./install.config.json)

echo "== parse"; "$PWSH" -NoLogo -NoProfile -File "$root/ci/Test-ScriptSyntax.ps1" -Path "$root" | grep -E "Install|PARSE" || true
fresh a; run preflight 0 "${CFG[@]}" -PreflightOnly
run whatif 0 "${CFG[@]}" -WhatIf
run install 0 "${CFG[@]}"
run rerun 0 "${CFG[@]}"
fresh b; FAKE_AZ_FAIL="acr build" run failure 1 "${CFG[@]}"
run resume 0 "${CFG[@]}"
fresh c; FAKE_AZ_ROLES="Reader" run badpreflight 2 "${CFG[@]}" -PreflightOnly
FAKE_AZ_ROLES="Reader" run blocked 1 "${CFG[@]}"
fresh d; FAKE_PAC_FAIL="connector create" run pacfail 0 "${CFG[@]}"
fresh e; printf '2\n\n\ndev\nn\n\n2\n' > "$work/answers.txt"
FAKE_AZ_SUBS=2 STDIN="$work/answers.txt" run wizard 0 -SkipSmokeTest
fresh f; run install2 0 "${CFG[@]}"; run uninstall 0 "${CFG[@]}" -Uninstall -RemoveGroups
echo "ALL INSTALLER CHECKS PASSED"
