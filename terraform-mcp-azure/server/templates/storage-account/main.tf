variable "account_tier" {
  type    = string
  default = "Standard"
}
variable "replication_type" {
  type    = string
  default = "ZRS"
}
variable "public_network_access_enabled" {
  type    = bool
  default = false
}
variable "allowed_ip_ranges" {
  type    = list(string)
  default = []
}
variable "shared_access_key_enabled" {
  type    = bool
  default = false
}
variable "versioning_enabled" {
  type    = bool
  default = true
}
variable "soft_delete_days" {
  type    = number
  default = 14
}
variable "containers" {
  type    = list(string)
  default = []
}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

resource "azurerm_storage_account" "this" {
  name                             = substr("st${local.compact_name}${random_string.suffix.result}", 0, 24)
  resource_group_name              = var.resource_group_name
  location                         = var.location
  account_kind                     = "StorageV2"
  account_tier                     = var.account_tier
  account_replication_type         = var.replication_type
  min_tls_version                  = "TLS1_2"
  https_traffic_only_enabled       = true
  allow_nested_items_to_be_public  = false
  shared_access_key_enabled        = var.shared_access_key_enabled
  default_to_oauth_authentication  = true
  public_network_access_enabled    = var.public_network_access_enabled
  cross_tenant_replication_enabled = false
  local_user_enabled               = false
  tags                             = var.tags

  blob_properties {
    versioning_enabled = var.versioning_enabled
    delete_retention_policy {
      days = var.soft_delete_days
    }
    container_delete_retention_policy {
      days = var.soft_delete_days
    }
  }

  network_rules {
    default_action = "Deny"
    bypass         = ["AzureServices"]
    ip_rules       = var.allowed_ip_ranges
  }
}

resource "azurerm_storage_container" "this" {
  for_each              = toset(var.containers)
  name                  = each.value
  storage_account_id    = azurerm_storage_account.this.id
  container_access_type = "private"
}

output "storage_account_name" {
  value = azurerm_storage_account.this.name
}
output "storage_account_id" {
  value = azurerm_storage_account.this.id
}
output "primary_blob_endpoint" {
  value = azurerm_storage_account.this.primary_blob_endpoint
}
