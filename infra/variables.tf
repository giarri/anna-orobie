variable "region" {
  type    = string
  default = "eu-north-1"
}

variable "bucket" {
  type    = string
  default = "anna-orobie-climbed"
}

variable "key" {
  description = "Shared (guest) object; signed-in users get users/<identity-id>/<key> instead."
  type        = string
  default     = "climbed-status.json"
}

variable "google_client_id" {
  description = "Google OAuth client ID (created by hand in the Google console)."
  type        = string
}

variable "cors_allowed_origins" {
  type = list(string)
  default = [
    "https://giarri.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
  ]
}
