import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';

import { PendingClientMessageStore } from '../../thread-context/pending-client-messages.js';

describe('PendingClientMessageStore', () => {
  /** @type {PendingClientMessageStore} */
  let store;

  beforeEach(() => {
    store = new PendingClientMessageStore();
  });

  it('records a new pending client message', () => {
    store.recordClientMessage('C1', { clientKey: 'acme', messageTs: '1.0', snippet: 'hello' });
    const entry = store.get('C1');
    assert.strictEqual(entry?.clientKey, 'acme');
    assert.strictEqual(entry?.firstMessageTs, '1.0');
    assert.strictEqual(entry?.latestMessageTs, '1.0');
    assert.strictEqual(entry?.snippet, 'hello');
    assert.strictEqual(entry?.alertCount, 0);
    assert.strictEqual(entry?.lastAlertAt, 0);
  });

  it('keeps the original firstMessageTs when a second client message arrives', () => {
    store.recordClientMessage('C1', { clientKey: 'acme', messageTs: '1.0', snippet: 'first' });
    const firstSeenAt = store.get('C1')?.firstSeenAt;
    store.recordClientMessage('C1', { clientKey: 'acme', messageTs: '2.0', snippet: 'second' });
    const entry = store.get('C1');
    assert.strictEqual(entry?.firstMessageTs, '1.0');
    assert.strictEqual(entry?.firstSeenAt, firstSeenAt);
    assert.strictEqual(entry?.latestMessageTs, '2.0');
    assert.strictEqual(entry?.snippet, 'second');
  });

  it('clears a channel once a team member responds', () => {
    store.recordClientMessage('C1', { clientKey: 'acme', messageTs: '1.0', snippet: 'hello' });
    store.clearChannel('C1');
    assert.strictEqual(store.get('C1'), undefined);
  });

  it('tracks separate channels independently', () => {
    store.recordClientMessage('C1', { clientKey: 'acme', messageTs: '1.0', snippet: 'a' });
    store.recordClientMessage('C2', { clientKey: 'pogo', messageTs: '1.0', snippet: 'b' });
    assert.strictEqual(store.get('C1')?.clientKey, 'acme');
    assert.strictEqual(store.get('C2')?.clientKey, 'pogo');
  });

  it('markAlerted bumps lastAlertAt and alertCount, and is a no-op for an unknown channel', () => {
    store.recordClientMessage('C1', { clientKey: 'acme', messageTs: '1.0', snippet: 'hello' });
    store.markAlerted('C1');
    const entry = store.get('C1');
    assert.strictEqual(entry?.alertCount, 1);
    assert.ok((entry?.lastAlertAt ?? 0) > 0);
    assert.doesNotThrow(() => store.markAlerted('C_UNKNOWN'));
  });

  it('evicts the oldest entries when max is exceeded', () => {
    const small = new PendingClientMessageStore(2);
    small.recordClientMessage('C1', { clientKey: 'a', messageTs: '1.0', snippet: '' });
    small.recordClientMessage('C2', { clientKey: 'b', messageTs: '1.0', snippet: '' });
    small.recordClientMessage('C3', { clientKey: 'c', messageTs: '1.0', snippet: '' });
    assert.strictEqual(small.get('C1'), undefined);
    assert.ok(small.get('C2'));
    assert.ok(small.get('C3'));
  });

  it('clear() drops every entry', () => {
    store.recordClientMessage('C1', { clientKey: 'acme', messageTs: '1.0', snippet: 'hello' });
    store.clear();
    assert.deepStrictEqual(store.entries(), []);
  });
});
