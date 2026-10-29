# Render job queue. The numbers mirror apps/worker/src/config.ts and
# docker-compose.yml: a 120 s lease renewed by heartbeats, three receives
# before the message is parked in the dead-letter queue (ADR 0001, 0003).

resource "aws_sqs_queue" "render_jobs_dlq" {
  name                      = "${var.project_name}-render-jobs-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "render_jobs" {
  name                       = "${var.project_name}-render-jobs"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600 # 4 days
  receive_wait_time_seconds  = 20     # long polling
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.render_jobs_dlq.arn
    maxReceiveCount     = 3 # must equal RENDER_MAX_ATTEMPTS
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "render_jobs_dlq" {
  queue_url = aws_sqs_queue.render_jobs_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.render_jobs.arn]
  })
}

# Our own workspaces' renders (ADR 0094): consumed by a worker on the owner's
# PC, never by Fargate. The same lease and receive numbers as render_jobs; the
# web app moves a job left here unclaimed for LOCAL_RENDER_FALLBACK_SECONDS to
# render_jobs, so a switched-off PC delays a render, never loses it.

resource "aws_sqs_queue" "render_jobs_local_dlq" {
  name                      = "${var.project_name}-render-jobs-local-dlq"
  message_retention_seconds = 1209600 # 14 days, the maximum
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "render_jobs_local" {
  name                       = "${var.project_name}-render-jobs-local"
  visibility_timeout_seconds = 120
  message_retention_seconds  = 345600 # 4 days
  receive_wait_time_seconds  = 20     # long polling
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.render_jobs_local_dlq.arn
    maxReceiveCount     = 3 # must equal RENDER_MAX_ATTEMPTS
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "render_jobs_local_dlq" {
  queue_url = aws_sqs_queue.render_jobs_local_dlq.id

  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.render_jobs_local.arn]
  })
}
