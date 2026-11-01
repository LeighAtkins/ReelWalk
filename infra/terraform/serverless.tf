# The cheap deployment (ADR 0015): the web app on App Runner, render workers
# as Fargate tasks started on demand by the web app, settings in SSM. Nothing
# here bills while idle except App Runner's provisioned memory (about $5 a
# month at 1 GB).

locals {
  ecr_web    = aws_ecr_repository.app["web"].repository_url
  ecr_worker = aws_ecr_repository.app["worker"].repository_url

  app_env = {
    AWS_REGION          = var.aws_region
    S3_REGION           = var.aws_region
    S3_BUCKET           = aws_s3_bucket.media.bucket
    S3_FORCE_PATH_STYLE = "false"
    SQS_QUEUE_URL       = aws_sqs_queue.render_jobs.url
    SQS_DLQ_URL         = aws_sqs_queue.render_jobs_dlq.url
    # Our own renders' queue (ADR 0094): the web app routes to it, workers relay its outbox messages to it.
    LOCAL_RENDER_QUEUE_URL = aws_sqs_queue.render_jobs_local.url
    # Whose renders go to it; the PC worker also refuses (hands to the cloud) any other workspace's job.
    LOCAL_RENDER_WORKSPACES      = join(",", var.local_render_workspace_ids)
    CLOUDFRONT_BASE_URL          = "https://${aws_cloudfront_distribution.media.domain_name}"
    APP_URL                      = "https://${var.app_domain}"
    RENDER_MAX_ATTEMPTS          = "3"
    RENDER_VISIBILITY_SECONDS    = "120"
    RENDER_HEARTBEAT_SECONDS     = "20"
    RENDER_STALE_SECONDS         = "60"
    RENDER_RETRY_BACKOFF_SECONDS = "15"
    OUTBOX_POLL_SECONDS          = "5"
    AI_VIDEO_ENABLED             = tostring(var.ai_video_enabled)
    AI_VIDEO_BUDGET_CENTS        = tostring(var.ai_video_budget_cents)
    GOOGLE_CLOUD_PROJECT         = var.google_cloud_project
    GOOGLE_CLOUD_LOCATION        = "us-central1"
    # Voiced AI takes (ADR 0038): a fixed presenter voice behind our Cloudflare Worker, lip-synced by sync.so.
    VOICE_ENABLED   = tostring(var.voice_enabled)
    VOICE_TTS_URL   = var.voice_tts_url
    PRESENTER_VOICE = var.presenter_voice
  }

  # Web-only settings (the worker sends no mail).
  web_env = {
    # Transactional email through SES (email.tf). Unset means log instead of send.
    EMAIL_FROM = "ReelWalk <hello@${var.app_domain}>"
    # The model behind "ask for a change" (ADR 0020).
    AI_PROVIDER     = var.ai_provider
    ANTHROPIC_MODEL = var.anthropic_model
    OPENAI_MODEL    = var.openai_model
    # Claude through Google Cloud (ADR 0072): the web app exchanges its instance-role
    # credentials for a Google token, as the worker does for Veo. Only used with ai_provider = "vertex";
    # the Google pool must admit the web instance role (see the ADR) or the exchange is refused.
    GOOGLE_WORKLOAD_IDENTITY_AUDIENCE = var.google_workload_identity_audience
    GOOGLE_SERVICE_ACCOUNT_EMAIL      = var.google_service_account_email
    VERTEX_CLAUDE_REGION              = var.vertex_claude_region
    # When a local render falls back to Fargate (ADR 0094).
    LOCAL_RENDER_FALLBACK_SECONDS = tostring(var.local_render_fallback_seconds)
    # Lip-synced takes (ADR 0038/0060): the sync.so key lives only on the worker, so the web is told it is there.
    LIPSYNC_ENABLED = tostring(local.lipsync_enabled)
    # Gemini Omni drafts (ADR 0105): on by choice (the worker signs with its Google credentials) or by a key on the worker.
    AI_OMNI_ENABLED = tostring(var.omni_enabled || nonsensitive(var.gemini_api_key != ""))
  }

  # On exactly when the worker can lip-sync (apps/worker/src/voice.ts lipsyncConfigured): voice on, its URL and key,
  # and the sync.so key. Only whether the keys are empty is revealed, never their values.
  lipsync_enabled = var.voice_enabled && var.voice_tts_url != "" && nonsensitive(var.voice_tts_key != "" && var.sync_api_key != "")

  # Parameter Store holds the credentials; both runtimes read them at start.
  app_secrets = merge({
    DATABASE_URL         = var.database_url
    META_APP_ID          = var.meta_app_id
    META_APP_SECRET      = var.meta_app_secret
    META_LOGIN_CONFIG_ID = var.meta_login_config_id
    # Instagram's own login, for keyword comment replies (ADR 0026).
    INSTAGRAM_APP_ID      = var.instagram_app_id
    INSTAGRAM_APP_SECRET  = var.instagram_app_secret
    PIXABAY_API_KEY       = var.pixabay_api_key
    OPENAI_API_KEY        = var.openai_api_key
    VOICE_TTS_KEY         = var.voice_tts_key
    SYNC_API_KEY          = var.sync_api_key
    GEMINI_API_KEY        = var.gemini_api_key
    STRIPE_SECRET_KEY     = var.stripe_secret_key
    STRIPE_WEBHOOK_SECRET = var.stripe_webhook_secret
    # Bearer secret EventBridge sends to /api/scheduled-posts/run (scheduled_posts.tf).
    SCHEDULER_SECRET = random_password.scheduler.result
  }, var.anthropic_api_key_ssm_arn == "" ? { ANTHROPIC_API_KEY = var.anthropic_api_key } : {})
}

