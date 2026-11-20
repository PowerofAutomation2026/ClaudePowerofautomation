variable "entra_admin_login" {
  type = string
}
variable "entra_admin_object_id" {
  type = string
}
variable "database_name" {
  type    = string
  default = "appdb"
}
variable "sku_name" {
  type    = string
  default = "GP_S_Gen5_1"
}
variable "max_size_gb" {
  type    = number
  default = null
}
variable "auto_pause_minutes" {
  type    = number
  default = 60
}
variable "zone_redundant" {
  type    = bool
  default = false
}
variable "backup_storage_redundancy" {
  type    = string
  default = "Geo"
}
variable "backup_retention_days" {
  type    = number
  default = 7
}
variable "public_network_access_enabled" {
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

locals {
  serverless = startswith(var.sku_name, "GP_S_")
}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

resource "azurerm_mssql_server" "this" {
  name                          = "sql-${var.deployment_name}-${random_string.suffix.result}"
  resource_group_name           = var.resource_group_name
  location                      = var.location
  version                       = "12.0"
  minimum_tls_version           = "1.2"
  public_network_access_enabled = var.public_network_access_enabled
  tags                          = var.tags

  # Entra ID only: no SQL logins or passwords exist on this server.
  azuread_administrator {
    login_username              = var.entra_admin_login
    object_id                   = var.entra_admin_object_id
    tenant_id                   = var.tenant_id
    azuread_authentication_only = true
  }

  identity {
    type = "SystemAssigned"
  }
}

resource "azurerm_mssql_database" "this" {
  name                                = var.database_name
  server_id                           = azurerm_mssql_server.this.id
  sku_name                            = var.sku_name
  max_size_gb                         = var.max_size_gb
  zone_redundant                      = var.zone_redundant
  storage_account_type                = var.backup_storage_redundancy
  auto_pause_delay_in_minutes         = local.serverless ? var.auto_pause_minutes : null
  min_capacity                        = local.serverless ? 0.5 : null
  transparent_data_encryption_enabled = true
  tags                                = var.tags

  short_term_retention_policy {
    retention_days = var.backup_retention_days
  }
}

resource "azurerm_private_endpoint" "this" {
  count               = var.private_endpoint_subnet_id == null ? 0 : 1
  name                = "pe-${azurerm_mssql_server.this.name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  subnet_id           = var.private_endpoint_subnet_id
  tags                = var.tags

  private_service_connection {
    name                           = "sqlserver"
    private_connection_resource_id = azurerm_mssql_server.this.id
    subresource_names              = ["sqlServer"]
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

output "server_name" {
  value = azurerm_mssql_server.this.name
}
output "server_fqdn" {
  value = azurerm_mssql_server.this.fully_qualified_domain_name
}
output "server_id" {
  value = azurerm_mssql_server.this.id
}
output "database_name" {
  value = azurerm_mssql_database.this.name
}
