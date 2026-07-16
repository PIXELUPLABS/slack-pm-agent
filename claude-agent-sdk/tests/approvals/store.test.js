import assert from 'node:assert';
import { describe, it } from 'node:test';

import { ProposalStore } from '../../approvals/store.js';

describe('ProposalStore', () => {
  it('creates a pending proposal with an id', () => {
    const store = new ProposalStore();
    const proposal = store.create({ type: 'task', payload: { title: 'x' }, requesterId: 'U1' });
    assert.ok(proposal.id);
    assert.strictEqual(proposal.status, 'pending');
    assert.strictEqual(store.get(proposal.id)?.requesterId, 'U1');
  });

  it('returns null for unknown ids', () => {
    const store = new ProposalStore();
    assert.strictEqual(store.get('nope'), null);
  });

  it('updates status', () => {
    const store = new ProposalStore();
    const proposal = store.create({ type: 'task', payload: {}, requesterId: 'U1' });
    store.setStatus(proposal.id, 'executed');
    assert.strictEqual(store.get(proposal.id)?.status, 'executed');
  });

  it('attaches the card message location', () => {
    const store = new ProposalStore();
    const proposal = store.create({ type: 'task', payload: {}, requesterId: 'U1' });
    store.attachMessage(proposal.id, 'C1', '123.456');
    assert.strictEqual(store.get(proposal.id)?.channelId, 'C1');
    assert.strictEqual(store.get(proposal.id)?.messageTs, '123.456');
  });

  it('expires proposals after the TTL', async () => {
    const store = new ProposalStore(0.001);
    const proposal = store.create({ type: 'task', payload: {}, requesterId: 'U1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(store.get(proposal.id), null);
  });

  it('evicts oldest entries beyond maxEntries', () => {
    const store = new ProposalStore(3600, 2);
    const first = store.create({ type: 'task', payload: {}, requesterId: 'U1' });
    const second = store.create({ type: 'task', payload: {}, requesterId: 'U1' });
    const third = store.create({ type: 'task', payload: {}, requesterId: 'U1' });
    assert.strictEqual(store.get(first.id), null);
    assert.ok(store.get(second.id));
    assert.ok(store.get(third.id));
  });
});
