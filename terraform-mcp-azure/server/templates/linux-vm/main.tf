variable "subnet_id" {
  type = string
}
variable "admin_ssh_public_key" {
  type = string
}
variable "admin_username" {
  type    = string
  default = "azureuser"
}
variable "size" {
  type    = string
  default = "Standard_B2s"
}
variable "image" {
  type    = string
  default = "ubuntu-24.04"
}
variable "os_disk_type" {
  type    = string
  default = "Premium_LRS"
}
variable "os_disk_size_gb" {
  type    = number
  default = 64
}
variable "zone" {
  type    = string
  default = null
}
variable "entra_login_enabled" {
  type    = bool
  default = true
}
variable "encryption_at_host_enabled" {
  type    = bool
  default = false
}

locals {
  images = {
    "ubuntu-24.04" = { publisher = "Canonical", offer = "ubuntu-24_04-lts", sku = "server" }
    "ubuntu-22.04" = { publisher = "Canonical", offer = "0001-com-ubuntu-server-jammy", sku = "22_04-lts-gen2" }
  }
}

# Private only: the network interface never gets a public IP address.
resource "azurerm_network_interface" "this" {
  name                = "nic-${var.deployment_name}"
  resource_group_name = var.resource_group_name
  location            = var.location
  tags                = var.tags

  ip_configuration {
    name                          = "internal"
    subnet_id                     = var.subnet_id
    private_ip_address_allocation = "Dynamic"
  }
}

resource "azurerm_linux_virtual_machine" "this" {
  name                            = "vm-${var.deployment_name}"
  computer_name                   = substr(var.deployment_name, 0, 15)
  resource_group_name             = var.resource_group_name
  location                        = var.location
  size                            = var.size
  zone                            = var.zone
  admin_username                  = var.admin_username
  disable_password_authentication = true
  network_interface_ids           = [azurerm_network_interface.this.id]
  secure_boot_enabled             = true
  vtpm_enabled                    = true
  encryption_at_host_enabled      = var.encryption_at_host_enabled
  patch_mode                      = "AutomaticByPlatform"
  patch_assessment_mode           = "AutomaticByPlatform"
  tags                            = var.tags

  admin_ssh_key {
    username   = var.admin_username
    public_key = var.admin_ssh_public_key
  }

  identity {
    type = "SystemAssigned"
  }

  os_disk {
    name                 = "osdisk-${var.deployment_name}"
    caching              = "ReadWrite"
    storage_account_type = var.os_disk_type
    disk_size_gb         = var.os_disk_size_gb
  }

  source_image_reference {
    publisher = local.images[var.image].publisher
    offer     = local.images[var.image].offer
    sku       = local.images[var.image].sku
    version   = "latest"
  }

  boot_diagnostics {}
}

# Sign in with Entra ID (az ssh vm) - needs the "Virtual Machine Administrator/User Login" role on the VM.
resource "azurerm_virtual_machine_extension" "entra_login" {
  count                      = var.entra_login_enabled ? 1 : 0
  name                       = "AADSSHLoginForLinux"
  virtual_machine_id         = azurerm_linux_virtual_machine.this.id
  publisher                  = "Microsoft.Azure.ActiveDirectory"
  type                       = "AADSSHLoginForLinux"
  type_handler_version       = "1.0"
  auto_upgrade_minor_version = true
  tags                       = var.tags
}

output "vm_name" {
  value = azurerm_linux_virtual_machine.this.name
}
output "vm_id" {
  value = azurerm_linux_virtual_machine.this.id
}
output "private_ip_address" {
  value = azurerm_network_interface.this.private_ip_address
}
output "identity_principal_id" {
  value = azurerm_linux_virtual_machine.this.identity[0].principal_id
}
