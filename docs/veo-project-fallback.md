# Veo billing project fallback

Set `google_cloud_fallback_project` in Terraform to a second Google Cloud project. Give the existing worker Google service account `roles/aiplatform.user` and `roles/serviceusage.serviceUsageConsumer` on that project. It uses the existing AWS workload identity, without a new API key or service-account key.

Only a primary HTTP 403 with canonical `PERMISSION_DENIED` and Google ErrorInfo `BILLING_DISABLED` permits one fallback submission. A successful fallback remains selected for that worker process. Every operation is polled against the project in its saved name, including after a worker restart. Primary operations continue polling on the primary project. Timeouts, lost responses, 5xx, quota, safety and ordinary IAM failures never trigger fallback.

This is billing-failure failover, not a free-credit meter. If the primary is a paid billing account, Google may charge its payment method when promotional credits run out rather than disable billing. In that case there is no rejection to trigger failover. Budget alerts are not hard spending caps. Do not describe this mechanism as guaranteeing no card charges.

## Verification on 2026-11-04

The owner authorized one live test on project `project-ff7636a6-ffa9-431a-8f8`. A single 4-second, silent, 720p Veo 3.1 Fast lake clip succeeded and returned an MP4. The request and operation receipt are kept in the local private task output. It used the new project service account via owner impersonation. This proves live model access, not the final invoice or application-worker identity exchange. The existing production worker identity has been granted access to the new project; the deployed fallback must still be checked after release.

The organization blocks both service-account keys and bound Cloud AI API keys. Those policies remain enforced. No AI Studio prepayment or Google Cloud billing upgrade was performed.
