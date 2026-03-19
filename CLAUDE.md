# PrimeCore Intelligence — Workers Relay v2.0

`api-relay.primecoreintelligence.com` — Cloudflare Worker + Durable Object

## Status
**NOT YET DEPLOYED.** Run `npx wrangler deploy` to activate TeleprompterSession DO.

## Architecture
Rate limit layer → HMAC validation → Tenant-isolated KV → Durable Object WS → War Room API

## All Endpoints (867 lines in src/index.js)
| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | /relay/health | none | liveness |
| POST | /relay/call/event | HMAC | CCaaS webhook |
| POST | /relay/call/transcript | none | live STT chunk |
| POST | /relay/call/end | none | FCR update |
| GET | /relay/call/live/:callId | Bearer | poll state |
| POST | /relay/call/outbound | Bearer | queue outbound + ROI |
| GET | /relay/teleprompter/ws/:sessionId | none | WS upgrade → DO |
| POST | /relay/teleprompter/push/:sessionId | Bearer | broadcast payload |
| POST | /relay/teleprompter/roi/:sessionId | Bearer | ROI compute + push |
| POST | /relay/roi | none | standalone ROI |
| POST | /relay/pilot-request | none (3/hr) | pilot form |
| GET | /relay/status/:tenantId | Bearer | KPI metrics |
| GET | /relay/audit/:tenantId | Bearer | audit log |

## Secrets Required (Cloudflare Dashboard → Worker Settings)
```
RELAY_AUTH_TOKEN
WAR_ROOM_API_TOKEN
NOTIFY_EMAIL
CCAAS_WEBHOOK_SECRET_FIVE9
CCAAS_WEBHOOK_SECRET_GENESYS
CCAAS_WEBHOOK_SECRET_BLISS
```

## Deploy Command
```bash
cd workers-Relay
npx wrangler deploy
```

## MCP Guidance
- `chrome-devtools` to debug WS frames after first deployment
- `--seq` for ROI engine edge cases (volume=0, unknown industry, plan boundary)
- `playwright` for end-to-end: outbound call queue → ROI pushed → teleprompter receives
