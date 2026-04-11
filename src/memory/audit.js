/**
 * PrimeCore Intelligence — Audit Receipt Generator
 * Layer E: Governance and Verification Layer
 *
 * Every memory write, intent execution, task approval, and rollback
 * must produce an audit receipt. This is the single source of truth
 * for what changed, who changed it, and why.
 *
 * Receipts are immutable once created. Store in RELAY_EVENTS KV.
 */

/**
 * Generate an audit receipt for any operational action.
 *
 * @param {object} action - action descriptor
 * @returns {object} receipt with unique ID
 */
export function generateAuditReceipt(action) {
  const id = `ar_${Date.now()}_${crypto.randomUUID().split('-')[0]}`;

  return {
    id,
    schema_version:  '1.0',
    generated_at:    new Date().toISOString(),
    system:          'PrimeCore Intelligence',
    bridge_version:  '1.0.0',
    ...action,
  };
}

/**
 * Persist audit receipt to KV.
 * @param {object} receipt - from generateAuditReceipt()
 * @param {object} env     - Cloudflare Worker env
 */
export async function persistAuditReceipt(receipt, env) {
  if (!env.RELAY_EVENTS) return;

  await env.RELAY_EVENTS.put(
    `audit:receipt:${receipt.id}`,
    JSON.stringify(receipt),
    { expirationTtl: 365 * 24 * 60 * 60 } // 1 year retention
  );
}
