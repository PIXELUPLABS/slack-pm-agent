import { randomUUID } from 'node:crypto';

/**
 * @typedef {'task' | 'task_update' | 'task_move' | 'qa_tasks' | 'scaffold' | 'client_update' | 'client_registration' | 'automation_idea' | 'canvas_update'} ProposalType
 */

/**
 * @typedef {Object} Proposal
 * @property {string} id
 * @property {ProposalType} type
 * @property {any} payload - Structured JSON describing exactly what will be written.
 * @property {string} requesterId - Slack user ID that triggered the proposal.
 * @property {string} [clientKey]
 * @property {'pending' | 'approved' | 'rejected' | 'executed' | 'failed'} status
 * @property {number} createdAt
 * @property {string} [channelId] - Where the approval card was posted.
 * @property {string} [messageTs]
 */

/**
 * In-memory proposal store with TTL-based cleanup, mirroring SessionStore.
 * Proposals expire after 24h — an expired card simply reports it can no
 * longer be executed.
 */
export class ProposalStore {
  /**
   * @param {number} [ttlSeconds=86400]
   * @param {number} [maxEntries=500]
   */
  constructor(ttlSeconds = 86400, maxEntries = 500) {
    /** @type {Map<string, Proposal>} */
    this._store = new Map();
    /** @private @type {number} */
    this._ttlSeconds = ttlSeconds;
    /** @private @type {number} */
    this._maxEntries = maxEntries;
  }

  /**
   * @param {{ type: ProposalType, payload: any, requesterId: string, clientKey?: string }} fields
   * @returns {Proposal}
   */
  create(fields) {
    /** @type {Proposal} */
    const proposal = {
      id: randomUUID(),
      type: fields.type,
      payload: fields.payload,
      requesterId: fields.requesterId,
      clientKey: fields.clientKey,
      status: 'pending',
      createdAt: Date.now(),
    };
    this._store.set(proposal.id, proposal);
    this._cleanup();
    return proposal;
  }

  /**
   * @param {string} id
   * @returns {Proposal | null}
   */
  get(id) {
    const proposal = this._store.get(id);
    if (!proposal) return null;
    if (Date.now() - proposal.createdAt > this._ttlSeconds * 1000) {
      this._store.delete(id);
      return null;
    }
    return proposal;
  }

  /**
   * @param {string} id
   * @param {Proposal['status']} status
   * @returns {void}
   */
  setStatus(id, status) {
    const proposal = this._store.get(id);
    if (proposal) proposal.status = status;
  }

  /**
   * Record where the approval card was posted so it can be updated later.
   * @param {string} id
   * @param {string} channelId
   * @param {string} messageTs
   * @returns {void}
   */
  attachMessage(id, channelId, messageTs) {
    const proposal = this._store.get(id);
    if (proposal) {
      proposal.channelId = channelId;
      proposal.messageTs = messageTs;
    }
  }

  /**
   * @private
   * @returns {void}
   */
  _cleanup() {
    const now = Date.now();
    for (const [key, proposal] of this._store) {
      if (now - proposal.createdAt > this._ttlSeconds * 1000) {
        this._store.delete(key);
      }
    }
    if (this._store.size > this._maxEntries) {
      const sorted = [...this._store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
      const toRemove = sorted.slice(0, this._store.size - this._maxEntries);
      for (const [key] of toRemove) {
        this._store.delete(key);
      }
    }
  }
}

export const proposalStore = new ProposalStore();
