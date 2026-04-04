/**
 * PrimeCore Intelligence — Lead Research & ROI Intelligence Engine v1.0
 * ────────────────────────────────────────────────────────────────────────
 * Runs automatically when a new lead enters the system.
 * Uses Claude to research the company and produce:
 *   1. Company dossier (funding, size, hiring, tech stack, news)
 *   2. 8-dimension intelligence score (0–100)
 *   3. Gut-wrenching opportunity flags (auto-escalate to founder)
 *   4. Recommended tier + routing priority
 *
 * Score dimensions (each 0–12.5 points = 100 total):
 *   1. Budget signals (funding, revenue, spending patterns)
 *   2. Company growth trajectory (hiring, expansion)
 *   3. Industry fit & vertical alignment
 *   4. Decision-maker accessibility (title, org structure)
 *   5. Technology stack maturity (already buying tools)
 *   6. Urgency signals (pain indicators, competitor displacement)
 *   7. Business legitimacy & stability
 *   8. Strategic value (LTV potential, reference value)
 *
 * Routing rules:
 *   90+ → Priority 1: Retell calls within 1 hour
 *   75–89 → Priority 2: Call within 24 hours
 *   50–74 → Priority 3: Founder 1-tap review
 *   <50  → Auto-reject: polite email + Notion log
 *
 * Gut-wrenching opportunity flags (override score — always escalate):
 *   - Raised funding in last 90 days
 *   - Revenue signals above $1M/yr
 *   - Hiring 5+ people right now
 *   - Competitor of existing client (displacement opportunity)
 *   - Industry in high-growth moment
 *   - Inbound from Fortune 1000 / enterprise brand
 */

"use strict";

// ── Minimum deal thresholds (ROI-first mandate) ──────────────────────────
const TIER_THRESHOLDS = {
  STARTER:      { minScore: 85, monthly: 2400,  label: "Starter"      },
  PROFESSIONAL: { minScore: 75, monthly: 5800,  label: "Professional" },
  ENTERPRISE:   { minScore: 60, monthly: 7997,  label: "Enterprise"   },
};

// High-growth industries that get priority regardless of score
const HIGH_GROWTH_INDUSTRIES = [
  "ai", "artificial intelligence", "machine learning",
  "fintech", "financial technology", "insurtech",
  "healthtech", "health technology", "telemedicine", "digital health",
  "logistics tech", "supply chain tech", "legaltech",
  "edtech", "hr tech", "proptech",
];

// ── KV helpers (local — match leadOrchestrator pattern) ──────────────────
async function kvGet(kv, key) {
  if (!kv) return null;
  try { const r = await kv.get(key); return r ? JSON.parse(r) : null; }
  catch { return null; }
}

async function kvPut(kv, key, value, ttl = 60 * 60 * 24 * 90) {
  if (!kv) return false;
  try { await kv.put(key, JSON.stringify(value), { expirationTtl: ttl }); return true; }
  catch { return false; }
}

function researchKey(leadId, field) {
  return `tenant:warroom:lead:${leadId}:research:${field}`;
}

function nowIso() { return new Date().toISOString(); }

// ── Extract domain from email ─────────────────────────────────────────────
function extractDomain(email = "") {
  const parts = email.split("@");
  return parts.length === 2 ? parts[1].toLowerCase().trim() : "";
}

