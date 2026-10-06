# Resources that existed before this configuration. Import blocks are
# idempotent: once the state holds the resource they are no-ops.

import {
  to = aws_s3_bucket.media
  id = "reelwalk-media-prod-734329326838-us-east-2-an"
}

import {
  to = aws_s3_bucket_public_access_block.media
  id = "reelwalk-media-prod-734329326838-us-east-2-an"
}

import {
  to = aws_s3_bucket_policy.media
  id = "reelwalk-media-prod-734329326838-us-east-2-an"
}

import {
  to = aws_cloudfront_origin_access_control.media
  id = "EGIIPBLWVLJH4"
}

import {
  to = aws_cloudfront_distribution.media
  id = "E3TVPU0FCSUONG"
}
