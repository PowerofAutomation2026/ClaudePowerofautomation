variable "entra_admin_name" {
  type = string
}
variable "entra_admin_object_id" {
  type = string
}
variable "entra_admin_type" {
  type    = string
  default = "Group"
}
variable "postgres_version" {
  type    = string
  default = "16"
}
variable "sku_name" {
  type    = string
  default = "B_Standard_B1ms"
}
variable "storage_mb" {
  type    = number
  default = 32768
}
variable "backup_retention_days" {
  type    = number
  default = 7
}
variable "geo_redundant_backup_enabled" {
  type    = bool
  default = false
}
variable "high_availability" {
  type    = bool
  default = false
}
variable "public_network_access_enabled" {
  type    = bool
  default = false
}
variable "delegated_subnet_id" {
  type    = string
  default = null
}
variable "private_dns_zone_id" {
  type    = string
  default = null
}
variable "database_name" {
  type    = string
  default = "appdb"
}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

resource "azurerm_postgresql_flexible_server" "this" {
  name                          = "psql-${var.deployment_name}-${random_string.suffix.result}"
  resource_group_name           = var.resource_group_name
  location                      = var.location
  version                       = var.postgres_version
  sku_name                      = var.sku_name
  storage_mb                    = var.storage_mb
  backup_retention_days         = var.backup_retention_days
  geo_redundant_backup_enabled  = var.geo_redundant_backup_enabled
  public_network_access_enabled = var.public_network_access_enabled
  delegated_subnet_id           = var.delegated_subnet_id
  private_dns_zone_id           = var.private_dns_zone_id
  tags                          = var.tags

  # Entra ID only: password sign-in is disabled, so no administrator password exists.
  authentication {
    active_directory_auth_enabled = true
    password_auth_enabled         = false
    tenant_id                     = var.tenant_id
  }

  dynamic "high_availability" {
    for_each = var.high_availability ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  lifecycle {
    # Azure picks the zones; do not fight it on later plans.
    ignore_changes = [zone, high_availability[0].standby_availability_zone]

    precondition {
      condition     = (var.delegated_subnet_id == null) == (var.private_dns_zone_id == null)
      error_message = "delegated_subnet_id and private_dns_zone_id must be given together (VNet-integrated server) or both omitted."
    }
    precondition {
      condition     = !(var.delegated_subnet_id != null && var.public_network_access_enabled)
      error_message = "A VNet-integrated server cannot have public network access."
    }
    precondition {
      condition     = !(var.high_availability && startswith(var.sku_name, "B_"))
      error_message = "High availability is not available on Burstable (B_) sizes."
    }
  }
}

resource "azurerm_postgresql_flexible_server_active_directory_administrator" "this" {
  server_name         = azurerm_postgresql_flexible_server.this.name
  resource_group_name = var.resource_group_name
  tenant_id           = var.tenant_id
  object_id           = var.entra_admin_object_id
  principal_name      = var.entra_admin_name
  principal_type      = var.entra_admin_type
}

resource "azurerm_postgresql_flexible_server_database" "this" {
  name      = var.database_name
  server_id = azurerm_postgresql_flexible_server.this.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

output "server_name" {
  value = azurerm_postgresql_flexible_server.this.name
}
output "server_fqdn" {
  value = azurerm_postgresql_flexible_server.this.fqdn
}
output "server_id" {
  value = azurerm_postgresql_flexible_server.this.id
}
output "database_name" {
  value = azurerm_postgresql_flexible_server_database.this.name
}