resource "aws_ssm_parameter" "app" {
  for_each = local.app_secrets

  name  = "/${var.project_name}/${each.key}"
  type  = "SecureString"
  value = each.value == "" ? "unset" : each.value
}

# ── Render workers on Fargate, started on demand ───────────────────────────

resource "aws_ecs_cluster" "renders" {
  name = "${var.project_name}-renders"
}

# Render workers launch on Fargate Spot, with on-demand Fargate when Spot has
# no capacity (ADR 0094; the web app picks per launch). A reclaimed Spot task
# gets SIGTERM two minutes ahead and hands its job back to the queue.
resource "aws_ecs_cluster_capacity_providers" "renders" {
  cluster_name       = aws_ecs_cluster.renders.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/${var.project_name}/worker"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "web" {
  name              = "/${var.project_name}/web"
  retention_in_days = 14
}

data "aws_iam_policy_document" "ecs_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# Pulls the image, writes logs, reads the parameters: what ECS itself needs to start the task.
resource "aws_iam_role" "task_execution" {
  name               = "${var.project_name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "read_parameters" {
  statement {
    actions   = ["ssm:GetParameters", "ssm:GetParameter"]
    resources = concat([for p in aws_ssm_parameter.app : p.arn], var.anthropic_api_key_ssm_arn == "" ? [] : [var.anthropic_api_key_ssm_arn])
  }
}

resource "aws_iam_role_policy" "task_execution_parameters" {
  name   = "read-parameters"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.read_parameters.json
}

# What the worker code may do: the application policy (bucket objects, queues).
resource "aws_iam_role" "worker_task" {
  name               = "${var.project_name}-worker-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "worker_task" {
  role       = aws_iam_role.worker_task.name
  policy_arn = aws_iam_policy.app.arn
}

