variable "sku_name" {
  type    = string
  default = "B1"
}
variable "worker_count" {
  type    = number
  default = 1
}
variable "runtime" {
  type    = string
  default = "NODE:22-lts"
}
variable "always_on" {
  type    = bool
  default = true
}
variable "public_network_access_enabled" {
  type    = bool
  default = true
}
variable "vnet_integration_subnet_id" {
  type    = string
  default = null
}
variable "health_check_path" {
  type    = string
  default = null
}
variable "app_settings" {
  type    = map(string)
  default = {}
}

locals {
  stack   = split(":", var.runtime)[0]
  version = split(":", var.runtime)[1]
}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

resource "azurerm_service_plan" "this" {
  name                = "asp-${var.deployment_name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  os_type             = "Linux"
  sku_name            = var.sku_name
  worker_count        = var.worker_count
  tags                = var.tags
}

resource "azurerm_linux_web_app" "this" {
  name                                           = "app-${var.deployment_name}-${random_string.suffix.result}"
  resource_group_name                            = var.resource_group_name
  location                                       = var.location
  service_plan_id                                = azurerm_service_plan.this.id
  https_only                                     = true
  public_network_access_enabled                  = var.public_network_access_enabled
  virtual_network_subnet_id                      = var.vnet_integration_subnet_id
  client_affinity_enabled                        = false
  ftp_publish_basic_authentication_enabled       = false
  webdeploy_publish_basic_authentication_enabled = false
  app_settings                                   = var.app_settings
  tags                                           = var.tags

  identity {
    type = "SystemAssigned"
  }

  site_config {
    always_on                         = var.always_on
    ftps_state                        = "Disabled"
    http2_enabled                     = true
    minimum_tls_version               = "1.2"
    scm_minimum_tls_version           = "1.2"
    remote_debugging_enabled          = false
    health_check_path                 = var.health_check_path
    health_check_eviction_time_in_min = var.health_check_path == null ? null : 5
    vnet_route_all_enabled            = var.vnet_integration_subnet_id != null

    application_stack {
      node_version   = local.stack == "NODE" ? local.version : null
      python_version = local.stack == "PYTHON" ? local.version : null
      dotnet_version = local.stack == "DOTNET" ? local.version : null
    }
  }
}

output "web_app_name" {
  value = azurerm_linux_web_app.this.name
}
output "web_app_id" {
  value = azurerm_linux_web_app.this.id
}
output "default_hostname" {
  value = azurerm_linux_web_app.this.default_hostname
}
output "identity_principal_id" {
  value = azurerm_linux_web_app.this.identity[0].principal_id
}
