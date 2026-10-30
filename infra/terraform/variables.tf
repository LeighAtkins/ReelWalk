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

# Fargate Spot for render workers (ADR 0094), with on-demand Fargate for what Spot cannot place.
variable "worker_spot" {
  type    = bool
  default = true
}

# Workspaces whose renders go to the local queue and a worker on the owner's
# PC instead of Fargate (ADR 0094). Ours: the @reelwalking studio and Last Mile
# (leigh.atkins1@gmail.com's two). The same list scopes what the PC may write
# (local_worker_iam.tf), so a new studio of ours is added here.
variable "local_render_workspace_ids" {
  type    = list(string)
  default = ["cmuy51nnw000h01adf9ks11xo", "cmvny3ai60000bkuumm4q6nha"]
}

# How long a local render may wait unclaimed (the PC is off) before it moves to Fargate.
variable "local_render_fallback_seconds" {
  type    = number
  default = 600
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
# "vertex" bills the same Claude models through Google Cloud instead (ADR 0072):
# no key, the web app's Google workload identity federation is used.
variable "ai_provider" {
  type    = string
  default = "anthropic"
  validation {
    condition     = contains(["anthropic", "openai", "vertex"], var.ai_provider)
    error_message = "AI provider must be anthropic, openai or vertex."
  }
}

# Where Claude on Vertex is called: "global" (Google's list price) or a region such as us-east5 (listed 10% higher).
variable "vertex_claude_region" {
  type    = string
  default = "global"
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

# The US$ prices for visitors outside Australia (ADR 0085). Empty: everyone sees and pays A$.
variable "stripe_price_agent_monthly_usd" {
  type    = string
  default = ""
}

variable "stripe_price_agent_yearly_usd" {
  type    = string
  default = ""
}

variable "stripe_price_office_monthly_usd" {
  type    = string
  default = ""
}

variable "stripe_price_office_yearly_usd" {
  type    = string
  default = ""
}

# The US$12 AI top-up; empty hides the top-up button for US$ visitors.
variable "stripe_price_ai_top_up_usd" {
  type    = string
  default = ""
}

# Optional: the Stripe product ids of the Agent and Studio plans, so a subscription bought on an
# older (USD) price still resolves to its plan after the prices moved to AUD (ADR 0081).
variable "stripe_product_agent" {
  type    = string
  default = ""
}

variable "stripe_product_office" {
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

# What each sample reel shows, comma separated in the same order ("From 9 phone clips,Cut to the beat"). Optional (ADR 0085).
variable "sample_reel_labels" {
  type    = string
  default = ""
}

# Images of the raw clips each sample was cut from, same order, shown as "Your clips"; an empty entry for none. Optional.
variable "sample_reel_raw_urls" {
  type    = string
  default = ""
}

# How often EventBridge runs the scheduled Instagram post publisher
# (scheduled_posts.tf). Posts go out within one interval of their time.
variable "scheduled_posts_rate" {
  type    = string
  default = "rate(1 minute)"
}

# Voiced AI takes (ADR 0038). Empty keys keep the feature off.
variable "voice_enabled" {
  type    = bool
  default = false
}
# The voice Worker (infra/cloudflare/voice): its workers.dev URL and the VOICE_KEY secret set on it.
variable "voice_tts_url" {
  type    = string
  default = ""
}
variable "voice_tts_key" {
  type      = string
  default   = ""
  sensitive = true
}
variable "sync_api_key" {
  type      = string
  default   = ""
  sensitive = true
}
# "melotts:<lang>", "aura-1:<speaker>" or "aura-2:<speaker>" (e.g. aura-2:theia, Australian); the same voice on every take.
variable "presenter_voice" {
  type    = string
  default = "melotts:en"
}
