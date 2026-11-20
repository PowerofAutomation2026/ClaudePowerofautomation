variable "address_space" {
  type    = list(string)
  default = ["10.0.0.0/16"]
}
variable "subnets" {
  type = map(string)
  default = {
    workloads         = "10.0.1.0/24"
    private-endpoints = "10.0.2.0/24"
  }
}
variable "dns_servers" {
  type    = list(string)
  default = []
}
variable "allow_intra_vnet_inbound" {
  type    = bool
  default = true
}

locals {
  # Azure-managed subnets must not carry a custom NSG like this one.
  reserved_subnets = ["GatewaySubnet", "AzureFirewallSubnet", "AzureFirewallManagementSubnet", "AzureBastionSubnet", "RouteServerSubnet"]
  guarded_subnets  = { for name, cidr in var.subnets : name => cidr if !contains(local.reserved_subnets, name) }
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
  for_each                          = var.subnets
  name                              = each.key
  resource_group_name               = var.resource_group_name
  virtual_network_name              = azurerm_virtual_network.this.name
  address_prefixes                  = [each.value]
  default_outbound_access_enabled   = contains(local.reserved_subnets, each.key)
  private_endpoint_network_policies = "Enabled"
}

resource "azurerm_network_security_group" "this" {
  for_each            = local.guarded_subnets
  name                = "nsg-${var.deployment_name}-${each.key}"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags
}

resource "azurerm_network_security_rule" "allow_vnet_inbound" {
  for_each                    = var.allow_intra_vnet_inbound ? local.guarded_subnets : {}
  name                        = "allow-vnet-inbound"
  priority                    = 4000
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "VirtualNetwork"
  destination_address_prefix  = "VirtualNetwork"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this[each.key].name
}

resource "azurerm_network_security_rule" "deny_all_inbound" {
  for_each                    = local.guarded_subnets
  name                        = "deny-all-inbound"
  priority                    = 4096
  direction                   = "Inbound"
  access                      = "Deny"
  protocol                    = "*"
  source_port_range           = "*"
  destination_port_range      = "*"
  source_address_prefix       = "*"
  destination_address_prefix  = "*"
  resource_group_name         = var.resource_group_name
  network_security_group_name = azurerm_network_security_group.this[each.key].name
}

resource "azurerm_subnet_network_security_group_association" "this" {
  for_each                  = local.guarded_subnets
  subnet_id                 = azurerm_subnet.this[each.key].id
  network_security_group_id = azurerm_network_security_group.this[each.key].id
  depends_on                = [azurerm_network_security_rule.deny_all_inbound, azurerm_network_security_rule.allow_vnet_inbound]
}

output "vnet_id" {
  value = azurerm_virtual_network.this.id
}
output "subnet_ids" {
  value = { for k, s in azurerm_subnet.this : k => s.id }
}
output "nsg_ids" {
  value = { for k, n in azurerm_network_security_group.this : k => n.id }
}
