variable "sku_name" {
  type    = string
  default = "standard"
}
variable "soft_delete_retention_days" {
  type    = number
  default = 90
}
variable "public_network_access_enabled" {
  type    = bool
  default = false
}
variable "allowed_ip_ranges" {
  type    = list(string)
  default = []
}
variable "private_endpoint_subnet_id" {
  type    = string
  default = null
}
variable "private_dns_zone_id" {
  type    = string
  default = null
}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

resource "azurerm_key_vault" "this" {
  # 3-24 chars, no consecutive hyphens
  name                          = "kv-${trimsuffix(substr(var.deployment_name, 0, 14), "-")}-${random_string.suffix.result}"
  resource_group_name           = var.resource_group_name
  location                      = var.location
  tenant_id                     = var.tenant_id
  sku_name                      = var.sku_name
  rbac_authorization_enabled    = true
  purge_protection_enabled      = true # not configurable: deleted vaults and secrets stay recoverable
  soft_delete_retention_days    = var.soft_delete_retention_days
  public_network_access_enabled = var.public_network_access_enabled
  tags                          = var.tags

  network_acls {
    default_action = "Deny"
    bypass         = "AzureServices"
    ip_rules       = var.allowed_ip_ranges
  }
}

resource "azurerm_private_endpoint" "this" {
  count               = var.private_endpoint_subnet_id == null ? 0 : 1
  name                = "pe-${azurerm_key_vault.this.name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  subnet_id           = var.private_endpoint_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "vault"
    private_connection_resource_id = azurerm_key_vault.this.id
    subresource_names              = ["vault"]
    is_manual_connection           = false
  }

  dynamic "private_dns_zone_group" {
    for_each = var.private_dns_zone_id == null ? [] : [var.private_dns_zone_id]
    content {
      name                 = "default"
      private_dns_zone_ids = [private_dns_zone_group.value]
    }
  }
}

output "key_vault_name" {
  value = azurerm_key_vault.this.name
}
output "key_vault_id" {
  value = azurerm_key_vault.this.id
}
output "vault_uri" {
  value = azurerm_key_vault.this.vault_uri
}