// ── Claude research prompt ────────────────────────────────────────────────
function buildResearchPrompt(lead) {
  const domain = extractDomain(lead.email);
  return `You are a B2B sales intelligence researcher for PrimeCore Intelligence, an AI-powered CCaaS platform.

Research the following company and produce a structured intelligence report.

COMPANY: ${lead.company}
CONTACT EMAIL DOMAIN: ${domain}
INDUSTRY/VERTICAL: ${lead.vertical || "unknown"}
CONTACT NAME: ${lead.name}
NOTES FROM LEAD FORM: ${lead.notes || "none"}
VOLUME STATED: ${lead.volume || "unknown"} calls/month
CURRENT CCAAS: ${lead.ccaas || "unknown"}

Using your knowledge of this company and industry, provide a JSON response with this EXACT structure:

{
  "company_overview": {
    "description": "1-2 sentence company description",
    "industry": "primary industry",
    "estimated_employees": "number or range e.g. 50-200",
    "estimated_revenue": "annual revenue estimate e.g. $5M-$20M",
    "founded_year": "year or null",
    "headquarters": "city, state/country",
    "business_model": "B2B / B2C / B2B2C"
  },
  "growth_signals": {
    "hiring_activity": "active / moderate / low / unknown",
    "hiring_count": "number of open positions if known or 0",
    "growth_stage": "seed / early / growth / mature / enterprise",
    "recent_funding": true or false,
    "funding_amount": "amount if known or null",
    "funding_date": "date if known or null",
    "expansion_signals": ["list of any expansion indicators"]
  },
  "tech_stack": {
    "crm": "Salesforce / HubSpot / Pipedrive / unknown",
    "ccaas_confirmed": "Five9 / Genesys / NICE / Talkdesk / other / none / unknown",
    "erp": "SAP / Oracle / NetSuite / unknown",
    "tech_sophistication": "high / medium / low",
    "buying_signals": ["tools or platforms they are actively purchasing"]
  },
  "risk_flags": {
    "layoffs_recent": true or false,
    "financial_distress": true or false,
    "regulatory_issues": true or false,
    "negative_news": true or false,
    "negative_news_detail": "brief description or null"
  },
  "opportunity_signals": {
    "competitor_displacement": true or false,
    "current_competitor": "name of competitor they use or null",
    "pain_indicators": ["list of pain points relevant to CCaaS"],
    "decision_maker_accessible": true or false,
    "inbound_intent": "high / medium / low",
    "strategic_value": "high / medium / low",
    "strategic_reason": "why this is or isn't a high-value reference client"
  },
  "score_dimensions": {
    "budget_signals": { "score": 0-12, "reasoning": "brief" },
    "growth_trajectory": { "score": 0-12, "reasoning": "brief" },
    "industry_fit": { "score": 0-13, "reasoning": "brief" },
    "decision_maker": { "score": 0-13, "reasoning": "brief" },
    "tech_maturity": { "score": 0-12, "reasoning": "brief" },
    "urgency": { "score": 0-13, "reasoning": "brief" },
    "legitimacy": { "score": 0-13, "reasoning": "brief" },
    "strategic_value": { "score": 0-12, "reasoning": "brief" }
  },
  "recommended_tier": "Starter / Professional / Enterprise",
  "gut_wrenching_opportunity": true or false,
  "gut_wrenching_reason": "why this is exceptional or null",
  "one_line_brief": "One sentence the system would say to flag this lead to operations",
  "confidence": "high / medium / low"
}

Be precise. Use your knowledge about the company if you recognize it. If you don't know the company specifically, use the domain and industry context to make reasonable inferences. Mark confidence as low if highly uncertain. Return ONLY valid JSON — no markdown, no explanation.`;
}

// ── Parse and validate Claude's JSON response ─────────────────────────────
function parseResearchResponse(raw) {
  try {
    // Strip markdown if Claude wrapped it
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    const data = JSON.parse(cleaned);

    // Validate required fields exist
    if (!data.score_dimensions || !data.company_overview) {
      throw new Error("Missing required fields");
    }
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message, raw };
  }
}

// ── Compute aggregate score from 8 dimensions ────────────────────────────
function computeAggregateScore(dimensions) {
  const keys = [
    "budget_signals", "growth_trajectory", "industry_fit", "decision_maker",
    "tech_maturity", "urgency", "legitimacy", "strategic_value",
  ];
  let total = 0;
  for (const k of keys) {
    const dim = dimensions[k];
    if (dim && typeof dim.score === "number") {
      total += Math.min(dim.score, 13); // cap each dimension
    }
  }
  return Math.min(Math.round(total), 100);
}

// ── Detect gut-wrenching opportunity flags ────────────────────────────────
function detectGutWrenchingFlags(research, lead) {
  const flags = [];

  // Recent funding
  if (research.growth_signals?.recent_funding) {
    flags.push(`Recent funding: ${research.growth_signals.funding_amount || "undisclosed"}`);
  }

  // High revenue signal
  const rev = research.company_overview?.estimated_revenue || "";
  if (rev.includes("M") || rev.includes("B") || rev.includes("billion")) {
    const match = rev.match(/\$?([\d.]+)\s*(M|B)/i);
    if (match) {
      const amount = parseFloat(match[1]) * (match[2].toUpperCase() === "B" ? 1000 : 1);
      if (amount >= 1) flags.push(`Revenue signal: ${rev}`);
    }
  }

  // Active hiring
  const hiringCount = parseInt(research.growth_signals?.hiring_count) || 0;
  if (hiringCount >= 5 || research.growth_signals?.hiring_activity === "active") {
    flags.push(`Actively hiring: ${hiringCount > 0 ? hiringCount + " open roles" : "active hiring detected"}`);
  }

  // Competitor displacement
  if (research.opportunity_signals?.competitor_displacement) {
    flags.push(`Competitor displacement: currently using ${research.opportunity_signals.current_competitor || "a competitor"}`);
  }

  // High-growth industry
  const industry = (research.company_overview?.industry || lead.vertical || "").toLowerCase();
  const isHighGrowth = HIGH_GROWTH_INDUSTRIES.some(ig => industry.includes(ig));
  if (isHighGrowth) flags.push(`High-growth industry: ${research.company_overview?.industry}`);

  // Enterprise/Fortune 1000 signal
  if (research.opportunity_signals?.strategic_value === "high") {
    flags.push(`High strategic value: ${research.opportunity_signals.strategic_reason}`);
  }

  // Founder-flagged
  if (research.gut_wrenching_opportunity) {
    flags.push(research.gut_wrenching_reason || "Claude flagged as exceptional opportunity");
  }

  return flags;
}