resource "aws_security_group" "worker" {
  name        = "${var.project_name}-worker"
  description = "Render worker tasks: outbound only"
  vpc_id      = module.vpc.vpc_id

  egress {
    description = "S3, SQS, ECR, the database and the internet"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.project_name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.worker_cpu
  memory                   = var.worker_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.worker_task.arn

  ephemeral_storage {
    size_in_gib = 30
  }

  container_definitions = jsonencode([
    {
      name      = "worker"
      image     = "${local.ecr_worker}:${var.image_tag}"
      essential = true
      # Fargate Spot warns two minutes before a reclaim (SIGTERM), and 120 s is ECS's longest stop timeout:
      # a render gets 90 s of it to finish before it is stopped and handed back (ADR 0094).
      stopTimeout = 120
      environment = [
        for k, v in merge(local.app_env, {
          RENDER_CONCURRENCY            = tostring(var.worker_render_concurrency)
          RENDER_SHUTDOWN_DRAIN_SECONDS = "90"
          RENDER_STOP_TIMEOUT_SECONDS   = "120"
          # A warm task picks up the next export at once; past 90 s idle it is cheaper to cold-start one (ADR 0094).
          WORKER_IDLE_EXIT_SECONDS = "90"
          # Walk the block's solve (ADR 0093): OpenCV threads, one per vCPU of the task (it also reads the cgroup quota).
          BLOCK_SOLVE_THREADS               = tostring(max(1, floor(tonumber(var.worker_cpu) / 1024)))
          GOOGLE_WORKLOAD_IDENTITY_AUDIENCE = var.google_workload_identity_audience
          GOOGLE_SERVICE_ACCOUNT_EMAIL      = var.google_service_account_email
          # Up to max_workers of these share the database pooler with the web app.
          DATABASE_POOL_MAX = "3"
          # Where the nightly backup task writes (backups.tf).
          BACKUP_BUCKET = aws_s3_bucket.backups.bucket
        }) : { name = k, value = v }
      ]
      secrets = [for k, p in aws_ssm_parameter.app : { name = k, valueFrom = p.arn } if contains(["DATABASE_URL", "VOICE_TTS_KEY", "SYNC_API_KEY", "GEMINI_API_KEY"], k)]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "worker"
        }
      }
    }
  ])
}

# ── The web app on App Runner ──────────────────────────────────────────────

data "aws_iam_policy_document" "apprunner_build_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["build.apprunner.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "apprunner_ecr" {
  name               = "${var.project_name}-apprunner-ecr"
  assume_role_policy = data.aws_iam_policy_document.apprunner_build_trust.json
}

resource "aws_iam_role_policy_attachment" "apprunner_ecr" {
  role       = aws_iam_role.apprunner_ecr.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
}

data "aws_iam_policy_document" "apprunner_tasks_trust" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["tasks.apprunner.amazonaws.com"]
    }
  }
}

# What the web code may do: the application policy, the parameters, and starting worker tasks.
resource "aws_iam_role" "web_instance" {
  name               = "${var.project_name}-web-instance"
  assume_role_policy = data.aws_iam_policy_document.apprunner_tasks_trust.json
}

resource "aws_iam_role_policy_attachment" "web_instance_app" {
  role       = aws_iam_role.web_instance.name
  policy_arn = aws_iam_policy.app.arn
}

data "aws_iam_policy_document" "web_instance" {
  statement {
    sid       = "ReadParameters"
    actions   = ["ssm:GetParameters", "ssm:GetParameter"]
    resources = concat([for p in aws_ssm_parameter.app : p.arn], var.anthropic_api_key_ssm_arn == "" ? [] : [var.anthropic_api_key_ssm_arn])
  }

  statement {
    sid       = "StartWorkers"
    actions   = ["ecs:RunTask"]
    resources = [aws_ecs_task_definition.worker.arn_without_revision, "${aws_ecs_task_definition.worker.arn_without_revision}:*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.renders.arn]
    }
  }

  statement {
    sid       = "ListWorkers"
    actions   = ["ecs:ListTasks"]
    resources = ["*"]
    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.renders.arn]
    }
  }

  statement {
    sid       = "PassWorkerRoles"
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.task_execution.arn, aws_iam_role.worker_task.arn]
  }
}

resource "aws_iam_role_policy" "web_instance" {
  name   = "web"
  role   = aws_iam_role.web_instance.id
  policy = data.aws_iam_policy_document.web_instance.json
}

