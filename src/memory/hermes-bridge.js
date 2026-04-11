/**
 * PrimeCore Intelligence — Hermes Memory Bridge
 * Target: Hermes Agent v0.8.0 (v2026.4.8) by NousResearch
 * Transport: MCP via `hermes mcp serve` (available since v0.6.0, hardened in v0.8.0)
 *
 * ARCHITECTURE ROLE: Layer D — Memory and Personalization Layer
 *
 * This module is the ONLY entry point for PrimeCore → Hermes communication.
 * All reads/writes route through here. Do not call Hermes endpoints directly
 * from other modules — changes to Hermes internals should only require
 * updating this file.
 *
 * UNCERTAINTY: Hermes v0.8.0 MCP tool names are inferred from v0.7.0 docs
 * and the v0.8.0 changelog. If tool signatures differ, run:
 *   hermes mcp serve --list-tools
 * and reconcile with HERMES_TOOL_MAP below.
 */

import { MEMORY_CONTRACTS } from './contracts.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const HERMES_MCP_URL = globalThis.HERMES_MCP_URL
  || 'http://localhost:8765/mcp'; // default hermes mcp serve port — override via env

const HERMES_TIMEOUT_MS = 12_000; // inactivity-based timeout in v0.8.0 — not wall-clock

const BRIDGE_VERSION = '1.0.0'; // PrimeCore bridge version, not Hermes version

/**
 * Tool names exposed by `hermes mcp serve`.
 * VERIFY against: hermes mcp serve --list-tools
 * These are inferred from v0.7.0 MCP docs + v0.8.0 plugin changelog.
 */
const HERMES_TOOL_MAP = {
  memoryWrite:   'memory_write',
  memorySearch:  'memory_search',
  memoryGet:     'memory_get',
  skillWrite:    'skill_write',
  skillSearch:   'skill_search',
  sessionSearch: 'session_search',
  taskSubmit:    'task_submit',    // v0.8.0: background task submission
  taskApprove:   'task_approve',   // v0.8.0: approval button surface
  taskStatus:    'task_status',    // v0.8.0: background task status polling
};

// ---------------------------------------------------------------------------
// Core MCP Client
// ---------------------------------------------------------------------------

/**
 * Low-level MCP tool call.
 * Hermes exposes itself as an MCP server — we call tools via JSON-RPC.
 *
 * @param {string} toolName  - Key from HERMES_TOOL_MAP
 * @param {object} params    - Tool-specific parameters
 * @param {object} [ctx]     - Request context for audit trail
 * @returns {Promise<object>}
 */
