#!/usr/bin/env sh
# Zero-touch installer launcher (macOS / Linux). Usage: ./install.sh [options]   (see ./install.sh --help)
set -e
dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
command -v node >/dev/null 2>&1 || { echo "Node.js 18+ is required. macOS: brew install node   Debian/Ubuntu: sudo apt install nodejs   (or https://nodejs.org)"; exit 1; }
command -v az   >/dev/null 2>&1 || { echo "Azure CLI is required. macOS: brew install azure-cli   Linux: https://learn.microsoft.com/cli/azure/install-azure-cli-linux"; exit 1; }
exec node "$dir/provision.mjs" "$@"
