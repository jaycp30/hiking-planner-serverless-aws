# Key Learning Points — AWS SAM & Serverless Deployment
### From the Hiking Dashboard Exercise

---

## 1. What is AWS SAM?

SAM stands for **Serverless Application Model**. It's an open-source framework from AWS that sits on top of CloudFormation and adds a shorthand layer specifically designed for serverless apps.

Think of it this way: CloudFormation is the full, verbose language AWS uses to describe infrastructure. SAM is a dialect of that language that lets you describe Lambda functions, API Gateways, and related resources in far fewer lines — then it expands into full CloudFormation before deploying.

A SAM template is still a CloudFormation template. The only difference is the `Transform: AWS::Serverless-2016-10-31` line at the top, which tells CloudFormation to process the SAM shorthand first.

---

## 2. SAM vs CloudFormation vs Amplify

These three tools solve the same problem (deploying AWS infrastructure) but at very different levels of abstraction.

| | SAM | Pure CloudFormation | Amplify |
|---|---|---|---|
| **Target use case** | Serverless backends (Lambda, API Gateway) | Any AWS infrastructure | Full-stack web/mobile apps |
| **Learning curve** | Low-Medium | High | Low |
| **Verbosity** | Concise | Very verbose | Minimal (config-based) |
| **Flexibility** | High | Maximum | Lower (opinionated) |
| **Frontend support** | None (you handle it) | None (you handle it) | Built-in (CI/CD from Git) |
| **Local testing** | Yes (`sam local invoke`) | No | Limited |
| **Packaging** | Automatic (`sam build`) | Manual | Automatic |
| **Deploy command** | `sam deploy` | `aws cloudformation deploy` | `amplify push` |
| **Best for** | APIs, microservices, event-driven | Complex multi-service infra | Hobbyist full-stack with managed CI/CD |

**In this exercise:** We used SAM for the backend (Lambda + API Gateway + S3 + CloudFront) and a shell script (`deploy-frontend.sh`) for the frontend. Amplify could have replaced that shell script but adds complexity and cost for a personal project.

**Why SAM over CloudFormation here:** The SAM template is ~80 lines. The equivalent pure CloudFormation template we also wrote is ~180 lines for the same infrastructure. SAM's `AWS::Serverless::Function` expands into `AWS::Lambda::Function` + `AWS::IAM::Role` + `AWS::Lambda::Permission` automatically.

**Why SAM over Amplify here:** Amplify's strength is Git-connected CI/CD (push code → auto-deploy). For a personal tool where you deploy occasionally, that overhead isn't worth it. Also, Amplify charges for build minutes, which adds up even within the free tier for frequent deployments.

---

## 3. The Infrastructure We Built

```
Browser
  └── CloudFront (CDN, HTTPS, global edge)
        ├── S3 (React static files)
        └── Lambda Function URL (Node.js 22, RESPONSE_STREAM)
              └── handler.js
                    ├── Claude Platform on AWS  (Claude + native web_search,
                    │     authenticated by the Lambda role via SigV4 — no API key)
                    └── DynamoDB  (search + trail-image cache, TTL'd)
```

**Why this shape:**
- **S3 + CloudFront** serves the React app. S3 is cheap (~$0.02/month for a 1MB app). CloudFront puts it on edge nodes globally, including Asia-Pacific.
- **Lambda Function URL** (not API Gateway) is what the frontend calls, because the backend **streams** Server-Sent Events as trails are found — API Gateway v2 caps responses at 29s, while a Function URL in `RESPONSE_STREAM` mode does not. (An API Gateway route still exists in the template for non-streaming use.)
- **Serverless** means you pay only when someone actually searches — no idle EC2 or container running 24/7.
- **DynamoDB** is a small cache (recent searches + per-trail Wikimedia photos) with a TTL, so repeat searches are instant and cheap. No relational DB, no VPC, no containers.
- **Claude Platform on AWS** runs the model *and* the web search on Anthropic's infrastructure, billed post-paid on the AWS Marketplace invoice. The Lambda authenticates with its **IAM role via SigV4** — there is no API key to store or rotate (see §8).

---

## 4. Commands We Used (and What Each Does)

### `sam build`
```bash
sam build
```
Reads `template.yaml`, finds the Lambda code in `backend/`, zips it, and puts the packaged artifact in `.aws-sam/build/`. For Node.js, this also runs `npm install` to pull dependencies — here that's `@anthropic-ai/aws-sdk` (the Claude Platform on AWS client) plus the DynamoDB SDK clients, so the build does real install work rather than being instant.

**Key output:** `.aws-sam/build/template.yaml` — a transformed version of your template with absolute paths to the packaged code.

---

### `sam deploy --guided`
```bash
sam deploy --guided \
  --stack-name hiking-dashboard \
  --region ap-northeast-1 \
  --capabilities CAPABILITY_IAM
```
The first deploy. `--guided` walks you through questions interactively and saves your answers to `samconfig.toml` so future deploys just need `sam deploy`.

