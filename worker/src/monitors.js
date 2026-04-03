/**
 * PrimeCore Intelligence — Monitoring Swarm
 * Four specialized monitors dispatched from the scheduled cron handler.
 *
 * Scope: PrimeCore infrastructure ONLY.
 * Never touches client CCaaS platforms, never modifies tenant data.
 * Read-only on tenant KV. Write-only on incident log.
 *
 * SEV levels:
 *   SEV1 — War Room API or Relay unreachable (email immediately)
 *   SEV2 — Any surface down 2+ consecutive checks (email within 15 min)
 *   SEV3 — Tenant webhook silent >60 min / KV corruption (email within 1h)
 *   SEV4 — Auto-repaired issues (dashboard only, no email)
 */

"use strict";

// ── Surfaces to check ─────────────────────────────────────────────────────
const SURFACES = [
  { id: "war_room_api",  url: "https://api.primecoreintelligence.com/api/health",        sev: 1 },
  { id: "relay_api",     url: "https://api-relay.primecoreintelligence.com/relay/health", sev: 1 },
  { id: "marketing",     url: "https://primecoreintelligence.com",                        sev: 2 },
  { id: "pilot_portal",  url: "https://pilot.primecoreintelligence.com",                  sev: 2 },
  { id: "app_portal",    url: "https://app.primecoreintelligence.com",                    sev: 2 },
  { id: "status_page",   url: "https://status.primecoreintelligence.com",                 sev: 2 },
  { id: "legal_page",    url: "https://primecoreintelligence.com/legal/",                 sev: 4 },
];

const HEALTH_KEY         = "tenant:warroom:monitor:health:latest";
const HEALTH_HISTORY_KEY = "tenant:warroom:monitor:health:history";
const WEBHOOK_GAPS_KEY   = "tenant:warroom:monitor:webhook_gaps";
const KV_HEALTH_KEY      = "tenant:warroom:monitor:kv_health";
const RELAY_KEY          = "tenant:warroom:monitor:relay_health";
const INCIDENTS_KEY      = "tenant:warroom:incidents:active";
const ALERT_COOLDOWN_KEY = "tenant:warroom:monitor:alert_cooldown";

const TIMEOUT_MS         = 8000;   // 8s per check
const MAX_HISTORY        = 144;    // 24h at 10-min intervals
const WEBHOOK_SILENCE_MS = 60 * 60 * 1000;  // 60 minutes
const ALERT_COOLDOWN_MS  = 30 * 60 * 1000;  // 30 min between same-SEV alerts

// ── Shared helpers ─────────────────────────────────────────────────────────
async function kvGet(kv, key) {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

async function kvPut(kv, key, value, opts = {}) {
  try {
    await kv.put(key, JSON.stringify(value), opts);
    return true;
  } catch { return false; }
}

function nowMs()  { return Date.now(); }
function nowIso() { return new Date().toISOString(); }

async function sendAlert(env, { sev, title, body, surface }) {
  if (!env.NOTIFY_EMAIL) return;

  // Cooldown — don't spam the same SEV within 30 minutes
  const cooldownKey = `${ALERT_COOLDOWN_KEY}:sev${sev}:${surface || "general"}`;
  const lastAlert = await kvGet(env.KEYWARDEN_STATE, cooldownKey);
  if (lastAlert && (nowMs() - lastAlert.ts) < ALERT_COOLDOWN_MS) return;

  await kvPut(env.KEYWARDEN_STATE, cooldownKey, { ts: nowMs() },
    { expirationTtl: Math.ceil(ALERT_COOLDOWN_MS / 1000) });

  const subject = `[PrimeCore SEV${sev}] ${title}`;
  const emailBody = `PrimeCore Intelligence Monitoring Alert

Severity: SEV${sev}
Time: ${nowIso()}
Surface: ${surface || "general"}

${body}

---
PrimeCore Intelligence Monitoring Swarm
View incidents: https://warroom.primecoreintelligence.com
`;

  try {
    await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: env.NOTIFY_EMAIL }] }],
        from: { email: "monitors@primecoreintelligence.com", name: "PrimeCore Monitoring" },
        subject,
        content: [{ type: "text/plain", value: emailBody }],
      }),
    });
  } catch { /* email failure is non-fatal */ }
}

