/**
 * PrimeCore Intelligence — Workers Relay v2.0
 * api-relay.primecoreintelligence.com
 *
 * Adds to v1.0:
 *   6. Durable Object WebSocket — TeleprompterSession (global, not localhost)
 *   7. ROI Engine — live calculation during outbound sales calls
 *   8. Outbound call engine — POST /relay/call/outbound
 *   9. Teleprompter push — POST /relay/teleprompter/push/:sessionId
 *  10. Teleprompter WS  — GET  /relay/teleprompter/ws/:sessionId (Upgrade)
 *  11. Live call poll   — GET  /relay/call/live/:callId
 *  12. Tenant metrics   — GET  /relay/status/:tenantId
 *  13. Audit log        — GET  /relay/audit/:tenantId
 */

"use strict";

const WAR_ROOM_API = "https://api.primecoreintelligence.com";
const VERSION      = "2.0.0";

// ── Rate limits ───────────────────────────────────────────────────────────
const LIMITS = {
  "/relay/pilot-request":      { max: 3,    window: 3600 },
  "/relay/call/event":         { max: 500,  window: 300  },
  "/relay/call/transcript":    { max: 2000, window: 300  },
  "/relay/call/end":           { max: 100,  window: 300  },
  "/relay/call/outbound":      { max: 200,  window: 300  },
  "/relay/teleprompter/push":  { max: 1000, window: 300  },
  "default":                   { max: 60,   window: 300  },
};

// ── CCaaS platforms ───────────────────────────────────────────────────────
const CCAAS_PLATFORMS = {
  five9:       { sigHeader: "x-five9-signature",   algo: "sha256" },
  genesys:     { sigHeader: "x-genesys-signature", algo: "sha256" },
  "3cx":       { sigHeader: "x-3cx-webhook-token", algo: "plain"  },
  ringcentral: { sigHeader: "x-ringcentral-token", algo: "plain"  },
  bliss:       { sigHeader: "x-bliss-signature",   algo: "sha256" },
  atento:      { sigHeader: "x-atento-token",      algo: "plain"  },
};

// ── ROI benchmarks (matches marketing ROI calculator exactly) ─────────────
const ROI_BENCHMARKS = {
  logistics:  { fcr: 0.89, aht: 87,  costPerCall: 6.50, label: "Logistics / 3PL"    },
  healthcare: { fcr: 0.82, aht: 120, costPerCall: 9.20, label: "Healthcare"          },
  financial:  { fcr: 0.79, aht: 105, costPerCall: 8.80, label: "Financial Services"  },
  retail:     { fcr: 0.87, aht: 72,  costPerCall: 5.40, label: "Retail / E-commerce" },
  fleet:      { fcr: 0.85, aht: 95,  costPerCall: 7.10, label: "Fleet / Dispatch"    },
  bpo:        { fcr: 0.83, aht: 102, costPerCall: 6.90, label: "BPO Operations"      },
  default:    { fcr: 0.84, aht: 95,  costPerCall: 7.00, label: "General"             },
};

const PLANS = [
  { name: "Starter",      monthly: 2400, pilotPrice: 1200, maxCalls: 5000   },
  { name: "Professional", monthly: 5800, pilotPrice: 2900, maxCalls: 20000  },
  { name: "Enterprise",   monthly: 7997, pilotPrice: 3999, maxCalls: 999999 },
];

// ── CORS ──────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = new Set([
  "https://primecoreintelligence.com",
  "https://www.primecoreintelligence.com",
  "https://warroom.primecoreintelligence.com",
  "https://pilot.primecoreintelligence.com",
  "https://app.primecoreintelligence.com",
  "https://assist.primecoreintelligence.com",
  "https://api.primecoreintelligence.com",
  "https://primebpo.primecoreintelligence.com",
]);

function corsHeaders(origin) {
  const h = {
    "access-control-allow-methods":  "GET,POST,PUT,DELETE,OPTIONS",
    "access-control-allow-headers":  "content-type, authorization, x-tenant-id, x-request-id, upgrade, connection",
    "access-control-max-age":        "86400",
    "vary":                          "Origin",
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["access-control-allow-origin"] = origin;
  return h;
}

// ── Helpers ───────────────────────────────────────────────────────────────
function json(obj, status = 200, origin = "") {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type":       "application/json; charset=utf-8",
      "x-relay-version":    VERSION,
      "x-relay-request-id": crypto.randomUUID(),
      "x-relay-ts":         new Date().toISOString(),
      ...corsHeaders(origin),
    },
  });
}