resource "aws_apprunner_service" "web" {
  service_name = "${var.project_name}-web"

  source_configuration {
    auto_deployments_enabled = false

    authentication_configuration {
      access_role_arn = aws_iam_role.apprunner_ecr.arn
    }

    image_repository {
      image_identifier      = "${local.ecr_web}:${var.image_tag}"
      image_repository_type = "ECR"

      image_configuration {
        port = "3000"
        runtime_environment_variables = merge(local.app_env, local.web_env, {
          # App Runner sets HOSTNAME to the instance name and Next's server binds to it; health checks use localhost.
          HOSTNAME                   = "0.0.0.0"
          ECS_CLUSTER                = aws_ecs_cluster.renders.name
          ECS_WORKER_TASK_DEFINITION = aws_ecs_task_definition.worker.arn_without_revision
          ECS_SUBNETS                = join(",", module.vpc.public_subnets)
          ECS_SECURITY_GROUPS        = aws_security_group.worker.id
          ECS_MAX_WORKERS            = tostring(var.max_workers)
          ECS_SPOT                   = tostring(var.worker_spot)
          # A worker takes one render at a time (apps/worker/src/index.ts). This is not
          # worker_render_concurrency, which is browser tabs inside that one render: reading
          # it here would make the web app start a third as many workers as it should.
          RENDER_JOBS_PER_WORKER = "1"
          # web_max_instances x 5, plus the workers' pools, stays well under the
          # transaction pooler's client limit.
          DATABASE_POOL_MAX = "5"
          # One-tap Instagram posting; off until the Meta app is out of development mode.
          INSTAGRAM_ENABLED           = tostring(var.instagram_enabled)
          STRIPE_PRICE_AGENT_MONTHLY  = var.stripe_price_agent_monthly
          STRIPE_PRICE_AGENT_YEARLY   = var.stripe_price_agent_yearly
          STRIPE_PRICE_OFFICE_MONTHLY = var.stripe_price_office_monthly
          STRIPE_PRICE_OFFICE_YEARLY  = var.stripe_price_office_yearly
          STRIPE_PRICE_AI_TOP_UP      = var.stripe_price_ai_top_up
          STRIPE_PRODUCT_AGENT        = var.stripe_product_agent
          STRIPE_PRODUCT_OFFICE       = var.stripe_product_office
          # US$ prices for visitors outside Australia (ADR 0085).
          STRIPE_PRICE_AGENT_MONTHLY_USD  = var.stripe_price_agent_monthly_usd
          STRIPE_PRICE_AGENT_YEARLY_USD   = var.stripe_price_agent_yearly_usd
          STRIPE_PRICE_OFFICE_MONTHLY_USD = var.stripe_price_office_monthly_usd
          STRIPE_PRICE_OFFICE_YEARLY_USD  = var.stripe_price_office_yearly_usd
          STRIPE_PRICE_AI_TOP_UP_USD      = var.stripe_price_ai_top_up_usd
          # Finished reels the landing page plays; empty shows a placeholder frame.
          SAMPLE_REEL_URL        = var.sample_reel_urls
          SAMPLE_REEL_POSTER_URL = var.sample_reel_poster_urls
          SAMPLE_REEL_LABELS     = var.sample_reel_labels
          SAMPLE_REEL_RAW_URLS   = var.sample_reel_raw_urls
        })
        runtime_environment_secrets = merge({ for k, p in aws_ssm_parameter.app : k => p.arn }, var.anthropic_api_key_ssm_arn == "" ? {} : { ANTHROPIC_API_KEY = var.anthropic_api_key_ssm_arn })
      }
    }
  }

  instance_configuration {
    cpu               = var.web_cpu
    memory            = var.web_memory
    instance_role_arn = aws_iam_role.web_instance.arn
  }

  auto_scaling_configuration_arn = aws_apprunner_auto_scaling_configuration_version.web.arn

  # /api/ready touches the database on every check, which also keeps a free
  # Supabase project from being paused for inactivity.
  health_check_configuration {
    protocol            = "HTTP"
    path                = "/api/ready"
    interval            = 20
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  depends_on = [aws_iam_role_policy_attachment.apprunner_ecr]
}

# One instance is always warm; App Runner adds instances as concurrent
# requests pass web_max_concurrency each, up to web_max_instances.
resource "aws_apprunner_auto_scaling_configuration_version" "web" {
  auto_scaling_configuration_name = "${var.project_name}-web"
  min_size                        = 1
  max_size                        = var.web_max_instances
  max_concurrency                 = var.web_max_concurrency
}

resource "aws_apprunner_custom_domain_association" "web" {
  domain_name          = var.app_domain
  service_arn          = aws_apprunner_service.web.arn
  enable_www_subdomain = true
}