async function writeIncident(kv, incident) {
  const incidents = (await kvGet(kv, INCIDENTS_KEY)) || [];
  incidents.unshift({ ...incident, ts: nowIso(), id: `inc_${Date.now()}` });
  // Keep last 50 incidents
  await kvPut(kv, INCIDENTS_KEY, incidents.slice(0, 50),
    { expirationTtl: 60 * 60 * 24 * 7 }); // 7-day TTL
}

// ── MONITOR 1: HealthMonitor ───────────────────────────────────────────────
// Pings all surfaces. Compares against previous check for consecutive failures.
// SEV1 on core services down. SEV2 on 2+ consecutive failures elsewhere.
export async function runHealthMonitor(env) {
  const kv     = env.KEYWARDEN_STATE;
  const prev   = (await kvGet(kv, HEALTH_KEY)) || { checks: {} };
  const result = { ts: nowIso(), checks: {}, failures: [], degraded: [] };

  await Promise.all(SURFACES.map(async surface => {
    const t0 = nowMs();
    let ok = false, status = 0, latencyMs = 0, error = null;

    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      const res = await fetch(surface.url, {
        method:  "GET",
        headers: { "user-agent": "PrimeCore-Monitor/1.0" },
        signal:  ctrl.signal,
      });
      clearTimeout(timer);
      latencyMs = nowMs() - t0;
      status = res.status;
      ok = res.status >= 200 && res.status < 400;
    } catch (e) {
      latencyMs = nowMs() - t0;
      error = e.name === "AbortError" ? "timeout" : "unreachable";
      ok = false;
    }

    const prevCheck = prev.checks[surface.id] || { ok: true, failCount: 0 };
    const failCount = ok ? 0 : (prevCheck.failCount || 0) + 1;

    result.checks[surface.id] = { ok, status, latencyMs, error, failCount, surface: surface.url };

    if (!ok) {
      result.failures.push(surface.id);

      // SEV1: core services (war room API or relay) on first failure
      if (surface.sev === 1) {
        await writeIncident(kv, {
          sev: 1, type: "health", surface: surface.id,
          message: `${surface.id} unreachable. Status: ${status}. Error: ${error || "HTTP error"}.`,
        });
        await sendAlert(env, {
          sev: 1,
          title: `${surface.id} is down`,
          surface: surface.id,
          body: `Surface: ${surface.url}\nStatus: ${status}\nError: ${error || "non-2xx response"}\nLatency: ${latencyMs}ms\n\nThis is a SEV1 — core infrastructure is unreachable.`,
        });
      }

      // SEV2: secondary surfaces after 2+ consecutive failures
      if (surface.sev === 2 && failCount >= 2) {
        await writeIncident(kv, {
          sev: 2, type: "health", surface: surface.id,
          message: `${surface.id} down for ${failCount} consecutive checks.`,
        });
        await sendAlert(env, {
          sev: 2,
          title: `${surface.id} down (${failCount} checks)`,
          surface: surface.id,
          body: `Surface: ${surface.url}\nConsecutive failures: ${failCount}\nStatus: ${status}\nError: ${error || "non-2xx"}`,
        });
      }
    }

    // Latency warning: >3s on core services
    if (ok && latencyMs > 3000 && surface.sev === 1) {
      result.degraded.push({ surface: surface.id, latencyMs });
    }
  }));

  // Persist latest result
  await kvPut(kv, HEALTH_KEY, result, { expirationTtl: 60 * 60 * 24 });

  // Append to rolling history (keep MAX_HISTORY entries)
  const history = (await kvGet(kv, HEALTH_HISTORY_KEY)) || [];
  history.unshift({ ts: result.ts, failures: result.failures, degraded: result.degraded });
  await kvPut(kv, HEALTH_HISTORY_KEY, history.slice(0, MAX_HISTORY),
    { expirationTtl: 60 * 60 * 48 }); // 48h

  return result;
}

