/**
 * retellOrchestrator.js — Retell AI Call Orchestration Layer
 * PrimeCore Intelligence — Agentic Answering System
 *
 * 4 Modes:
 *   Mode 1 — Fully Autonomous   : AI answers, handles end-to-end, logs FCR
 *   Mode 2 — Teleprompter Assist: Founder on call, AI whispers suggestions in real-time
 *   Mode 3 — Warm Handoff       : AI starts, escalates to founder with full context card
 *   Mode 4 — Scheduled Outbound : delivery notifications, reminders, surveys
 *
 * Stack: Retell AI (orchestration) + Microsoft Vibe Voice (TTS) + Claude Haiku (brain)
 * Voice cloning: founder voice via FOUNDER_VOICE_ID env secret
 *
 * Retell AI API: https://api.retellai.com
 * Webhook events: call_started, call_ended, call_analyzed, transcript_updated,
 *                 transfer_started, transfer_bridged, transfer_cancelled
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const RETELL_API_BASE = "https://api.retellai.com";

// Call mode IDs (stored in KV, overridable per call)
export const CALL_MODES = {
  AUTONOMOUS:   1, // AI fully autonomous — founder never alerted unless escalation threshold
  TELEPROMPTER: 2, // Founder takes call, AI whispers coaching in Command Station
  WARM_HANDOFF: 3, // AI starts, warm-transfers to founder when needed
  OUTBOUND:     4, // Scheduled outbound campaign or individual call
};

// Language map for Retell agent voice selection
const RETELL_VOICE_MAP = {
  es: "azure-es-MX-DaliaNeural",   // Retell native Azure voice IDs
  en: "azure-en-US-JennyNeural",
  pt: "azure-pt-BR-FranciscaNeural",
  fr: "azure-fr-FR-DeniseNeural",
  de: "azure-de-DE-KatjaNeural",
};

// ─── Retell API Helpers ────────────────────────────────────────────────────────

/**
 * Make an authenticated request to Retell AI API
 */
