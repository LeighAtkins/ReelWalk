# The clock for scheduled Instagram posts (ADR 0017). App Runner gives an
# instance almost no CPU between requests, so the web app's own 60 s loop
# cannot be trusted to run there. Every minute EventBridge POSTs to
# /api/scheduled-posts/run with a bearer secret, and that request runs one
# publisher tick (claim due posts, check containers, publish).
#
# EventBridge Scheduler has no HTTPS target, so this is a scheduled
# EventBridge rule with an API destination, the native way to call an HTTP
# endpoint on a timer. The secret is generated here and handed to both sides:
# the connection (stored by EventBridge in Secrets Manager) and the web app
# (Parameter Store, SCHEDULER_SECRET in serverless.tf).

resource "random_password" "scheduler" {
  length  = 48
  special = false
}

resource "aws_cloudwatch_event_connection" "scheduled_posts" {
  name               = "${var.project_name}-scheduled-posts"
  description        = "Bearer secret for the scheduled post publisher endpoint"
  authorization_type = "API_KEY"

  auth_parameters {
    api_key {
      key   = "Authorization"
      value = "Bearer ${random_password.scheduler.result}"
    }
  }
}

# The App Runner address rather than the public domain: it does not depend on
# the DNS and proxy in front of reelwalking.com.
resource "aws_cloudwatch_event_api_destination" "scheduled_posts" {
  name                             = "${var.project_name}-scheduled-posts"
  description                      = "One scheduled post publisher tick"
  invocation_endpoint              = "https://${aws_apprunner_service.web.service_url}/api/scheduled-posts/run"
  http_method                      = "POST"
  invocation_rate_limit_per_second = 1
  connection_arn                   = aws_cloudwatch_event_connection.scheduled_posts.arn
}

resource "aws_cloudwatch_event_rule" "scheduled_posts" {
  name                = "${var.project_name}-scheduled-posts"
  description         = "Publishes scheduled Instagram posts that are due"
  schedule_expression = var.scheduled_posts_rate
}

data "aws_iam_policy_document" "events_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduled_posts" {
  name               = "${var.project_name}-scheduled-posts"
  assume_role_policy = data.aws_iam_policy_document.events_trust.json
}

resource "aws_iam_role_policy" "scheduled_posts" {
  name = "invoke-publisher"
  role = aws_iam_role.scheduled_posts.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["events:InvokeApiDestination"]
      Resource = [aws_cloudwatch_event_api_destination.scheduled_posts.arn]
    }]
  })
}

resource "aws_cloudwatch_event_target" "scheduled_posts" {
  rule     = aws_cloudwatch_event_rule.scheduled_posts.name
  arn      = aws_cloudwatch_event_api_destination.scheduled_posts.arn
  role_arn = aws_iam_role.scheduled_posts.arn
  input    = jsonencode({ source = "eventbridge" })

  # A missed tick is made up by the next one a minute later, so no retries
  # that could pile up behind a slow deploy.
  retry_policy {
    maximum_event_age_in_seconds = 60
    maximum_retry_attempts       = 0
  }
}

# Email if the publisher endpoint keeps failing (EventBridge counts failed
# invocations of the target, e.g. 401 after a secret mismatch or 5xx).
resource "aws_cloudwatch_metric_alarm" "scheduled_posts_failing" {
  alarm_name          = "${var.project_name}-scheduled-posts-failing"
  alarm_description   = "EventBridge could not run the scheduled post publisher for 15 minutes. Check /${var.project_name}/web logs for 'scheduled posts'."
  namespace           = "AWS/Events"
  metric_name         = "FailedInvocations"
  dimensions          = { RuleName = aws_cloudwatch_event_rule.scheduled_posts.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 3
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
