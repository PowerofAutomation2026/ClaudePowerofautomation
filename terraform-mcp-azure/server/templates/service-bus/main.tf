variable "sku" {
  type    = string
  default = "Standard"
}
variable "capacity" {
  type    = number
  default = 1
}
variable "public_network_access_enabled" {
  type    = bool
  default = true
}
variable "queues" {
  type    = list(string)
  default = []
}
variable "max_delivery_count" {
  type    = number
  default = 10
}

resource "random_string" "suffix" {
  length  = 5
  upper   = false
  special = false
}

resource "azurerm_servicebus_namespace" "this" {
  name                          = "sb-${var.deployment_name}-${random_string.suffix.result}"
  resource_group_name           = var.resource_group_name
  location                      = var.location
  sku                           = var.sku
  capacity                      = var.sku == "Premium" ? var.capacity : 0
  premium_messaging_partitions  = var.sku == "Premium" ? 1 : 0
  local_auth_enabled            = false
  minimum_tls_version           = "1.2"
  public_network_access_enabled = var.public_network_access_enabled
  tags                          = var.tags

  lifecycle {
    precondition {
      condition     = var.sku == "Premium" || var.public_network_access_enabled
      error_message = "Disabling public network access needs the Premium SKU."
    }
  }
}

resource "azurerm_servicebus_queue" "this" {
  for_each                             = toset(var.queues)
  name                                 = each.value
  namespace_id                         = azurerm_servicebus_namespace.this.id
  max_delivery_count                   = var.max_delivery_count
  dead_lettering_on_message_expiration = true
}

output "namespace_name" {
  value = azurerm_servicebus_namespace.this.name
}
output "namespace_id" {
  value = azurerm_servicebus_namespace.this.id
}
output "endpoint" {
  value = azurerm_servicebus_namespace.this.endpoint
}
output "queue_names" {
  value = [for q in azurerm_servicebus_queue.this : q.name]
}
