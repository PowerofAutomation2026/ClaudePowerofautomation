variable "target_resource_id" {
  type = string
}
variable "subresource" {
  type = string
}
variable "subnet_id" {
  type = string
}
variable "private_dns_zone_ids" {
  type    = list(string)
  default = []
}

resource "azurerm_private_endpoint" "this" {
  name                          = "pe-${var.deployment_name}"
  resource_group_name           = var.resource_group_name
  location                      = var.location
  subnet_id                     = var.subnet_id
  custom_network_interface_name = "nic-pe-${var.deployment_name}"
  tags                          = var.tags

  private_service_connection {
    name                           = var.subresource
    private_connection_resource_id = var.target_resource_id
    subresource_names              = [var.subresource]
    is_manual_connection           = false
  }

  dynamic "private_dns_zone_group" {
    for_each = length(var.private_dns_zone_ids) > 0 ? [1] : []
    content {
      name                 = "default"
      private_dns_zone_ids = var.private_dns_zone_ids
    }
  }
}

output "private_endpoint_id" {
  value = azurerm_private_endpoint.this.id
}
output "private_ip_address" {
  value = azurerm_private_endpoint.this.private_service_connection[0].private_ip_address
}
