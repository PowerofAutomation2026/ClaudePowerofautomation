variable "admin_group_object_ids" {
  type = list(string)
}
variable "private_cluster" {
  type    = bool
  default = true
}
variable "authorized_ip_ranges" {
  type    = list(string)
  default = []
}
variable "kubernetes_version" {
  type    = string
  default = null
}
variable "sku_tier" {
  type    = string
  default = "Free"
}
variable "node_vm_size" {
  type    = string
  default = "Standard_D2s_v5"
}
variable "node_count" {
  type    = number
  default = 2
}
variable "node_subnet_id" {
  type    = string
  default = null
}
variable "log_analytics_workspace_id" {
  type    = string
  default = null
}

resource "azurerm_kubernetes_cluster" "this" {
  name                              = "aks-${var.deployment_name}"
  resource_group_name               = var.resource_group_name
  location                          = var.location
  dns_prefix                        = var.deployment_name
  kubernetes_version                = var.kubernetes_version
  sku_tier                          = var.sku_tier
  private_cluster_enabled           = var.private_cluster
  local_account_disabled            = true
  role_based_access_control_enabled = true
  oidc_issuer_enabled               = true
  workload_identity_enabled         = true
  azure_policy_enabled              = true
  automatic_upgrade_channel         = "patch"
  node_os_upgrade_channel           = "NodeImage"
  tags                              = var.tags

  # Sign-in and authorization through Entra ID and Azure RBAC only.
  azure_active_directory_role_based_access_control {
    tenant_id              = var.tenant_id
    azure_rbac_enabled     = true
    admin_group_object_ids = var.admin_group_object_ids
  }

  identity {
    type = "SystemAssigned"
  }

  default_node_pool {
    name                        = "system"
    vm_size                     = var.node_vm_size
    node_count                  = var.node_count
    os_sku                      = "AzureLinux"
    vnet_subnet_id              = var.node_subnet_id
    temporary_name_for_rotation = "systemtmp"
    tags                        = var.tags

    upgrade_settings {
      max_surge = "10%"
    }
  }

  network_profile {
    network_plugin      = "azure"
    network_plugin_mode = "overlay"
    network_data_plane  = "cilium"
    network_policy      = "cilium"
    load_balancer_sku   = "standard"
  }

  dynamic "api_server_access_profile" {
    for_each = !var.private_cluster && length(var.authorized_ip_ranges) > 0 ? [1] : []
    content {
      authorized_ip_ranges = var.authorized_ip_ranges
    }
  }

  dynamic "oms_agent" {
    for_each = var.log_analytics_workspace_id == null ? [] : [var.log_analytics_workspace_id]
    content {
      log_analytics_workspace_id      = oms_agent.value
      msi_auth_for_monitoring_enabled = true
    }
  }

  lifecycle {
    # automatic patch upgrades move these
    ignore_changes = [kubernetes_version, default_node_pool[0].orchestrator_version]
  }
}

output "cluster_name" {
  value = azurerm_kubernetes_cluster.this.name
}
output "cluster_id" {
  value = azurerm_kubernetes_cluster.this.id
}
output "oidc_issuer_url" {
  value = azurerm_kubernetes_cluster.this.oidc_issuer_url
}
output "node_resource_group" {
  value = azurerm_kubernetes_cluster.this.node_resource_group
}
output "private_fqdn" {
  value = azurerm_kubernetes_cluster.this.private_fqdn
}
