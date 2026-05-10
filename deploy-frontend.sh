#!/bin/bash
# deploy-frontend.sh
# Run this from the project root after `sam deploy` completes.
# Usage: ./deploy-frontend.sh

set -e

# ── Read outputs from CloudFormation ───────────────────────────────────────
STACK_NAME="hiking-dashboard"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region)}}"
if [ -z "$REGION" ]; then
  echo "Error: no AWS region configured. Set AWS_REGION or run: aws configure set region <region>"
  exit 1
fi

echo "Fetching stack outputs..."
echo "Region: $REGION"

BUCKET=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
  --output text)

CF_ID=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontId'].OutputValue" \
  --output text)

API_URL=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='StreamUrl'].OutputValue" \
  --output text)

CF_URL=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontUrl'].OutputValue" \
  --output text)

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