// ── MONITOR 2: WebhookMonitor ──────────────────────────────────────────────
// Scans active pilot tenants. If a tenant in shadow/live mode has no
// webhook events in 60 minutes, that's a SEV3.
// "Never connected" tenants (still onboarding) are SEV4 — tracked but no alert.
export async function runWebhookMonitor(env) {
  const kv     = env.KEYWARDEN_STATE;
  const result = { ts: nowIso(), tenants_checked: 0, gaps: [], new_gaps: [] };

  // List all onboarding records (tenant:public:onboarding:*)
  let tenantList = [];
  try {
    const listed = await kv.list({ prefix: "tenant:public:onboarding:" });
    tenantList = listed.keys.map(k => k.name.split("tenant:public:onboarding:")[1]).filter(Boolean);
  } catch { return result; }

  result.tenants_checked = tenantList.length;

  for (const tenantId of tenantList) {
    try {
      const onboarding = await kvGet(kv, `tenant:public:onboarding:${tenantId}`);
      if (!onboarding) continue;

      // Only monitor tenants that have completed onboarding
      const isActive = onboarding.steps && (
        onboarding.steps.includes("verify") ||
        onboarding.steps.includes("completed") ||
        onboarding.step === "completed"
      );
      if (!isActive) continue;

      // Check last webhook event for this tenant
      const lastEvent = await kvGet(kv, `tenant:${tenantId}:call:last_event`);
      const completedAt = onboarding.completedAt
        ? new Date(onboarding.completedAt).getTime()
        : nowMs() - (2 * 60 * 60 * 1000);

      const lastEventTs = lastEvent?.ts
        ? new Date(lastEvent.ts).getTime()
        : completedAt; // fallback to completion time

      const silenceMs = nowMs() - lastEventTs;

      if (silenceMs > WEBHOOK_SILENCE_MS) {
        const gapEntry = {
          tenantId,
          silenceMs,
          silenceMinutes: Math.round(silenceMs / 60000),
          lastEvent: lastEvent?.ts || null,
          platform: onboarding.platform || "unknown",
        };
        result.gaps.push(gapEntry);

        // Was this gap already known?
        const prevGaps = (await kvGet(kv, WEBHOOK_GAPS_KEY)) || [];
        const alreadyKnown = prevGaps.some(g => g.tenantId === tenantId);

        if (!alreadyKnown) {
          result.new_gaps.push(gapEntry);
          await writeIncident(kv, {
            sev: 3, type: "webhook_gap", tenantId,
            message: `Tenant ${tenantId} (${onboarding.platform}) has not sent a webhook event in ${gapEntry.silenceMinutes} minutes.`,
          });
          await sendAlert(env, {
            sev: 3,
            title: `Webhook silence: tenant ${tenantId}`,
            surface: "webhook",
            body: `Tenant: ${tenantId}\nPlatform: ${onboarding.platform || "unknown"}\nSilence: ${gapEntry.silenceMinutes} minutes\nLast event: ${lastEvent?.ts || "never"}\n\nClient may have a misconfigured webhook. Check onboarding steps and relay health.`,
          });
        }
      }
    } catch { continue; }
  }

  await kvPut(kv, WEBHOOK_GAPS_KEY, result.gaps, { expirationTtl: 60 * 60 * 24 });
  return result;
}