// ── Determine routing from score ─────────────────────────────────────────
function determineRouting(score, gutWrenchingFlags, research) {
  const isGutWrenching = gutWrenchingFlags.length > 0;
  const tier = research.recommended_tier || "Starter";

  if (isGutWrenching || score >= 90) {
    return {
      priority:    1,
      action:      "call_1hr",
      label:       "Priority 1 — Call within 1 hour",
      autoApprove: true,
      reason:      isGutWrenching
        ? `Gut-wrenching opportunity: ${gutWrenchingFlags[0]}`
        : "Score ≥ 90 — top-tier prospect",
    };
  }
  if (score >= 75) {
    return {
      priority:    2,
      action:      "call_24hr",
      label:       "Priority 2 — Call within 24 hours",
      autoApprove: true,
      reason:      `Score ${score}/100 — strong prospect`,
    };
  }
  if (score >= 50) {
    return {
      priority:    3,
      action:      "founder_review",
      label:       "Priority 3 — Founder 1-tap review",
      autoApprove: false,
      reason:      `Score ${score}/100 — borderline, needs founder judgment`,
    };
  }
  return {
    priority:    4,
    action:      "auto_reject",
    label:       "Auto-reject — below threshold",
    autoApprove: false,
    reason:      `Score ${score}/100 — below minimum threshold`,
  };
}

