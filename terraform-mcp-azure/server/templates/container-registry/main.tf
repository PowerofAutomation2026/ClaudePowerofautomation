variable "sku" {
  type    = string
  default = "Standard"
}
variable "public_network_access_enabled" {
  type    = bool
  default = true
}
variable "zone_redundancy_enabled" {
  type    = bool
  default = false
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

resource "azurerm_container_registry" "this" {
  name                          = "acr${local.compact_name}${random_string.suffix.result}"
  resource_group_name           = var.resource_group_name
  location                      = var.location
  sku                           = var.sku
  admin_enabled                 = false
  anonymous_pull_enabled        = false
  public_network_access_enabled = var.public_network_access_enabled
  zone_redundancy_enabled       = var.zone_redundancy_enabled
  tags                          = var.tags

  lifecycle {
    precondition {
      condition     = var.sku == "Premium" || (var.public_network_access_enabled && !var.zone_redundancy_enabled && var.private_endpoint_subnet_id == null)
      error_message = "Disabling public network access, zone redundancy and private endpoints need the Premium SKU."
    }
  }
}

resource "azurerm_private_endpoint" "this" {
  count               = var.private_endpoint_subnet_id == null ? 0 : 1
  name                = "pe-${azurerm_container_registry.this.name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  subnet_id           = var.private_endpoint_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "registry"
    private_connection_resource_id = azurerm_container_registry.this.id
    subresource_names              = ["registry"]
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

output "registry_name" {
  value = azurerm_container_registry.this.name
}
output "registry_id" {
  value = azurerm_container_registry.this.id
}
output "login_server" {
  value = azurerm_container_registry.this.login_server
}
