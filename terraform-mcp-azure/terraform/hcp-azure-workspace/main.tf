# Sample: an HCP Terraform workspace the agent may drive, authenticated to Azure with OIDC (no stored secrets).
terraform {
  required_providers {
    tfe     = { source = "hashicorp/tfe", version = "~> 0.60" }
    azuread = { source = "hashicorp/azuread", version = "~> 3.0" }
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
  }
}
variable "org"             { type = string }
variable "workspace_name"  { type = string }
variable "vcs_repo"        { type = string }   # e.g. contoso/azure-landing-zone
variable "vcs_oauth_token" { type = string }   # tfe_oauth_client token id (ot-...)
variable "subscription_id" { type = string }
variable "auto_apply" {
  type    = bool
  default = false # keep false: humans approve applies
}

provider "azuread" {}
provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}
provider "tfe" {}
data "azurerm_subscription" "this" {}

resource "azuread_application" "tfc" { display_name = "tfc-${var.workspace_name}" }
resource "azuread_service_principal" "tfc" { client_id = azuread_application.tfc.client_id }
resource "azuread_application_federated_identity_credential" "plan" {
  application_id = azuread_application.tfc.id
  display_name   = "tfc-plan"
  issuer         = "https://app.terraform.io"
  audiences      = ["api://AzureADTokenExchange"]
  subject        = "organization:${var.org}:project:Default Project:workspace:${var.workspace_name}:run_phase:plan"
}
resource "azuread_application_federated_identity_credential" "apply" {
  application_id = azuread_application.tfc.id
  display_name   = "tfc-apply"
  issuer         = "https://app.terraform.io"
  audiences      = ["api://AzureADTokenExchange"]
  subject        = "organization:${var.org}:project:Default Project:workspace:${var.workspace_name}:run_phase:apply"
}
# Least privilege: Contributor on the subscription here; scope down to a resource group for real use.
resource "azurerm_role_assignment" "tfc" {
  scope                = data.azurerm_subscription.this.id
  role_definition_name = "Contributor"
  principal_id         = azuread_service_principal.tfc.object_id
}
resource "tfe_workspace" "ws" {
  name         = var.workspace_name
  organization = var.org
  auto_apply   = var.auto_apply
  vcs_repo {
    identifier     = var.vcs_repo
    oauth_token_id = var.vcs_oauth_token
  }
}
locals { vars = {
  TFC_AZURE_PROVIDER_AUTH = "true"
  TFC_AZURE_RUN_CLIENT_ID = azuread_application.tfc.client_id
  ARM_SUBSCRIPTION_ID     = var.subscription_id
  ARM_TENANT_ID           = data.azurerm_subscription.this.tenant_id
} }
resource "tfe_variable" "env" {
  for_each     = local.vars
  key          = each.key
  value        = each.value
  category     = "env"
  workspace_id = tfe_workspace.ws.id
}