**What happens under the hood:**
1. SAM creates a staging S3 bucket (`aws-sam-cli-managed-default-samclisourcebucket-...`)
2. Uploads the Lambda ZIP to that bucket
3. Uploads the transformed template
4. Creates a CloudFormation changeset
5. Shows you the changeset (what resources will be created/modified)
6. Waits for your `y` confirmation
7. CloudFormation provisions everything in dependency order

**`--capabilities CAPABILITY_IAM`** — tells CloudFormation you acknowledge it's creating IAM roles. Required any time your template touches IAM. Without this flag the deploy fails.

**CloudFront takes 3–5 minutes** to create. It's always the slowest resource because AWS provisions global edge locations.

---

### `sam deploy` (subsequent deploys)
```bash
sam deploy
```
After the first `--guided` run, all parameters are saved in `samconfig.toml`. Future deploys use those saved values, no interactive questions. Only changed resources get updated — in our case, when we only changed `handler.js`, CloudFormation updated just the Lambda function (~30 seconds) without touching S3, CloudFront, or API Gateway.

---

### `sam logs`
```bash
sam logs -n SearchFunction --stack-name hiking-dashboard --region ap-northeast-1
```
Streams CloudWatch logs from your Lambda directly in the terminal. This was the primary debugging tool throughout the exercise. Every `console.error()` in `handler.js` and every Lambda execution report (duration, memory, status) shows up here.

**What we diagnosed with it:**
- `Status: timeout` — Lambda dying at exactly 60 seconds before the API could respond
- `Duration: 48301.64 ms` — confirmed the app actually worked once the timeout was raised

---

### `./deploy-frontend.sh`
Not a SAM command, but the bridge SAM doesn't provide. This script:
1. Reads stack outputs from CloudFormation (`aws cloudformation describe-stacks`)
2. Writes `VITE_API_URL` into `frontend/.env`
3. Runs `npm install` and `npm run build` (Vite)
4. Uploads the built files to S3 (`aws s3 sync`)
5. Invalidates the CloudFront cache so users see the new version immediately

You need to run this separately from `sam deploy` any time the frontend code changes.


---

## 5. Issues We Hit and How We Fixed Them

### Issue 1: Model string was outdated
**Error:** `model: claude-sonnet-4-20250514` displayed as an error in the browser.  
**Cause:** The model ID in `handler.js` referenced a model version that no longer existed.  
**Fix:** Updated to `claude-sonnet-4-6`.


---

### Issue 2: Lambda timeout (60 seconds)
**Error:** `Duration: 60000.00 ms   Status: timeout` in SAM logs.  
**Cause:** The Anthropic API with web search does multiple search rounds internally before returning. This takes 30–50 seconds, and the Lambda was configured with a 60-second timeout — not enough headroom.  
**Fix:** Changed `Timeout: 60` to `Timeout: 120` in `template.yaml`.

**Lesson:** Lambda timeout and API Gateway timeout are separate ceilings. API Gateway v2 hard-caps at 29 seconds, but Lambda can run longer for async workloads. For web-search-heavy AI calls, 90–120 seconds is a good timeout.


---

### Issue 3: `anthropic-beta` header mismatch
**Error:** Continued timeouts even after timeout fix.  
**Cause:** `handler.js` had `"anthropic-beta": "web-search-2025-03-05"` — a beta header that's no longer required since web search went GA. We also initially tried `web_search_20260209`, which spun up a code execution environment and consumed all output tokens before finishing.  
**Fix:** Removed the beta header entirely. Switched back to `web_search_20250305` (still valid, simpler execution path, no code execution overhead).


---

### Issue 4: Rate limit (30,000 input tokens/minute)
**Error:** `This request would exceed your organization's rate limit of 30,000 input tokens per minute`.  
**Cause:** All the repeated failed debug attempts burned through the rate limit. Web search feeds large chunks of search result HTML back into the context as input tokens, which adds up fast.  
**Fix:** Wait 2–3 minutes for the window to reset. Long term: trim the system prompt (we reduced it from ~400 tokens to ~120 tokens), and rate limits increase automatically as API spend grows.


---

### Issue 5: `max_tokens` set too high (50,000)
**Error:** Would have caused an API validation error — Sonnet 4.6 has an 8,192 output token hard cap.  
**Lesson:** `max_tokens` controls the output length ceiling, not input. Setting it above the model's hard cap either throws an error or gets silently capped. For a JSON response with 8–12 trail objects, 4,000–8,000 is the right range.

---

## 6. Cost Reality Check

After one debugging session:

| Item | Detail |
|---|---|
| AWS infrastructure | ~$0 (all within free tier) |
| Anthropic API credits burned | $9.41 |
| Cause | Repeated 60-second timeout runs, each consuming ~25,000 input tokens from web search results |
| Per-search cost going forward | ~$0.05–0.15 per search (web search = $0.01 + tokens) |

**Key insight:** The Anthropic API bills for tokens consumed even if Lambda times out and kills the connection. The API was doing its work on Anthropic's side — you just never received the response.


