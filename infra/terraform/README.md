# AWS resources

Terraform for everything ReelWalk uses in the AWS account (734329326838,
`us-east-2`). Applied from a workstation with the `reelwalk` CLI profile;
there is no apply step in CI.

| File | What it creates |
| --- | --- |
| `media.tf` | The media bucket (imported), CORS for presigned browser uploads, SSE-S3, and the CloudFront distribution with origin access control (imported) |
| `queue.tf` | `reelwalk-render-jobs` and its dead-letter queue; 120 s visibility, 3 receives, long polling |
| `ecr.tf` | `reelwalk-web` and `reelwalk-worker` repositories, immutable tags, scan on push, keep 30 images |
| `github_oidc.tf` | OIDC provider for GitHub Actions and the `reelwalk-github-ci` role that only `main` of this repository can assume, limited to pushing those two repositories |
| `app_iam.tf` | The `reelwalk-app` policy (bucket objects, the two queues) and an IAM user that carries it until the workers run on EKS with IRSA |
| `budget.tf` | A monthly cost budget with alerts at 80 % and on the forecast |
| `imports.tf` | Import blocks for the bucket and distribution that existed before Terraform |

| `network.tf` | VPC in two zones with public subnets (no NAT gateway) for the Fargate render tasks |
| `serverless.tf` | App Runner service for the web app, the ECS cluster and worker task definition started on demand, the roles, and the SSM parameters holding credentials (ADR 0015) |

Secrets (`database_url`, `meta_*`, `pixabay_api_key`) and `image_tag` come
from `terraform.tfvars`, which is gitignored.

## State

State is in the bucket `reelwalk-tfstate-734329326838` (versioned, private,
created once by hand) with S3 lock files, so no DynamoDB table is needed.

## Running it

```sh
# ~/.aws/credentials needs a profile with enough rights to manage IAM, S3,
# SQS, ECR, CloudFront and Budgets. The deployer user has AdministratorAccess.
export AWS_PROFILE=reelwalk
echo 'budget_email = "you@example.com"' > terraform.tfvars   # gitignored
terraform init
terraform plan
terraform apply
```

`terraform output` prints the queue URLs, the ECR repository URLs and the CI
role ARN. Two outputs go into GitHub repository variables so that CI pushes
images to ECR:

```sh
gh variable set AWS_ROLE_ARN --body "$(terraform output -raw github_ci_role_arn)"
gh variable set AWS_REGION --body us-east-2
```

## Runtime credentials

The access key for `reelwalk-app` is created by hand so that it never lands in
the state file:

```sh
aws iam create-access-key --user-name reelwalk-app --profile reelwalk
```

Put it in `.env.aws` at the repository root (gitignored) together with the
bucket and queue URLs from `terraform output`, then start the local web app and
worker against AWS with
`docker compose -f docker-compose.yml -f docker-compose.aws.yml --env-file .env.aws up -d web worker`.
On EKS the same policy would be attached to an IRSA role instead and no key
would exist.

## Accepted scanner findings

Trivy flags the missing WAF on the distribution and the lack of a
customer-managed KMS key on the bucket. Both are cost decisions and are
listed with reasons in `.trivyignore.yaml`.
