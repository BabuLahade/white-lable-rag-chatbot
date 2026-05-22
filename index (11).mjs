// ============================================================
// WebcreateHub — Ingest Lambda  (index.mjs)  v2.3
//
// CHANGES IN v2.3:
//   • Primary embed model: gemini-embedding-2-preview
//   • Uses @google/genai SDK for new model (different API shape)
//   • Falls back to REST fetch for older models if new one fails
//   • embedModel stored in DynamoDB client metadata
//   • All crawler / chunking / storage logic unchanged from v2.2
//
// DEPLOY STEP: npm install @google/genai  (add to Lambda package)
// ============================================================

import { DynamoDBClient, PutItemCommand, DeleteItemCommand, QueryCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { GoogleGenAI } from "@google/genai";
import { crawlAnySite } from "./universal-crawler.mjs";

const ddb     = new DynamoDBClient({ region: process.env.AWS_REGION || "eu-north-1" });
const TABLE_K = process.env.DYNAMODB_TABLE_KNOWLEDGE || "edubot_knowledge";
const TABLE_C = process.env.DYNAMODB_TABLE_CLIENTS   || "edubot_clients";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "Content-Type,x-ingest-secret",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
};

const respond = (status, body) => ({
  statusCode: status,
  headers: CORS,
  body: JSON.stringify(body),
});

// ══════════════════════════════════════════════════════════════
// GEMINI EMBEDDINGS — v2.3
//
// Priority order:
//   1. gemini-embedding-2-preview  via @google/genai SDK (new)
//   2. gemini-embedding-001        via REST fetch (confirmed working)
//   3. text-embedding-004          via REST fetch
//   4. older models...
//
// Why two methods?
//   New model uses @google/genai SDK with different request shape.
//   Old models use direct REST /v1beta/models/:model:embedContent.
// ══════════════════════════════════════════════════════════════

const REST_FALLBACK_CANDIDATES = [
  ["gemini-embedding-001",       "v1beta"],  // ✅ confirmed on your key
  ["gemini-embedding-001",       "v1"    ],
  ["text-embedding-004",         "v1beta"],
  ["text-embedding-004",         "v1"    ],
  ["gemini-embedding-exp-03-07", "v1beta"],
  ["gemini-embedding-exp-03-07", "v1"    ],
  ["embedding-001",              "v1beta"],
  ["embedding-001",              "v1"    ],
];

// Cached per Lambda invocation
let workingEmbedConfig = null;
// Shape: { type: "genai", model: "gemini-embedding-2-preview" }
//     or { type: "rest",  model: "gemini-embedding-001", version: "v1beta" }

// ── New SDK embed (gemini-embedding-2-preview) ────────────────
async function tryNewSdkEmbed(text, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.embedContent({
    model:    "gemini-embedding-2-preview",
    contents: [{ parts: [{ text: text.slice(0, 2000) }] }],
  });
  const values = response?.embeddings?.[0]?.values;
  if (!values?.length) throw new Error("Empty vector from gemini-embedding-2-preview");
  return values;
}

// ── Legacy REST embed ─────────────────────────────────────────
async function tryRestEmbed(text, model, version, apiKey) {
  const url = `https://generativelanguage.googleapis.com/${version}/models/${model}:embedContent?key=${apiKey}`;
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model:   `models/${model}`,
      content: { parts: [{ text: text.slice(0, 2000) }] },
    }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json();
  const values = data?.embedding?.values;
  if (!values?.length) throw new Error(data?.error?.message || "Empty vector");
  return values;
}

// ── Probe which method works, cache result ────────────────────
async function findWorkingEmbedModel(apiKey) {
  const probe = "test embedding probe";

  // 1. New SDK first
  console.log("[embed] Trying gemini-embedding-2-preview (new SDK)...");
  try {
    const values = await tryNewSdkEmbed(probe, apiKey);
    if (values?.length > 0) {
      console.log(`[embed] ✅ gemini-embedding-2-preview — dim: ${values.length}`);
      return { type: "genai", model: "gemini-embedding-2-preview" };
    }
  } catch (e) {
    console.log(`[embed] ✗ gemini-embedding-2-preview: ${e.message}`);
  }

  // 2. REST fallbacks
  console.log("[embed] Falling back to REST models...");
  for (const [model, version] of REST_FALLBACK_CANDIDATES) {
    try {
      const values = await tryRestEmbed(probe, model, version, apiKey);
      if (values?.length > 0) {
        console.log(`[embed] ✅ Fallback: ${model} (${version}) — dim: ${values.length}`);
        return { type: "rest", model, version };
      }
    } catch (e) {
      console.log(`[embed] ✗ ${model} (${version}): ${e.message}`);
    }
  }

  return null;
}

