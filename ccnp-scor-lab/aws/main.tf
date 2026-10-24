terraform {
  required_providers { aws = { source = "hashicorp/aws", version = "~> 5.0" } }
}
provider "aws" { region = var.region }

variable "region"      { default = "us-east-1" }
variable "my_ip_cidr"  { description = "Your public IP as x.x.x.x/32" }
variable "key_name"    { description = "Existing EC2 key pair name" }
# KVM needs bare metal on AWS (no nested virt on regular instances). ~US$4/hr — STOP IT when done.
variable "eve_instance_type" { default = "c5.metal" }
# Optional NATIVE Cisco appliances. Subscribe in AWS Marketplace first, then paste AMI IDs for your region.
variable "ftdv_ami"   { default = "" } # Cisco Secure Firewall Threat Defense Virtual (BYOL/trial)
variable "fmcv_ami"   { default = "" } # Cisco Secure Firewall Management Center Virtual
variable "c8000v_ami" { default = "" } # Cisco Catalyst 8000V (router, IPsec/GRE/DMVPN/FlexVPN)
variable "ftdv_type"  { default = "c5.xlarge" }
variable "fmcv_type"  { default = "c5.4xlarge" }
variable "c8000v_type"{ default = "c5n.large" }

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}

resource "aws_vpc" "v" {
  cidr_block           = "10.60.0.0/16"
  enable_dns_hostnames = true
  tags = { Name = "scor-lab" }
}
resource "aws_internet_gateway" "igw" { vpc_id = aws_vpc.v.id }
resource "aws_subnet" "mgmt" {
  vpc_id                  = aws_vpc.v.id
  cidr_block              = "10.60.1.0/24"
  map_public_ip_on_launch = true
}
resource "aws_subnet" "inside" {
  vpc_id     = aws_vpc.v.id
  cidr_block = "10.60.10.0/24"
}
resource "aws_subnet" "outside" {
  vpc_id                  = aws_vpc.v.id
  cidr_block              = "10.60.20.0/24"
  map_public_ip_on_launch = true
}
resource "aws_route_table" "pub" {
  vpc_id = aws_vpc.v.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}
resource "aws_route_table_association" "m" {
  subnet_id      = aws_subnet.mgmt.id
  route_table_id = aws_route_table.pub.id
}
resource "aws_route_table_association" "o" {
  subnet_id      = aws_subnet.outside.id
  route_table_id = aws_route_table.pub.id
}

resource "aws_security_group" "lab" {
  name   = "scor-lab"
  vpc_id = aws_vpc.v.id
  ingress {
    description = "Admin access from my IP only"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.my_ip_cidr]
  }
  ingress {
    description = "intra-VPC"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# ---- EVE-NG web GUI host (bring your own Cisco images: IOSv, ASAv, FTDv, FMCv, ISE, ...) ----
resource "aws_instance" "eve" {
  ami                    = data.aws_ami.ubuntu.id
  instance_type          = var.eve_instance_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.mgmt.id
  vpc_security_group_ids = [aws_security_group.lab.id]
  user_data              = file("${path.module}/../scripts/install-eve.sh")
  root_block_device {
    volume_size = 500
    volume_type = "gp3"
  }
  tags = { Name = "eve-ng-scor" }
}

# ---- Native Cisco appliances (optional; created only if AMI id supplied) ----
resource "aws_instance" "ftdv" {
  count                  = var.ftdv_ami == "" ? 0 : 1
  ami                    = var.ftdv_ami
  instance_type          = var.ftdv_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.mgmt.id
  vpc_security_group_ids = [aws_security_group.lab.id]
  # FTDv first-boot day0 (manage via FMC): fill in your FMC address / reg key
  user_data = jsonencode({
    AdminPassword = "ChangeMe!12345"
    Hostname      = "ftd1"
    FirewallMode  = "routed"
    ManageLocally = "No"
    FmcIp         = length(aws_instance.fmcv) > 0 ? aws_instance.fmcv[0].private_ip : ""
    FmcRegKey     = "cisco123"
    FmcNatId      = "ftd1"
  })
  tags = { Name = "ftdv" }
}
resource "aws_instance" "fmcv" {
  count                  = var.fmcv_ami == "" ? 0 : 1
  ami                    = var.fmcv_ami
  instance_type          = var.fmcv_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.mgmt.id
  vpc_security_group_ids = [aws_security_group.lab.id]
  user_data = jsonencode({ AdminPassword = "ChangeMe!12345", Hostname = "fmc1" })
  tags = { Name = "fmcv" }
}
resource "aws_instance" "c8000v" {
  count                  = var.c8000v_ami == "" ? 0 : 1
  ami                    = var.c8000v_ami
  instance_type          = var.c8000v_type
  key_name               = var.key_name
  subnet_id              = aws_subnet.mgmt.id
  vpc_security_group_ids = [aws_security_group.lab.id]
  tags = { Name = "c8000v" }
}

output "eve_gui_url" { value = "https://${aws_instance.eve.public_ip}  (admin/eve — change it)" }
output "fmc_url"     { value = length(aws_instance.fmcv) > 0 ? "https://${aws_instance.fmcv[0].public_ip}" : "n/a" }
