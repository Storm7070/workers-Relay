# PrimeCore Intelligence — Workers Relay v2.0

**API relay, rate limiting, CCaaS webhooks, ROI engine, outbound calls, Durable Object WebSocket.**

Live at: `https://api-relay.primecoreintelligence.com`

---

## What's New in v2.0

| Feature | Detail |
|---|---|
| **Durable Object WebSocket** | `TeleprompterSession` — global WebSocket, not localhost. Each session gets its own DO instance. |
| **ROI Engine** | Live calculation during calls. Matches the marketing ROI calculator exactly. |
| **Outbound Call Engine** | Queue outbound calls with pre-computed ROI, auto-pushes to teleprompter. |
| **Teleprompter Push** | Push any payload to connected reps globally in real time. |

---

## All Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/relay/health` | — | Liveness |
| POST | `/relay/call/event` | HMAC/none | CCaaS inbound webhook |
| POST | `/relay/call/transcript` | — | Live STT chunk |
| POST | `/relay/call/end` | — | Call ended, update FCR |
| GET | `/relay/call/live/:callId` | Bearer | Poll live call state |
| **POST** | **`/relay/call/outbound`** | Bearer | Queue outbound call + pre-compute ROI |
| **GET** | **`/relay/teleprompter/ws/:sessionId`** | — | WebSocket (Durable Object) |
| **POST** | **`/relay/teleprompter/push/:sessionId`** | Bearer | Push raw payload to session |
| **POST** | **`/relay/teleprompter/roi/:sessionId`** | Bearer | Compute ROI + push to session |
| **POST** | **`/relay/roi`** | — | Compute ROI (no push) |
| POST | `/relay/pilot-request` | — | Pilot form (3/hr rate limit) |
| GET | `/relay/status/:tenantId` | Bearer | Tenant KPI metrics |
| GET | `/relay/audit/:tenantId` | Bearer | Audit log |

---

## Durable Object WebSocket — TeleprompterSession

Each rep connects to their own session:
```
wss://api-relay.primecoreintelligence.com/relay/teleprompter/ws/{sessionId}
```

Push a payload to all connected reps in that session:
```
POST /relay/teleprompter/push/{sessionId}
Authorization: Bearer {RELAY_AUTH_TOKEN}
Content-Type: application/json
{...teleprompter payload...}
```

Compute ROI + push automatically:
```
POST /relay/teleprompter/roi/{sessionId}
{
  "industry": "logistics",
  "volume": 22000,
  "agents": 12,
  "agentCost": 1800,
  "callerLanguage": "es",
  "stage": 1,
  "prospect": { "company": "LogiFlow Colombia", "lastStatement": "How much does it cost?" }
}
```

---

## Outbound Call Engine

```
POST /relay/call/outbound
Authorization: Bearer {RELAY_AUTH_TOKEN}
{
  "to": "+573001234567",
  "callType": "pilot_follow_up",
  "industry": "logistics",
  "volume": 22000,
  "agents": 12,
  "agentCost": 1800,
  "language": "es",
  "company": "LogiFlow Colombia",
  "contactName": "Carlos Mendez",
  "sessionId": "rep-alex-vega"
}
```

Returns:
```json
{
  "ok": true,
  "callId": "out_1742317...",
  "status": "queued",
  "roi": { "netMonthly": 17200, "breakEvenMonth": 1, ... },
  "sessionId": "rep-alex-vega"
}
```

Pre-computed ROI is automatically pushed to the teleprompter session when the call is queued.

---

## ROI Engine — Industry Benchmarks

| Industry | FCR | AHT | Cost/Call |
|---|---|---|---|
| Logistics / 3PL | 89% | 87s | $6.50 |
| Healthcare | 82% | 120s | $9.20 |
| Financial Services | 79% | 105s | $8.80 |
| Retail / E-commerce | 87% | 72s | $5.40 |
| Fleet / Dispatch | 85% | 95s | $7.10 |
| BPO Operations | 83% | 102s | $6.90 |

---

## Required Cloudflare Setup

### KV Namespace
`0b666aeb10344273adefd8ca0b13dd7f` — same as War Room

### Durable Object
Deploy via `wrangler deploy` — `TeleprompterSession` class is exported from `src/index.js`

### Secrets
```
RELAY_AUTH_TOKEN             — Bearer token for authenticated endpoints
WAR_ROOM_API_TOKEN           — Forward to api.primecoreintelligence.com
NOTIFY_EMAIL                 — Pilot notification email
CCAAS_WEBHOOK_SECRET_FIVE9   — HMAC secret
CCAAS_WEBHOOK_SECRET_GENESYS — HMAC secret
CCAAS_WEBHOOK_SECRET_BLISS   — HMAC secret
```

---

© 2026 PrimeCore Intelligence S.A.
