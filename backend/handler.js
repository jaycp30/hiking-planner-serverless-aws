"use strict";

const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, GetCommand, PutCommand } = require("@aws-sdk/lib-dynamodb");

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const OPENAI_API_URL    = "https://api.openai.com/v1/responses";
const SEARCH_CACHE_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_TRAIL_LIMIT = 10;
const MAX_TRAIL_LIMIT = 20;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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

const CORS_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
};

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

function parseClaudeTrails(data) {
  for (const block of (data.content || []).filter(b => b.type === "text")) {
    const result = extractJson(block.text);
    if (result.length > 0) return result;
  }
  console.log("parseClaudeTrails: no parseable trails. stop_reason:", data.stop_reason);
  console.log("parseClaudeTrails: text sample:", (data.content || [])
    .filter(b => b.type === "text")
    .map(b => (b.text || "").slice(0, 300))
    .join(" | "));
  return [];
}

function parseOpenAITrails(data) {
  // Try all output items regardless of type
  for (const item of (data.output || [])) {
    // Handle message items with content array
    for (const content of (item.content || [])) {
      const text = content.text || content.value || "";
      if (!text) continue;
      const result = extractJson(text);
      if (result.length > 0) return result;
    }
    // Handle items with a direct text field
    if (item.text) {
      const result = extractJson(item.text);
      if (result.length > 0) return result;
    }
  }
  // Last resort: stringify entire response and hunt for a JSON array
  const raw = JSON.stringify(data);
  const match = raw.match(/\[[\s\S]*?\{[\s\S]*?"name"[\s\S]*?\}[\s\S]*?\]/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {}
  }
  const textSample = (data.output || []).flatMap(i => (i.content || []).map(c => (c.text || "").slice(0, 300))).join(" | ");
  console.log("parseOpenAITrails: failed. Text sample:", textSample);
  console.log("parseOpenAITrails: output structure:", JSON.stringify((data.output || []).map(i => ({ type: i.type, contentTypes: (i.content || []).map(c => c.type) }))));
  return [];
}

function sse(stream, data) {
  stream.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function searchWithClaude(location, apiKey, stream, targetLimit = DEFAULT_TRAIL_LIMIT) {
  const TARGET = clampTrailLimit(targetLimit);
  const BATCH  = Math.min(5, TARGET);
  const allTrails = [];
  const maxAttempts = Math.ceil(TARGET / BATCH) + 1;

  for (let i = 0; i < maxAttempts && allTrails.length < TARGET; i++) {
    sse(stream, {
      type: "progress",
      found: allTrails.length,
      total: TARGET,
      message: i === 0 ? "Searching AllTrails and YAMAP..." : "Retrying live search for better trail data...",
    });

    const exclude = allTrails.length > 0
      ? " Skip trails already found (search different areas or difficulty levels)."
      : "";

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 3000,
        system: SYSTEM_PROMPT,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{
          role: "user",
          content: `Find ${BATCH} hiking trails near ${location}.${exclude} Include AllTrails URLs, and YAMAP URLs if this is a Japan location. Include photos where available.`,
        }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      if (allTrails.length > 0) break;
      sse(stream, { type: "error", error: data.error.message || "Anthropic API error" });
      return;
    }

    const parsed = parseClaudeTrails(data);
    if (parsed.length === 0) {
      console.log(`Claude returned no parseable trails on attempt ${i + 1} for location: ${location}`);
      continue;
    }

    sse(stream, {
      type: "progress",
      found: allTrails.length,
      total: TARGET,
      message: "Adding map details and trail photos...",
    });
    const remaining = TARGET - allTrails.length;
    const raw = parsed.slice(0, remaining).map((t, j) => ({ ...t, id: allTrails.length + j + 1 }));
    const batch = await Promise.all(raw.map(enrichWithImages));
    allTrails.push(...batch);
    sse(stream, {
      type: "batch",
      trails: batch,
      found: allTrails.length,
      total: TARGET,
      message: `Found ${allTrails.length} trails so far...`,
    });
  }

  if (allTrails.length === 0) {
    sse(stream, {
      type: "error",
      error: "The search provider came back empty this time. This can happen with live web search; please retry the same search.",
    });
    return;
  }

  await setCachedSearch(location, "haiku", TARGET, allTrails);
  sse(stream, { type: "complete", found: allTrails.length, total: TARGET });
}

async function searchWithGPT(location, apiKey, stream, targetLimit = DEFAULT_TRAIL_LIMIT) {
  const TARGET = clampTrailLimit(targetLimit);
  let parsed = [];

  for (let attempt = 0; attempt < 2 && parsed.length === 0; attempt++) {
    sse(stream, {
      type: "progress",
      found: 0,
      total: TARGET,
      message: attempt === 0 ? "Searching live trail sources..." : "Retrying live search for better trail data...",
    });

    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        instructions: SYSTEM_PROMPT,
        tools: [{ type: "web_search_preview" }],
        input: `Find ${TARGET} hiking trails near ${location}. Include AllTrails URLs, and YAMAP URLs if this is a Japan location. Include photos where available. Reply with ONLY the JSON array, no other text.`,
      }),
    });

    const data = await response.json();

    if (data.error) {
      sse(stream, { type: "error", error: data.error.message || "OpenAI API error" });
      return;
    }

    parsed = parseOpenAITrails(data);
    if (parsed.length === 0) {
      console.log(`OpenAI returned no parseable trails on attempt ${attempt + 1} for location: ${location}`);
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
  await setCachedSearch(location, "gpt54", TARGET, trails);
  sse(stream, {
    type: "batch",
    trails,
    found: trails.length,
    total: TARGET,
    message: `Found ${trails.length} trails.`,
  });
  sse(stream, { type: "complete", found: trails.length, total: TARGET });
}

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
    const searchModel = model === "gpt54" ? "gpt54" : "haiku";
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
    const cached = await getCachedSearch(searchLocation, searchModel, searchLimit);
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

    if (searchModel === "gpt54") {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        sse(stream, { type: "error", error: "OpenAI API key not configured" });
        stream.end();
        return;
      }
      await searchWithGPT(searchLocation, apiKey, stream, searchLimit);
    } else {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        sse(stream, { type: "error", error: "Anthropic API key not configured" });
        stream.end();
        return;
      }
      await searchWithClaude(searchLocation, apiKey, stream, searchLimit);
    }
  } catch (err) {
    console.error("Handler error:", err);
    sse(stream, { type: "error", error: err.message || "Internal server error" });
  }

  stream.end();
});

module.exports = { handler };
