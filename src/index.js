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
import { runLeadOrchestrator, sweepStaleLeads } from "./leadOrchestrator.js";

const WAR_ROOM_API = "https://api.primecoreintelligence.com";
const VERSION      = "2.0.0";
const SECURITY_VERSION = "2026.04.02"; // Updated automatically on each deploy
const LAST_SECURITY_REVIEW = "2026-04-02";

// ── Rate limits ───────────────────────────────────────────────────────────
const LIMITS = {
  "/relay/pilot-request":      { max: 3,    window: 3600 },
  "/relay/call/event":         { max: 500,  window: 300  },
  "/relay/call/transcript":    { max: 2000, window: 300  },
  "/relay/call/end":           { max: 100,  window: 300  },
  "/relay/call/respond":        { max: 1000, window: 300  },
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
  logistics:  { fcr: 0.89, aht: 87,  costPerCall: 4.50, label: "Logistics / 3PL"    },
  healthcare: { fcr: 0.82, aht: 120, costPerCall: 9.20, label: "Healthcare"          },
  financial:  { fcr: 0.79, aht: 105, costPerCall: 8.80, label: "Financial Services"  },
  retail:     { fcr: 0.87, aht: 72,  costPerCall: 5.40, label: "Retail / E-commerce" },
  fleet:      { fcr: 0.85, aht: 95,  costPerCall: 4.80, label: "Fleet / Dispatch"    },
  bpo:        { fcr: 0.83, aht: 102, costPerCall: 4.20, label: "BPO Operations"      },
  default:    { fcr: 0.84, aht: 95,  costPerCall: 4.50, label: "General — LATAM"     },
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
  "https://relay.primecoreintelligence.com",
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
function getTenantId(req) {
  // Security: strip everything except alphanumeric and hyphen to prevent
  // colon injection in KV key format (tenant:{id}:{cat}:{key})
  const raw = (req.headers.get("x-tenant-id") || "").trim()
    || new URL(req.url).searchParams.get("tenant_id") || "";
  const clean = raw.replace(/[^a-z0-9\-]/gi, "").slice(0, 40);
  return clean || "public";
}
function sanitize(s, max = 500) { return String(s || "").trim().slice(0, max); }
function isValidEmail(s)  { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "")); }

// ── Tenant KV keys ────────────────────────────────────────────────────────
function tenantKey(tenantId, category, key) {
  // Security: all three segments stripped of KV-unsafe chars
  // Colons (:) are the separator — must never appear in any segment
  const tid = String(tenantId || "public").replace(/[^a-z0-9\-]/gi, "").slice(0, 40) || "public";
  const cat = String(category || "misc").replace(/[^a-z0-9_]/gi, "_");
  const k   = String(key || "").replace(/[^a-z0-9\-_.]/gi, "_").slice(0, 100);
  return `tenant:${tid}:${cat}:${k}`;
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
  // Primary: Resend API (reliable, free tier 3k/month)
  if (env.RESEND_API_KEY) {
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Authorization": `Bearer ${env.RESEND_API_KEY}`
        },
        body: JSON.stringify({
          from: "PrimeCore Intelligence <noreply@primecoreintelligence.com>",
          to: [to],
          subject,
          text: body,
          reply_to: replyTo || undefined,
        }),
      });
      if (resp.ok) return true;
    } catch { /* fall through */ }
  }

  // Fallback: MailChannels (may work depending on CF plan)
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


// ═══════════════════════════════════════════════════════════════════════════
// AGENTIC EMAIL SYSTEM
// ─────────────────────────────────────────────────────────────────────────
// Flow:
//   1. Pilot form submit → immediate AI-written personal reply to prospect
//   2. Internal notification → lead brief + ROI + custom quote awaiting approval
//   3. Follow-up sequence stored in KV → Day 1, Day 3, Day 7
//   4. Custom plan pricing → AI builds the number, waits for founder approval
//
// Custom plan logic:
//   - Always anchors to value delivered (savings), not cost
//   - Presents a range so "yes" is easy (pick the middle, not the top)
//   - Never presents a number the prospect can flat-out reject
//   - Founder approves before it goes out
// ═══════════════════════════════════════════════════════════════════════════

// ── Custom plan pricing engine ────────────────────────────────────────────
function buildCustomQuote(record, roi) {
  const vol    = parseInt(String(record.volume || "0").replace(/[^0-9]/g, ""), 10) || 0;
  const saved  = Math.abs(roi?.laborSaved || 0);
  const agents = roi?.agents || 0;

  // Anchor: price = 18–22% of labor savings (always positive ROI for client)
  // Present THREE options so they choose, not refuse
  const base   = Math.max(7997, Math.round(saved * 0.18 / 100) * 100);
  const mid    = Math.round(base * 1.15 / 100) * 100;
  const full   = Math.round(base * 1.32 / 100) * 100;

  // Pilot pricing: always 50% of chosen tier
  const pilotBase = Math.round(base / 2 / 100) * 100;
  const pilotMid  = Math.round(mid  / 2 / 100) * 100;
  const pilotFull = Math.round(full / 2 / 100) * 100;

  return {
    vol, saved, agents,
    options: [
      {
        label: "Core",
        monthly: base, pilot: pilotBase,
        includes: "Autonomous handling up to 80% of volume, 3 CCaaS integrations, 15 languages, SLA alerting",
        roiMonth1: saved - base,
        note: "Best starting point — lowest commitment, fastest ROI proof"
      },
      {
        label: "Full Deployment",
        monthly: mid, pilot: pilotMid,
        includes: "Autonomous + Assist Mode blended, unlimited CCaaS, 50+ languages, dedicated success engineer",
        roiMonth1: saved - mid,
        note: "Most selected — complete stack, fastest scale"
      },
      {
        label: "Enterprise Max",
        monthly: full, pilot: pilotFull,
        includes: "All modes, multi-tenant isolation, custom SLA enforcement, LATAM compliance pack, quarterly business review",
        roiMonth1: saved - full,
        note: "For operations that need full control and compliance coverage"
      }
    ],
    reasoning: `Based on ${vol.toLocaleString()} calls/month with ${agents} agents at current cost, ` +
      `we estimate $${saved.toLocaleString()}/month in recoverable labor. ` +
      `All three options deliver positive ROI from Month 1. ` +
      `Core is priced at 18% of savings — the floor that makes the math undeniable. ` +
      `Full Deployment is the most common choice for operations this size.`
  };
}

