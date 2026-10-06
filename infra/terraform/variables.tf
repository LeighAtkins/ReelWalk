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
  default = ["http://localhost:8080", "http://localhost:3000"]
}

variable "github_repository" {
  type        = string
  description = "owner/name of the GitHub repository whose main branch may push images"
  default     = "LeighAtkins/ReelWalk"
}

variable "budget_monthly_usd" {
  type    = number
  default = 20
}

variable "budget_email" {
  type        = string
  description = "Address that receives budget alerts (set in terraform.tfvars, not committed)"
}
