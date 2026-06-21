# Hiking Dashboard — Detailed SAM CLI Deployment Procedure

This guide deploys the Hiking Dashboard as a serverless AWS web app using AWS SAM CLI.

The project has two deployment phases:

1. `sam build` and `sam deploy` create/update the AWS infrastructure from `template.yaml`.
2. `deploy-frontend.sh` builds the Vite/React frontend and uploads the static files to the S3 bucket created by the SAM stack.

SAM owns the backend/infrastructure lifecycle. The shell script owns the static frontend artifact lifecycle.

## Architecture

```text
Browser
  |
  v
CloudFront
  - public HTTPS app URL
  - SPA fallback to /index.html for 403/404
  - reads private S3 bucket through Origin Access Control
  |
  v
S3 frontend bucket
  - stores Vite build output from frontend/dist/
  - private bucket, not public website hosting

Browser search request
  |
  v
Lambda Function URL
  - response streaming endpoint
  - used by frontend as VITE_API_URL
  - returns Server-Sent Events
  |
  v
Lambda SearchFunction
  - Node.js 22
  - handler: backend/handler.js
  - 512 MB memory
  - 90 second timeout by default
  |
  +--> Claude Platform on AWS  (Anthropic-operated)
  |    - Claude Haiku 4.5 / Claude Sonnet 4.6
  |    - native web_search tool (runs server-side)
  |    - SigV4 auth via the Lambda execution role (no API key)
  |
  +--> DynamoDB TrailImagesTable
       - search + trail image cache
       - TTL enabled

API Gateway HTTP API
  - also exposes POST /search
  - useful as a normal HTTP endpoint
  - frontend currently uses StreamUrl instead
```

The key detail is that the frontend uses the `StreamUrl` output, not the `ApiUrl` output. `StreamUrl` is the Lambda Function URL with response streaming enabled. That is why the UI can receive progress and batches as Server-Sent Events.

## Files Involved

Core deployment files:

```text
template.yaml
deploy-frontend.sh
samconfig.toml
backend/handler.js
backend/package.json
frontend/package.json
frontend/package-lock.json
frontend/public/hero.png
frontend/src/App.jsx
frontend/vite.config.js
```

Generated files/directories:

```text
.aws-sam/
frontend/dist/
frontend/node_modules/
frontend/.env
```

Do not commit generated dependency/build artifacts:

```text
.aws-sam/
frontend/node_modules/
frontend/dist/
frontend/.env
```

Commit `frontend/public/hero.png`. The banner references `/hero.png`, and Vite copies `frontend/public/hero.png` into the final build.

## What `template.yaml` Deploys

`template.yaml` is a SAM template because it includes:

```yaml
Transform: AWS::Serverless-2016-10-31
```

That transform lets the template use `AWS::Serverless::*` shorthand. SAM expands the shorthand into normal CloudFormation resources before deployment.

The stack provisions:

- `AWS::Serverless::HttpApi` for API Gateway v2 HTTP API
- `AWS::Serverless::Function` for the Lambda search backend
- Lambda Function URL with `InvokeMode: RESPONSE_STREAM`
- DynamoDB table for trail image caching
- S3 bucket for static frontend files
- S3 bucket policy allowing CloudFront access only
- CloudFront Origin Access Control
- CloudFront distribution
- CloudFormation outputs used by `deploy-frontend.sh`

Important outputs:

| Output | Meaning |
|---|---|
| `ApiUrl` | API Gateway endpoint |
| `StreamUrl` | Lambda Function URL used by the frontend |
| `CloudFrontUrl` | Public web app URL |
| `FrontendBucketName` | S3 bucket where `frontend/dist/` is uploaded |
| `CloudFrontId` | Distribution ID used for invalidation |

## Region Strategy

The template is region-aware. It uses `${AWS::Region}` for regional naming and endpoint construction.

Set the region explicitly before deployment:

```bash
export AWS_REGION=eu-west-2
```

Replace `eu-west-2` with the region you want.

Use the same region for:

- `sam build`
- `sam deploy`
- `deploy-frontend.sh`
- `sam logs`
- `sam delete`
- CloudFormation output lookup commands

Check your current AWS CLI default region:

```bash
aws configure get region
```

Check the local SAM config:

```bash
cat samconfig.toml
```

If `samconfig.toml` contains an old region, pass `--region "$AWS_REGION"` explicitly when deploying. That avoids accidentally deploying to the wrong region.

## Prerequisites