// ── AI-written prospect reply ──────────────────────────────────────────────
async function generateProspectReply(env, record, roi) {
  if (!env.ANTHROPIC_API_KEY && !env.WAR_ROOM_API_TOKEN) return null;

  const lang = record.lang || "en";

  const volLabel = {
    "under-5k": { en: "under 5,000 calls/month", es: "menos de 5,000 llamadas/mes", pt: "menos de 5.000 chamadas/mês" },
    "5k-20k":   { en: "5,000–20,000 calls/month", es: "entre 5,000 y 20,000 llamadas/mes", pt: "entre 5.000 e 20.000 chamadas/mês" },
    "20k-100k": { en: "20,000–100,000 calls/month", es: "entre 20,000 y 100,000 llamadas/mes", pt: "entre 20.000 e 100.000 chamadas/mês" },
    "100k+":    { en: "over 100,000 calls/month", es: "más de 100,000 llamadas/mes", pt: "mais de 100.000 chamadas/mês" },
  };
  const vol = (volLabel[record.volume] || {})[lang] || record.volume;

  const roiNum = roi && roi.netMonthly > 0
    ? `$${Math.abs(roi.netMonthly).toLocaleString()}`
    : null;

  const systemPrompts = {
    en: `You are a senior operations advisor at PrimeCore Intelligence writing a professional email reply to someone who just requested a pilot.

RULES — follow these exactly:
- Write in fluent, natural English. Sound like a real person, not a company.
- 3–4 short paragraphs. No bullet points. No numbered lists.
- Never use these words: solution, leverage, synergy, seamless, excited, thrilled, honored, pleased to, I hope this email finds you.
- Never start with "I hope" or "Thank you for reaching out" or "We are pleased".
- Reference their company, their volume, and their vertical by name.
- Mention shadow mode: the AI runs alongside their agents with zero side effects until they approve.
- If ROI data is available, mention the monthly savings estimate naturally in one sentence — not as a headline.
- End with one specific question or a clear next step. Not a generic close.
- Sign as: PrimeCore Intelligence — Enterprise Operations`,

    es: `Eres un asesor senior de operaciones en PrimeCore Intelligence escribiendo una respuesta profesional a alguien que acaba de solicitar un piloto.

REGLAS — síguelas exactamente:
- Escribe en español fluido y natural. Suena como una persona real, no como una empresa.
- 3–4 párrafos cortos. Sin puntos. Sin listas numeradas.
- Nunca uses estas palabras: solución integral, sinergia, robusto, de vanguardia, nos complace, estamos encantados.
- Nunca empieces con "Espero que este correo te encuentre bien" ni "Gracias por comunicarte con nosotros".
- Menciona su empresa, su volumen de llamadas y su vertical por nombre.
- Menciona el modo sombra: la IA funciona junto a sus agentes sin efectos secundarios hasta que ellos aprueben.
- Si hay datos de ROI disponibles, menciona el ahorro mensual estimado en una sola oración, de forma natural.
- Termina con una pregunta específica o un próximo paso claro. No un cierre genérico.
- Firma como: PrimeCore Intelligence — Operaciones Empresariales`,

    pt: `Você é um consultor sênior de operações da PrimeCore Intelligence escrevendo uma resposta profissional a alguém que acabou de solicitar um piloto.

REGRAS — siga-as exatamente:
- Escreva em português fluido e natural. Soe como uma pessoa real, não como uma empresa.
- 3–4 parágrafos curtos. Sem marcadores. Sem listas numeradas.
- Nunca use estas palavras: solução integrada, sinergia, robusto, de ponta, ficamos felizes em, é um prazer.
- Nunca comece com "Espero que este e-mail te encontre bem" ou "Obrigado por entrar em contato conosco".
- Mencione a empresa, o volume de chamadas e o vertical pelo nome.
- Mencione o modo sombra: a IA funciona junto com os agentes sem efeitos colaterais até que eles aprovem.
- Se houver dados de ROI disponíveis, mencione a estimativa de economia mensal em uma frase, de forma natural.
- Termine com uma pergunta específica ou um próximo passo claro. Não um fechamento genérico.
- Assine como: PrimeCore Intelligence — Operações Empresariais`,
  };

  const userPrompts = {
    en: `Write the email reply to this prospect:

Name: ${record.name}
Company: ${record.company}
Volume: ${vol}
Vertical: ${record.vertical || "contact center operations"}
CCaaS: ${record.ccaas || "not specified"}
${roiNum ? `Estimated monthly savings: ${roiNum} net after plan cost` : ""}

Just the email body — no subject line. Sign as: PrimeCore Intelligence — Enterprise Operations`,

    es: `Escribe el correo de respuesta para este prospecto:

Nombre: ${record.name}
Empresa: ${record.company}
Volumen: ${vol}
Vertical: ${record.vertical || "operaciones de centro de contacto"}
CCaaS: ${record.ccaas || "no especificado"}
${roiNum ? `Ahorro mensual estimado: ${roiNum} neto después del costo del plan` : ""}

Solo el cuerpo del correo — sin asunto. Firma como: PrimeCore Intelligence — Operaciones Empresariales`,

    pt: `Escreva o e-mail de resposta para este prospect:

Nome: ${record.name}
Empresa: ${record.company}
Volume: ${vol}
Vertical: ${record.vertical || "operações de contact center"}
CCaaS: ${record.ccaas || "não especificado"}
${roiNum ? `Economia mensal estimada: ${roiNum} líquido após custo do plano` : ""}

Apenas o corpo do e-mail — sem assunto. Assine como: PrimeCore Intelligence — Operações Empresariais`,
  };

  const systemPrompt = systemPrompts[lang] || systemPrompts.en;
  const userPrompt   = userPrompts[lang]   || userPrompts.en;

  try {
    // Use Anthropic Claude for human-quality multilingual responses
    if (!env.ANTHROPIC_API_KEY) return null;

    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch { return null; }
}

// ── Schedule follow-up sequence in KV ────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════
// INSTALLATION AGENT — Phase 1
// Sends guided shadow mode setup emails after a pilot is approved.
// Triggered for 20k-100k and 100k+ volume leads (same as Active Pilots).
// Disable per-client: set installation_agent_disabled flag in KV.
// Disable globally: set INSTALLATION_AGENT_ENABLED=false in CF secrets.
// ══════════════════════════════════════════════════════════════════════════

const INSTALL_STEPS = {
  en: {
    welcome: {
      subject: (company) => `Your PrimeCore pilot is active — next steps for ${company}`,
      body: (r) => `Hi ${r.name},

Your 30-day pilot is confirmed. Shadow mode setup takes less than one hour and requires no changes to ${r.ccaas || 'your CCaaS'}.

Here's what happens next:

Step 1 — Your IT admin adds one webhook URL to your CCaaS admin panel (15 min)
Step 2 — We verify the first call event arrives (automatic)
Step 3 — You get war room access to watch calls in real time

I'll send you the exact webhook configuration for ${r.ccaas || 'your platform'} in a separate email in the next few minutes.

One question before I do: when does your IT admin have 30 minutes available this week?

PrimeCore Intelligence — Enterprise Operations`,
    },
    webhook_config: {
      subject: (company, ccaas) => `Webhook configuration for ${company} — ${ccaas || 'your CCaaS'}`,
      body: (r, tenantId, token) => `Hi ${r.name},

Here is your webhook configuration. Your IT admin adds this in the CCaaS admin panel under Integrations → Webhooks:

URL: https://relay.primecoreintelligence.com/relay/call/event
Method: POST
Header 1: x-tenant-id: ${tenantId}
Header 2: Authorization: Bearer ${token}
Trigger: every inbound call event

Once added, I'll receive the first call event automatically and confirm shadow mode is active. You don't need to do anything else.

War room access (so you can watch calls in real time):
https://warroom.primecoreintelligence.com

Your tenant ID: ${tenantId}

Let me know if your IT team has any questions — I respond same day.

PrimeCore Intelligence — Enterprise Operations`,
    },
    week2: {
      subject: (company) => `${company} — Week 2 shadow mode check-in`,
      body: (r) => `Hi ${r.name},

Two weeks of shadow data are in. A few things worth reviewing in your war room dashboard before we talk:

1. FCR prediction — the percentage of calls the AI would have resolved without an agent
2. AHT comparison — actual agent time vs. AI simulation time per intent category  
3. Top intent categories — where the AI performs strongest

One specific question: are there any call types showing up in the dashboard that you'd expect the AI to struggle with? That helps us calibrate before the Week 4 evidence pack.

Schedule 15 minutes whenever works: just reply to this email.

PrimeCore Intelligence — Enterprise Operations`,
    },
  },
  es: {
    welcome: {
      subject: (company) => `Su piloto de PrimeCore está activo — próximos pasos para ${company}`,
      body: (r) => `Hola ${r.name},

Su piloto de 30 días está confirmado. La configuración del modo sombra toma menos de una hora y no requiere ningún cambio en ${r.ccaas || 'su CCaaS'}.

Esto es lo que sigue:

Paso 1 — Su administrador de TI agrega una URL de webhook en el panel de administración de su CCaaS (15 min)
Paso 2 — Verificamos que el primer evento de llamada llegue (automático)
Paso 3 — Recibe acceso a la sala de guerra para ver las llamadas en tiempo real

Le enviaré la configuración exacta del webhook para ${r.ccaas || 'su plataforma'} en un correo separado en los próximos minutos.

Una pregunta antes de enviarlo: ¿cuándo tiene disponible su administrador de TI 30 minutos esta semana?

PrimeCore Intelligence — Enterprise Operations`,
    },
    webhook_config: {
      subject: (company, ccaas) => `Configuración del webhook para ${company} — ${ccaas || 'su CCaaS'}`,
      body: (r, tenantId, token) => `Hola ${r.name},

Aquí está la configuración del webhook. Su administrador de TI la agrega en el panel de administración del CCaaS bajo Integraciones → Webhooks:

URL: https://relay.primecoreintelligence.com/relay/call/event
Método: POST
Header 1: x-tenant-id: ${tenantId}
Header 2: Authorization: Bearer ${token}
Disparador: cada evento de llamada entrante

Una vez agregado, recibiré el primer evento de llamada automáticamente y confirmaré que el modo sombra está activo. No necesita hacer nada más.

Acceso a la sala de guerra (para ver las llamadas en tiempo real):
https://warroom.primecoreintelligence.com

Su ID de tenant: ${tenantId}

Avíseme si su equipo de TI tiene alguna pregunta — respondo el mismo día.

PrimeCore Intelligence — Enterprise Operations`,
    },
    week2: {
      subject: (company) => `${company} — Seguimiento Semana 2 del modo sombra`,
      body: (r) => `Hola ${r.name},

Ya tenemos dos semanas de datos en modo sombra. Vale la pena revisar algunas cosas en su panel de sala de guerra antes de conversar:

1. Predicción de FCR — el porcentaje de llamadas que la IA habría resuelto sin un agente
2. Comparación de AHT — tiempo real del agente vs. tiempo de simulación de IA por categoría de intención
3. Categorías de intención principales — donde la IA funciona mejor

Una pregunta específica: ¿hay algún tipo de llamada en el panel que esperaría que la IA tuviera dificultades para manejar? Eso nos ayuda a calibrar antes del paquete de evidencias de la Semana 4.

Coordine 15 minutos cuando le convenga: responda a este correo.

PrimeCore Intelligence — Enterprise Operations`,
    },
  },
  pt: {
    welcome: {
      subject: (company) => `Seu piloto PrimeCore está ativo — próximos passos para ${company}`,
      body: (r) => `Olá ${r.name},

Seu piloto de 30 dias está confirmado. A configuração do modo sombra leva menos de uma hora e não requer nenhuma mudança no ${r.ccaas || 'seu CCaaS'}.

Veja o que acontece a seguir:

Passo 1 — Seu administrador de TI adiciona uma URL de webhook no painel de administração do CCaaS (15 min)
Passo 2 — Verificamos que o primeiro evento de chamada chegou (automático)
Passo 3 — Você recebe acesso à sala de guerra para ver as chamadas em tempo real

Enviarei a configuração exata do webhook para ${r.ccaas || 'sua plataforma'} em um e-mail separado nos próximos minutos.

Uma pergunta antes de enviar: quando seu administrador de TI tem 30 minutos disponíveis esta semana?

PrimeCore Intelligence — Enterprise Operations`,
    },
    webhook_config: {
      subject: (company, ccaas) => `Configuração do webhook para ${company} — ${ccaas || 'seu CCaaS'}`,
      body: (r, tenantId, token) => `Olá ${r.name},

Aqui está a configuração do webhook. Seu administrador de TI a adiciona no painel de administração do CCaaS em Integrações → Webhooks:

URL: https://relay.primecoreintelligence.com/relay/call/event
Método: POST
Header 1: x-tenant-id: ${tenantId}
Header 2: Authorization: Bearer ${token}
Gatilho: cada evento de chamada recebida

Assim que adicionado, receberei o primeiro evento de chamada automaticamente e confirmarei que o modo sombra está ativo. Você não precisa fazer mais nada.

Acesso à sala de guerra (para ver as chamadas em tempo real):
https://warroom.primecoreintelligence.com

Seu ID de tenant: ${tenantId}

Avise-me se sua equipe de TI tiver alguma dúvida — respondo no mesmo dia.

PrimeCore Intelligence — Enterprise Operations`,
    },
    week2: {
      subject: (company) => `${company} — Acompanhamento Semana 2 do modo sombra`,
      body: (r) => `Olá ${r.name},

Duas semanas de dados em modo sombra já estão disponíveis. Vale revisar algumas coisas no seu painel da sala de guerra antes de conversar:

1. Previsão de FCR — a porcentagem de chamadas que a IA teria resolvido sem um agente
2. Comparação de AHT — tempo real do agente vs. tempo de simulação de IA por categoria de intenção
3. Principais categorias de intenção — onde a IA performa melhor

Uma pergunta específica: há algum tipo de chamada no painel que você esperaria que a IA tivesse dificuldade em tratar? Isso nos ajuda a calibrar antes do pacote de evidências da Semana 4.

Agende 15 minutos quando for conveniente: responda a este e-mail.

PrimeCore Intelligence — Enterprise Operations`,
    },
  },
};

async function scheduleInstallationAgent(env, record) {
  // Global disable switch
  if (env.INSTALLATION_AGENT_ENABLED === 'false') return;
  if (!env.RELAY_STATE || !env.RESEND_API_KEY) return;

  const lang = (record.lang || 'es').toLowerCase().slice(0, 2);
  const t = INSTALL_STEPS[lang] || INSTALL_STEPS.es;
  const tenantId = record.id || crypto.randomUUID();
  const token = env.RELAY_AUTH_TOKEN || 'pending';
  const now = Date.now();

  // Store installation sequence in KV
  const installKey = `install:${record.id}`;
  await env.RELAY_STATE.put(installKey, JSON.stringify({
    record, tenantId, lang,
    steps: [
      { type: 'welcome',        daysOut: 0,  sent: false },
      { type: 'webhook_config', daysOut: 0,  sent: false }, // same day, 10 min later
      { type: 'week2',          daysOut: 14, sent: false },
    ],
    createdAt: now,
    agentEnabled: true,
  }), { expirationTtl: 60 * 60 * 24 * 45 }); // 45 day TTL

  // Send welcome email immediately
  const welcome = t.welcome;
  await sendEmail(env, {
    to: record.email,
    subject: welcome.subject(record.company || record.name),
    body: welcome.body(record),
  });

  // Schedule webhook config email (fire after 10 minutes via KV flag)
  const webhookKey = `install:${record.id}:webhook_config`;
  await env.RELAY_STATE.put(webhookKey, JSON.stringify({
    record, tenantId, token, lang,
    sendAt: now + (10 * 60 * 1000), // 10 minutes
    sent: false,
  }), { expirationTtl: 60 * 60 * 24 });
}

async function scheduleFollowUps(env, record, roi) {
  if (!env.RELAY_STATE) return;
  const now = Date.now();
  const seq = [
    { daysOut: 1,  type: "roi_followup",   sent: false },
    { daysOut: 3,  type: "case_study",     sent: false },
    { daysOut: 7,  type: "closing_loop",   sent: false },
  ];
  const key = `followup:${record.id}`;
  await env.RELAY_STATE.put(key, JSON.stringify({
    record, roi, seq,
    createdAt: now,
    nextCheck: now + (24 * 60 * 60 * 1000)
  }), { expirationTtl: 60 * 60 * 24 * 14 }); // 14-day TTL
}

// ── Internal approval email for custom quotes ─────────────────────────────
async function sendApprovalRequest(env, record, roi, quote) {
  const opts = quote.options.map((o, i) =>
    `OPTION ${i+1} — ${o.label}
  Monthly:  $${o.monthly.toLocaleString()}/mo  (Pilot Month 1: $${o.pilot.toLocaleString()})
  Includes: ${o.includes}
  ROI M1:   +$${o.roiMonth1.toLocaleString()}/mo net for client
  Note:     ${o.note}`
  ).join("\n\n");

  const approveBase = `https://relay.primecoreintelligence.com/relay/quote-approve?id=${record.id}&option=0&token=${env.RELAY_AUTH_TOKEN}`;
  const approveMid  = `https://relay.primecoreintelligence.com/relay/quote-approve?id=${record.id}&option=1&token=${env.RELAY_AUTH_TOKEN}`;
  const approveFull = `https://relay.primecoreintelligence.com/relay/quote-approve?id=${record.id}&option=2&token=${env.RELAY_AUTH_TOKEN}`;

  const body = `
⚡ CUSTOM QUOTE READY FOR APPROVAL
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PROSPECT
  Name:    ${record.name}
  Email:   ${record.email}
  Company: ${record.company}
  Volume:  ${record.volume}
  Vertical: ${record.vertical || "Not specified"}

PRICING RATIONALE
  ${quote.reasoning}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THREE OPTIONS (AI-built, value-anchored)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

${opts}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
APPROVE & SEND (one click):

✅ Send Option 1 (Core):             ${approveBase}
✅ Send Option 2 (Full Deployment):  ${approveMid}
✅ Send Option 3 (Enterprise Max):   ${approveFull}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Prospect ID: ${record.id}
Submitted:   ${record.ts}
`.trim();

  return sendEmail(env, {
    to:      env.NOTIFY_EMAIL || "sales@primecoreintelligence.com",
    subject: `⚡ Approve Custom Quote — ${record.company} ($${quote.options[1].monthly.toLocaleString()}/mo)`,
    body,
  });
}

// ── Notion Integration ────────────────────────────────────────────────────
// Creates a Leads & Deals page in Notion on every pilot request.
// Requires NOTION_API_TOKEN secret in Cloudflare Worker settings.

const NOTION_LEADS_DB   = "a6f67944-772d-4396-b7e3-c380d1b9186b";
const NOTION_PILOTS_DB  = "65ebde47a45241e4be224f07f071b1b3";
const NOTION_PLAYBOOKS_DB = "670b80a8-4e2a-4484-9027-34ac592cdc68";

// Map form volume values to Notion select options
const VOLUME_MAP = {
  "under-5k":   "Under 5k",
  "5k-20k":     "5k-20k",
  "20k-100k":   "20k-100k",
  "100k+":      "100k+",
};

// Map vertical values to Notion select options
const VERTICAL_MAP = {
  "logistics":    "Logistics/3PL",
  "logistics3pl": "Logistics/3PL",
  "healthcare":   "Healthcare",
  "financial":    "Financial Services",
  "fleet":        "Fleet",
  "bpo":          "BPO",
  "latam":        "LATAM Enterprise",
};

// Map CCaaS to Notion select options
const CCAAS_MAP = {
  "five9":       "Five9",
  "genesys":     "Genesys",
  "ringcentral": "RingCentral",
  "3cx":         "3CX",
  "atento":      "Atento",
  "bliss":       "Bliss",
};

// Classify inquiry type from notes field
function classifyInquiry(record) {
  const notes = (record.notes || "").toLowerCase();
  const volume = record.volume || "";
  if (volume === "100k+") return "Volume Deal";
  if (notes.includes("hipaa") || notes.includes("soc2") || notes.includes("gdpr") || notes.includes("baa") || notes.includes("compliance")) return "Compliance Docs";
  if (notes.includes("integrat") || notes.includes("webhook") || notes.includes("api")) return "Integration Question";
  if (notes.includes("feature") || notes.includes("custom") || notes.includes("roadmap")) return "Feature Request";
  if (notes.includes("partner") || notes.includes("resell") || notes.includes("white label")) return "Partnership";
  if (notes.includes("price") || notes.includes("pricing") || notes.includes("discount") || notes.includes("quote")) return "Custom Pricing";
  return "Standard Pilot";
}

// Score priority from record
function scorePriority(record) {
  const vol = record.volume || "";
  const type = classifyInquiry(record);
  if (vol === "100k+" || type === "Volume Deal" || type === "Custom Pricing") return "High";
  if (vol === "20k-100k" || type === "Compliance Docs") return "Medium";
  return "Low";
}

// Estimate deal value from volume
function estimateDealValue(record) {
  const volMap = { "under-5k": 1200, "5k-20k": 2900, "20k-100k": 5800, "100k+": 12000 };
  return volMap[record.volume] || 0;
}

// Normalize CCaaS name
function normalizeCCaaS(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return CCAAS_MAP[key] || null;
}

// Normalize vertical
function normalizeVertical(raw) {
  if (!raw) return null;
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
  return VERTICAL_MAP[key] || null;
}

// Create a page in a Notion database via REST API
async function notionCreatePage(token, databaseId, properties) {
  const payload = {
    parent: { database_id: databaseId },
    properties: {},
  };

  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue;

    if (key === "__title__") {
      payload.properties["Company"] = { title: [{ text: { content: String(value) } }] };
    } else if (key === "__title_field__") {
      // skip - used internally
    } else if (typeof value === "boolean" || value === "__YES__" || value === "__NO__") {
      payload.properties[key] = { checkbox: value === true || value === "__YES__" };
    } else if (typeof value === "number") {
      payload.properties[key] = { number: value };
    } else if (value && typeof value === "object" && value._select) {
      payload.properties[key] = { select: { name: value._select } };
    } else if (value && typeof value === "object" && value._email) {
      payload.properties[key] = { email: value._email };
    } else if (value && typeof value === "object" && value._url) {
      payload.properties[key] = { url: value._url };
    } else {
      payload.properties[key] = { rich_text: [{ text: { content: String(value).slice(0, 2000) } }] };
    }
  }

  const resp = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Notion API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  return resp.json();
}

