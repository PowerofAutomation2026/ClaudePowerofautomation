variable "address_space" {
  type    = list(string)
  default = ["10.20.0.0/16"]
}
variable "subnets" {
  type    = map(string)
  default = { default = "10.20.0.0/24" }
}
resource "azurerm_virtual_network" "this" {
  name                = "vnet-${var.deployment_name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  address_space       = var.address_space
  tags                = var.tags
}
resource "azurerm_subnet" "s" {
  for_each             = var.subnets
  name                 = each.key
  resource_group_name  = var.resource_group_name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [each.value]
}
output "vnet_id" { value = azurerm_virtual_network.this.id }