---

## 7. SAM Mental Model — What to Remember

SAM owns the **backend lifecycle**:
```
sam build → packages code
sam deploy → provisions/updates AWS resources
sam logs → tails CloudWatch
sam local invoke → tests locally without deploying
```

SAM does **not** handle:
- Frontend builds (Vite, webpack, etc.)
- Uploading static files to S3
- CloudFront cache invalidation
- Database seeding
- Any non-serverless resources beyond its shorthand types

Anything outside SAM's scope you handle yourself — shell scripts, Makefiles, or a CI/CD pipeline like GitHub Actions or AWS CodePipeline.

**When to use SAM:** APIs, event-driven functions, scheduled jobs, webhook handlers. Anything that's Lambda-centric.  
**When to reach for something else:** Full-stack apps with complex frontends (Amplify), multi-service platforms with databases and containers (CDK or Terraform), or situations where you need maximum infrastructure control (raw CloudFormation).

---

## 8. Migration: Anthropic/OpenAI API keys → Claude Platform on AWS

The app originally called the first-party Anthropic API (and OpenAI) directly, with API keys stored as `NoEcho` CloudFormation parameters. It was later migrated to run entirely on **Claude Platform on AWS**. This section captures what changed and why.

### Three ways to run Claude on AWS — they are not the same

| | **Amazon Bedrock** | **Claude Platform on AWS** | First-party Anthropic API |
|---|---|---|---|
| Operated by | AWS (partner) | **Anthropic**, via AWS infra | Anthropic |
| Native `web_search` tool | ❌ none | ✅ yes | ✅ yes |
| Billing | AWS bill, post-paid | **AWS Marketplace, post-paid** | Prepaid credits |
| Auth | IAM (SigV4) | **IAM (SigV4)** | API key |
| Model IDs | `jp.anthropic.claude-…` | bare `claude-haiku-4-5` | bare `claude-haiku-4-5` |

The key realization: **Bedrock has no built-in web search for Claude** — that tool only exists on Anthropic-operated surfaces. So a Bedrock migration would have forced a third-party search vendor (we briefly used Tavily and hit its free-tier rate limit). **Claude Platform on AWS** gives the native search *and* post-paid AWS billing with no prepaid credits — exactly what this app needed.

### Auth model — no more API keys

The Lambda authenticates with its own **execution role** via SigV4; the `@anthropic-ai/aws-sdk` client signs every request automatically. There is no secret to store, so the stack has no `NoEcho` key parameter anymore — the auth *is* the IAM role. Least-privilege policy on that role:

- `aws-external-anthropic:CreateInference` — scoped to the **workspace ARN** (`arn:aws:aws-external-anthropic:{region}:{account}:workspace/{workspace-id}`)
- `sts:GetWebIdentityToken` + `sts:TagGetWebIdentityToken` — on `arn:aws:sts::{account}:self` (the SDK exchanges the role's credentials for a short-lived workload-identity token before calling Claude)
- `dynamodb:*` — on the cache table only

The only deploy input is the **workspace ID** (`wrkspc_...`), passed as a plain parameter — not a secret.

### Issues we hit during this migration (and the lesson in each)

The errors got progressively more specific — that's the signal each fix is landing, not failing:

1. **`CreateInference` denied** → the role had no Claude-on-AWS permission. Added the scoped inference action.
2. **`sts:GetWebIdentityToken` denied** → Claude Platform on AWS uses AWS *workload identity*; the SDK first exchanges role credentials for a web-identity token. Added the STS action on `:self`.
3. **`sts:TagGetWebIdentityToken` denied** → the tagged variant of the same exchange. Added it alongside the first. (Lesson: grant the **specific** STS actions, not `sts:*`.)
4. **`404 model: jp.anthropic.claude-haiku-4-5-…`** → a stale Bedrock model ID. CloudFormation **keeps the previous parameter value** when you don't pass it on update, so the new template default wasn't picked up. Fixed by passing the bare IDs explicitly, then pinning them in `samconfig.toml`.
5. **`400 … does not support programmatic tool calling`** → the `web_search_20260209` tool defaults to *dynamic filtering*, which Haiku 4.5 can't do. Set `allowed_callers: ["direct"]` on the tool so it's called directly by the model — works on every model.

### Don't leak backend errors to the browser

Early on, the raw AWS error (including the account ID and role ARN) was rendered straight to the user. Fixed by sanitizing: the client now gets a generic *"temporarily unavailable"* message, and the full error — ARNs, IAM actions, stack traces — goes only to CloudWatch via `console.error`. An account ID isn't a credential, but internal detail should never reach end users.

---

Demo (now responsive for desktop and mobile):
[https://d2dxl1mmddrrze.cloudfront.net](https://1drv.ms/v/c/060d23632df8ec38/IQBPFIK6AnNgTponA_W9GEcBASd_L7K9BqaLFMVM5CGIndY?e=YWk4Fp)