// Main function: create Leads & Deals page + Active Pilots page
async function createNotionLead(env, record, roi) {
  if (!env.NOTION_API_TOKEN) return null;

  try {
    const inquiryType = classifyInquiry(record);
    const priority    = scorePriority(record);
    const dealValue   = estimateDealValue(record);
    const ccaas       = normalizeCCaaS(record.ccaas);
    const vertical    = normalizeVertical(record.vertical);
    const lang        = (record.lang || "en").toUpperCase();
    const volume      = VOLUME_MAP[record.volume] || record.volume || null;

    const roiNote = roi && roi.netMonthly > 0
      ? `Estimated savings: $${Math.abs(roi.netMonthly).toLocaleString()}/mo net.`
      : "";
    const notesText = [record.notes, roiNote, `Source: ${record.source || "primecoreintelligence.com"}`]
      .filter(Boolean).join(" | ").slice(0, 2000);

    // Build properties directly — correct Notion API types for each field
    const props = {
      "Company": { title: [{ text: { content: String(record.company || record.name || "Unknown").slice(0, 200) } }] },
      "Contact Name": { rich_text: [{ text: { content: String(record.name || "").slice(0, 200) } }] },
      "Email": { email: record.email || null },
      "Inquiry Type": { select: { name: inquiryType } },
      "Priority": { select: { name: priority } },
      "Language": { select: { name: lang } },
      "Status": { status: { name: "Not started" } },
      "Response Sent": { checkbox: false },
      "Approval Pending": { checkbox: inquiryType === "Custom Pricing" || inquiryType === "Volume Deal" },
      "Pilot ID": { rich_text: [{ text: { content: record.id || "" } }] },
      "Source Domain": { rich_text: [{ text: { content: String(record.source || "primecoreintelligence.com").slice(0, 200) } }] },
      "Notes": { rich_text: [{ text: { content: notesText } }] },
    };

    // Only add select fields if we have a valid mapped value
    if (volume)   props["Volume"]          = { select: { name: volume } };
    if (ccaas)    props["CCaaS Platform"]  = { select: { name: ccaas } };
    if (vertical) props["Vertical"]        = { select: { name: vertical } };
    if (dealValue) props["Deal Value"]     = { number: dealValue };

    const resp = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.NOTION_API_TOKEN,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: NOTION_LEADS_DB },
        properties: props,
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      console.error("Notion leads page failed:", resp.status, errBody.slice(0, 300));
      return null;
    }

    const page = await resp.json();

    // For high-volume leads — also create Active Pilots entry
    if (record.volume === "20k-100k" || record.volume === "100k+") {
      const pilotProps = {
        "Company": { title: [{ text: { content: String(record.company || record.name || "Unknown").slice(0, 200) } }] },
        "Pilot ID": { rich_text: [{ text: { content: record.id || "" } }] },
        "Contact Name": { rich_text: [{ text: { content: String(record.name || "").slice(0, 200) } }] },
        "Contact Email": { email: record.email || null },
        "Language": { select: { name: lang } },
        "Plan": { select: { name: "Growth" } },
        "Week": { select: { name: "Week 1 — Shadow Mode" } },
        "Shadow Mode Active": { select: { name: "Pending" } },
        "Cutover Approved": { select: { name: "Not Yet" } },
        "Health": { select: { name: "On Track" } },
        "Next Action": { rich_text: [{ text: { content: `Contact ${record.name} to confirm shadow mode setup. CCaaS: ${record.ccaas || "TBD"}` } }] },
      };
      if (ccaas)    pilotProps["CCaaS Platform"] = { select: { name: ccaas } };
      if (vertical) pilotProps["Vertical"]       = { select: { name: vertical } };
      if (dealValue) pilotProps["Monthly Value"] = { number: dealValue };

      const pilotResp = await fetch("https://api.notion.com/v1/pages", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.NOTION_API_TOKEN,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          parent: { database_id: NOTION_PILOTS_DB },
          properties: pilotProps,
        }),
      });
      if (!pilotResp.ok) {
        const e = await pilotResp.text();
        console.error("Notion pilots page failed:", pilotResp.status, e.slice(0, 200));
      }
    }

    return { pageId: page.id, pageUrl: page.url, inquiryType, priority };

  } catch (err) {
    console.error("Notion createLead exception:", err.message);
    return null;
  }
}

