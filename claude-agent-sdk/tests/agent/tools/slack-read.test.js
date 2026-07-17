import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

import { lookupChannelIdByName, resetChannelCache, resolveChannelArg } from '../../../agent/tools/slack-read.js';

/** @returns {any} Minimal conventions shape for channel resolution. */
function conventions() {
  return {
    clients: {
      acme: { display_name: 'Acme', channel_id: 'C0ACME', internal_channel_id: 'C0ACMEINT' },
      ghost: { display_name: 'Ghost', channel_id: 'C_TODO_GHOST' },
    },
  };
}

describe('resolveChannelArg', () => {
  it('resolves a client key to the external channel ID', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'acme'), { id: 'C0ACME' });
  });

  it('resolves "{key}-internal" to the internal channel ID', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'acme-internal'), { id: 'C0ACMEINT' });
  });

  it('passes raw channel IDs through untouched', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'C0OTHER'), { id: 'C0OTHER' });
  });

  it('falls back to a live name lookup for placeholder channel IDs', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'ghost'), { lookupName: 'ghost-pixelup' });
  });

  it('falls back to a live name lookup when the internal channel is not configured', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), 'ghost-internal'), { lookupName: 'ghost-internal' });
  });

  it('treats unknown names as channel names to look up, stripping any leading #', () => {
    assert.deepStrictEqual(resolveChannelArg(conventions(), '#design-team'), { lookupName: 'design-team' });
  });
});

describe('lookupChannelIdByName', () => {
  beforeEach(() => resetChannelCache());

  /** @param {any[]} channels */
  function fakeClient(channels) {
    return {
      conversations: {
        list: mock.fn(async () => ({ channels, response_metadata: {} })),
      },
    };
  }

  it('finds a channel by name across the channels visible to the bot', async () => {
    const client = fakeClient([{ id: 'C0DESIGN', name: 'design-team' }]);
    const id = await lookupChannelIdByName(/** @type {any} */ (client), 'design-team');
    assert.strictEqual(id, 'C0DESIGN');
  });

  it('serves repeat lookups from the cache without re-listing', async () => {
    const client = fakeClient([{ id: 'C0DESIGN', name: 'design-team' }]);
    await lookupChannelIdByName(/** @type {any} */ (client), 'design-team');
    await lookupChannelIdByName(/** @type {any} */ (client), 'design-team');
    assert.strictEqual(client.conversations.list.mock.callCount(), 1);
  });

  it('does not re-list on a fresh cache miss (avoids hammering the API)', async () => {
    const client = fakeClient([{ id: 'C0DESIGN', name: 'design-team' }]);
    await lookupChannelIdByName(/** @type {any} */ (client), 'design-team');
    const missing = await lookupChannelIdByName(/** @type {any} */ (client), 'no-such-channel');
    assert.strictEqual(missing, undefined);
    assert.strictEqual(client.conversations.list.mock.callCount(), 1);
  });
});