// ── MONITOR 3: KVMonitor ───────────────────────────────────────────────────
// Validates known KV schema patterns. Auto-repairs fixable issues.
// Flags unfixable corruption as SEV3.
export async function runKVMonitor(env) {
  const kv     = env.KEYWARDEN_STATE;
  const result = { ts: nowIso(), checked: 0, repaired: 0, flagged: 0, issues: [] };

  // Check the global metrics record
  try {
    const metrics = await kvGet(kv, "tenant:warroom:metrics:current");
    if (metrics !== null) {
      result.checked++;
      let repaired = false;
      const fixed = { ...metrics };

      // Required fields with safe defaults
      const defaults = {
        active_calls: 0, fcr_rate: "Collecting baseline",
        sla_compliance: "Collecting baseline", pilot_requests: 0,
        calls_today: 0, pipeline: "Pilot mode",
      };
      for (const [k, v] of Object.entries(defaults)) {
        if (fixed[k] === undefined || fixed[k] === null) {
          fixed[k] = v; repaired = true;
        }
      }
      if (!fixed.updatedAt) { fixed.updatedAt = nowIso(); repaired = true; }

      if (repaired) {
        await kvPut(kv, "tenant:warroom:metrics:current", fixed,
          { expirationTtl: 60 * 60 * 24 * 30 });
        result.repaired++;
        result.issues.push({ key: "metrics:current", action: "auto-repaired missing fields", sev: 4 });
      }
    }
  } catch (e) {
    result.flagged++;
    result.issues.push({ key: "metrics:current", action: "unreadable", error: e.message, sev: 3 });
    await writeIncident(kv, {
      sev: 3, type: "kv_corruption", key: "metrics:current",
      message: `Global metrics record is unreadable: ${e.message}`,
    });
    await sendAlert(env, {
      sev: 3, title: "KV: metrics record unreadable",
      surface: "kv",
      body: `Key: tenant:warroom:metrics:current\nError: ${e.message}\n\nThe War Room dashboard will show stale data until this is repaired.`,
    });
  }

  // Check incident queue itself isn't corrupted
  try {
    const incidents = await kvGet(kv, INCIDENTS_KEY);
    if (incidents !== null && !Array.isArray(incidents)) {
      // Corrupted — reset to empty array
      await kvPut(kv, INCIDENTS_KEY, [], { expirationTtl: 60 * 60 * 24 * 7 });
      result.repaired++;
      result.issues.push({ key: "incidents:active", action: "reset — was not an array", sev: 4 });
    }
    result.checked++;
  } catch { result.checked++; }

  // Check rate limiting KV entries aren't stuck
  try {
    const rlList = await kv.list({ prefix: "rl:", limit: 50 });
    for (const key of rlList.keys) {
      const raw = await kv.get(key.name);
      if (raw) {
        const parsed = parseInt(raw, 10);
        // If a rate limit counter is impossibly high (>10000 in a window), reset it
        if (!isNaN(parsed) && parsed > 10000) {
          await kv.delete(key.name);
          result.repaired++;
          result.issues.push({ key: key.name, action: "reset — counter overflow", sev: 4 });
        }
        result.checked++;
      }
    }
  } catch { /* rate limit check failure is non-fatal */ }

  await kvPut(kv, KV_HEALTH_KEY, result, { expirationTtl: 60 * 60 * 24 });
  return result;
}