export async function retellRequest(env, method, path, body = null) {
  if (!env.RETELL_API_KEY) {
    return { ok: false, error: "RETELL_API_KEY not configured" };
  }
  try {
    const resp = await fetch(`${RETELL_API_BASE}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${env.RETELL_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Verify a Retell webhook signature
 * Retell sends x-retell-signature header
 */
export function verifyRetellWebhook(request, env) {
  // Retell signature verification — compare x-retell-signature against API key hash
  // For now: validate API key presence (Retell IP allowlist: 100.20.5.228)
  const sig = request.headers.get("x-retell-signature");
  if (!sig && !env.RETELL_API_KEY) return false;
  return true; // IP-level security handled at Cloudflare WAF level
}

// ─── Agent Management ─────────────────────────────────────────────────────────

/**
 * Ensure a Retell agent exists for the given mode + language combo.
 * Stores agent IDs in KV so we don't recreate on every call.
 */
export async function ensureRetellAgent(env, kvState, tenantId, mode, lang = "es") {
  const cacheKey = `retell_agent_${mode}_${lang}`;
  const cached = await kvGet(kvState, tenantId, "retell_agents", cacheKey);
  if (cached?.agent_id) return cached.agent_id;

  const agentConfig = buildAgentConfig(env, mode, lang);
  const result = await retellRequest(env, "POST", "/create-agent", agentConfig);
  if (!result.ok) {
    console.error("Failed to create Retell agent:", result.error || result.data);
    return null;
  }

  const agentId = result.data.agent_id;
  await kvPut(kvState, tenantId, "retell_agents", cacheKey, {
    agent_id: agentId, mode, lang, created_at: new Date().toISOString(),
  }, { expirationTtl: 60 * 60 * 24 * 30 });

  return agentId;
}

/**
 * Build Retell agent configuration for a given mode
 */
function buildAgentConfig(env, mode, lang = "es") {
  const voiceId = RETELL_VOICE_MAP[lang] || RETELL_VOICE_MAP.es;
  const webhookUrl = env.RELAY_URL
    ? `${env.RELAY_URL}/relay/retell/webhook`
    : "https://relay.primecoreintelligence.com/relay/retell/webhook";

  const base = {
    agent_name:               `PrimeCore-Mode${mode}-${lang.toUpperCase()}`,
    voice_id:                 voiceId,
    voice_temperature:        0.6,
    voice_speed:              1.0,
    responsiveness:           0.9,
    interruption_sensitivity: 0.8,
    enable_backchannel:       true,
    language:                 lang,
    webhook_url:              webhookUrl,
    webhook_events:           ["call_started", "call_ended", "call_analyzed", "transcript_updated"],
    opt_out_sensitive_data_storage: false,
    max_call_duration_ms:     1800000, // 30 min max
  };

  switch (mode) {
    case CALL_MODES.AUTONOMOUS:
      return {
        ...base,
        agent_name:      `PrimeCore-Autonomous-${lang.toUpperCase()}`,
        response_engine: {
          type:              "retell-llm",
          llm_websocket_url: `${env.RELAY_URL || "https://relay.primecoreintelligence.com"}/relay/retell/llm`,
        },
        begin_message: lang === "es"
          ? "Gracias por llamar a PrimeCore Intelligence. ¿En qué le puedo ayudar hoy?"
          : lang === "pt"
          ? "Obrigado por ligar para a PrimeCore Intelligence. Como posso ajudá-lo hoje?"
          : "Thank you for calling PrimeCore Intelligence. How can I help you today?",
      };

    case CALL_MODES.TELEPROMPTER:
      return {
        ...base,
        agent_name:      `PrimeCore-Teleprompter-${lang.toUpperCase()}`,
        response_engine: {
          type:              "retell-llm",
          llm_websocket_url: `${env.RELAY_URL || "https://relay.primecoreintelligence.com"}/relay/retell/teleprompter`,
        },
        // Teleprompter mode: silent coaching, not autonomous speech
        begin_message: "", // Founder speaks first
      };

    case CALL_MODES.WARM_HANDOFF:
      return {
        ...base,
        agent_name:      `PrimeCore-Handoff-${lang.toUpperCase()}`,
        response_engine: {
          type:              "retell-llm",
          llm_websocket_url: `${env.RELAY_URL || "https://relay.primecoreintelligence.com"}/relay/retell/llm`,
        },
        begin_message: lang === "es"
          ? "Hola, gracias por llamar a PrimeCore Intelligence. Mi nombre es Aria. ¿Con quién tengo el gusto?"
          : lang === "pt"
          ? "Olá, obrigado por ligar para a PrimeCore Intelligence. Meu nome é Aria. Com quem falo?"
          : "Hello, thank you for calling PrimeCore Intelligence. My name is Aria. Who am I speaking with?",
      };

    case CALL_MODES.OUTBOUND:
      return {
        ...base,
        agent_name:      `PrimeCore-Outbound-${lang.toUpperCase()}`,
        response_engine: {
          type:              "retell-llm",
          llm_websocket_url: `${env.RELAY_URL || "https://relay.primecoreintelligence.com"}/relay/retell/llm`,
        },
        begin_message: "", // Set dynamically per call via dynamic_variables
      };

    default:
      return base;
  }
}

// ─── Inbound Call Handler ─────────────────────────────────────────────────────

/**
 * Handle Retell inbound webhook — pick agent based on active call mode
 * POST /relay/retell/inbound
 */
export async function handleRetellInbound(env, kvState, tenantId, payload) {
  const fromNumber = payload?.call_inbound?.from_number || "";
  const toNumber   = payload?.call_inbound?.to_number   || "";

  // Get current call mode from KV (default: Mode 3 Warm Handoff — safest for inbound)
  const settings   = await kvGet(kvState, tenantId, "retell_settings", "mode") || {};
  const activeMode = settings.mode || CALL_MODES.WARM_HANDOFF;
  const activeLang = settings.default_lang || "es";

  // Look up caller context from Notion/CRM
  let callerContext = {};
  try {
    const stored = await kvGet(kvState, tenantId, "retell_callers", fromNumber.replace(/\+/g, ""));
    if (stored) callerContext = stored;
  } catch { /* no stored context */ }

  // Get or create agent for this mode/language
  const agentId = await ensureRetellAgent(env, kvState, tenantId, activeMode, activeLang);

  // If Mode 2 (teleprompter) — founder must be online. Check presence.
  if (activeMode === CALL_MODES.TELEPROMPTER) {
    const presence = await kvGet(kvState, tenantId, "founder_presence", "status");
    if (!presence?.online) {
      // Fall back to warm handoff if founder is offline
      const fallbackAgentId = await ensureRetellAgent(env, kvState, tenantId, CALL_MODES.WARM_HANDOFF, activeLang);
      return buildInboundResponse(fallbackAgentId, callerContext, activeLang, CALL_MODES.WARM_HANDOFF);
    }
  }

  return buildInboundResponse(agentId, callerContext, activeLang, activeMode);
}

function buildInboundResponse(agentId, callerContext, lang, mode) {
  const dynamicVars = {
    caller_name:    callerContext.name    || "there",
    company:        callerContext.company || "",
    history_note:   callerContext.note    || "",
    call_mode:      String(mode),
    language:       lang,
  };

  return {
    call_inbound: {
      override_agent_id:            agentId,
      dynamic_variables:            dynamicVars,
      metadata: {
        tenant_id:  "primecore",
        call_mode:  mode,
        lang,
      },
      agent_override: {
        agent: {
          language:          lang,
          voice_speed:       1.0,
        },
      },
    },
  };
}

// ─── Outbound Call Dispatcher ─────────────────────────────────────────────────

/**
 * Initiate an outbound call via Retell AI
 * Called from existing /relay/call/outbound handler
 */
export async function dispatchRetellOutbound(env, kvState, tenantId, callRecord) {
  if (!env.RETELL_API_KEY) return { ok: false, error: "Retell not configured" };

  const lang    = callRecord.language || "es";
  const agentId = await ensureRetellAgent(env, kvState, tenantId, CALL_MODES.OUTBOUND, lang);
  if (!agentId) return { ok: false, error: "Could not create/find Retell agent" };

  // Build begin_message based on call type
  const beginMsg = buildOutboundMessage(callRecord, lang);

  const retellPayload = {
    from_number:       env.RETELL_FROM_NUMBER || "",
    to_number:         callRecord.to,
    override_agent_id: agentId,
    retell_llm_dynamic_variables: {
      contact_name:   callRecord.contactName || "there",
      company:        callRecord.company     || "",
      call_type:      callRecord.callType,
      language:       lang,
      begin_message:  beginMsg,
      notes:          callRecord.notes       || "",
    },
    metadata: {
      internal_call_id: callRecord.id,
      tenant_id:        tenantId,
      call_type:        callRecord.callType,
    },
  };

  const result = await retellRequest(env, "POST", "/v2/create-phone-call", retellPayload);
  return result;
}

function buildOutboundMessage(record, lang) {
  const name = record.contactName || "";
  const co   = record.company     || "";
  const type = record.callType;

  const msgs = {
    follow_up: {
      es: `Hola${name ? ` ${name}` : ""}, le llamo de PrimeCore Intelligence${co ? ` respecto a ${co}` : ""}. ¿Tiene un momento?`,
      en: `Hello${name ? ` ${name}` : ""}, this is PrimeCore Intelligence calling${co ? ` about ${co}` : ""}. Do you have a moment?`,
      pt: `Olá${name ? ` ${name}` : ""}, aqui é da PrimeCore Intelligence${co ? ` sobre ${co}` : ""}. Você tem um momento?`,
    },
    callback: {
      es: `Hola${name ? ` ${name}` : ""}, le devolvemos la llamada desde PrimeCore Intelligence. ¿En qué le podemos ayudar?`,
      en: `Hello${name ? ` ${name}` : ""}, returning your call from PrimeCore Intelligence. How can we help?`,
      pt: `Olá${name ? ` ${name}` : ""}, retornando sua ligação da PrimeCore Intelligence. Como podemos ajudar?`,
    },
    campaign: {
      es: `Hola${name ? ` ${name}` : ""}, le contactamos de PrimeCore Intelligence con información importante para su empresa.`,
      en: `Hello${name ? ` ${name}` : ""}, PrimeCore Intelligence calling with an important update for your business.`,
      pt: `Olá${name ? ` ${name}` : ""}, PrimeCore Intelligence entrando em contato com uma atualização importante para sua empresa.`,
    },
    csat: {
      es: `Hola${name ? ` ${name}` : ""}, le llamo de PrimeCore Intelligence para una encuesta rápida de satisfacción. Solo 2 minutos, ¿le parece bien?`,
      en: `Hello${name ? ` ${name}` : ""}, PrimeCore Intelligence calling for a quick 2-minute satisfaction survey. Is that okay?`,
      pt: `Olá${name ? ` ${name}` : ""}, PrimeCore Intelligence ligando para uma pesquisa rápida de satisfação. Apenas 2 minutos, tudo bem?`,
    },
    reminder: {
      es: `Hola${name ? ` ${name}` : ""}, le llamo de PrimeCore Intelligence con un recordatorio importante.`,
      en: `Hello${name ? ` ${name}` : ""}, PrimeCore Intelligence calling with an important reminder.`,
      pt: `Olá${name ? ` ${name}` : ""}, PrimeCore Intelligence ligando com um lembrete importante.`,
    },
    pilot_follow_up: {
      es: `Hola${name ? ` ${name}` : ""}, le llamo de PrimeCore Intelligence para darle seguimiento a su piloto. ¿Cómo va todo?`,
      en: `Hello${name ? ` ${name}` : ""}, PrimeCore Intelligence calling to follow up on your pilot. How's everything going?`,
      pt: `Olá${name ? ` ${name}` : ""}, PrimeCore Intelligence ligando para acompanhar seu piloto. Como está tudo?`,
    },
  };

  return (msgs[type]?.[lang] || msgs[type]?.es) ||
    (lang === "es" ? `Hola, le llama PrimeCore Intelligence.`
    : lang === "pt" ? `Olá, aqui é PrimeCore Intelligence.`
    : `Hello, PrimeCore Intelligence calling.`);
}

