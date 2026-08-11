/**
 * @typedef {Object} PendingEntry
 * @property {string} clientKey
 * @property {string} firstMessageTs - ts of the first unanswered client message.
 * @property {string} latestMessageTs - ts of the most recent unanswered client message.
 * @property {string} snippet - Preview of the most recent unanswered message.
 * @property {number} firstSeenAt - epoch ms when the channel went unanswered.
 * @property {number} lastAlertAt - epoch ms of the last reminder fired (0 = never).
 * @property {number} alertCount
 */

/**
 * Tracks, per client-external channel, whether the client is waiting on a
 * reply. `listeners/events/client-response-watchdog.js` writes to this on
 * every message; `schedules/response-watchdog.js` reads it on a timer. A
 * team-member message anywhere in the channel clears the entry — the clock
 * only ever runs while the client's most recent message has had zero replies
 * from the team.
 *
 * In-memory only, same tradeoff as SessionStore: a restart forgets anything
 * still pending, and a client with an unanswered message during a restart
 * needs one more message (or the next scheduled pass, once re-tracked) to
 * resume the clock.
 */
export class PendingClientMessageStore {
  /** @param {number} [maxEntries=500] */
  constructor(maxEntries = 500) {
    /** @type {Map<string, PendingEntry>} */
    this._store = new Map();
    /** @private @type {number} */
    this._maxEntries = maxEntries;
  }

  /**
   * Record a client message in `channelId`. If the channel is already
   * pending, the original `firstMessageTs`/`firstSeenAt` (and alert history)
   * are kept — a second client message doesn't restart the clock — but the
   * snippet/latest ts are refreshed so a reminder reflects what's actually
   * being asked right now.
   * @param {string} channelId
   * @param {{ clientKey: string, messageTs: string, snippet: string }} message
   * @returns {void}
   */
  recordClientMessage(channelId, { clientKey, messageTs, snippet }) {
    const existing = this._store.get(channelId);
    if (existing) {
      existing.latestMessageTs = messageTs;
      existing.snippet = snippet;
      return;
    }
    this._store.set(channelId, {
      clientKey,
      firstMessageTs: messageTs,
      latestMessageTs: messageTs,
      snippet,
      firstSeenAt: Date.now(),
      lastAlertAt: 0,
      alertCount: 0,
    });
    this._cleanup();
  }

  /**
   * A team member posted — the channel is no longer waiting on a reply.
   * @param {string} channelId
   * @returns {void}
   */
  clearChannel(channelId) {
    this._store.delete(channelId);
  }

  /**
   * @param {string} channelId
   * @returns {PendingEntry | undefined}
   */
  get(channelId) {
    return this._store.get(channelId);
  }

  /** @returns {Array<[string, PendingEntry]>} */
  entries() {
    return [...this._store.entries()];
  }

  /**
   * Record that a reminder just fired, so the next one waits a full
   * threshold before repeating.
   * @param {string} channelId
   * @returns {void}
   */
  markAlerted(channelId) {
    const entry = this._store.get(channelId);
    if (!entry) return;
    entry.lastAlertAt = Date.now();
    entry.alertCount += 1;
  }

  /** Drop every pending entry (tests). @returns {void} */
  clear() {
    this._store.clear();
  }

  /**
   * @private
   * @returns {void}
   */
  _cleanup() {
    if (this._store.size <= this._maxEntries) return;
    const sorted = [...this._store.entries()].sort((a, b) => a[1].firstSeenAt - b[1].firstSeenAt);
    const toRemove = sorted.slice(0, this._store.size - this._maxEntries);
    for (const [key] of toRemove) this._store.delete(key);
  }
}
