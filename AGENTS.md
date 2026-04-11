# AGENTS.md — PrimeCore Intelligence Agent Topology

> Last updated: April 2026
> Hermes Agent target: v0.8.0 (v2026.4.8) by NousResearch
> PrimeCore Bridge version: 1.0.0

---

## Agent Architecture Overview

PrimeCore uses a **5-layer architecture** where Hermes Agent acts as the
Memory and Personalization plane (Layer D) underneath the operational system.

```
┌─────────────────────────────────────────────────────┐
│  LAYER A — Interaction Layer                        │
│  Founder Intent Console | Supervisor Console        │
│  Teleprompter | Voice Override | Text Override      │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│  LAYER B — Intent Orchestration Layer               │
│  Intent Parser → Constraint Extractor →             │
│  Policy Classifier → Change Planner →               │
│  Confidence Scorer → Approval Router                │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│  LAYER C — Operational Execution Layer              │
│  Relay Worker | Call Routing | Teleprompter Logic   │
│  Queue | Multilingual | Escalation | CRM Sync       │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│  LAYER D — Memory and Personalization Layer ◄───────┼─ Hermes Agent v0.8.0
│  hermes-bridge.js | session-hooks.js                │
│  contracts.js | approval-bridge.js                  │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│  LAYER E — Governance and Verification Layer        │
│  Policy Validation | Audit Receipts | Rollback      │
│  Confidence Scoring | Simulation Harness            │
└─────────────────────────────────────────────────────┘
```

---

## Hermes Agent Integration

### What Hermes handles
- Persistent cross-session memory (founder prefs, scripts, objections, routing patterns)
- Skill accumulation in agentskills.io format
- Background task execution (skill synthesis, long-running analysis)
- Approval workflow surface (v0.8.0 button-based approvals)
- Live model switching (v0.8.0) for provider fallback

### What Hermes does NOT handle
- Real-time call routing (Relay Worker owns this)
- Teleprompter display (portal owns this)
- Cloudflare KV state (war-room Worker owns this)
- Policy enforcement (Layer E owns this)

### Connection
Hermes exposes itself as an MCP server via:
```bash
hermes mcp serve
```
PrimeCore connects via `src/memory/hermes-bridge.js` using JSON-RPC over HTTP.
Default URL: `http://localhost:8765/mcp` — override via `HERMES_MCP_URL` env var.

### v0.8.0 Features Used
| Feature | PrimeCore Usage |
|---|---|
| Background task auto-notifications | Skill synthesis completion alerts |
| Approval buttons (/approve, /deny) | Founder approval queue in monitor.html |
| Live model switching | Provider fallback for ES/PT reasoning |
| Session lifecycle hooks | Auto-write memory on call end |
| Request-scoped hooks | Per-intent validation |
| Inactivity-based timeouts | Long escalation hold protection |
| Pluggable memory providers | Swap to mem0/Honcho if needed |

---

## Memory Categories

Eight categories are defined in `src/memory/contracts.js`:

| Category | TTL | Purpose |
|---|---|---|
| `founder_preference` | Never | Operational biases set by founder |
| `approved_script` | 180d | Production teleprompter scripts |
| `objection_memory` | 90d | Winning objection responses |
| `routing_pattern` | 60d | Successful routing decisions |
| `exception_precedent` | 365d | Approved policy exceptions |
| `segment_heuristic` | 30d | Customer segment behavior |
| `workflow_snapshot` | 90d | High-performing call workflows |
| `reusable_skill` | Never | agentskills.io procedural skills |

---

## Approval Workflow

```
Hermes task completes
       │
       ▼
POST /api/hermes/webhook  ← handleHermesWebhook()
       │
       ▼
KV: hermes:pending:{task_id}
       │
       ▼
monitor.html approval queue (founder sees it)
       │
    approve / deny
       │
       ▼
POST /api/hermes/approve  ← handleApprovalRequest()
       │
       ▼
approveTask() → Hermes commits
generateAuditReceipt() → KV: audit:receipt:{id}
```

---

## New Worker Routes Required

Add these to your war-room Worker router:

```javascript
// Hermes webhook (inbound from Hermes background task runner)
POST /api/hermes/webhook   → handleHermesWebhook(request, env)

// Founder approval/denial
POST /api/hermes/approve   → handleApprovalRequest(request, env)

// List pending approvals (for monitor.html)
GET  /api/hermes/pending   → listPendingApprovals(env)
```

---

## Environment Variables Required

Add to `wrangler.toml` under `[vars]` (non-secret) or set as secrets:

```toml
# Non-secret (wrangler.toml [vars])
HERMES_MCP_URL = "http://your-server:8765/mcp"

# Secrets (set via: wrangler secret put HERMES_WEBHOOK_SECRET)
# HERMES_WEBHOOK_SECRET — shared secret between Hermes and war-room webhook
# WAR_ROOM_SECRET — existing auth token (already in use)
```

---

## KV Bindings Used

Both use the existing `RELAY_STATE` and `RELAY_EVENTS` KV namespace
(`1d3899dba6744eeaae48e2ecba7f261e`). No new namespaces required.

| Key Pattern | Namespace | TTL |
|---|---|---|
| `hermes:pending:{task_id}` | RELAY_STATE | 72h |
| `hermes:event:{ts}:{task_id}` | RELAY_EVENTS | 7d |
| `audit:receipt:{id}` | RELAY_EVENTS | 365d |

---

## What Is NOT Yet Built (Honest Gap List)

These are interfaces/stubs that require the actual war-room codebase:

1. **Intent Compiler** (Layer B) — not built; requires seeing existing routing logic
2. **Workflow Mutator** (Layer B) — not built; requires seeing wrangler config + routes
3. **Simulation Harness** (Layer E) — not built; requires seeing call flow code
4. **Founder Intent Console UI** (Layer A) — not built; requires portal access
5. **Teleprompter hook integration** — bridge is ready, call site unknown

These will be built once war-room repo access is provided.

---

## File Locations

```
src/memory/
├── hermes-bridge.js      ← MCP client, core bridge (v0.8.0 target)
├── contracts.js          ← 8 memory category contracts + validation
├── session-hooks.js      ← lifecycle hooks: onSessionStart/End/IntentProcessed
├── approval-bridge.js    ← webhook handler + founder approval routing
└── audit.js              ← audit receipt generation and persistence
```
