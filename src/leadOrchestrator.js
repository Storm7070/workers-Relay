/**
 * PrimeCore Intelligence — Sales Swarm Lead Orchestrator v1.0
 * ─────────────────────────────────────────────────────────────
 * Implements the 5-agent Sales Swarm from the Notion architecture doc.
 * Orchestrates: Qualifier → Pain Mapper → ROI Builder → Closer → Objection Handler
 *
 * State machine — lead progresses through these states in KV:
 *   new          → Qualifier runs (within 2h of arrival)
 *   qualified    → Pain Mapper runs (if score ≥6)
 *   pain_mapped  → ROI Builder runs
 *   roi_built    → Closer runs (Day 1/3/7 email sequence)
 *   active       → Objection Handler watches for reply signals
 *   disqualified → Score <6, logged, no further action (founder can override)
 *   escalated    → Requires founder review before proceeding
 *
 * Designed to run from:
 *   1. POST /relay/leads/orchestrate    — called by pilot form handler after Notion write
 *   2. GET  /relay/leads/sweep          — cron: sweeps all leads for stale states
 *
 * KV key pattern: tenant:warroom:lead:{leadId}:state
 *                 tenant:warroom:lead:{leadId}:profile
 *                 tenant:warroom:lead:{leadId}:roi
 *                 tenant:warroom:lead:{leadId}:emails
 *
 * GUARDRAILS (non-negotiable):
 *   - Never claims to be human
 *   - Never commits to capabilities not yet built
 *   - Never approves custom pricing >$12,000/mo (escalates to founder)
 *   - Never signs contracts (escalates to founder)
 *   - Sends after 30-minute delay to avoid feeling automated
 *   - All email drafts stored in KV for founder review before send
 */

"use strict";

// ── Lead state transitions ────────────────────────────────────────────────
const LEAD_STATES = {
  NEW:           "new",
  QUALIFIED:     "qualified",
  DISQUALIFIED:  "disqualified",
  PAIN_MAPPED:   "pain_mapped",
  ROI_BUILT:     "roi_built",
  ACTIVE:        "active",          // Closer sequence running
  OBJECTION:     "objection",       // Objection detected, handling
  ESCALATED:     "escalated",       // Needs founder review
  CLOSED_WON:    "closed_won",
  CLOSED_LOST:   "closed_lost",
};

// ── KV key helpers ────────────────────────────────────────────────────────
function leadKey(leadId, field) {
  return `tenant:warroom:lead:${leadId}:${field}`;
}

async function kvGet(kv, key) {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function kvPut(kv, key, value, ttl = 60 * 60 * 24 * 90) {
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
    return true;
  } catch { return false; }
}

function nowIso() { return new Date().toISOString(); }
function nowMs()  { return Date.now(); }

// ── ROI benchmarks (canonical — matches war room and marketing exactly) ───
// CANONICAL — must match marketing site ROI calculator exactly (public/index.html line 5252)
const ROI_BENCHMARKS = {
  logistics:  { fcr: 0.89, aht: 87,  costPerCall: 4.50 },  // Logistics / 3PL
  healthcare: { fcr: 0.82, aht: 120, costPerCall: 9.20 },  // Healthcare
  financial:  { fcr: 0.79, aht: 105, costPerCall: 8.80 },  // Financial Services
  retail:     { fcr: 0.87, aht: 72,  costPerCall: 4.00 },  // Retail / E-commerce
  fleet:      { fcr: 0.85, aht: 95,  costPerCall: 4.80 },  // Fleet / Dispatch
  bpo:        { fcr: 0.83, aht: 102, costPerCall: 4.20 },  // BPO Operations
  default:    { fcr: 0.84, aht: 95,  costPerCall: 4.50 },  // General — LATAM
};

const PLANS = [
  { name: "Starter",      monthly: 2400, pilotPrice: 1200, maxCalls: 5000   },
  { name: "Professional", monthly: 5800, pilotPrice: 2900, maxCalls: 20000  },
  { name: "Enterprise",   monthly: 7997, pilotPrice: 3999, maxCalls: 999999 },
];

