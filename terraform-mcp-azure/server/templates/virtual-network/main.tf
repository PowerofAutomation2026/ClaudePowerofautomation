variable "address_space" {
  type    = list(string)
  default = ["10.20.0.0/16"]
}
variable "subnets" {
  type    = map(string)
  default = { default = "10.20.0.0/24" }
}
variable "dns_servers" {
  type    = list(string)
  default = []
}

resource "azurerm_virtual_network" "this" {
  name                = "vnet-${var.deployment_name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  address_space       = var.address_space
  dns_servers         = var.dns_servers
  tags                = var.tags
}

resource "azurerm_subnet" "this" {
  for_each                        = var.subnets
  name                            = each.key
  resource_group_name             = var.resource_group_name
  virtual_network_name            = azurerm_virtual_network.this.name
  address_prefixes                = [each.value]
  default_outbound_access_enabled = false
}

output "vnet_id" {
  value = azurerm_virtual_network.this.id
}
output "subnet_ids" {
  value = { for k, s in azurerm_subnet.this : k => s.id }
}
