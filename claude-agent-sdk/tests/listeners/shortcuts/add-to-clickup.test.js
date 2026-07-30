import assert from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';
import { fileURLToPath } from 'node:url';

import { handleAddToClickUp } from '../../../listeners/shortcuts/add-to-clickup.js';

// Hermetic: use the test fixture, never the real checked-in conventions.
process.env.CONVENTIONS_PATH = fileURLToPath(new URL('../../fixtures/conventions.json', import.meta.url));

// Slack IDs from the fixture.
const LEAD_ID = 'U0000000LEAD';
const CLIENT_CHANNEL_ID = 'C0000000000';

describe('handleAddToClickUp', () => {
  let fakeAck;
  let fakeClient;
  let fakeLogger;

  beforeEach(() => {
    fakeAck = mock.fn(async () => {});
    fakeClient = {
      chat: {
        postMessage: mock.fn(async () => ({ ok: true, channel: 'D0LEAD', ts: '9.9' })),
        postEphemeral: mock.fn(async () => ({ ok: true })),
      },
      conversations: { open: mock.fn(async () => ({ channel: { id: 'D0LEAD' } })) },
    };
    fakeLogger = { error: mock.fn() };
  });

  /** @param {string} userId @param {string} channelId @param {string} text */
  function shortcut(userId, channelId, text) {
    return {
      user: { id: userId },
      channel: { id: channelId },
      message: { text, ts: '111.222' },
    };
  }

  it('posts the approval card to the requester DM, never the source channel', async () => {
    await handleAddToClickUp({
      ack: fakeAck,
      shortcut: shortcut(LEAD_ID, CLIENT_CHANNEL_ID, 'Please update the hero image\nby Friday'),
      client: fakeClient,
      logger: fakeLogger,
    });
    assert.strictEqual(fakeAck.mock.callCount(), 1);
    assert.strictEqual(fakeClient.chat.postMessage.mock.callCount(), 1);
    const args = fakeClient.chat.postMessage.mock.calls[0].arguments[0];
    assert.strictEqual(args.channel, 'D0LEAD');
    assert.notStrictEqual(args.channel, CLIENT_CHANNEL_ID);
    const summary = JSON.stringify(args.blocks);
    assert.ok(summary.includes('Please update the hero image'));
    assert.ok(summary.includes('example-client'));
  });

  it('ignores non-team users in client channels with total silence (no ephemeral)', async () => {
    await handleAddToClickUp({
      ack: fakeAck,
      shortcut: shortcut('U0STRANGER', CLIENT_CHANNEL_ID, 'hello'),
      client: fakeClient,
      logger: fakeLogger,
    });
    assert.strictEqual(fakeClient.chat.postMessage.mock.callCount(), 0);
    assert.strictEqual(fakeClient.chat.postEphemeral.mock.callCount(), 0);
  });

  it('tells non-team users via ephemeral in non-client channels', async () => {
    await handleAddToClickUp({
      ack: fakeAck,
      shortcut: shortcut('U0STRANGER', 'C0INTERNAL0', 'hello'),
      client: fakeClient,
      logger: fakeLogger,
    });
    assert.strictEqual(fakeClient.chat.postMessage.mock.callCount(), 0);
    assert.strictEqual(fakeClient.chat.postEphemeral.mock.callCount(), 1);
  });

  it('truncates long first lines into an 80-char title', async () => {
    const longLine = 'x'.repeat(200);
    await handleAddToClickUp({
      ack: fakeAck,
      shortcut: shortcut(LEAD_ID, CLIENT_CHANNEL_ID, longLine),
      client: fakeClient,
      logger: fakeLogger,
    });
    const blocks = JSON.stringify(fakeClient.chat.postMessage.mock.calls[0].arguments[0].blocks);
    assert.ok(blocks.includes(`${'x'.repeat(77)}…`));
  });
});