function getIP(req)       { return req.headers.get("cf-connecting-ip") || "unknown"; }
function getTenantId(req) { return (req.headers.get("x-tenant-id") || "").trim() || new URL(req.url).searchParams.get("tenant_id") || "public"; }
function sanitize(s, max = 500) { return String(s || "").trim().slice(0, max); }
function isValidEmail(s)  { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "")); }

// ── Tenant KV keys ────────────────────────────────────────────────────────
function tenantKey(tenantId, category, key) {
  const tid = String(tenantId || "public").replace(/[^a-z0-9\-_]/gi, "_").slice(0, 40);
  return `tenant:${tid}:${category}:${String(key).replace(/[^a-z0-9\-_.]/gi,"_").slice(0,100)}`;
}

async function kvGet(kv, tenantId, cat, key) {
  if (!kv) return null;
  try { const r = await kv.get(tenantKey(tenantId, cat, key)); return r ? JSON.parse(r) : null; }
  catch { return null; }
}

async function kvPut(kv, tenantId, cat, key, val, opts = {}) {
  if (!kv) return false;
  try { await kv.put(tenantKey(tenantId, cat, key), JSON.stringify(val), opts); return true; }
  catch { return false; }
}

async function kvList(kv, tenantId, cat, limit = 50) {
  if (!kv) return [];
  try { return (await kv.list({ prefix: `tenant:${tenantId}:${cat}:`, limit })).keys || []; }
  catch { return []; }
}

// ── Rate limiting ─────────────────────────────────────────────────────────
async function rateLimit(kv, ip, path) {
  const rule  = LIMITS[path] || LIMITS["default"];
  const nowSec = Math.floor(Date.now() / 1000);
  const slot   = Math.floor(nowSec / rule.window);
  const key    = `rl:${ip.replace(/[.:]/g,"_")}:${path.replace(/\//g,"_")}:${slot}`;
  if (!kv) return { ok: true };
  try {
    const raw   = await kv.get(key);
    const count = raw ? parseInt(raw, 10) + 1 : 1;
    if (count > rule.max) return { ok: false, retryAfter: rule.window - (nowSec % rule.window) };
    await kv.put(key, String(count), { expirationTtl: rule.window * 2 });
    return { ok: true };
  } catch { return { ok: true }; }
}

// ── HMAC verification ─────────────────────────────────────────────────────
async function verifyHmac(secret, body, sig) {
  try {
    const key  = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name:"HMAC", hash:"SHA-256" }, false, ["verify"]);
    const clean = sig.replace(/^sha256=/i, "");
    const bytes = Uint8Array.from(clean.match(/.{2}/g).map(b => parseInt(b, 16)));
    return await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body));
  } catch { return false; }
}

// ── Auth ──────────────────────────────────────────────────────────────────
function requireAuth(req, env) {
  const h = req.headers.get("authorization") || "";
  const bearer = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : null;
  const expected = (env.RELAY_AUTH_TOKEN || "").trim();
  if (!expected) return { ok: false, code: 503, msg: "RELAY_AUTH_TOKEN not configured" };
  if (!bearer || bearer !== expected) return { ok: false, code: 401, msg: "Unauthorized" };
  return { ok: true };
}

// ── ROI Engine ────────────────────────────────────────────────────────────
function computeROI(opts) {
  const {
    industry   = "default",
    volume     = 0,      // monthly calls
    agents     = 0,      // agents handling calls
    agentCost  = 1800,   // per agent/month fully loaded
  } = opts;

  const bench = ROI_BENCHMARKS[industry] || ROI_BENCHMARKS["default"];

  // Plan selection
  let plan = PLANS[0];
  if (volume > 5000)  plan = PLANS[1];
  if (volume > 20000) plan = PLANS[2];

  // Calculations
  const aiCallsHandled     = Math.round(volume * bench.fcr);
  const totalAgentCost     = agents * agentCost;
  const hoursPerMonth      = 160;
  const callsPerHour       = 60 / (bench.aht / 60);
  const callsPerAgent      = hoursPerMonth * callsPerHour;
  const costPerCallCurrent = agents > 0 ? (agentCost / callsPerAgent) : bench.costPerCall;
  const laborSaved         = aiCallsHandled * costPerCallCurrent;
  const aiOpsCost          = aiCallsHandled * 0.04;
  const netMonthly         = laborSaved - plan.monthly;
  const roi3yr             = (netMonthly * 36) - (plan.monthly * 36);
  const breakEvenMonth     = netMonthly > 0 ? 1 : Math.ceil(plan.monthly / (laborSaved || 1));
  const hoursFreed         = Math.round(aiCallsHandled / callsPerHour);

  return {
    industry,
    volume,
    agents,
    agentCost,
    bench: { fcr: bench.fcr, aht: bench.aht, label: bench.label },
    plan: { name: plan.name, monthly: plan.monthly, pilotPrice: plan.pilotPrice },
    aiCallsHandled,
    humanCallsLeft: volume - aiCallsHandled,
    totalAgentCost,
    laborSaved: Math.round(laborSaved),
    aiOpsCost:  Math.round(aiOpsCost),
    netMonthly: Math.round(netMonthly),
    annualBenefit: Math.round(netMonthly * 12),
    roi3yr:     Math.round(roi3yr),
    hoursFreed,
    breakEvenMonth,
    costPerCallCurrent: Math.round(costPerCallCurrent * 100) / 100,
    costPerCallAI: 0.04,
    computedAt: new Date().toISOString(),
  };
}