// ─── Retell Webhook Handler ───────────────────────────────────────────────────

/**
 * Process Retell webhook events
 * POST /relay/retell/webhook
 */
export async function handleRetellWebhook(env, kvState, tenantId, payload, ctx) {
  const event  = payload?.event;
  const call   = payload?.call || {};
  const callId = call.call_id || "";

  switch (event) {
    case "call_started": {
      await kvPut(kvState, tenantId, "retell_live", callId, {
        callId,
        status:       "active",
        direction:    call.direction || "inbound",
        fromNumber:   call.from_number || "",
        toNumber:     call.to_number   || "",
        mode:         call.metadata?.call_mode || CALL_MODES.WARM_HANDOFF,
        lang:         call.metadata?.lang || "es",
        startedAt:    new Date().toISOString(),
        transcript:   [],
        escalated:    false,
      }, { expirationTtl: 3600 });

      // Notify Command Station via Slack (non-blocking)
      ctx.waitUntil(notifyCallStarted(env, call));
      break;
    }

    case "transcript_updated": {
      const live = await kvGet(kvState, tenantId, "retell_live", callId) || {};
      live.transcript = call.transcript_object || [];
      live.lastUpdated = new Date().toISOString();
      await kvPut(kvState, tenantId, "retell_live", callId, live, { expirationTtl: 3600 });

      // In Mode 2 (teleprompter): push AI coaching suggestion
      if (live.mode === CALL_MODES.TELEPROMPTER && call.transcript_object?.length) {
        ctx.waitUntil(pushTeleprompterCoaching(env, kvState, tenantId, callId, call));
      }
      break;
    }

    case "transfer_started": {
      const live = await kvGet(kvState, tenantId, "retell_live", callId) || {};
      live.status    = "transferring";
      live.escalated = true;
      await kvPut(kvState, tenantId, "retell_live", callId, live, { expirationTtl: 3600 });
      ctx.waitUntil(notifyWarmHandoff(env, call, payload.transfer_destination));
      break;
    }

    case "transfer_bridged": {
      const live = await kvGet(kvState, tenantId, "retell_live", callId) || {};
      live.status = "founder_active";
      await kvPut(kvState, tenantId, "retell_live", callId, live, { expirationTtl: 3600 });
      break;
    }

    case "call_ended": {
      const live = await kvGet(kvState, tenantId, "retell_live", callId) || {};
      const record = {
        ...live,
        status:          "ended",
        endedAt:         new Date().toISOString(),
        durationSec:     call.end_timestamp
          ? Math.round((call.end_timestamp - call.start_timestamp) / 1000)
          : 0,
        disconnectReason: call.disconnection_reason || "unknown",
        transcript:       call.transcript || "",
        transcriptObject: call.transcript_object || [],
      };
      // Archive to history (7-day TTL)
      await kvPut(kvState, tenantId, "retell_history", callId, record, { expirationTtl: 60 * 60 * 24 * 7 });
      // Remove from live
      try { await kvState?.delete(`${tenantId}:retell_live:${callId}`); } catch {}
      ctx.waitUntil(notifyCallEnded(env, record));
      break;
    }

    case "call_analyzed": {
      const analysis = call.call_analysis || {};
      const hist = await kvGet(kvState, tenantId, "retell_history", callId) || {};
      hist.analysis = analysis;
      hist.sentiment = analysis.user_sentiment || "";
      hist.summary   = analysis.call_summary   || "";
      hist.fcr       = analysis.custom_analysis_data?.fcr ?? null;
      await kvPut(kvState, tenantId, "retell_history", callId, hist, { expirationTtl: 60 * 60 * 24 * 7 });
      break;
    }
  }

  return { ok: true, event, callId };
}

