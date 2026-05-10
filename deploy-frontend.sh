#!/bin/bash
# deploy-frontend.sh
# Run this from the project root after `sam deploy` completes.
# Usage: ./deploy-frontend.sh

set -e

# ── Read outputs from CloudFormation ───────────────────────────────────────
STACK_NAME="${STACK_NAME:-hiking-dashboard}"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region)}}"
if [ -z "$REGION" ]; then
  echo "Error: no AWS region configured. Set AWS_REGION or run: aws configure set region <region>"
  exit 1
fi

echo "Fetching stack outputs..."
echo "Stack:  $STACK_NAME"
echo "Region: $REGION"

STACK_OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output json 2>/tmp/hiking-dashboard-describe-stack.err) || {
    echo ""
    echo "Error: stack '$STACK_NAME' was not found in region '$REGION'."
    echo ""
    echo "Most likely fixes:"
    echo "  1. Deploy the stack first:"
    echo "     sam build && sam deploy --guided --stack-name $STACK_NAME --region $REGION --capabilities CAPABILITY_IAM"
    echo ""
    echo "  2. Or point this script at the region where you already deployed it:"
    echo "     AWS_REGION=<your-stack-region> ./deploy-frontend.sh"
    echo ""
    echo "  3. Or point this script at a different stack name:"
    echo "     STACK_NAME=<your-stack-name> AWS_REGION=$REGION ./deploy-frontend.sh"
    echo ""
    echo "Stacks visible in $REGION:"
    aws cloudformation list-stacks \
      --region "$REGION" \
      --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE IMPORT_COMPLETE \
      --query "StackSummaries[*].StackName" \
      --output table || true
    echo ""
    echo "Original AWS error:"
    cat /tmp/hiking-dashboard-describe-stack.err
    exit 1
  }

BUCKET=$(printf '%s' "$STACK_OUTPUTS" | node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(0,"utf8")); console.log((o.find(x=>x.OutputKey==="FrontendBucketName")||{}).OutputValue||"")')
CF_ID=$(printf '%s' "$STACK_OUTPUTS" | node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(0,"utf8")); console.log((o.find(x=>x.OutputKey==="CloudFrontId")||{}).OutputValue||"")')
API_URL=$(printf '%s' "$STACK_OUTPUTS" | node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(0,"utf8")); console.log((o.find(x=>x.OutputKey==="StreamUrl")||{}).OutputValue||"")')
CF_URL=$(printf '%s' "$STACK_OUTPUTS" | node -e 'const fs=require("fs"); const o=JSON.parse(fs.readFileSync(0,"utf8")); console.log((o.find(x=>x.OutputKey==="CloudFrontUrl")||{}).OutputValue||"")')

if [ -z "$BUCKET" ] || [ -z "$CF_ID" ] || [ -z "$API_URL" ] || [ -z "$CF_URL" ]; then
  echo "Error: stack '$STACK_NAME' exists, but required outputs are missing."
  echo "Required outputs: FrontendBucketName, CloudFrontId, StreamUrl, CloudFrontUrl"
  echo "Actual outputs:"
  printf '%s\n' "$STACK_OUTPUTS"
  exit 1
fi

echo "  Bucket:     $BUCKET"
echo "  CF ID:      $CF_ID"
echo "  API URL:    $API_URL"
echo "  App URL:    $CF_URL"

# ── Write .env for Vite ─────────────────────────────────────────────────────
echo "Writing frontend/.env..."
echo "VITE_API_URL=$API_URL" > frontend/.env

# ── Build the React app ─────────────────────────────────────────────────────
echo "Installing frontend dependencies..."
cd frontend
npm install

echo "Building React app..."
npm run build
cd ..

# ── Upload to S3 ─────────────────────────────────────────────────────────────
echo "Uploading to S3..."
aws s3 sync frontend/dist/ s3://$BUCKET/ \
  --region $REGION \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "index.html"

# index.html should not be cached aggressively
aws s3 cp frontend/dist/index.html s3://$BUCKET/index.html \
  --region $REGION \
  --cache-control "no-cache, no-store, must-revalidate"

# ── Invalidate CloudFront cache ───────────────────────────────────────────────
echo "Invalidating CloudFront cache..."
aws cloudfront create-invalidation \
  --distribution-id $CF_ID \
  --paths "/*"

echo ""
echo "Done! Your app is live at:"
echo "  $CF_URL"
echo ""
echo "Share this URL with your friends."