// Volume string → numeric midpoint
function volumeToNumber(vol) {
  const map = {
    "under-5k":  2500,
    "5k-20k":    12500,
    "20k-100k":  60000,
    "100k+":     150000,
  };
  return map[vol] || 5000;
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT 1 — QUALIFIER
// Scores lead 1–10 using MEDDIC-adapted framework.
// Score ≥6 → proceeds. Score <6 → disqualified with reason logged.
// ════════════════════════════════════════════════════════════════════════════
function runQualifier(lead) {
  let score = 0;
  const signals = [];

  // M — Metrics: quantifiable volume
  const vol = volumeToNumber(lead.volume);
  if (vol >= 20000)      { score += 2; signals.push("High volume (20k+)"); }
  else if (vol >= 5000)  { score += 1; signals.push("Mid volume (5k–20k)"); }
  else                   { signals.push("Low volume (<5k) — starter only"); }

  // E — Economic buyer signal (title inference from notes/role)
  const notes = (lead.notes || "").toLowerCase();
  const buyerSignals = ["director", "vp", "coo", "ceo", "head of", "manager", "operations", "founder"];
  if (buyerSignals.some(s => notes.includes(s))) {
    score += 2;
    signals.push("Economic buyer signal detected");
  } else {
    score += 1; // unknown but not ruled out
    signals.push("Buyer role unclear — need discovery");
  }

  // D — Decision criteria: has CCaaS already
  if (lead.ccaas && lead.ccaas !== "other" && lead.ccaas !== "") {
    score += 2;
    signals.push(`CCaaS confirmed: ${lead.ccaas}`);
  } else {
    score += 0;
    signals.push("No CCaaS specified — requires discovery");
  }

  // I — Pain: vertical specificity
  const painVerticals = ["healthcare", "financial", "logistics", "retail", "fleet", "bpo", "insurance"];
  if (painVerticals.includes(lead.vertical)) {
    score += 2;
    signals.push(`Known vertical: ${lead.vertical}`);
  } else if (lead.vertical) {
    score += 1;
    signals.push(`Vertical specified: ${lead.vertical}`);
  } else {
    signals.push("No vertical — generic qualification only");
  }

  // C — Champion: direct pilot request is a positive champion signal
  if (lead.source === "pilot_form") {
    score += 1;
    signals.push("Self-initiated pilot request — strong intent");
  }

  // Escalate immediately: very large volume always worth founder review
  const escalate = vol >= 100000;
  const state = score >= 6 ? LEAD_STATES.QUALIFIED : LEAD_STATES.DISQUALIFIED;

  return {
    score,
    state: escalate ? LEAD_STATES.ESCALATED : state,
    signals,
    escalateReason: escalate ? "Volume ≥100k — founder review required before proceeding" : null,
    qualifiedAt: nowIso(),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT 2 — PAIN MAPPER
// Maps lead's vertical and CCaaS to specific PrimeCore capabilities.
// Generates a 3–5 sentence pain analysis — no generic language.
// ════════════════════════════════════════════════════════════════════════════
function runPainMapper(lead) {
  const vertical  = lead.vertical || "default";
  const ccaas     = lead.ccaas    || "unknown";
  const vol       = volumeToNumber(lead.volume);
  const bench     = ROI_BENCHMARKS[vertical] || ROI_BENCHMARKS.default;

  // What PrimeCore solves in this vertical (Mode 1 — Tier 1 call deflection)
  const verticalPain = {
    healthcare: {
      primaryPain:    "Tier 1 call volume (appointment confirmations, eligibility queries, rx status) consuming agent capacity needed for complex clinical navigation",
      pcSolves:       "Mode 1 routes intent-classified Tier 1 calls to AI resolution before any agent touch — FCR 82%, cost $0.04/call",
      outOfScope:     "Clinical triage decisions, prior auth judgment calls, complex claims disputes",
    },
    logistics: {
      primaryPain:    "High-frequency status queries (shipment tracking, ETA, POD confirmations) creating repetitive agent load at peak dispatch windows",
      pcSolves:       "Mode 1 resolves tracking and ETA intents in <90 seconds without agent — FCR 89%, AHT 87s",
      outOfScope:     "Carrier relationship management, claims resolution, freight negotiation",
    },
    financial: {
      primaryPain:    "Routine account status, balance inquiry, and fraud flag queries spiking call volume while agents are allocated to compliance-sensitive calls",
      pcSolves:       "Mode 1 handles non-sensitive intent categories autonomously — FCR 79%, cost $0.04/call vs $8.80 current",
      outOfScope:     "Fraud investigation, regulatory compliance calls, account opening",
    },
    retail: {
      primaryPain:    "Order status, returns, and catalog queries overloading agents during peak seasons, driving AHT above benchmarks",
      pcSolves:       "Mode 1 deflects order status and standard return intents — FCR 87%, AHT 72s, cost $0.04/call",
      outOfScope:     "Escalated dispute resolution, custom product requests",
    },
    fleet: {
      primaryPain:    "Driver check-in, load status, and route confirmation calls creating dispatch center bottlenecks during peak windows",
      pcSolves:       "Mode 1 handles standard driver status and load confirmation intents — FCR 85%, AHT 95s",
      outOfScope:     "Accident response, hazmat coordination, regulatory filings",
    },
    bpo: {
      primaryPain:    "Margin compression from Tier 1 volume that delivers no added value while consuming agent time billable to clients at fixed SLAs",
      pcSolves:       "Mode 1 converts Tier 1 calls from agent cost ($4.20/call) to AI cost ($0.04/call) — improving client margins and SLA compliance",
      outOfScope:     "Client-specific QA scoring, custom agent coaching programs",
    },
  };

  const pain = verticalPain[vertical] || {
    primaryPain: "Tier 1 call volume consuming agent capacity that could be redirected to high-complexity calls",
    pcSolves:    "Mode 1 routes and resolves intent-classified Tier 1 calls autonomously before any agent touch",
    outOfScope:  "Complex escalations, regulatory matters, contract decisions",
  };

  const tierOnePercent = 0.70; // default 70% Tier 1 unless prospect specifies
  const aiHandled      = Math.round(vol * tierOnePercent * bench.fcr);

  const analysis = {
    primaryPain:    pain.primaryPain,
    primecoreFit:   pain.pcSolves,
    outOfScope:     pain.outOfScope,
    callsDeflected: aiHandled,
    verticalBench:  bench,
    ccaas:          ccaas,
    mappedAt:       nowIso(),
    honestNote:     pain.outOfScope
      ? `Honesty flag: ${pain.outOfScope} are out of scope for Mode 1. If prospect's primary pain is in these areas, flag for founder review.`
      : null,
  };

  return analysis;
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT 3 — ROI BUILDER
// Computes personalized ROI model. Output used directly in Closer emails.
// Formula is canonical — matches marketing ROI calculator exactly.
// ════════════════════════════════════════════════════════════════════════════
function runROIBuilder(lead, painAnalysis) {
  const vertical       = lead.vertical || "default";
  const bench          = ROI_BENCHMARKS[vertical] || ROI_BENCHMARKS.default;
  const vol            = volumeToNumber(lead.volume);
  const tierOnePercent = 0.70;
  const aiCallsHandled = Math.round(vol * tierOnePercent * bench.fcr);
  const remainingCalls = vol - aiCallsHandled;

  const currentMonthlyCost  = vol * bench.costPerCall;
  const aiCost              = aiCallsHandled * 0.04;
  const agentCostRemaining  = remainingCalls * bench.costPerCall;
  const newMonthlyCost      = aiCost + agentCostRemaining;

  // Select plan based on volume
  const plan = vol <= 5000
    ? PLANS[0]
    : vol <= 20000
    ? PLANS[1]
    : PLANS[2];

  const grossSavings  = currentMonthlyCost - newMonthlyCost;
  const netMonthly    = grossSavings - plan.monthly;
  const pilotNetMonth1 = grossSavings - plan.pilotPrice;

  // Break-even: how many months until cumulative savings > plan cost
  const breakEvenMonth = netMonthly > 0
    ? Math.ceil(plan.monthly / grossSavings)
    : null;

  return {
    plan:               plan.name,
    planCost:           plan.monthly,
    pilotPrice:         plan.pilotPrice,
    volume:             vol,
    currentMonthlyCost: Math.round(currentMonthlyCost),
    aiCost:             Math.round(aiCost),
    newMonthlyCost:     Math.round(newMonthlyCost),
    grossSavings:       Math.round(grossSavings),
    netMonthly:         Math.round(netMonthly),
    pilotNetMonth1:     Math.round(pilotNetMonth1),
    aiCallsHandled,
    remainingCalls,
    breakEvenMonth,
    bench,
    vertical,
    builtAt:            nowIso(),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT 4 — CLOSER
// Builds Day 1/3/7 email sequence. Stores drafts in KV for review.
// All emails use ROI numbers from Agent 3.
// Sends via existing Resend integration in workers-Relay.
// ════════════════════════════════════════════════════════════════════════════
function buildCloserSequence(lead, roi, painAnalysis) {
  const lang = lead.lang || "en";
  const fmt  = (n) => `$${Math.abs(Math.round(n)).toLocaleString()}`;

  const templates = {
    en: {
      day1: {
        subject: `${lead.company} — your PrimeCore pilot request`,
        body: `${lead.name},

Your pilot request came through. Before I send you the formal setup details, a few things about what shadow mode actually means for ${lead.company}.

${painAnalysis.primaryPain}. In your vertical, ${Math.round(painAnalysis.verticalBench.fcr * 100)}% first-call resolution is the baseline. The AI runs alongside your team — no changes to ${lead.ccaas || "your CCaaS"}, no agent disruption — for 30 days while you watch the data.

Based on ${vol_label(lead.volume)} at $${roi.bench.costPerCall.toFixed(2)}/call, the rough math puts net savings at ${fmt(roi.netMonthly)}/month after the platform cost. Month 1 during pilot: ${fmt(roi.pilotNetMonth1)} net at 50% price.

One question: is ${lead.ccaas || "your CCaaS"} admin-accessible to your IT team, or does it go through a vendor support ticket? That determines how long setup takes.

Lester
Founder — PrimeCore Intelligence`,
      },
      day3: {
        subject: `Re: ${lead.company} pilot — quick follow-up`,
        body: `${lead.name},

Following up on the pilot request. Shadow mode setup for ${lead.ccaas || "your platform"} is one webhook URL added to the admin panel — typically 15 minutes for IT.

If the timing isn't right this week, that's fine. The numbers don't change: ${Math.round(roi.aiCallsHandled).toLocaleString()} calls/month handled at $0.04 instead of $${roi.bench.costPerCall.toFixed(2)}.

What's the best way to get 20 minutes with whoever handles your CCaaS integrations?

Lester`,
      },
      day7: {
        subject: `${lead.company} — last follow-up before I close this out`,
        body: `${lead.name},

Last touch on the pilot — I'll close this out after today and you can reopen it whenever the timing works.

If the numbers were off, or you found a better solution, I'd genuinely like to know. What happened?

If it's a timing issue: the pilot structure doesn't change — 30 days, shadow mode, cancel before Month 2 if the data doesn't convince you. The only thing that changes is when we start.

Lester`,
      },
    },
    es: {
      day1: {
        subject: `${lead.company} — su solicitud de piloto en PrimeCore`,
        body: `${lead.name},

Su solicitud de piloto llegó. Antes de enviarle los detalles formales de configuración, algunas cosas sobre lo que significa el modo sombra para ${lead.company}.

${painAnalysis.primaryPain}. En su vertical, ${Math.round(painAnalysis.verticalBench.fcr * 100)}% de resolución en primera llamada es la línea base. La IA corre junto a su equipo — sin cambios en ${lead.ccaas || "su CCaaS"}, sin interrupciones para los agentes — durante 30 días mientras usted observa los datos.

Con un volumen de ${vol_label_es(lead.volume)} a $${roi.bench.costPerCall.toFixed(2)}/llamada, el ahorro neto estimado es de ${fmt(roi.netMonthly)}/mes después del costo de la plataforma. En el Mes 1 del piloto: ${fmt(roi.pilotNetMonth1)} neto al precio reducido.

Una pregunta: ¿el administrador de ${lead.ccaas || "su CCaaS"} es accesible para su equipo de TI, o requiere un ticket de soporte del proveedor?

Lester
Fundador — PrimeCore Intelligence`,
      },
      day3: {
        subject: `Re: Piloto ${lead.company} — breve seguimiento`,
        body: `${lead.name},

Haciendo seguimiento a la solicitud del piloto. La configuración del modo sombra para ${lead.ccaas || "su plataforma"} es una URL de webhook en el panel de administración — típicamente 15 minutos para TI.

Si el momento no es el adecuado esta semana, no hay problema. Los números no cambian: ${Math.round(roi.aiCallsHandled).toLocaleString()} llamadas/mes manejadas a $0.04 en lugar de $${roi.bench.costPerCall.toFixed(2)}.

¿Cuál es la mejor forma de coordinar 20 minutos con quien maneja las integraciones de su CCaaS?

Lester`,
      },
      day7: {
        subject: `${lead.company} — último seguimiento`,
        body: `${lead.name},

Último contacto sobre el piloto — cerraré este expediente después de hoy y puede reabrirlo cuando el momento sea el adecuado.

Si los números no eran correctos o encontró una mejor solución, me gustaría saberlo genuinamente. ¿Qué pasó?

Si es una cuestión de tiempo: la estructura del piloto no cambia — 30 días, modo sombra, cancelación antes del Mes 2 si los datos no lo convencen. Lo único que cambia es cuándo empezamos.

Lester`,
      },
    },
    pt: {
      day1: {
        subject: `${lead.company} — sua solicitação de piloto no PrimeCore`,
        body: `${lead.name},

Sua solicitação de piloto chegou. Antes de enviar os detalhes formais de configuração, algumas considerações sobre o que o modo sombra significa para a ${lead.company}.

${painAnalysis.primaryPain}. No seu vertical, ${Math.round(painAnalysis.verticalBench.fcr * 100)}% de resolução na primeira chamada é a linha de base. A IA opera junto à sua equipe — sem alterações no ${lead.ccaas || "seu CCaaS"}, sem interrupções para os agentes — durante 30 dias enquanto você acompanha os dados.

Com um volume de ${vol_label_pt(lead.volume)} a $${roi.bench.costPerCall.toFixed(2)}/chamada, a economia líquida estimada é de ${fmt(roi.netMonthly)}/mês após o custo da plataforma. No Mês 1 do piloto: ${fmt(roi.pilotNetMonth1)} líquido com preço reduzido.

Uma pergunta: o administrador do ${lead.ccaas || "seu CCaaS"} é acessível à sua equipe de TI, ou precisa de um chamado de suporte ao fornecedor?

Lester
Fundador — PrimeCore Intelligence`,
      },
      day3: {
        subject: `Re: Piloto ${lead.company} — acompanhamento rápido`,
        body: `${lead.name},

Acompanhando a solicitação do piloto. A configuração do modo sombra para ${lead.ccaas || "sua plataforma"} é uma URL de webhook no painel de administração — normalmente 15 minutos para a TI.

Se o momento não for ideal esta semana, sem problema. Os números não mudam: ${Math.round(roi.aiCallsHandled).toLocaleString()} chamadas/mês processadas a $0.04 em vez de $${roi.bench.costPerCall.toFixed(2)}.

Qual é a melhor forma de agendar 20 minutos com quem cuida das integrações do seu CCaaS?

Lester`,
      },
      day7: {
        subject: `${lead.company} — último acompanhamento`,
        body: `${lead.name},

Último contato sobre o piloto — vou encerrar este processo após hoje e você pode reabri-lo quando o momento for adequado.

Se os números não estavam certos ou você encontrou uma solução melhor, gostaria genuinamente de saber. O que aconteceu?

Se é uma questão de tempo: a estrutura do piloto não muda — 30 dias, modo sombra, cancelamento antes do Mês 2 se os dados não te convencerem. A única coisa que muda é quando começamos.

Lester`,
      },
    },
  };

  const t = templates[lang] || templates.en;
  const sendSchedule = [
    { day: 1,  delayMs: 30 * 60 * 1000,         email: t.day1 }, // 30 min delay
    { day: 3,  delayMs: 3  * 24 * 60 * 60 * 1000, email: t.day3 }, // Day 3
    { day: 7,  delayMs: 7  * 24 * 60 * 60 * 1000, email: t.day7 }, // Day 7
  ];

  return {
    sequence:  sendSchedule,
    builtAt:   nowIso(),
    from:      "lester@primecoreintelligence.com",
    replyTo:   "lester@primecoreintelligence.com",
  };
}

// Volume label helpers
function vol_label(vol)    {
  return { "under-5k": "under 5,000 calls/month", "5k-20k": "5,000–20,000 calls/month", "20k-100k": "20,000–100,000 calls/month", "100k+": "over 100,000 calls/month" }[vol] || vol;
}
function vol_label_es(vol) {
  return { "under-5k": "menos de 5,000 llamadas/mes", "5k-20k": "5,000–20,000 llamadas/mes", "20k-100k": "20,000–100,000 llamadas/mes", "100k+": "más de 100,000 llamadas/mes" }[vol] || vol;
}
function vol_label_pt(vol) {
  return { "under-5k": "menos de 5.000 chamadas/mês", "5k-20k": "5.000–20.000 chamadas/mês", "20k-100k": "20.000–100.000 chamadas/mês", "100k+": "mais de 100.000 chamadas/mês" }[vol] || vol;
}

// ════════════════════════════════════════════════════════════════════════════
// AGENT 5 — OBJECTION HANDLER
// Classifies incoming reply signals and retrieves response from Objection Bank.
// Called when relay worker detects objection keywords in a prospect reply.
// ════════════════════════════════════════════════════════════════════════════
function runObjectionHandler(replyText, lead, roi) {
  const lower = replyText.toLowerCase();
  const lang  = lead.lang || "en";

  // Objection classification
  let category = null;
  if (/too expensive|very expensive|caro|muy caro|alto|precio|cost|price|afford/.test(lower))            category = "price";
  else if (/tried ai|tested ai|failed|didn't work|probamos|falló|não funcionou/.test(lower))              category = "ai_failed_before";
  else if (/our agents|our team|employees|staff|jobs|agentes|funcionarios/.test(lower))                   category = "agent_resistance";
  else if (/not ready|not the right time|bad time|no estamos|not now|next year/.test(lower))              category = "timing";
  else if (/it team|it department|security|compliance|gdpr|hipaa|sox|ti equipo/.test(lower))              category = "technical_it";
  else if (/legal|contract|terms|liability|compliance officer|juridico/.test(lower))                      category = "legal"; // → ESCALATE
  else if (/replace|laid off|despedir|demitir|automation replace/.test(lower))                           category = "job_replacement";
  else if (/phone call|llamada|ligação|speak to someone|hablar con/.test(lower))                          category = "wants_call"; // → ESCALATE

  // Escalate legal and call requests to founder
  if (category === "legal" || category === "wants_call") {
    return {
      action: "escalate",
      category,
      reason:    category === "legal"
        ? "Legal/compliance question — founder + legal review required"
        : "Prospect requests a call — founder takes it directly",
      draftReply: null,
    };
  }

  // Objection Bank responses
  const bank = {
    en: {
      price: `The ROI math doesn't change based on the price — it changes based on your volume. At ${lead.volume}, PrimeCore handles roughly ${Math.round(roi?.aiCallsHandled || 0).toLocaleString()} calls/month at $0.04 each. The question isn't whether the platform fee is expensive. It's whether saving ${roi?.netMonthly > 0 ? `$${Math.round(roi.netMonthly).toLocaleString()}` : "significant cost"}/month net is worth it. What's the number that would make this an obvious yes?`,
      ai_failed_before: `That's the most important thing I hear. Most AI deployments fail for one of three reasons: wrong intent classification, no human fallback, or it was deployed live before being validated. Shadow mode exists for exactly this — 30 days running alongside your agents with zero calls touched, while you watch the data and decide. No commitment until the data convinces you.`,
      agent_resistance: `Shadow mode means agents don't interact with it at all during the pilot. The AI runs in parallel, builds the prediction model, and never touches a live call. When the data is ready, you decide whether and how to deploy. The question for your team isn't "will AI replace us" — it's "which calls do you want to stop taking."`,
      timing: `Understood. The structure doesn't change when you're ready — same 30-day pilot, same shadow mode, same cancel-before-Month-2 guarantee. The only thing that changes is the date. What does "ready" look like for you? Is there a specific event or decision you're waiting on?`,
      technical_it: `Shadow mode only requires one webhook URL added to your CCaaS admin panel. No API keys on your side, no agent desktop changes, no security review of your core systems. I can send the technical documentation directly to your IT contact — one page, platform-specific. What's their email?`,
      job_replacement: `Mode 1 handles Tier 1 calls — the ones your agents least want to take. Appointment confirmations, tracking queries, basic eligibility checks. When those stop going to agents, agents get more time for calls that actually require judgment. The headcount question is a business decision your leadership makes — PrimeCore just changes the cost of Tier 1 volume.`,
    },
    es: {
      price: `El cálculo del ROI no cambia según el precio — cambia según su volumen. Con ${lead.volume}, PrimeCore maneja aproximadamente ${Math.round(roi?.aiCallsHandled || 0).toLocaleString()} llamadas/mes a $0.04 cada una. La pregunta no es si el costo de la plataforma es caro. Es si ahorrar ${roi?.netMonthly > 0 ? `$${Math.round(roi.netMonthly).toLocaleString()}` : "costos significativos"}/mes neto vale la pena. ¿Cuál es el número que haría que esto sea una decisión obvia?`,
      ai_failed_before: `Eso es lo más importante que escucho. La mayoría de las implementaciones de IA fallan por una de tres razones: clasificación de intenciones incorrecta, sin respaldo humano, o se desplegó en vivo sin validación previa. El modo sombra existe exactamente para esto — 30 días corriendo junto a sus agentes sin tocar ninguna llamada, mientras usted observa los datos y decide.`,
      agent_resistance: `El modo sombra significa que los agentes no interactúan con él en absoluto durante el piloto. La IA corre en paralelo, construye el modelo predictivo, y nunca toca una llamada en vivo. La pregunta para su equipo no es "¿nos reemplazará la IA?" — sino "¿qué llamadas quieren dejar de atender?"`,
      timing: `Entendido. La estructura no cambia cuando esté listo — mismo piloto de 30 días, mismo modo sombra, misma garantía de cancelación antes del Mes 2. ¿Cómo se ve "estar listo" para usted?`,
      technical_it: `El modo sombra solo requiere una URL de webhook en el panel de administración de su CCaaS. Sin claves API de su lado, sin cambios en el escritorio del agente. Puedo enviar la documentación técnica directamente a su contacto de TI — una página, específica para su plataforma. ¿Cuál es su correo?`,
      job_replacement: `El Modo 1 maneja llamadas de Nivel 1 — las que sus agentes menos quieren atender. Confirmaciones de citas, consultas de seguimiento, verificaciones básicas de elegibilidad. Cuando esas dejan de ir a los agentes, los agentes tienen más tiempo para llamadas que realmente requieren juicio.`,
    },
    pt: {
      price: `O cálculo do ROI não muda com base no preço — muda com base no seu volume. Com ${lead.volume}, o PrimeCore processa aproximadamente ${Math.round(roi?.aiCallsHandled || 0).toLocaleString()} chamadas/mês a $0,04 cada. A pergunta não é se o custo da plataforma é caro. É se economizar ${roi?.netMonthly > 0 ? `$${Math.round(roi.netMonthly).toLocaleString()}` : "custos significativos"}/mês líquido vale a pena.`,
      ai_failed_before: `Isso é o mais importante que ouço. A maioria das implementações de IA falha por um de três motivos: classificação incorreta de intenções, sem fallback humano, ou foi implementada em produção antes de ser validada. O modo sombra existe exatamente para isso — 30 dias rodando junto com sua equipe sem tocar nenhuma chamada.`,
      agent_resistance: `O modo sombra significa que os agentes não interagem com ele durante o piloto. A IA roda em paralelo, constrói o modelo preditivo, e nunca toca uma chamada ao vivo. A pergunta para sua equipe não é "a IA vai nos substituir?" — mas "quais chamadas vocês querem parar de atender?"`,
      timing: `Entendido. A estrutura não muda quando estiver pronto — mesmo piloto de 30 dias, mesmo modo sombra. Como é "estar pronto" para você?`,
      technical_it: `O modo sombra só requer uma URL de webhook no painel de administração do seu CCaaS. Posso enviar a documentação técnica diretamente para o seu contato de TI — uma página, específica para a sua plataforma. Qual é o e-mail dele?`,
      job_replacement: `O Modo 1 lida com chamadas de Nível 1 — as que seus agentes menos querem atender. Quando essas param de ir para os agentes, eles têm mais tempo para chamadas que realmente exigem julgamento.`,
    },
  };

  const b = bank[lang] || bank.en;
  const draftReply = b[category] || null;

  return {
    action:     draftReply ? "draft_ready" : "unknown_objection",
    category,
    draftReply,
    sendDelay:  30 * 60 * 1000, // 30-minute send delay — avoids feeling automated
    builtAt:    nowIso(),
  };
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR — runLeadOrchestrator(leadId, env)
// Entry point. Reads current lead state from KV, runs the right agent,
// writes new state back. Idempotent — safe to call multiple times.
// ════════════════════════════════════════════════════════════════════════════
export async function runLeadOrchestrator(leadId, lead, env) {
  const kv = env.KEYWARDEN_STATE || env.RELAY_STATE;
  if (!kv) return { error: "No KV binding available" };

  // Load current state
  let currentState = await kvGet(kv, leadKey(leadId, "state"));
  if (!currentState) {
    currentState = { state: LEAD_STATES.NEW, leadId, createdAt: nowIso() };
  }

  const result = { leadId, prevState: currentState.state, newState: null, agentRan: null };

  // ── State machine ─────────────────────────────────────────────────────────
  if (currentState.state === LEAD_STATES.NEW) {
    // Agent 1 — Qualifier
    const qualification = runQualifier(lead);
    await kvPut(kv, leadKey(leadId, "qualification"), qualification);
    await kvPut(kv, leadKey(leadId, "state"), {
      state:       qualification.state,
      leadId,
      updatedAt:   nowIso(),
      score:       qualification.score,
    });
    result.newState   = qualification.state;
    result.agentRan   = "Qualifier";
    result.score      = qualification.score;
    result.signals    = qualification.signals;

    // If disqualified, log and stop
    if (qualification.state === LEAD_STATES.DISQUALIFIED) {
      result.reason = `Score ${qualification.score}/10 — below threshold of 6`;
      return result;
    }

    // If escalated (very large volume), notify and stop
    if (qualification.state === LEAD_STATES.ESCALATED) {
      result.reason = qualification.escalateReason;
      await notifyFounderEscalation(kv, leadId, lead, qualification.escalateReason, env);
      return result;
    }

    // Continue to next agent immediately
    currentState.state = LEAD_STATES.QUALIFIED;
  }

  if (currentState.state === LEAD_STATES.QUALIFIED) {
    // Agent 2 — Pain Mapper
    const painAnalysis = runPainMapper(lead);
    await kvPut(kv, leadKey(leadId, "pain"), painAnalysis);

    // Agent 3 — ROI Builder (runs immediately after pain mapping)
    const roi = runROIBuilder(lead, painAnalysis);
    await kvPut(kv, leadKey(leadId, "roi"), roi);

    await kvPut(kv, leadKey(leadId, "state"), {
      state:     LEAD_STATES.ROI_BUILT,
      leadId,
      updatedAt: nowIso(),
    });
    currentState.state = LEAD_STATES.ROI_BUILT;
    result.agentRan    = "PainMapper + ROIBuilder";
    result.painSummary = painAnalysis.primaryPain;
    result.netMonthly  = roi.netMonthly;
  }

  if (currentState.state === LEAD_STATES.ROI_BUILT) {
    // Agent 4 — Closer: build email sequence
    const pain   = await kvGet(kv, leadKey(leadId, "pain"))  || runPainMapper(lead);
    const roi    = await kvGet(kv, leadKey(leadId, "roi"))   || runROIBuilder(lead, pain);
    const emails = buildCloserSequence(lead, roi, pain);

    // Store email drafts — do NOT auto-send yet (founder reviews Day 1 email)
    await kvPut(kv, leadKey(leadId, "emails"), {
      sequence:    emails.sequence,
      status:      "pending_review",
      createdAt:   nowIso(),
    });

    await kvPut(kv, leadKey(leadId, "state"), {
      state:     LEAD_STATES.ACTIVE,
      leadId,
      updatedAt: nowIso(),
    });

    result.newState  = LEAD_STATES.ACTIVE;
    result.agentRan  = (result.agentRan ? result.agentRan + " + " : "") + "Closer";
    result.emails    = { count: emails.sequence.length, status: "pending_review" };

    // Notify founder: new qualified lead ready with email drafts
    await notifyFounderNewLead(kv, leadId, lead, roi, emails, env);
  }

  result.newState = result.newState || currentState.state;
  return result;
}

// ── Objection handling entry point ─────────────────────────────────────────
export async function runObjectionOrchestrator(leadId, replyText, env) {
  const kv  = env.KEYWARDEN_STATE || env.RELAY_STATE;
  const lead = await kvGet(kv, leadKey(leadId, "profile"));
  const roi  = await kvGet(kv, leadKey(leadId, "roi"));

  if (!lead) return { error: "Lead not found" };

  const response = runObjectionHandler(replyText, lead, roi);

  if (response.action === "escalate") {
    await kvPut(kv, leadKey(leadId, "state"), {
      state:       LEAD_STATES.ESCALATED,
      leadId,
      updatedAt:   nowIso(),
      reason:      response.reason,
    });
    await notifyFounderEscalation(kv, leadId, lead, response.reason, env);
  } else if (response.draftReply) {
    await kvPut(kv, leadKey(leadId, "objection_draft"), {
      draft:     response.draftReply,
      category:  response.category,
      sendAfter: nowMs() + response.sendDelay,
      status:    "pending_review",
      createdAt: nowIso(),
    });
    await kvPut(kv, leadKey(leadId, "state"), {
      state:     LEAD_STATES.OBJECTION,
      leadId,
      updatedAt: nowIso(),
    });
  }

  return response;
}

// ── Founder notification helpers ──────────────────────────────────────────
async function notifyFounderNewLead(kv, leadId, lead, roi, emails, env) {
  if (!env.NOTIFY_EMAIL) return;

  const subject = `[PrimeCore Lead] ${lead.company} — Score qualified, emails ready for review`;
  const body = `New qualified lead in the Sales Swarm.

Lead ID: ${leadId}
Company: ${lead.company}
Contact: ${lead.name} (${lead.email})
Volume: ${lead.volume}
Vertical: ${lead.vertical}
CCaaS: ${lead.ccaas || "not specified"}
Language: ${lead.lang || "en"}

ROI Model:
  Current monthly cost: $${roi.currentMonthlyCost?.toLocaleString()}
  Recommended plan: ${roi.plan} ($${roi.planCost?.toLocaleString()}/mo)
  Net monthly savings: $${roi.netMonthly?.toLocaleString()}
  Pilot Month 1 (50% off): $${roi.pilotNetMonth1?.toLocaleString()} net
  Calls AI handles: ${roi.aiCallsHandled?.toLocaleString()}/month

Day 1/3/7 email drafts are ready in KV for your review.
Approve to send: POST /relay/leads/${leadId}/approve-email/1

War Room: https://warroom.primecoreintelligence.com

---
PrimeCore Sales Swarm`;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "swarm@primecoreintelligence.com",
        to:   [env.NOTIFY_EMAIL],
        subject,
        text: body,
      }),
    });
  } catch { /* non-fatal */ }
}

async function notifyFounderEscalation(kv, leadId, lead, reason, env) {
  if (!env.NOTIFY_EMAIL) return;
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from:    "swarm@primecoreintelligence.com",
        to:      [env.NOTIFY_EMAIL],
        subject: `[PrimeCore ESCALATION] ${lead?.company || leadId} — founder review required`,
        text:    `Escalation required for lead ${leadId}.\n\nCompany: ${lead?.company}\nContact: ${lead?.name} (${lead?.email})\n\nReason: ${reason}\n\nTake over this thread directly.\n\n---\nPrimeCore Sales Swarm`,
      }),
    });
  } catch { /* non-fatal */ }
}

// ── Sweep: re-process stale leads ─────────────────────────────────────────
export async function sweepStaleLeads(env) {
  const kv = env.KEYWARDEN_STATE || env.RELAY_STATE;
  if (!kv) return;

  const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
  const results = [];

  try {
    const listed = await kv.list({ prefix: "tenant:warroom:lead:", limit: 100 });
    const stateKeys = listed.keys
      .filter(k => k.name.endsWith(":state"))
      .map(k => k.name);

    for (const key of stateKeys) {
      const state = await kvGet(kv, key);
      if (!state) continue;
      if (state.state !== LEAD_STATES.NEW) continue;
      if (!state.createdAt) continue;

      const age = nowMs() - new Date(state.createdAt).getTime();
      if (age < STALE_THRESHOLD_MS) continue;

      // Lead has been NEW for >2 hours — re-trigger orchestration
      const leadId = state.leadId;
      const lead   = await kvGet(kv, leadKey(leadId, "profile"));
      if (!lead) continue;

      const result = await runLeadOrchestrator(leadId, lead, env);
      results.push({ leadId, result });
    }
  } catch { /* sweep failure is non-fatal */ }

  return results;
}
