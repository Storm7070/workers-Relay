// ══════════════════════════════════════════════════════════════════════════════
// CFO INTELLIGENCE LAYER — Phase 5
// Accounting · Audit · Tax · Market Positioning · Financial Advisor
//
// Capabilities:
//  1. Revenue tracking — record payments, subscriptions, refunds
//  2. P&L engine — auto-compute monthly profit & loss
//  3. Audit department — flag anomalies, discrepancies, suspicious patterns
//  4. Tax intelligence — estimated liability, quarterly reminders
//  5. Market positioning — where to invest, what to cut, ROI rankings
//  6. Financial advisor — AI-powered strategic financial guidance
//  7. Monthly CFO brief — auto-generated, sent to Slack + stored
// ══════════════════════════════════════════════════════════════════════════════

// ── Expense categories ────────────────────────────────────────────────────
export const EXPENSE_CATEGORIES = [
  "infrastructure",   // Cloudflare, Railway, hosting
  "ai_apis",          // Anthropic, other AI
  "services",         // Slack, Notion, Resend, Paddle fees
  "marketing",        // ads, content, outreach
  "operations",       // tools, subscriptions
  "labor",            // contractors, freelancers
  "taxes",            // estimated tax payments
  "other",
];

// ── Revenue categories ────────────────────────────────────────────────────
export const REVENUE_CATEGORIES = [
  "starter_mrr",      // $2,400/mo subscriptions
  "professional_mrr", // $5,800/mo subscriptions
  "enterprise_mrr",   // $7,997/mo subscriptions
  "one_time",         // setup fees, consulting
  "refund",           // negative revenue
];

