terraform {
  required_version = ">= 1.6.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

resource "aws_s3_bucket" "media" {
  bucket = var.media_bucket_name
}

resource "aws_sqs_queue" "renders" {
  name                       = "${var.project_name}-renders"
  visibility_timeout_seconds = 900
}

resource "aws_cloudfront_distribution" "media" {
  enabled = true

  origin {
    domain_name = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id   = "media"
  }

  default_cache_behavior {
    target_origin_id       = "media"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

output "media_bucket_name" {
  value = aws_s3_bucket.media.bucket
}

output "media_cloudfront_domain_name" {
  value = aws_cloudfront_distribution.media.domain_name
}

output "media_cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.media.domain_name}"
}

# Placeholders for the first AWS deployment pass. Task 01 uses local Docker
# services; these resources define the target shape without inventing the full
# production network yet.
resource "aws_ecs_cluster" "renders" {
  name = "${var.project_name}-renders"
}

resource "aws_db_subnet_group" "postgres" {
  count      = length(var.private_subnet_ids) > 0 ? 1 : 0
  name       = "${var.project_name}-postgres"
  subnet_ids = var.private_subnet_ids
}

resource "aws_db_instance" "postgres" {
  count                = length(var.private_subnet_ids) > 0 ? 1 : 0
  identifier           = "${var.project_name}-postgres"
  engine               = "postgres"
  engine_version       = "16"
  instance_class       = "db.t4g.micro"
  allocated_storage    = 20
  db_name              = "reelwalk"
  username             = "reelwalk"
  password             = var.database_password
  db_subnet_group_name = aws_db_subnet_group.postgres[0].name
  skip_final_snapshot  = true
  publicly_accessible  = false
  deletion_protection  = false
}

resource "aws_elasticache_subnet_group" "redis" {
  count      = length(var.private_subnet_ids) > 0 ? 1 : 0
  name       = "${var.project_name}-redis"
  subnet_ids = var.private_subnet_ids
}

resource "aws_elasticache_cluster" "redis" {
  count                = length(var.private_subnet_ids) > 0 ? 1 : 0
  cluster_id           = "${var.project_name}-redis"
  engine               = "redis"
  node_type            = "cache.t4g.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  subnet_group_name    = aws_elasticache_subnet_group.redis[0].name
}
