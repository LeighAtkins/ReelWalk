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

# Production access was granted on 2026-10-20 (50,000 a day, 14 a second).
#
# A custom MAIL FROM domain makes the envelope sender ours, so SPF aligns
# with the From domain for DMARC and bounces come back through SES. It needs
# two records in Cloudflare (DNS only):
#   MX  mail.reelwalking.com  10 feedback-smtp.us-east-2.amazonses.com
#   TXT mail.reelwalking.com  "v=spf1 include:amazonses.com ~all"
# Both were added on 2026-10-20; until SES sees the MX it falls back to its
# own domain (USE_DEFAULT_VALUE) rather than refusing to send.
resource "aws_sesv2_email_identity_mail_from_attributes" "domain" {
  email_identity         = aws_sesv2_email_identity.domain.email_identity
  mail_from_domain       = "mail.${var.app_domain}"
  behavior_on_mx_failure = "USE_DEFAULT_VALUE"
}

data "aws_iam_policy_document" "send_email" {
  statement {
    sid     = "SendEmail"
    actions = ["ses:SendEmail"]
    # The domain identity is what we send from. While the account is in the
    # SES sandbox, SES also authorises each recipient address as an identity
    # resource, so the wildcard is needed for any mail to arrive; the
    # FromAddress condition below still pins the sender to our domain.
    resources = [
      aws_sesv2_email_identity.domain.arn,
      "arn:aws:ses:${var.aws_region}:${data.aws_caller_identity.current.account_id}:identity/*",
    ]
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