// ── Format Slack dossier message ──────────────────────────────────────────
function buildSlackDossier(leadId, lead, dossier) {
  const { score, routing, gutWrenchingFlags, research } = dossier;
  const isGutWrenching = gutWrenchingFlags.length > 0;
  const priorityEmoji  = routing.priority === 1 ? "🔥" : routing.priority === 2 ? "⚡" : routing.priority === 3 ? "👀" : "❌";
  const scoreColor     = score >= 75 ? "#00c9a7" : score >= 50 ? "#f59e0b" : "#ef4444";

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `${priorityEmoji} NEW LEAD INTELLIGENCE — ${lead.company}` },
    },
  ];

  if (isGutWrenching) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*⚠️ GUT-WRENCHING OPPORTUNITY*\n${gutWrenchingFlags.map(f => `• ${f}`).join("\n")}` },
    });
  }

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Score:*\n${score}/100` },
      { type: "mrkdwn", text: `*Routing:*\n${routing.label}` },
      { type: "mrkdwn", text: `*Tier:*\n${research.recommended_tier}` },
      { type: "mrkdwn", text: `*Confidence:*\n${research.confidence}` },
    ],
  });

  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*Company:*\n${research.company_overview?.description || lead.company}` },
      { type: "mrkdwn", text: `*Size:*\n${research.company_overview?.estimated_employees || "unknown"} employees` },
      { type: "mrkdwn", text: `*Revenue:*\n${research.company_overview?.estimated_revenue || "unknown"}` },
      { type: "mrkdwn", text: `*Growth:*\n${research.growth_signals?.growth_stage || "unknown"}` },
    ],
  });

  if (research.opportunity_signals?.pain_indicators?.length > 0) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Pain Indicators:*\n${research.opportunity_signals.pain_indicators.slice(0, 3).map(p => `• ${p}`).join("\n")}`,
      },
    });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*Brief:* ${research.one_line_brief || "No brief available"}` },
  });

  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `Lead ID: ${leadId} · Contact: ${lead.name} <${lead.email}> · ${nowIso()}` }],
  });

  return {
    attachments: [{
      color:  scoreColor,
      blocks,
    }],
  };
}

// ── MAIN EXPORT: runLeadResearch ──────────────────────────────────────────
// Called after a lead arrives. Runs Claude research, scores, routes.
// Returns dossier stored in KV under tenant:warroom:lead:{leadId}:research:dossier
export async function runLeadResearch(leadId, lead, env) {
  const startMs = Date.now();

  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, error: "ANTHROPIC_API_KEY not configured", leadId };
  }

  // ── 1. Call Claude for company research ──────────────────────────────
  let research;
  try {
    const prompt = buildResearchPrompt(lead);
    const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method:  "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-haiku-4-20250514",
        max_tokens: 2048,
        messages:   [{ role: "user", content: prompt }],
      }),
    });

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text();
      return { ok: false, error: `Anthropic API error: ${anthropicRes.status} — ${errText}`, leadId };
    }

    const anthropicData = await anthropicRes.json();
    const rawContent    = anthropicData?.content?.[0]?.text || "";
    const parsed        = parseResearchResponse(rawContent);

    if (!parsed.ok) {
      return { ok: false, error: `Parse error: ${parsed.error}`, leadId, rawContent };
    }
    research = parsed.data;
  } catch (e) {
    return { ok: false, error: `Research error: ${e.message}`, leadId };
  }

  // ── 2. Compute aggregate score ───────────────────────────────────────
  const score           = computeAggregateScore(research.score_dimensions);
  const gutWrenchingFlags = detectGutWrenchingFlags(research, lead);
  const routing         = determineRouting(score, gutWrenchingFlags, research);
  const elapsedMs       = Date.now() - startMs;

  // ── 3. Build full dossier ────────────────────────────────────────────
  const dossier = {
    leadId,
    score,
    routing,
    gutWrenchingFlags,
    research,
    lead: {
      name:     lead.name,
      email:    lead.email,
      company:  lead.company,
      vertical: lead.vertical,
      volume:   lead.volume,
      ccaas:    lead.ccaas,
      source:   lead.source,
    },
    researchedAt: nowIso(),
    elapsedMs,
    version:      "1.0",
  };

  // ── 4. Store in KV ───────────────────────────────────────────────────
  await kvPut(
    env.RELAY_STATE,
    `${researchKey(leadId, "dossier")}`,
    dossier,
    60 * 60 * 24 * 90 // 90 days
  );

  // Also store score separately for quick lookup
  await kvPut(
    env.RELAY_STATE,
    `${researchKey(leadId, "score")}`,
    { score, routing: routing.action, priority: routing.priority, gutWrenching: gutWrenchingFlags.length > 0 },
    60 * 60 * 24 * 90
  );

  // ── 5. Slack notification ─────────────────────────────────────────────
  const slackWebhook = routing.priority <= 2
    ? env.SLACK_WEBHOOK_ALERTS    // High priority → #pci-sev
    : env.SLACK_WEBHOOK_APPROVALS; // Review needed → #pci-approvals

  if (slackWebhook) {
    const slackPayload = buildSlackDossier(leadId, lead, dossier);
    await fetch(slackWebhook, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(slackPayload),
    }).catch(() => {}); // non-fatal
  }

  // ── 6. If founder review needed — create approval request ────────────
  if (routing.action === "founder_review") {
    const approvalId  = `appr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const approveUrl  = `https://relay.primecoreintelligence.com/relay/approvals/${approvalId}/approve?token=${env.RELAY_AUTH_TOKEN}`;
    const denyUrl     = `https://relay.primecoreintelligence.com/relay/approvals/${approvalId}/deny?token=${env.RELAY_AUTH_TOKEN}`;

    const approval = {
      id:         approvalId,
      action:     `Pursue lead: ${lead.company} — Score ${score}/100`,
      risk:       "medium",
      context:    `${research.one_line_brief || ""} | Tier: ${research.recommended_tier} | ${routing.reason}`,
      factory:    "Lead Engine",
      status:     "pending",
      createdAt:  nowIso(),
      expiresAt:  new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      decidedAt:  null,
      decision:   null,
      approveUrl,
      denyUrl,
      leadId,
    };

    if (env.RELAY_STATE) {
      await env.RELAY_STATE.put(
        `tenant:warroom:approval:${approvalId}`,
        JSON.stringify(approval),
        { expirationTtl: 60 * 60 * 24 * 2 }
      );
    }
  }

  return { ok: true, leadId, score, routing, gutWrenchingFlags, elapsedMs };
}

// ── EXPORT: getLeadDossier ────────────────────────────────────────────────
// Retrieves a stored dossier by leadId
export async function getLeadDossier(leadId, env) {
  return await kvGet(env.RELAY_STATE, researchKey(leadId, "dossier"));
}

// ── EXPORT: listLeadDossiers ──────────────────────────────────────────────
// Lists all researched leads — for Command Station lead panel
export async function listLeadDossiers(env, limit = 50) {
  if (!env.RELAY_STATE) return [];
  try {
    const keys = await env.RELAY_STATE.list({ prefix: "tenant:warroom:lead:", limit: limit * 3 });
    const dossiers = [];
    for (const key of (keys.keys || [])) {
      if (!key.name.endsWith(":research:dossier")) continue;
      try {
        const raw = await env.RELAY_STATE.get(key.name);
        if (raw) dossiers.push(JSON.parse(raw));
      } catch { /* skip */ }
    }
    dossiers.sort((a, b) => new Date(b.researchedAt) - new Date(a.researchedAt));
    return dossiers.slice(0, limit);
  } catch { return []; }
}
