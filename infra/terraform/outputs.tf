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

output "apprunner_url" {
  value = "https://${aws_apprunner_service.web.service_url}"
}

output "apprunner_dns_target" {
  description = "CNAME target for the custom domain"
  value       = aws_apprunner_custom_domain_association.web.dns_target
}

output "apprunner_certificate_validation_records" {
  description = "CNAME records Cloudflare must carry before App Runner issues the certificate"
  value       = aws_apprunner_custom_domain_association.web.certificate_validation_records
}

output "worker_task_definition" {
  value = aws_ecs_task_definition.worker.arn_without_revision
}
