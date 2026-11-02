'use strict';
/**
 * GROUP CHAT — Concurrent Message Batch Window
 *
 * When the judge returns BATCH_PENDING, messages are queued per group.
 * A 2-second inactivity window starts (or resets on each new message).
 * Once the window closes with no new messages, the full batch is passed
 * back to the judge for a final evaluation on the complete burst.
 */

const BATCH_WINDOW_MS = 2000;

// groupId → { messages: [], timer: TimeoutId, pendingResolvers: [] }
const pendingBatches = new Map();

const flush = (groupId) => {
  const batch = pendingBatches.get(groupId);
  if (!batch) return;
  clearTimeout(batch.timer);
  pendingBatches.delete(groupId);
  batch.pendingResolvers.forEach(r => r(batch.messages));
};

const addToBatch = (groupId, message) =>
  new Promise((resolve) => {
    const existing = pendingBatches.get(groupId);

    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.pendingResolvers.push(resolve);
      existing.timer = setTimeout(() => flush(groupId), BATCH_WINDOW_MS);
    } else {
      pendingBatches.set(groupId, {
        messages:         [message],
        pendingResolvers: [resolve],
        timer:            setTimeout(() => flush(groupId), BATCH_WINDOW_MS),
      });
    }
  });

const hasPendingBatch = (groupId) => pendingBatches.has(groupId);
const flushBatch      = (groupId) => flush(groupId);

module.exports = { addToBatch, hasPendingBatch, flushBatch, BATCH_WINDOW_MS };