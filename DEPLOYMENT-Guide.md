# Japan Hiking Dashboard — Deployment Guide

Region: ap-northeast-1 (Tokyo)
Estimated infra cost: ~$0/month (within AWS free tier for personal use)
Anthropic API: prepaid credits, charged per search (~$0.01–0.05 per search)

---

## Prerequisites

Make sure you have these installed and configured:

```bash
# Check versions
node --version       # need 20+
aws --version        # need 2.x
sam --version        # need 1.x

# Configure AWS credentials if you haven't already
aws configure
# Enter your AWS Access Key ID, Secret, region: ap-northeast-1, output: json
```

You also need:
- An AWS account
- An Anthropic API key from https://console.anthropic.com
  (separate from Claude Pro — create an account, buy prepaid credits)

---

## Step 1 — Get the code

Your project folder should look like this:

```
hiking-app/
├── template.yaml
├── deploy-frontend.sh
├── backend/
│   ├── handler.js
│   └── package.json
└── frontend/
    ├── index.html
    ├── package.json
    ├── vite.config.js
    └── src/
        ├── main.jsx
        └── App.jsx
```

---

## Step 2 — Deploy the backend

You have two options. Pick one — both produce the exact same AWS infrastructure.

### Option A: SAM CLI (simpler, recommended)

SAM handles packaging and uploading the Lambda code automatically.

```bash
sam build
sam deploy --guided \
  --stack-name hiking-dashboard \
  --region ap-northeast-1 \
  --capabilities CAPABILITY_IAM
```

When prompted:
- **Stack Name**: `hiking-dashboard`
- **AWS Region**: `ap-northeast-1`
- **AnthropicApiKey**: paste your key (input is hidden)
- **Confirm changes before deploy**: `y`
- **Allow SAM CLI IAM role creation**: `y`
- **Save arguments to configuration file**: `y`

### Option B: Pure CloudFormation (no SAM CLI needed)

Use this if you don't want to install SAM CLI, or if you prefer deploying
from the AWS Console. The `package.sh` script handles zipping the Lambda
and uploading it to a staging S3 bucket before running `aws cloudformation deploy`.

```bash
chmod +x package.sh
./package.sh
```

The script will prompt you for your Anthropic API key and handle everything else.

---

Both options output the same values at the end:

```
ApiUrl          https://abc123.execute-api.ap-northeast-1.amazonaws.com
CloudFrontUrl   https://xyz.cloudfront.net
FrontendBucket  hiking-dashboard-frontend-123456789
CloudFrontId    ABCDEFGHIJKLMN
```

---

## Step 2b — Deploy the backend (original SAM section, for reference)

From the project root:

```bash
# Build the SAM app
sam build

# Deploy — this will prompt you for the Anthropic API key
sam deploy --guided \
  --stack-name hiking-dashboard \
  --region ap-northeast-1 \
  --capabilities CAPABILITY_IAM
```

When prompted:
- **Stack Name**: `hiking-dashboard`
- **AWS Region**: `ap-northeast-1`
- **AnthropicApiKey**: paste your key (input is hidden)
- **Confirm changes before deploy**: `y`
- **Allow SAM CLI IAM role creation**: `y`
- **Save arguments to configuration file**: `y` (saves to samconfig.toml for future deploys)

This takes 3–5 minutes. CloudFront distribution creation is the slow part.

At the end you'll see outputs like:
```
Key   ApiUrl
Value https://abc123.execute-api.ap-northeast-1.amazonaws.com

Key   CloudFrontUrl
Value https://xyz.cloudfront.net

Key   FrontendBucketName
Value hiking-dashboard-frontend-123456789

Key   CloudFrontId
Value ABCDEFGHIJKLMN
```

---

## Step 3 — Deploy the frontend

Make the deploy script executable, then run it:

```bash
chmod +x deploy-frontend.sh
./deploy-frontend.sh
```

This script automatically:
1. Reads the API URL and bucket name from your CloudFormation stack
2. Writes `frontend/.env` with `VITE_API_URL`
3. Runs `npm install` and `npm run build`
4. Uploads the built files to S3
5. Invalidates the CloudFront cache

At the end it prints your app URL. That's what you share with friends.

---

## Step 4 — Test it

Open the CloudFront URL in your browser. Try searching for "Nikko" or "Hakone".

The first search after a fresh deploy may be slow (Lambda cold start + web search).
Subsequent searches are faster.

---

## Updating the app

If you change `App.jsx` or any frontend code:

```bash
./deploy-frontend.sh
```

If you change `backend/handler.js` or `template.yaml`:

```bash
sam build && sam deploy
```

---

## Tearing it down

If you ever want to remove everything:

```bash
# Empty the S3 bucket first (CloudFormation can't delete non-empty buckets)
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name hiking-dashboard \
  --region ap-northeast-1 \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
  --output text)

aws s3 rm s3://$BUCKET --recursive

# Delete the stack
sam delete --stack-name hiking-dashboard --region ap-northeast-1
```

---

## Cost breakdown

| Service | Free tier | Expected monthly |
|---|---|---|
| Lambda | 1M requests, 400K GB-sec | $0 |
| API Gateway (HTTP) | 1M requests | $0 |
| S3 | 5GB, 20K GET requests | $0 |
| CloudFront | 1TB transfer, 10M requests | $0 |
| Anthropic API | — | $0.01–0.05 per search |

For personal + friends use, you'll likely stay within free tier on AWS indefinitely.
The only real cost is Anthropic API credits — budget $5–10 to start.

---

## Troubleshooting

**"No trails found" on every search**
The web_search call might be failing. Check Lambda logs:
```bash
sam logs -n SearchFunction --stack-name hiking-dashboard --region ap-northeast-1 --tail
```

**CORS errors in browser**
The HTTP API has CORS configured to allow all origins. If you're still seeing CORS errors,
check that the API URL in frontend/.env doesn't have a trailing slash.

**CloudFront returning old version**
Wait 2–3 minutes after running deploy-frontend.sh for the invalidation to propagate,
or force-refresh your browser with Cmd+Shift+R (Mac) / Ctrl+Shift+R (Windows).

**Lambda timeout**
web_search can occasionally be slow. The Lambda timeout is set to 60 seconds in template.yaml.
If searches consistently time out, raise it to 90.
