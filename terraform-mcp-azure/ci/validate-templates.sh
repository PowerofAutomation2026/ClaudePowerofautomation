#!/usr/bin/env bash
# terraform fmt + init (no backend) + validate for every template in server/templates.
# Needs the terraform binary and access to the providers (registry.terraform.io, or a filesystem
# mirror configured through TF_CLI_CONFIG_FILE).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)/server/templates"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export TF_IN_AUTOMATION=1 TF_PLUGIN_CACHE_DIR="${TF_PLUGIN_CACHE_DIR:-$work/.plugin-cache}"
mkdir -p "$TF_PLUGIN_CACHE_DIR"
fail=0
terraform fmt -check -diff -recursive "$root" || { echo "FMT  FAIL (run: terraform fmt -recursive server/templates)"; fail=1; }
for dir in "$root"/*/; do
  name="$(basename "$dir")"
  [[ "$name" == _* ]] && continue
  mkdir -p "$work/$name"
  cp "$dir"/*.tf "$root/_common/common.tf" "$work/$name/"
  if (cd "$work/$name" && terraform init -backend=false -input=false -no-color >init.log 2>&1 && terraform validate -no-color >validate.log 2>&1); then
    echo "OK   $name"
  else
    echo "FAIL $name"; cat "$work/$name/init.log" "$work/$name/validate.log" 2>/dev/null | tail -40; fail=1
  fi
done
exit $fail
