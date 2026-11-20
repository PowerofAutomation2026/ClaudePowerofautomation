# Shared by every template: backend, pinned providers and the variables the server injects.
# Users can never set these variables; the server fills them from the environment configuration.
terraform {
  required_version = ">= 1.6"
  backend "azurerm" {}
  required_providers {
    # Exact pins: this is the provider build every template was validated against.
    azurerm = { source = "hashicorp/azurerm", version = "4.81.0" }
    random  = { source = "hashicorp/random", version = "3.9.1" }
  }
}

provider "azurerm" {
  features {
    key_vault {
      purge_soft_delete_on_destroy    = false
      recover_soft_deleted_key_vaults = true
    }
    storage {
      # storage accounts are created with public network access off: never call the data plane
      data_plane_available = false
    }
  }
  use_msi             = true
  subscription_id     = var.subscription_id
  storage_use_azuread = true
  # The identity is Contributor on one resource group only; it cannot (and must not) register
  # resource providers. The deploy script registers them once per subscription.
  resource_provider_registrations = "none"
}

variable "subscription_id" {
  type        = string
  description = "Injected: subscription of the target environment."
}
variable "tenant_id" {
  type        = string
  description = "Injected: Entra tenant."
}
variable "deployment_name" {
  type        = string
  description = "Injected: validated deployment name (3-20 chars, lowercase, digits, hyphens)."
}
variable "resource_group_name" {
  type        = string
  description = "Injected: the environment's resource group. Templates never create resource groups."
}
variable "location" {
  type        = string
  description = "Injected: a region allowed for the environment."
}
variable "environment" {
  type        = string
  description = "Injected: environment name (dev, test, prod ...)."
}
variable "tags" {
  type        = map(string)
  description = "Injected: mandatory tags (managedBy, environment, deployment, owner) plus user tags."
  default     = {}
}

locals {
  # deployment name without hyphens, for resource types that only allow letters and digits
  compact_name = replace(var.deployment_name, "-", "")
}
