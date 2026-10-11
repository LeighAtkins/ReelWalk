# Media bucket and the CloudFront distribution in front of it. Both predate
# this configuration and were imported (imports.tf), so their names are fixed.

resource "aws_s3_bucket" "media" {
  bucket = var.media_bucket_name

  tags = {
    Env = "prod"
  }
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# The browser uploads straight to S3 with presigned PUT URLs and reads
# thumbnails with presigned GET URLs, so the bucket must answer CORS.
resource "aws_s3_bucket_cors_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  cors_rule {
    allowed_methods = ["GET", "HEAD", "PUT"]
    # The custom domain plus App Runner's own address, which the smoke test uses.
    allowed_origins = concat(var.media_cors_origins, ["https://${aws_apprunner_service.web.service_url}"])
    allowed_headers = ["*"]
    expose_headers  = ["ETag"]
    max_age_seconds = 3600
  }
}

# Only CloudFront may read objects anonymously; the app uses IAM credentials.
data "aws_iam_policy_document" "media_bucket" {
  statement {
    sid       = "AllowCloudFrontServicePrincipal"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "ArnLike"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.media.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = data.aws_iam_policy_document.media_bucket.json
}

resource "aws_cloudfront_origin_access_control" "media" {
  name                              = "oac-${var.media_bucket_name}.s3-mqlv4jg9gi0"
  description                       = "Created by CloudFront"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

locals {
  # AWS managed cache policy "CachingOptimized".
  cache_policy_caching_optimized = "658327ea-f89d-4fab-a63d-7e88639e58f6"
  media_origin_id                = "${var.media_bucket_name}.s3.${var.aws_region}.amazonaws.com-mqlv3a3crq8"
}

resource "aws_cloudfront_distribution" "media" {
  enabled         = true
  is_ipv6_enabled = true
  http_version    = "http2"
  price_class     = "PriceClass_All"

  origin {
    domain_name              = aws_s3_bucket.media.bucket_regional_domain_name
    origin_id                = local.media_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.media.id
  }

  default_cache_behavior {
    target_origin_id           = local.media_origin_id
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD"]
    cached_methods             = ["GET", "HEAD"]
    compress                   = true
    cache_policy_id            = local.cache_policy_caching_optimized
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media.id
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

# Parts of an upload that was abandoned (tab closed, phone died) are billed
# like any object until removed; S3 drops them two days after the start.
resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}
    abort_incomplete_multipart_upload {
      days_after_initiation = 2
    }
  }
}

# Object keys never get new content (uploads, previews and renders each have
# their own), so browsers may cache them for a year. Applies only where S3 sent
# no Cache-Control of its own.
resource "aws_cloudfront_response_headers_policy" "media" {
  name = "${var.project_name}-media-cache"

  custom_headers_config {
    items {
      header   = "Cache-Control"
      value    = "public, max-age=31536000, immutable"
      override = false
    }
  }
}

