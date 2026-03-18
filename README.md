# PrimeCore Intelligence — Workers Relay

**API relay, rate limiting, CCaaS webhook receiver, and tenant isolation layer.**

Live at: `https://api-relay.primecoreintelligence.com`

Sits between the public internet and the War Room API (`api.primecoreintelligence.com`). Every inbound event passes through here first.

---

## What It Does

| Layer | Detail |
|---|---|
| **Rate limiting** | Per-IP, per-endpoint, per window. Cloudflare KV-backed. Fail-open on KV error. |
| **Tenant isolation** | Every KV key is `tenant:{id}:{category}:{key}` — zero cross-tenant data access possible |
| **Webhook validation** | HMAC-SHA256 signature verification for Five9, Genesys, Bliss. Plain-token for 3CX, RingCentral, Atento |
| **Audit logging** | Every inbound event logged with IP, tenant, timestamp, 90-day retention |
| **CCaaS normalization** | Normalizes Five9/Genesys/3CX event shapes into a single canonical format |

---

## Routes

| Method | Path | Auth | Rate Limit | Description |
|--------|------|------|------------|-------------|
| GET | `/relay/health` | — | — | Liveness check |
| POST | `/relay/call/event` | HMAC or none | 500/5min/tenant | CCaaS call event webhook |
| POST | `/relay/call/transcript` | — | 2000/5min/tenant | Live transcript chunk |
| POST | `/relay/call/end` | — | 100/5min/tenant | Call ended, update analytics |
| GET | `/relay/call/live/:callId` | Bearer | 60/5min default | Poll live call state |
| POST | `/relay/pilot-request` | — | **3/hour/IP** | Pilot form (strict limit) |
| GET | `/relay/status/:tenantId` | Bearer | 60/5min default | Tenant KPI metrics |
| GET | `/relay/audit/:tenantId` | Bearer | 60/5min default | Recent audit log |

---

## Tenant Isolation Architecture

All KV keys use the format:
```
tenant:{tenantId}:{category}:{key}
```

Examples:
```
tenant:client-abc:call:call_8821ab          ← call state
tenant:client-abc:metrics:current           ← live KPIs
tenant:client-abc:audit:2026-03-17T10-00    ← audit log entry
tenant:public:pilot:pilot_xyz               ← pilot request (no tenant yet)
```

Client A cannot access Client B's keys — they never share a prefix.

---

## Supported CCaaS Platforms

| Platform | Signature Header | Verification |
|---|---|---|
| Five9 | `x-five9-signature` | HMAC-SHA256 |
| Genesys | `x-genesys-signature` | HMAC-SHA256 |
| Bliss | `x-bliss-signature` | HMAC-SHA256 |
| 3CX | `x-3cx-webhook-token` | Plain token |
| RingCentral | `x-ringcentral-token` | Plain token |
| Atento | `x-atento-token` | Plain token |

---

## Required Cloudflare Setup

### KV Namespace
Uses same namespace as War Room: `0b666aeb10344273adefd8ca0b13dd7f`

### Secrets (set in Cloudflare dashboard → Workers & Pages → primecore-relay → Settings → Variables)
```
RELAY_AUTH_TOKEN                — Bearer token for authenticated endpoints
WAR_ROOM_API_TOKEN              — Token for forwarding to api.primecoreintelligence.com
CCAAS_WEBHOOK_SECRET_FIVE9      — HMAC secret from Five9 dashboard
CCAAS_WEBHOOK_SECRET_GENESYS    — HMAC secret from Genesys dashboard
CCAAS_WEBHOOK_SECRET_BLISS      — HMAC secret from Bliss dashboard
```

### Rate Limits (configured in code — no dashboard action needed)
```
/relay/pilot-request    →  3 requests / hour / IP      (strict — prevents lead spam)
/relay/call/event       →  500 requests / 5min / IP    (high volume for CCaaS)
/relay/call/transcript  →  2000 requests / 5min / IP   (highest — real-time STT)
/relay/call/end         →  100 requests / 5min / IP
default                 →  60 requests / 5min / IP
```

---

## Call Event Payload (from CCaaS)

```json
{
  "callId": "call_abc123",
  "type": "call.started",
  "agentId": "agent_456",
  "callerId": "+15551234567",
  "direction": "inbound",
  "language": "es",
  "platform": "five9"
}
```

Send with header: `x-tenant-id: your-client-id`

---

## Disclaimer

Not legal, medical, financial, or compliance advice.
© 2026 PrimeCore Intelligence S.A.
