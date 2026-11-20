variable "retention_days" {
  type    = number
  default = 30
}
variable "daily_quota_gb" {
  type    = number
  default = -1
}

resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${var.deployment_name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = var.retention_days
  daily_quota_gb      = var.daily_quota_gb
  tags                = var.tags
}

output "workspace_id" {
  value = azurerm_log_analytics_workspace.this.id
}
output "workspace_customer_id" {
  value = azurerm_log_analytics_workspace.this.workspace_id
}
