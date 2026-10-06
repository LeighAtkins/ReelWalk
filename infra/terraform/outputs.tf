output "media_bucket_name" {
  value = aws_s3_bucket.media.bucket
}

output "media_cloudfront_url" {
  value = "https://${aws_cloudfront_distribution.media.domain_name}"
}

output "render_jobs_queue_url" {
  value = aws_sqs_queue.render_jobs.url
}

output "render_jobs_dlq_url" {
  value = aws_sqs_queue.render_jobs_dlq.url
}

output "ecr_repository_urls" {
  value = { for k, r in aws_ecr_repository.app : k => r.repository_url }
}

output "github_ci_role_arn" {
  description = "Set as the AWS_ROLE_ARN repository variable"
  value       = aws_iam_role.github_ci.arn
}

output "app_user_name" {
  value = aws_iam_user.app.name
}
