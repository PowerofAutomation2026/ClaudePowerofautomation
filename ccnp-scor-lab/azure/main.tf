terraform {
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.100" }
  }
}
provider "azurerm" { features {} }

variable "location"   { default = "eastus" }
variable "my_ip_cidr" { description = "Your public IP as x.x.x.x/32 (only this can reach the lab)" }
variable "vm_size"    { default = "Standard_D16s_v5" } # nested virtualization supported (KVM for Cisco images)
variable "admin_user" { default = "labadmin" }
variable "ssh_pubkey_path" { default = "~/.ssh/id_rsa.pub" }

resource "azurerm_resource_group" "rg" {
  name     = "rg-scor-lab"
  location = var.location
}

resource "azurerm_virtual_network" "vnet" {
  name                = "vnet-scor"
  address_space       = ["10.50.0.0/16"]
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
}
resource "azurerm_subnet" "sn" {
  name                 = "sn-lab"
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.50.1.0/24"]
}
resource "azurerm_public_ip" "pip" {
  name                = "pip-eve"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  allocation_method   = "Static"
  sku                 = "Standard"
}
resource "azurerm_network_security_group" "nsg" {
  name                = "nsg-eve"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  security_rule {
    name                       = "mgmt"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_ranges    = ["22", "80", "443", "32768-35000"] # SSH, EVE web GUI, node consoles
    source_address_prefix      = var.my_ip_cidr
    destination_address_prefix = "*"
  }
}
resource "azurerm_network_interface" "nic" {
  name                = "nic-eve"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  ip_configuration {
    name                          = "ipc"
    subnet_id                     = azurerm_subnet.sn.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.pip.id
  }
}
resource "azurerm_network_interface_security_group_association" "a" {
  network_interface_id      = azurerm_network_interface.nic.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}

resource "azurerm_linux_virtual_machine" "eve" {
  name                  = "eve-ng-scor"
  location              = azurerm_resource_group.rg.location
  resource_group_name   = azurerm_resource_group.rg.name
  size                  = var.vm_size
  admin_username        = var.admin_user
  network_interface_ids = [azurerm_network_interface.nic.id]
  custom_data           = base64encode(file("${path.module}/../scripts/install-eve.sh"))
  admin_ssh_key {
    username   = var.admin_user
    public_key = file(pathexpand(var.ssh_pubkey_path))
  }
  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "Premium_LRS"
    disk_size_gb         = 512
  }
  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }
}

# Cost control: auto-shutdown at 23:00 UTC daily so you never forget it running
resource "azurerm_dev_test_global_vm_shutdown_schedule" "off" {
  virtual_machine_id    = azurerm_linux_virtual_machine.eve.id
  location              = azurerm_resource_group.rg.location
  enabled               = true
  daily_recurrence_time = "2300"
  timezone              = "UTC"
  notification_settings { enabled = false }
}

output "eve_gui_url" { value = "https://${azurerm_public_ip.pip.ip_address}  (user: admin / pass: eve — change it!)" }
output "ssh"         { value = "ssh ${var.admin_user}@${azurerm_public_ip.pip.ip_address}" }