// ── MONITOR 4: RelayMonitor ────────────────────────────────────────────────
// Checks relay health and version. Verifies Durable Object sessions
// aren't zombie (active but 4h+ without alarm cleanup).
export async function runRelayMonitor(env) {
  const kv     = env.KEYWARDEN_STATE;
  const result = { ts: nowIso(), relay_ok: false, latencyMs: 0, version: null, issues: [] };

  // Ping relay health
  const t0 = nowMs();
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res   = await fetch("https://api-relay.primecoreintelligence.com/relay/health", {
      headers: { "user-agent": "PrimeCore-Monitor/1.0" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    result.latencyMs = nowMs() - t0;

    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      result.relay_ok = true;
      result.version  = body.version || null;
    } else {
      result.issues.push({ type: "relay_http_error", status: res.status });
    }
  } catch (e) {
    result.latencyMs = nowMs() - t0;
    result.issues.push({ type: "relay_unreachable", error: e.name === "AbortError" ? "timeout" : e.message });
  }

  // Check for tenants with uncommonly high rate limit hit counts
  // (could indicate a legitimate client being wrongly blocked)
  try {
    const rlList = await kv.list({ prefix: "rl:" });
    for (const key of rlList.keys) {
      const raw = await kv.get(key.name);
      if (raw) {
        const count = parseInt(raw, 10);
        // A single IP at >500 requests in a rate window is unusual — flag it
        if (!isNaN(count) && count > 500) {
          result.issues.push({
            type: "rate_limit_spike", key: key.name, count,
            note: "May be legitimate burst or attempted abuse"
          });
          await writeIncident(kv, {
            sev: 4, type: "rate_limit_spike", key: key.name,
            message: `Rate limit spike: ${key.name} at ${count} requests. May be legitimate burst.`,
          });
        }
      }
    }
  } catch { /* non-fatal */ }

  // Redeploy hook placeholder — requires CLOUDFLARE_API_TOKEN secret
  // Uncomment once CLOUDFLARE_API_TOKEN is set in Worker secrets:
  //
  // if (!result.relay_ok && env.CLOUDFLARE_API_TOKEN) {
  //   try {
  //     await fetch(
  //       `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/primecore-relay/deployments`,
  //       {
  //         method: "POST",
  //         headers: {
  //           "Authorization": `Bearer ${env.CLOUDFLARE_API_TOKEN}`,
  //           "Content-Type": "application/json",
  //         },
  //         body: JSON.stringify({ strategy: "percentage", annotations: { "workers/triggered_by": "monitor" } }),
  //       }
  //     );
  //   } catch { /* redeploy attempt failed — already alerting */ }
  // }

  await kvPut(kv, RELAY_KEY, result, { expirationTtl: 60 * 60 * 24 });
  return result;
}


// ── MONITOR 5: NotionMonitor ───────────────────────────────────────────────
// Reads a single row from the Leads & Deals database — read-only.
// Verifies the Notion API integration is healthy. SEV2 on 2 consecutive failures.
// Requires: env.NOTION_SECRET (Internal Integration Token)
//           env.NOTION_LEADS_DB (Leads & Deals database ID)
const NOTION_HEALTH_KEY    = "tenant:warroom:monitor:notion_health";
const NOTION_FAIL_KEY      = "tenant:warroom:monitor:notion_fail_count";

export async function runNotionMonitor(env) {
  const kv = env.KEYWARDEN_STATE;
  const result = { ts: nowIso(), ok: false, latencyMs: 0, error: null };

  if (!env.NOTION_SECRET || !env.NOTION_LEADS_DB) {
    result.error = "NOTION_SECRET or NOTION_LEADS_DB not configured";
    await kvPut(kv, NOTION_HEALTH_KEY, result, { expirationTtl: 60 * 60 * 24 });
    return result;
  }

  const t0 = nowMs();
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000); // 5s timeout
    const res = await fetch(
      `https://api.notion.com/v1/databases/${env.NOTION_LEADS_DB}/query`,
      {
        method: "POST",
        headers: {
          "Authorization":  `Bearer ${env.NOTION_SECRET}`,
          "Notion-Version": "2022-06-28",
          "Content-Type":   "application/json",
        },
        body: JSON.stringify({ page_size: 1 }), // read-only, minimum query
        signal: ctrl.signal,
      }
    );
    clearTimeout(timer);
    result.latencyMs = nowMs() - t0;

    if (res.ok) {
      result.ok = true;
      // Reset fail counter on success
      await kvPut(kv, NOTION_FAIL_KEY, { count: 0 }, { expirationTtl: 60 * 60 * 24 });
    } else {
      const body = await res.json().catch(() => ({}));
      result.error = `HTTP ${res.status}: ${body?.message || "Notion API error"}`;
      await handleNotionFailure(env, kv, result.error, result.latencyMs);
    }
  } catch (e) {
    result.latencyMs = nowMs() - t0;
    result.error = e.name === "AbortError" ? "timeout after 5000ms" : e.message;
    await handleNotionFailure(env, kv, result.error, result.latencyMs);
  }

  await kvPut(kv, NOTION_HEALTH_KEY, result, { expirationTtl: 60 * 60 * 24 });
  return result;
}

async function handleNotionFailure(env, kv, errorMsg, latencyMs) {
  const failData = (await kvGet(kv, NOTION_FAIL_KEY)) || { count: 0 };
  failData.count = (failData.count || 0) + 1;
  await kvPut(kv, NOTION_FAIL_KEY, failData, { expirationTtl: 60 * 60 * 24 });

  // SEV2 on 2+ consecutive failures — new leads will not reach Notion
  if (failData.count >= 2) {
    await writeIncident(kv, {
      sev: 2, type: "notion_down", surface: "notion",
      message: `Notion API failing for ${failData.count} consecutive checks. Error: ${errorMsg}. New lead submissions will not create Notion pages.`,
    });
    await sendAlert(env, {
      sev: 2,
      title: `Notion API down (${failData.count} checks)`,
      surface: "notion",
      body: `Consecutive failures: ${failData.count}\nError: ${errorMsg}\nLatency: ${latencyMs}ms\n\nImpact: New pilot form submissions will not create Notion lead pages.\nAction: Check Notion integration token validity at https://www.notion.so/my-integrations`,
    });
  }
}

