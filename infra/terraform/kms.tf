# A customer-managed key for the database backups (a full dump: emails,
# password hashes, session and Instagram tokens) and the alerts topic. About
# $1 a month; the media bucket stays on SSE-S3 (see .trivyignore.yaml).

resource "aws_kms_key" "ops" {
  description             = "${var.project_name} database backups and alert notifications"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy                  = data.aws_iam_policy_document.ops_key.json
}

resource "aws_kms_alias" "ops" {
  name          = "alias/${var.project_name}-ops"
  target_key_id = aws_kms_key.ops.key_id
}

data "aws_iam_policy_document" "ops_key" {
  # IAM policies in this account decide who else may use the key (the
  # worker task role may encrypt backups; see backups.tf).
  statement {
    sid       = "AccountAdministers"
    actions   = ["kms:*"]
    resources = ["*"]
    principals {
      type        = "AWS"
      identifiers = ["arn:aws:iam::${data.aws_caller_identity.current.account_id}:root"]
    }
  }

  # CloudWatch alarms publish to the encrypted alerts topic.
  statement {
    sid       = "CloudWatchAlarmsPublish"
    actions   = ["kms:Decrypt", "kms:GenerateDataKey*"]
    resources = ["*"]
    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }
  }
}
