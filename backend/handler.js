"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

// Claude Platform on AWS — Anthropic-operated, full first-party API parity
// (including the hosted web_search server tool), authenticated with the Lambda
// role via SigV4, billed post-paid on the AWS Marketplace invoice.
// Reads AWS_REGION (set by Lambda) and ANTHROPIC_AWS_WORKSPACE_ID from the env.
let AnthropicAws = require("@anthropic-ai/aws-sdk");
AnthropicAws = AnthropicAws.default || AnthropicAws; // CJS/ESM interop
const anthropic = new AnthropicAws();

// ── Config ───────────────────────────────────────────────────────────────────
// Bare first-party model IDs (no provider prefix on Claude Platform on AWS).
const MODEL_IDS = {
  haiku:  process.env.HAIKU_MODEL_ID  || "claude-haiku-4-5",
  sonnet: process.env.SONNET_MODEL_ID || "claude-sonnet-4-6",
};
const SEARCH_CACHE_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_TRAIL_LIMIT = 10;
const MAX_TRAIL_LIMIT = 20;
const MAX_TOKENS = 4096;
const WEB_SEARCH_MAX_USES = 8;        // cap searches per request to bound cost
const MAX_PAUSE_CONTINUATIONS = 6;    // resume the server tool loop at most N times

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// The hosted web search tool — Anthropic runs the search server-side and feeds
// results back to the model. We just declare it; no client-side search needed.
// allowed_callers: ["direct"] disables dynamic filtering (which relies on
// programmatic tool calling), so this works on Haiku 4.5 — which doesn't support
// PTC — as well as Sonnet 4.6.
const WEB_SEARCH_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
  max_uses: WEB_SEARCH_MAX_USES,
  allowed_callers: ["direct"],
};

// ── Cache key helpers ──────────────────────────────────────────────────────────
function trailCacheKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
}

function clampTrailLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return DEFAULT_TRAIL_LIMIT;
  return Math.min(MAX_TRAIL_LIMIT, Math.max(1, Math.round(parsed)));
}

function searchCacheKey(location, model, limit) {
  return `search:${model || "haiku"}:${clampTrailLimit(limit)}:${trailCacheKey(location)}`;
}

// ── DynamoDB: image cache ────────────────────────────────────────────────────
async function getCachedImages(name) {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: process.env.TABLE_NAME,
      Key: { trailKey: trailCacheKey(name) },
    }));
    return result.Item?.images || null;
  } catch { return null; }
}

async function setCachedImages(name, images) {
  try {
    await ddb.send(new PutCommand({
      TableName: process.env.TABLE_NAME,
      Item: {
        trailKey: trailCacheKey(name),
        images,
        ttl: Math.floor(Date.now() / 1000) + 120 * 24 * 60 * 60,
      },
    }));
  } catch (err) { console.error("DynamoDB write failed:", err); }
}

// ── DynamoDB: search-result cache ────────────────────────────────────────────
async function getCachedSearch(location, model, limit) {
  try {
    const result = await ddb.send(new GetCommand({
      TableName: process.env.TABLE_NAME,
      Key: { trailKey: searchCacheKey(location, model, limit) },
    }));
    return Array.isArray(result.Item?.trails) && result.Item.trails.length > 0
      ? result.Item.trails
      : null;
  } catch (err) {
    console.error("DynamoDB search cache read failed:", err);
    return null;
  }
}

async function setCachedSearch(location, model, limit, trails) {
  if (!Array.isArray(trails) || trails.length === 0) return;
  try {
    await ddb.send(new PutCommand({
      TableName: process.env.TABLE_NAME,
      Item: {
        trailKey: searchCacheKey(location, model, limit),
        location,
        model,
        limit: clampTrailLimit(limit),
        trails,
        ttl: Math.floor(Date.now() / 1000) + SEARCH_CACHE_TTL_SECONDS,
      },
    }));
  } catch (err) {
    console.error("DynamoDB search cache write failed:", err);
  }
}

