# What the web app and the worker may do at runtime. On EKS this policy
# would be attached to an IRSA role; until then it sits on one IAM user whose
# access key is created by hand, never by Terraform, so it is not written into
# the state file.

data "aws_iam_policy_document" "app" {
  statement {
    sid       = "ListBucket"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.media.arn]
  }

  statement {
    sid = "Objects"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  statement {
    sid = "Queues"
    actions = [
      "sqs:SendMessage",
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
    ]
    resources = [
      aws_sqs_queue.render_jobs.arn,
      aws_sqs_queue.render_jobs_dlq.arn,
    ]
  }
}

resource "aws_iam_policy" "app" {
  name        = "${var.project_name}-app"
  description = "Runtime access for the ReelWalk web app and render workers"
  policy      = data.aws_iam_policy_document.app.json
}

resource "aws_iam_user" "app" {
  name = "${var.project_name}-app"
}

resource "aws_iam_user_policy_attachment" "app" {
  user       = aws_iam_user.app.name
  policy_arn = aws_iam_policy.app.arn
}
