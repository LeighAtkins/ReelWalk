# One VPC in two availability zones. The on-demand Fargate render tasks run
# in public subnets with public addresses, which avoids a NAT gateway (the
# single most expensive idle line on a small deployment).

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 6.0"

  name = "${var.project_name}-eks"
  cidr = "10.20.0.0/16"

  azs            = ["${var.aws_region}a", "${var.aws_region}b"]
  public_subnets = ["10.20.0.0/20", "10.20.16.0/20"]

  enable_nat_gateway      = false
  map_public_ip_on_launch = true
}