// Build Slack alert message
function buildSlackAlert(record, notionResult, roi) {
  const priority = notionResult?.priority || scorePriority(record);
  const inquiryType = notionResult?.inquiryType || classifyInquiry(record);
  const notionLink = notionResult?.pageUrl || null;

  const priorityEmoji = { High: "🔴", Medium: "🟡", Low: "🟢" }[priority] || "🟢";
  const roiLine = roi && roi.netMonthly > 0
    ? `*Est. savings:* $${Math.abs(roi.netMonthly).toLocaleString()}/mo`
    : "";

  return {
    text: `${priorityEmoji} New ${inquiryType} — ${record.company}`,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `${priorityEmoji} ${inquiryType} — ${record.company}` }
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Name:*\n${record.name}` },
          { type: "mrkdwn", text: `*Email:*\n${record.email}` },
          { type: "mrkdwn", text: `*Volume:*\n${record.volume || "not specified"}` },
          { type: "mrkdwn", text: `*CCaaS:*\n${record.ccaas || "not specified"}` },
          { type: "mrkdwn", text: `*Vertical:*\n${record.vertical || "not specified"}` },
          { type: "mrkdwn", text: `*Priority:*\n${priority}` },
        ].filter(f => f.text.text !== "not specified\nnot specified"),
      },
      roiLine ? {
        type: "section",
        text: { type: "mrkdwn", text: roiLine },
      } : null,
      notionLink ? {
        type: "actions",
        elements: [{
          type: "button",
          text: { type: "plain_text", text: "Open in Notion →" },
          url: notionLink,
          style: "primary",
        }],
      } : null,
    ].filter(Boolean),
  };
}

// Send Slack alert via webhook
async function sendSlackAlert(env, record, notionResult, roi) {
  if (!env.SLACK_WEBHOOK_URL) return;
  try {
    const payload = buildSlackAlert(record, notionResult, roi);
    await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("Slack alert failed:", err.message);
  }
}


// ══════════════════════════════════════════════════════════════════════════
// VOICE SYNTHESIS LAYER
// Standard: PrimeCore Voice — $0.04/call
// Premium:  PrimeCore Voice Pro — $0.09/call
// ══════════════════════════════════════════════════════════════════════════

// Voice persona definitions per language
const VOICE_PERSONAS = {
  cartesia: {
    es: { voice_id: "a0e99841-438c-4a64-b679-ae501e7d6091", language: "es" }, // Spanish neutral LATAM
    en: { voice_id: "79a125e8-cd45-4c13-8a67-188112f4dd22", language: "en" }, // English professional
    pt: { voice_id: "c8cf1063-8195-4a0e-b7c1-c9639d0c1a8b", language: "pt" }, // Portuguese Brazilian
  },
  elevenlabs: {
    es: { voice_id: "pNInz6obpgDQGcFmaJgB", model: "eleven_turbo_v2_5" }, // Adam — neutral, professional
    en: { voice_id: "ErXwobaYiN019PkySvjV", model: "eleven_turbo_v2_5" }, // Antoni
    pt: { voice_id: "pNInz6obpgDQGcFmaJgB", model: "eleven_turbo_v2_5" }, // Adam (neutral)
  },
};

// Cartesia voice synthesis — standard tier ($0.04/call)
async function synthesizeCartesia(env, text, lang = "es") {
  if (!env.CARTESIA_API_KEY) return null;
  const persona = VOICE_PERSONAS.cartesia[lang] || VOICE_PERSONAS.cartesia.es;

  try {
    const resp = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "X-API-Key": env.CARTESIA_API_KEY,
        "Cartesia-Version": "2024-06-10",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: "sonic-multilingual",
        transcript: text,
        voice: {
          mode: "id",
          id: persona.voice_id,
        },
        output_format: {
          container: "raw",
          encoding: "pcm_mulaw",
          sample_rate: 8000, // telephony standard
        },
        language: persona.language,
      }),
    });

    if (!resp.ok) {
      console.error("Cartesia synthesis failed:", resp.status);
      return null;
    }

    const audioBuffer = await resp.arrayBuffer();
    return {
      provider: "cartesia",
      audio: audioBuffer,
      format: "audio/mulaw",
      sampleRate: 8000,
      tier: "standard",
    };
  } catch (err) {
    console.error("Cartesia error:", err.message);
    return null;
  }
}

// ElevenLabs voice synthesis — premium tier ($0.09/call)
async function synthesizeElevenLabs(env, text, lang = "es") {
  if (!env.ELEVENLABS_API_KEY) return null;
  const persona = VOICE_PERSONAS.elevenlabs[lang] || VOICE_PERSONAS.elevenlabs.es;

  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${persona.voice_id}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": env.ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg",
        },
        body: JSON.stringify({
          text,
          model_id: persona.model,
          voice_settings: {
            stability: 0.45,        // slightly variable = more natural
            similarity_boost: 0.80,
            style: 0.20,            // subtle expressiveness
            use_speaker_boost: true,
          },
          output_format: "ulaw_8000", // telephony standard
        }),
      }
    );

    if (!resp.ok) {
      console.error("ElevenLabs synthesis failed:", resp.status);
      return null;
    }

    const audioBuffer = await resp.arrayBuffer();
    return {
      provider: "elevenlabs",
      audio: audioBuffer,
      format: "audio/mulaw",
      sampleRate: 8000,
      tier: "premium",
    };
  } catch (err) {
    console.error("ElevenLabs error:", err.message);
    return null;
  }
}

// Main voice router — picks provider based on tenant voice_tier
async function synthesizeVoice(env, text, lang = "es", voiceTier = "standard") {
  if (voiceTier === "premium" && env.ELEVENLABS_API_KEY) {
    const result = await synthesizeElevenLabs(env, text, lang);
    if (result) return result;
    // Fallback to Cartesia if ElevenLabs fails
    console.error("ElevenLabs failed — falling back to Cartesia");
  }
  return synthesizeCartesia(env, text, lang);
}

// Generate Mode 1 AI response for a call intent
async function generateCallResponse(env, intent, context, lang = "es") {
  if (!env.ANTHROPIC_API_KEY) return null;

  const SYSTEM = {
    es: `Eres un agente de contact center IA para PrimeCore Intelligence. Respondes en español latinoamericano natural y conversacional. REGLAS: frases cortas, contracciones, nada de lenguaje corporativo. Nunca digas "de acuerdo", "por supuesto", "con gusto". Suenas como un agente humano eficiente y cálido. Máximo 2 oraciones por respuesta. Solo lo que el agente diría en voz alta.`,
    en: `You are an AI contact center agent for PrimeCore Intelligence. You respond in natural conversational English. RULES: short phrases, contractions, no corporate language. Never say "certainly", "of course", "absolutely". Sound like an efficient, warm human agent. Maximum 2 sentences. Only what the agent would say out loud.`,
    pt: `Você é um agente de contact center IA para PrimeCore Intelligence. Você responde em português brasileiro natural e conversacional. REGRAS: frases curtas, contrações, nada de linguagem corporativa. Nunca diga "certamente", "com prazer", "absolutamente". Soe como um agente humano eficiente e caloroso. Máximo 2 frases. Apenas o que o agente diria em voz alta.`,
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
        model: "claude-haiku-4-5-20251001", // fastest + cheapest for real-time calls
        max_tokens: 150,
        system: SYSTEM[lang] || SYSTEM.es,
        messages: [{
          role: "user",
          content: `Intención del llamante: ${intent}
Contexto: ${context || "ninguno"}
Responde como agente de voz en ${lang === "es" ? "español" : lang === "pt" ? "portugués" : "inglés"}.`,
        }],
      }),
    });

    if (!resp.ok) return null;
    const data = await resp.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error("Call response generation failed:", err.message);
    return null;
  }
}

// ── Quote approval endpoint handler ──────────────────────────────────────
async function handleQuoteApproval(request, env, origin) {
  const url    = new URL(request.url);
  const id     = url.searchParams.get("id");
  const option = parseInt(url.searchParams.get("option") || "1", 10);
  const token  = url.searchParams.get("token");

  if (!token || token !== (env.RELAY_AUTH_TOKEN || "")) {
    return json({ ok: false, error: "Unauthorized" }, 401, origin);
  }
  if (!id) return json({ ok: false, error: "Missing id" }, 400, origin);

  // Load lead from KV
  const record = await kvGet(env.RELAY_STATE, "public", "pilot", id);
  if (!record) return json({ ok: false, error: "Lead not found" }, 404, origin);

  const roi   = record.roi;
  const quote = buildCustomQuote(record, roi);
  const chosen = quote.options[Math.min(option, 2)];

  // Send approved quote to prospect
  const lang = record.lang || "en";
  const subjects = {
    en: `Your PrimeCore Intelligence custom plan — ${chosen.label}`,
    es: `Tu plan personalizado de PrimeCore Intelligence — ${chosen.label}`,
    pt: `Seu plano personalizado PrimeCore Intelligence — ${chosen.label}`,
  };

  const bodies = {
    en: `Hi ${record.name},

Following your pilot request, I've put together a custom plan based on your operation's profile.

${chosen.label} Plan — $${chosen.monthly.toLocaleString()}/month
Pilot Month 1: $${chosen.pilot.toLocaleString()} (50% off)

What's included:
${chosen.includes}

At your call volume, our model shows approximately $${Math.abs(chosen.roiMonth1).toLocaleString()}/month in net benefit after plan cost. Break-even comes before the end of your pilot month.

To move forward, reply to this email or click below to start your pilot directly. No setup fees. Cancel before Month 2.

Start your pilot: https://pilot.primecoreintelligence.com

PrimeCore Intelligence — Enterprise Operations`,

    es: `Hola ${record.name},

Tras su solicitud de piloto, he preparado un plan personalizado basado en el perfil de su operación.

Plan ${chosen.label} — $${chosen.monthly.toLocaleString()}/mes
Mes 1 de piloto: $${chosen.pilot.toLocaleString()} (50% de descuento)

Qué incluye:
${chosen.includes}

Con su volumen de llamadas, nuestro modelo muestra aproximadamente $${Math.abs(chosen.roiMonth1).toLocaleString()}/mes de beneficio neto después del costo del plan. El punto de equilibrio llega antes de que termine su mes piloto.

Para avanzar, responda este correo o haga clic abajo para iniciar su piloto directamente. Sin tarifas de configuración. Cancele antes del Mes 2.

Iniciar piloto: https://pilot.primecoreintelligence.com

PrimeCore Intelligence — Operaciones Empresariales`,

    pt: `Olá ${record.name},

Após sua solicitação de piloto, preparei um plano personalizado baseado no perfil da sua operação.

Plano ${chosen.label} — $${chosen.monthly.toLocaleString()}/mês
Mês 1 do piloto: $${chosen.pilot.toLocaleString()} (50% de desconto)

O que está incluído:
${chosen.includes}

Com o seu volume de chamadas, nosso modelo mostra aproximadamente $${Math.abs(chosen.roiMonth1).toLocaleString()}/mês de benefício líquido após o custo do plano. O break-even chega antes do final do seu mês piloto.

Para avançar, responda este email ou clique abaixo para iniciar seu piloto diretamente. Sem taxas de configuração. Cancele antes do Mês 2.

Iniciar piloto: https://pilot.primecoreintelligence.com

PrimeCore Intelligence — Operaciones Empresariales`,
  };

  await sendEmail(env, {
    to:      record.email,
    subject: subjects[lang] || subjects.en,
    body:    bodies[lang]   || bodies.en,
    replyTo: "sales@primecoreintelligence.com",
  });

  // Update lead status in KV
  record.status = "quoted";
  record.quotedAt = new Date().toISOString();
  record.quotedOption = chosen.label;
  await kvPut(env.RELAY_STATE, "public", "pilot", id, record, { expirationTtl: 60*60*24*365 });

  return new Response(
    `<html><body style="font-family:sans-serif;max-width:500px;margin:80px auto;text-align:center">
      <h2>✅ Quote sent to ${record.name}</h2>
      <p>${chosen.label} plan at $${chosen.monthly.toLocaleString()}/mo</p>
      <p style="color:#666">Email delivered to ${record.email}</p>
    </body></html>`,
    { status: 200, headers: { "content-type": "text/html" } }
  );
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

      // Security: cap concurrent clients per session to prevent memory exhaustion
      if (this.clients.size >= 50) {
        return new Response(
          JSON.stringify({ error: "Session at client limit (50). Close another connection first." }),
          { status: 429, headers: { "content-type": "application/json" } }
        );
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
// ── Sales Swarm sweep (internal cron or manual trigger) ──────────────────
async function handleLeadSweep(env) {
  const results = await sweepStaleLeads(env).catch(() => []);
  return { ok: true, swept: results?.length || 0, ts: new Date().toISOString() };
}

// ── Sales Swarm sweep (internal cron or manual trigger) ──────────────────
async function handleLeadSweep(env) {
  const results = await sweepStaleLeads(env).catch(() => []);
  return { ok: true, swept: results?.length || 0, ts: new Date().toISOString() };
}

export default {
  // ── Cron: daily follow-up sequence processor (10:00 UTC) ─────────────
  async scheduled(event, env, ctx) {
    if (!env.RELAY_STATE) return;
    const now = Date.now();
    try {
      // List all follow-up keys
      const keys = await env.RELAY_STATE.list({ prefix: "tenant:public:followup:" });
      for (const key of (keys.keys || [])) {
        try {
          const raw = await env.RELAY_STATE.get(key.name);
          if (!raw) continue;
          const item = JSON.parse(raw);
          if (!item.seq || !item.record) continue;

          const createdAt = item.createdAt || now;
          const daysSince = (now - createdAt) / (1000 * 60 * 60 * 24);
          const record    = item.record;
          const lang      = record.lang || "en";

          for (const step of item.seq) {
            if (step.sent) continue;
            if (daysSince < step.daysOut) continue;

            // Time to send this step
            const subjects = {
              roi_followup: {
                en: `Your PrimeCore ROI estimate — ${record.company}`,
                es: `Su estimación de ROI con PrimeCore — ${record.company}`,
                pt: `Sua estimativa de ROI com PrimeCore — ${record.company}`,
              },
              case_study: {
                en: `How similar operations cut call costs by 78%`,
                es: `Cómo operaciones similares redujeron costos un 78%`,
                pt: `Como operações similares reduziram custos em 78%`,
              },
              closing_loop: {
                en: `Closing the loop — PrimeCore pilot for ${record.company}`,
                es: `Cerrando el ciclo — piloto PrimeCore para ${record.company}`,
                pt: `Encerrando o ciclo — piloto PrimeCore para ${record.company}`,
              },
            };

            const bodies = {
              roi_followup: {
                en: `Hi ${record.name},\n\nFollowing up on your PrimeCore Intelligence request from a few days ago.\n\nBased on your volume (${record.volume}), our model estimates $${record.roi ? Math.abs(record.roi.netMonthly).toLocaleString() : "8,000–24,000"}/month in net savings after plan cost.\n\nIf that number is interesting, reply here and I'll set up a 20-minute compatibility check — no commitment, just numbers.\n\nPrimeCore Intelligence — Enterprise Operations`,
                es: `Hola ${record.name},\n\nSiguiendo con su solicitud de PrimeCore Intelligence de hace unos días.\n\nBasado en su volumen (${record.volume}), nuestro modelo estima $${record.roi ? Math.abs(record.roi.netMonthly).toLocaleString() : "8,000–24,000"}/mes en ahorros netos.\n\nSi ese número le interesa, responda aquí y coordino una verificación de compatibilidad de 20 minutos.\n\nPrimeCore Intelligence — Operaciones Empresariales`,
                pt: `Olá ${record.name},\n\nSeguindo com sua solicitação da PrimeCore Intelligence de alguns dias atrás.\n\nCom base no seu volume (${record.volume}), nosso modelo estima $${record.roi ? Math.abs(record.roi.netMonthly).toLocaleString() : "8.000–24.000"}/mês em economias líquidas.\n\nSe esse número for interessante, responda aqui e agendo uma verificação de compatibilidade de 20 minutos.\n\nPrimeCore Intelligence — Operaciones Empresariales`,
              },
              case_study: {
                en: `Hi ${record.name},\n\nSharing a quick data point that might be relevant to your evaluation:\n\nA logistics operator with a similar profile to yours — 22,000 calls/month, 12 agents — reduced their per-call cost from $6.50 to $0.04 on Tier-1 volume. AHT dropped from 5:40 to under 2 minutes. Six weeks, no SLA breaches.\n\nHappy to walk you through exactly how that was configured if you want a 20-minute call.\n\nPrimeCore Intelligence — Enterprise Operations`,
                es: `Hola ${record.name},\n\nComparto un dato que podría ser relevante para su evaluación:\n\nUn operador logístico con un perfil similar al suyo — 22,000 llamadas/mes, 12 agentes — redujo su costo por llamada de $6.50 a $0.04 en volumen Nivel 1. El AHT bajó de 5:40 a menos de 2 minutos. Seis semanas, sin incumplimientos de SLA.\n\nCon gusto le explico exactamente cómo se configuró si quiere una llamada de 20 minutos.\n\nPrimeCore Intelligence — Operaciones Empresariales`,
                pt: `Olá ${record.name},\n\nCompartilhando um dado que pode ser relevante para sua avaliação:\n\nUm operador logístico com um perfil semelhante ao seu — 22.000 chamadas/mês, 12 agentes — reduziu o custo por chamada de $6,50 para $0,04 no volume Nível 1. O AHT caiu de 5:40 para menos de 2 minutos. Seis semanas, sem violações de SLA.\n\nPosso explicar exatamente como foi configurado se quiser uma chamada de 20 minutos.\n\nPrimeCore Intelligence — Operaciones Empresariales`,
              },
              closing_loop: {
                en: `Hi ${record.name},\n\nClosing the loop on your PrimeCore pilot request.\n\nIf the timing isn't right, no problem at all — I'll stop following up after this. If you want to revisit when the time is right, the pilot link is always open: https://pilot.primecoreintelligence.com\n\nEither way, good luck with the operation.\n\nPrimeCore Intelligence — Enterprise Operations`,
                es: `Hola ${record.name},\n\nCerrando el ciclo sobre su solicitud de piloto PrimeCore.\n\nSi el momento no es el correcto, no hay problema — dejaré de hacer seguimiento después de este mensaje. Si quiere retomarlo cuando sea el momento adecuado, el enlace del piloto siempre está disponible: https://pilot.primecoreintelligence.com\n\nDe cualquier forma, mucho éxito con la operación.\n\nPrimeCore Intelligence — Operaciones Empresariales`,
                pt: `Olá ${record.name},\n\nEncerrando o ciclo sobre sua solicitação de piloto PrimeCore.\n\nSe o momento não é o certo, sem problema — vou parar de fazer follow-up após esta mensagem. Se quiser retomar quando o momento for certo, o link do piloto está sempre disponível: https://pilot.primecoreintelligence.com\n\nDe qualquer forma, boa sorte com a operação.\n\nPrimeCore Intelligence — Operaciones Empresariales`,
              },
            };

            const subject = (subjects[step.type] || {})[lang] || subjects.roi_followup.en;
            const body    = (bodies[step.type] || {})[lang]    || bodies.roi_followup.en;

            await sendEmail(env, {
              to:      record.email,
              subject,
              body,
              replyTo: "sales@primecoreintelligence.com",
            });

            step.sent   = true;
            step.sentAt = new Date().toISOString();
            break; // only one step per run
          }

          // Update KV with sent flags
          const allSent = item.seq.every(s => s.sent);
          if (allSent) {
            await env.RELAY_STATE.delete(key.name);
          } else {
            await env.RELAY_STATE.put(key.name, JSON.stringify(item),
              { expirationTtl: 60 * 60 * 24 * 14 });
          }
        } catch(e) { /* skip broken entries */ }
      }
    } catch(e) { /* fail silently */ }
  },

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
        // Security: validate auth on WS upgrade — prevents session hijacking
        // Accept Bearer in Authorization header or ?token= query param
        // (query param supports browser WebSocket API which can't set custom headers)
        const wsToken = (request.headers.get("authorization") || "")
          .replace(/^bearer\s+/i, "").trim() || url.searchParams.get("token") || "";
        const expected = (env.RELAY_AUTH_TOKEN || "").trim();
        if (expected && wsToken !== expected) {
          return new Response(
            JSON.stringify({ error: "Unauthorized — provide Authorization: Bearer {token} or ?token= param" }),
            { status: 401, headers: { "content-type": "application/json" } }
          );
        }
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

    // ══════════════════════════════════════════════════════════════════════
    // CALL RESPOND — POST /relay/call/respond
    // CCaaS sends caller's transcribed speech → relay returns voice audio
    // Body: { callId, tenantId, intent, transcript, lang, context, voice_tier }
    // Returns: audio/mulaw (8kHz) for direct playback via CCaaS
    // ══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/relay/call/respond") {
      let body = {};
      try { body = await request.json(); } catch { return json({ ok:false, error:"Invalid JSON" }, 400, origin); }

      const callId    = sanitize(body.callId || "", 100);
      const intent    = sanitize(body.intent || body.transcript || "", 500);
      const lang      = sanitize(body.lang || "es", 5);
      const context   = sanitize(body.context || "", 1000);
      const voiceTier = sanitize(body.voice_tier || "standard", 20);

      if (!intent) return json({ ok:false, error:"intent or transcript required" }, 422, origin);

      // 1. Generate AI response text
      const responseText = await generateCallResponse(env, intent, context, lang);
      if (!responseText) {
        return json({ ok:false, error:"AI response generation failed" }, 500, origin);
      }

      // 2. Synthesize voice
      const voiceResult = await synthesizeVoice(env, responseText, lang, voiceTier);
      if (!voiceResult) {
        // Return text fallback if voice synthesis unavailable
        return json({
          ok: true,
          callId,
          response_text: responseText,
          voice_available: false,
          voice_tier: voiceTier,
          provider: "none",
        }, 200, origin);
      }

      // 3. Log the interaction
      ctx.waitUntil(kvPut(env.RELAY_EVENTS, tenantId, "call_response", 
        `${callId}_${Date.now()}`,
        { callId, intent: intent.slice(0,100), responseText: responseText.slice(0,200), 
          lang, voiceTier, provider: voiceResult.provider, ts: new Date().toISOString() },
        { expirationTtl: 60*60*24 }
      ).catch(() => {}));

      // 4. Return audio bytes directly for CCaaS playback
      return new Response(voiceResult.audio, {
        status: 200,
        headers: {
          "Content-Type": voiceResult.format,
          "X-Sample-Rate": String(voiceResult.sampleRate),
          "X-Voice-Provider": "primecore-voice",
          "X-Voice-Tier": voiceResult.tier,  // primecore-voice or primecore-voice-pro
          "X-Response-Text": encodeURIComponent(responseText.slice(0, 200)),
          "Access-Control-Allow-Origin": origin || "*",
        },
      });
    }

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
      if (errors.length) return json({ ok:false, errors }, 422, origin);

      const id = `pilot_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
      const record = {
        id, tenantId:"public",
        name:     sanitize(body.name),
        email:    sanitize(body.email, 200),
        company:  sanitize(body.company || "Not provided"),
        ccaas:    sanitize(body.ccaas   || "Not specified"),
        volume:   sanitize(body.volume  || ""),
        vertical: sanitize(body.vertical || ""),
        notes:    sanitize(body.notes   || "", 1000),
        source:   sanitize(body.source  || "primecoreintelligence.com", 200),
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

      // ── Fire all emails + agent tasks ──────────────────────────────────
      const ccaasSlug = (record.ccaas || "other").toLowerCase().replace(/[^a-z0-9]/g,"");
      const onboardingUrl = `https://pilot.primecoreintelligence.com/onboarding/?pilot=${id}&platform=${ccaasSlug}&lang=${record.lang || "en"}&client=${encodeURIComponent(record.name)}`;

      // 1. Internal notification to founder
      ctx.waitUntil(sendEmail(env, {
        to:      env.NOTIFY_EMAIL || "sales@primecoreintelligence.com",
        subject: `New Pilot Request — ${record.company} (${record.volume})`,
        body:    `New Pilot Request

Name:     ${record.name}
Email:    ${record.email}
Company:  ${record.company}
Volume:   ${record.volume}
Vertical: ${record.vertical || "Not specified"}
ROI:      ${record.roi ? "$" + Math.abs(record.roi.netMonthly).toLocaleString() + "/mo net savings" : "pending"}
ID:       ${id}

Onboarding link: ${onboardingUrl}`,
        replyTo: record.email,
      }));

      // 2. AI-written personal reply to prospect
      ctx.waitUntil((async () => {
        try {
          const aiReply = await generateProspectReply(env, record, record.roi);
          const subj = {
            en: "Re: Your PrimeCore Intelligence pilot request",
            es: "Re: Su solicitud de piloto PrimeCore Intelligence",
            pt: "Re: Sua solicitação de piloto PrimeCore Intelligence",
          };
          await sendEmail(env, {
            to:      record.email,
            subject: subj[record.lang || "en"] || subj.en,
            body:    aiReply || `Hi ${record.name},

Thank you for requesting a PrimeCore Intelligence pilot.

I'll personally review your setup and reach out today with next steps tailored to your operation.

PrimeCore Intelligence — Enterprise Operations
ops@primecoreintelligence.com`,
            replyTo: "sales@primecoreintelligence.com",
          });
        } catch(e) { /* fail silently */ }
      })());

      // 3. Custom quote for enterprise volume — await founder approval
      if (record.volume === "100k+" || record.volume === "20k-100k") {
        ctx.waitUntil((async () => {
          try {
            const quote = buildCustomQuote(record, record.roi);
            await sendApprovalRequest(env, record, record.roi, quote);
            if (env.RELAY_STATE) {
              await kvPut(env.RELAY_STATE, "public", "quote", id, quote, { expirationTtl: 60*60*24*30 });
            }
          } catch(e) { /* fail silently */ }
        })());
      }

      // 4. Schedule follow-up sequence
      ctx.waitUntil(scheduleFollowUps(env, record, record.roi).catch(() => {}));

      // 4b. Installation Agent — guided shadow mode setup (high-volume pilots only)
      if (record.volume === '20k-100k' || record.volume === '100k+') {
        ctx.waitUntil(scheduleInstallationAgent(env, record).catch(() => {}));
      }

      // 5. Create Notion lead page + fire Slack alert (non-blocking)
      ctx.waitUntil((async () => {
        try {
          const notionResult = await createNotionLead(env, record, record.roi);
          await sendSlackAlert(env, record, notionResult, record.roi);
        } catch (e) { /* non-critical */ }
      })());

      // 6. Forward to war-room
      if (env.WAR_ROOM_API_TOKEN) {
        ctx.waitUntil(fetch(`${WAR_ROOM_API}/api/pilot-request`, {
          method: "POST",
          headers: { "content-type": "application/json", "authorization": `Bearer ${env.WAR_ROOM_API_TOKEN}` },
          body: JSON.stringify(record),
        }).catch(() => {}));
      }

      // 5. Sales Swarm — trigger lead orchestrator asynchronously (Qualifier → Closer)
      ctx.waitUntil(
        runLeadOrchestrator(id, {
          name:     record.name,
          email:    record.email,
          company:  record.company,
          phone:    record.phone || "",
          ccaas:    record.ccaas || "",
          volume:   record.volume || "",
          vertical: record.vertical || "",
          notes:    record.notes || "",
          lang:     record.lang || "en",
          source:   "pilot_form",
        }, env).catch(() => { /* swarm failure is non-fatal */ })
      );

      // 5. Sales Swarm — trigger lead orchestrator asynchronously (Qualifier → Closer)
      ctx.waitUntil(
        runLeadOrchestrator(id, {
          name:     record.name,
          email:    record.email,
          company:  record.company,
          phone:    record.phone || "",
          ccaas:    record.ccaas || "",
          volume:   record.volume || "",
          vertical: record.vertical || "",
          notes:    record.notes || "",
          lang:     record.lang || "en",
          source:   "pilot_form",
        }, env).catch(() => { /* swarm failure is non-fatal */ })
      );

      return json({ ok:true, id, roi:record.roi || null, message:"Pilot request received. We will contact you within 1 business day." }, 201, origin);
    }

    // ── Quote approval (founder one-click approve) ────────────────────────
    if (request.method === "GET" && path === "/relay/quote-approve") {
      return handleQuoteApproval(request, env, origin);
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


    // ══════════════════════════════════════════════════════════════════════
    // PADDLE WEBHOOK — Finance Tower live revenue
    // POST /relay/paddle/webhook
    //
    // Events handled:
    //   subscription.activated   → increment active MRR
    //   subscription.cancelled   → decrement MRR
    //   subscription.updated     → update MRR tier
    //   transaction.completed    → record one-time payment
    //   transaction.payment_failed → fire SEV2 alert
    //
    // Paddle-Signature header is verified (HMAC-SHA256) if PADDLE_WEBHOOK_SECRET is set.
    // ══════════════════════════════════════════════════════════════════════
    if (request.method === "POST" && path === "/relay/paddle/webhook") {
      const rawBody = await request.text();

      // Signature verification (skip if secret not configured — log warning)
      if (env.PADDLE_WEBHOOK_SECRET) {
        const sigHeader = request.headers.get("paddle-signature") || "";
        // Paddle format: ts=<timestamp>;h1=<hmac>
        const parts = Object.fromEntries(sigHeader.split(";").map(p => p.split("=").map((v, i) => i === 0 ? v : p.slice(p.indexOf("=")+1))));
        const ts    = parts["ts"] || "";
        const h1    = parts["h1"] || "";
        if (ts && h1) {
          const encoder = new TextEncoder();
          const key = await crypto.subtle.importKey(
            "raw", encoder.encode(env.PADDLE_WEBHOOK_SECRET),
            { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
          );
          const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(`${ts}:${rawBody}`));
          const expected = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
          if (expected !== h1) {
            return json({ ok: false, error: "Invalid Paddle signature" }, 401, origin);
          }
        }
      } else {
        console.warn("[Paddle] PADDLE_WEBHOOK_SECRET not set — skipping signature verification");
      }

      let event = {};
      try { event = JSON.parse(rawBody); } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400, origin);
      }

      const eventType    = event.event_type || event.notification_type || "";
      const eventData    = event.data || {};
      const subscId      = eventData.id || eventData.subscription_id || "";
      const customerId   = eventData.customer_id || "";
      const items        = eventData.items || [];
      const priceId      = items[0]?.price?.id || "";
      const unitPrice    = items[0]?.price?.unit_price?.amount || 0;
      const currency     = items[0]?.price?.unit_price?.currency_code || "USD";
      // Paddle amounts are in lowest denomination (cents)
      const amountUsd    = currency === "USD" ? Math.round(unitPrice / 100) : unitPrice;
      const now          = new Date().toISOString();

      // Map Paddle price ID to plan name (configure in Cloudflare secrets as JSON)
      // PADDLE_PRICE_MAP = '{"pri_xxx":"Starter","pri_yyy":"Professional","pri_zzz":"Enterprise"}'
      let planName = "Unknown";
      try {
        const priceMap = JSON.parse(env.PADDLE_PRICE_MAP || "{}");
        planName = priceMap[priceId] || planName;
      } catch { /* use Unknown */ }

      if (!env.RELAY_STATE) {
        return json({ ok: false, error: "RELAY_STATE KV not configured" }, 503, origin);
      }

      // ── Read current finance state ──────────────────────────────────────
      const finKey  = "finance:mrr:live";
      const rawFin  = await env.RELAY_STATE.get(finKey);
      const finance = rawFin ? JSON.parse(rawFin) : {
        mrr_cents:       0,
        active_subs:     0,
        churned_subs:    0,
        transactions:    [],
        last_updated:    null,
      };

      // ── Process event ────────────────────────────────────────────────────
      let action = "unknown";

      if (eventType === "subscription.activated" || eventType === "subscription.created") {
        finance.mrr_cents   += amountUsd * 100;
        finance.active_subs += 1;
        action = "subscription_activated";
        finance.transactions.unshift({ id: subscId, type: "sub_start", amount: amountUsd, plan: planName, customer: customerId, ts: now });

      } else if (eventType === "subscription.cancelled") {
        finance.mrr_cents   = Math.max(0, finance.mrr_cents - amountUsd * 100);
        finance.active_subs = Math.max(0, finance.active_subs - 1);
        finance.churned_subs += 1;
        action = "subscription_cancelled";
        finance.transactions.unshift({ id: subscId, type: "churn", amount: -amountUsd, plan: planName, customer: customerId, ts: now });

        // Fire SEV2 alert on churn
        if (env.SLACK_WEBHOOK_URL || env.SLACK_WEBHOOK_ALERTS) {
          const slackPayload = {
            text: `🟡 Subscription Cancelled — ${planName} ($${amountUsd}/mo)`,
            blocks: [{
              type: "section",
              text: { type: "mrkdwn", text: `*Churn Event:* ${planName} plan cancelled\n*Amount lost:* $${amountUsd}/mo\n*Customer:* ${customerId}\n*Time:* ${now}` },
            }],
          };
          ctx.waitUntil(fetch(env.SLACK_WEBHOOK_ALERTS || env.SLACK_WEBHOOK_URL, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(slackPayload),
          }).catch(() => {}));
        }

      } else if (eventType === "subscription.updated") {
        // Price change — delta update
        const prevAmount = eventData.previous_billing_period?.unit_price?.amount || 0;
        const delta = amountUsd * 100 - prevAmount;
        finance.mrr_cents += delta;
        action = "subscription_updated";
        finance.transactions.unshift({ id: subscId, type: "upgrade", amount: amountUsd, plan: planName, customer: customerId, ts: now });

      } else if (eventType === "transaction.completed") {
        const txAmount = eventData.details?.totals?.grand_total || unitPrice;
        const txAmountUsd = currency === "USD" ? Math.round(txAmount / 100) : txAmount;
        action = "transaction_completed";
        finance.transactions.unshift({ id: eventData.id || subscId, type: "payment", amount: txAmountUsd, plan: planName, customer: customerId, ts: now });

      } else if (eventType === "transaction.payment_failed") {
        action = "payment_failed";
        finance.transactions.unshift({ id: eventData.id || subscId, type: "failed", amount: amountUsd, plan: planName, customer: customerId, ts: now });

        // SEV2 alert — payment failure
        if (env.SLACK_WEBHOOK_URL || env.SLACK_WEBHOOK_ALERTS) {
          const slackPayload = {
            text: `🔴 Payment Failed — ${planName} ($${amountUsd})`,
            blocks: [{
              type: "section",
              text: { type: "mrkdwn", text: `*Payment Failed:* ${planName} plan\n*Amount:* $${amountUsd}\n*Customer:* ${customerId}\n*Time:* ${now}` },
            }],
          };
          ctx.waitUntil(fetch(env.SLACK_WEBHOOK_ALERTS || env.SLACK_WEBHOOK_URL, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(slackPayload),
          }).catch(() => {}));
        }
      }

      // Keep last 100 transactions
      finance.transactions = finance.transactions.slice(0, 100);
      finance.last_updated = now;
      finance.mrr          = Math.round(finance.mrr_cents / 100);

      // Persist
      await env.RELAY_STATE.put(finKey, JSON.stringify(finance), { expirationTtl: 60 * 60 * 24 * 90 });

      // Broadcast SSE to Command Station if event type was meaningful
      if (action !== "unknown") {
        ctx.waitUntil(fetch("https://primecore-command-production.up.railway.app/api/warroom/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.RELAY_AUTH_TOKEN || ""}` },
        }).catch(() => {}));
      }

      return json({ ok: true, event_type: eventType, action, mrr: finance.mrr, active_subs: finance.active_subs }, 200, origin);
    }

    // ── GET /relay/finance — Command Station polls this for live revenue ──────
    if (request.method === "GET" && path === "/relay/finance") {
      const auth = requireAuth(request, env);
      if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code, origin);
      if (!env.RELAY_STATE) return json({ ok: false, error: "RELAY_STATE not configured" }, 503, origin);
      const raw = await env.RELAY_STATE.get("finance:mrr:live");
      const finance = raw ? JSON.parse(raw) : { mrr: 0, active_subs: 0, churned_subs: 0, transactions: [], last_updated: null };
      return json({ ok: true, ...finance }, 200, origin);
    }

    // ══════════════════════════════════════════════════════════════════════
    // APPROVAL QUEUE — Founder-gated action management
    // POST /relay/approvals          — create approval request
    // GET  /relay/approvals          — list pending approvals
    // GET  /relay/approvals/:id/approve — one-tap approve (from Slack button)
    // GET  /relay/approvals/:id/deny    — one-tap deny
    // ══════════════════════════════════════════════════════════════════════
    if (path === "/relay/approvals" || path.startsWith("/relay/approvals/")) {

      // ── Create approval request ──────────────────────────────────────────
      if (request.method === "POST" && path === "/relay/approvals") {
        const auth = requireAuth(request, env);
        if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code, origin);
        if (!env.RELAY_STATE) return json({ ok: false, error: "RELAY_STATE not configured" }, 503, origin);

        let body = {};
        try { body = await request.json(); } catch {
          return json({ ok: false, error: "Invalid JSON" }, 400, origin);
        }

        const approvalId  = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const expiresInMin = body.expiresInMin || 60;
        const approval = {
          id:           approvalId,
          action:       sanitize(body.action || "Unknown action", 200),
          risk:         ["high", "medium", "low"].includes(body.risk) ? body.risk : "medium",
          context:      sanitize(body.context || "", 500),
          factory:      sanitize(body.factory || "System", 50),
          status:       "pending",
          createdAt:    new Date().toISOString(),
          expiresAt:    new Date(Date.now() + expiresInMin * 60 * 1000).toISOString(),
          decidedAt:    null,
          decision:     null,
        };

        const approveUrl = `https://relay.primecoreintelligence.com/relay/approvals/${approvalId}/approve?token=${env.RELAY_AUTH_TOKEN}`;
        const denyUrl    = `https://relay.primecoreintelligence.com/relay/approvals/${approvalId}/deny?token=${env.RELAY_AUTH_TOKEN}`;
        approval.approveUrl = approveUrl;
        approval.denyUrl    = denyUrl;

        // Persist to KV
        const kvKey = `approval:${approvalId}`;
        await env.RELAY_STATE.put(kvKey, JSON.stringify(approval), { expirationTtl: 60 * 60 * 24 });

        // Track in pending list
        const pendingRaw = await env.RELAY_STATE.get("approvals:pending");
        const pending    = pendingRaw ? JSON.parse(pendingRaw) : [];
        pending.unshift(approvalId);
        await env.RELAY_STATE.put("approvals:pending", JSON.stringify(pending.slice(0, 50)),
          { expirationTtl: 60 * 60 * 24 });

        // Fire Slack notification → #pci-approvals
        if (env.SLACK_WEBHOOK_URL || env.SLACK_WEBHOOK_APPROVALS) {
          const riskEmoji = { high: "🔴", medium: "🟡", low: "🟢" }[approval.risk] || "🟡";
          const slackPayload = {
            text: `${riskEmoji} Approval Required: ${approval.action}`,
            blocks: [
              { type: "header", text: { type: "plain_text", text: `${riskEmoji} Operations Review Required` } },
              { type: "section", text: { type: "mrkdwn",
                text: `*Action:* ${approval.action}\n*Factory:* ${approval.factory}\n*Risk:* ${approval.risk.toUpperCase()}\n*ID:* \`${approvalId}\`` } },
              approval.context ? { type: "section", text: { type: "mrkdwn", text: `*Context:*\n${approval.context}` } } : null,
              { type: "actions", elements: [
                { type: "button", text: { type: "plain_text", text: "✅  APPROVE" }, url: approveUrl, style: "primary" },
                { type: "button", text: { type: "plain_text", text: "❌  DENY" },    url: denyUrl,    style: "danger" },
              ]},
              { type: "context", elements: [{ type: "mrkdwn",
                text: `PrimeCore Intelligence · Policy Engine · Expires ${new Date(Date.now() + expiresInMin * 60000).toUTCString()}` }] },
            ].filter(Boolean),
          };
          ctx.waitUntil(fetch(env.SLACK_WEBHOOK_APPROVALS || env.SLACK_WEBHOOK_URL, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(slackPayload),
          }).catch(() => {}));
        }

        return json({ ok: true, approvalId, approveUrl, denyUrl, approval }, 201, origin);
      }

      // ── List pending approvals ───────────────────────────────────────────
      if (request.method === "GET" && path === "/relay/approvals") {
        const auth = requireAuth(request, env);
        if (!auth.ok) return json({ ok: false, error: auth.msg }, auth.code, origin);
        if (!env.RELAY_STATE) return json({ ok: false, error: "RELAY_STATE not configured" }, 503, origin);

        const pendingRaw = await env.RELAY_STATE.get("approvals:pending");
        const pendingIds = pendingRaw ? JSON.parse(pendingRaw) : [];

        const approvals = await Promise.all(
          pendingIds.slice(0, 20).map(async id => {
            const raw = await env.RELAY_STATE.get(`approval:${id}`);
            return raw ? JSON.parse(raw) : null;
          })
        );

        const active = approvals
          .filter(Boolean)
          .filter(a => a.status === "pending" && new Date(a.expiresAt) > new Date())
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

        return json({ ok: true, count: active.length, approvals: active }, 200, origin);
      }

      // ── One-tap Approve ──────────────────────────────────────────────────
      if (request.method === "GET" && path.endsWith("/approve")) {
        const token = url.searchParams.get("token") || "";
        if (!token || token !== (env.RELAY_AUTH_TOKEN || "")) {
          return new Response("Unauthorized", { status: 401 });
        }
        const approvalId = path.split("/relay/approvals/")[1]?.split("/")[0];
        if (!approvalId || !env.RELAY_STATE) return new Response("Not found", { status: 404 });

        const raw = await env.RELAY_STATE.get(`approval:${approvalId}`);
        if (!raw) return new Response("Approval not found", { status: 404 });
        const approval = JSON.parse(raw);
        approval.status    = "approved";
        approval.decision  = "approved";
        approval.decidedAt = new Date().toISOString();
        await env.RELAY_STATE.put(`approval:${approvalId}`, JSON.stringify(approval),
          { expirationTtl: 60 * 60 * 24 * 7 });

        return new Response(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Approved</title><style>body{font-family:system-ui;background:#0a1628;color:#00c9a7;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px}</style></head><body><div style="font-size:48px">✅</div><h2>Approved</h2><p style="color:#7a93b8">${approval.action}</p><p style="color:#4a6080;font-size:12px">PrimeCore Intelligence · ${approval.decidedAt}</p></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }

      // ── One-tap Deny ─────────────────────────────────────────────────────
      if (request.method === "GET" && path.endsWith("/deny")) {
        const token = url.searchParams.get("token") || "";
        if (!token || token !== (env.RELAY_AUTH_TOKEN || "")) {
          return new Response("Unauthorized", { status: 401 });
        }
        const approvalId = path.split("/relay/approvals/")[1]?.split("/")[0];
        if (!approvalId || !env.RELAY_STATE) return new Response("Not found", { status: 404 });

        const raw = await env.RELAY_STATE.get(`approval:${approvalId}`);
        if (!raw) return new Response("Approval not found", { status: 404 });
        const approval = JSON.parse(raw);
        approval.status    = "denied";
        approval.decision  = "denied";
        approval.decidedAt = new Date().toISOString();
        await env.RELAY_STATE.put(`approval:${approvalId}`, JSON.stringify(approval),
          { expirationTtl: 60 * 60 * 24 * 7 });

        return new Response(
          `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Denied</title><style>body{font-family:system-ui;background:#0a1628;color:#ef4444;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;flex-direction:column;gap:16px}</style></head><body><div style="font-size:48px">❌</div><h2>Denied</h2><p style="color:#7a93b8">${approval.action}</p><p style="color:#4a6080;font-size:12px">PrimeCore Intelligence · ${approval.decidedAt}</p></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } }
        );
      }
    }

    return json({ ok:false, error:"Not found", path }, 404, origin);
  },
};
