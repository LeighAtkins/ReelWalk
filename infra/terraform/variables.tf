variable "project_name" {
  type    = string
  default = "reelwalk"
}

variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "media_bucket_name" {
  type    = string
  default = "reelwalk-media-dev"
}

variable "private_subnet_ids" {
  type    = list(string)
  default = []
}

variable "database_password" {
  type      = string
  sensitive = true
  default   = "replace-me-task-01"
}
