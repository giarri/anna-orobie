locals {
  pool_name = "anna_orobie_pool"
}

# --- S3 ---------------------------------------------------------------------

resource "aws_s3_bucket" "climbed" {
  bucket = var.bucket
}

resource "aws_s3_bucket_ownership_controls" "climbed" {
  bucket = aws_s3_bucket.climbed.id

  rule {
    object_ownership = "BucketOwnerPreferred"
  }
}

# The shared object must be publicly readable, so public policies are allowed.
resource "aws_s3_bucket_public_access_block" "climbed" {
  bucket = aws_s3_bucket.climbed.id

  block_public_acls       = false
  ignore_public_acls      = false
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_cors_configuration" "climbed" {
  bucket = aws_s3_bucket.climbed.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT"]
    allowed_origins = var.cors_allowed_origins
  }
}

resource "aws_s3_bucket_policy" "public_read" {
  bucket = aws_s3_bucket.climbed.id

  # Must be applied after the public access block is relaxed.
  depends_on = [aws_s3_bucket_public_access_block.climbed]

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadClimbedStatus"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${aws_s3_bucket.climbed.arn}/${var.key}"
    }]
  })
}

# --- Cognito ----------------------------------------------------------------

resource "aws_cognito_identity_pool" "main" {
  identity_pool_name               = local.pool_name
  allow_unauthenticated_identities = true

  supported_login_providers = {
    "accounts.google.com" = var.google_client_id
  }
}

# --- IAM --------------------------------------------------------------------

data "aws_iam_policy_document" "unauth_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["cognito-identity.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "cognito-identity.amazonaws.com:aud"
      values   = [aws_cognito_identity_pool.main.id]
    }

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "cognito-identity.amazonaws.com:amr"
      values   = ["unauthenticated"]
    }
  }
}

data "aws_iam_policy_document" "auth_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["cognito-identity.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "cognito-identity.amazonaws.com:aud"
      values   = [aws_cognito_identity_pool.main.id]
    }

    condition {
      test     = "ForAnyValue:StringLike"
      variable = "cognito-identity.amazonaws.com:amr"
      values   = ["authenticated"]
    }
  }
}

resource "aws_iam_role" "unauth" {
  name               = "${local.pool_name}_unauth"
  description        = "Unauthenticated Cognito role for anna-orobie climbed-status.json sync"
  assume_role_policy = data.aws_iam_policy_document.unauth_assume.json
}

resource "aws_iam_role" "auth" {
  name               = "${local.pool_name}_auth"
  description        = "Authenticated (Google) Cognito role for anna-orobie climbed-status.json sync"
  assume_role_policy = data.aws_iam_policy_document.auth_assume.json
}

# Guests may overwrite only the shared object.
resource "aws_iam_role_policy" "unauth_put" {
  name = "S3PutClimbedStatus"
  role = aws_iam_role.unauth.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:PutObjectAcl"]
      Resource = "${aws_s3_bucket.climbed.arn}/${var.key}"
    }]
  })
}

# Signed-in users may read/write only their own object. The policy variable is
# substituted by IAM, not Terraform, hence the $${...} escape.
resource "aws_iam_role_policy" "auth_user" {
  name = "S3UserClimbedStatus"
  role = aws_iam_role.auth.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject"]
      Resource = "${aws_s3_bucket.climbed.arn}/users/$${cognito-identity.amazonaws.com:sub}/${var.key}"
    }]
  })
}

resource "aws_cognito_identity_pool_roles_attachment" "main" {
  identity_pool_id = aws_cognito_identity_pool.main.id

  roles = {
    authenticated   = aws_iam_role.auth.arn
    unauthenticated = aws_iam_role.unauth.arn
  }
}
