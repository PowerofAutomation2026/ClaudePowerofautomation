variable "account_tier" {
  type    = string
  default = "Standard"
}
variable "replication_type" {
  type    = string
  default = "LRS"
}
resource "random_string" "s" {
  length  = 6
  upper   = false
  special = false
}
resource "azurerm_storage_account" "this" {
  name                            = substr("st${replace(var.deployment_name, "-", "")}${random_string.s.result}", 0, 24)
  resource_group_name             = var.resource_group_name
  location                        = var.location
  account_tier                    = var.account_tier
  account_replication_type        = var.replication_type
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  tags                            = var.tags
}
output "storage_account_name" { value = azurerm_storage_account.this.name }