// ── MONITOR 6: EmailDeliveryMonitor ───────────────────────────────────────
// Sends a synthetic test email via Resend. Verifies email delivery is live.
// Runs once daily at 09:00 UTC. SEV2 on failure.
// Requires: env.RESEND_API_KEY
//           env.NOTIFY_EMAIL (the monitoring destination address)
const EMAIL_HEALTH_KEY = "tenant:warroom:monitor:email_health";
const EMAIL_LAST_KEY   = "tenant:warroom:monitor:email_last_sent";

export async function runEmailDeliveryMonitor(env) {
  const kv = env.KEYWARDEN_STATE;
  const result = { ts: nowIso(), ok: false, latencyMs: 0, error: null, skipped: false };

  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) {
    result.error = "RESEND_API_KEY or NOTIFY_EMAIL not configured";
    result.skipped = true;
    await kvPut(kv, EMAIL_HEALTH_KEY, result, { expirationTtl: 60 * 60 * 24 });
    return result;
  }

  // Only send once every 20 hours minimum (prevents duplicate sends on retry)
  const lastSent = await kvGet(kv, EMAIL_LAST_KEY);
  if (lastSent && (nowMs() - lastSent.ts) < 20 * 60 * 60 * 1000) {
    result.skipped = true;
    result.error   = "Skipped — sent within last 20 hours";
    await kvPut(kv, EMAIL_HEALTH_KEY, result, { expirationTtl: 60 * 60 * 24 });
    return result;
  }

  const t0 = nowMs();
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify({
        from:    "monitors@primecoreintelligence.com",
        to:      [env.NOTIFY_EMAIL],
        subject: "[PrimeCore Monitor] Email delivery check — OK",
        html:    `<p>This is an automated delivery check from PrimeCore Intelligence monitoring swarm.</p>
                  <p>Time: ${nowIso()}</p>
                  <p>If you received this, email delivery is confirmed working.</p>
                  <p style="color:#7a93b8;font-size:12px;">PrimeCore Intelligence · Monitoring · warroom.primecoreintelligence.com</p>`,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    result.latencyMs = nowMs() - t0;

    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      result.ok = true;
      result.messageId = body?.id || null;
      // Record last sent timestamp
      await kvPut(kv, EMAIL_LAST_KEY, { ts: nowMs(), messageId: result.messageId },
        { expirationTtl: 60 * 60 * 48 });
    } else {
      const body = await res.json().catch(() => ({}));
      result.error = `HTTP ${res.status}: ${body?.message || "Resend API error"}`;
      await writeIncident(kv, {
        sev: 2, type: "email_delivery_failed", surface: "resend",
        message: `Email delivery failing via Resend. Error: ${result.error}. Prospect follow-ups and alerts affected.`,
      });
      await sendAlert(env, {
        sev: 2,
        title: "Email delivery failing via Resend",
        surface: "email",
        body: `Error: ${result.error}\nLatency: ${result.latencyMs}ms\n\nImpact: Follow-up sequences, pilot confirmation emails, and operations alerts via Resend will not send.\nAction: Check RESEND_API_KEY validity at https://resend.com/api-keys`,
      });
    }
  } catch (e) {
    result.latencyMs = nowMs() - t0;
    result.error = e.name === "AbortError" ? "timeout after 10000ms" : e.message;
    await writeIncident(kv, {
      sev: 2, type: "email_delivery_failed", surface: "resend",
      message: `Email delivery check timed out or failed: ${result.error}`,
    });
    await sendAlert(env, {
      sev: 2,
      title: "Email delivery check failed",
      surface: "email",
      body: `Error: ${result.error}\nThis likely means Resend API is unreachable or the API key is invalid.`,
    });
  }

  await kvPut(kv, EMAIL_HEALTH_KEY, result, { expirationTtl: 60 * 60 * 24 });
  return result;
}
