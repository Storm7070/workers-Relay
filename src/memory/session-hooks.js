/**
 * PrimeCore Intelligence — Session Lifecycle Hooks
 * Target: Hermes Agent v0.8.0 plugin system
 *
 * v0.8.0 introduced session lifecycle hooks in the plugin system:
 * - session start hook: fires when a call/session begins
 * - session end hook: fires when a call/session concludes
 * - request-scoped hooks: fire per intent/action within a session
 *
 * This module implements those hooks for PrimeCore call sessions.
 * It is the primary writer of memory to Hermes — most memory writes
 * happen automatically at session end, not manually.
 *
 * INTEGRATION POINT:
 * Call onSessionStart() when a call is accepted by the Relay Worker.
 * Call onSessionEnd() when the call closes (resolution or handoff).
 * Call onIntentProcessed() after each founder intent is executed.
 *
 * UNCERTAINTY: The exact v0.8.0 plugin hook registration API is not
 * confirmed from public docs. The hooks here are designed as standalone
 * callables — if Hermes plugin registration works differently, wrap
 * these functions in the appropriate plugin manifest format.
 */

import {
  writeMemory,
  writeSkill,
  submitBackgroundTask,
  HermesBridgeError,
} from './hermes-bridge.js';

// ---------------------------------------------------------------------------
// Session Start Hook
// ---------------------------------------------------------------------------

/**
 * Called when a PrimeCore call session begins.
 * Loads relevant memory context for the call from Hermes.
 * Returns context object to be injected into teleprompter and routing.
 *
 * @param {object} session - { callId, language, customerSegment, callType, agentId }
 * @returns {Promise<object>} context - enriched session context
 */
export async function onSessionStart(session) {
  const { callId, language, customerSegment, callType } = session;

  const ctx = {
    requestId: `session-start-${callId}`,
    originRole: 'system',
  };

  // Non-blocking: if Hermes is down, call still proceeds
  const context = {
    callId,
    language,
    customerSegment,
    callType,
    hermesEnriched: false,
    founderPreferences: {},
    relevantScripts: [],
    commonObjections: [],
    routingHints: [],
  };

  try {
    // Parallel fetch — do not block call on any single query
    const [prefs, scripts, objections] = await Promise.allSettled([
      loadFounderPreferences(language, ctx),
      loadApprovedScripts(language, callType, ctx),
      loadCommonObjections(language, customerSegment, ctx),
    ]);

    context.founderPreferences = prefs.status === 'fulfilled' ? prefs.value : {};
    context.relevantScripts    = scripts.status === 'fulfilled' ? scripts.value : [];
    context.commonObjections   = objections.status === 'fulfilled' ? objections.value : [];
    context.hermesEnriched     = true;

  } catch (err) {
    // Log but never throw — session must not fail due to Hermes unavailability
    console.warn('[hermes-session] onSessionStart enrichment failed:', err.message);
  }

  return context;
}

// ---------------------------------------------------------------------------
// Session End Hook
// ---------------------------------------------------------------------------

/**
 * Called when a PrimeCore call session ends.
 * Writes outcome data to Hermes memory asynchronously.
 * Does NOT block the call close — fire and forget with error logging.
 *
 * @param {object} session - full session object with outcome data
 * @param {object} outcome - { resolution, metrics, objections, routingDecisions, scriptUsed }
 */
export async function onSessionEnd(session, outcome) {
  const ctx = {
    requestId: `session-end-${session.callId}`,
    originRole: 'system',
  };

  // Run all writes in parallel — individual failures don't block others
  const writes = [];

  // Write objection outcomes if any objections were handled
  if (outcome.objections?.length > 0) {
    for (const obj of outcome.objections) {
      writes.push(
        writeMemory('objection_memory', {
          objection_type:   obj.type,
          language:         session.language,
          response_summary: obj.responseSummary,
          outcome:          obj.outcome,
          customer_segment: session.customerSegment || 'unknown',
          call_id:          session.callId,
          agent_id:         session.agentId,
          tags:             ['auto-captured'],
        }, ctx).catch(err =>
          console.warn('[hermes-session] objection write failed:', err.message)
        )
      );
    }
  }

  // Write routing pattern if outcome was positive
  const isPositiveOutcome = ['resolved', 'converted'].includes(outcome.resolution);
  if (isPositiveOutcome && outcome.routingDecisions?.length > 0) {
    for (const rd of outcome.routingDecisions) {
      writes.push(
        writeMemory('routing_pattern', {
          routing_key:      `${session.callType}_${session.language}`,
          decision:         rd.decision,
          outcome_metric:   'fcr',
          outcome_value:    outcome.metrics?.fcr || 0,
          language:         session.language,
          customer_segment: session.customerSegment || 'unknown',
          call_type:        session.callType,
          tags:             ['auto-captured'],
        }, ctx).catch(err =>
          console.warn('[hermes-session] routing pattern write failed:', err.message)
        )
      );
    }
  }

  // Write workflow snapshot if the session was exceptional (top 10% by metric)
  const isHighPerforming = (outcome.metrics?.fcr || 0) >= 0.9
    || (outcome.metrics?.csat || 0) >= 0.9;

  if (isHighPerforming) {
    writes.push(
      writeMemory('workflow_snapshot', {
        workflow_id:      session.callId,
        workflow_type:    session.callType,
        outcome_summary:  buildOutcomeSummary(session, outcome),
        language:         session.language,
        customer_segment: session.customerSegment,
        metrics:          outcome.metrics,
        tags:             ['high-performing', 'auto-captured'],
      }, ctx).catch(err =>
        console.warn('[hermes-session] workflow snapshot write failed:', err.message)
      )
    );
  }

  // Wait for all writes to settle (not resolve — we don't want to throw)
  await Promise.allSettled(writes);
}

