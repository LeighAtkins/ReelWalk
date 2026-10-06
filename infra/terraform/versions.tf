terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }

  # State lives in a versioned, private bucket created once by hand
  # (see README.md). Locking uses S3 conditional writes, no DynamoDB table.
  backend "s3" {
    bucket       = "reelwalk-tfstate-734329326838"
    key          = "reelwalk/terraform.tfstate"
    region       = "us-east-2"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project   = "ReelWalk"
      ManagedBy = "terraform"
    }
  }
}

data "aws_caller_identity" "current" {}
