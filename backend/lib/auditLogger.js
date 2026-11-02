'use strict';
const { supabase } = require('./supabase');

const EVENT_TYPES = ['rule', 'safety', 'proposal', 'memory', 'agent', 'system'];

/**
 * Write a governance event to the audit_logs table.
 * Fire-and-forget — never throws, never blocks the caller.
 *
 * @param {'rule'|'safety'|'proposal'|'memory'|'agent'|'system'} eventType
 * @param {string} message
 * @param {object} [metadata]
 */
const logAudit = async (eventType, message, metadata = null) => {
  if (!EVENT_TYPES.includes(eventType)) {
    console.warn('[AuditLogger] Unknown event type:', eventType);
    return;
  }
  try {
    await supabase.from('audit_logs').insert({
      event_type: eventType,
      message,
      metadata:   metadata || null,
    });
  } catch (err) {
    console.warn('[AuditLogger] Failed to write audit log:', err.message);
  }
};

/**
 * Fetch recent audit log entries.
 *
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
const getAuditLog = async (limit = 50) => {
  const { data, error } = await supabase
    .from('audit_logs')
    .select('id, event_type, message, metadata, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('[AuditLogger] Failed to fetch audit log:', error.message);
    return [];
  }
  return data || [];
};

module.exports = { logAudit, getAuditLog };