// ── Wikimedia image enrichment ───────────────────────────────────────────────
async function fetchWikimediaImages(trailName) {
  const query = encodeURIComponent(`${trailName} hiking trail`);
  const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrsearch=${query}&gsrnamespace=6&prop=imageinfo&iiprop=url&iiurlwidth=600&format=json&origin=*&gsrlimit=6`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    return Object.values(data.query?.pages || {})
      .map(p => p.imageinfo?.[0]?.thumburl || p.imageinfo?.[0]?.url)
      .filter(u => u && /\.(jpe?g|png|webp)/i.test(u))
      .slice(0, 3);
  } catch { return []; }
}

async function enrichWithImages(trail) {
  const cached = await getCachedImages(trail.name);
  if (cached) return { ...trail, photos: cached };

  const images = await fetchWikimediaImages(trail.name);
  await setCachedImages(trail.name, images);
  return { ...trail, photos: images };
}

// ── SSE helper ───────────────────────────────────────────────────────────────
function sse(stream, data) {
  stream.write(`data: ${JSON.stringify(data)}\n\n`);
}

const CORS_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
};

// ── Prompt + JSON extraction ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a worldwide hiking trail search assistant.
Use the web_search tool to find hiking trails from two sources:
  1. AllTrails (alltrails.com) — best for global coverage
  2. YAMAP (yamap.com) — best for Japan trails, use this when location is in Japan

Search strategy:
  - First search: "alltrails.com hiking trails [LOCATION]"
  - Second search (Japan only): "yamap.com [LOCATION] trail" or "yamap 登山 [LOCATION]"
  - For non-Japan locations, skip the YAMAP search entirely
  - Merge results, remove duplicates (same trail on both sites = one entry with both URLs)

Respond ONLY with a valid JSON array — no markdown, no backticks, no explanation.
Each object must have exactly these fields:
  id             (number — unique integer),
  name           (string — trail name in English),
  difficulty     ("easy" | "moderate" | "hard"),
  length_km      (number — trail length in km, 1 decimal),
  elevation_gain_m (number — elevation gain in meters, integer),
  duration_minutes (number — estimated hiking time),
  rating         (number — 0 to 5),
  latitude       (number — trailhead latitude),
  longitude      (number — trailhead longitude),
  description    (string — one sentence about what makes this trail special),
  alltrails_url  (string — full https://www.alltrails.com/trail/... URL, or ""),
  yamap_url      (string — full https://yamap.com/mountains/... URL, or ""),
  photos         (array of up to 3 real photo URL strings, or []),
  source         ("alltrails" | "yamap" | "both").

Return [] if nothing found. Aim for exactly the number of trails requested.`;

function extractJson(text) {
  const raw = (text || "").trim()
    .replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  const match = raw.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

// Pull the trail JSON array out of the model's text content blocks.
function parseClaudeTrails(message) {
  for (const block of (message.content || []).filter(b => b.type === "text")) {
    const result = extractJson(block.text);
    if (result.length > 0) return result;
  }
  console.log("parseClaudeTrails: no parseable trails. stop_reason:", message.stop_reason);
  return [];
}

// ── Claude (native web search) call ──────────────────────────────────────────
async function callClaude(modelId, messages) {
  let response = await anthropic.messages.create({
    model: modelId,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    tools: [WEB_SEARCH_TOOL],
    messages,
  });

  // The server-side web search loop pauses with stop_reason "pause_turn" when it
  // hits its internal iteration limit — re-send to let it resume.
  let continuations = 0;
  while (response.stop_reason === "pause_turn" && continuations < MAX_PAUSE_CONTINUATIONS) {
    continuations++;
    messages.push({ role: "assistant", content: response.content });
    response = await anthropic.messages.create({
      model: modelId,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: [WEB_SEARCH_TOOL],
      messages,
    });
  }
  return response;
}

async function searchTrails(location, modelKey, modelId, stream, targetLimit) {
  const TARGET = clampTrailLimit(targetLimit);
  let parsed = [];

  // One retry — live web search occasionally comes back thin on the first pass.
  for (let attempt = 0; attempt < 2 && parsed.length === 0; attempt++) {
    sse(stream, {
      type: "progress",
      found: 0,
      total: TARGET,
      message: attempt === 0 ? "Searching AllTrails and YAMAP..." : "Retrying live search for better trail data...",
    });

    const messages = [{
      role: "user",
      content: `Find ${TARGET} hiking trails near ${location}. Use web_search to look them up on ` +
        `AllTrails (and YAMAP if this is in Japan). Include real AllTrails/YAMAP URLs and photos ` +
        `where available. Reply with ONLY the JSON array.`,
    }];

    let response;
    try {
      response = await callClaude(modelId, messages);
    } catch (err) {
      // Log full detail (ARNs, IAM actions, stack) to CloudWatch only — never to the client.
      console.error("Claude call failed:", err);
      if (attempt === 0) continue;
      sse(stream, {
        type: "error",
        error: "The trail search service is temporarily unavailable. Please try again in a moment.",
      });
      return;
    }

    parsed = parseClaudeTrails(response);
    if (parsed.length === 0) {
      console.log(`Claude returned no parseable trails on attempt ${attempt + 1} for: ${location}`);
    }
  }

  if (parsed.length === 0) {
    sse(stream, {
      type: "error",
      error: "The search provider came back empty this time. This can happen with live web search; please retry the same search.",
    });
    return;
  }

  sse(stream, {
    type: "progress",
    found: 0,
    total: TARGET,
    message: "Adding map details and trail photos...",
  });

  const raw = parsed.slice(0, TARGET).map((t, i) => ({ ...t, id: i + 1 }));
  const trails = await Promise.all(raw.map(enrichWithImages));
  await setCachedSearch(location, modelKey, TARGET, trails);

  sse(stream, {
    type: "batch",
    trails,
    found: trails.length,
    total: TARGET,
    message: `Found ${trails.length} trails.`,
  });
  sse(stream, { type: "complete", found: trails.length, total: TARGET });
}

// ── Lambda entrypoint (streaming response) ────────────────────────────────────
const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  if (event.requestContext?.http?.method === "OPTIONS") {
    awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    }).end();
    return;
  }

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: CORS_HEADERS,
  });

  try {
    const body = JSON.parse(event.body || "{}");
    const { location, model, limit } = body;
    const searchLocation = location?.trim();
    const modelKey = model === "sonnet" ? "sonnet" : "haiku";
    const modelId = MODEL_IDS[modelKey];
    const searchLimit = clampTrailLimit(limit);

    if (!searchLocation) {
      sse(stream, { type: "error", error: "location is required" });
      stream.end();
      return;
    }

    sse(stream, {
      type: "progress",
      found: 0,
      total: searchLimit,
      message: "Checking recent searches...",
    });

    const cached = await getCachedSearch(searchLocation, modelKey, searchLimit);
    if (cached) {
      sse(stream, {
        type: "batch",
        trails: cached,
        found: cached.length,
        total: searchLimit,
        cached: true,
        message: "Loaded a recent cached search.",
      });
      sse(stream, { type: "complete", found: cached.length, total: searchLimit, cached: true });
      stream.end();
      return;
    }

    await searchTrails(searchLocation, modelKey, modelId, stream, searchLimit);
  } catch (err) {
    // Full detail to CloudWatch only; the client gets a generic message so we
    // never leak account IDs, role ARNs, IAM actions, or stack traces.
    console.error("Handler error:", err);
    sse(stream, { type: "error", error: "Something went wrong on our end. Please try again." });
  }

  stream.end();
});

module.exports = { handler };