// ── KV helpers ───────────────────────────────────────────────────────────
async function kvGet(kv, key, fallback = null) {
  if (!kv) return fallback;
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
async function kvPut(kv, key, value, ttl = 86400 * 365) {
  if (!kv) return;
  try { await kv.put(key, JSON.stringify(value), { expirationTtl: ttl }); }
  catch { /* non-fatal */ }
}

// ── Date helpers ──────────────────────────────────────────────────────────
function currentPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
function currentYear() {
  return String(new Date().getUTCFullYear());
}
function currentQuarter() {
  const m = new Date().getUTCMonth(); // 0-indexed
  return `Q${Math.floor(m / 3) + 1}`;
}

// ── Record a transaction ─────────────────────────────────────────────────
export async function recordTransaction(kv, tx) {
  // tx = { type: "revenue"|"expense", category, amount, description, date?, source? }
  const date   = tx.date || new Date().toISOString();
  const period = date.slice(0, 7); // YYYY-MM
  const id     = `tx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  const record = {
    id,
    type:        tx.type,
    category:    tx.category,
    amount:      parseFloat(tx.amount),
    description: tx.description || "",
    source:      tx.source || "manual",
    date,
    period,
    recordedAt:  new Date().toISOString(),
  };

  // Store individual transaction (1yr TTL)
  await kvPut(kv, `cfo:tx:${id}`, record, 86400 * 365);

  // Update period ledger
  const ledgerKey = `cfo:ledger:${period}`;
  const ledger    = await kvGet(kv, ledgerKey, { period, transactions: [], revenue: 0, expenses: 0 });
  ledger.transactions.push(record);
  if (tx.type === "revenue") {
    ledger.revenue = (ledger.revenue || 0) + record.amount;
  } else {
    ledger.expenses = (ledger.expenses || 0) + record.amount;
  }
  ledger.lastUpdated = new Date().toISOString();
  await kvPut(kv, ledgerKey, ledger, 86400 * 400);

  // Update running YTD
  const ytdKey = `cfo:ytd:${currentYear()}`;
  const ytd    = await kvGet(kv, ytdKey, { year: currentYear(), revenue: 0, expenses: 0, transactions: [] });
  if (tx.type === "revenue") ytd.revenue  = (ytd.revenue  || 0) + record.amount;
  else                        ytd.expenses = (ytd.expenses || 0) + record.amount;
  ytd.lastUpdated = new Date().toISOString();
  await kvPut(kv, ytdKey, ytd, 86400 * 400);

  return { ok: true, id, record };
}

// ── Compute P&L for a period ──────────────────────────────────────────────
export async function computePnL(kv, period) {
  const ledger = await kvGet(kv, `cfo:ledger:${period}`, null);
  if (!ledger) return { ok: false, error: "No data for period", period };

  const txs       = ledger.transactions || [];
  const revenue   = txs.filter(t => t.type === "revenue").reduce((s, t) => s + t.amount, 0);
  const expenses  = txs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  const netProfit = revenue - expenses;
  const margin    = revenue > 0 ? ((netProfit / revenue) * 100).toFixed(1) : "0.0";

  // Revenue breakdown by category
  const revByCategory = {};
  txs.filter(t => t.type === "revenue").forEach(t => {
    revByCategory[t.category] = (revByCategory[t.category] || 0) + t.amount;
  });

  // Expense breakdown by category
  const expByCategory = {};
  txs.filter(t => t.type === "expense").forEach(t => {
    expByCategory[t.category] = (expByCategory[t.category] || 0) + t.amount;
  });

  // MRR estimate from subscriptions
  const mrrCategories = ["starter_mrr", "professional_mrr", "enterprise_mrr"];
  const mrr = mrrCategories.reduce((s, c) => s + (revByCategory[c] || 0), 0);

  const pnl = {
    period,
    revenue:         parseFloat(revenue.toFixed(2)),
    expenses:        parseFloat(expenses.toFixed(2)),
    net_profit:      parseFloat(netProfit.toFixed(2)),
    profit_margin:   `${margin}%`,
    mrr,
    revenue_by_category: revByCategory,
    expense_by_category: expByCategory,
    transaction_count:   txs.length,
    computed_at:         new Date().toISOString(),
  };

  // Store the P&L snapshot
  await kvPut(kv, `cfo:pnl:${period}`, pnl, 86400 * 400);
  return { ok: true, ...pnl };
}

// ── Audit engine ──────────────────────────────────────────────────────────
export async function runAudit(kv, period) {
  const ledger = await kvGet(kv, `cfo:ledger:${period}`, null);
  const flags  = [];

  if (!ledger) {
    return { ok: true, period, flags: [], message: "No ledger data to audit" };
  }

  const txs = ledger.transactions || [];

  // Flag: Large single transactions (>$5k expense or >$20k revenue)
  txs.forEach(t => {
    if (t.type === "expense" && t.amount > 5000) {
      flags.push({
        type:        "LARGE_EXPENSE",
        severity:    "medium",
        tx_id:       t.id,
        amount:      t.amount,
        description: t.description,
        message:     `Large expense: $${t.amount.toLocaleString()} — ${t.category}: "${t.description}"`,
      });
    }
    if (t.type === "revenue" && t.amount > 20000) {
      flags.push({
        type:        "LARGE_REVENUE",
        severity:    "info",
        tx_id:       t.id,
        amount:      t.amount,
        description: t.description,
        message:     `Large revenue event: $${t.amount.toLocaleString()} — verify source`,
      });
    }
  });

  // Flag: Uncategorized / "other" expenses >$500
  txs.filter(t => t.type === "expense" && t.category === "other" && t.amount > 500).forEach(t => {
    flags.push({
      type:        "UNCATEGORIZED",
      severity:    "low",
      tx_id:       t.id,
      amount:      t.amount,
      message:     `Uncategorized expense $${t.amount}: "${t.description}" — reclassify`,
    });
  });

  // Flag: Negative margin
  const revenue  = txs.filter(t => t.type === "revenue").reduce((s, t) => s + t.amount, 0);
  const expenses = txs.filter(t => t.type === "expense").reduce((s, t) => s + t.amount, 0);
  if (revenue > 0 && expenses > revenue) {
    flags.push({
      type:        "NEGATIVE_MARGIN",
      severity:    "high",
      amount:      expenses - revenue,
      message:     `Negative P&L: expenses ($${expenses.toLocaleString()}) exceed revenue ($${revenue.toLocaleString()}) by $${(expenses - revenue).toLocaleString()}`,
    });
  }

  // Flag: No revenue recorded
  if (revenue === 0 && txs.length > 0) {
    flags.push({
      type:        "ZERO_REVENUE",
      severity:    "high",
      message:     `No revenue recorded for ${period} — ${txs.length} transactions logged but all expenses`,
    });
  }

  // Flag: Duplicate amounts (potential double-entry)
  const amounts = txs.map(t => `${t.type}-${t.amount}-${t.category}`);
  const seen    = new Set();
  const dups    = new Set();
  amounts.forEach((a, i) => {
    if (seen.has(a)) dups.add(i);
    seen.add(a);
  });
  dups.forEach(i => {
    flags.push({
      type:        "POTENTIAL_DUPLICATE",
      severity:    "medium",
      tx_id:       txs[i].id,
      amount:      txs[i].amount,
      message:     `Potential duplicate: $${txs[i].amount} ${txs[i].type} (${txs[i].category}) — verify`,
    });
  });

  const report = {
    ok:          true,
    period,
    flags,
    flag_count:  flags.length,
    high_count:  flags.filter(f => f.severity === "high").length,
    audited_at:  new Date().toISOString(),
    revenue,
    expenses,
    clean:       flags.length === 0,
  };

  await kvPut(kv, `cfo:audit:${period}`, report, 86400 * 400);
  return report;
}

// ── Tax estimation ────────────────────────────────────────────────────────
export async function estimateTax(kv) {
  const year = currentYear();
  const ytd  = await kvGet(kv, `cfo:ytd:${year}`, null);
  if (!ytd) return { ok: false, error: "No YTD data" };

  const netProfit = (ytd.revenue || 0) - (ytd.expenses || 0);
  const quarter   = currentQuarter();

  // Tentative estimates — flagged as estimates, not legal advice
  // Federal effective rate estimate for pass-through / S-corp structure
  const federalRate       = 0.21;   // flat C-corp or ~21% effective for pass-through
  const selfEmployRate    = 0.153;  // SE tax if sole prop / LLC
  const stateRate         = 0.06;   // conservative state rate estimate

  const federalEstimate   = netProfit > 0 ? netProfit * federalRate   : 0;
  const stateEstimate     = netProfit > 0 ? netProfit * stateRate      : 0;
  const seEstimate        = netProfit > 0 ? Math.min(netProfit, 160200) * selfEmployRate : 0;

  // Quarterly estimated tax (IRS Form 1040-ES schedule)
  const quarterlyFederal  = federalEstimate / 4;
  const deadlines: Record<string, string> = {
    Q1: `${year}-04-15`,
    Q2: `${year}-06-15`,
    Q3: `${year}-09-15`,
    Q4: `${parseInt(year) + 1}-01-15`,
  };

  const result = {
    ok:              true,
    year,
    current_quarter: quarter,
    ytd_revenue:     ytd.revenue || 0,
    ytd_expenses:    ytd.expenses || 0,
    ytd_net_profit:  parseFloat(netProfit.toFixed(2)),
    estimates: {
      federal_income:     parseFloat(federalEstimate.toFixed(2)),
      self_employment:    parseFloat(seEstimate.toFixed(2)),
      state_income:       parseFloat(stateEstimate.toFixed(2)),
      total_estimated:    parseFloat((federalEstimate + stateEstimate).toFixed(2)),
      quarterly_payment:  parseFloat(quarterlyFederal.toFixed(2)),
    },
    next_deadline:   deadlines[quarter] || deadlines["Q4"],
    disclaimer:      "TENTATIVE ESTIMATES — consult a licensed CPA or tax attorney before filing. Rates are illustrative averages.",
    computed_at:     new Date().toISOString(),
  };

  await kvPut(kv, `cfo:tax:${year}`, result, 86400 * 400);
  return result;
}

// ── AI Financial Advisor ──────────────────────────────────────────────────
export async function runFinancialAdvisor(env, kv, context) {
  if (!env.ANTHROPIC_API_KEY) return null;

  const SYSTEM = `You are the CFO and Chief Financial Advisor of PrimeCore Intelligence — an AI-native CCaaS platform.
Your mandate: maximize profit, eliminate waste, avoid losses at all times, identify gut-wrenching opportunities.
You are SHARP. Nothing slips under the table. You control how capital is deployed and where PrimeCore should be positioned.

PrimeCore financials context:
- Pricing: Starter $2,400/mo · Professional $5,800/mo · Enterprise $7,997/mo
- Costs: Anthropic API (pay per call), Cloudflare Workers (metered), Railway ($20-500/mo), Notion, Slack, Resend, Paddle (5% fee)
- Business model: recurring SaaS + usage-based AI calling
- Target markets: healthcare, logistics, BPO

When asked for financial advice, provide:
1. Revenue opportunities — ranked by ROI
2. Cost reduction targets — specific line items
3. Cash flow risks — what could hurt us in 90 days
4. Market positioning — where to invest capital for maximum return
5. Action items — ranked by impact, with specific numbers

Be a financial advisor who gives real recommendations, not vague platitudes.
Respond with valid JSON only:
{
  "financial_position": "1-sentence assessment",
  "revenue_opportunities": [{"opportunity": "description", "estimated_revenue": "$X/mo", "effort": "low|medium|high", "priority": 1}],
  "cost_reductions": [{"item": "description", "estimated_savings": "$X/mo", "action": "specific action"}],
  "cash_flow_risks": [{"risk": "description", "timeline": "30|60|90 days", "severity": "low|medium|high"}],
  "market_positioning": [{"position": "description", "capital_required": "$X", "roi_estimate": "X%", "timeline": "Xmo"}],
  "action_items": [{"action": "specific action", "impact": "$X/mo", "urgency": "immediate|this_week|this_month"}],
  "gut_wrenching_opportunity": null or "string — major opportunity requiring immediate founder attention"
}`;

  const userMsg = `Current financial context:
Period: ${context.period || "N/A"}
Revenue: $${(context.revenue || 0).toLocaleString()}
Expenses: $${(context.expenses || 0).toLocaleString()}
Net profit: $${(context.net_profit || 0).toLocaleString()}
Profit margin: ${context.profit_margin || "N/A"}
MRR: $${(context.mrr || 0).toLocaleString()}
YTD revenue: $${(context.ytd_revenue || 0).toLocaleString()}
YTD expenses: $${(context.ytd_expenses || 0).toLocaleString()}
Audit flags: ${context.audit_flags || 0}
Leads in pipeline: ${context.leads_count || 0}
${context.additional_context || ""}

Provide sharp financial advisory for PrimeCore Intelligence.`;

  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type":      "application/json",
        "x-api-key":         env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-5",
        max_tokens: 1200,
        system:     SYSTEM,
        messages:   [{ role: "user", content: userMsg }],
      }),
    });
    if (!resp.ok) return null;
    const data    = await resp.json();
    const content = data.content?.[0]?.text;
    if (!content) return null;
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error("[CFO Advisor] failed:", e.message);
    return null;
  }
}

// ── Generate monthly CFO brief ────────────────────────────────────────────
export async function generateMonthlyCFOBrief(env, kv, period) {
  // 1. Get/compute P&L
  const pnl = await computePnL(kv, period);
  // 2. Run audit
  const audit = await runAudit(kv, period);
  // 3. Tax estimate
  const tax = await estimateTax(kv);
  // 4. AI advisory
  const advisorContext = {
    period,
    ...pnl,
    audit_flags:  audit?.flag_count || 0,
    ytd_revenue:  tax?.ytd_revenue  || 0,
    ytd_expenses: tax?.ytd_expenses || 0,
  };
  const advice = await runFinancialAdvisor(env, kv, advisorContext);

  const brief = {
    period,
    generated_at: new Date().toISOString(),
    pnl,
    audit,
    tax,
    advisory:     advice,
  };

  await kvPut(kv, `cfo:brief:${period}`, brief, 86400 * 400);

  // Send to Slack
  if (env.SLACK_WEBHOOK_APPROVALS && pnl.ok) {
    const netStr = pnl.net_profit >= 0 ? `+$${pnl.net_profit.toLocaleString()}` : `-$${Math.abs(pnl.net_profit).toLocaleString()}`;
    const auditStr = audit.clean ? "✅ Clean audit" : `⚠ ${audit.flag_count} audit flags`;
    const gutOpp  = advice?.gut_wrenching_opportunity;
    let slackMsg = `*📊 CFO Monthly Brief — ${period}*\n\n` +
      `Revenue: $${pnl.revenue.toLocaleString()}\n` +
      `Expenses: $${pnl.expenses.toLocaleString()}\n` +
      `Net P&L: *${netStr}* (${pnl.profit_margin} margin)\n` +
      `MRR: $${pnl.mrr.toLocaleString()}\n\n` +
      `${auditStr}\n` +
      `Tax estimate Q: $${tax?.estimates?.quarterly_payment?.toLocaleString() || "N/A"} (next: ${tax?.next_deadline || "N/A"})\n\n`;

    if (advice?.financial_position) {
      slackMsg += `*CFO Assessment:* ${advice.financial_position}\n\n`;
    }
    if (advice?.action_items?.length) {
      slackMsg += `*Top Action Items:*\n${advice.action_items.slice(0, 3).map((a: any) => `• ${a.action} (${a.impact})`).join("\n")}\n\n`;
    }
    if (gutOpp) {
      slackMsg += `🚨 *GUT-WRENCHING OPPORTUNITY:* ${gutOpp}\n\n`;
    }
    slackMsg += `_PrimeCore Intelligence — CFO Intelligence Layer_`;

    try {
      await fetch(env.SLACK_WEBHOOK_APPROVALS, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: slackMsg }),
      });
    } catch { /* non-fatal */ }
  }

  return { ok: true, brief };
}

// ── Get dashboard summary ──────────────────────────────────────────────────
export async function getCFODashboard(kv) {
  const period  = currentPeriod();
  const year    = currentYear();

  const [ledger, pnl, audit, tax, lastBrief, ytd] = await Promise.all([
    kvGet(kv, `cfo:ledger:${period}`, null),
    kvGet(kv, `cfo:pnl:${period}`,    null),
    kvGet(kv, `cfo:audit:${period}`,  null),
    kvGet(kv, `cfo:tax:${year}`,      null),
    kvGet(kv, `cfo:brief:${period}`,  null),
    kvGet(kv, `cfo:ytd:${year}`,      null),
  ]);

  // Load last 6 months of P&L for trend
  const months     = [];
  const now        = new Date();
  const pnlHistory = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getUTCFullYear(), now.getUTCMonth() - i, 1);
    const p = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    months.push(p);
  }
  for (const m of months) {
    const p = await kvGet(kv, `cfo:pnl:${m}`, null);
    pnlHistory.push({ period: m, revenue: p?.revenue || 0, expenses: p?.expenses || 0, net_profit: p?.net_profit || 0 });
  }

  return {
    ok:           true,
    current_period: period,
    current_year:   year,
    ledger,
    pnl,
    audit,
    tax,
    ytd,
    last_brief:   lastBrief,
    pnl_history:  pnlHistory,
    generated_at: new Date().toISOString(),
  };
}
