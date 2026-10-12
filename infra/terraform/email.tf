# Transactional email (ADR 0016): password resets and feedback go out through
# SES as "ReelWalk <hello@reelwalking.com>". The domain identity signs with
# Easy DKIM; the three CNAME records in `ses_dkim_cname_records` go into
# Cloudflare (DNS only, not proxied) and the identity verifies on its own.
#
# A new SES account starts in the sandbox: it may only send to verified
# addresses, 200 a day. Production access is requested once, by hand, and
# cannot be expressed in Terraform:
#   aws sesv2 put-account-details --production-access-enabled \
#     --mail-type TRANSACTIONAL --website-url https://reelwalking.com \
#     --use-case-description "Password resets and feedback receipts for ReelWalk accounts" \
#     --additional-contact-email-addresses hello@reelwalking.com --profile reelwalk
# AWS answers within a day. Until then only hello@reelwalking.com and other
# verified addresses receive mail.

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.app_domain

  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }
}

# Bounces and complaints come back to the sender address; the domain's own
# MX is not involved (no custom MAIL FROM), so nothing else needs DNS.

data "aws_iam_policy_document" "send_email" {
  statement {
    sid       = "SendEmail"
    actions   = ["ses:SendEmail"]
    resources = [aws_sesv2_email_identity.domain.arn]
    condition {
      test     = "StringLike"
      variable = "ses:FromAddress"
      values   = ["*@${var.app_domain}"]
    }
  }
}

# Only the web app sends mail; the render workers have nothing to say.
resource "aws_iam_role_policy" "web_instance_email" {
  name   = "send-email"
  role   = aws_iam_role.web_instance.id
  policy = data.aws_iam_policy_document.send_email.json
}
