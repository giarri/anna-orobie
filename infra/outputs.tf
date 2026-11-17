# Values that go into aws-config.js.
output "aws_config" {
  value = {
    region         = var.region
    identityPoolId = aws_cognito_identity_pool.main.id
    bucket         = aws_s3_bucket.climbed.bucket
    key            = var.key
    googleClientId = var.google_client_id
  }
}
