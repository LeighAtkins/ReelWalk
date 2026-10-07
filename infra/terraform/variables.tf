variable "project_name" {
  type    = string
  default = "reelwalk"
}

variable "aws_region" {
  type    = string
  default = "us-east-2"
}

# Created before Terraform existed; imported, not renamed.
variable "media_bucket_name" {
  type    = string
  default = "reelwalk-media-prod-734329326838-us-east-2-an"
}

# Origins allowed to PUT uploads and GET media straight from the bucket with
# presigned URLs. Add the public web origin when there is one.
variable "media_cors_origins" {
  type    = list(string)
  default = ["https://reelwalking.com", "http://localhost:8080", "http://localhost:3000"]
}

variable "app_domain" {
  type    = string
  default = "reelwalking.com"
}

variable "kubernetes_version" {
  type    = string
  default = "1.34"
}

variable "node_instance_type" {
  type    = string
  default = "t3.xlarge"
}

variable "node_count" {
  type    = number
  default = 1
}

variable "db_instance_class" {
  type    = string
  default = "db.t4g.micro"
}

variable "github_repository" {
  type        = string
  description = "owner/name of the GitHub repository whose main branch may push images"
  default     = "LeighAtkins/ReelWalk"
}

# EKS control plane, one node, the load balancer and RDS come to roughly
# $250 a month; the alert sits above that.
variable "budget_monthly_usd" {
  type    = number
  default = 300
}

variable "budget_email" {
  type        = string
  description = "Address that receives budget alerts (set in terraform.tfvars, not committed)"
}

# ── Serverless deployment (ADR 0015) ───────────────────────────────────────

# Image tag in ECR for both images (CI pushes the commit SHA).
variable "image_tag" {
  type = string
}

# App Runner instance: 0.5 vCPU / 1 GB keeps the idle charge near $5 a month.
variable "web_cpu" {
  type    = string
  default = "512"
}

variable "web_memory" {
  type    = string
  default = "1024"
}

# A Fargate render task; billed only while a render runs.
variable "worker_cpu" {
  type    = string
  default = "2048"
}

variable "worker_memory" {
  type    = string
  default = "4096"
}

variable "worker_render_concurrency" {
  type    = number
  default = 2
}

variable "max_workers" {
  type    = number
  default = 2
}

# Credentials, from terraform.tfvars (gitignored). Empty strings become the
# placeholder "unset" in Parameter Store.
variable "database_url" {
  type      = string
  sensitive = true
  default   = ""
}

variable "meta_app_id" {
  type    = string
  default = ""
}

variable "meta_app_secret" {
  type      = string
  sensitive = true
  default   = ""
}

variable "meta_login_config_id" {
  type    = string
  default = ""
}

variable "pixabay_api_key" {
  type      = string
  sensitive = true
  default   = ""
}
