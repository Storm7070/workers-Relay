/**
 * PrimeCore Intelligence — Memory Storage Contracts
 * Layer D: Memory and Personalization Layer
 *
 * Each contract defines:
 * - required: fields that MUST be present before writing to Hermes
 * - optional: fields that enrich the entry if available
 * - description: what this category is for
 * - ttlDays: soft TTL for relevance decay (Hermes does not auto-delete;
 *   this is used by search ranking heuristics in session-hooks.js)
 *
 * Adding a new category: add it here, then add a writeXxx() helper
 * in session-hooks.js. The bridge will enforce contracts automatically.
 */

export const MEMORY_CONTRACTS = {

  // -------------------------------------------------------------------------
  // 1. Founder Preferences
  // Persistent preferences set by the founder via Founder Intent Console.
  // These bias ALL downstream decisions: routing, tone, escalation thresholds.
  // -------------------------------------------------------------------------
  founder_preference: {
    description: 'Founder-level operational preferences and behavioral biases',
    required: ['preference_key', 'preference_value', 'scope'],
    optional: ['previous_value', 'rationale', 'expires_at', 'tags'],
    ttlDays: null, // never expires unless explicitly replaced
    schema: {
      preference_key:   'string — e.g. "escalation_threshold", "teleprompter_tone"',
      preference_value: 'any — the new value',
      scope:            '"global" | "campaign:{id}" | "language:{code}" | "client:{id}"',
      previous_value:   'any — prior value, for rollback support',
      rationale:        'string — why the founder made this change',
      expires_at:       'ISO datetime | null',
    },
  },

  // -------------------------------------------------------------------------
  // 2. Approved Scripts
  // Finalized teleprompter and agent assist scripts that have been
  // approved (by founder or supervisor) for live production use.
  // -------------------------------------------------------------------------
  approved_script: {
    description: 'Production-approved teleprompter and agent assist scripts',
    required: ['script_id', 'script_content', 'language', 'scenario'],
    optional: ['tone', 'approved_by', 'version', 'supersedes', 'tags'],
    ttlDays: 180,
    schema: {
      script_id:      'string — unique, e.g. "objection_pricing_es_v3"',
      script_content: 'string — the full script text',
      language:       'BCP-47 code — e.g. "es-MX", "pt-BR", "en-US"',
      scenario:       'string — e.g. "pricing_objection", "enterprise_escalation"',
      tone:           '"professional" | "empathetic" | "direct" | "consultative"',
      approved_by:    '"founder" | "supervisor" | "system"',
      version:        'semver string',
      supersedes:     'script_id of the script this replaces',
    },
  },

  // -------------------------------------------------------------------------
  // 3. Objection Memory
  // Winning responses to specific objections, indexed by objection type,
  // language, and customer segment. Used to bias teleprompter suggestions.
  // -------------------------------------------------------------------------
  objection_memory: {
    description: 'Winning objection-handling responses with outcome data',
    required: ['objection_type', 'language', 'response_summary', 'outcome'],
    optional: ['customer_segment', 'full_response', 'call_id', 'agent_id', 'tags'],
    ttlDays: 90,
    schema: {
      objection_type:    'string — e.g. "price_too_high", "already_have_solution"',
      language:          'BCP-47 code',
      response_summary:  'string — concise description of the winning response',
      outcome:           '"resolved" | "escalated" | "churned" | "converted"',
      customer_segment:  '"enterprise" | "smb" | "bpo" | "unknown"',
      full_response:     'string — verbatim or near-verbatim winning response',
      call_id:           'string — PrimeCore call reference',
      agent_id:          'string — anonymized agent reference',
    },
  },

  // -------------------------------------------------------------------------
  // 4. Successful Routing Patterns
  // Routing decisions that led to positive outcomes (FCR, resolution, CSAT).
  // Used to bias future routing logic.
  // -------------------------------------------------------------------------
  routing_pattern: {
    description: 'Routing decisions correlated with positive call outcomes',
    required: ['routing_key', 'decision', 'outcome_metric', 'outcome_value'],
    optional: ['language', 'customer_segment', 'call_type', 'tags'],
    ttlDays: 60,
    schema: {
      routing_key:     'string — e.g. "enterprise_inbound_es", "bpo_escalation_pt"',
      decision:        'string — the routing decision taken',
      outcome_metric:  '"fcr" | "aht" | "csat" | "resolution_rate"',
      outcome_value:   'number — normalized 0-1 or raw metric value',
      language:        'BCP-47 code',
      customer_segment: '"enterprise" | "smb" | "bpo" | "unknown"',
      call_type:       '"inbound" | "outbound" | "escalation" | "overflow"',
    },
  },

  // -------------------------------------------------------------------------
  // 5. Exception Precedents
  // Approved exceptions to policy — used so Hermes does not re-escalate
  // the same exception class to the founder repeatedly.
  // -------------------------------------------------------------------------
  exception_precedent: {
    description: 'Approved policy exceptions that establish recurring precedent',
    required: ['exception_class', 'approved_action', 'approved_by'],
    optional: ['condition', 'expires_at', 'risk_level', 'tags'],
    ttlDays: 365,
    schema: {
      exception_class:  'string — e.g. "high_value_client_override", "after_hours_escalation"',
      approved_action:  'string — what action was approved',
      approved_by:      '"founder" | "supervisor"',
      condition:        'string — under what conditions this applies',
      expires_at:       'ISO datetime | null',
      risk_level:       '"low" | "medium" | "high"',
    },
  },

  // -------------------------------------------------------------------------
  // 6. Customer Segment Heuristics
  // Learned patterns about customer segments that inform routing,
  // teleprompter tone, and qualification logic.
  // -------------------------------------------------------------------------
  segment_heuristic: {
    description: 'Learned behavioral heuristics per customer segment',
    required: ['segment', 'heuristic_key', 'heuristic_value'],
    optional: ['language', 'confidence', 'sample_size', 'tags'],
    ttlDays: 30,
    schema: {
      segment:          'string — e.g. "enterprise_latam", "smb_us"',
      heuristic_key:    'string — e.g. "avg_decision_time_days", "primary_objection"',
      heuristic_value:  'any — the learned value',
      language:         'BCP-47 code',
      confidence:       'number 0-1',
      sample_size:      'integer — number of observations this is based on',
    },
  },

  // -------------------------------------------------------------------------
  // 7. High-Performing Workflows
  // Complete workflow snapshots that achieved strong outcome metrics.
  // Written after resolution, read back when building new campaign logic.
  // -------------------------------------------------------------------------
  workflow_snapshot: {
    description: 'Snapshots of high-performing complete call workflows',
    required: ['workflow_id', 'workflow_type', 'outcome_summary'],
    optional: ['language', 'customer_segment', 'steps', 'metrics', 'tags'],
    ttlDays: 90,
    schema: {
      workflow_id:      'string — unique',
      workflow_type:    '"inbound_qualification" | "outbound_campaign" | "escalation" | "recovery"',
      outcome_summary:  'string — narrative of what made this workflow successful',
      language:         'BCP-47 code',
      customer_segment: 'string',
      steps:            'array of step descriptions',
      metrics:          'object — { aht, fcr, csat, resolution_rate }',
    },
  },

  // -------------------------------------------------------------------------
  // 8. Reusable Skills
  // Procedural knowledge in agentskills.io format.
  // These are written to Hermes skill store (not memory store) but
  // the contract here ensures consistent metadata.
  // -------------------------------------------------------------------------
  reusable_skill: {
    description: 'Procedural skills in agentskills.io format for Hermes skill store',
    required: ['skill_name', 'skill_content', 'trigger_description'],
    optional: ['version', 'author', 'tags', 'tested_scenarios'],
    ttlDays: null, // skills are permanent until explicitly replaced
    schema: {
      skill_name:           'string — e.g. "primecore/handle_pricing_objection_es"',
      skill_content:        'string — full markdown content in agentskills.io format',
      trigger_description:  'string — when Hermes should auto-load this skill',
      version:              'semver string',
      author:               '"system" | "founder" | "supervisor"',
      tested_scenarios:     'array of scenario names this skill was validated against',
    },
  },

};

/**
 * Get all valid category keys.
 * Used for input validation in hermes-bridge.js.
 */
export const VALID_CATEGORIES = Object.keys(MEMORY_CONTRACTS);

/**
 * Get required fields for a category.
 * @param {string} category
 * @returns {string[]}
 */
export function getRequiredFields(category) {
  return MEMORY_CONTRACTS[category]?.required || [];
}

/**
 * Get soft TTL in days for a category.
 * null = never expires.
 * @param {string} category
 * @returns {number|null}
 */
export function getCategoryTTL(category) {
  return MEMORY_CONTRACTS[category]?.ttlDays ?? null;
}
