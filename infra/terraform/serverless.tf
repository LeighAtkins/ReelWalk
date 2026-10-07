# The cheap deployment (ADR 0015): the web app on App Runner, render workers
# as Fargate tasks started on demand by the web app, settings in SSM. Nothing
# here bills while idle except App Runner's provisioned memory (about $5 a
# month at 1 GB).

locals {
  ecr_web    = aws_ecr_repository.app["web"].repository_url
  ecr_worker = aws_ecr_repository.app["worker"].repository_url

  app_env = {
    AWS_REGION                   = var.aws_region
    S3_REGION                    = var.aws_region
    S3_BUCKET                    = aws_s3_bucket.media.bucket
    S3_FORCE_PATH_STYLE          = "false"
    SQS_QUEUE_URL                = aws_sqs_queue.render_jobs.url
    SQS_DLQ_URL                  = aws_sqs_queue.render_jobs_dlq.url
    CLOUDFRONT_BASE_URL          = "https://${aws_cloudfront_distribution.media.domain_name}"
    APP_URL                      = "https://${var.app_domain}"
    RENDER_MAX_ATTEMPTS          = "3"
    RENDER_VISIBILITY_SECONDS    = "120"
    RENDER_HEARTBEAT_SECONDS     = "20"
    RENDER_STALE_SECONDS         = "60"
    RENDER_RETRY_BACKOFF_SECONDS = "15"
    OUTBOX_POLL_SECONDS          = "5"
  }

  # Parameter Store holds the credentials; both runtimes read them at start.
  app_secrets = {
    DATABASE_URL         = var.database_url
    META_APP_ID          = var.meta_app_id
    META_APP_SECRET      = var.meta_app_secret
    META_LOGIN_CONFIG_ID = var.meta_login_config_id
    PIXABAY_API_KEY      = var.pixabay_api_key
  }
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
    resources = [for p in aws_ssm_parameter.app : p.arn]
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
      environment = [
        for k, v in merge(local.app_env, {
          RENDER_CONCURRENCY       = tostring(var.worker_render_concurrency)
          WORKER_IDLE_EXIT_SECONDS = "240"
        }) : { name = k, value = v }
      ]
      secrets = [for k, p in aws_ssm_parameter.app : { name = k, valueFrom = p.arn } if k == "DATABASE_URL"]
      linuxParameters = {
        # Chrome wants more shared memory than the 64 MB default.
        sharedMemorySize = 512
      }
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
    resources = [for p in aws_ssm_parameter.app : p.arn]
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
        runtime_environment_variables = merge(local.app_env, {
          ECS_CLUSTER                = aws_ecs_cluster.renders.name
          ECS_WORKER_TASK_DEFINITION = aws_ecs_task_definition.worker.arn_without_revision
          ECS_SUBNETS                = join(",", module.vpc.public_subnets)
          ECS_SECURITY_GROUPS        = aws_security_group.worker.id
          ECS_MAX_WORKERS            = tostring(var.max_workers)
        })
        runtime_environment_secrets = { for k, p in aws_ssm_parameter.app : k => p.arn }
      }
    }
  }

  instance_configuration {
    cpu               = var.web_cpu
    memory            = var.web_memory
    instance_role_arn = aws_iam_role.web_instance.arn
  }

  health_check_configuration {
    protocol            = "HTTP"
    path                = "/api/health"
    interval            = 10
    timeout             = 5
    healthy_threshold   = 1
    unhealthy_threshold = 5
  }

  depends_on = [aws_iam_role_policy_attachment.apprunner_ecr]
}

resource "aws_apprunner_custom_domain_association" "web" {
  domain_name          = var.app_domain
  service_arn          = aws_apprunner_service.web.arn
  enable_www_subdomain = true
}