async function callHermesTool(toolName, params, ctx = {}) {
  const resolvedTool = HERMES_TOOL_MAP[toolName];
  if (!resolvedTool) {
    throw new HermesBridgeError(`Unknown tool key: ${toolName}`, 'UNKNOWN_TOOL');
  }

  const requestId = ctx.requestId || crypto.randomUUID();
  const payload = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: {
      name: resolvedTool,
      arguments: params,
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HERMES_TIMEOUT_MS);

  try {
    const response = await fetch(HERMES_MCP_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-PrimeCore-Bridge-Version': BRIDGE_VERSION,
        'X-PrimeCore-Request-Id': requestId,
        ...(ctx.originRole && { 'X-PrimeCore-Origin-Role': ctx.originRole }),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new HermesBridgeError(
        `Hermes MCP returned ${response.status}`,
        'HTTP_ERROR',
        { status: response.status }
      );
    }

    const data = await response.json();

    if (data.error) {
      throw new HermesBridgeError(
        data.error.message || 'Hermes MCP error',
        'MCP_ERROR',
        { code: data.error.code, data: data.error.data }
      );
    }

    return data.result;

  } catch (err) {
    if (err.name === 'AbortError') {
      throw new HermesBridgeError(
        `Hermes tool call timed out after ${HERMES_TIMEOUT_MS}ms (inactivity)`,
        'TIMEOUT'
      );
    }
    if (err instanceof HermesBridgeError) throw err;
    throw new HermesBridgeError(err.message, 'NETWORK_ERROR', { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

/**
 * Verify Hermes MCP server is reachable and version is compatible.
 * Call this on Worker startup before attempting memory operations.
 *
 * @returns {Promise<{ ok: boolean, version?: string, error?: string }>}
 */
export async function hermesHealthCheck() {
  try {
    // MCP ping via tools/list — lightweight, no side effects
    const response = await fetch(HERMES_MCP_URL.replace('/mcp', '/health'), {
      method: 'GET',
      headers: { 'X-PrimeCore-Bridge-Version': BRIDGE_VERSION },
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json().catch(() => ({}));
    return { ok: true, version: data.version || 'unknown' };

  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Memory Operations
// ---------------------------------------------------------------------------

/**
 * Write a structured memory entry to Hermes.
 * Validates against MEMORY_CONTRACTS before writing.
 *
 * @param {string} category  - One of MEMORY_CONTRACTS keys
 * @param {object} payload   - Data matching the category contract
 * @param {object} ctx       - { requestId, originRole, auditReceiptId }
 */
export async function writeMemory(category, payload, ctx = {}) {
  const contract = MEMORY_CONTRACTS[category];
  if (!contract) {
    throw new HermesBridgeError(`Unknown memory category: ${category}`, 'INVALID_CATEGORY');
  }

  // Validate required fields per contract
  const violations = contract.required.filter(f => !(f in payload));
  if (violations.length > 0) {
    throw new HermesBridgeError(
      `Missing required fields for ${category}: ${violations.join(', ')}`,
      'CONTRACT_VIOLATION'
    );
  }

  const entry = {
    primecore_category: category,
    primecore_bridge_version: BRIDGE_VERSION,
    primecore_audit_receipt_id: ctx.auditReceiptId || null,
    primecore_origin_role: ctx.originRole || 'system',
    recorded_at: new Date().toISOString(),
    ...payload,
  };

  return callHermesTool('memoryWrite', {
    content: JSON.stringify(entry),
    tags: [category, 'primecore', ...(payload.tags || [])],
  }, ctx);
}

/**
 * Search Hermes memory using FTS5 full-text search.
 * Returns structured results filtered to PrimeCore-tagged entries.
 *
 * @param {string} query
 * @param {object} options - { category?, limit?, originRole? }
 */
export async function searchMemory(query, options = {}) {
  const { category, limit = 10 } = options;

  const filters = ['primecore'];
  if (category) filters.push(category);

  const result = await callHermesTool('memorySearch', {
    query,
    tags: filters,
    limit,
  }, options);

  // Deserialize PrimeCore entries back from Hermes storage
  return (result?.matches || []).map(m => {
    try {
      return JSON.parse(m.content);
    } catch {
      return { _raw: m.content, _parse_error: true };
    }
  });
}

// ---------------------------------------------------------------------------
// Skill Operations
// ---------------------------------------------------------------------------

/**
 * Write a reusable operational skill to Hermes skill store.
 * Skills persist across sessions and self-improve during use (v0.8.0).
 *
 * @param {string} skillName   - Unique identifier
 * @param {string} skillContent - Markdown following agentskills.io standard
 * @param {object} meta        - { category, tags, version, author }
 */
export async function writeSkill(skillName, skillContent, meta = {}, ctx = {}) {
  return callHermesTool('skillWrite', {
    name: `primecore/${skillName}`,
    content: skillContent,
    description: meta.description || '',
    tags: ['primecore', ...(meta.tags || [])],
    version: meta.version || '1.0.0',
  }, ctx);
}

/**
 * Search available PrimeCore skills in Hermes skill store.
 */
export async function searchSkills(query, options = {}) {
  return callHermesTool('skillSearch', {
    query,
    tags: ['primecore'],
    limit: options.limit || 5,
  }, options);
}

// ---------------------------------------------------------------------------
// Background Task Operations (v0.8.0)
// ---------------------------------------------------------------------------

/**
 * Submit a long-running task to Hermes background executor.
 * v0.8.0 feature: auto-notifications + approval buttons on completion.
 *
 * The task will notify war-room webhook when complete,
 * and may require founder /approve before committing changes.
 *
 * @param {object} task - { instruction, requiresApproval, notifyWebhook, metadata }
 * @returns {Promise<{ taskId: string, status: 'queued' | 'running' }>}
 */
export async function submitBackgroundTask(task, ctx = {}) {
  if (!task.instruction) {
    throw new HermesBridgeError('task.instruction is required', 'MISSING_FIELD');
  }

  return callHermesTool('taskSubmit', {
    instruction: task.instruction,
    requires_approval: task.requiresApproval ?? true,       // default: require approval
    notify_webhook: task.notifyWebhook || null,             // war-room webhook URL
    metadata: {
      primecore_origin_role: ctx.originRole || 'system',
      primecore_request_id: ctx.requestId,
      primecore_audit_receipt_id: ctx.auditReceiptId,
      ...task.metadata,
    },
    // v0.8.0: inactivity-based timeout, not wall-clock
    inactivity_timeout_seconds: task.inactivityTimeoutSeconds || 300,
  }, ctx);
}

/**
 * Poll background task status.
 * @param {string} taskId
 */
export async function getTaskStatus(taskId, ctx = {}) {
  return callHermesTool('taskStatus', { task_id: taskId }, ctx);
}

/**
 * Approve a pending background task.
 * Wires to v0.8.0 approval button surface.
 * Called by war-room /approve endpoint when founder clicks approve.
 *
 * @param {string} taskId
 * @param {object} approvalMeta - { approvedBy, reason }
 */
export async function approveTask(taskId, approvalMeta = {}, ctx = {}) {
  return callHermesTool('taskApprove', {
    task_id: taskId,
    approved_by: approvalMeta.approvedBy || 'founder',
    reason: approvalMeta.reason || '',
    approved_at: new Date().toISOString(),
  }, ctx);
}

// ---------------------------------------------------------------------------
// Error Type
// ---------------------------------------------------------------------------

export class HermesBridgeError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'HermesBridgeError';
    this.code = code;
    this.details = details;
  }
}
