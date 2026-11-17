# Adopt the resources originally created by hand (see README). After the first
# successful apply these blocks are no-ops and can be deleted.

import {
  to = aws_s3_bucket.climbed
  id = "anna-orobie-climbed"
}

import {
  to = aws_s3_bucket_ownership_controls.climbed
  id = "anna-orobie-climbed"
}

import {
  to = aws_s3_bucket_public_access_block.climbed
  id = "anna-orobie-climbed"
}

import {
  to = aws_s3_bucket_cors_configuration.climbed
  id = "anna-orobie-climbed"
}

import {
  to = aws_s3_bucket_policy.public_read
  id = "anna-orobie-climbed"
}

import {
  to = aws_cognito_identity_pool.main
  id = "eu-north-1:648fcbcb-f86d-4049-a33f-6e33189112c3"
}

import {
  to = aws_cognito_identity_pool_roles_attachment.main
  id = "eu-north-1:648fcbcb-f86d-4049-a33f-6e33189112c3"
}

import {
  to = aws_iam_role.unauth
  id = "anna_orobie_pool_unauth"
}

import {
  to = aws_iam_role.auth
  id = "anna_orobie_pool_auth"
}

import {
  to = aws_iam_role_policy.unauth_put
  id = "anna_orobie_pool_unauth:S3PutClimbedStatus"
}

import {
  to = aws_iam_role_policy.auth_user
  id = "anna_orobie_pool_auth:S3UserClimbedStatus"
}
