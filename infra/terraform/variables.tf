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

variable "github_repository" {
  type        = string
  description = "owner/name of the GitHub repository whose main branch may push images"
  default     = "LeighAtkins/ReelWalk"
}

# App Runner, on-demand renders and storage come to $10-15 a month (ADR 0015);
# the alert sits above that.
variable "budget_monthly_usd" {
  type    = number
  default = 30
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
  default = "1024"
}

variable "web_memory" {
  type    = string
  default = "2048"
}

# A Fargate render task; billed only while a render runs.
variable "worker_cpu" {
  type    = string
  default = "2048"
}

variable "worker_memory" {
  # 4 GB was killed (OOM) rendering a reel of four phone clips. Fargate bills
  # only while a task runs, so the bigger box costs cents per render.
  type    = string
  default = "8192"
}

variable "worker_render_concurrency" {
  type    = number
  default = 1
}

# Render workers running at once. Each takes worker_cpu (2 vCPU); the
# account's Fargate quota is 12 vCPU, so 6 is the ceiling until it is raised.
variable "max_workers" {
  type    = number
  default = 6
}

# App Runner instances for the web app: one is always up; more are added as
# requests in flight pass web_max_concurrency per instance.
variable "web_max_instances" {
  type    = number
  default = 10
}

# Show "Connect Instagram". While the Meta app is in development mode only
# its testers can connect, so leave this off for a public launch.
variable "instagram_enabled" {
  type    = bool
  default = false
}

variable "web_max_concurrency" {
  type    = number
  default = 60
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

# From the Meta app's "API setup with Instagram login" page (ADR 0026).
variable "instagram_app_id" {
  type    = string
  default = ""
}

variable "instagram_app_secret" {
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

# Direct Anthropic API for editing chat; keep the key in encrypted SSM.
variable "ai_provider" {
  type    = string
  default = "anthropic"
  validation {
    condition     = contains(["anthropic", "openai"], var.ai_provider)
    error_message = "AI provider must be anthropic or openai."
  }
}

variable "anthropic_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

# Use an existing encrypted parameter without putting its value in Terraform inputs.
variable "anthropic_api_key_ssm_arn" {
  type    = string
  default = ""
}

variable "anthropic_model" {
  type    = string
  default = "claude-opus-5-5"
}

# Asking for a change in words (ADR 0020). Empty hides the feature.
variable "openai_api_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "openai_model" {
  type    = string
  default = "gpt-6-luna"
}

# Stripe billing (apps/web/lib/stripe.ts). Empty means no upgrade buttons.
variable "stripe_secret_key" {
  type      = string
  sensitive = true
  default   = ""
}

variable "stripe_webhook_secret" {
  type      = string
  sensitive = true
  default   = ""
}

# Stripe price ids, one per plan and billing interval. The monthly ones turn
# billing on; a missing yearly one hides the yearly option. OFFICE is the
# stored id of the plan shown as "Studio".
variable "google_cloud_project" {
  type    = string
  default = ""
}

variable "google_workload_identity_audience" {
  type    = string
  default = ""
}

variable "google_service_account_email" {
  type    = string
  default = ""
}

variable "ai_video_enabled" {
  type    = bool
  default = false
}

variable "ai_video_budget_cents" {
  description = "Lifetime application ceiling for Vertex video attempts, in USD cents. Raise deliberately after the trial."
  type        = number
  default     = 24000
}

variable "stripe_price_ai_top_up" {
  type    = string
  default = ""
}

variable "stripe_price_agent_monthly" {
  type    = string
  default = ""
}

variable "stripe_price_agent_yearly" {
  type    = string
  default = ""
}

variable "stripe_price_office_monthly" {
  type    = string
  default = ""
}

variable "stripe_price_office_yearly" {
  type    = string
  default = ""
}

# Public https URLs of finished reels shown on the landing page (apps/web/components/landing),
# comma separated, newest first. Empty shows a placeholder frame.
variable "sample_reel_urls" {
  type    = string
  default = ""
}

# Poster images for sample_reel_urls, comma separated in the same order. Optional.
variable "sample_reel_poster_urls" {
  type    = string
  default = ""
}

# How often EventBridge runs the scheduled Instagram post publisher
# (scheduled_posts.tf). Posts go out within one interval of their time.
variable "scheduled_posts_rate" {
  type    = string
  default = "rate(1 minute)"
}

