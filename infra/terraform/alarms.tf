# Email when users are likely seeing failures. Alerts go to budget_email
# through SNS; AWS sends a confirmation link to that address first, and
# nothing is delivered until it is clicked.

resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.budget_email
}

# A render that gave up after its retries, or whose job was lost with its
# worker. The worker logs one of these lines for each.
resource "aws_cloudwatch_log_metric_filter" "render_failures" {
  name           = "${var.project_name}-render-failures"
  log_group_name = aws_cloudwatch_log_group.worker.name
  pattern        = "?\"failed after\" ?\"dead-lettered while still active\""

  metric_transformation {
    name          = "RenderFailures"
    namespace     = "ReelWalk"
    value         = "1"
    default_value = "0"
  }
}

resource "aws_cloudwatch_metric_alarm" "render_failures" {
  alarm_name          = "${var.project_name}-render-failed"
  alarm_description   = "A render failed for good. Worker log group ${aws_cloudwatch_log_group.worker.name} has the error."
  namespace           = "ReelWalk"
  metric_name         = "RenderFailures"
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 1
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}

# Work waiting far longer than any render takes: workers are not starting
# (Fargate quota, a bad image) or are crashing.
resource "aws_cloudwatch_metric_alarm" "render_backlog" {
  alarm_name          = "${var.project_name}-render-backlog"
  alarm_description   = "The oldest render job has waited 45 minutes. Check ECS tasks in cluster ${aws_ecs_cluster.renders.name}."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.render_jobs.name }
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 2700
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}

# Server errors from the web app.
resource "aws_cloudwatch_metric_alarm" "web_5xx" {
  alarm_name          = "${var.project_name}-web-errors"
  alarm_description   = "The web app answered 20 or more requests with a server error in 5 minutes. App Runner application logs have the details."
  namespace           = "AWS/AppRunner"
  metric_name         = "5xxStatusResponses"
  dimensions          = { ServiceName = aws_apprunner_service.web.service_name, ServiceID = aws_apprunner_service.web.service_id }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 20
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