// ── Single embed using cached config ─────────────────────────
async function embedSingle(text, config, apiKey) {
  if (config.type === "genai") {
    return await tryNewSdkEmbed(text, apiKey);
  }
  return await tryRestEmbed(text, config.model, config.version, apiKey);
}

// ── Batch embed ───────────────────────────────────────────────
async function embedTexts(texts, apiKey) {
  if (!workingEmbedConfig) {
    console.log("[embed] Probing models...");
    workingEmbedConfig = await findWorkingEmbedModel(apiKey);
    if (!workingEmbedConfig) {
      throw new Error(
        "No working Gemini embedding model found.\n" +
        "Check: 1) GEMINI_API_KEY is correct, " +
        "2) Generative Language API is enabled in Google Cloud Console, " +
        "3) No IP restrictions blocking Lambda.\n" +
        "Guide: https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com"
      );
    }
  }

  const vectors = [];
  const BATCH   = 5;

  for (let i = 0; i < texts.length; i += BATCH) {
    const batch   = texts.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(t => embedSingle(t, workingEmbedConfig, apiKey).catch(() => []))
    );
    vectors.push(...results);
    if (i + BATCH < texts.length) await new Promise(r => setTimeout(r, 200));
  }

  const valid = vectors.filter(v => v?.length > 0).length;
  console.log(`[embed] ${valid}/${vectors.length} vectors — model: ${workingEmbedConfig.model}`);
  return vectors;
}

// ── Exports for rag-chat-handler ──────────────────────────────
export async function embedQuery(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!workingEmbedConfig) {
    workingEmbedConfig = await findWorkingEmbedModel(apiKey);
  }
  if (!workingEmbedConfig) return [];
  return await embedSingle(text, workingEmbedConfig, apiKey);
}

export function cosineSimilarity(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na  += a[i] * a[i];
    nb  += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-10);
}

