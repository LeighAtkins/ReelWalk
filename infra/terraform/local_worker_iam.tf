# The render worker on the owner's PC (ADR 0094) runs as its own IAM user, not
# as reelwalk-app. It may use only the local render queue and its dead-letter
# queue, read media, and write the objects a render makes. It cannot touch the
# customers' queue, list the bucket, or delete anything. Its access key is made
# by hand (infra/local-worker/start.sh key), never by Terraform, so it is not
# written into the state file.

data "aws_iam_policy_document" "local_worker" {
  statement {
    sid = "LocalQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:ChangeMessageVisibility",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      # Hands an interrupted job back to its own queue as a fresh message (ADR 0050).
      "sqs:SendMessage",
    ]
    resources = [aws_sqs_queue.render_jobs_local.arn, aws_sqs_queue.render_jobs_local_dlq.arn]
  }

  # A reel may use any library, stock or AI media, so reads span the bucket.
  # That is no wider than the database URL the worker needs anyway.
  statement {
    sid       = "ReadMedia"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.media.arn}/*"]
  }

  # What a render writes: the export with its checks and audio (renders/), a
  # preview and its frame thumbnail (previews/, thumbs/) and the re-encoded
  # source an export reuses (render-sources/). No delete, no list.
  statement {
    sid       = "WriteRenders"
    actions   = ["s3:PutObject", "s3:AbortMultipartUpload"]
    resources = [for prefix in ["renders", "previews", "thumbs", "render-sources"] : "${aws_s3_bucket.media.arn}/${prefix}/*"]
  }
}

resource "aws_iam_policy" "local_worker" {
  name        = "${var.project_name}-local-worker"
  description = "The render worker on the owner's PC: the local render queue and render outputs only (ADR 0094)"
  policy      = data.aws_iam_policy_document.local_worker.json
}

resource "aws_iam_user" "local_worker" {
  name = "${var.project_name}-local-worker"
}

resource "aws_iam_user_policy_attachment" "local_worker" {
  user       = aws_iam_user.local_worker.name
  policy_arn = aws_iam_policy.local_worker.arn
}
