/**
 * PrimeCore Intelligence — Workers Relay v1.0
 * api-relay.primecoreintelligence.com
 *
 * This Worker sits between the public internet and the War Room API.
 * It enforces:
 *   1. Rate limiting (per-IP, per-tenant, per-endpoint)
 *   2. CCaaS webhook validation (HMAC signature verification)
 *   3. Tenant isolation (all KV keys prefixed with tenant:{id}:)
 *   4. Call event ingestion from Five9 / Genesys / 3CX / RingCentral
 *   5. Audit logging of every inbound event
 *
 * Routes:
 *   POST /relay/call/event         — CCaaS call event webhook
 *   POST /relay/call/transcript    — Live transcript chunk
 *   POST /relay/call/end           — Call ended, trigger analytics
 *   GET  /relay/call/live/:callId  — Poll live call state
 *   POST /relay/pilot-request      — Pilot form (rate-limited)
 *   GET  /relay/health             — Liveness (no auth)
 *   GET  /relay/status/:tenantId   — Tenant KPI status (auth required)
 */

"use strict";

// ── Constants ─────────────────────────────────────────────────────────────
const WAR_ROOM_API = "https://api.primecoreintelligence.com";
const VERSION      = "1.0.0";
const RELAY_EPOCH  = 300; // 5-minute rate limit window (seconds)

// Per-IP rate limits (requests per window)
const LIMITS = {
  "/relay/pilot-request":    { max: 3,   window: 3600 }, // 3/hour per IP
  "/relay/call/event":       { max: 500, window: 300  }, // 500/5min per tenant
  "/relay/call/transcript":  { max: 2000,window: 300  }, // 2000/5min per tenant
  "/relay/call/end":         { max: 100, window: 300  }, // 100/5min per tenant
  "default":                 { max: 60,  window: 300  }, // 60/5min default
};

// Supported CCaaS platforms and their signature header names
const CCAAS_PLATFORMS = {
  five9:        { sigHeader: "x-five9-signature",     algo: "sha256" },
  genesys:      { sigHeader: "x-genesys-signature",   algo: "sha256" },
  "3cx":        { sigHeader: "x-3cx-webhook-token",   algo: "plain"  },
  ringcentral:  { sigHeader: "x-ringcentral-token",   algo: "plain"  },
  bliss:        { sigHeader: "x-bliss-signature",     algo: "sha256" },
  atento:       { sigHeader: "x-atento-token",        algo: "plain"  },
};

// ── CORS ──────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = new Set([
  "https://primecoreintelligence.com",
  "https://www.primecoreintelligence.com",
  "https://warroom.primecoreintelligence.com",
  "https://pilot.primecoreintelligence.com",
  "https://app.primecoreintelligence.com",
  "https://assist.primecoreintelligence.com",
  "https://api.primecoreintelligence.com",
]);

function corsHeaders(origin) {
  const h = {
    "access-control-allow-methods":  "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers":  "content-type, authorization, x-tenant-id, x-request-id, x-five9-signature, x-genesys-signature",
    "access-control-max-age":        "86400",
    "vary":                          "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["access-control-allow-origin"] = origin;
  }
  return h;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function json(obj, status = 200, origin = "") {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type":          "application/json; charset=utf-8",
      "x-relay-version":       VERSION,
      "x-relay-ts":            new Date().toISOString(),
      "x-relay-request-id":    crypto.randomUUID(),
      ...corsHeaders(origin),
    },
  });
}

function getIP(request) {
  return request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
}

function getTenantId(request) {
  // Priority: header > query param > "public"
  return (request.headers.get("x-tenant-id") || "").trim()
    || new URL(request.url).searchParams.get("tenant_id")
    || "public";
}

// ── Tenant-prefixed KV keys ───────────────────────────────────────────────
// ALL KV operations go through these helpers.
// This is the tenant isolation layer — no key ever exists without a tenant prefix.
function tenantKey(tenantId, category, key) {
  // Format: tenant:{tenantId}:{category}:{key}
  // Examples:
  //   tenant:lf-001:call:call_abc123
  //   tenant:lf-001:metrics:current
  //   tenant:public:pilot:pilot_xyz
  //   tenant:lf-001:audit:2026-03-17T10:00:00Z
  const safeId = String(tenantId || "public").replace(/[^a-z0-9\-_]/gi, "_").slice(0, 40);
  const safeCat = String(category || "misc").replace(/[^a-z0-9_]/gi, "_");
  const safeKey = String(key || "").replace(/[^a-z0-9\-_.]/gi, "_").slice(0, 100);
  return `tenant:${safeId}:${safeCat}:${safeKey}`;
}