// ---------------------------------------------------------------------------
// Intent Processed Hook (request-scoped, v0.8.0)
// ---------------------------------------------------------------------------

/**
 * Called after each founder intent is processed by the Intent Orchestration Layer.
 * Writes approved changes to Hermes memory so they persist across sessions.
 *
 * @param {object} intentResult - output from the Intent Compiler
 * @param {object} approvalMeta - { approvedBy, approvedAt, auditReceiptId }
 */
export async function onIntentProcessed(intentResult, approvalMeta = {}) {
  const ctx = {
    requestId: intentResult.request_id,
    originRole: intentResult.origin_role,
    auditReceiptId: approvalMeta.auditReceiptId,
  };

  // Only write to memory if intent was approved and executed
  if (intentResult.status !== 'executed') return;

  // Write each affected module's change as a founder preference
  const writes = [];

  for (const change of (intentResult.proposed_changes || [])) {
    if (change.module === 'teleprompter' || change.module === 'routing'
        || change.module === 'escalation' || change.module === 'qualification') {

      writes.push(
        writeMemory('founder_preference', {
          preference_key:   `${change.module}.${change.field}`,
          preference_value: change.new_value,
          previous_value:   change.old_value,
          scope:            change.scope || 'global',
          rationale:        intentResult.normalized_goal,
          tags:             ['intent-driven', intentResult.origin_role],
        }, ctx).catch(err =>
          console.warn('[hermes-session] preference write failed:', err.message)
        )
      );
    }
  }

  // If the intent produced a new script, write it as an approved script
  if (intentResult.new_script) {
    writes.push(
      writeMemory('approved_script', {
        script_id:      `intent-${intentResult.request_id}`,
        script_content: intentResult.new_script.content,
        language:       intentResult.new_script.language,
        scenario:       intentResult.new_script.scenario,
        tone:           intentResult.new_script.tone,
        approved_by:    approvalMeta.approvedBy || 'founder',
        tags:           ['intent-driven'],
      }, ctx).catch(err =>
        console.warn('[hermes-session] script write failed:', err.message)
      )
    );
  }

  await Promise.allSettled(writes);
}

// ---------------------------------------------------------------------------
// Background Skill Generation (v0.8.0 background tasks)
// ---------------------------------------------------------------------------

/**
 * Submit a background skill generation task to Hermes.
 * After a sufficient number of similar sessions accumulate,
 * this synthesizes experience into a reusable skill.
 *
 * Requires founder approval before committing to skill store.
 * v0.8.0: approval buttons appear in war-room dashboard automatically.
 *
 * @param {string} skillTopic  - e.g. "pricing_objection_es-MX"
 * @param {string[]} callIds   - source sessions for synthesis
 * @param {string} notifyUrl   - war-room webhook to notify on completion
 */
export async function submitSkillSynthesisTask(skillTopic, callIds, notifyUrl) {
  const ctx = { originRole: 'system', requestId: `skill-synthesis-${Date.now()}` };

  return submitBackgroundTask({
    instruction: `Synthesize a reusable operational skill for: "${skillTopic}". 
Source sessions: ${callIds.join(', ')}. 
Follow agentskills.io format. Include: procedures, pitfalls, verification steps.
Tag as primecore/${skillTopic.replace(/\s+/g, '_').toLowerCase()}.`,
    requiresApproval: true,  // always require founder approval for new skills
    notifyWebhook: notifyUrl,
    inactivityTimeoutSeconds: 600,
    metadata: {
      skill_topic: skillTopic,
      source_call_count: callIds.length,
    },
  }, ctx);
}

// ---------------------------------------------------------------------------
// Private Helpers
// ---------------------------------------------------------------------------

async function loadFounderPreferences(language, ctx) {
  const { searchMemory } = await import('./hermes-bridge.js');
  const results = await searchMemory(`founder preference language:${language}`, {
    category: 'founder_preference',
    limit: 20,
  });

  // Merge into flat preference map, most recent wins
  return results.reduce((acc, r) => {
    if (r.preference_key && !r._parse_error) {
      acc[r.preference_key] = r.preference_value;
    }
    return acc;
  }, {});
}

async function loadApprovedScripts(language, callType, ctx) {
  const { searchMemory } = await import('./hermes-bridge.js');
  return searchMemory(`approved script ${callType} ${language}`, {
    category: 'approved_script',
    limit: 5,
  });
}

async function loadCommonObjections(language, customerSegment, ctx) {
  const { searchMemory } = await import('./hermes-bridge.js');
  return searchMemory(`objection ${language} ${customerSegment || ''}`, {
    category: 'objection_memory',
    limit: 10,
  });
}

function buildOutcomeSummary(session, outcome) {
  return [
    `Call ${session.callId} | ${session.callType} | ${session.language}`,
    `Segment: ${session.customerSegment || 'unknown'}`,
    `Resolution: ${outcome.resolution}`,
    `Metrics: FCR=${outcome.metrics?.fcr ?? 'n/a'} CSAT=${outcome.metrics?.csat ?? 'n/a'} AHT=${outcome.metrics?.aht ?? 'n/a'}s`,
    outcome.objections?.length
      ? `Objections handled: ${outcome.objections.map(o => o.type).join(', ')}`
      : 'No objections recorded',
  ].join(' | ');
}