// Generates a complete teleprompter payload for an outbound sales call
function buildTeleprompterPayload(opts) {
  const { roi, prospect, stage = 0, callerLanguage = "es" } = opts;
  const { plan, netMonthly, laborSaved, breakEvenMonth } = roi;

  const fmt = (n) => n >= 1000 ? "$" + Math.round(n/1000) + "K" : "$" + n;

  // Stage-based guidance
  const stages = [
    {
      goal: "qualify_volume",
      short: `Great — at that volume, we're looking at ${fmt(laborSaved)}/mo in savings.`,
      clear: `That puts you in our ${plan.name} tier at $${plan.monthly.toLocaleString()}/month. Net benefit after plan cost: ${fmt(netMonthly)}/month.`,
      complete: `Let me send you the exact breakdown right now so you can show your finance team the numbers before our next call. Does that work?`,
      tone: "confident_close",
    },
    {
      goal: "present_roi",
      short: `Your ROI: ${fmt(netMonthly)}/month net — break-even in Month ${breakEvenMonth}.`,
      clear: `Based on your volume and industry, PrimeCore handles ${Math.round(roi.bench.fcr * 100)}% of calls autonomously. That's ${roi.aiCallsHandled.toLocaleString()} calls/month at $0.04 each vs your current $${roi.costPerCallCurrent.toFixed(2)}.`,
      complete: `The pilot is $${plan.pilotPrice.toLocaleString()} for Month 1 — 50% off. Shadow mode: AI runs alongside your team with zero side effects. You see the actual FCR numbers before committing.`,
      tone: "confident_close",
    },
    {
      goal: "close_pilot",
      short: `I'm sending the pilot agreement now — 2 pages, DocuSign.`,
      clear: `${plan.name} pilot: $${plan.pilotPrice.toLocaleString()} Month 1. Deploy in 48 hours. Shadow mode — no production side effects until you approve. Cancel before Day 30, no Month 2 charge.`,
      complete: `Once you sign, Paddle sends the payment link in your currency. We're live within 48 hours. Any questions before I hit send?`,
      tone: "confident_close",
    },
    {
      goal: "handle_objection",
      short: `Let me flip the math for you.`,
      clear: `At your current cost per call ($${roi.costPerCallCurrent.toFixed(2)}), you're spending ${fmt(roi.totalAgentCost)}/month on calls PrimeCore handles at $0.04 each. The question isn't whether ${plan.monthly.toLocaleString()} is expensive — it's whether saving ${fmt(netMonthly)}/month net is worth it.`,
      complete: `Most clients break even in week one of the pilot. The 30-day shadow mode means you see those exact numbers from your own calls before any production decision.`,
      tone: "objection_reframe",
    },
  ];

  const s = stages[Math.min(stage, stages.length - 1)];

  return {
    schema_version: "teleprompter.v1.1",
    display_payload: {
      timestamp:              Math.floor(Date.now() / 1000),
      clarity_goal:           s.goal,
      caller_language:        callerLanguage,
      caller_text_original:   prospect?.lastStatement || "",
      caller_text_translation: prospect?.lastStatementTranslated || "",
      reply_short:            s.short,
      reply_clear:            s.clear,
      reply_complete:         s.complete,
      tone_hint:              s.tone,
      risk_flags:             prospect?.riskFlags || [],
      caller_memory:          prospect?.crmLine || `${prospect?.company || "Prospect"} · ${roi.volume.toLocaleString()} calls/mo · ${roi.bench.label}`,
      deal_probability:       { current: stage >= 2 ? 0.78 : stage >= 1 ? 0.55 : 0.32, trend: "+7%" },
      recommended_package:    plan.name.toLowerCase(),
      stage_index:            stage,
      roi: {
        netMonthly:      roi.netMonthly,
        laborSaved:      roi.laborSaved,
        planCost:        roi.plan.monthly,
        pilotPrice:      roi.plan.pilotPrice,
        breakEvenMonth:  roi.breakEvenMonth,
        fcr:             roi.bench.fcr,
        aiCallsHandled:  roi.aiCallsHandled,
        costPerCallNow:  roi.costPerCallCurrent,
      },
      quick_actions: [
        { id: "send_roi_pdf",     label: "📊 Send ROI PDF"    },
        { id: "send_pilot_link",  label: "🚀 Send Pilot Link" },
        { id: "send_payment",     label: "💳 Paddle Payment"  },
        { id: "docusign_now",     label: "✍ DocuSign Now"     },
        { id: "alex_close",       label: "🤖 Alex Closes"     },
      ],
    },
  };
}

