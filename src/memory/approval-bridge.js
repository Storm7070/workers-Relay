/**
 * PrimeCore Intelligence — Approval Bridge
 * Target: Hermes Agent v0.8.0 background task approval buttons
 *
 * v0.8.0 added: button-based approval UI with /approve, /deny slash commands
 * and interactive button prompts. This module wires the war-room's
 * existing auth-gated /approve endpoint to Hermes task approvals.
 *
 * Flow:
 *   1. Hermes completes a background task (skill synthesis, intent execution)
 *   2. Hermes notifies war-room via webhook (NOTIFY_WEBHOOK)
 *   3. War-room displays pending approval in monitor.html dashboard
 *   4. Founder clicks Approve or Deny
 *   5. War-room calls this module → routes to Hermes approveTask()
 *   6. Hermes commits or discards the task result
 *
 * INTEGRATION: Add a route handler in your war-room Worker:
 *
 *   import { handleApprovalRequest } from './memory/approval-bridge.js';
 *
 *   // In your request router:
 *   if (pathname === '/api/hermes/approve' && method === 'POST') {
 *     return handleApprovalRequest(request, env);
 *   }
 *
 * UNCERTAINTY: The exact shape of Hermes webhook notifications in v0.8.0
 * is inferred from the changelog. Verify webhook payload structure by
 * running: hermes task list --verbose after submitting a test task.
 */

import { approveTask, getTaskStatus, HermesBridgeError } from './hermes-bridge.js';
import { generateAuditReceipt } from './audit.js';

// ---------------------------------------------------------------------------
// Inbound Webhook Handler
// Called by Hermes when a background task completes and needs approval.
// ---------------------------------------------------------------------------

/**
 * Handle inbound webhook notification from Hermes background task runner.
 * Stores pending approval in KV for display in monitor.html.
 *
 * @param {Request} request  - incoming webhook from Hermes
 * @param {object} env       - Cloudflare Worker env bindings
 * @returns {Response}
 */
export async function handleHermesWebhook(request, env) {
  // Validate webhook origin — Hermes should send a shared secret
  const secret = request.headers.get('X-Hermes-Webhook-Secret');
  if (secret !== (env.HERMES_WEBHOOK_SECRET || '')) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { task_id, status, summary, requires_approval, metadata } = body;

  if (!task_id) {
    return new Response('Missing task_id', { status: 400 });
  }

  // Only handle tasks that need approval
  if (status === 'completed' && requires_approval) {
    const pendingApproval = {
      task_id,
      status:       'pending_approval',
      summary:      summary || 'No summary provided',
      metadata:     metadata || {},
      received_at:  new Date().toISOString(),
      expires_at:   new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString(), // 72h
    };

    // Store in KV for monitor.html to display
    // UNCERTAINTY: assumes RELAY_STATE KV binding exists in your Worker
    if (env.RELAY_STATE) {
      await env.RELAY_STATE.put(
        `hermes:pending:${task_id}`,
        JSON.stringify(pendingApproval),
        { expirationTtl: 72 * 60 * 60 } // 72 hours
      );
    }

    // Also append to events log
    if (env.RELAY_EVENTS) {
      await env.RELAY_EVENTS.put(
        `hermes:event:${Date.now()}:${task_id}`,
        JSON.stringify({ type: 'HERMES_APPROVAL_PENDING', ...pendingApproval }),
        { expirationTtl: 7 * 24 * 60 * 60 }
      );
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Approval Request Handler
// Called by war-room dashboard when founder clicks Approve or Deny.
// ---------------------------------------------------------------------------

/**
 * Handle founder approval or denial of a Hermes background task.
 * Expected request body: { task_id, decision: 'approve'|'deny', reason?, approved_by? }
 *
 * @param {Request} request
 * @param {object} env       - Cloudflare Worker env bindings
 * @returns {Response}
 */
export async function handleApprovalRequest(request, env) {
  // Auth check — reuse existing war-room auth pattern
  // UNCERTAINTY: replace this with your actual auth check
  const authToken = request.headers.get('X-War-Room-Token');
  if (!authToken || authToken !== (env.WAR_ROOM_SECRET || '')) {
    return new Response('Unauthorized', { status: 401 });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const { task_id, decision, reason, approved_by } = body;

  if (!task_id || !decision) {
    return new Response(
      JSON.stringify({ error: 'task_id and decision are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  if (!['approve', 'deny'].includes(decision)) {
    return new Response(
      JSON.stringify({ error: 'decision must be "approve" or "deny"' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  // Retrieve pending approval from KV
  let pending = null;
  if (env.RELAY_STATE) {
    const raw = await env.RELAY_STATE.get(`hermes:pending:${task_id}`);
    if (raw) {
      try { pending = JSON.parse(raw); } catch {}
    }
  }

  if (!pending) {
    return new Response(
      JSON.stringify({ error: 'Task not found or already resolved' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const auditReceipt = generateAuditReceipt({
    action: `hermes_task_${decision}d`,
    task_id,
    decided_by: approved_by || 'founder',
    reason:     reason || '',
    task_summary: pending.summary,
  });

  const ctx = {
    requestId:      `approval-${task_id}`,
    originRole:     'founder',
    auditReceiptId: auditReceipt.id,
  };

  try {
    if (decision === 'approve') {
      await approveTask(task_id, {
        approvedBy: approved_by || 'founder',
        reason:     reason || '',
      }, ctx);
    }
    // deny: Hermes will auto-discard if not approved within TTL,
    // but we can notify Hermes explicitly if needed.
    // UNCERTAINTY: v0.8.0 may expose a task_deny tool — check tool list.

    // Clean up KV
    if (env.RELAY_STATE) {
      await env.RELAY_STATE.delete(`hermes:pending:${task_id}`);
    }

    // Log the audit event
    if (env.RELAY_EVENTS) {
      await env.RELAY_EVENTS.put(
        `hermes:event:${Date.now()}:${task_id}-${decision}`,
        JSON.stringify({
          type: `HERMES_TASK_${decision.toUpperCase()}D`,
          task_id,
          decided_by: approved_by || 'founder',
          reason,
          audit_receipt_id: auditReceipt.id,
          decided_at: new Date().toISOString(),
        }),
        { expirationTtl: 90 * 24 * 60 * 60 } // 90 days
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        decision,
        task_id,
        audit_receipt_id: auditReceipt.id,
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    const errMsg = err instanceof HermesBridgeError
      ? `[${err.code}] ${err.message}`
      : err.message;

    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ---------------------------------------------------------------------------
// List Pending Approvals
// Called by monitor.html to populate approval queue.
// ---------------------------------------------------------------------------

/**
 * Return all pending Hermes approvals from KV.
 * @param {object} env
 * @returns {Promise<Array>}
 */
export async function listPendingApprovals(env) {
  if (!env.RELAY_STATE) return [];

  const list = await env.RELAY_STATE.list({ prefix: 'hermes:pending:' });

  const results = await Promise.all(
    list.keys.map(async ({ name }) => {
      const raw = await env.RELAY_STATE.get(name);
      try { return raw ? JSON.parse(raw) : null; } catch { return null; }
    })
  );

  return results.filter(Boolean).sort(
    (a, b) => new Date(b.received_at) - new Date(a.received_at)
  );
}