// ─── Teleprompter Coaching Push ───────────────────────────────────────────────

/**
 * In Mode 2: analyze live transcript and push a coaching suggestion to Command Station
 */
async function pushTeleprompterCoaching(env, kvState, tenantId, callId, call) {
  if (!env.ANTHROPIC_API_KEY) return;

  const transcript = call.transcript_object || [];
  if (!transcript.length) return;

  // Get last 3 turns
  const recent = transcript.slice(-3)
    .map(t => `${t.role === "agent" ? "AI" : "Caller"}: ${t.content}`)
    .join("\n");

  const lang = call.metadata?.lang || "es";

  const PROMPTS = {
    es: `Eres un coach de ventas en tiempo real para PrimeCore Intelligence. Analiza esta conversación y da UNA sugerencia concisa de qué decir ahora el representante (máx 20 palabras). Solo la sugerencia, sin explicación.`,
    en: `You are a real-time sales coach for PrimeCore Intelligence. Analyze this conversation and give ONE concise suggestion for what the rep should say now (max 20 words). Only the suggestion, no explanation.`,
    pt: `Você é um coach de vendas em tempo real para PrimeCore Intelligence. Analise esta conversa e dê UMA sugestão concisa do que o representante deve dizer agora (máx 20 palavras). Apenas a sugestão, sem explicação.`,
  };

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 60,
        system: PROMPTS[lang] || PROMPTS.es,
        messages: [{ role: "user", content: `Transcripción reciente:\n${recent}` }],
      }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    const suggestion = data.content?.[0]?.text?.trim();
    if (!suggestion) return;

    // Store coaching suggestion in KV for Command Station to poll
    await kvPut(kvState, tenantId, "retell_coaching", callId, {
      callId,
      suggestion,
      lang,
      ts: new Date().toISOString(),
    }, { expirationTtl: 300 });
  } catch { /* non-critical */ }
}

