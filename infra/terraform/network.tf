# One VPC in two availability zones. Nodes live in public subnets with public
# addresses, which avoids a NAT gateway (the single most expensive idle line
# on a small cluster). The database sits in private subnets with no route out.

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = "${var.project_name}-eks"
  cidr = "10.20.0.0/16"

  azs              = ["${var.aws_region}a", "${var.aws_region}b"]
  public_subnets   = ["10.20.0.0/20", "10.20.16.0/20"]
  database_subnets = ["10.20.100.0/24", "10.20.101.0/24"]

  enable_nat_gateway           = false
  map_public_ip_on_launch      = true
  create_database_subnet_group = true

  public_subnet_tags = {
    "kubernetes.io/role/elb"                    = "1"
    "kubernetes.io/cluster/${var.project_name}" = "shared"
  }
}