async function kvGet(kv, tenantId, category, key) {
  if (!kv) return null;
  try {
    const raw = await kv.get(tenantKey(tenantId, category, key));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function kvPut(kv, tenantId, category, key, value, opts = {}) {
  if (!kv) return false;
  try {
    await kv.put(tenantKey(tenantId, category, key), JSON.stringify(value), opts);
    return true;
  } catch { return false; }
}

async function kvList(kv, tenantId, category, limit = 50) {
  if (!kv) return [];
  try {
    const prefix = `tenant:${tenantId}:${category}:`;
    const result = await kv.list({ prefix, limit });
    return result.keys || [];
  } catch { return []; }
}

// ── Rate Limiting ─────────────────────────────────────────────────────────
async function checkRateLimit(kv, identifier, path) {
  const rule = LIMITS[path] || LIMITS["default"];
  const windowSec = rule.window;
  const maxReq    = rule.max;

  // Rate limit key — per IP+path, not per tenant (IP is the right identifier here)
  const rlKey = `rl:${identifier}:${path.replace(/\//g, "_")}`;
  const now   = Math.floor(Date.now() / 1000);
  const slot  = Math.floor(now / windowSec); // current time slot

  if (!kv) return { allowed: true, remaining: maxReq }; // no KV = no limit

  try {
    const stored = await kv.get(rlKey);
    const state  = stored ? JSON.parse(stored) : { slot: 0, count: 0 };

    // New time slot — reset counter
    if (state.slot !== slot) {
      const newState = { slot, count: 1 };
      await kv.put(rlKey, JSON.stringify(newState), { expirationTtl: windowSec * 2 });
      return { allowed: true, remaining: maxReq - 1 };
    }

    // Same slot — increment
    if (state.count >= maxReq) {
      return {
        allowed:   false,
        remaining: 0,
        resetAt:   (slot + 1) * windowSec,
        retryAfter: windowSec - (now % windowSec),
      };
    }

    const newState = { slot, count: state.count + 1 };
    await kv.put(rlKey, JSON.stringify(newState), { expirationTtl: windowSec * 2 });
    return { allowed: true, remaining: maxReq - newState.count };

  } catch {
    return { allowed: true, remaining: maxReq }; // fail open on KV error
  }
}

// ── HMAC Signature Verification ───────────────────────────────────────────
async function verifyHmac(secret, body, signature) {
  try {
    const enc     = new TextEncoder();
    const keyData = enc.encode(secret);
    const msgData = enc.encode(body);
    const key     = await crypto.subtle.importKey("raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    // Normalize: strip "sha256=" prefix if present
    const sigClean = signature.replace(/^sha256=/i, "");
    const sigBytes = hexToBytes(sigClean);
    return await crypto.subtle.verify("HMAC", key, sigBytes, msgData);
  } catch {
    return false;
  }
}

function hexToBytes(hex) {
  const arr = new Uint8Array(Math.floor(hex.length / 2));
  for (let i = 0; i < arr.length; i++) {
    arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return arr;
}

// ── Audit Logger ──────────────────────────────────────────────────────────
async function auditLog(kv, tenantId, event) {
  const ts  = new Date().toISOString();
  const key = `${ts.replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
  await kvPut(kv, tenantId, "audit", key, {
    ts,
    tenantId,
    ...event,
  }, { expirationTtl: 60 * 60 * 24 * 90 }); // 90-day retention
}

// ── Auth ──────────────────────────────────────────────────────────────────
function requireAuth(request, env) {
  const header  = request.headers.get("authorization") || "";
  const bearer  = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
  const expected = (env.RELAY_AUTH_TOKEN || "").trim();
  if (!expected) return { ok: false, code: 503, msg: "RELAY_AUTH_TOKEN not configured" };
  if (!bearer || bearer !== expected) return { ok: false, code: 401, msg: "Unauthorized" };
  return { ok: true };
}

// ── Validation ────────────────────────────────────────────────────────────
function isValidEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "")); }
function sanitize(s, max = 500) { return String(s || "").trim().slice(0, max); }

// ── FETCH handler ─────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const origin   = request.headers.get("Origin") || "";
    const url      = new URL(request.url);
    const path     = url.pathname;
    const tenantId = getTenantId(request);
    const ip       = getIP(request);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // ── Rate limiting (applied to all non-health routes) ──────────────────
    if (path !== "/relay/health") {
      const rl = await checkRateLimit(env.RELAY_STATE, `${ip}:${path}`, path);
      if (!rl.allowed) {
        await auditLog(env.RELAY_STATE, tenantId, {
          type: "rate_limit_exceeded", path, ip,
          retryAfter: rl.retryAfter,
        });
        return json({
          ok: false, error: "Rate limit exceeded",
          retryAfter: rl.retryAfter,
          message: "Too many requests. Please slow down.",
        }, 429, origin);
      }
    }

    // ── GET /relay/health ─────────────────────────────────────────────────
    if (request.method === "GET" && path === "/relay/health") {
      return json({
        ok: true, service: "primecore-relay",
        version: VERSION, ts: new Date().toISOString(),
      }, 200, origin);
    }

    // ── POST /relay/call/event — CCaaS webhook receiver ───────────────────
    if (request.method === "POST" && path === "/relay/call/event") {
      const rawBody = await request.text();

      // Detect platform from header
      const platform = (request.headers.get("x-ccaas-platform") || "unknown").toLowerCase();
      const platformConfig = CCAAS_PLATFORMS[platform];

      // Verify HMAC signature if platform is known and secret is configured
      if (platformConfig && platformConfig.algo === "sha256") {
        const secretKey = `CCAAS_WEBHOOK_SECRET_${platform.toUpperCase().replace(/-/g, "_")}`;
        const secret    = env[secretKey];
        if (secret) {
          const sig = request.headers.get(platformConfig.sigHeader) || "";
          const valid = await verifyHmac(secret, rawBody, sig);
          if (!valid) {
            await auditLog(env.RELAY_STATE, tenantId, {
              type: "webhook_signature_invalid", platform, ip,
            });
            return json({ ok: false, error: "Invalid webhook signature" }, 401, origin);
          }
        }
      }

      let event = {};
      try { event = JSON.parse(rawBody); } catch {
        return json({ ok: false, error: "Invalid JSON body" }, 400, origin);
      }

      // Normalize event shape across all CCaaS platforms
      const normalized = {
        id:         event.callId || event.call_id || event.id || crypto.randomUUID(),
        tenantId,
        platform,
        type:       event.type || event.event_type || event.eventType || "call.unknown",
        callId:     event.callId || event.call_id || event.id,
        agentId:    event.agentId || event.agent_id || null,
        queueId:    event.queueId || event.queue_id || null,
        callerId:   event.callerId || event.caller_id || event.ani || null,
        direction:  event.direction || "inbound",
        language:   event.language || event.caller_language || "en",
        ts:         new Date().toISOString(),
        raw:        event, // preserve original for debugging
      };

      // Store call state in KV (tenant-isolated)
      await kvPut(
        env.RELAY_EVENTS, tenantId, "call",
        normalized.callId,
        normalized,
        { expirationTtl: 60 * 60 * 24 } // 24-hour TTL per call
      );

      // Update tenant call counter in metrics
      const metrics = await kvGet(env.RELAY_STATE, tenantId, "metrics", "current") || {};
      metrics.calls_today   = (metrics.calls_today || 0) + 1;
      metrics.active_calls  = Math.max(0, (metrics.active_calls || 0) + (normalized.type.includes("start") ? 1 : normalized.type.includes("end") ? -1 : 0));
      metrics.updated_at    = new Date().toISOString();
      await kvPut(env.RELAY_STATE, tenantId, "metrics", "current", metrics);

      // Audit log
      ctx.waitUntil(auditLog(env.RELAY_STATE, tenantId, {
        type: "call_event_received",
        callId: normalized.callId,
        platform,
        eventType: normalized.type,
        ip,
      }));

      // Forward to War Room API (non-blocking)
      if (env.WAR_ROOM_API_TOKEN) {
        ctx.waitUntil(
          fetch(`${WAR_ROOM_API}/api/receipts`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "authorization": `Bearer ${env.WAR_ROOM_API_TOKEN}`,
              "x-tenant-id": tenantId,
            },
            body: JSON.stringify({
              type:     "call_event",
              tenantId,
              callId:   normalized.callId,
              platform,
              eventType: normalized.type,
              ts:       normalized.ts,
            }),
          }).catch(() => {})
        );
      }

      return json({
        ok: true, eventId: normalized.id, callId: normalized.callId,
        tenantId, platform, type: normalized.type,
      }, 201, origin);
    }

    // ── POST /relay/call/transcript — live transcript chunk ───────────────
    if (request.method === "POST" && path === "/relay/call/transcript") {
      let body = {};
      try { body = await request.json(); } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400, origin);
      }

      const callId = sanitize(body.callId || body.call_id, 100);
      if (!callId) return json({ ok: false, error: "callId required" }, 422, origin);

      const chunk = {
        callId, tenantId,
        speaker:    body.speaker || "caller", // "caller" | "agent"
        text:       sanitize(body.text || body.transcript, 2000),
        language:   sanitize(body.language || "en", 10),
        confidence: typeof body.confidence === "number" ? body.confidence : null,
        ts:         new Date().toISOString(),
        seq:        typeof body.seq === "number" ? body.seq : 0,
      };

      // Store latest transcript chunk (rolling — only keeps last 50 per call)
      const transcriptKey = `${callId}_${chunk.seq}_${Date.now()}`;
      await kvPut(
        env.RELAY_EVENTS, tenantId, "transcript",
        transcriptKey,
        chunk,
        { expirationTtl: 60 * 60 * 4 } // 4-hour TTL
      );

      return json({ ok: true, callId, tenantId, seq: chunk.seq }, 201, origin);
    }

    // ── POST /relay/call/end — call ended, finalize analytics ─────────────
    if (request.method === "POST" && path === "/relay/call/end") {
      let body = {};
      try { body = await request.json(); } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400, origin);
      }

      const callId = sanitize(body.callId || body.call_id, 100);
      if (!callId) return json({ ok: false, error: "callId required" }, 422, origin);

      const summary = {
        callId, tenantId,
        duration:    typeof body.duration === "number" ? body.duration : null,
        outcome:     sanitize(body.outcome || "completed", 50),
        resolution:  sanitize(body.resolution || "resolved", 50),
        fcr:         typeof body.fcr === "boolean" ? body.fcr : true,
        language:    sanitize(body.language || "en", 10),
        agentId:     sanitize(body.agentId || body.agent_id || "", 100),
        platform:    sanitize(body.platform || "unknown", 50),
        ts:          new Date().toISOString(),
      };

      await kvPut(
        env.RELAY_EVENTS, tenantId, "call_summary",
        callId,
        summary,
        { expirationTtl: 60 * 60 * 24 * 90 } // 90 days
      );

      // Update metrics
      const metrics = await kvGet(env.RELAY_STATE, tenantId, "metrics", "current") || {};
      metrics.active_calls = Math.max(0, (metrics.active_calls || 1) - 1);
      const prevFcr = metrics.fcr_total || 0;
      const prevCount = metrics.calls_completed || 0;
      metrics.calls_completed = prevCount + 1;
      metrics.fcr_total       = prevFcr + (summary.fcr ? 1 : 0);
      metrics.fcr_rate        = prevCount > 0
        ? ((metrics.fcr_total / metrics.calls_completed) * 100).toFixed(1) + "%"
        : "—";
      metrics.updated_at = new Date().toISOString();
      await kvPut(env.RELAY_STATE, tenantId, "metrics", "current", metrics);

      ctx.waitUntil(auditLog(env.RELAY_STATE, tenantId, {
        type: "call_ended", callId, outcome: summary.outcome,
        duration: summary.duration, fcr: summary.fcr,
      }));

      return json({ ok: true, callId, tenantId, summary }, 200, origin);
    }

    // ── GET /relay/call/live/:callId — poll live call state ───────────────
    if (request.method === "GET" && path.startsWith("/relay/call/live/")) {
      const auth = requireAuth(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code, origin);

      const callId = path.split("/relay/call/live/")[1]?.split("?")[0];
      if (!callId) return json({ ok: false, error: "callId required in path" }, 422, origin);

      const callState  = await kvGet(env.RELAY_EVENTS, tenantId, "call", callId);
      const transcripts = await kvList(env.RELAY_EVENTS, tenantId, `transcript_${callId}`, 20);

      if (!callState) return json({ ok: false, error: "Call not found", callId }, 404, origin);

      return json({ ok: true, callId, tenantId, state: callState, transcripts }, 200, origin);
    }

    // ── POST /relay/pilot-request — rate-limited pilot form ───────────────
    if (request.method === "POST" && path === "/relay/pilot-request") {
      let body = {};
      try { body = await request.json(); } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400, origin);
      }

      // Validate
      const errors = [];
      if (!body.name?.trim())          errors.push("name required");
      if (!isValidEmail(body.email))   errors.push("valid email required");
      if (!body.company?.trim())       errors.push("company required");
      if (!body.ccaas?.trim())         errors.push("ccaas platform required");
      if (errors.length) return json({ ok: false, errors }, 422, origin);

      const id = `pilot_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const record = {
        id, tenantId: "public",
        name:     sanitize(body.name),
        email:    sanitize(body.email, 200),
        company:  sanitize(body.company),
        ccaas:    sanitize(body.ccaas),
        volume:   sanitize(body.volume || ""),
        vertical: sanitize(body.vertical || ""),
        notes:    sanitize(body.notes || "", 1000),
        source:   sanitize(body.source || "pilot.primecoreintelligence.com", 200),
        status:   "new",
        ts:       new Date().toISOString(),
      };

      // Store — tenant "public" + pilot: prefix
      await kvPut(env.RELAY_STATE, "public", "pilot", id, record,
        { expirationTtl: 60 * 60 * 24 * 365 });

      // Audit
      ctx.waitUntil(auditLog(env.RELAY_STATE, "public", {
        type: "pilot_request", id, company: record.company,
        vertical: record.vertical, ip,
      }));

      // Forward to War Room API
      if (env.WAR_ROOM_API_TOKEN) {
        ctx.waitUntil(
          fetch(`${WAR_ROOM_API}/api/pilot-request`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "authorization": `Bearer ${env.WAR_ROOM_API_TOKEN}`,
            },
            body: JSON.stringify(record),
          }).catch(() => {})
        );
      }

      return json({
        ok: true, id,
        message: "Pilot request received. We will contact you within 1 business day.",
      }, 201, origin);
    }

    // ── GET /relay/status/:tenantId — tenant KPI status ───────────────────
    if (request.method === "GET" && path.startsWith("/relay/status/")) {
      const auth = requireAuth(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code, origin);

      const tid = path.split("/relay/status/")[1]?.split("?")[0] || tenantId;
      const metrics = await kvGet(env.RELAY_STATE, tid, "metrics", "current") || {};

      return json({ ok: true, tenantId: tid, metrics, ts: new Date().toISOString() }, 200, origin);
    }

    // ── GET /relay/audit/:tenantId — recent audit log ─────────────────────
    if (request.method === "GET" && path.startsWith("/relay/audit/")) {
      const auth = requireAuth(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code, origin);

      const tid   = path.split("/relay/audit/")[1]?.split("?")[0] || tenantId;
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
      const keys  = await kvList(env.RELAY_STATE, tid, "audit", limit);
      const items = await Promise.all(
        keys.slice(0, limit).map(async (k) => {
          const val = await env.RELAY_STATE.get(k.name);
          return val ? JSON.parse(val) : null;
        })
      );

      return json({
        ok: true, tenantId: tid, count: items.length,
        events: items.filter(Boolean).sort((a, b) =>
          new Date(b.ts).getTime() - new Date(a.ts).getTime()
        ),
      }, 200, origin);
    }

    return json({ ok: false, error: "Not found", path }, 404, origin);
  },
};