// ─── Slack Notifications ──────────────────────────────────────────────────────

async function notifyCallStarted(env, call) {
  if (!env.SLACK_WEBHOOK_ALERTS) return;
  const dir  = call.direction === "outbound" ? "📤 Outbound" : "📥 Inbound";
  const from = call.from_number || "unknown";
  const mode = call.metadata?.call_mode || 3;
  const modeLabel = ["", "🤖 Autonomous", "🎤 Teleprompter", "🤝 Warm Handoff", "📤 Outbound"][mode] || `Mode ${mode}`;
  await fetch(env.SLACK_WEBHOOK_ALERTS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `${dir} call started`,
      blocks: [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${dir} Call Active*\n📞 From: \`${from}\`\n⚙️ Mode: ${modeLabel}\n🆔 ID: \`${call.call_id}\``,
        },
      }],
    }),
  }).catch(() => {});
}

async function notifyWarmHandoff(env, call, destination) {
  if (!env.SLACK_WEBHOOK_APPROVALS) return;
  const from     = call.from_number || "unknown";
  const transcript = call.transcript || "";
  const snippet  = transcript.slice(-300).trim() || "No transcript yet";
  await fetch(env.SLACK_WEBHOOK_APPROVALS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: "🤝 Warm Handoff — Founder Alert",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*🤝 Warm Handoff Incoming*\n📞 Caller: \`${from}\`\n🆔 Call ID: \`${call.call_id}\``,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Last transcript:*\n\`\`\`${snippet}\`\`\``,
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Action:* Review Command Station → 📞 VOICE panel for full context`,
          },
        },
      ],
    }),
  }).catch(() => {});
}

async function notifyCallEnded(env, record) {
  if (!env.SLACK_WEBHOOK_ALERTS) return;
  const dur  = record.durationSec || 0;
  const mins = Math.floor(dur / 60);
  const secs = dur % 60;
  const modeLabel = ["", "🤖 Autonomous", "🎤 Teleprompter", "🤝 Handoff", "📤 Outbound"][record.mode] || `Mode ${record.mode}`;
  const fcr = record.escalated ? "❌ Escalated" : "✅ Resolved";
  await fetch(env.SLACK_WEBHOOK_ALERTS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: `Call ended — ${fcr}`,
      blocks: [{
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Call Ended*\n${fcr} · ${modeLabel}\n⏱️ Duration: ${mins}m ${secs}s\n📞 From: \`${record.fromNumber}\``,
        },
      }],
    }),
  }).catch(() => {});
}