Check local tools:

```bash
node --version
aws --version
sam --version
```

Expected:

- Node.js 20 or newer locally
- AWS CLI v2
- SAM CLI v1
- AWS credentials configured
- A Claude Platform on AWS subscription (AWS Marketplace) with a workspace provisioned in your region
- The workspace ID (`wrkspc_...`) — there is no API key; the Lambda authenticates with its IAM role via SigV4

The Lambda runtime in the template is `nodejs22.x`. Your local Node.js version does not need to be exactly 22, but Node.js 20+ is a good baseline for this project.

Install SAM CLI if needed:

```bash
brew install aws-sam-cli
```

Or follow your preferred SAM CLI installation method.

Configure AWS credentials if you have not already:

```bash
aws configure
```

Confirm the account:

```bash
aws sts get-caller-identity
```

## Auth Notes (no API keys)

This app runs on **Claude Platform on AWS**, which authenticates with **AWS IAM via SigV4** — there is no API key to store. The only deploy input is the workspace ID:

Required:

- `WorkspaceId` (looks like `wrkspc_...`) — not a secret; it routes requests to your Claude workspace.

The Lambda's execution role signs every request. Least-privilege actions on that role (defined in `template.yaml`):

- `aws-external-anthropic:CreateInference` — scoped to the workspace ARN
- `sts:GetWebIdentityToken` + `sts:TagGetWebIdentityToken` — on `arn:aws:sts::{account}:self` (the SDK exchanges the role's credentials for a short-lived workload-identity token before calling Claude)
- DynamoDB CRUD — on the cache table only

Because there is no key, there is nothing to rotate or leak. Billing is post-paid on your AWS Marketplace invoice.

## Step 1 — Choose Region and Stack Name

From the project root:

```bash
export AWS_REGION=eu-west-2
export STACK_NAME=hiking-dashboard
```

Confirm:

```bash
echo "$AWS_REGION"
echo "$STACK_NAME"
```

You can use a different stack name, but `deploy-frontend.sh` currently expects:

```bash
STACK_NAME="hiking-dashboard"
```

If you change the stack name, update `deploy-frontend.sh` too.

## Step 2 — Validate the SAM Template

Run basic validation:

```bash
sam validate --template-file template.yaml
```

Run lint validation:

```bash
sam validate --lint --template-file template.yaml
```

Expected:

```text
template.yaml is a valid SAM Template
```

## Step 3 — Build the SAM Application

Run:

```bash
sam build
```

What this does:

- Reads `template.yaml`
- Finds Lambda code in `backend/`
- Reads `backend/package.json`
- Installs backend dependencies
- Packages Lambda artifacts under `.aws-sam/build/`
- Generates `.aws-sam/build/template.yaml`

The backend currently depends on:

```text
@anthropic-ai/aws-sdk      (Claude Platform on AWS client)
@aws-sdk/client-dynamodb
@aws-sdk/lib-dynamodb
```

Native `fetch` is available in modern Node.js (used for Wikimedia photo lookups), so no fetch package is needed.

Expected:

```text
Build Succeeded
```

## Step 4 — First-Time SAM Deploy

Use guided deploy the first time:

```bash
sam deploy --guided \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM
```

Recommended answers:

| Prompt | Recommended answer |
|---|---|
| Stack Name | `hiking-dashboard` |
| AWS Region | Your selected region, for example `eu-west-2` |
| Parameter `WorkspaceId` | Paste your Claude Platform on AWS workspace ID (`wrkspc_...`) |
| Parameter `HaikuModelId` | Leave default `claude-haiku-4-5` |
| Parameter `SonnetModelId` | Leave default `claude-sonnet-4-6` |
| Confirm changes before deploy | `Y` |
| Allow SAM CLI IAM role creation | `Y` |
| Disable rollback | `N` |
| Save arguments to configuration file | `Y` |
| SAM configuration file | `samconfig.toml` |
| SAM configuration environment | `default` |

Why `CAPABILITY_IAM` is needed:

SAM/CloudFormation creates IAM permissions for the Lambda function. CloudFormation requires explicit acknowledgement before creating or modifying IAM resources.

What happens behind the scenes:

1. SAM creates or reuses a managed staging S3 bucket named like `aws-sam-cli-managed-default-samclisourcebucket-...`.
2. SAM uploads the packaged Lambda ZIP to the staging bucket.
3. SAM uploads the transformed template.
4. CloudFormation creates a changeset.
5. SAM shows you the changeset.
6. You confirm the changeset.
7. CloudFormation creates resources in dependency order.
8. SAM prints stack outputs.

CloudFront is usually the slowest part. First deploy can take several minutes because CloudFront provisions a global distribution.

## Step 5 — Review Stack Outputs

SAM prints outputs after deploy. You can also query them:

```bash
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[*].[OutputKey,OutputValue]" \
  --output table
```

Expected output keys:

```text
ApiUrl
StreamUrl
CloudFrontUrl
FrontendBucketName
CloudFrontId
```

Example shape:

```text
ApiUrl             https://abc123.execute-api.eu-west-2.amazonaws.com
StreamUrl          https://xxxxxxxxxxxxxxxx.lambda-url.eu-west-2.on.aws/
CloudFrontUrl      https://dxxxxxxxxxxxxx.cloudfront.net
FrontendBucketName hiking-dashboard-frontend-123456789012-eu-west-2
CloudFrontId       E1234567890ABC
```

You do not need to copy these manually for frontend deployment. `deploy-frontend.sh` reads them from CloudFormation.

## Step 6 — Deploy the Frontend

Run:

```bash
chmod +x deploy-frontend.sh
AWS_REGION="$AWS_REGION" ./deploy-frontend.sh
```

The script:

1. Reads `FrontendBucketName`, `CloudFrontId`, `StreamUrl`, and `CloudFrontUrl` from the stack outputs.
2. Writes `frontend/.env`.
3. Runs `npm install` in `frontend/`.
4. Runs `npm run build`.
5. Uploads static assets to S3.
6. Uploads `index.html` separately with no-cache headers.
7. Creates a CloudFront invalidation for `/*`.

The generated `frontend/.env` looks like:

```text
VITE_API_URL=https://xxxxxxxxxxxxxxxx.lambda-url.eu-west-2.on.aws/
```

The frontend reads this value in `frontend/src/App.jsx`:

```jsx
const API_URL = import.meta.env.VITE_API_URL;
```

## Frontend Cache-Control Behavior

`deploy-frontend.sh` intentionally handles caching in two passes.

Static assets:

```bash
aws s3 sync frontend/dist/ s3://$BUCKET/ \
  --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude "index.html"
```

`index.html`:

```bash
aws s3 cp frontend/dist/index.html s3://$BUCKET/index.html \
  --cache-control "no-cache, no-store, must-revalidate"
```

Why:

- Vite fingerprints JS/CSS filenames, for example `index-xHv5YyAB.js`.
- Fingerprinted assets are safe to cache for a long time.
- `index.html` must stay fresh because it points to the current fingerprinted asset names.
- CloudFront invalidation makes the new version visible quickly.

## Step 7 — Open and Test the App

Open the `CloudFrontUrl` printed by the script.

Test trail-area examples:

```text
Kinabalu Park
Kamikochi
Banff
Chichibu
```

Test starting point examples:

```text
London
Edmonton
Rifugio Auronzo
Shinjuku Station, Tokyo
```

Test model paths (both run on Claude Platform on AWS — no per-model keys):

- Claude Haiku 4.5 — fast/cheap default
- Claude Sonnet 4.6 — higher quality, costs more per search

Both authenticate via the Lambda execution role. If a search fails with a permission error, check the role's IAM policy (see Auth Notes), not an API key.

Test the progressive result behavior:

1. Run a normal search.
2. Confirm the first response targets 10 trails.
3. Click `Load more trails`.
4. Confirm the app requests up to 20 trails.
5. Repeat the same search and confirm cached results return faster.

The app intentionally searches for 10 trails first to reduce token pressure and improve perceived speed. `Load more trails` asks the backend for a larger 20-trail result set.

## Step 8 — Subsequent Deployments

### Frontend-only change

Examples:

- `frontend/src/App.jsx`
- `frontend/public/hero.png`
- UI copy
- CSS/styling
- Vite config that changes frontend output

Deploy:

```bash
AWS_REGION="$AWS_REGION" ./deploy-frontend.sh
```

No SAM deploy is required for frontend-only changes.

### Backend-only change

Examples:

- `backend/handler.js`
- `backend/package.json`
- Lambda logic
- API provider/model changes

Deploy:

```bash
sam build
sam deploy --region "$AWS_REGION"
```

If `sam build` fails with an npm cache permission error under `~/.npm`, use a temporary npm cache:

```bash
env npm_config_cache=/private/tmp/hiking-app-npm-cache sam build
sam deploy --region "$AWS_REGION"
```

If the frontend URL output did not change, you do not strictly need to redeploy the frontend. Running `deploy-frontend.sh` anyway is harmless and refreshes `frontend/.env`.

### Infrastructure change

Examples:

- `template.yaml`
- Lambda runtime
- Lambda timeout/memory
- DynamoDB table changes
- CloudFront/S3 policy changes

Deploy:

```bash
env npm_config_cache=/private/tmp/hiking-app-npm-cache sam build
sam deploy --region "$AWS_REGION"
AWS_REGION="$AWS_REGION" ./deploy-frontend.sh
```

Run the frontend deploy after infrastructure changes because outputs may change.

## Step 9 — Debugging and Logs

Tail Lambda logs:

```bash
sam logs \
  -n SearchFunction \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --tail
```

Use logs for:

- Search failures
- Empty responses
- Provider API errors
- Lambda timeout
- DynamoDB read/write errors
- Model configuration errors

Look for Lambda execution report lines containing:

```text
Duration
Billed Duration
Memory Size
Max Memory Used
Status: timeout
```

Common log clues:

| Log symptom | Meaning | Likely fix |
|---|---|---|
| `Status: timeout` and duration near 90000 ms | Lambda hit the 90s timeout | Increase `Timeout` to 120 |
| Rate limit error | Too many token-heavy searches in a short window | Wait a few minutes; reduce repeated testing |
| `403 ... CreateInference` or `sts:*GetWebIdentityToken` not authorized | Lambda role missing a Claude-on-AWS or STS action | Add the action to the role (see Auth Notes), redeploy |
| `404 model: ...` | Stale/invalid model ID | Use bare IDs (`claude-haiku-4-5`); CloudFormation keeps previous param values, so pass them explicitly |
| `400 ... programmatic tool calling` | web_search default path unsupported on Haiku | Set `allowed_callers: ["direct"]` on the web_search tool |
| DynamoDB write failed | Cache write issue | Check Lambda role/table permissions |

## Local Invocation

You can invoke the Lambda locally:

```bash
sam local invoke SearchFunction \
  --event events/search.json
```

Create `events/search.json` if you want a reusable local event:

```json
{
  "body": "{\"location\":\"Nikko\",\"model\":\"haiku\"}",
  "requestContext": {
    "http": {
      "method": "POST"
    }
  }
}
```

Local invocation caveats:

- Local invocation needs `ANTHROPIC_AWS_WORKSPACE_ID` plus AWS credentials in your shell (SigV4). For local-only testing without AWS creds, a long-term API key from the Claude Platform on AWS console works (the role would also need `aws-external-anthropic:CallWithBearerToken`).
- It will not automatically use your deployed DynamoDB table unless credentials and table name are configured.
- Response streaming behavior may differ locally from real Lambda Function URLs.
- Real end-to-end testing should still be done through the deployed CloudFront URL.

Example env vars file:

```json
{
  "SearchFunction": {
    "ANTHROPIC_AWS_WORKSPACE_ID": "wrkspc_your_workspace_id",
    "HAIKU_MODEL_ID": "claude-haiku-4-5",
    "SONNET_MODEL_ID": "claude-sonnet-4-6",
    "TABLE_NAME": "hiking-trail-images"
  }
}
```

Invoke with:

```bash
sam local invoke SearchFunction \
  --event events/search.json \
  --env-vars env.local.json
```

Do not commit `env.local.json`.

## Updating Lambda Timeout

The template currently sets:

```yaml
Globals:
  Function:
    Runtime: nodejs22.x
    Timeout: 90
    MemorySize: 512
```

If web search regularly times out, raise timeout:

```yaml
Timeout: 120
```

Then deploy:

```bash
sam build
sam deploy --region "$AWS_REGION"
```

Important nuance:

- API Gateway v2 has a much shorter synchronous integration ceiling.
- This app’s frontend uses Lambda Function URL response streaming, not API Gateway, for search requests.
- Streaming lets the app send progress/batch events instead of waiting for one full response.

## Verifying AWS Resources

Check the stack status:

```bash
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].[StackStatus,CreationTime,LastUpdatedTime]"
```

Check outputs:

```bash
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs"
```

Check Lambda runtime:

```bash
aws lambda get-function \
  --function-name hiking-dashboard-search \
  --region "$AWS_REGION" \
  --query "Configuration.[FunctionName,Runtime,Timeout,MemorySize]"
```

Check frontend bucket contents:

```bash
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
  --output text)

aws s3 ls "s3://$BUCKET/" --region "$AWS_REGION"
```

Check CloudFront invalidations:

```bash
CF_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontId'].OutputValue" \
  --output text)

aws cloudfront list-invalidations \
  --distribution-id "$CF_ID"
```

## Troubleshooting

### `sam deploy` says IAM capabilities are required

Run:

```bash
sam deploy \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM
```

### `deploy-frontend.sh` cannot find the stack

Check the region and stack:

```bash
echo "$AWS_REGION"
aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION"
```

If the stack exists in a different region, export that region and rerun:

```bash
export AWS_REGION=the-correct-region
AWS_REGION="$AWS_REGION" ./deploy-frontend.sh
```

### The browser still shows the old frontend

Wait a few minutes for CloudFront invalidation to propagate.

Then hard refresh:

- macOS: `Cmd+Shift+R`
- Windows/Linux: `Ctrl+Shift+R`

Check invalidation status:

```bash
aws cloudfront list-invalidations \
  --distribution-id "$CF_ID"
```

### Search returns no results or an error

Tail logs:

```bash
sam logs \
  -n SearchFunction \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --tail
```

Then test:

- Is `WorkspaceId` set, and does the Lambda role allow `aws-external-anthropic:CreateInference` plus the `sts:*GetWebIdentityToken` actions?
- Are the model IDs the bare values (`claude-haiku-4-5` / `claude-sonnet-4-6`)?
- Did the provider return a rate-limit error?
- Did Lambda timeout?
- Did the frontend get the correct `VITE_API_URL` from `frontend/.env` before build?

### `VITE_API_URL` is wrong

Re-run frontend deploy:

```bash
AWS_REGION="$AWS_REGION" ./deploy-frontend.sh
```

Inspect:

```bash
cat frontend/.env
```

It should contain the `StreamUrl`, not `ApiUrl`.

### `samconfig.toml` keeps deploying to the wrong region

Either edit `samconfig.toml` or override it:

```bash
sam deploy --region "$AWS_REGION"
```

For a clean guided reconfiguration:

```bash
sam deploy --guided \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --capabilities CAPABILITY_IAM
```

### CloudFormation stack update fails

Check events:

```bash
aws cloudformation describe-stack-events \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --max-items 20
```

Common causes:

- S3 bucket naming conflict
- S3 bucket replacement while the old bucket still has frontend files
- IAM permission denied
- CloudFront distribution update still in progress
- Region mismatch
- Parameter value missing

### Stack update gets stuck deleting an old frontend bucket

This can happen when a template change replaces the S3 frontend bucket. CloudFormation creates the new bucket, updates CloudFront, then tries to delete the old bucket. S3 refuses deletion if the old bucket still contains files.

Symptoms:

```text
UPDATE_COMPLETE_CLEANUP_IN_PROGRESS
DELETE_FAILED AWS::S3::Bucket FrontendBucket
The bucket you tried to delete is not empty
```

Recovery:

1. Identify the old bucket from stack events:

   ```bash
   aws cloudformation describe-stack-events \
     --stack-name "$STACK_NAME" \
     --region "$AWS_REGION" \
     --max-items 20
   ```

2. Confirm the current bucket from outputs:

   ```bash
   aws cloudformation describe-stacks \
     --stack-name "$STACK_NAME" \
     --region "$AWS_REGION" \
     --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
     --output text
   ```

3. Only if the failed bucket is the old replaced bucket, empty it:

   ```bash
   aws s3 rm "s3://OLD_BUCKET_NAME" --recursive --region "$AWS_REGION"
   ```

4. Check for object versions:

   ```bash
   aws s3api list-object-versions \
     --bucket OLD_BUCKET_NAME \
     --region "$AWS_REGION" \
     --query "{Versions: length(Versions || \`[]\`), DeleteMarkers: length(DeleteMarkers || \`[]\`)}"
   ```

5. If the old bucket is empty and CloudFormation still cannot finish cleanup, remove the empty old bucket:

   ```bash
   aws s3 rb "s3://OLD_BUCKET_NAME" --region "$AWS_REGION"
   ```

6. Confirm the stack returns to `UPDATE_COMPLETE`:

   ```bash
   aws cloudformation describe-stacks \
     --stack-name "$STACK_NAME" \
     --region "$AWS_REGION" \
     --query "Stacks[0].StackStatus"
   ```

7. Re-run frontend deployment so the new bucket has the latest build:

   ```bash
   AWS_REGION="$AWS_REGION" ./deploy-frontend.sh
   ```

## Cost Notes

For personal/light use, AWS infrastructure should usually stay very low cost or free-tier friendly:

| Service | Expected for light use |
|---|---|
| Lambda | Usually free-tier friendly |
| API Gateway HTTP API | Usually free-tier friendly |
| DynamoDB on-demand cache table | Usually very low |
| S3 frontend bucket | Usually very low |
| CloudFront | Usually free-tier friendly for light traffic |
| Claude Platform on AWS (tokens + web search) | Main variable cost — post-paid on AWS Marketplace |

AI search is the meaningful cost driver.

Why:

- Web search results can consume many input tokens.
- Repeated failed debugging attempts can still bill provider-side tokens.
- A Lambda timeout does not necessarily mean the AI provider did no work.

Practical advice:

- The app requests 10 trails first, then lets the user load up to 20.
- Full search results are cached in DynamoDB for a few hours by location, model, and requested limit.
- Avoid rapidly repeating the same failing search.
- Watch provider API dashboards during debugging.
- Tail Lambda logs before retrying many times.
- Budget a small amount of API credits for testing.

## Delete the Stack

CloudFormation cannot delete a non-empty S3 bucket. Empty the frontend bucket first:

```bash
BUCKET=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='FrontendBucketName'].OutputValue" \
  --output text)

aws s3 rm "s3://$BUCKET" --recursive --region "$AWS_REGION"
```

Delete the stack:

```bash
sam delete \
  --stack-name "$STACK_NAME" \
  --region "$AWS_REGION"
```

`sam delete` removes the CloudFormation stack resources. SAM’s managed staging bucket may remain because SAM manages that separately. You can clean that manually later if you no longer use SAM in the account/region.

## Clean Deployment Checklist

Before first deploy:

- [ ] AWS CLI installed
- [ ] SAM CLI installed
- [ ] Node.js available locally
- [ ] AWS credentials configured
- [ ] `AWS_REGION` set
- [ ] `STACK_NAME` set or defaulting to `hiking-dashboard`
- [ ] Claude Platform on AWS workspace ID (`wrkspc_...`) available
- [ ] Lambda role grants `aws-external-anthropic:CreateInference` + `sts:*GetWebIdentityToken` (handled by the template)
- [ ] `frontend/public/hero.png` exists
- [ ] `frontend/node_modules/` is not committed
- [ ] `frontend/dist/` is not committed
- [ ] `frontend/.env` is not committed

Deploy:

- [ ] `sam validate --lint --template-file template.yaml`
- [ ] `env npm_config_cache=/private/tmp/hiking-app-npm-cache sam build`
- [ ] `sam deploy --guided --stack-name "$STACK_NAME" --region "$AWS_REGION" --capabilities CAPABILITY_IAM`
- [ ] Review CloudFormation changeset
- [ ] Confirm deploy
- [ ] Review outputs
- [ ] `AWS_REGION="$AWS_REGION" ./deploy-frontend.sh`
- [ ] Open `CloudFrontUrl`
- [ ] Run a Claude-backed search
- [ ] Confirm the first search shows 10 trails before using `Load more trails`
- [ ] Click `Load more trails` and confirm up to 20 trails can load
- [ ] Try both Claude Haiku 4.5 and Claude Sonnet 4.6
- [ ] Tail logs if anything fails

Subsequent work:

- [ ] Frontend-only change: run `deploy-frontend.sh`
- [ ] Backend/template change: run `sam build`, `sam deploy`, then optionally `deploy-frontend.sh`
- [ ] Backend plus frontend change: run `sam build`, `sam deploy`, then `deploy-frontend.sh`

## Mental Model

SAM lifecycle:

```text
sam validate -> check the template
sam build    -> package Lambda/backend code
sam deploy   -> create/update AWS resources through CloudFormation
sam logs     -> read Lambda logs from CloudWatch
sam delete   -> delete the stack
```

Frontend lifecycle:

```text
npm install
npm run build
aws s3 sync frontend/dist/
aws s3 cp frontend/dist/index.html
aws cloudfront create-invalidation
```

This project deliberately combines both:

- SAM is excellent for Lambda-centric serverless infrastructure.
- Vite is responsible for the static frontend build.
- S3 and CloudFront serve the built frontend globally.
