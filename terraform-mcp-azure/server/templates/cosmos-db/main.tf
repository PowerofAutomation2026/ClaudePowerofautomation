variable "capacity_mode" {
  type    = string
  default = "Serverless"
}
variable "max_throughput" {
  type    = number
  default = 1000
}
variable "consistency_level" {
  type    = string
  default = "Session"
}
variable "zone_redundant" {
  type    = bool
  default = false
}
variable "public_network_access_enabled" {
  type    = bool
  default = false
}
variable "allowed_ip_ranges" {
  type    = list(string)
  default = []
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

resource "azurerm_cosmosdb_account" "this" {
  name                               = "cosmos-${var.deployment_name}-${random_string.suffix.result}"
  resource_group_name                = var.resource_group_name
  location                           = var.location
  offer_type                         = "Standard"
  kind                               = "GlobalDocumentDB"
  local_authentication_enabled       = false
  access_key_metadata_writes_enabled = false
  public_network_access_enabled      = var.public_network_access_enabled
  ip_range_filter                    = var.allowed_ip_ranges
  minimal_tls_version                = "Tls12"
  automatic_failover_enabled         = false
  tags                               = var.tags

  consistency_policy {
    consistency_level = var.consistency_level
  }

  geo_location {
    location          = var.location
    failover_priority = 0
    zone_redundant    = var.zone_redundant
  }

  dynamic "capabilities" {
    for_each = var.capacity_mode == "Serverless" ? ["EnableServerless"] : []
    content {
      name = capabilities.value
    }
  }

  backup {
    type = "Continuous"
    tier = "Continuous7Days"
  }
}

resource "azurerm_cosmosdb_sql_database" "this" {
  name                = var.database_name
  resource_group_name = var.resource_group_name
  account_name        = azurerm_cosmosdb_account.this.name

  dynamic "autoscale_settings" {
    for_each = var.capacity_mode == "Provisioned" ? [1] : []
    content {
      max_throughput = var.max_throughput
    }
  }
}

output "account_name" {
  value = azurerm_cosmosdb_account.this.name
}
output "account_id" {
  value = azurerm_cosmosdb_account.this.id
}
output "endpoint" {
  value = azurerm_cosmosdb_account.this.endpoint
}
output "database_name" {
  value = azurerm_cosmosdb_sql_database.this.name
}
