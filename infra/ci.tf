# GitHub Actions access: remote state + OIDC roles (no long-lived AWS keys).

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  repo       = "giarri/anna-orobie"
  oidc_host  = "token.actions.githubusercontent.com"
}

# --- Remote state -----------------------------------------------------------

resource "aws_s3_bucket" "tfstate" {
  bucket = "anna-orobie-tfstate"

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = true
  restrict_public_buckets = true
}

# --- OIDC provider ----------------------------------------------------------

resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://${local.oidc_host}"
  client_id_list = ["sts.amazonaws.com"]
}

# --- Plan role: pull requests, read-only ------------------------------------

data "aws_iam_policy_document" "plan_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # Fork PRs get no OIDC token, so only branches of this repo can match.
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["repo:${local.repo}:pull_request"]
    }
  }
}

resource "aws_iam_role" "gha_plan" {
  name               = "anna_orobie_gha_plan"
  description        = "GitHub Actions: terraform plan on pull requests (read-only)"
  assume_role_policy = data.aws_iam_policy_document.plan_assume.json
}

resource "aws_iam_role_policy_attachment" "gha_plan_readonly" {
  role       = aws_iam_role.gha_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

# --- Apply role: only the protected `production` environment ----------------

data "aws_iam_policy_document" "apply_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:aud"
      values   = ["sts.amazonaws.com"]
    }

    # The environment is restricted to the main branch (see README).
    condition {
      test     = "StringEquals"
      variable = "${local.oidc_host}:sub"
      values   = ["repo:${local.repo}:environment:production"]
    }
  }
}

resource "aws_iam_role" "gha_apply" {
  name               = "anna_orobie_gha_apply"
  description        = "GitHub Actions: terraform apply for infra/ (main branch, approval required)"
  assume_role_policy = data.aws_iam_policy_document.apply_assume.json
}

# Scoped to this project's resources. It can't modify itself or the plan role
# (IAM writes are limited to the two Cognito roles), so it can't escalate.
data "aws_iam_policy_document" "apply" {
  statement {
    sid       = "AppBuckets"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.climbed.arn, aws_s3_bucket.tfstate.arn]
  }

  statement {
    sid       = "StateObjects"
    actions   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
    resources = ["${aws_s3_bucket.tfstate.arn}/*"]
  }

  statement {
    sid       = "CognitoPool"
    actions   = ["cognito-identity:*"]
    resources = ["arn:aws:cognito-identity:${var.region}:${local.account_id}:identitypool/*"]
  }

  statement {
    sid = "CognitoRoles"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:PassRole",
    ]
    resources = [aws_iam_role.auth.arn, aws_iam_role.unauth.arn]
  }

  statement {
    sid       = "IamRead"
    actions   = ["iam:Get*", "iam:List*", "cognito-identity:Describe*", "cognito-identity:List*", "cognito-identity:Get*"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "gha_apply" {
  name   = "TerraformApplyInfra"
  role   = aws_iam_role.gha_apply.id
  policy = data.aws_iam_policy_document.apply.json
}

output "gha_plan_role_arn" {
  value = aws_iam_role.gha_plan.arn
}

output "gha_apply_role_arn" {
  value = aws_iam_role.gha_apply.arn
}