// ── Audit logger ──────────────────────────────────────────────────────────
async function auditLog(kv, tenantId, event) {
  const ts  = new Date().toISOString();
  const key = `${ts.replace(/[:.]/g, "-")}_${crypto.randomUUID().slice(0, 8)}`;
  await kvPut(kv, tenantId, "audit", key, { ts, tenantId, ...event }, { expirationTtl: 60 * 60 * 24 * 90 });
}

// ── Email via MailChannels ────────────────────────────────────────────────
async function sendEmail(env, { to, subject, body, replyTo }) {
  try {
    const resp = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: "noreply@primecoreintelligence.com", name: "PrimeCore Intelligence" },
        reply_to: replyTo ? { email: replyTo } : undefined,
        subject,
        content: [{ type: "text/plain", value: body }],
      }),
    });
    return resp.status === 202;
  } catch { return false; }
}

// ═════════════════════════════════════════════════════════════════════════
// DURABLE OBJECT — TeleprompterSession
// Each sales rep / session gets their own DO instance.
// Clients connect via WebSocket. Push endpoint broadcasts to all clients.
// ═════════════════════════════════════════════════════════════════════════
export class TeleprompterSession {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;
    this.clients = new Set(); // connected WebSocket clients
  }

  async fetch(request) {
    const url    = new URL(request.url);
    const action = url.searchParams.get("action") || "connect";

    // ── WebSocket upgrade (browsers / overlay connect here) ──────────────
    if (action === "connect") {
      const upgrade = request.headers.get("upgrade") || "";
      if (upgrade.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket upgrade", { status: 426 });
      }

      const [client, server] = Object.values(new WebSocketPair());
      server.accept();

      // Send last known payload immediately on connect
      const lastPayload = await this.state.storage.get("last_payload");
      if (lastPayload) {
        server.send(JSON.stringify(lastPayload));
      } else {
        server.send(JSON.stringify({ type: "connected", message: "PrimeCore Teleprompter ready" }));
      }

      this.clients.add(server);

      server.addEventListener("message", (evt) => {
        // Heartbeat / ack from client
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === "heartbeat") server.send(JSON.stringify({ type: "pong", ts: Date.now() }));
        } catch {}
      });

      server.addEventListener("close", () => { this.clients.delete(server); });
      server.addEventListener("error", () => { this.clients.delete(server); });

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Push payload (called by relay fetch handler) ──────────────────────
    if (action === "push" && request.method === "POST") {
      const payload = await request.json();

      // Store for late-joining clients
      await this.state.storage.put("last_payload", payload);
      await this.state.storage.setAlarm(Date.now() + 4 * 60 * 60 * 1000); // 4h cleanup

      // Broadcast to all connected clients
      const dead = [];
      for (const ws of this.clients) {
        try {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(payload));
          } else {
            dead.push(ws);
          }
        } catch { dead.push(ws); }
      }
      dead.forEach(ws => this.clients.delete(ws));

      return new Response(JSON.stringify({ ok: true, delivered: this.clients.size }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }

  // Cleanup stale sessions
  async alarm() {
    await this.state.storage.deleteAll();
    this.clients.forEach(ws => { try { ws.close(); } catch {} });
    this.clients.clear();
  }
}