export async function vectorSearch(clientId, queryVector, topK = 4) {
  const res   = await ddb.send(new QueryCommand({
    TableName:                 TABLE_K,
    KeyConditionExpression:    "clientId = :c",
    ExpressionAttributeValues: marshall({ ":c": clientId }),
  }));
  const items = (res.Items || []).map(i => unmarshall(i));
  if (!items.length) return [];
  return items
    .map(item => ({ ...item, score: cosineSimilarity(queryVector, item.vector) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .filter(item => item.score > 0.52);
}

// ── DynamoDB helpers ──────────────────────────────────────────
async function deleteExistingChunks(clientId) {
  const res = await ddb.send(new QueryCommand({
    TableName:                 TABLE_K,
    KeyConditionExpression:    "clientId = :c",
    ExpressionAttributeValues: marshall({ ":c": clientId }),
    ProjectionExpression:      "clientId, chunkId",
  }));
  const items = res.Items || [];
  if (!items.length) return 0;
  const BATCH = 25;
  for (let i = 0; i < items.length; i += BATCH) {
    await Promise.all(items.slice(i, i + BATCH).map(item =>
      ddb.send(new DeleteItemCommand({
        TableName: TABLE_K,
        Key: { clientId: item.clientId, chunkId: item.chunkId },
      }))
    ));
  }
  return items.length;
}

async function storeChunks(clientId, chunks) {
  const now   = new Date().toISOString();
  const BATCH = 10;
  for (let i = 0; i < chunks.length; i += BATCH) {
    await Promise.all(chunks.slice(i, i + BATCH).map(c =>
      ddb.send(new PutItemCommand({
        TableName: TABLE_K,
        Item: marshall({
          clientId,
          chunkId:   c.chunkId,
          text:      c.text,
          vector:    c.vector,
          source:    c.source   || "",
          type:      c.type     || "page",
          title:     c.title    || "",
          platform:  c.platform || "unknown",
          updatedAt: now,
        }, { removeUndefinedValues: true }),
      }))
    ));
    console.log(`[store] ${Math.min(i + BATCH, chunks.length)}/${chunks.length} chunks stored`);
  }
}

async function storeClientMeta(clientId, config, totalChunks, siteUrl, platform, embedModel) {
  await ddb.send(new PutItemCommand({
    TableName: TABLE_C,
    Item: marshall({
      clientId,
      config:      JSON.stringify(config || {}),
      siteUrl:     siteUrl    || "",
      totalChunks,
      platform:    platform   || "unknown",
      embedModel:  embedModel || "unknown",
      crawledAt:   new Date().toISOString(),
      ragEnabled:  true,
    }, { removeUndefinedValues: true }),
  }));
}

// ══════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════
export const handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod;
  if (method === "OPTIONS") return respond(200, { ok: true });

  const secret = event.headers?.["x-ingest-secret"] || event.headers?.["X-Ingest-Secret"];
  if (secret !== process.env.INGEST_SECRET) return respond(401, { error: "Unauthorized" });

  workingEmbedConfig = null; // Reset per invocation

  try {
    const body = JSON.parse(event.body || "{}");
    const { clientId, siteUrl, manualSections = [], clientConfig, authConfig, mode = "full" } = body;

    if (!clientId) return respond(400, { error: "clientId is required" });
    if (mode !== "manual-only" && !siteUrl) return respond(400, { error: "siteUrl required unless mode is manual-only" });

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey || apiKey === "your-gemini-api-key-here") {
      return respond(500, {
        error: "GEMINI_API_KEY not set in Lambda environment variables.",
        fix:   "AWS Console → Lambda → Configuration → Environment variables → add GEMINI_API_KEY",
      });
    }

    console.log(`[ingest] clientId=${clientId} url=${siteUrl} mode=${mode}`);

    // ── STEP 1: CRAWL ─────────────────────────────────────────
    let chunks = [];
    let platform = "manual";

    if (mode !== "manual-only" && siteUrl) {
      const result = await crawlAnySite(siteUrl, {
        authConfig:     authConfig || {},
        manualSections: mode !== "crawl-only" ? manualSections : [],
      });
      chunks   = result.chunks;
      platform = result.platform;
      console.log(`[ingest] Crawled: ${chunks.length} chunks (${platform})`);
    } else {
      for (const s of manualSections) {
        const text = `${s.title ? s.title + ". " : ""}${(s.content || "").trim()}`;
        if (text.length > 20) chunks.push({
          chunkId:  `manual_${(s.title||"sec").toLowerCase().replace(/[^a-z0-9]+/g,"_").slice(0,28)}_0`,
          text, source: "manual", type: s.type || "manual", title: s.title || "", platform: "manual",
        });
      }
    }

    if (!chunks.length) {
      return respond(400, {
        error:    "No content extracted and no manual sections provided.",
        tip:      "Add manual sections in the request body with key page content.",
        platform,
      });
    }

    // ── STEP 2: EMBED ─────────────────────────────────────────
    console.log(`[ingest] Embedding ${chunks.length} chunks...`);
    let vectors;
    try {
      vectors = await embedTexts(chunks.map(c => c.text), apiKey);
    } catch (embedErr) {
      return respond(500, {
        error:  embedErr.message,
        action: "Fix GEMINI_API_KEY or enable Generative Language API",
        guide:  "https://console.cloud.google.com/apis/library/generativelanguage.googleapis.com",
      });
    }

    const withVectors = chunks
      .map((c, i) => ({ ...c, vector: vectors[i] }))
      .filter(c => c.vector?.length > 0);

    console.log(`[ingest] ${withVectors.length}/${chunks.length} chunks have valid vectors`);

    if (!withVectors.length) {
      return respond(500, {
        error:  "All embeddings returned empty vectors.",
        model:  workingEmbedConfig?.model || "none",
        action: "Check API key and Generative Language API is enabled",
      });
    }

    // ── STEP 3: STORE ─────────────────────────────────────────
    const deleted = await deleteExistingChunks(clientId);
    console.log(`[ingest] Deleted ${deleted} old chunks`);

    await storeChunks(clientId, withVectors);
    await storeClientMeta(clientId, clientConfig, withVectors.length, siteUrl, platform, workingEmbedConfig?.model);

    const byType = withVectors.reduce((a, c) => ({ ...a, [c.type]: (a[c.type]||0)+1 }), {});

    console.log(`[ingest] ✅ Done: ${withVectors.length} chunks | ${platform} | ${workingEmbedConfig?.model}`);

    return respond(200, {
      success:     true,
      clientId,
      siteUrl,
      platform,
      totalChunks: withVectors.length,
      embedModel:  workingEmbedConfig?.model,
      byType,
      message:     `✅ ${withVectors.length} chunks indexed for ${clientId} (${platform})`,
    });

  } catch (err) {
    console.error("[ingest] Unhandled error:", err);
    return respond(500, { error: err.message });
  }
};
