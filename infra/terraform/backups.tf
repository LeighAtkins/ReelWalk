# Nightly database backups (apps/worker/src/backup.ts). The free Supabase
# plan keeps none, so a worker task runs pg_dump every night and writes the
# file to this private bucket, which keeps 14 days of them.

resource "aws_s3_bucket" "backups" {
  bucket = "${var.project_name}-backups-${data.aws_caller_identity.current.account_id}-${var.aws_region}"
}

resource "aws_s3_bucket_public_access_block" "backups" {
  bucket                  = aws_s3_bucket.backups.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.ops.arn
    }
    # One key request per backup rather than per part of the upload.
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "backups" {
  bucket = aws_s3_bucket.backups.id
  rule {
    id     = "keep-two-weeks"
    status = "Enabled"
    filter {}
    expiration {
      days = 14
    }
  }
}

# The worker task may add backups (encrypted with the ops key), nothing else.
resource "aws_iam_role_policy" "worker_backups" {
  name = "write-backups"
  role = aws_iam_role.worker_task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.backups.arn}/db/*"
      },
      {
        Effect   = "Allow"
        Action   = ["kms:GenerateDataKey"]
        Resource = aws_kms_key.ops.arn
      },
    ]
  })
}

# EventBridge Scheduler starts the worker task with the backup command.
data "aws_iam_policy_document" "scheduler_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "backup_scheduler" {
  name               = "${var.project_name}-backup-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_trust.json
}

resource "aws_iam_role_policy" "backup_scheduler" {
  name = "run-backup-task"
  role = aws_iam_role.backup_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["ecs:RunTask"]
        Resource = ["${aws_ecs_task_definition.worker.arn_without_revision}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["iam:PassRole"]
        Resource = [aws_iam_role.task_execution.arn, aws_iam_role.worker_task.arn]
      },
    ]
  })
}

resource "aws_scheduler_schedule" "db_backup" {
  name = "${var.project_name}-db-backup"
  # 03:00 in Tokyo, when the app is quietest.
  schedule_expression = "cron(0 18 * * ? *)"

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_ecs_cluster.renders.arn
    role_arn = aws_iam_role.backup_scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.worker.arn
      launch_type         = "FARGATE"
      network_configuration {
        subnets          = module.vpc.public_subnets
        security_groups  = [aws_security_group.worker.id]
        assign_public_ip = true
      }
    }

    input = jsonencode({
      containerOverrides = [{ name = "worker", command = ["node_modules/.bin/tsx", "src/backup.ts"] }]
    })

    retry_policy {
      maximum_retry_attempts = 2
    }
  }
}

# Email if a backup fails.
resource "aws_cloudwatch_log_metric_filter" "backup_failures" {
  name           = "${var.project_name}-backup-failures"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "\"backup failed\""

  metric_transformation {
    name          = "BackupFailures"
    namespace     = "ReelWalk"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "backup_failures" {
  alarm_name          = "${var.project_name}-backup-failed"
  alarm_description   = "The nightly database backup failed. Worker log group ${aws_cloudwatch_log_group.worker.name} has the error."
  namespace           = "ReelWalk"
  metric_name         = "BackupFailures"
  statistic           = "Sum"
  period              = 3600
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
