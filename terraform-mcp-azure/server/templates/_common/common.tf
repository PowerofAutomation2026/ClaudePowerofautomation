terraform {
  required_version = ">= 1.6"
  backend "azurerm" {}
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 4.0" }
    random  = { source = "hashicorp/random", version = "~> 3.6" }
  }
}
provider "azurerm" {
  features {}
  use_msi         = true
  subscription_id = var.subscription_id
}
variable "subscription_id" { type = string }
variable "deployment_name" { type = string }
variable "resource_group_name" { type = string }
variable "location" { type = string }
variable "tags" {
  type    = map(string)
  default = {}
}
