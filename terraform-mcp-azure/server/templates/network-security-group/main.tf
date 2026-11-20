variable "rules" {
  type = list(object({
    name                       = string
    priority                   = number
    direction                  = string
    access                     = string
    protocol                   = string
    source_address_prefix      = string
    destination_address_prefix = string
    destination_port_range     = string
    description                = string
  }))
  default = []
}

resource "azurerm_network_security_group" "this" {
  name                = "nsg-${var.deployment_name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "this" {
  for_each                    = { for r in var.rules : r.name => r }
  name                        = each.value.name
  description                 = each.value.description
  priority                    = each.value.priority
  direction                   = each.value.direction
  access                      = each.value.access
  protocol                    = each.value.protocol
  source_port_range           = "*"
  source_address_prefix       = each.value.source_address_prefix
  destination_address_prefix  = each.value.destination_address_prefix
  destination_port_range      = each.value.destination_port_range
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this.name
}

output "nsg_id" {
  value = azurerm_network_security_group.this.id
}
output "nsg_name" {
  value = azurerm_network_security_group.this.name
}
