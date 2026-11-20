variable "retention_days" {
  type    = number
  default = 30
}
resource "azurerm_log_analytics_workspace" "this" {
  name                = "log-${var.deployment_name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  sku                 = "PerGB2018"
  retention_in_days   = var.retention_days
  tags                = var.tags
}
output "workspace_id" { value = azurerm_log_analytics_workspace.this.id }
