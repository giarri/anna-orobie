terraform {
  required_version = ">= 1.5"

  backend "s3" {
    bucket       = "anna-orobie-tfstate"
    key          = "infra/terraform.tfstate"
    region       = "eu-north-1"
    use_lockfile = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}