// ═════════════════════════════════════════════════════════════════════════
// MAIN FETCH HANDLER
// ═════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const origin   = request.headers.get("Origin") || "";
    const url      = new URL(request.url);
    const path     = url.pathname;
    const tenantId = getTenantId(request);
    const ip       = getIP(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Health — no rate limit
    if (path === "/relay/health") {
      return json({ ok: true, service: "primecore-relay", version: VERSION, ts: new Date().toISOString() });
    }

    // Rate limiting
    const rl = await rateLimit(env.RELAY_STATE, ip, path);
    if (!rl.ok) {
      return json({ ok: false, error: "Rate limit exceeded", retryAfter: rl.retryAfter, path }, 429, origin);
    }

    // ══════════════════════════════════════════════════════════════════════
    // TELEPROMPTER — Durable Object WebSocket
    // GET  /relay/teleprompter/ws/:sessionId  — WebSocket upgrade
    // POST /relay/teleprompter/push/:sessionId — Push payload to session
    // POST /relay/teleprompter/roi/:sessionId  — Compute ROI + push
    // ══════════════════════════════════════════════════════════════════════

    if (path.startsWith("/relay/teleprompter/")) {
      const parts     = path.split("/").filter(Boolean); // ["relay","teleprompter","ws","sessionId"]
      const action    = parts[2]; // "ws" | "push" | "roi"
      const sessionId = parts[3] || "default";

      if (!env.TELEPROMPTER_SESSION) {
        return json({ ok: false, error: "TELEPROMPTER_SESSION Durable Object not configured" }, 503, origin);
      }

      const doId  = env.TELEPROMPTER_SESSION.idFromName(sessionId);
      const doStub = env.TELEPROMPTER_SESSION.get(doId);

      // ── WebSocket connection ────────────────────────────────────────────
      if (action === "ws") {
        // Forward WebSocket upgrade to Durable Object
        return doStub.fetch(new Request(
          `https://internal/teleprompter?action=connect&sessionId=${sessionId}`,
          { headers: request.headers }
        ));
      }

      // ── Push raw payload ────────────────────────────────────────────────
      if (action === "push" && request.method === "POST") {
        const auth = requireAuth(request, env);
        if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code, origin);

        let payload = {};
        try { payload = await request.json(); } catch {
          return json({ ok: false, error: "Invalid JSON" }, 400, origin);
        }

        const resp = await doStub.fetch(new Request("https://internal/teleprompter?action=push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }));
        const result = await resp.json();
        return json({ ok: true, sessionId, ...result }, 200, origin);
      }

      // ── ROI computation + push ──────────────────────────────────────────
      if (action === "roi" && request.method === "POST") {
        const auth = requireAuth(request, env);
        if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code, origin);

        let body = {};
        try { body = await request.json(); } catch {
          return json({ ok: false, error: "Invalid JSON" }, 400, origin);
        }

        // Compute ROI
        const roi = computeROI({
          industry:   body.industry   || "default",
          volume:     Number(body.volume  || 0),
          agents:     Number(body.agents  || 0),
          agentCost:  Number(body.agentCost || 1800),
        });

        // Build full teleprompter payload with ROI embedded
        const payload = buildTeleprompterPayload({
          roi,
          prospect: body.prospect || {},
          stage:    Number(body.stage || 0),
          callerLanguage: body.callerLanguage || "es",
        });

        // Push to Durable Object
        await doStub.fetch(new Request("https://internal/teleprompter?action=push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        }));

        // Store ROI in KV for session history
        ctx.waitUntil(
          kvPut(env.RELAY_STATE, tenantId, "roi", sessionId, { roi, pushedAt: new Date().toISOString() },
            { expirationTtl: 60 * 60 * 8 }) // 8h TTL per session
        );

        return json({ ok: true, sessionId, roi, payload }, 200, origin);
      }

      return json({ ok: false, error: "Unknown teleprompter action", action }, 404, origin);
    }

    // ══════════════════════════════════════════════════════════════════════
    // OUTBOUND CALL ENGINE
    // POST /relay/call/outbound — schedule or initiate an outbound call
    // ══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/relay/call/outbound") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code, origin);

      let body = {};
      try { body = await request.json(); } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400, origin);
      }

      // Validate required fields
      const errors = [];
      if (!body.to?.trim())       errors.push("to (phone number or contact ID) required");
      if (!body.callType?.trim()) errors.push("callType required: follow_up | callback | campaign | csat");
      if (errors.length) return json({ ok: false, errors }, 422, origin);

      const VALID_CALL_TYPES = ["follow_up", "callback", "campaign", "csat", "reminder", "pilot_follow_up"];
      if (!VALID_CALL_TYPES.includes(body.callType)) {
        return json({ ok: false, error: `Invalid callType. Must be: ${VALID_CALL_TYPES.join(", ")}` }, 422, origin);
      }

      const callId = `out_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const record = {
        id:         callId,
        tenantId,
        to:         sanitize(body.to),
        callType:   sanitize(body.callType),
        industry:   sanitize(body.industry || "default"),
        volume:     Number(body.volume || 0),
        agents:     Number(body.agents || 0),
        agentCost:  Number(body.agentCost || 1800),
        language:   sanitize(body.language || "es"),
        contactName: sanitize(body.contactName || ""),
        company:    sanitize(body.company || ""),
        notes:      sanitize(body.notes || "", 500),
        status:     "queued",
        scheduledAt: body.scheduledAt || new Date().toISOString(),
        createdAt:  new Date().toISOString(),
        platform:   sanitize(body.platform || "auto"),
        sessionId:  body.sessionId || callId, // teleprompter session to push ROI to
      };

      // Pre-compute ROI for this outbound call
      if (record.volume > 0) {
        record.roi = computeROI({
          industry:  record.industry,
          volume:    record.volume,
          agents:    record.agents,
          agentCost: record.agentCost,
        });
      }

      // Store outbound call record
      await kvPut(env.RELAY_EVENTS, tenantId, "outbound", callId, record,
        { expirationTtl: 60 * 60 * 24 * 30 }); // 30 days

      // Update outbound call counter
      const metrics = await kvGet(env.RELAY_STATE, tenantId, "metrics", "current") || {};
      metrics.outbound_queued = (metrics.outbound_queued || 0) + 1;
      await kvPut(env.RELAY_STATE, tenantId, "metrics", "current", metrics);

      // Audit
      ctx.waitUntil(auditLog(env.RELAY_STATE, tenantId, {
        type: "outbound_call_queued", callId, callType: record.callType,
        to: record.to, company: record.company, ip,
      }));

      // If this is a pilot follow-up, pre-push ROI to teleprompter session
      if (record.roi && env.TELEPROMPTER_SESSION) {
        const doId   = env.TELEPROMPTER_SESSION.idFromName(record.sessionId);
        const doStub = env.TELEPROMPTER_SESSION.get(doId);
        const payload = buildTeleprompterPayload({
          roi:      record.roi,
          prospect: { company: record.company, crmLine: `${record.company} · ${record.volume.toLocaleString()} calls/mo · ${record.language.toUpperCase()}` },
          stage:    0,
          callerLanguage: record.language,
        });
        ctx.waitUntil(
          doStub.fetch(new Request("https://internal/teleprompter?action=push", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })).catch(() => {})
        );
      }

      // Forward to War Room API
      if (env.WAR_ROOM_API_TOKEN) {
        ctx.waitUntil(
          fetch(`${WAR_ROOM_API}/api/receipts`, {
            method: "POST",
            headers: { "content-type":"application/json","authorization":`Bearer ${env.WAR_ROOM_API_TOKEN}`,"x-tenant-id":tenantId },
            body: JSON.stringify({ type:"outbound_call_queued", tenantId, callId, callType:record.callType, company:record.company }),
          }).catch(() => {})
        );
      }

      return json({ ok: true, callId, status: "queued", roi: record.roi || null, sessionId: record.sessionId }, 201, origin);
    }

    // ══════════════════════════════════════════════════════════════════════
    // ROI ENDPOINT (standalone — no teleprompter push)
    // POST /relay/roi — compute ROI for any prospect
    // ══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/relay/roi") {
      let body = {};
      try { body = await request.json(); } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400, origin);
      }
      const roi = computeROI({
        industry:  body.industry  || "default",
        volume:    Number(body.volume    || 0),
        agents:    Number(body.agents    || 0),
        agentCost: Number(body.agentCost || 1800),
      });
      return json({ ok: true, roi }, 200, origin);
    }

    // ══════════════════════════════════════════════════════════════════════
    // INBOUND CCaaS WEBHOOK — POST /relay/call/event
    // ══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/relay/call/event") {
      const rawBody = await request.text();
      const platform = (request.headers.get("x-ccaas-platform") || "unknown").toLowerCase();
      const cfg = CCAAS_PLATFORMS[platform];

      if (cfg?.algo === "sha256") {
        const secretKey = `CCAAS_WEBHOOK_SECRET_${platform.toUpperCase().replace(/-/g,"_")}`;
        const secret = env[secretKey];
        if (secret) {
          const sig = request.headers.get(cfg.sigHeader) || "";
          if (!(await verifyHmac(secret, rawBody, sig))) {
            await auditLog(env.RELAY_STATE, tenantId, { type:"webhook_signature_invalid", platform, ip });
            return json({ ok: false, error: "Invalid webhook signature" }, 401, origin);
          }
        }
      }

      let event = {};
      try { event = JSON.parse(rawBody); } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400, origin);
      }

      const normalized = {
        id:       event.callId || event.id || crypto.randomUUID(),
        tenantId, platform,
        type:     event.type || event.event_type || "call.unknown",
        callId:   event.callId || event.call_id || event.id,
        agentId:  event.agentId || null,
        queueId:  event.queueId || null,
        callerId: event.callerId || event.ani || null,
        direction: event.direction || "inbound",
        language: event.language || "en",
        ts: new Date().toISOString(),
      };

      await kvPut(env.RELAY_EVENTS, tenantId, "call", normalized.callId, normalized,
        { expirationTtl: 60 * 60 * 24 });

      const metrics = await kvGet(env.RELAY_STATE, tenantId, "metrics", "current") || {};
      metrics.calls_today  = (metrics.calls_today || 0) + 1;
      metrics.active_calls = Math.max(0, (metrics.active_calls || 0) + (normalized.type.includes("start") ? 1 : normalized.type.includes("end") ? -1 : 0));
      metrics.updated_at   = new Date().toISOString();
      await kvPut(env.RELAY_STATE, tenantId, "metrics", "current", metrics);

      ctx.waitUntil(auditLog(env.RELAY_STATE, tenantId, {
        type:"call_event_received", callId:normalized.callId, platform, eventType:normalized.type, ip,
      }));

      if (env.WAR_ROOM_API_TOKEN) {
        ctx.waitUntil(fetch(`${WAR_ROOM_API}/api/receipts`, {
          method:"POST",
          headers:{"content-type":"application/json","authorization":`Bearer ${env.WAR_ROOM_API_TOKEN}`,"x-tenant-id":tenantId},
          body:JSON.stringify({type:"call_event",tenantId,callId:normalized.callId,platform,eventType:normalized.type,ts:normalized.ts}),
        }).catch(() => {}));
      }

      return json({ ok:true, eventId:normalized.id, callId:normalized.callId, tenantId, platform, type:normalized.type }, 201, origin);
    }

    // ══════════════════════════════════════════════════════════════════════
    // TRANSCRIPT — POST /relay/call/transcript
    // ══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/relay/call/transcript") {
      let body = {};
      try { body = await request.json(); } catch { return json({ ok:false, error:"Invalid JSON" }, 400, origin); }
      const callId = sanitize(body.callId || body.call_id, 100);
      if (!callId) return json({ ok:false, error:"callId required" }, 422, origin);

      const chunk = {
        callId, tenantId,
        speaker:    body.speaker || "caller",
        text:       sanitize(body.text || "", 2000),
        language:   sanitize(body.language || "en", 10),
        confidence: typeof body.confidence === "number" ? body.confidence : null,
        ts:         new Date().toISOString(),
        seq:        typeof body.seq === "number" ? body.seq : 0,
      };

      await kvPut(env.RELAY_EVENTS, tenantId, "transcript",
        `${callId}_${chunk.seq}_${Date.now()}`, chunk, { expirationTtl: 60 * 60 * 4 });

      return json({ ok:true, callId, tenantId, seq:chunk.seq }, 201, origin);
    }

    // ══════════════════════════════════════════════════════════════════════
    // CALL END — POST /relay/call/end
    // ══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/relay/call/end") {
      let body = {};
      try { body = await request.json(); } catch { return json({ ok:false, error:"Invalid JSON" }, 400, origin); }
      const callId = sanitize(body.callId || body.call_id, 100);
      if (!callId) return json({ ok:false, error:"callId required" }, 422, origin);

      const summary = {
        callId, tenantId,
        duration:   typeof body.duration === "number" ? body.duration : null,
        outcome:    sanitize(body.outcome || "completed", 50),
        resolution: sanitize(body.resolution || "resolved", 50),
        fcr:        typeof body.fcr === "boolean" ? body.fcr : true,
        language:   sanitize(body.language || "en", 10),
        agentId:    sanitize(body.agentId || "", 100),
        platform:   sanitize(body.platform || "unknown", 50),
        ts:         new Date().toISOString(),
      };

      await kvPut(env.RELAY_EVENTS, tenantId, "call_summary", callId, summary,
        { expirationTtl: 60 * 60 * 24 * 90 });

      const metrics = await kvGet(env.RELAY_STATE, tenantId, "metrics", "current") || {};
      metrics.active_calls     = Math.max(0, (metrics.active_calls || 1) - 1);
      metrics.calls_completed  = (metrics.calls_completed || 0) + 1;
      metrics.fcr_total        = (metrics.fcr_total || 0) + (summary.fcr ? 1 : 0);
      metrics.fcr_rate         = ((metrics.fcr_total / metrics.calls_completed) * 100).toFixed(1) + "%";
      metrics.updated_at       = new Date().toISOString();
      await kvPut(env.RELAY_STATE, tenantId, "metrics", "current", metrics);

      ctx.waitUntil(auditLog(env.RELAY_STATE, tenantId, {
        type:"call_ended", callId, outcome:summary.outcome, duration:summary.duration, fcr:summary.fcr,
      }));

      return json({ ok:true, callId, tenantId, summary }, 200, origin);
    }

    // ══════════════════════════════════════════════════════════════════════
    // PILOT REQUEST — POST /relay/pilot-request
    // ══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/relay/pilot-request") {
      let body = {};
      try { body = await request.json(); } catch { return json({ ok:false, error:"Invalid JSON" }, 400, origin); }

      const errors = [];
      if (!body.name?.trim())        errors.push("name required");
      if (!isValidEmail(body.email)) errors.push("valid email required");
      if (!body.company?.trim())     errors.push("company required");
      if (!body.ccaas?.trim())       errors.push("ccaas platform required");
      if (errors.length) return json({ ok:false, errors }, 422, origin);

      const id = `pilot_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const record = {
        id, tenantId:"public",
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

      // Pre-compute ROI if volume is provided
      if (body.volume) {
        const volNum = parseInt(String(body.volume).replace(/[^0-9]/g,""), 10);
        if (volNum > 0) {
          record.roi = computeROI({ industry: body.vertical || "default", volume: volNum });
        }
      }

      await kvPut(env.RELAY_STATE, "public", "pilot", id, record, { expirationTtl: 60*60*24*365 });

      ctx.waitUntil(auditLog(env.RELAY_STATE, "public", { type:"pilot_request", id, company:record.company, vertical:record.vertical, ip }));

      // Email notification
      if (env.NOTIFY_EMAIL || true) {
        const emailBody = `New Pilot Request\n\nName: ${record.name}\nEmail: ${record.email}\nCompany: ${record.company}\nCCaaS: ${record.ccaas}\nVolume: ${record.volume}\nVertical: ${record.vertical}\nNotes: ${record.notes}\n\nROI Preview: ${record.roi ? `$${record.roi.netMonthly.toLocaleString()}/mo net` : "pending"}\n\nSubmitted: ${record.ts}\nID: ${id}`;
        ctx.waitUntil(sendEmail(env, {
          to:      env.NOTIFY_EMAIL || "sales@primecoreintelligence.com",
          subject: `🚀 Pilot Request — ${record.company} (${record.vertical})`,
          body:    emailBody,
          replyTo: record.email,
        }));
      }

      if (env.WAR_ROOM_API_TOKEN) {
        ctx.waitUntil(fetch(`${WAR_ROOM_API}/api/pilot-request`, {
          method:"POST",
          headers:{"content-type":"application/json","authorization":`Bearer ${env.WAR_ROOM_API_TOKEN}`},
          body:JSON.stringify(record),
        }).catch(() => {}));
      }

      return json({ ok:true, id, roi:record.roi || null, message:"Pilot request received. We will contact you within 1 business day." }, 201, origin);
    }

    // ── Status / audit (auth required) ───────────────────────────────────
    if (request.method === "GET" && path.startsWith("/relay/status/")) {
      const auth = requireAuth(request, env);
      if (!auth.ok) return json({ ok:false, error:auth.msg }, auth.code, origin);
      const tid = path.split("/relay/status/")[1]?.split("?")[0] || tenantId;
      const metrics = await kvGet(env.RELAY_STATE, tid, "metrics", "current") || {};
      return json({ ok:true, tenantId:tid, metrics, ts:new Date().toISOString() }, 200, origin);
    }

    if (request.method === "GET" && path.startsWith("/relay/audit/")) {
      const auth = requireAuth(request, env);
      if (!auth.ok) return json({ ok:false, error:auth.msg }, auth.code, origin);
      const tid   = path.split("/relay/audit/")[1]?.split("?")[0] || tenantId;
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "20"), 100);
      const keys  = await kvList(env.RELAY_STATE, tid, "audit", limit);
      const items = await Promise.all(keys.slice(0, limit).map(async k => {
        const v = await env.RELAY_STATE.get(k.name);
        return v ? JSON.parse(v) : null;
      }));
      return json({ ok:true, tenantId:tid, count:items.length, events:items.filter(Boolean).sort((a,b)=>new Date(b.ts)-new Date(a.ts)) }, 200, origin);
    }

    if (request.method === "GET" && path.startsWith("/relay/call/live/")) {
      const auth = requireAuth(request, env);
      if (!auth.ok) return json({ ok:false, error:auth.msg }, auth.code, origin);
      const callId = path.split("/relay/call/live/")[1]?.split("?")[0];
      if (!callId) return json({ ok:false, error:"callId required" }, 422, origin);
      const callState = await kvGet(env.RELAY_EVENTS, tenantId, "call", callId);
      if (!callState) return json({ ok:false, error:"Call not found", callId }, 404, origin);
      return json({ ok:true, callId, tenantId, state:callState }, 200, origin);
    }

    return json({ ok:false, error:"Not found", path }, 404, origin);
  },
};
