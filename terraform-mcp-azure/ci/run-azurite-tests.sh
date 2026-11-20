#!/usr/bin/env bash
# Runs the storage-semantics tests (ETag compare-and-swap, conditional delete, lease break) against the
# Azurite emulator. Needs Node.js (npx) and the Python dev requirements. The account key is random
# and lives only for this run - nothing secret is stored in the repository.
set -euo pipefail
cd "$(dirname "$0")/../server"
PY="${PYTHON:-python}"
AZURITE="${AZURITE_BIN:-npx --yes azurite-blob@3.38.0}"
key="$(head -c 32 /dev/urandom | base64)"
port="${AZURITE_PORT:-10000}"
AZURITE_ACCOUNTS="devacct:${key}" $AZURITE --inMemoryPersistence --skipApiVersionCheck --silent --blobPort "$port" &
pid=$!
trap 'kill $pid 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do (echo > "/dev/tcp/127.0.0.1/$port") 2>/dev/null && break; sleep 1; done
export NO_PROXY="127.0.0.1,localhost" no_proxy="127.0.0.1,localhost"
export AZURITE_CONNECTION_STRING="DefaultEndpointsProtocol=http;AccountName=devacct;AccountKey=${key};BlobEndpoint=http://127.0.0.1:${port}/devacct;"
"$PY" -m pytest tests/test_blobstore_azurite.py -v
