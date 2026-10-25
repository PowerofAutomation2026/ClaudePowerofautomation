#!/usr/bin/env bash
# Host the simulator as an Azure Static Website (storage account). Run in Azure Cloud Shell (bash) from this folder:
#   bash deploy-azure-static.sh [resource-group] [location]
set -euo pipefail
RG=${1:-rg-scor-sim}; LOC=${2:-eastus}; SA="scorsim$RANDOM$RANDOM"
az group create -n "$RG" -l "$LOC" -o none
az storage account create -n "$SA" -g "$RG" -l "$LOC" --sku Standard_LRS --kind StorageV2 --allow-blob-public-access true -o none
az storage blob service-properties update --account-name "$SA" --static-website --index-document index.html -o none
az storage blob upload-batch --account-name "$SA" -s "$(dirname "$0")" -d '$web' --pattern '*.js' --overwrite -o none
az storage blob upload-batch --account-name "$SA" -s "$(dirname "$0")" -d '$web' --pattern '*.html' --overwrite -o none
echo; echo "Simulator URL:  $(az storage account show -n "$SA" -g "$RG" --query primaryEndpoints.web -o tsv)"
echo "Delete later with: az group delete -n $RG"