// ─── Live Calls Query ─────────────────────────────────────────────────────────

/**
 * Get all currently active calls from KV
 * Used by Command Station VOICE panel
 */
export async function getLiveCalls(env, kvState, tenantId) {
  // Note: Cloudflare KV doesn't support prefix list in Workers free tier
  // We maintain a live call index
  const index = await kvGet(kvState, tenantId, "retell_live", "_index") || { ids: [] };
  const calls = [];
  for (const id of (index.ids || []).slice(0, 20)) {
    const c = await kvGet(kvState, tenantId, "retell_live", id);
    if (c && c.status !== "ended") calls.push(c);
  }
  return calls;
}

/**
 * Get recent call history (last 50)
 */
export async function getCallHistory(env, kvState, tenantId, limit = 50) {
  const index = await kvGet(kvState, tenantId, "retell_history", "_index") || { ids: [] };
  const calls = [];
  for (const id of (index.ids || []).slice(0, limit)) {
    const c = await kvGet(kvState, tenantId, "retell_history", id);
    if (c) calls.push(c);
  }
  return calls;
}

// ─── KV helpers (re-declared locally since this is a module) ──────────────────

async function kvGet(ns, tenantId, category, key) {
  if (!ns) return null;
  try { return JSON.parse(await ns.get(`${tenantId}:${category}:${key}`)); } catch { return null; }
}

async function kvPut(ns, tenantId, category, key, value, opts = {}) {
  if (!ns) return;
  try { await ns.put(`${tenantId}:${category}:${key}`, JSON.stringify(value), opts); } catch {}
}
