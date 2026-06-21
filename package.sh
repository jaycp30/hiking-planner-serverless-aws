#!/bin/bash
# package.sh
# Packages the Lambda function and deploys the full CloudFormation stack.
# Run this instead of `sam deploy` if you prefer pure CloudFormation.
#
# Usage: ./package.sh

set -e

STACK_NAME="hiking-dashboard"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region)}}"
if [ -z "$REGION" ]; then
  echo "Error: no AWS region configured. Set AWS_REGION or run: aws configure set region <region>"
  exit 1
fi
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STAGING_BUCKET="hiking-dashboard-lambda-staging-${ACCOUNT_ID}"
LAMBDA_KEY="lambda/hiking-dashboard.zip"

echo "=== Hiking Dashboard — CloudFormation Deploy ==="
echo "Region: $REGION"
echo ""

# ── Prompt for Claude Platform on AWS workspace ID ───────────────────────────
# Trail data comes from Claude Platform on AWS (Claude + native web search).
# Access is granted via the function's IAM role (SigV4), so there is no secret
# key — we only need the workspace ID (looks like wrkspc_...) to route requests.
echo -n "Enter your Claude Platform on AWS workspace ID (wrkspc_...): "
read WORKSPACE_ID
echo ""

if [ -z "$WORKSPACE_ID" ]; then
  echo "Error: workspace ID is required."
  exit 1
fi

# ── Create staging S3 bucket if it doesn't exist ─────────────────────────────
echo "Checking Lambda staging bucket..."
if ! aws s3api head-bucket --bucket "$STAGING_BUCKET" --region "$REGION" 2>/dev/null; then
  echo "Creating staging bucket: $STAGING_BUCKET"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket \
      --bucket "$STAGING_BUCKET" \
      --region "$REGION"
  else
    aws s3api create-bucket \
      --bucket "$STAGING_BUCKET" \
      --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"
  fi

  # Block all public access on the staging bucket
  aws s3api put-public-access-block \
    --bucket "$STAGING_BUCKET" \
    --public-access-block-configuration \
      "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"

  echo "Staging bucket created."
else
  echo "Staging bucket already exists."
fi

# ── Zip the Lambda function ───────────────────────────────────────────────────
echo "Packaging Lambda..."
cd backend
zip -q ../hiking-dashboard-lambda.zip handler.js package.json
cd ..
echo "Lambda packaged: hiking-dashboard-lambda.zip ($(du -sh hiking-dashboard-lambda.zip | cut -f1))"

# ── Upload ZIP to staging bucket ──────────────────────────────────────────────
echo "Uploading Lambda ZIP to S3..."
aws s3 cp hiking-dashboard-lambda.zip \
  "s3://${STAGING_BUCKET}/${LAMBDA_KEY}" \
  --region "$REGION"

# Clean up local ZIP
rm hiking-dashboard-lambda.zip
echo "Lambda uploaded."

# ── Deploy CloudFormation stack ───────────────────────────────────────────────
echo ""
echo "Deploying CloudFormation stack (this takes 5–10 min for CloudFront)..."
echo ""

aws cloudformation deploy \
  --template-file cloudformation.yaml \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    WorkspaceId="$WORKSPACE_ID" \
    LambdaCodeBucket="$STAGING_BUCKET" \
    LambdaCodeKey="$LAMBDA_KEY"

# ── Print outputs ─────────────────────────────────────────────────────────────
echo ""
echo "=== Stack deployed successfully ==="
echo ""

aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" \
  --output table

echo ""
echo "Next: run ./deploy-frontend.sh to build and upload the React app."
